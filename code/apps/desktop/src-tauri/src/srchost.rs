//! 音源脚本宿主（原生）：内嵌 QuickJS 跑洛雪音源脚本。
//!
//! ## 为什么要搬进原生
//!
//! 播放地址只能由「音源脚本」给出（`@shuyin/lx-provider` 的平台层只负责搜索、
//! 歌词、评论，不出链）。这些脚本原先跑在 WebView 的 Worker 里，而 iOS 切后台后
//! WebView 的 JS 会被系统冻住：曲终时拿不到下一首的地址，用户听到的就是
//! 「放完这首就停」。脚本在原生进程里跑，后台接歌就不再依赖 WebView 是否活着。
//!
//! ## 宿主契约（必须与前端 `lxWorkerBoot.ts` 逐条对齐）
//!
//!   · `lx.on('request', fn)`          注册取链处理器
//!   · `lx.send('inited', { sources })` 声明支持哪些平台的哪些音质
//!   · `lx.request(url, opts, cb)`     出网
//!   · 处理器入参：`{ source, action: 'musicUrl', info: { type: 音质, musicInfo } }`
//!
//! 与 Worker 版的两处刻意差异：
//!   1. **HTTP 是同步的**：宿主线程用 ureq 阻塞请求，回来直接调 cb。脚本里
//!      `new Promise(r => lx.request(u, o, r))` 的写法照样成立。
//!   2. **补齐 QuickJS 没有的 Web API**：btoa/atob、TextEncoder/TextDecoder、
//!      crypto.getRandomValues、URL/URLSearchParams、定时器。音源脚本大量用它们，
//!      不补的话一加载就抛 `atob is not defined`。
//!
//! ## 线程模型
//!
//! `Context` / `Runtime` 都不是 `Send`，宿主独占一个线程，外部只拿 `Sender`。
//! 取链是「发命令 → 等回复」的阻塞调用，调用方自己控超时。

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::mpsc::{channel, Sender};
use std::time::{Duration, Instant};

use rquickjs::{Context, Ctx, Function, Runtime};

/// 音质从低到高（与前端 `QUALITY_ORDER` 一致）
const QUALITY_ORDER: [&str; 9] = [
    "128k", "192k", "320k", "flac", "flac24bit", "hires", "atmos", "atmos_plus", "master",
];

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/* ------------------------------------------------------------------ */
/* 对外模型                                                             */
/* ------------------------------------------------------------------ */

/// 前端递过来的「接下来要放的歌」及取链所需原料。
///
/// 和 `next_prefetch` 的区别：那份是**已经取好的直链**，这份是**原料**
/// （平台 + 原始对象 + 音质）。原生只在直链表空了、JS 又被冻住时才动它。
#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainItem {
    pub index: usize,
    /// 曲目 id。原生不取链也能用它去缓存目录里找现成的文件（离线后台）。
    #[serde(default)]
    pub id: String,
    /// 平台：wy / tx / kg / kw
    pub platform: String,
    /// 期望音质（实际按脚本声明的档位逐级往下退）
    #[serde(default)]
    pub quality: String,
    /// 洛雪 `musicInfo`：平台原始对象（各家脚本认的字段不同，必须原样带过来）。
    ///
    /// 存的是**原始 JSON 文本**而不是 `Value` 树：整张歌单几千首会一直躺在
    /// 内存里，展开成树要十几 MB，iOS 后台就会因为内存被系统杀掉——那比
    /// 「放完就停」更糟。取链时只解析当前这一首（几百字节，忽略不计）。
    #[serde(default)]
    pub raw: Option<String>,
    #[serde(default)]
    pub duration: f64,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub artist: String,
    #[serde(default)]
    pub album: String,
    #[serde(default)]
    pub cover: String,
    /// 本地文件 / 整曲缓存命中时的路径：有它就不用取链
    #[serde(default)]
    pub path: Option<String>,
}

/// 一个可用音源：名字 + **脚本体**。
///
/// 为什么递正文而不是路径：音源自 v0.4.5 起就不是「一个音源一个 .js 文件」了，
/// 全塞在 `sources.json` 清单里、code 直接内嵌。清单地址是个合成串
/// （`…/sources.json#名字`），拿它去 `read_to_string` 必然 ENOENT。
/// 2026-11-24 用户日志里的 `relay 失败 … 读不到脚本: No such file or directory`
/// 就是这条：原生手里有整张歌单，却连一个音源都起不来，曲终只能停住。
#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainSource {
    /// 清单里的名字。只用于日志与缓存键，不参与取链逻辑。
    #[serde(default)]
    pub name: String,
    /// 洛雪 lx 脚本源码。
    #[serde(default)]
    pub code: String,
}

impl ChainSource {
    fn label(&self) -> String {
        if self.name.is_empty() {
            "未命名音源".to_string()
        } else {
            self.name.clone()
        }
    }

    /// 缓存键：名字 + 正文指纹。
    ///
    /// 不能只用名字——用户重新导入同一个名字的音源（更新版本）时正文变了，
    /// 按名字命中就会拿旧脚本取链，表现为「换了新音源还是老样子」。
    fn key(&self) -> String {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for b in self.code.as_bytes() {
            h ^= *b as u64;
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
        format!("{}#{h:x}", self.name)
    }
}

/// 前端一次递过来的整份「原生取链上下文」。
#[derive(Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainPayload {
    /// 已启用的音源脚本（正文随包递来），顺序 = 取链优先级
    #[serde(default)]
    pub scripts: Vec<ChainSource>,

    /// 平台 → 登录 cookie 整串
    #[serde(default)]
    pub cookies: HashMap<String, String>,
    #[serde(default)]
    pub items: Vec<ChainItem>,
    /// 窗口是否首尾相接（队列本身是循环的）。
    ///
    /// 三个播放模式（列表循环 / 单曲循环 / 随机）在 `advance` 里**都会回绕**，
    /// 所以前端递过来的是「从当前这首开始的一个完整周期」。原生走到最后一项
    /// 必须回到第一项继续——不回绕的话后台就只能撑一个周期（60 首或一个歌单
    /// 就停，2026-11-24 用户反馈「四小时还是会停」的根因）。
    #[serde(default, rename = "loop")]
    pub looping: bool,
}

/* ------------------------------------------------------------------ */
/* 宿主句柄                                                             */
/* ------------------------------------------------------------------ */

enum HostCmd {
    Resolve {
        source: ChainSource,
        platform: String,
        quality: String,
        raw: serde_json::Value,
        cookies: HashMap<String, String>,
        budget_ms: u64,
        reply: Sender<Result<String, String>>,
    },
}

/// 原生音源宿主。克隆廉价（只包一个 Sender），可跨线程传。
#[derive(Clone)]
pub struct ScriptHost {
    tx: Sender<HostCmd>,
}

impl ScriptHost {
    pub fn new() -> ScriptHost {
        ScriptHost::new_with_log(|_| {})
    }

    /// `log` 用来把脚本加载/报错写进 app.log（宿主线程不该直接 println）
    pub fn new_with_log<F>(log: F) -> ScriptHost
    where
        F: Fn(&str) + Send + 'static,
    {
        let (tx, rx) = channel::<HostCmd>();
        std::thread::Builder::new()
            .name("shuyin-srchost".into())
            .spawn(move || worker(rx, log))
            .expect("音源宿主线程起不来");
        ScriptHost { tx }
    }

    /// 按脚本优先级逐级取链：谁先给出 URL 用谁，单档 6s，总预算 `budget_ms`。
    pub fn resolve(
        &self,
        scripts: &[ChainSource],
        platform: &str,
        quality: &str,
        raw: &serde_json::Value,
        cookies: &HashMap<String, String>,
        budget_ms: u64,
    ) -> Result<String, String> {
        if scripts.is_empty() {
            return Err("没有可用音源脚本".into());
        }
        let deadline = Instant::now() + Duration::from_millis(budget_ms.max(1_500));
        let mut last = String::from("所有音源都没能取到播放地址");
        for source in scripts {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                last = format!("{last}（已超时）");
                break;
            }
            // 空正文十有八九是清单损坏 / 取 code 失败。直接报出来比让它
            // 去 QuickJS 里抛一个「语法错误」更容易定位。
            if source.code.trim().is_empty() {
                last = format!("{}: 脚本正文是空的", source.label());
                continue;
            }
            let (tx, rx) = channel();
            if self
                .tx
                .send(HostCmd::Resolve {
                    source: source.clone(),
                    platform: platform.to_string(),
                    quality: quality.to_string(),
                    raw: raw.clone(),
                    cookies: cookies.clone(),
                    budget_ms: left.as_millis() as u64,
                    reply: tx,
                })
                .is_err()
            {
                return Err("音源宿主已退出".into());
            }
            match rx.recv_timeout(left + Duration::from_millis(800)) {
                Ok(Ok(url)) if !url.is_empty() => return Ok(url),
                Ok(Ok(_)) => last = format!("{}: 返回了空地址", source.label()),
                Ok(Err(e)) => last = format!("{}: {e}", source.label()),
                Err(_) => last = format!("{}: 取链超时", source.label()),
            }
        }
        Err(last)
    }
}

/* ------------------------------------------------------------------ */
/* 宿主线程                                                             */
/* ------------------------------------------------------------------ */

struct Loaded {
    key: String,
    /// 持有它只为「别让 runtime 提前 drop」——脚本上下文挂在它身上
    #[allow(dead_code)]
    rt: Runtime,
    ctx: Context,
    inited: serde_json::Value,
    cookies: Rc<RefCell<HashMap<String, String>>>,
}

fn worker<F>(rx: std::sync::mpsc::Receiver<HostCmd>, log: F)
where
    F: Fn(&str) + Send + 'static,
{
    let mut loaded: Vec<Loaded> = Vec::new();
    while let Ok(HostCmd::Resolve { source, platform, quality, raw, cookies, budget_ms, reply }) = rx.recv() {
        let r = resolve_with(&mut loaded, &source, &cookies, &log, |ctx, inited| {
            resolve_in(ctx, inited, &platform, &quality, &raw, budget_ms)
        });
        let _ = reply.send(r);
    }
}

/// 取（必要时加载）某个脚本的上下文，然后在里面干活。
fn resolve_with<F, L>(
    loaded: &mut Vec<Loaded>,
    source: &ChainSource,
    cookies: &HashMap<String, String>,
    log: &L,
    f: F,
) -> Result<String, String>
where
    F: FnOnce(&Ctx<'_>, &serde_json::Value) -> Result<String, String>,
    L: Fn(&str),
{
    let key = source.key();
    let pos = match loaded.iter().position(|l| l.key == key) {
        Some(i) => i,
        None => {
            let l = load_script(source, cookies, log)?;
            loaded.push(l);
            loaded.len() - 1
        }
    };
    let l = &loaded[pos];
    // cookie 每轮可能变（用户刚登录），取链前刷一遍
    *l.cookies.borrow_mut() = cookies.clone();
    let inited = l.inited.clone();
    l.ctx.with(|ctx| f(&ctx, &inited))
}

fn load_script<L>(source: &ChainSource, cookies: &HashMap<String, String>, log: &L) -> Result<Loaded, String>
where
    L: Fn(&str),
{
    if source.code.trim().is_empty() {
        return Err("脚本正文是空的".into());
    }
    let code = &source.code;
    let rt = Runtime::new().map_err(|e| format!("QuickJS 初始化失败: {e}"))?;
    let ctx = Context::full(&rt).map_err(|e| format!("QuickJS 上下文失败: {e}"))?;
    let jar = Rc::new(RefCell::new(cookies.clone()));
    ctx.with(|ctx| -> Result<(), String> {
        install_host(&ctx, jar.clone())?;
        // 与 Worker 版一致：脚本体在全局作用域直接执行（洛雪脚本依赖顶层声明可见）
        ctx.eval::<(), _>(code.as_bytes())
            .map_err(|e| format!("脚本执行出错: {}", js_err(&ctx, e)))?;
        // 有些脚本在 setTimeout 里才 send('inited')：给它几拍
        pump(&ctx, Instant::now() + Duration::from_millis(3_000));
        Ok(())
    })?;
    let inited = ctx.with(|ctx| -> Result<serde_json::Value, String> {
        let raw: String = ctx
            .eval("JSON.stringify(globalThis.__lx_inited || { sources: {} })")
            .map_err(|e| format!("读不到 inited: {}", js_err(&ctx, e)))?;
        Ok(serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::json!({ "sources": {} })))
    })?;
    log(&format!("[srchost] 已加载 {}（{} 字）", source.label(), code.len()));
    Ok(Loaded {
        key: source.key(),
        rt,
        ctx,
        inited,
        cookies: jar,
    })
}

/// 在一个脚本上下文里按音质阶梯调 `musicUrl`。
fn resolve_in(
    ctx: &Ctx<'_>,
    inited: &serde_json::Value,
    platform: &str,
    quality: &str,
    raw: &serde_json::Value,
    budget_ms: u64,
) -> Result<String, String> {
    /*
     * 脚本显式声明了「支持哪些平台」时，没声明的一律不调——和前端
     * `SourceManager.chainFor(platform)` 的过滤一致。只声明了 tx 的脚本
     * 去试 wy，除了白等一轮没有任何好处。
     * `sources` 是空对象（脚本压根没 send('inited')）时不拦：让它试一次，
     * 有些源是「请求时才懒加载」的。
     */
    let declared = inited.get("sources").and_then(|s| s.as_object());
    if let Some(map) = declared {
        if !map.is_empty() && !map.contains_key(platform) {
            return Err(format!("音源未声明支持 {platform}"));
        }
    }
    let ladder = quality_ladder(inited, platform, quality);
    let deadline = Instant::now() + Duration::from_millis(budget_ms);
    let mut last = String::from("取链失败");
    for q in ladder {
        if Instant::now() >= deadline {
            return Err(format!("{last}（已超时）"));
        }
        let payload = serde_json::json!({
            "source": platform,
            "action": "musicUrl",
            "info": { "type": q, "musicInfo": raw },
        });
        match call_handler(ctx, &payload, deadline) {
            Ok(url) if !url.is_empty() => return Ok(url),
            Ok(_) => last = format!("音质 {q} 返回了空地址"),
            Err(e) => last = format!("音质 {q}: {e}"),
        }
    }
    Err(last)
}

/// 请求档 + 逐级往下（脚本没声明的档位跳过），与前端 `qualitiesToTry` 同义。
fn quality_ladder(inited: &serde_json::Value, platform: &str, wanted: &str) -> Vec<String> {
    /*
     * inited 的形状（洛雪约定）：
     *   { sources: { kg: { qualitys: ['128k','320k','flac'], ... } } }
     * 有些脚本不写 qualitys —— 那就别拦，按请求档直接试一次。
     */
    let supported: Vec<String> = inited
        .get("sources")
        .and_then(|s| s.get(platform))
        .and_then(|p| p.get("qualitys"))
        .and_then(|q| q.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str()).map(|s| s.to_string()).collect())
        .unwrap_or_default();
    let wanted = if wanted.is_empty() { "320k" } else { wanted };
    let mut out = vec![wanted.to_string()];
    if let Some(mut i) = QUALITY_ORDER.iter().position(|q| *q == wanted) {
        while i > 0 {
            i -= 1;
            let q = QUALITY_ORDER[i];
            if supported.iter().any(|s| s == q) && !out.iter().any(|o| o == q) {
                out.push(q.to_string());
            }
        }
    }
    out
}

/// 调脚本的 request 处理器，抽完微任务与定时器后取结果。
fn call_handler(
    ctx: &Ctx<'_>,
    payload: &serde_json::Value,
    deadline: Instant,
) -> Result<String, String> {
    let lit = json_literal(payload);
    ctx.eval::<(), _>(format!("globalThis.__lx_start({lit})").as_bytes())
        .map_err(|e| format!("调用处理器失败: {}", js_err(ctx, e)))?;
    pump(ctx, deadline);
    let done: bool = ctx.eval("globalThis.__lx_state.done").unwrap_or(false);
    if !done {
        return Err("处理器没有在预算内返回".into());
    }
    let err: String = ctx.eval("globalThis.__lx_state.error").unwrap_or_default();
    if !err.is_empty() {
        return Err(err.trim().to_string());
    }
    let v: String = ctx.eval("globalThis.__lx_state.value").unwrap_or_default();
    Ok(v)
}

/// 抽微任务 + 跑到期的定时器，直到 Promise 落定或到点。
fn pump(ctx: &Ctx<'_>, deadline: Instant) {
    loop {
        while ctx.execute_pending_job() {}
        if ctx.eval::<bool, _>("globalThis.__lx_state.done").unwrap_or(true) {
            return;
        }
        let left = ctx.eval::<i32, _>("globalThis.__lx_tick()").unwrap_or(0);
        if ctx.eval::<bool, _>("globalThis.__lx_state.done").unwrap_or(true) {
            return;
        }
        if Instant::now() >= deadline {
            // 超时也把状态标成已决，免得下一轮读到上一首的残留
            let _ = ctx.eval::<(), _>("globalThis.__lx_state.done = true");
            return;
        }
        std::thread::sleep(Duration::from_millis(if left > 0 { 4 } else { 12 }));
    }
}

fn js_err(ctx: &Ctx<'_>, e: rquickjs::Error) -> String {
    // QuickJS 的异常对象能拿到 message，拿不到就退回 Display
    match e {
        rquickjs::Error::Exception => ctx
            .catch()
            .as_exception()
            .and_then(|ex| ex.message())
            .unwrap_or_else(|| "脚本异常".into()),
        other => other.to_string(),
    }
}

/// JSON → JS 字面量。U+2028/U+2029 在 JS 里会截断字符串，必须转义。
fn json_literal(v: &serde_json::Value) -> String {
    serde_json::to_string(v)
        .unwrap_or_else(|_| "null".into())
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

/* ------------------------------------------------------------------ */
/* 出网桥                                                               */
/* ------------------------------------------------------------------ */

/// 平台登录 cookie 按域名注入（与前端 `COOKIE_HOSTS` 同一张表）。
fn platform_of_host(host: &str) -> Option<&'static str> {
    let h = host.to_ascii_lowercase();
    if h == "music.163.com" || h.ends_with(".music.163.com") {
        Some("wy")
    } else if h == "y.qq.com" || h.ends_with(".y.qq.com") {
        Some("tx")
    } else if h == "kuwo.cn" || h.ends_with(".kuwo.cn") {
        Some("kw")
    } else if h == "kugou.com" || h.ends_with(".kugou.com") {
        Some("kg")
    } else {
        None
    }
}

/// 合并 cookie：同名以脚本自己写的为准，登录凭证补在后面（前端 `mergeCookie` 同义）
fn merge_cookie(existing: &str, login: &str) -> String {
    let mut bag: Vec<(String, String)> = Vec::new();
    for part in existing.split(';') {
        let mut it = part.splitn(2, '=');
        let k = it.next().unwrap_or("").trim().to_string();
        let v = it.next().unwrap_or("").trim().to_string();
        if !k.is_empty() {
            bag.push((k, v));
        }
    }
    for part in login.split(';') {
        let mut it = part.splitn(2, '=');
        let k = it.next().unwrap_or("").trim().to_string();
        let v = it.next().unwrap_or("").trim().to_string();
        if !k.is_empty() && !bag.iter().any(|(n, _)| *n == k) {
            bag.push((k, v));
        }
    }
    bag.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("; ")
}

fn http_bridge(req: &str, jar: &HashMap<String, String>) -> String {
    #[derive(serde::Deserialize)]
    struct Req {
        url: String,
        #[serde(default)]
        options: Opts,
    }
    #[derive(serde::Deserialize, Default)]
    struct Opts {
        #[serde(default)]
        method: Option<String>,
        #[serde(default)]
        headers: HashMap<String, String>,
        #[serde(default)]
        body: Option<String>,
        #[serde(default)]
        timeout: Option<u64>,
    }

    let req: Req = match serde_json::from_str(req) {
        Ok(v) => v,
        Err(e) => return serde_json::json!({ "error": format!("请求参数不合法: {e}") }).to_string(),
    };
    let method = req.options.method.unwrap_or_else(|| "GET".into()).to_uppercase();
    let timeout = Duration::from_millis(req.options.timeout.unwrap_or(12_000).clamp(1_000, 30_000));

    let host = {
        let rest = req.url.split("://").nth(1).unwrap_or("");
        rest.split(['/', '?']).next().unwrap_or("").split(':').next().unwrap_or("")
    };
    let mut headers = req.options.headers.clone();
    if let Some(p) = platform_of_host(host) {
        if let Some(login) = jar.get(p).filter(|s| !s.is_empty()) {
            let key = headers
                .keys()
                .find(|k| k.eq_ignore_ascii_case("cookie"))
                .cloned()
                .unwrap_or_else(|| "Cookie".into());
            let merged = merge_cookie(headers.get(&key).cloned().unwrap_or_default().as_str(), login);
            headers.insert(key, merged);
        }
    }

    /*
     * 必须显式接系统 TLS：Cargo.toml 里 ureq 关了 default-features（只留 native-tls），
     * 这种配置下 AgentBuilder 不会自带 TLS 后端，发 https 会直接报
     * "cannot make HTTPS request because no TLS backend is configured"。
     *
     * net.rs 的共享出网 agent 早就做了这件事，但脚本宿主这条桥是另一条独立通道，
     * 一直用裸 agent —— 桌面端音源跑在 WebView（fetch 有系统 TLS）所以看不出来；
     * iOS 切后台后 WebView 被冻结，接歌全靠这里的原生 relay，
     * 于是后面的 https 取链全失败：预取那几首放完就停。
     */
    let mut builder = ureq::AgentBuilder::new()
        .user_agent(UA)
        .timeout_connect(Duration::from_secs(10))
        .timeout(timeout)
        .redirects(6);
    match ureq::native_tls::TlsConnector::new() {
        Ok(c) => builder = builder.tls_connector(std::sync::Arc::new(c)),
        Err(e) => eprintln!("srchost TLS 初始化失败（音源 https 请求会不可用）：{e}"),
    }
    let agent = builder.build();
    let mut r = match method.as_str() {
        "POST" => agent.post(&req.url),
        "PUT" => agent.put(&req.url),
        "DELETE" => agent.delete(&req.url),
        "HEAD" => agent.head(&req.url),
        _ => agent.get(&req.url),
    };
    for (k, v) in &headers {
        r = r.set(k, v);
    }
    let resp = match req.options.body.as_deref() {
        Some(b) => r.send_string(b),
        None => r.call(),
    };

    let resp = match resp {
        Ok(v) => v,
        // 4xx/5xx 也是「正常响应」：脚本要读 body 里的 error_code
        Err(ureq::Error::Status(_, v)) => v,
        Err(e) => return serde_json::json!({ "error": format!("网络请求失败: {e}") }).to_string(),
    };
    let status = resp.status();
    let mut hmap = serde_json::Map::new();
    for name in resp.headers_names() {
        if let Some(v) = resp.header(&name) {
            hmap.insert(name.to_ascii_lowercase(), serde_json::Value::String(v.to_string()));
        }
    }
    // 脚本要的是**原始字符串 body**（自己 JSON.parse），这里不解析
    let body = resp.into_string().unwrap_or_default();
    serde_json::json!({
        "response": { "statusCode": status, "headers": hmap, "body": body }
    })
    .to_string()
}

/* ------------------------------------------------------------------ */
/* JS 垫片                                                              */
/* ------------------------------------------------------------------ */

fn install_host(ctx: &Ctx<'_>, jar: Rc<RefCell<HashMap<String, String>>>) -> Result<(), String> {
    let cb = jar.clone();
    let http = Function::new(ctx.clone(), move |req: String| -> String {
        http_bridge(&req, &cb.borrow())
    })
    .map_err(|e| format!("注册 http 桥失败: {e}"))?;
    ctx.globals()
        .set("__lx_http", http)
        .map_err(|e| format!("挂 http 桥失败: {e}"))?;
    ctx.eval::<(), _>(HOST_SHIM.as_bytes())
        .map_err(|e| format!("宿主垫片执行失败: {}", js_err(ctx, e)))
}

/// 宿主垫片：洛雪 `lx` API + QuickJS 缺的 Web API。
///
/// 这份代码必须能在**没有 DOM、没有 fetch、没有 btoa** 的 QuickJS 里跑，
/// 所以全部自己实现，不依赖任何运行时。
const HOST_SHIM: &str = r#"
(function () {
  var handlers = [];
  globalThis.__lx_handlers = handlers;
  globalThis.__lx_state = { done: true, value: '', error: '' };
  globalThis.__lx_inited = null;
  globalThis.__lx_logs = [];
  globalThis.self = globalThis;

  function fmtArgs(a) {
    var out = [];
    for (var i = 0; i < a.length; i++) {
      var v = a[i];
      if (typeof v === 'string') out.push(v);
      else if (v instanceof Error) out.push(v.message || String(v));
      else { try { out.push(JSON.stringify(v)) } catch (e) { out.push(String(v)) } }
    }
    return out.join(' ');
  }
  function pushLog(text) {
    var logs = globalThis.__lx_logs;
    logs.push(String(text));
    if (logs.length > 200) logs.splice(0, logs.length - 200);
  }

  var con = {};
  ['log', 'info', 'warn', 'error', 'debug', 'trace'].forEach(function (k) {
    con[k] = function () { pushLog(fmtArgs(arguments)) };
  });
  globalThis.console = con;

  /* ---- 定时器（宿主线程每拍调一次 __lx_tick） ---- */
  var timers = [], tid = 1;
  function addTimer(fn, ms, args, every) {
    var id = tid++;
    timers.push({ id: id, due: Date.now() + (ms || 0), fn: fn, args: args, every: every || 0 });
    return id;
  }
  globalThis.setTimeout = function (fn, ms) {
    return addTimer(fn, ms, Array.prototype.slice.call(arguments, 2), 0);
  };
  globalThis.setInterval = function (fn, ms) {
    return addTimer(fn, ms || 1, Array.prototype.slice.call(arguments, 2), ms || 1);
  };
  globalThis.clearTimeout = globalThis.clearInterval = function (id) {
    timers = timers.filter(function (t) { return t.id !== id });
  };
  globalThis.__lx_tick = function () {
    var now = Date.now(), due = [];
    timers = timers.filter(function (t) {
      if (t.due <= now) { due.push(t); return t.every > 0 }
      return true;
    });
    for (var i = 0; i < due.length; i++) {
      var t = due[i];
      if (t.every > 0) t.due = now + t.every;
      try { t.fn.apply(null, t.args) } catch (e) { con.error(e) }
    }
    return timers.length;
  };

  /* ---- base64 ---- */
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  globalThis.btoa = function (s) {
    s = String(s);
    var out = '';
    for (var i = 0; i < s.length; i += 3) {
      var a = s.charCodeAt(i) & 255;
      var hasB = i + 1 < s.length, hasC = i + 2 < s.length;
      var b = hasB ? (s.charCodeAt(i + 1) & 255) : 0;
      var c = hasC ? (s.charCodeAt(i + 2) & 255) : 0;
      out += B64.charAt(a >> 2);
      out += B64.charAt(((a & 3) << 4) | (b >> 4));
      out += hasB ? B64.charAt(((b & 15) << 2) | (c >> 6)) : '=';
      out += hasC ? B64.charAt(c & 63) : '=';
    }
    return out;
  };
  globalThis.atob = function (s) {
    s = String(s).replace(/[^A-Za-z0-9+/=]/g, '');
    var out = '';
    for (var i = 0; i < s.length; i += 4) {
      var c2 = s.charAt(i + 2), c3 = s.charAt(i + 3);
      var n = (B64.indexOf(s.charAt(i)) << 18) |
              (B64.indexOf(s.charAt(i + 1)) << 12) |
              ((c2 === '=' ? 0 : B64.indexOf(c2)) << 6) |
              (c3 === '=' ? 0 : B64.indexOf(c3));
      out += String.fromCharCode((n >> 16) & 255);
      if (c2 !== '=') out += String.fromCharCode((n >> 8) & 255);
      if (c3 !== '=') out += String.fromCharCode(n & 255);
    }
    return out;
  };

  /* ---- UTF-8 ---- */
  function utf8Bytes(s) {
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        var d = s.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) {
          c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
          i++;
        }
      }
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }
  function utf8String(bytes) {
    var out = '', i = 0;
    while (i < bytes.length) {
      var b = bytes[i++];
      if (b < 0x80) out += String.fromCharCode(b);
      else if (b >= 0xc0 && b < 0xe0) {
        out += String.fromCharCode(((b & 31) << 6) | (bytes[i++] & 63));
      } else if (b >= 0xe0 && b < 0xf0) {
        out += String.fromCharCode(((b & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63));
      } else {
        var cp = ((b & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
        cp -= 0x10000;
        out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023));
      }
    }
    return out;
  }
  globalThis.TextEncoder = function () { this.encoding = 'utf-8' };
  globalThis.TextEncoder.prototype.encode = function (s) { return new Uint8Array(utf8Bytes(String(s))) };
  globalThis.TextDecoder = function () { this.encoding = 'utf-8' };
  globalThis.TextDecoder.prototype.decode = function (buf) {
    if (!buf) return '';
    var a = (buf instanceof Uint8Array) ? buf : new Uint8Array(buf.buffer || buf);
    return utf8String(a);
  };

  /* ---- crypto.getRandomValues ---- */
  if (!globalThis.crypto) globalThis.crypto = {};
  if (!globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues = function (arr) {
      for (var i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
      return arr;
    };
  }

  /* ---- URLSearchParams / URL（脚本解析域名、拼接参数用） ---- */
  function searchToMap(s) {
    var m = [];
    s = String(s || '').replace(/^\?/, '');
    if (!s) return m;
    s.split('&').forEach(function (kv) {
      if (!kv) return;
      var i = kv.indexOf('=');
      var k = i < 0 ? kv : kv.slice(0, i);
      var v = i < 0 ? '' : kv.slice(i + 1);
      m.push([decodeURIComponent(k.replace(/\+/g, ' ')), decodeURIComponent(v.replace(/\+/g, ' '))]);
    });
    return m;
  }
  function URLSearchParams(init) {
    this._list = [];
    if (typeof init === 'string') this._list = searchToMap(init);
    else if (init && typeof init === 'object' && init._list) this._list = init._list.slice();
  }
  URLSearchParams.prototype.get = function (k) {
    for (var i = 0; i < this._list.length; i++) if (this._list[i][0] === k) return this._list[i][1];
    return null;
  };
  URLSearchParams.prototype.getAll = function (k) {
    var out = [];
    for (var i = 0; i < this._list.length; i++) if (this._list[i][0] === k) out.push(this._list[i][1]);
    return out;
  };
  URLSearchParams.prototype.has = function (k) { return this.get(k) !== null };
  URLSearchParams.prototype.set = function (k, v) {
    for (var i = 0; i < this._list.length; i++) if (this._list[i][0] === k) { this._list[i][1] = String(v); return }
    this._list.push([k, String(v)]);
  };
  URLSearchParams.prototype.append = function (k, v) { this._list.push([k, String(v)]) };
  URLSearchParams.prototype.toString = function () {
    return this._list.map(function (p) {
      return encodeURIComponent(p[0]) + '=' + encodeURIComponent(p[1]);
    }).join('&');
  };
  globalThis.URLSearchParams = URLSearchParams;

  globalThis.URL = function (u, base) {
    var s = String(u);
    if (base && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
      var b = String(base).replace(/\/[^/]*$/, '/');
      s = b + s.replace(/^\//, '');
    }
    var m = /^([a-z][a-z0-9+.-]*:)\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(s);
    if (!m) throw new TypeError('Invalid URL: ' + s);
    this.protocol = m[1];
    this.hash = m[5] || '';
    var auth = m[2] || '';
    var at = auth.lastIndexOf('@');
    if (at >= 0) auth = auth.slice(at + 1);
    var hp = auth.split(':');
    this.hostname = hp[0] || '';
    this.port = hp[1] || '';
    this.host = this.port ? this.hostname + ':' + this.port : this.hostname;
    this.pathname = m[3] || '/';
    this.search = m[4] || '';
    this.searchParams = new URLSearchParams(this.search);
    this.origin = this.protocol + '//' + this.host;
    this.href = s;
  };
  globalThis.URL.prototype.toString = function () { return this.href };

  /* ---- 洛雪宿主 API ---- */
  globalThis.lx = {
    EVENT_NAMES: { request: 'request', inited: 'inited', updateAlert: 'updateAlert' },
    env: { lang: 'zh_cn', version: '2.9.1' },
    version: '2.9.1',
    currentScriptInfo: { name: '', description: '', version: '', author: '', homepage: '', rawScript: '' },
    on: function (name, fn) {
      if (name === 'request' && typeof fn === 'function') handlers.push(fn);
    },
    send: function (name, data) {
      if (name === 'inited') globalThis.__lx_inited = data;
    },
    request: function (url, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {} }
      var o = opts || {};
      var out;
      try {
        out = JSON.parse(globalThis.__lx_http(JSON.stringify({
          url: String(url),
          options: { method: o.method || 'GET', headers: o.headers || {}, body: o.body, timeout: o.timeout }
        })));
      } catch (e) {
        out = { error: (e && e.message) || String(e) };
      }
      if (typeof cb === 'function') {
        cb(out.error ? new Error(out.error) : null, out.response);
      }
    },
    utils: { crypto: {}, buffer: {} }
  };

  /* 宿主调用入口：跑处理器，结果写回 __lx_state */
  globalThis.__lx_start = function (payload) {
    globalThis.__lx_state = { done: false, value: '', error: '' };
    var st = globalThis.__lx_state;
    try {
      if (!handlers.length) throw new Error('该音源没有注册 request 处理器');
      Promise.resolve()
        .then(function () { return handlers[0](payload) })
        .then(function (v) {
          st.value = (typeof v === 'string') ? v : (v == null ? '' : String(v));
          st.done = true;
        })
        .catch(function (e) {
          st.error = (e && e.message) || String(e);
          st.done = true;
        });
    } catch (e) {
      st.error = (e && e.message) || String(e);
      st.done = true;
    }
  };
})();
"#;

#[cfg(test)]
mod tests {
    use super::*;

    /// 冒烟：引擎能起、能求值、能跑 Promise 微任务
    #[test]
    fn engine_smoke() {
        let rt = Runtime::new().unwrap();
        let ctx = Context::full(&rt).unwrap();
        ctx.with(|ctx| {
            let v: i32 = ctx.eval("1 + 2").unwrap();
            assert_eq!(v, 3);
            ctx.eval::<(), _>("globalThis.out = ''; Promise.resolve('ok').then(v => { globalThis.out = v })")
                .unwrap();
            while ctx.execute_pending_job() {}
            let out: String = ctx.eval("globalThis.out").unwrap();
            assert_eq!(out, "ok");
        });
    }

    /// 宿主垫片：btoa/atob、TextEncoder、URLSearchParams 的往返
    #[test]
    fn shim_polyfills() {
        let rt = Runtime::new().unwrap();
        let ctx = Context::full(&rt).unwrap();
        ctx.with(|ctx| {
            ctx.eval::<(), _>(HOST_SHIM.as_bytes()).unwrap();
            // btoa/atob 只认 Latin1（与浏览器一致）：UTF-8 走 TextEncoder 再自己编
            let b64: String = ctx.eval("btoa('abc')").unwrap();
            assert_eq!(b64, "YWJj");
            let back: String = ctx.eval("atob('YWJj')").unwrap();
            assert_eq!(back, "abc");

            // TextEncoder/TextDecoder 的 UTF-8 往返
            let len: i32 = ctx.eval("new TextEncoder().encode('疏音').length").unwrap();
            assert_eq!(len, 6);
            let txt: String = ctx
                .eval("new TextDecoder().decode(new TextEncoder().encode('疏音 abc'))")
                .unwrap();
            assert_eq!(txt, "疏音 abc");

            let host: String = ctx.eval("new URL('https://y.qq.com/a?b=1').hostname").unwrap();
            assert_eq!(host, "y.qq.com");
            let param: String = ctx.eval("new URL('https://x/a?b=1&c=2').searchParams.get('c')").unwrap();
            assert_eq!(param, "2");
        });
    }

    /// 用「假音源脚本」跑完整链路：inited → request handler → lx.request（拦住不出网）
    #[test]
    fn fake_script_resolves() {
        let shim_script = r#"
          lx.on('request', function (payload) {
            if (payload.action !== 'musicUrl') return ''
            return Promise.resolve('https://example.com/' + payload.info.musicInfo.songmid + '.' + payload.info.type + '.mp3')
          })
          lx.send('inited', { sources: { tx: { name: '假源', qualitys: ['128k', '320k', 'flac'] } } })
        "#;
        let src = ChainSource { name: "假源".into(), code: shim_script.into() };

        let host = ScriptHost::new();
        let raw = serde_json::json!({ "songmid": "abc123" });
        let url = host
            .resolve(std::slice::from_ref(&src), "tx", "flac", &raw, &HashMap::new(), 5_000)
            .unwrap();
        assert_eq!(url, "https://example.com/abc123.flac.mp3");

        /*
         * 请求档脚本没声明：阶梯是 [请求档, …声明支持的低档…]。
         * 第一档仍会照试（和前端 qualitiesToTry 一致：脚本可能只是没在 inited
         * 里写全），失败才退档。这里假源来者不拒，所以拿到的还是 master。
         * 真正验证「退档」的是下面那条不声明档位的脚本。
         */
        let url2 = host
            .resolve(std::slice::from_ref(&src), "tx", "master", &raw, &HashMap::new(), 5_000)
            .unwrap();
        assert_eq!(url2, "https://example.com/abc123.master.mp3");

        // 脚本没声明的平台 → 直接失败
        assert!(host
            .resolve(std::slice::from_ref(&src), "wy", "320k", &raw, &HashMap::new(), 3_000)
            .is_err());
    }

    /// 空正文的音源不许静默跳过：必须报出「是哪个音源、空在哪」。
    ///
    /// 2026-11-24 那次事故里，前端把 `sources.json#名字` 当文件路径递过来，
    /// 原生读盘 ENOENT、整条链一个音源都没起来，日志只有一句笼统的
    /// 「读不到脚本」。这类失败必须能被一眼指认。
    #[test]
    fn empty_script_reports_which_source() {
        let host = ScriptHost::new();
        let bad = ChainSource { name: "坏源".into(), code: "  ".into() };
        let err = host
            .resolve(&[bad], "tx", "320k", &serde_json::json!({}), &HashMap::new(), 2_000)
            .unwrap_err();
        assert!(err.contains("坏源"), "错误里要带音源名：{err}");
        assert!(err.contains("空"), "错误里要说清是正文空：{err}");
    }

    #[test]
    fn cookie_merge_keeps_caller_first() {
        assert_eq!(merge_cookie("a=1; b=2", "b=9; c=3"), "a=1; b=2; c=3");
    }

    /// 前端 `native_chain` 的 payload 契约（字段名 / 默认值 / 原始对象原样保留）。
    ///
    /// 这条测试盯的是「前后端对不上」这一类事故：改名字、改大小写、忘记默认值，
    /// 在 iOS 上表现为「后台接歌偶尔能接、偶尔不能」，日志里什么都看不出来。
    #[test]
    fn chain_payload_contract() {
        let json = serde_json::json!({
            "scripts": [{ "name": "洛雪音源1", "code": "lx.on('request', () => '')" }],
            "cookies": { "tx": "a=1" },
            "items": [{
                "index": 7,
                "id": "tx_m1",
                "platform": "tx",
                "quality": "320k",
                "raw": "{\"songmid\":\"m1\",\"nested\":{\"k\":[1,2,3]}}",
                "duration": 201.5,
                "title": "歌名",
                "artist": "歌手",
                "album": "专辑",
                "cover": "https://x/y.jpg"
            }],
            "loop": true
        });
        let p: ChainPayload = serde_json::from_value(json).unwrap();
        assert!(p.looping, "loop 必须映射到 looping");
        assert_eq!(p.scripts.len(), 1);
        assert_eq!(p.scripts[0].name, "洛雪音源1");
        assert!(p.scripts[0].code.contains("lx.on"), "脚本体必须原样收到");
        assert_eq!(p.cookies.get("tx").map(String::as_str), Some("a=1"));
        let it = &p.items[0];
        assert_eq!(it.index, 7);
        assert_eq!(it.id, "tx_m1");
        assert_eq!(it.quality, "320k");
        assert_eq!(it.duration, 201.5);
        /* 原始对象必须能原样还给脚本（含嵌套数组），不能被吃掉字段 */
        let back: serde_json::Value =
            serde_json::from_str(it.raw.as_ref().expect("raw 必须保留")).unwrap();
        assert_eq!(back["songmid"], "m1");
        assert_eq!(back["nested"]["k"][2], 3);

        // 老 payload（没有 loop / id / path / scripts）照样能读：默认值兜住
        let old: ChainPayload = serde_json::from_str(
            r#"{"cookies":{},"items":[{"index":0,"platform":"wy","title":"x"}]}"#,
        )
        .unwrap();
        assert!(!old.looping);
        assert!(old.scripts.is_empty());
        assert_eq!(old.items[0].id, "");
        assert!(old.items[0].path.is_none());
        assert!(old.items[0].raw.is_none());
    }
}
