//! 出网层：平台 API 代理 + 在线音频流式读取。
//!
//! 两个用途，共用同一个 ureq agent：
//!   1. `request()` —— 由前端 invoke 过来，替代 WebView 里被 CORS 挡住的 fetch
//!   2. `HttpRangeReader` —— 给 rodio 的解码器实现 `Read + Seek`，在线曲目可以边下边解、可以拖进度
//!
//! 为什么不用 WebView 的 fetch：音乐平台接口一律不带 `Access-Control-Allow-Origin`，
//! 前端 `no-cors` 只能拿到 opaque 响应（读不了 body）。必须走原生。
//! TLS 用系统的（Windows = schannel），不额外打包根证书。

use std::collections::{HashMap, HashSet};
use std::io::{Error as IoError, ErrorKind, Read, Seek, SeekFrom};
use std::sync::OnceLock;
use std::time::Duration;

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/* 分片大小见下方 SEG_BYTES：单连接按需拉的旧做法已由分段并发取代 */

fn agent() -> &'static ureq::Agent {
    static A: OnceLock<ureq::Agent> = OnceLock::new();
    A.get_or_init(|| {
        let mut b = ureq::AgentBuilder::new()
            .user_agent(UA)
            .timeout_connect(Duration::from_secs(10))
            .redirects(6);
        // ureq 只在启用 rustls 时才自带默认 TLS；这里显式接系统 TLS（Windows=schannel），
        // 证书走系统store，不用打包根证书
        match ureq::native_tls::TlsConnector::new() {
            Ok(c) => b = b.tls_connector(std::sync::Arc::new(c)),
            Err(e) => eprintln!("TLS 初始化失败（https 请求会不可用）：{e}"),
        }
        b.build()
    })
}

#[derive(serde::Serialize)]
pub struct NetResponse {
    pub status: u16,
    /// key 统一小写，前端按 `content-type` 这种写法取
    pub headers: HashMap<String, String>,
    pub body: String,
    /// 原始字节的 base64。
    ///
    /// `body` 是「按文本解一遍」的结果，给普通接口用；文件下载（云同步的 JSON、
    /// 图片、附件）必须认这串——文本解码在二进制上是有损的（UTF-8 替换符、
    /// GB18030 兜底都会改写字节），拿它当文件内容等于把文件弄坏。
    #[serde(rename = "bodyB64")]
    pub body_b64: String,
}

/// 标准 base64。手写这两段不引 crate：只有云同步的请求/响应各一处要用，
/// 拉一个依赖进 Cargo.lock 不划算。
fn b64_encode(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for c in bytes.chunks(3) {
        let b0 = c[0] as u32;
        let b1 = *c.get(1).unwrap_or(&0) as u32;
        let b2 = *c.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        s.push(T[(n >> 18) as usize & 63] as char);
        s.push(T[(n >> 12) as usize & 63] as char);
        s.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        s.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    s
}

fn b64_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let mut buf: u32 = 0;
    let mut bits: u32 = 0;
    for b in s.bytes() {
        let v = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' | b'\r' | b'\n' => continue,
            _ => return None,
        } as u32;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Some(out)
}

fn collect(resp: ureq::Response, want_b64: bool) -> Result<NetResponse, String> {
    let status = resp.status();
    let mut headers = HashMap::new();
    for name in resp.headers_names() {
        // header() 只回第一条：Set-Cookie 往往是多值，而登录凭证可能正好在
        // 第二条里（网易云扫码 803 常常只在 Set-Cookie 给 MUSIC_U）。
        // 多值一律用 \n 拼，前端按行拆。
        let vals = resp.all(&name);
        if vals.is_empty() {
            continue;
        }
        headers.insert(name.to_ascii_lowercase(), vals.join("\n"));
    }
    // 先取字节：有损文本解码只用于 `body`，`bodyB64` 保持字节原样
    let mut bytes: Vec<u8> = Vec::new();
    resp.into_reader()
        .read_to_end(&mut bytes)
        .map_err(|e| format!("读取响应失败：{e}"))?;
    let body = String::from_utf8_lossy(&bytes).to_string();
    Ok(NetResponse {
        status,
        headers,
        body,
        // 只有调用方明确要字节时才编码：这是全应用共用的出网口子，
        // 每一条普通 JSON 响应都白做一次 base64 不值（音源接口载荷可不小）
        body_b64: if want_b64 { b64_encode(&bytes) } else { String::new() },
    })
}

/// 同步发一次请求。4xx/5xx **不当作错误**——平台接口的风控信息就在 body 里，
/// 交给上层（`http.ts` 的 `HttpError`）去判断。
pub fn request(
    method: &str,
    url: &str,
    headers: &HashMap<String, String>,
    body: Option<&str>,
    body_b64: Option<&str>,
    want_b64: bool,
    timeout_ms: u64,
) -> Result<NetResponse, String> {
    let a = agent();
    let verb = method.trim().to_ascii_uppercase();
    let has_body = !matches!(verb.as_str(), "GET" | "HEAD");
    let mut req = a.request(&verb, url);
    for (k, v) in headers {
        // 由 ureq 自己决定这两个：手写会和服务端压缩/长度对不上
        if k.eq_ignore_ascii_case("host") || k.eq_ignore_ascii_case("content-length") {
            continue;
        }
        req = req.set(k, v);
    }
    req = req.timeout(Duration::from_millis(timeout_ms.clamp(1_000, 60_000)));

    let out = match (body_b64, body) {
        // multipart / 二进制：按原始字节发，别过一遍 UTF-8
        (Some(b), _) if has_body => {
            let bytes = b64_decode(b).ok_or_else(|| "请求体 base64 解析失败".to_string())?;
            req.send_bytes(&bytes)
        }
        (_, Some(b)) if has_body => req.send_string(b),
        _ => req.call(),
    };
    match out {
        Ok(r) => collect(r, want_b64),
        // 有状态码的失败也把响应读出来（body 里往往是业务错误信息）
        Err(ureq::Error::Status(_, r)) => collect(r, want_b64),
        Err(e) => Err(e.to_string()),
    }
}

/* ------------------------------------------------------------------ */
/* 流式读取（分段并发预取）                                             */
/* ------------------------------------------------------------------ */

/**
 * 每段多大、开几路并发。
 *
 * 以前是单连接、按需 512KB：网速一般时一首 5 分钟的歌要拉十几秒，
 * 进度条「半天停在一半」。现在拆成 256KB 的段、4 路并发 + 后台顺序预取，
 * 起播只要等第一段（约 1 个 RTT + 256KB），后面几路一起把整首拉完。
 *
 * 并发别开太大：CDN 对单 IP 有连接数限制，4 路大约能跑满普通家宽的 3 倍速。
 */
const SEG_BYTES: u64 = 256 * 1024;
const SEG_WORKERS: usize = 4;
/** 等某一段就绪的上限：超过就报错，别让解码线程永久卡住（单位秒） */
const SEG_WAIT_SECS: u64 = 45;

/// 分段仓库：workers 往里塞，reader 从里取。
struct SegStore {
    url: String,
    total: u64,
    seg_size: u64,
    segs: std::sync::Mutex<HashMap<u64, std::sync::Arc<Vec<u8>>>>,
    /// 失败段 → 原因（read 到它时如实报错，而不是假装 EOF）
    failed: std::sync::Mutex<HashMap<u64, String>>,
    cv: std::sync::Condvar,
    /// 下一个待分配的段号（workers 抢号）
    next: std::sync::atomic::AtomicU64,
    /// reader 已销毁：workers 尽快退出
    abort: std::sync::atomic::AtomicBool,
    /// 已从网络落进内存的字节总量（进度条的「已缓冲」）
    fetched: std::sync::Arc<std::sync::atomic::AtomicU64>,
    /**
     * 正在拉取的段号（抢号制）。
     *
     * seek 之后要用的是**中间某一段**，而 workers 是从 0 号顺序往后抢的：
     * 一首 10MB 的歌跳到 70% 时，等 workers 走到那儿要拉几十段，体感就是
     * 「点了进度条好几秒才出声」。所以 seek 时单独起一个 urgent 线程先把那一段抢下来。
     * 谁先 claim 谁拉，同一段不会拉两遍。
     */
    inflight: std::sync::Mutex<HashSet<u64>>,
}

impl SegStore {
    fn seg_count(&self) -> u64 {
        if self.total == 0 {
            0
        } else {
            (self.total + self.seg_size - 1) / self.seg_size
        }
    }

    /// 所有段都已处理（成功或失败）
    fn all_settled(&self) -> bool {
        let ok = self.segs.lock().map(|g| g.len()).unwrap_or(0) as u64;
        let bad = self.failed.lock().map(|g| g.len()).unwrap_or(0) as u64;
        ok + bad >= self.seg_count()
    }

    /// 抢号：true = 由我负责拉这一段
    fn claim(&self, idx: u64) -> bool {
        self.inflight.lock().map(|mut g| g.insert(idx)).unwrap_or(true)
    }

    fn release(&self, idx: u64) {
        if let Ok(mut g) = self.inflight.lock() {
            g.remove(&idx);
        }
    }

    fn put(&self, idx: u64, data: Vec<u8>) {
        let n = data.len() as u64;
        if let Ok(mut g) = self.segs.lock() {
            g.insert(idx, std::sync::Arc::new(data));
        }
        self.fetched
            .fetch_add(n, std::sync::atomic::Ordering::Relaxed);
        self.cv.notify_all();
    }

    fn mark_failed(&self, idx: u64, err: String) {
        if let Ok(mut g) = self.failed.lock() {
            g.insert(idx, err);
        }
        self.cv.notify_all();
    }

    /// 拉一段（带两次重试）。返回空 Vec 表示「服务端说这段没了」（尾部越界等）
    fn fetch_seg(&self, idx: u64) -> Result<Vec<u8>, String> {
        let start = idx * self.seg_size;
        let end = (start + self.seg_size - 1).min(self.total.saturating_sub(1));
        let range = format!("bytes={start}-{end}");
        let mut last = String::new();
        for attempt in 0..3 {
            if self.abort.load(std::sync::atomic::Ordering::Relaxed) {
                return Ok(Vec::new());
            }
            let out = agent()
                .get(&self.url)
                .set("Range", &range)
                .timeout(Duration::from_secs(20))
                .call();
            match out {
                Ok(resp) => {
                    if resp.status() != 206 && resp.status() != 200 {
                        last = format!("HTTP {}", resp.status());
                    } else {
                        let mut data = Vec::with_capacity(self.seg_size as usize);
                        match resp.into_reader().read_to_end(&mut data) {
                            Ok(_) => return Ok(data),
                            Err(e) => last = format!("读取失败：{e}"),
                        }
                    }
                }
                // 416：段越界（文件比预期短），当尾部处理
                Err(ureq::Error::Status(416, _)) => return Ok(Vec::new()),
                Err(e) => last = e.to_string(),
            }
            if attempt < 2 {
                std::thread::sleep(Duration::from_millis(220 * (attempt as u64 + 1)));
            }
        }
        Err(last)
    }
}

/// 起 N 个后台线程，从段 0 开始顺序抢号拉取
fn spawn_seg_workers(store: std::sync::Arc<SegStore>) {
    for _ in 0..SEG_WORKERS {
        let st = store.clone();
        let _ = std::thread::Builder::new()
            .name("shuyin-net-seg".into())
            .spawn(move || loop {
                if st.abort.load(std::sync::atomic::Ordering::Relaxed) {
                    return;
                }
                let idx = st.next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                if idx >= st.seg_count() {
                    return;
                }
                if st.segs.lock().map(|g| g.contains_key(&idx)).unwrap_or(false) {
                    continue;
                }
                // 已经被 seek 的 urgent 线程抢走了就别重复拉
                if !st.claim(idx) {
                    continue;
                }
                let out = st.fetch_seg(idx);
                st.release(idx);
                match out {
                    Ok(data) if data.is_empty() => st.mark_failed(idx, "服务端返回空段".into()),
                    Ok(data) => st.put(idx, data),
                    Err(e) => st.mark_failed(idx, e),
                }
            });
    }
}

/// 立刻去拉某一段（seek 用）：不等 workers 的顺序号
fn prioritize(store: &std::sync::Arc<SegStore>, idx: u64) {
    if idx >= store.seg_count() {
        return;
    }
    if store.segs.lock().map(|g| g.contains_key(&idx)).unwrap_or(false) {
        return;
    }
    if !store.claim(idx) {
        return; // 已经在拉了
    }
    let st = store.clone();
    let _ = std::thread::Builder::new()
        .name("shuyin-net-urgent".into())
        .spawn(move || {
            let out = st.fetch_seg(idx);
            st.release(idx);
            match out {
                Ok(d) if d.is_empty() => st.mark_failed(idx, "服务端返回空段".into()),
                Ok(d) => st.put(idx, d),
                Err(e) => st.mark_failed(idx, e),
            }
        });
}

/// 把一段 HTTP 资源伪装成 `Read + Seek`，交给 rodio 的 Decoder。
///
/// 内部是**分段并发预取**：open 时同步拉第一段（保证解码器立刻有数据），
/// 其余段由 4 个后台线程并行拉进内存。读取某段还没到时阻塞等它（在解码线程上，
/// 不在音频实时线程上），所以网速只影响「缓冲涨多快」，不会影响播放流畅度。
pub struct HttpRangeReader {
    total: u64,
    pos: u64,
    /// 服务端不认 Range 时（回 200 全量），整份数据直接放这儿
    whole: Option<Vec<u8>>,
    seg_size: u64,
    store: std::sync::Arc<SegStore>,
    /// 服务端声明的 Content-Type（小写），解码失败时写进错误信息帮用户定位
    content_type: String,
    /// 已经从网络拉到本地缓冲的字节总量
    fetched: std::sync::Arc<std::sync::atomic::AtomicU64>,
}

impl HttpRangeReader {
    pub fn open(url: &str) -> Result<Self, String> {
        let a = agent();
        let resp = a
            .get(url)
            .set("Range", &format!("bytes=0-{}", SEG_BYTES - 1))
            .timeout(Duration::from_secs(20))
            .call();

        let resp = match resp {
            Ok(r) => r,
            // 416：空文件
            Err(ureq::Error::Status(416, _)) => {
                let store = std::sync::Arc::new(SegStore {
                    url: url.to_string(),
                    total: 0,
                    seg_size: SEG_BYTES,
                    segs: Default::default(),
                    failed: Default::default(),
                    cv: std::sync::Condvar::new(),
                    next: Default::default(),
                    abort: Default::default(),
                    fetched: Default::default(),
                    inflight: Default::default(),
                });
                return Ok(Self {
                    total: 0,
                    pos: 0,
                    whole: Some(Vec::new()),
                    seg_size: SEG_BYTES,
                    store,
                    content_type: String::new(),
                    fetched: Default::default(),
                });
            }
            Err(ureq::Error::Status(code, r)) => {
                let detail = r.into_string().unwrap_or_default();
                return Err(format!("HTTP {code} {}", detail.chars().take(120).collect::<String>()));
            }
            Err(e) => return Err(e.to_string()),
        };

        let status = resp.status();
        let total = resp
            .header("content-range")
            .and_then(|v| v.rsplit('/').next())
            .and_then(|v| v.trim().parse::<u64>().ok())
            .filter(|n| *n > 0)
            .unwrap_or(0);
        let content_type = resp
            .header("content-type")
            .unwrap_or("")
            .to_ascii_lowercase();

        let mut first = Vec::new();
        resp.into_reader()
            .take(SEG_BYTES)
            .read_to_end(&mut first)
            .map_err(|e| format!("读取音频流失败：{e}"))?;

        if first.is_empty() {
            return Err("音源返回了空文件".to_string());
        }

        /*
         * 总长度必须尽量拿到：MP4/M4A 的 demuxer 初始化时要 seek 到**文件尾**读 moov，
         * SeekFrom::End 在 total=0 时只能报错，而 rodio 的 symphonia 解码器把
         * 「初始化期间的 seek 错误」直接 unreachable!() panic（实测稻香的 m4a 就炸在这）。
         * 有些服务端 206 响应不带 content-range，这里用 bytes=0-0 的空 Range 补探一次。
         */
        let total = if total > 0 {
            total
        } else if status != 206 {
            first.len() as u64
        } else {
            match agent()
                .get(url)
                .set("Range", "bytes=0-0")
                .timeout(Duration::from_secs(10))
                .call()
            {
                Ok(r) => r
                    .header("content-range")
                    .and_then(|v| v.rsplit('/').next())
                    .and_then(|v| v.trim().parse::<u64>().ok())
                    .filter(|n| *n > 0)
                    .unwrap_or(0),
                Err(_) => 0,
            }
        };

        /*
         * 服务端连总长度都不给（分块传输）：没有总长度就切不了段，
         * 退回「整份读进内存」。这类源一般是短音频，128MB 上限足够，
         * 而且整份在内存里反而 seek 最稳（不会出现半路 416）。
         */
        if total == 0 {
            let mut all = first;
            if let Ok(r) = agent().get(url).timeout(Duration::from_secs(60)).call() {
                let mut full = Vec::new();
                let _ = r.into_reader().take(128 * 1024 * 1024).read_to_end(&mut full);
                if full.len() > all.len() {
                    all = full;
                }
            }
            let len = all.len() as u64;
            let fetched = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(len));
            let store = std::sync::Arc::new(SegStore {
                url: url.to_string(),
                total: len,
                seg_size: SEG_BYTES,
                segs: Default::default(),
                failed: Default::default(),
                cv: std::sync::Condvar::new(),
                next: Default::default(),
                abort: Default::default(),
                fetched: fetched.clone(),
                inflight: Default::default(),
            });
            return Ok(Self {
                total: len,
                pos: 0,
                whole: Some(all),
                seg_size: SEG_BYTES,
                store,
                content_type,
                fetched,
            });
        }

        // 200 = 服务端忽略了 Range，body 就是完整文件：不再分段，直接全内存
        if status != 206 {
            let fetched = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(first.len() as u64));
            let store = std::sync::Arc::new(SegStore {
                url: url.to_string(),
                total,
                seg_size: SEG_BYTES,
                segs: Default::default(),
                failed: Default::default(),
                cv: std::sync::Condvar::new(),
                next: Default::default(),
                abort: Default::default(),
                fetched: fetched.clone(),
                inflight: Default::default(),
            });
            return Ok(Self {
                total,
                pos: 0,
                whole: Some(first),
                seg_size: SEG_BYTES,
                store,
                content_type,
                fetched,
            });
        }

        // 分段并发：首段已经拿到，直接塞进仓库，其余交给 workers
        let fetched = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let store = std::sync::Arc::new(SegStore {
            url: url.to_string(),
            total,
            seg_size: SEG_BYTES,
            segs: Default::default(),
            failed: Default::default(),
            cv: std::sync::Condvar::new(),
            next: Default::default(),
            abort: Default::default(),
            fetched: fetched.clone(),
            inflight: Default::default(),
        });
        store.put(0, first);
        if total > 0 {
            spawn_seg_workers(store.clone());
        }

        Ok(Self {
            total,
            pos: 0,
            whole: None,
            seg_size: SEG_BYTES,
            store,
            content_type,
            fetched,
        })
    }

    /// 时长（秒）估计：只有拿到总长度且下游知道码率时才有意义，
    /// 这里只把它当"有多大"的参考，真正的时长由前端从平台结果里带进来。
    pub fn byte_len(&self) -> u64 {
        self.total
    }

    /// 服务端声明的 Content-Type（小写，可能为空）
    pub fn content_type(&self) -> &str {
        &self.content_type
    }

    /// 已从网络取到的字节总量（进度条「已缓冲」用）
    pub fn fetched_handle(&self) -> std::sync::Arc<std::sync::atomic::AtomicU64> {
        self.fetched.clone()
    }

    /// 等某一段就绪；返回空 Vec 表示到文件尾了
    fn wait_seg(&self, idx: u64) -> std::io::Result<std::sync::Arc<Vec<u8>>> {
        // 缺段就先让 urgent 线程去抢，别干等 workers 顺序爬到这儿
        if self.whole.is_none() {
            prioritize(&self.store, idx);
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(SEG_WAIT_SECS);
        loop {
            if let Ok(g) = self.store.segs.lock() {
                if let Some(d) = g.get(&idx) {
                    return Ok(d.clone());
                }
            }
            // 段失败：如实报错（403/超时等），别让解码器以为文件结束了
            if let Ok(g) = self.store.failed.lock() {
                if let Some(e) = g.get(&idx) {
                    return Err(IoError::new(
                        ErrorKind::Other,
                        format!("音频分片 {idx} 拉取失败：{e}"),
                    ));
                }
            }
            if self.store.all_settled() {
                // 全部段都处理完还没有这一段：越界，按 EOF
                return Ok(std::sync::Arc::new(Vec::new()));
            }
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            if left.is_zero() {
                return Err(IoError::new(
                    ErrorKind::TimedOut,
                    format!("等待音频分片 {idx} 超时（{SEG_WAIT_SECS}s）"),
                ));
            }
            // 200ms 一轮：既是等待，也顺便复查失败表
            let wait = left.min(Duration::from_millis(200));
            if let Ok(g) = self.store.segs.lock() {
                let _ = self
                    .store
                    .cv
                    .wait_timeout(g, wait)
                    .map_err(|_| IoError::new(ErrorKind::Other, "分段等待锁中毒"))?;
            }
        }
    }
}

impl Drop for HttpRangeReader {
    fn drop(&mut self) {
        self.store
            .abort
            .store(true, std::sync::atomic::Ordering::Relaxed);
        // 叫醒可能还在 wait_seg 里的调用方（正常路径下 reader 只有一个持有者，这里只是兜底）
        self.store.cv.notify_all();
    }
}

impl Read for HttpRangeReader {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if out.is_empty() {
            return Ok(0);
        }
        // 整段模式：数据已在内存
        if let Some(all) = &self.whole {
            let pos = self.pos as usize;
            if pos >= all.len() {
                return Ok(0);
            }
            let n = out.len().min(all.len() - pos);
            out[..n].copy_from_slice(&all[pos..pos + n]);
            self.pos += n as u64;
            return Ok(n);
        }
        if self.total == 0 || self.pos >= self.total {
            return Ok(0);
        }
        let idx = self.pos / self.seg_size;
        let seg = self.wait_seg(idx)?;
        let off = (self.pos - idx * self.seg_size) as usize;
        if off >= seg.len() {
            return Ok(0);
        }
        let n = out.len().min(seg.len() - off);
        out[..n].copy_from_slice(&seg[off..off + n]);
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for HttpRangeReader {
    fn seek(&mut self, from: SeekFrom) -> std::io::Result<u64> {
        /*
         * SeekFrom::Start **绝不报错**：MP4/M4A 扫 box 时会 seek 到很大的偏移
         * （size=0 的 mdat 名义上延伸到文件尾）。rodio 的 symphonia 解码器把
         * 「初始化期间的任何 seek 错误」直接 unreachable!() panic。
         * 越界位置交给 read() ——那里按 EOF 返回 0，是干净的正常路径。
         */
        let next: u64 = match from {
            SeekFrom::Start(p) => p,
            SeekFrom::Current(d) => {
                let n = self.pos as i64 + d;
                if n < 0 {
                    return Err(IoError::new(ErrorKind::InvalidInput, "seek 到负数位置"));
                }
                n as u64
            }
            SeekFrom::End(d) => {
                if self.total == 0 {
                    return Err(IoError::new(ErrorKind::Other, "该音源未提供长度，无法从末尾定位"));
                }
                let n = self.total as i64 + d;
                if n < 0 {
                    return Err(IoError::new(ErrorKind::InvalidInput, "seek 到负数位置"));
                }
                n as u64
            }
        };
        self.pos = next;
        /*
         * 目标段立刻插队去拉。
         *
         * 这一步是「点进度条要等好几秒才出声」的正解：workers 是从 0 号段顺序往后抢的，
         * 解码器 seek 到中间以后要读的段可能排在队列很后面，只能干等。
         * 这里在 seek 的同一刻把目标段交给 urgent 线程，通常 100~200ms 内就位。
         */
        if self.whole.is_none() && self.seg_size > 0 {
            prioritize(&self.store, next / self.seg_size);
        }
        Ok(self.pos)
    }
}

/* ------------------------------------------------------------------ */
/* 整首下载（分段并发，和在线播放共用一套分段逻辑）                      */
/* ------------------------------------------------------------------ */

/**
 * 把直链下载成文件。
 *
 * 和播放用同一套「分段并发」思路：先探总长度，再 4 路并发拉段、**按顺序**写盘
 * （乱序写盘要来回 seek，机械盘和网络盘都吃亏）。进度通过回调上报，
 * 前端拿它画下载进度。返回实际写入的字节数。
 */
pub fn download_to_file<F>(url: &str, dest: &std::path::Path, on_progress: F) -> Result<u64, String>
where
    F: Fn(u64, u64) + Send + Sync + 'static,
{
    use std::io::Write;

    let mut reader = HttpRangeReader::open(url)?;
    let total = reader.byte_len();
    let content_type = reader.content_type().to_string();
    if content_type.starts_with("text/") || content_type.contains("json") {
        return Err(format!("直链返回的不是音频（{content_type}）"));
    }
    if let Some(parent) = dest.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    /*
     * 服务端不给总长度（分块传输 / 不认 Range）时**不能直接失败**。
     *
     * 这是「能播但下不了」的元凶：播放侧遇到 total=0 会退回「整份读进内存」，
     * 所以照常出声；下载侧却直接报「该直链未提供文件长度」。
     * 用户看到的现象就是「明明能听，一按下载就说取不到地址」。
     * 这里改成一次性 GET、边读边写：没有进度分母而已，文件是完整的。
     */
    if total == 0 {
        return download_stream(url, dest, on_progress);
    }
    let mut file = std::fs::File::create(dest).map_err(|e| format!("创建文件失败：{e}"))?;


    // 顺序写：段由后台并发拉取，这里按顺序消费（乱序写要来回 seek，盘和网络盘都吃亏）
    let mut written: u64 = 0;
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("下载中断：{e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| format!("写入失败：{e}"))?;
        written += n as u64;
        on_progress(written, total);
    }
    file.flush().map_err(|e| format!("写入失败：{e}"))?;
    Ok(written)
}

/// 不知道总长度时的下载：一次性 GET，边读边写盘。
///
/// 进度分母尽力从 `content-length` 拿（分块传输是没有的），拿不到就报 0，
/// 前端会显示「下载中 X MB」而不是百分比——比直接失败好得多。
fn download_stream<F>(url: &str, dest: &std::path::Path, on_progress: F) -> Result<u64, String>
where
    F: Fn(u64, u64) + Send + Sync + 'static,
{
    use std::io::{Read, Write};

    let resp = agent()
        .get(url)
        .timeout(Duration::from_secs(120))
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(code, _) => format!("HTTP {code}"),
            other => other.to_string(),
        })?;
    if let Some(ct) = resp.header("content-type") {
        let ct = ct.to_ascii_lowercase();
        if ct.starts_with("text/") || ct.contains("json") {
            return Err(format!("直链返回的不是音频（{ct}）"));
        }
    }
    let total = resp
        .header("content-length")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);

    let mut file = std::fs::File::create(dest).map_err(|e| format!("创建文件失败：{e}"))?;
    let mut rd = resp.into_reader();
    let mut buf = vec![0u8; 64 * 1024];
    let mut written: u64 = 0;
    loop {
        let n = rd.read(&mut buf).map_err(|e| format!("下载中断：{e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| format!("写入失败：{e}"))?;
        written += n as u64;
        on_progress(written, total);
    }
    file.flush().map_err(|e| format!("写入失败：{e}"))?;
    if written == 0 {
        return Err("下载到的文件是空的".to_string());
    }
    Ok(written)
}

/* ------------------------------------------------------------------ */
/* 直链可用性探测                                                      */
/* ------------------------------------------------------------------ */

/**
 * 取链成功后先探一下这条直链，再交给播放器。
 *
 * 为什么必须探：音源脚本「返回了一个 URL」和「这个 URL 真的能拉」是两件事。
 * 平台经常回一个签名过期 / 需要 Referer / 已经 302 到 403 的地址，
 * 脚本那层看不出来（它只拼字符串），等到 rodio 去解码才失败——
 * 用户看到的是「这首歌播不了」，而我们本来完全可以降一档音质或换一个音源。
 *
 * 判据：
 *   · 200 / 206 都算可用（有的源不认 Range）
 *   · 必须真的读到字节（防止 200 + 空 body）
 *   · Content-Type 明显不是音频/二进制流（比如 text/html 的错误页）直接判死
 */
/**
 * 探活的结果。
 *
 * 除了「能不能读」之外还带两个数，是为了做**音频与歌曲信息的一致性校验**：
 * 有些音源对拿不到版权的歌不回错误，而是回一段别的音频（试听片段 / 广告 / 静音），
 * 甚至干脆是另一首歌。只看「有字节回来」是拦不住的，播出来就成了
 * 「封面写着富士山下，声音不是它」。
 *
 * 判据是**平均码率** = 总字节 × 8 ÷ 时长：
 *   · 真正的音乐在 64kbps（低码 AAC）~ 5000kbps（Hi-Res 无损）之间；
 *   · 一段 30 秒的试听占位，按 4 分钟算出来只有十几 kbps，一眼就露馅。
 * 前端拿到 `total` 之后自己比（那里才知道这歌该多长）。
 */
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeAudio {
    /// 实际读到的字节数
    pub got: u64,
    /// 文件总字节；拿不到（服务端不给长度）为 0
    pub total: i64,
    /// Content-Type，排查时看
    pub content_type: String,
    pub status: u16,
    /// 从文件头解析出的真实时长（秒）；0 = 这个格式/这段数据里读不出来
    pub duration: f64,
    /// 音频文件自己写的标题（Vorbis 注释 / ID3 TIT2）；读不到是空串
    pub title: String,
    /// 音频文件自己写的歌手；读不到是空串
    pub artist: String,
}

/* ------------------------------------------------------------------ */
/* 文件头里读时长                                                       */
/* ------------------------------------------------------------------ */

/*
 * 为什么要做这件事：音源给回来的**不一定是要的那首歌**。
 *
 * 实测复盘（2026-10）：搜「花海 (DJ 阿若版)」（酷我声明 210 秒），某个音源
 * 给的 FLAC 解出来是邓紫棋《唯一》（253.7 秒，标签里连专辑 T.I.M.E. 都写着）。
 * 结果就是「标题写着花海，耳机里唱的是唯一」——用户第一时间就听出来了。
 *
 * 旧校验只算「总字节 ÷ 声明时长 = 平均码率」，落在 48~6500 kbps 之间就放行。
 * 这个 FLAC 算出来 1943 kbps，正在区间里，一点都拦不住。
 * 时长才是硬指标：同一首歌的不同版本最多差几秒，差四十秒就是另一首歌。
 *
 * 只读前 2~4 KB，认三种最常见的封装：
 *   · FLAC —— STREAMINFO 固定在第一块，时长精确
 *   · MP3  —— Xing/Info 帧数（精确）或首帧码率 × 总字节（CBR 估算）
 *   · MP4/M4A —— moov 在头部时读 mvhd（faststart 的文件才有）
 * 读不出来就返回 0，前端按「未知」跳过校验，不影响正常播放。
 */

fn be32(b: &[u8], at: usize) -> u64 {
    if at + 4 > b.len() {
        return 0;
    }
    u32::from_be_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]]) as u64
}

/// ID3v2 标签长度（MP3 的音频数据从它之后开始）
fn id3_len(h: &[u8]) -> usize {
    if h.len() >= 10 && &h[0..3] == b"ID3" {
        let sz = ((h[6] as usize & 0x7f) << 21)
            | ((h[7] as usize & 0x7f) << 14)
            | ((h[8] as usize & 0x7f) << 7)
            | (h[9] as usize & 0x7f);
        10 + sz
    } else {
        0
    }
}

fn flac_duration(h: &[u8]) -> f64 {
    if h.len() < 42 || &h[0..4] != b"fLaC" {
        return 0.0;
    }
    // METADATA_BLOCK_HEADER(4) + STREAMINFO(34)：采样率在 STREAMINFO 的 10~12 字节
    let s = 8; // STREAMINFO 起点
    let sr = ((h[s + 10] as u64) << 12) | ((h[s + 11] as u64) << 4) | ((h[s + 12] as u64) >> 4);
    let total = (((h[s + 13] as u64) & 0x0F) << 32) | be32(h, s + 14);
    if sr == 0 || total == 0 {
        return 0.0;
    }
    total as f64 / sr as f64
}

fn mp3_duration(h: &[u8], total: i64) -> f64 {
    let off = id3_len(h);
    if off >= h.len() {
        return 0.0;
    }
    let b = &h[off..];
    // 找一帧同步字：11 个 1
    for i in 0..b.len().saturating_sub(4) {
        if b[i] != 0xFF || (b[i + 1] & 0xE0) != 0xE0 {
            continue;
        }
        let ver = (b[i + 1] >> 3) & 0x03; // 3=MPEG1 2=MPEG2 0=MPEG2.5
        let layer = (b[i + 1] >> 1) & 0x03; // 1=Layer III
        let br_i = (b[i + 2] >> 4) as usize;
        let sr_i = ((b[i + 2] >> 2) & 0x03) as usize;
        let pad = ((b[i + 2] >> 1) & 0x01) as usize;
        if layer != 1 || br_i == 0 || br_i == 15 || sr_i == 3 {
            continue;
        }
        let mpeg1 = ver == 3;
        let br: u32 = if mpeg1 {
            [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0][br_i]
        } else {
            [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0][br_i]
        };
        let sr: u32 = match (mpeg1, sr_i) {
            (true, 0) => 44100,
            (true, 1) => 48000,
            (true, 2) => 32000,
            (false, 0) => 22050,
            (false, 1) => 24000,
            (false, 2) => 16000,
            _ => 11025,
        };
        let mono = (b[i + 3] >> 6) & 0x03 == 3;
        let spf = if mpeg1 { 1152 } else { 576 };
        let frame_len = if mpeg1 {
            (144 * br as usize * 1000 / sr as usize) + pad
        } else {
            (72 * br as usize * 1000 / sr as usize) + pad
        };
        // Xing / Info 头：Layer III 的边信息长度固定（MPEG1 单声道 17，立体声 32）
        let side = match (mpeg1, mono) {
            (true, true) => 17,
            (true, false) => 32,
            (false, true) => 9,
            (false, false) => 17,
        };
        let x = i + 4 + side;
        if x + 12 <= b.len() && (&b[x..x + 4] == b"Xing" || &b[x..x + 4] == b"Info") {
            let flags = be32(b, x + 4);
            if flags & 1 != 0 {
                let frames = be32(b, x + 8);
                if frames > 0 {
                    return frames as f64 * spf as f64 / sr as f64;
                }
            }
        }
        // 没有 Xing：按首帧码率当 CBR 估算（真 CBR 很准，VBR 会偏，够用）
        if total > 0 && br > 0 {
            return (total as f64 * 8.0) / (br as f64 * 1000.0);
        }
        let _ = frame_len;
        return 0.0;
    }
    0.0
}

/// 在一段 box 里递归找 mvhd（moov 得在文件头，否则这段数据里没有）
fn mp4_find_mvhd(b: &[u8], start: usize, end: usize, depth: u8) -> f64 {
    if depth > 3 {
        return 0.0;
    }
    let mut p = start;
    let end = end.min(b.len());
    while p + 8 <= end {
        let size = be32(b, p) as usize;
        let typ = &b[p + 4..p + 8];
        let body = p + 8;
        if typ == b"mvhd" {
            return mp4_mvhd(b, body, depth);
        }
        if typ == b"moov" {
            let r = mp4_find_mvhd(b, body, if size > 8 { p + size } else { end }, depth + 1);
            if r > 0.0 {
                return r;
            }
        }
        if size < 8 {
            break;
        }
        p += size;
    }
    0.0
}

fn mp4_mvhd(b: &[u8], body: usize, _depth: u8) -> f64 {
    if body + 20 > b.len() {
        return 0.0;
    }
    let ver = b[body];
    if ver == 1 {
        if body + 32 > b.len() {
            return 0.0;
        }
        let scale = be32(b, body + 20);
        let dur = be32(b, body + 24); // 64 位的高位一般用不上
        if scale > 0 {
            return dur as f64 / scale as f64;
        }
    } else {
        let scale = be32(b, body + 12);
        let dur = be32(b, body + 16);
        if scale > 0 {
            return dur as f64 / scale as f64;
        }
    }
    0.0
}

/// 从文件头猜时长（秒）。读不出来返回 0。
pub fn sniff_duration(h: &[u8], total: i64, content_type: &str) -> f64 {
    let d = match content_type {
        t if t.contains("flac") || (h.len() > 4 && &h[0..4] == b"fLaC") => flac_duration(h),
        t if t.contains("mp4") || t.contains("m4a") || (h.len() > 8 && &h[4..8] == b"ftyp") => {
            mp4_find_mvhd(h, 0, h.len(), 0)
        }
        t if t.contains("mpeg") || t.contains("mp3") => mp3_duration(h, total),
        _ => 0.0,
    };
    if d > 0.0 && d < 36_000.0 {
        (d * 10.0).round() / 10.0
    } else {
        0.0
    }
}

/// 从文件头里读「这个文件自己说自己是谁」（标题 / 歌手）。
///
/// 为什么非读不可：时长只能挡住「差十几秒」的错歌。实测栽过一次——
/// 播《孤勇者》（256 秒），某个音源给的是邓紫棋《唯一》（253.7 秒），
/// 差 2.3 秒、稳稳落在容差里，校验一路绿灯，可耳机里唱的根本不是这首歌；
/// 更早那次《花海》也是同一件事（253.7 秒）。
/// 这种情况下唯一还讲得上证据的，就是音频文件自己带的标签。
///
/// 认三种最常见的封装，**读不出来就当没有标签**（前端跳过校验，不影响播放）：
///   · FLAC / Ogg —— VORBIS_COMMENT，`TITLE=` / `ARTIST=` 明文，直接扫
///   · MP3        —— ID3v2 头 + TIT2 / TPE1 帧，四种编码都解
///   · M4A        —— ilst 在 moov 里位置不固定，这里不做
#[derive(Default, Debug)]
pub struct AudioTags {
    pub title: String,
    pub artist: String,
}

/// 在头部字节里找一个 `KEY=value`（Vorbis 注释的样子），大小写都认。
fn vorbis_field(buf: &[u8], key: &str) -> String {
    let upper = key.to_ascii_uppercase();
    for k in [upper.clone(), key.to_ascii_lowercase()] {
        let needle = k.as_bytes();
        let mut i = 0usize;
        while i + needle.len() + 1 < buf.len() {
            if &buf[i..i + needle.len()] == needle && buf[i + needle.len()] == b'=' {
                // 只认「字段边界上的」KEY=：前面一个字节得是块边界或分隔符，
                // 否则音频数据里凑巧出现的 `TITLE=` 也会被当成标签
                let boundary = i == 0 || buf[i - 1] <= 0x20 || buf[i - 1] >= 0x7f;
                let start = i + needle.len() + 1;
                let end = buf[start..]
                    .iter()
                    .position(|&b| b == 0)
                    .map(|p| start + p)
                    .unwrap_or(buf.len())
                    .min(start + 120);
                if boundary && end > start {
                    let s = String::from_utf8_lossy(&buf[start..end]).trim().to_string();
                    if !s.is_empty() {
                        return s;
                    }
                }
            }
            i += 1;
        }
    }
    String::new()
}

/// ID3v2 帧正文 → 字符串。开头那个字节是编码：0=Latin1、1=UTF-16(带 BOM)、2=UTF-16BE、3=UTF-8。
fn id3_text(body: &[u8]) -> String {
    if body.is_empty() {
        return String::new();
    }
    let enc = body[0];
    let rest = &body[1..];
    let s = match enc {
        0 => rest.iter().map(|&b| b as char).collect::<String>(),
        1 | 2 => {
            let (le, data) = if rest.len() >= 2 && rest[0] == 0xFF && rest[1] == 0xFE {
                (true, &rest[2..])
            } else if rest.len() >= 2 && rest[0] == 0xFE && rest[1] == 0xFF {
                (false, &rest[2..])
            } else {
                (enc == 1, rest)
            };
            let units: Vec<u16> = data
                .chunks(2)
                .filter(|c| c.len() == 2)
                .map(|c| if le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) })
                .collect();
            String::from_utf16_lossy(&units)
        }
        _ => String::from_utf8_lossy(rest).to_string(),
    };
    s.trim_matches(|c: char| c == '\0' || c.is_whitespace()).to_string()
}

/// 扫 ID3v2 头，取 TIT2（标题）/ TPE1（歌手）。
fn id3_tags(h: &[u8]) -> AudioTags {
    let mut out = AudioTags::default();
    if h.len() < 10 || &h[0..3] != b"ID3" {
        return out;
    }
    // 大小 = 4 个字节，每个字节只用低 7 位（syncsafe）
    let size = ((h[6] as usize & 0x7f) << 21)
        | ((h[7] as usize & 0x7f) << 14)
        | ((h[8] as usize & 0x7f) << 7)
        | (h[9] as usize & 0x7f);
    let end = (10 + size).min(h.len());
    let mut i = 10usize;
    while i + 10 <= end {
        let id = &h[i..i + 4];
        if id[0] == 0 {
            break; // padding
        }
        let fsz = ((h[i + 4] as usize) << 24)
            | ((h[i + 5] as usize) << 16)
            | ((h[i + 6] as usize) << 8)
            | (h[i + 7] as usize);
        let body_start = i + 10;
        let body_end = (body_start + fsz).min(end);
        if fsz == 0 || body_end <= body_start {
            break;
        }
        match id {
            b"TIT2" if out.title.is_empty() => out.title = id3_text(&h[body_start..body_end]),
            b"TPE1" if out.artist.is_empty() => out.artist = id3_text(&h[body_start..body_end]),
            _ => {}
        }
        i = body_end;
    }
    out
}

/// 从文件头读标签。读不到就返回空（前端把空当「没标签」）。
pub fn sniff_tags(h: &[u8], content_type: &str) -> AudioTags {
    // 整个 16KB 都扫：FLAC 的 VORBIS_COMMENT 常常排在几百 KB 的封面后面，
    // 8KB 窗口会整块跳过（实测那份 fLaC 就是这样）
    let head = if h.len() > 16384 { &h[..16384] } else { h };
    if head.len() > 3 && &head[0..3] == b"ID3" {
        return id3_tags(head);
    }
    let is_ogg = head.len() > 4 && &head[0..4] == b"OggS";
    let is_flac = head.len() > 4 && &head[0..4] == b"fLaC";
    if is_ogg
        || is_flac
        || content_type.contains("ogg")
        || content_type.contains("flac")
        || content_type.contains("opus")
    {
        return AudioTags {
            title: vorbis_field(head, "TITLE"),
            artist: vorbis_field(head, "ARTIST"),
        };
    }
    AudioTags::default()
}

pub fn probe_audio(url: &str) -> Result<ProbeAudio, String> {
    let a = agent();
    let resp = a
        .get(url)
        // 16KB：ID3 标签（带封面）常常超过 2KB，只读 2KB 会连第一帧都摸不到，
        // 时长就无从校验。16KB 对任何 CDN 都是可以忽略的流量。
        .set("Range", "bytes=0-16383")
        // 4 秒：探活是**串在起播链路上**的一步，10 秒的等待只会让「点了半天没声音」更久。
        // 真慢的源本来就该判失败去换下一个，而不是挂着。
        .timeout(Duration::from_secs(4))
        .call();

    let resp = match resp {
        Ok(r) => r,
        // 4xx/5xx：把状态码带回去，调用方据此说明「地址无效」
        Err(ureq::Error::Status(code, _)) => return Err(format!("直链不可用（HTTP {code}）")),
        Err(e) => return Err(format!("直链不可达（{e}）")),
    };

    let status = resp.status();
    if status != 200 && status != 206 {
        return Err(format!("直链不可用（HTTP {status}）"));
    }
    let content_type = resp.header("content-type").unwrap_or("").to_ascii_lowercase();
    if content_type.starts_with("text/") || content_type.contains("json") || content_type.contains("xml") {
        return Err(format!("直链返回的不是音频（{content_type}）"));
    }

    /*
     * 总长度有两个来源，优先 `content-range`：
     *   · 206 + `bytes 0-2047/10359162` → 最后那个数字才是整首的大小
     *   · 200（服务端不认 Range）→ `content-length` 就是整首
     * 两个都没有就记 0，前端会跳过校验。
     */
    let total = resp
        .header("content-range")
        .and_then(|v| v.rsplit('/').next().map(|s| s.trim().to_string()))
        .and_then(|s| s.parse::<i64>().ok())
        .or_else(|| resp.header("content-length").and_then(|v| v.trim().parse::<i64>().ok()))
        .unwrap_or(0);

    let mut head = Vec::new();
    resp.into_reader()
        .take(16 * 1024)
        .read_to_end(&mut head)
        .map_err(|e| format!("直链读取失败（{e}）"))?;
    if head.is_empty() {
        return Err("直链返回了空内容".to_string());
    }
    let duration = sniff_duration(&head, total, &content_type);
    let tags = sniff_tags(&head, &content_type);
    Ok(ProbeAudio {
        got: head.len() as u64,
        total,
        content_type,
        status,
        duration,
        title: tags.title.chars().take(80).collect(),
        artist: tags.artist.chars().take(80).collect(),
    })
}

/// 本地音频文件的真实时长（秒）。
///
/// 用在音频缓存上：缓存是「曲目 id + 扩展名」存的，当初下载的那份是错的，
/// 之后每次点这首歌都是错的，而且因为命中缓存**根本不会再出网**，
/// 校验一次都不会跑。只有把文件本身读一遍才知道它到底多长。
pub fn local_duration(path: &str) -> Result<f64, String> {
    use lofty::file::AudioFile;
    let p = std::path::Path::new(path);
    let probe = lofty::probe::Probe::open(p).map_err(|e| format!("读不出音频信息：{e}"))?;
    let f: lofty::file::TaggedFile = probe.read().map_err(|e| format!("读不出音频信息：{e}"))?;
    Ok(f.properties().duration().as_secs_f64())
}

/// 本地音频文件自己写的标题 / 歌手（读不到是空串）。
///
/// 给**缓存**用：缓存是按「曲目 id」存的，一旦某次拿到的是另一首歌，这份错文件
/// 从此就跟着这个 id 定居，之后每次点它都命中缓存、根本不出网，`verify` 一次都不跑。
/// 只有把文件本体的标签读出来，才知道硬盘上那份到底是谁。
pub fn local_tags(path: &str) -> Result<(String, String), String> {
    use lofty::file::AudioFile;
    use lofty::file::TaggedFileExt;
    use lofty::tag::Accessor;
    let p = std::path::Path::new(path);
    let probe = lofty::probe::Probe::open(p).map_err(|e| format!("读不出音频信息：{e}"))?;
    let f: lofty::file::TaggedFile = probe.read().map_err(|e| format!("读不出音频信息：{e}"))?;
    let _ = f.properties();
    let tag = f.primary_tag().or_else(|| f.first_tag());
    let (title, artist) = match tag {
        Some(t) => (
            t.title().map(|s| s.to_string()).unwrap_or_default(),
            t.artist().map(|s| s.to_string()).unwrap_or_default(),
        ),
        None => (String::new(), String::new()),
    };
    Ok((title.chars().take(80).collect(), artist.chars().take(80).collect()))
}

/* ------------------------------------------------------------------ */
/* 冒烟测试（默认跳过，要真跑网络时设 SHUYIN_NET_TEST=1）              */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    fn enabled() -> bool {
        std::env::var("SHUYIN_NET_TEST").map(|v| v == "1").unwrap_or(false)
    }

    #[test]
    fn net_request_gets_json() {
        if !enabled() {
            return;
        }
        let mut h = HashMap::new();
        h.insert("Referer".to_string(), "https://music.163.com/".to_string());
        let r = request(
            "GET",
            "https://music.163.com/api/v6/playlist/detail?id=3778678&n=3",
            &h,
            None,
            None,
            false,
            10_000,
        )
        .expect("请求失败");
        assert_eq!(r.status, 200);
        assert!(r.body.contains("\"playlist\""), "body 头部：{}", &r.body[..200.min(r.body.len())]);
        println!("net_request OK，body {} 字节", r.body.len());
    }

    #[test]
    fn range_reader_streams_and_seeks() {
        if !enabled() {
            return;
        }
        // 用平台接口拿一个真实直链不稳，这里直接读一个公开的 mp3 头
        let url = "https://music.163.com/song/media/outer/url?id=509781655.mp3";
        let mut rd = HttpRangeReader::open(url).expect("打开音频流失败");
        let mut head = vec![0u8; 4096];
        let n = rd.read(&mut head).expect("读失败");
        assert!(n > 0, "读到 0 字节");
        println!("首块 {n} 字节，总长 {}", rd.byte_len());
        // 往回 seek 再读，内容必须一致
        rd.seek(SeekFrom::Start(0)).expect("seek 失败");
        let mut again = vec![0u8; 64];
        rd.read_exact(&mut again).expect("重读失败");
        assert_eq!(&head[..64], &again[..], "seek 后内容不一致");
        println!("seek 回读一致");
    }
}
