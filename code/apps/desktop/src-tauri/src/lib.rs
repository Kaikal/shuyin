//! Tauri 命令层：前端 invoke 的唯一入口。
//!
//! 本文件承担三件"壳"相关的事：
//! 1. 右下角托盘（常驻 + 最小化到托盘，符合国内音乐播放器的使用习惯）
//! 2. 桌面歌词独立窗口（透明 / 置顶 / 无边框 / 可拖动 / 可锁定穿透）
//! 3. 歌单文件读取（供前端解析网易云、QQ 音乐等导出的歌单）

pub mod db;
pub mod hotkeys;
#[cfg(target_os = "ios")]
pub mod ios_openurl;
pub mod liveactivity;
pub mod net;
#[cfg(desktop)]
pub mod platform_login;
pub mod player;
pub mod smtc;
#[cfg(windows)]
pub mod wallpaper;
#[cfg(not(windows))]
pub(crate) mod wallpaper {
    /// 非 Windows 占位：壁纸嵌入依赖 Win32 WorkerW（详见 wallpaper.rs），
    /// 其他平台没有对应实现，调用点也都在 `#[cfg(windows)]` 内。
    #[allow(dead_code)]
    pub struct Attach {
        pub ok: bool,
        pub detail: String,
    }
}

use crate::db::{Db, LocalTrack, LyricsRaw, ScanResult};
use crate::player::{Player, PlayerSnapshot};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
#[cfg(desktop)]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::{FilePath, FsExt};

/// 是否「真的要退出」（托盘菜单退出前置位，否则关窗口只是收进托盘）
pub struct QuitFlag(pub AtomicBool);

/// 桌面歌词窗口状态：锁定标记 + 位置写盘节流
pub struct LyricsState {
    pub locked: AtomicBool,
    last_save: Mutex<Instant>,
}

impl Default for LyricsState {
    fn default() -> Self {
        Self { locked: AtomicBool::new(false), last_save: Mutex::new(Instant::now() - Duration::from_secs(10)) }
    }
}

/// 启动心跳：前端真正画出界面后置位，白屏看门狗据此判断"到底画出来没有"
#[derive(Default)]
pub struct Boot {
    ok: AtomicBool,
}

/// 主窗口位置/大小写盘节流。
/// 多显示器 / 分屏用户关掉再开时窗口还在原地，不用每次重新摆。
pub struct WindowGeo {
    last_save: Mutex<Instant>,
    /// 前端「伪最大化」标记。
    /// 无边框窗口不走系统 zoom：zoom 态会盖住任务栏、还会被 Windows 往外扩 7px。
    /// 最大化由前端按工作区直接摆窗口，这个标记负责让存档 / 还原知道「当时是最大化态」。
    max_hint: Mutex<bool>,
    /**
     * 最小化之前是不是最大化态。
     *
     * 无边框窗口「最大化 → 最小化 → 从任务栏还原」时，Windows 偶尔会把 zoom 丢掉，
     * 窗口回到「正常态尺寸」——也就是比最大化小一圈，用户得再点一次最大化。
     * 记下这个标记，还原时发现 zoom 没了就补一次。
     */
    was_max: Mutex<bool>,
    /** 上一帧是不是最小化态：用来区分「从任务栏还原」和「用户主动还原最大化」 */
    was_min: Mutex<bool>,
}

impl Default for WindowGeo {
    fn default() -> Self {
        Self {
            last_save: Mutex::new(Instant::now() - Duration::from_secs(10)),
            max_hint: Mutex::new(false),
            was_max: Mutex::new(false),
            was_min: Mutex::new(false),
        }
    }
}

/* ------------------------------------------------------------------ */
/* WebView2 启动参数                                                   */
/* ------------------------------------------------------------------ */

/// 标记文件：存在表示上一次 GPU 初始化失败过，改用软件渲染。
/// 路径与 app_local_data_dir 保持一致，但这里不依赖 AppHandle（要在建窗口之前用）。
fn gpu_off_marker() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .map(|p| PathBuf::from(p).join("cn.shuyin.player").join("gpu-off"))
}

fn gpu_off() -> bool {
    gpu_off_marker().map(|p| p.exists()).unwrap_or(false)
}

/// WebView2 附加启动参数。
///
/// 虚拟显示器（远程控制类软件）、部分安全软件会让 Chromium 的 GPU 进程沙箱
/// 初始化失败，随后浏览器进程以 `FATAL: GPU process isn't usable. Goodbye.`
/// 直接退出——表现就是窗口一片白、点哪里都没反应。关掉 GPU 进程沙箱即可恢复；
/// 万一某些机器仍然白屏，看门狗会写标记，下一轮再加上 --disable-gpu 走软件渲染。
pub(crate) fn browser_args() -> &'static str {
    static ARGS: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    ARGS.get_or_init(|| {
        let mut args = String::from("--disable-gpu-sandbox");
        /*
         * 触摸屏笔记本上的双指捏合会把整页放大 —— 和手机上是同一件事。
         * 界面是固定布局的，放大之后图表、进度条、歌词位置全错，退都退不回来。
         * 只关手势（--disable-pinch），Ctrl+滚轮留着：那是键鼠用户的明确动作，
         * 不算误触。
         */
        args.push_str(" --disable-pinch");
        // 桌面歌词 / 音乐桌面常年待在别的窗口后面（音乐桌面还嵌在壁纸层里），
        // Chromium 默认把「被遮挡窗口」的 rAF 和定时器降频——表现就是频谱不动、
        // 逐字染色一顿一顿。这类窗口本来就该常驻刷新，关掉两种后台节流。
        args.push_str(" --disable-backgrounding-occluded-windows --disable-renderer-backgrounding");
        if gpu_off() {
            args.push_str(" --disable-gpu");
        }
        // 排查用的后门：SHUYIN_BROWSER_ARGS="--remote-debugging-port=9222" 再启动，
        // 就能用 DevTools 协议连上真实窗口看 DOM / 截图
        if let Ok(extra) = std::env::var("SHUYIN_BROWSER_ARGS") {
            let extra = extra.trim();
            if !extra.is_empty() {
                args.push(' ');
                args.push_str(extra);
            }
        }
        args
    })
}

/* ------------------------------------------------------------------ */
/* 诊断日志                                                            */
/* ------------------------------------------------------------------ */

fn log_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_local_data_dir()
        .map(|d| d.join("app.log"))
        .unwrap_or_else(|_| PathBuf::from("app.log"))
}

pub(crate) fn append_log(app: &AppHandle, line: &str) {
    use std::io::Write;
    let path = log_path(app);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // 超过 512KB 直接换新文件，避免无限增长
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > 512 * 1024 {
            let _ = std::fs::remove_file(&path);
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(f, "[{ts}] {line}");
    }
}

/// 前端诊断日志（白屏 / 闪退排查用）
#[tauri::command]
fn diag_log(app: AppHandle, event: String, detail: Option<String>) {
    append_log(&app, &format!("{event} {}", detail.unwrap_or_default()));
}

/// 前端完成首次绘制后调用：告诉后端"界面真出来了"，别触发白屏重试
#[tauri::command]
fn boot_ok(boot: State<'_, Boot>) {
    boot.ok.store(true, Ordering::SeqCst);
}

/**
 * 设置窗口最小尺寸（用**物理像素**）。
 *
 * 为什么不用 `min_inner_size` 就够了：
 *   · Tauri 的 `min_inner_size` 吃的是**逻辑**像素，这台机器的系统缩放是 1.5，
 *     而 webview 的 `devicePixelRatio` 是 1.71（两者不等，见 v0.3.3 的 zoom 处理）。
 *     逻辑 1120 换算过去只有 1680 物理像素，用户看到的宽度其实只有 983 CSS px ——
 *     比我们按布局算出来的下限小一截，窗口还是能拖到「布局被挤扁」的状态。
 *   · 前端知道自己的 dpr，CSS px = 物理 px / dpr，所以下限由前端上报 dpr、
 *     后端按物理像素设，才真正卡在「用户看得见的 1120×680」。
 *
 * 顺带把当前尺寸抬到下限之上：上一次存档可能是小窗口，恢复后会直接被 Windows
 * 夹住（min tracking 只拦用户拖拽，不拦程序 set_size）。程序化的缩小和跨显示器
 * DPI 变化另外由 install_max_fix 子类的 WM_WINDOWPOSCHANGING 兜底钳制。
 */
/*
 * 主窗口最小尺寸（物理像素）：apply_min_size 写入，install_max_fix 的子类在
 * WM_WINDOWPOSCHANGING 里读它兜底（那条路不走 ptMinTrackSize）。
 */
static MIN_W: AtomicU32 = AtomicU32::new(0);
static MIN_H: AtomicU32 = AtomicU32::new(0);

#[cfg(desktop)]
#[tauri::command]
fn apply_min_size(app: AppHandle, dpr: f64) {
    let Some(win) = app.get_webview_window("main") else { return };
    let dpr = if dpr.is_finite() && dpr > 0.5 && dpr < 4.0 { dpr } else { 1.0 };
    let min_w = (1120.0 * dpr).ceil() as u32;
    let min_h = (680.0 * dpr).ceil() as u32;
    let _ = win.set_min_size(Some(tauri::PhysicalSize::new(min_w, min_h)));
    // 子类的 WM_WINDOWPOSCHANGING 兜底读这两个值
    MIN_W.store(min_w, Ordering::Relaxed);
    MIN_H.store(min_h, Ordering::Relaxed);
    let mut note = String::from("cur-ok");
    if let Ok(cur) = win.inner_size() {
        if cur.width < min_w || cur.height < min_h {
            let want = tauri::PhysicalSize::new(cur.width.max(min_w), cur.height.max(min_h));
            let _ = win.set_size(want);
            let after = win.inner_size().unwrap_or(want);
            note = format!(
                "raise {}x{} -> {}x{}",
                cur.width, cur.height, after.width, after.height
            );
        }
    }
    append_log(&app, &format!("window.min {min_w}x{min_h} dpr={dpr} {note}"));
}

/* ------------------------------------------------------------------ */
/* 曲库                                                                */
/* ------------------------------------------------------------------ */

#[tauri::command]
fn scan_music(
    app: AppHandle,
    db: State<'_, Db>,
    scope: String,
    directories: Vec<String>,
    incremental: bool,
) -> Result<ScanResult, String> {
    let app2 = app.clone();
    crate::db::scan(&app, &db, &scope, &directories, incremental, &|found, parsed, dir| {
        let _ = app2.emit(
            "scan://progress",
            serde_json::json!({ "found": found, "parsed": parsed, "currentDir": dir }),
        );
    })
}

#[tauri::command]
fn get_tracks(db: State<'_, Db>) -> Result<Vec<LocalTrack>, String> {
    crate::db::get_all_tracks(&db)
}

#[tauri::command]
fn get_track_count(db: State<'_, Db>) -> Result<i64, String> {
    db.count()
}

#[tauri::command]
fn get_lyrics(db: State<'_, Db>, track_id: String) -> Result<LyricsRaw, String> {
    crate::db::lyrics_for(&db, &track_id)
}

#[tauri::command]
fn remove_track(db: State<'_, Db>, track_id: String) -> Result<(), String> {
    crate::db::remove_track(&db, &track_id)
}

#[tauri::command]
async fn pick_music_folder(app: AppHandle) -> Result<Option<String>, String> {
    #[cfg(desktop)]
    {
        let dir = app.dialog().file().blocking_pick_folder();
        Ok(dir.map(|d| d.to_string()))
    }
    #[cfg(mobile)]
    {
        let _ = app;
        Err("移动端暂不支持自选扫描目录".to_string())
    }
}

/// 选取歌单文件（其他音乐 APP 导出的 json / txt / csv / m3u / lxmc）
///
/// 返回 `{ path, name }`：`path` 原样回传（iOS 是 `file://`、安卓是 `content://`），
/// 读的时候交给 `read_*_abs` 按方案走；`name` 由这里算好，前端不用再猜——
/// 从 URL 里切 basename 会拿到 `%E6%B4%9B…` 这种百分号编码的鬼东西。
#[tauri::command]
async fn pick_playlist_file(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    let picked = file_filter(
        app.dialog().file(),
        &["json", "txt", "csv", "m3u", "m3u8", "pls", "lxmc"],
    )
    .blocking_pick_file();
    let Some(f) = picked else { return Ok(None) };
    let name = picked_name(&f).unwrap_or_else(|| "歌单".to_string());
    Ok(Some(serde_json::json!({ "path": f.to_string(), "name": name })))
}

/// 读二进制文件（lxmc 这类 gzip 容器走这里；大小上限与文本版一致）
#[tauri::command]
fn read_bin_abs(app: AppHandle, path: String) -> Result<Vec<u8>, String> {
    let bytes = read_any(&app, &path)?;
    if bytes.len() > 16 * 1024 * 1024 {
        return Err("文件超过 16MB，疑似不是歌单文件".to_string());
    }
    Ok(bytes)
}

/// 读取任意路径的文本：UTF-8 优先，失败回落 GB18030（大量国产 APP 导出的 txt 是 GBK）
#[tauri::command]
fn read_text_abs(app: AppHandle, path: String) -> Result<String, String> {
    let bytes = read_any(&app, &path)?;
    if bytes.len() > 16 * 1024 * 1024 {
        return Err("文件超过 16MB，疑似不是歌单文件".to_string());
    }
    if let Ok(s) = std::str::from_utf8(&bytes) {
        return Ok(s.trim_start_matches('\u{feff}').to_string());
    }
    let (cow, _, _) = encoding_rs::GB18030.decode(&bytes);
    Ok(cow.trim_start_matches('\u{feff}').to_string())
}

/* ------------------------------------------------------------------ */
/* 全局快捷键 / 媒体键（耳机线控）                                      */
/* ------------------------------------------------------------------ */

/// 重新注册一整套快捷键。逐项返回结果——单个键被占用不影响其它键。
#[tauri::command]
fn hotkeys_apply(app: AppHandle, items: Vec<hotkeys::HotkeyItem>) -> Vec<hotkeys::HotkeyResult> {
    hotkeys::apply(&app, items)
}

/// 全部注销（用户关掉快捷键功能，或者要彻底让出媒体键给别的播放器）
#[tauri::command]
fn hotkeys_clear() -> Vec<hotkeys::HotkeyResult> {
    hotkeys::clear()
}

/* ------------------------------------------------------------------ */
/* 配置包（备份 / 换机器）                                              */
/* ------------------------------------------------------------------ */

/// 选一个保存位置并返回路径（配置包导出用）
#[tauri::command]
async fn pick_save_file(app: AppHandle, default_name: Option<String>) -> Result<Option<String>, String> {
    let dlg = app
        .dialog()
        .file()
        .add_filter("疏音配置包", &["json"])
        .add_filter("全部文件", &["*"]);
    let dlg = match default_name.filter(|n| !n.trim().is_empty()) {
        Some(n) => dlg.set_file_name(n),
        None => dlg,
    };
    Ok(dlg.blocking_save_file().map(|p| p.to_string()))
}

/// 写任意路径的文本（配置包、导出的歌词都走它）
#[tauri::command]
fn write_text_abs(path: String, text: String) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&path, text.as_bytes()).map_err(|e| format!("写入文件失败：{e}"))
}

/* ------------------------------------------------------------------ */
/* 播放                                                                */
/* ------------------------------------------------------------------ */

#[tauri::command]
fn player_state(player: State<'_, Player>) -> Result<PlayerSnapshot, String> {
    Ok(player.snapshot())
}

#[tauri::command]
fn play_file(
    player: State<'_, Player>,
    db: State<'_, Db>,
    path: String,
    index: i64,
    start_at: Option<f64>,
    autoplay: Option<bool>,
) -> Result<(), String> {
    let hint = db.duration_of(&path).unwrap_or(0.0);
    player.play_from(
        &path,
        index.max(0) as usize,
        hint,
        start_at.unwrap_or(0.0),
        autoplay.unwrap_or(true),
    )
}

/// 在线曲目：直链流式播放。`durationHint` 由前端从平台结果带过来（秒）。
#[tauri::command]
fn play_url(
    player: State<'_, Player>,
    url: String,
    index: i64,
    duration_hint: Option<f64>,
    start_at: Option<f64>,
    autoplay: Option<bool>,
) -> Result<(), String> {
    player.play_url(
        &url,
        index.max(0) as usize,
        duration_hint.unwrap_or(0.0),
        start_at.unwrap_or(0.0),
        autoplay.unwrap_or(true),
    )
}

/// 预告表：前端把「接下来几首」已经取到的直链递过来。
///
/// 为什么需要它（iOS 独有）：后台播放时 WebView 的 JS 会被系统冻住，
/// 曲终推 `ended` 过去没人接，用户听到的就是「放完这首就停」。
/// 原生手里有下一首的地址就能自己接（见 player.rs 的曲终检测）。
///
/// 和安卓的 `next_prefetch` 是同一件事、同一份 payload（前端只写一次）。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrefetchIn {
    index: i64,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    duration: f64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    artist: String,
    #[serde(default)]
    album: String,
    #[serde(default)]
    cover: String,
}

#[tauri::command]
fn next_prefetch(player: State<'_, Player>, items: Vec<PrefetchIn>) {
    let list = items
        .into_iter()
        .filter(|i| i.index >= 0)
        .map(|i| player::PrefetchItem {
            index: i.index as usize,
            path: i.path.filter(|p| !p.is_empty()),
            url: i.url.filter(|u| !u.is_empty()),
            duration: i.duration.max(0.0),
            title: i.title,
            artist: i.artist,
            album: i.album,
            cover: i.cover,
        })
        .collect();
    player.set_prefetch(list);
}

/* ------------------------------------------------------------------ */
/* 出网（绕 CORS 的平台 API 代理）                                      */
/* ------------------------------------------------------------------ */

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct NetRequest {
    url: String,
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    headers: Option<std::collections::HashMap<String, String>>,
    #[serde(default)]
    body: Option<String>,
    /// 二进制请求体（base64）。云同步的文件上传是 multipart，只能走这个字段
    #[serde(default, rename = "bodyB64")]
    body_b64: Option<String>,
    /// 要求回包带上原始字节（base64）。默认不编码，见 `net::collect`
    #[serde(default, rename = "wantBytes")]
    want_bytes: bool,
    #[serde(default)]
    timeout: Option<u64>,
}

/// 代理一次 HTTP 请求。
///
/// 音乐平台接口全部不带 CORS 头，WebView 里 fetch 拿不到 body，只能走原生。
/// **异步**：同步命令会跑在主线程上，一次 8s 的超时能把界面卡死。
#[tauri::command]
async fn net_request(req: NetRequest) -> Result<net::NetResponse, String> {
    let method = req.method.unwrap_or_else(|| "GET".to_string());
    let headers = req.headers.unwrap_or_default();
    let timeout = req.timeout.unwrap_or(10_000);
    let body = req.body;
    let body_b64 = req.body_b64;
    let want_bytes = req.want_bytes;
    tauri::async_runtime::spawn_blocking(move || {
        net::request(
            &method,
            &req.url,
            &headers,
            body.as_deref(),
            body_b64.as_deref(),
            want_bytes,
            timeout,
        )
    })
    .await
    .map_err(|e| format!("网络线程异常：{e}"))?
}

/* ------------------------------------------------------------------ */
/* 更新检查                                                            */
/* ------------------------------------------------------------------ */

/// 更新信息放哪儿：一个**公开**仓库里的 json（只有版本号/更新说明/下载页）。
/// 源码仓库是私有的，匿名拉不到，所以单独开了一个 `shuyin-update`。
/// 想换成自己的服务器，改这里，或者前端调用时传 `url`。
const UPDATE_FEED: &str = "https://gitee.com/ghpgitee/shuyin-update/raw/master/version.json";

#[derive(serde::Serialize)]
pub struct UpdateInfo {
    /// 当前运行的版本：编译期从 Cargo.toml 烘进去，和 package.json 同步改
    current: String,
    latest: String,
    has_update: bool,
    notes: Vec<String>,
    url: String,
    date: String,
    /// true = 这个版本必须更新（不显示「以后再说」）
    force: bool,
}

/// 版本比较：只认数字段（0.5.10 > 0.5.9），段数不同按 0 补齐。
fn version_gt(a: &str, b: &str) -> bool {
    let num = |s: &str| -> Vec<u32> {
        s.split(|c: char| !c.is_ascii_digit())
            .filter(|part| !part.is_empty())
            .map(|part| part.parse().unwrap_or(0))
            .collect()
    };
    let (pa, pb) = (num(a), num(b));
    for i in 0..pa.len().max(pb.len()) {
        let x = *pa.get(i).unwrap_or(&0);
        let y = *pb.get(i).unwrap_or(&0);
        if x != y {
            return x > y;
        }
    }
    false
}

#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
async fn check_update(url: Option<String>) -> Result<UpdateInfo, String> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let target = url
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| UPDATE_FEED.to_string());
    let body = tauri::async_runtime::spawn_blocking(move || {
        let headers = std::collections::HashMap::new();
        net::request("GET", &target, &headers, None, None, false, 8_000).map(|r| r.body)
    })
    .await
    .map_err(|e| format!("网络线程异常：{e}"))??;

    let v: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("更新信息不是合法 JSON：{e}"))?;
    let latest = v.get("version").and_then(|x| x.as_str()).unwrap_or("").to_string();
    if latest.is_empty() {
        return Err("更新信息里没有 version 字段".into());
    }
    let notes: Vec<String> = v
        .get("notes")
        .and_then(|x| x.as_array())
        .map(|a| a.iter().filter_map(|s| s.as_str()).map(|s| s.to_string()).collect())
        .unwrap_or_default();
    Ok(UpdateInfo {
        has_update: version_gt(&latest, &current),
        current,
        latest,
        notes,
        url: v.get("url").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        date: v.get("date").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        force: v.get("force").and_then(|x| x.as_bool()).unwrap_or(false),
    })
}

/// 用系统默认浏览器打开下载页。只认 http/https——别把任意字符串丢给系统命令。
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let u = url.trim();
    if !(u.starts_with("https://") || u.starts_with("http://")) {
        return Err("只支持 http/https 链接".into());
    }
    #[cfg(windows)]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", u])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(u)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// macOS 应用内更新：下载 dmg 到临时目录并直接挂载打开。
///
/// Windows 的更新走 NSIS 安装器（安卓走原生 update_download），macOS 的 dmg
/// 没有「静默安装」的官方通道——但 `open xxx.dmg` 会自动挂载并弹出 Finder
/// 窗口，用户把「疏音.app」拖进「应用程序」就完成更新，比跳浏览器再翻
/// 下载目录顺得多。下载用 ureq（跟取链同一套 TLS），写到系统临时目录。
#[derive(serde::Serialize)]
struct MacInstall {
    status: &'static str,
    path: String,
}

#[tauri::command]
async fn update_dmg_install(
    app: AppHandle,
    urls: Vec<String>,
    name: String,
) -> Result<MacInstall, String> {
    let _ = &app;
    #[cfg(not(target_os = "macos"))]
    {
        Err("应用内安装 dmg 只在 macOS 上可用".to_string())
    }
    #[cfg(target_os = "macos")]
    {
        let target_dir = std::env::temp_dir();
        let safe_name: String = name
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
            .collect();
        let path = target_dir.join(if safe_name.ends_with(".dmg") { safe_name } else { format!("{safe_name}.dmg") });
        tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
            let mut last_err = String::new();
            for u in urls.iter().filter(|u| u.starts_with("http")) {
                match ureq::get(u.as_str())
                    .timeout(std::time::Duration::from_secs(180))
                    .call()
                {
                    Ok(resp) => {
                        let mut f = std::fs::File::create(&path).map_err(|e| e.to_string())?;
                        use std::io::Read;
                        let mut reader = resp.into_reader();
                        std::io::copy(&mut reader, &mut f).map_err(|e| e.to_string())?;
                        drop(f);
                        let st = std::process::Command::new("open")
                            .arg(&path)
                            .spawn();
                        return match st {
                            Ok(_) => Ok(path.display().to_string()),
                            Err(e) => Err(format!("镜像挂载失败：{e}")),
                        };
                    }
                    Err(e) => {
                        last_err = format!("{e}");
                        continue;
                    }
                }
            }
            Err(if last_err.is_empty() { "更新地址是空的".into() } else { format!("下载失败：{last_err}") })
        })
        .await
        .map_err(|e| format!("下载线程异常：{e}"))?
        .map(|path| MacInstall { status: "installed", path })
    }
}

/// 把当前曲目与播放状态交给系统媒体会话。
///
/// 有了它，耳机按键才会路由到本应用，「音量键浮层 / 锁屏」上也会显示歌名——
/// 这两件事是同一个机制（SMTC），不做就只能靠 RegisterHotKey 碰运气。
#[tauri::command]
fn smtc_update(
    app: AppHandle,
    title: String,
    artist: String,
    album: String,
    playing: bool,
    cover: Option<String>,
    position: Option<f64>,
    duration: Option<f64>,
) {
    /*
     * 前四个参数四个平台一样；后三个只有 Apple 用得上（Windows 的 SMTC
     * 也能吃封面和进度，但那条 Update() 路径得单独打开，先不混进来）。
     * 用 Option 是为了让老前端（没传这三个字段）照样能调。
     */
    smtc::update(
        &app,
        title,
        artist,
        album,
        playing,
        cover.unwrap_or_default(),
        position.unwrap_or(0.0),
        duration.unwrap_or(0.0),
    );
}

/// 探测一条在线直链是否真的能播。带上「读到的字节 / 文件总长 / Content-Type / 真实时长」，
/// 前端据此判断「这个文件到底是不是这首歌」（见 net::ProbeAudio 的说明）。
#[tauri::command]
async fn probe_audio_url(url: String) -> Result<net::ProbeAudio, String> {
    tauri::async_runtime::spawn_blocking(move || net::probe_audio(&url))
        .await
        .map_err(|e| format!("探测线程异常：{e}"))?
}

/// 读本地音频文件的真实时长（秒）。缓存校验用：缓存里那份音频当初是错的，
/// 只要文件还在，光看索引是看不出来的，必须真读一次标签/流信息。
#[tauri::command]
async fn local_audio_duration(path: String) -> Result<f64, String> {
    tauri::async_runtime::spawn_blocking(move || net::local_duration(&path))
        .await
        .map_err(|e| format!("读取线程异常：{e}"))?
}

/// 读本地音频文件自己写的标题/歌手（`[title, artist]`，读不到是空串）。
///
/// 和 `local_audio_duration` 是一对：时长差 2 秒挡不住的那类错歌
/// （《孤勇者》256s vs 邓紫棋《唯一》253.7s），靠名字才认得出来。
#[tauri::command]
async fn local_audio_tags(path: String) -> Result<(String, String), String> {
    tauri::async_runtime::spawn_blocking(move || net::local_tags(&path))
        .await
        .map_err(|e| format!("读取线程异常：{e}"))?
}

/* ------------------------------------------------------------------ */
/* 音源脚本目录                                                         */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 音源脚本：清单式存储（sources.json）                                  */
/* ------------------------------------------------------------------ */

/// 清单里的一条音源。**code 直接内嵌**——不再是一曲一个 .js 文件：
/// 用户往文件夹里丢 / 改 .js 一律不认（清单里没有就不是音源），
/// 想加 / 改 / 删音源只能走设置页的导入与删除，从根上杜绝「手改数据」。
#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct SourceEntry {
    name: String,
    code: String,
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct SourceManifest {
    version: u32,
    #[serde(default)]
    sources: Vec<SourceEntry>,
}

/// 给前端的音源条目。`path` 是合成地址（`…/sources.json#名字`）：
/// sourceManager 拿它算稳定 id，删除时按它找到清单里对应的一条。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceScript {
    path: String,
    name: String,
    code: String,
}

fn manifest_path(dir: &std::path::Path) -> PathBuf {
    dir.join("sources.json")
}

/// 读清单。文件不存在 = 还没导入过（空清单）；损坏 = 明确报错，
/// 不静默回退成扫目录——那正是「手改数据」想看到的结果。
fn load_manifest(dir: &std::path::Path) -> Result<SourceManifest, String> {
    let p = manifest_path(dir);
    let raw = match std::fs::read_to_string(&p) {
        Ok(v) => v,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SourceManifest { version: 1, sources: Vec::new() })
        }
        Err(e) => return Err(format!("读取音源清单失败：{e}")),
    };
    serde_json::from_str(&raw).map_err(|e| format!("音源清单已损坏（{}）：{e}", p.display()))
}

/// 原子写：先写临时文件再改名，避免写到一半断电留下半个清单
fn save_manifest(dir: &std::path::Path, m: &SourceManifest) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("创建音源目录失败：{e}"))?;
    let text = serde_json::to_string_pretty(m).map_err(|e| format!("序列化音源清单失败：{e}"))?;
    let tmp = dir.join("sources.json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("写入音源清单失败：{e}"))?;
    std::fs::rename(&tmp, manifest_path(dir)).map_err(|e| format!("保存音源清单失败：{e}"))
}

/// 旧版迁移：v0.4.5 之前音源是「一个脚本一个 .js 文件」，用户也可能自己往里丢过。
/// 第一次读清单时若目录里还有 .js，就把它们收进清单、然后删掉 .js——
/// 从此那些文件只是历史，改它们没有任何效果。
///
/// **无论收没收到东西都把清单写一遍**：让「清单文件存在」成为耐久的「已迁移」标记。
/// 否则空目录首次读完之后清单仍不存在，用户之后再往目录里丢 .js 会被当成旧版文件
/// 二次收编——那就破坏了「只认导入」的约定。清单落盘成功才删 .js，绝不弄丢用户的音源。
fn migrate_legacy_scripts(dir: &std::path::Path) -> Result<Vec<SourceEntry>, String> {
    if !dir.is_dir() {
        return Ok(Vec::new()); // 目录都没有（比如旧版指了个不存在的路径）：什么都不建
    }
    let mut out: Vec<SourceEntry> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for entry in rd.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let name = match path.file_name().and_then(|s| s.to_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            if !name.to_ascii_lowercase().ends_with(".js") {
                continue;
            }
            let bytes = match std::fs::read(&path) {
                Ok(v) => v,
                Err(_) => continue,
            };
            // 音源脚本都是几十 KB，超过 8MB 基本不是脚本
            if bytes.len() > 8 * 1024 * 1024 {
                continue;
            }
            let code = match String::from_utf8(bytes) {
                Ok(s) => s,
                Err(e) => String::from_utf8_lossy(e.as_bytes()).to_string(),
            };
            out.push(SourceEntry {
                name: name.trim_end_matches(".js").trim_end_matches(".JS").to_string(),
                code,
            });
        }
    }
    let mut m = load_manifest(dir)?;
    for e in &out {
        // 清单里已有同名的以清单为准（用户导入过更新的版本）
        if !m.sources.iter().any(|x| x.name == e.name) {
            m.sources.push(e.clone());
        }
    }
    save_manifest(dir, &m)?;
    if out.is_empty() {
        return Ok(out);
    }
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        if let Some(n) = p.file_name().and_then(|s| s.to_str()) {
            if n.to_ascii_lowercase().ends_with(".js") {
                let _ = std::fs::remove_file(&p);
            }
        }
    }
    Ok(out)
}

/// 列音源：**只认清单**（`sources.json`）。
/// 目录里多出来的 .js、被改过的 .js，一律看不见——这是「只能软件导入」的落地方式。
#[tauri::command]
fn list_source_scripts(dir: String) -> Result<Vec<SourceScript>, String> {
    let p = PathBuf::from(&dir);
    let mut m = load_manifest(&p)?;
    if m.sources.is_empty() && !manifest_path(&p).exists() {
        // 没有清单（首次启动 / 旧版升级）：做一次性迁移，把旧 .js 收进来
        m.sources = migrate_legacy_scripts(&p)?;
    }
    let manifest = manifest_path(&p).to_string_lossy().to_string();
    let mut out: Vec<SourceScript> = m
        .sources
        .iter()
        .map(|e| SourceScript {
            path: format!("{manifest}#{}", e.name),
            name: format!("{}.js", e.name),
            code: e.code.clone(),
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/* ------------------------------------------------------------------ */
/* 统一数据根目录（音源 + 播放缓存都在这下面）                           */
/* ------------------------------------------------------------------ */

/// 统一数据根：`%APPDATA%\cn.shuyin.player`。
/// 音源清单和播放缓存默认都放在这里——「应用自己的数据只有一个家」，
/// 用户要知道东西在哪只需要记住这一个目录（缓存还能再自选，见 cache-dir.json）。
fn data_root(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
}

/// 音源目录：`<数据根>\sources`
fn sources_dir(app: &AppHandle) -> PathBuf {
    data_root(app).join("sources")
}

/// 默认音源目录：`%APPDATA%\cn.shuyin.player\sources`（缺了就建）。
/// 仓库里自带的脚本**不自动加载**，必须用户在设置页显式导入。
#[tauri::command]
fn sources_default_dir(app: AppHandle) -> Result<String, String> {
    let dir = sources_dir(&app);
    let _ = std::fs::create_dir_all(&dir);
    Ok(dir.to_string_lossy().to_string())
}

/// 默认下载目录 = **系统「下载」文件夹**（`%USERPROFILE%\Downloads`）。
///
/// 以前退回 `%APPDATA%\cn.shuyin.player\downloads`：那是个隐藏目录，
/// 下完歌在资源管理器里根本找不到，用户以为「没下下来」。AppData 是给应用自己
/// 存配置/缓存的，不该放用户主动要的文件。
fn default_download_dir(app: &AppHandle) -> PathBuf {
    /*
     * iOS：沙箱里根本没有「下载文件夹」这个概念。
     *
     * `app.path().download_dir()` 在 iOS 上直接 Err，退回 `home_dir()` 拿到的
     * 又常常是 `/var/mobile`（不可写）——于是 `downloads_dir` 报错，界面上
     * 「保存到」显示「（还没取到）」，每个任务都是「找不到下载目录，去设置里选一个」，
     * 而 iOS 的设置页里根本没有可选的目录（用户 2026-11-23 的截图）。
     *
     * iOS 该落的是 App 自己的 Documents：Info.plist 里配了
     * `UIFileSharingEnabled` + `LSSupportsOpeningDocumentsInPlace` 之后，
     * 「文件」App → 我的 iPhone → 疏音 里能直接看到、能拷出来、能隔空投送。
     * 子目录用中文名，和安卓那边「音乐/疏音」的叫法对齐。
     */
    #[cfg(target_os = "ios")]
    {
        return match app.path().document_dir() {
            Ok(d) => d.join("疏音"),
            Err(_) => data_root(app).join("downloads"),
        };
    }
    #[cfg(not(target_os = "ios"))]
    {
        if let Ok(d) = app.path().download_dir() {
            return d;
        }
        // 极端情况下（组策略改过 Shell 文件夹）退回 用户目录\Downloads
        if let Ok(home) = app.path().home_dir() {
            return home.join("Downloads");
        }
        app.path()
            .app_data_dir()
            .map(|d| d.join("downloads"))
            .unwrap_or_else(|_| PathBuf::from("."))
    }
}

/// 下载目录。传了 `dir` 就用它（顺手建好，用户选个空文件夹也能直接落盘），
/// 没传就用系统「下载」文件夹。
#[tauri::command]
fn downloads_dir(app: AppHandle, dir: Option<String>) -> Result<String, String> {
    /*
     * iOS 上「自选目录」不存在（没有 SAF / 没有持久授权的文件对话框），
     * 传什么都忽略——否则 localStorage 里一条历史值就能把下载指到沙箱外的
     * 死路径上，表现是「每个任务都失败，设置里还显示着一个假路径」。
     */
    #[cfg(target_os = "ios")]
    let dir: Option<String> = {
        let _ = dir;
        None
    };
    let base = match dir.map(|d| d.trim().to_string()).filter(|d| !d.is_empty()) {
        Some(d) => PathBuf::from(d),
        None => default_download_dir(&app),
    };
    std::fs::create_dir_all(&base).map_err(|e| format!("建不了下载目录「{}」：{e}", base.display()))?;
    Ok(base.to_string_lossy().to_string())
}

/* ------------------------------------------------------------------ */
/* 播放缓存（音频）                                                     */
/* ------------------------------------------------------------------ */

/// 缓存默认目录：`<数据根>\cache\audio`——和音源清单同一个家。
///
/// 为什么单独做一层磁盘缓存：在线曲目的直链是一次性的（签名 + 十几分钟过期），
/// 每次打开都要重新取链、重新从网络拉一遍。听过的歌留一份在本地，
/// 下一次直接按本地文件播——秒开，也不吃流量。
fn default_cache_dir(app: &AppHandle) -> PathBuf {
    data_root(app).join("cache").join("audio")
}

/// 用户自选的缓存目录写在 `<数据根>\cache-dir.json`（Rust 侧持有：
/// 缓存查找/落盘都在 Rust 里发生，不能每次让前端传一遍）。
/// 空 / 没有这个文件 = 用默认目录。
fn cache_override_path(app: &AppHandle) -> PathBuf {
    data_root(app).join("cache-dir.json")
}

fn read_cache_override(app: &AppHandle) -> Option<PathBuf> {
    let raw = std::fs::read_to_string(cache_override_path(app)).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let d = v.get("dir")?.as_str()?.trim();
    if d.is_empty() {
        None
    } else {
        Some(PathBuf::from(d))
    }
}

fn write_cache_override(app: &AppHandle, dir: Option<&str>) -> Result<(), String> {
    let p = cache_override_path(app);
    match dir {
        Some(d) if !d.trim().is_empty() => {
            let text = serde_json::json!({ "dir": d.trim() }).to_string();
            std::fs::write(&p, text).map_err(|e| format!("记住缓存目录失败：{e}"))
        }
        _ => {
            let _ = std::fs::remove_file(&p);
            Ok(())
        }
    }
}

/// 旧版默认缓存位置：`%LOCALAPPDATA%\cn.shuyin.player\cache\audio`。
/// v0.4.5 起缓存搬进统一数据根，第一次用到缓存时把旧文件一次性搬过去
/// （用户没自选目录的前提下——他自选了就以他选的为准，旧文件不动）。
fn migrate_legacy_cache(app: &AppHandle) {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        if read_cache_override(app).is_some() {
            return;
        }
        let old = match app.path().app_cache_dir() {
            Ok(d) => d.join("cache").join("audio"),
            Err(_) => return,
        };
        let new = default_cache_dir(app);
        if old == new || !old.is_dir() {
            return;
        }
        let _ = std::fs::create_dir_all(&new);
        // 新目录已经有东西了（上次搬过一半 / 用户手动放过）：不重复搬
        let has_new = std::fs::read_dir(&new).map(|mut r| r.next().is_some()).unwrap_or(false);
        if has_new {
            return;
        }
        if let Ok(rd) = std::fs::read_dir(&old) {
            for e in rd.flatten() {
                let p = e.path();
                if !p.is_file() {
                    continue;
                }
                let dest = new.join(e.file_name());
                if dest.exists() {
                    continue;
                }
                if std::fs::rename(&p, &dest).is_err() {
                    // 跨盘 rename 会失败：拷贝一份再删旧的
                    if std::fs::copy(&p, &dest).is_ok() {
                        let _ = std::fs::remove_file(&p);
                    }
                }
            }
        }
    });
}

/// 生效的缓存目录（自选 > 默认），顺手建好
fn cache_audio_dir(app: &AppHandle) -> PathBuf {
    migrate_legacy_cache(app);
    let base = read_cache_override(app).unwrap_or_else(|| default_cache_dir(app));
    let _ = std::fs::create_dir_all(&base);
    base
}

/// 把目录里的缓存文件搬到另一个目录（rename，跨盘退化成拷贝）。
/// 返回 (搬了多少个, 失败多少个)。新旧是同一个目录就什么都不做。
fn move_cache_files(from: &std::path::Path, to: &std::path::Path) -> (usize, usize) {
    let mut moved = 0usize;
    let mut failed = 0usize;
    if from == to || !from.is_dir() {
        return (moved, failed);
    }
    let _ = std::fs::create_dir_all(to);
    if let Ok(rd) = std::fs::read_dir(from) {
        for e in rd.flatten() {
            let p = e.path();
            if !p.is_file() {
                continue;
            }
            let dest = to.join(e.file_name());
            if dest.exists() {
                moved += 1; // 新目录已有同名文件，视为已就位
                continue;
            }
            let ok = if std::fs::rename(&p, &dest).is_ok() {
                true
            } else if std::fs::copy(&p, &dest).is_ok() {
                let _ = std::fs::remove_file(&p); // 拷贝成功的才删源
                true
            } else {
                false
            };
            if ok {
                moved += 1;
            } else {
                failed += 1;
            }
        }
    }
    (moved, failed)
}

/// 当前缓存目录（设置页展示用）。`custom` = 用户自选过（据此显示「恢复默认」）
#[tauri::command]
fn cache_dir(app: AppHandle) -> CacheDirInfo {
    CacheDirInfo {
        dir: cache_audio_dir(&app).to_string_lossy().to_string(),
        custom: read_cache_override(&app).is_some(),
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheDirInfo {
    dir: String,
    custom: bool,
}

/// 换缓存目录。传空 = 恢复默认（数据根下的 cache\audio）。
/// 已有的缓存文件会一起搬过去——不然换个目录就把听过的歌全扔了，用户得重新下一遍。
/// 返回新目录 + 搬迁统计（前端照实告诉用户搬了几个、失败几个）。
#[tauri::command]
fn cache_set_dir(app: AppHandle, dir: Option<String>) -> Result<CacheDirSetInfo, String> {
    let old = cache_audio_dir(&app);
    let picked = dir.map(|d| d.trim().to_string()).filter(|d| !d.is_empty());
    let new = match &picked {
        Some(d) => {
            let p = PathBuf::from(d);
            if p.is_file() {
                return Err(format!("「{}」是个文件，不能当缓存目录", d));
            }
            std::fs::create_dir_all(&p).map_err(|e| format!("建不了缓存目录「{}」：{e}", d))?;
            p
        }
        None => default_cache_dir(&app),
    };
    write_cache_override(&app, picked.as_deref())?;
    let _ = std::fs::create_dir_all(&new);
    let (moved, failed) = move_cache_files(&old, &new);
    Ok(CacheDirSetInfo {
        dir: new.to_string_lossy().to_string(),
        custom: picked.is_some(),
        moved,
        failed,
    })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheDirSetInfo {
    dir: String,
    custom: bool,
    moved: usize,
    failed: usize,
}

/// 缓存文件名：曲目 id 里可能带 `:` `/`，全部换成 `_`
fn cache_name(key: &str, ext: &str) -> String {
    let safe: String = key
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let ext = if ext.starts_with('.') { ext.to_string() } else { format!(".{ext}") };
    format!("{}{}", safe, ext)
}

/// 查缓存：命中且文件非空才返回路径，否则返回 None（前端据此决定要不要重新取链）
#[tauri::command]
fn cache_lookup(app: AppHandle, key: String, ext: String) -> Option<String> {
    let p = cache_audio_dir(&app).join(cache_name(&key, &ext));
    match std::fs::metadata(&p) {
        Ok(m) if m.len() > 4096 => Some(p.to_string_lossy().to_string()),
        _ => None,
    }
}

/// 申请一个缓存落点（后台下载用；文件可能还不存在）
#[tauri::command]
fn cache_slot(app: AppHandle, key: String, ext: String) -> String {
    cache_audio_dir(&app).join(cache_name(&key, &ext)).to_string_lossy().to_string()
}

/// 删掉某一条缓存（校验发现缓存里存的其实是另一首歌时用）
#[tauri::command]
fn cache_drop(app: AppHandle, key: String, ext: String) -> bool {
    let p = cache_audio_dir(&app).join(cache_name(&key, &ext));
    std::fs::remove_file(p).is_ok()
}

fn dir_bytes(p: &std::path::Path) -> u64 {
    let mut total = 0;
    if let Ok(rd) = std::fs::read_dir(p) {
        for e in rd.flatten() {
            let path = e.path();
            if path.is_dir() {
                total += dir_bytes(&path);
            } else if let Ok(m) = e.metadata() {
                total += m.len();
            }
        }
    }
    total
}

/// 缓存占了多少字节（设置页显示用）
#[tauri::command]
fn cache_size(app: AppHandle) -> u64 {
    dir_bytes(&cache_audio_dir(&app))
}

/// 清空缓存，返回释放的字节数。只删我们自己建的 cache 目录，
/// 用户下载到「下载」文件夹里的歌不动——那是他的东西。
#[tauri::command]
fn cache_clear(app: AppHandle) -> u64 {
    let dir = cache_audio_dir(&app);
    let freed = dir_bytes(&dir);
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::create_dir_all(&dir);
    freed
}

/// 下载进度表：dest 路径 → (已写字节, 总字节)。
/// 用全局表而不是事件：前端轮询一次就能拿到，断线重连也不会丢状态。
fn dl_table() -> &'static std::sync::Mutex<std::collections::HashMap<String, (u64, u64)>> {
    static T: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, (u64, u64)>>> =
        std::sync::OnceLock::new();
    T.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// 下载在线曲目到 `dest`（分段并发，和在线播放同一套逻辑）。
/// 阻塞调用，放在 async 命令里避免卡住 IPC 线程。
#[tauri::command]
async fn download_track(url: String, dest: String) -> Result<u64, String> {
    let key = dest.clone();
    let path = PathBuf::from(&dest);
    dl_table()
        .lock()
        .map_err(|_| "进度表锁中毒".to_string())?
        .insert(key.clone(), (0, 0));

    let res = tauri::async_runtime::spawn_blocking(move || {
        let k = key.clone();
        let out = crate::net::download_to_file(&url, &path, {
            let kk = k.clone();
            move |done, total| {
                if let Ok(mut g) = dl_table().lock() {
                    g.insert(kk.clone(), (done, total));
                }
            }
        });
        if out.is_ok() {
            if let Ok(mut g) = dl_table().lock() {
                g.remove(&k);
            }
        }
        out
    })
    .await
    .map_err(|e| format!("下载线程异常：{e}"))?;

    if res.is_err() {
        // 失败也清掉进度，不然前端会一直转圈
        if let Ok(mut g) = dl_table().lock() {
            g.remove(&dest);
        }
    }
    res
}

/// 查询某个下载任务的进度；没有任务返回 None
#[tauri::command]
fn download_progress(dest: String) -> Option<(u64, u64)> {
    dl_table().lock().ok().and_then(|g| g.get(&dest).copied())
}

/// 把歌词文本写成 `.lrc`（覆盖写）。前端负责算好完整路径。
#[tauri::command]
fn save_lyrics_file(path: String, text: String) -> Result<(), String> {
    if let Some(parent) = PathBuf::from(&path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&path, text).map_err(|e| format!("写入歌词失败：{e}"))
}

/* ---- 音源导入（洛雪那种「把脚本给我」，而不是「指个文件夹」） ---- */

/// 文件名去掉路径分隔符与非法字符，防止脚本名里带 `../` 写到目录外。
/// `#` 也要换掉——合成地址用 `sources.json#名字` 切分，名字里带 # 会切错。
fn safe_script_name(name: &str) -> String {
    let base = name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(name)
        .trim()
        .trim_end_matches(".js")
        .trim_end_matches(".JS");
    let cleaned: String = base
        .chars()
        .map(|c| if "<>:\"/\\|?*#".contains(c) || c.is_control() { '_' } else { c })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').to_string();
    if cleaned.is_empty() { "source".to_string() } else { cleaned }
}

/// 把一个音源写进清单。同名就**替换** code——重新导入同一个名字就是更新版本，
/// 不会像以前那样悄悄变成 `名字-2.js` 堆一串重复项。
/// 返回合成地址（`…/sources.json#名字`）。
fn write_script(dir: &std::path::Path, name: &str, code: &str) -> Result<String, String> {
    if code.trim().is_empty() {
        return Err("脚本内容是空的".to_string());
    }
    if !code.contains("lx.") && !code.contains("EVENT_NAMES") {
        return Err("这不像洛雪音源脚本（找不到 lx / EVENT_NAMES）".to_string());
    }
    let safe = safe_script_name(name);
    let mut m = load_manifest(dir)?;
    match m.sources.iter_mut().find(|x| x.name == safe) {
        Some(e) => e.code = code.to_string(),
        None => m.sources.push(SourceEntry { name: safe.clone(), code: code.to_string() }),
    }
    save_manifest(dir, &m)?;
    Ok(format!("{}#{}", manifest_path(dir).to_string_lossy(), safe))
}

/* ---- 选文件 / 读文件：三端差异统一收在这里 ---- */

/// 把对话框或前端给的地址变成文件插件能吃的 `FilePath`。
///
/// 平台差异是硬伤，不统一就会踩：
/// - **iOS**：文件对话框返回 `file://` URL，中文名还是**百分号编码**的。
///   直接 `PathBuf::from(url)` 拿到的是 `%E6%B4%9B%E9%9B%AA…1.js` 这种字面量，
///   于是报 `No such file or directory (os error 2)`（2026-11-22 用户导入音源那条）。
/// - **安卓**：返回 `content://` URI，`std::fs` 完全读不了，得走 ContentResolver。
/// - **桌面**：普通路径，两个变体都一样。
fn to_file_path(path: &str) -> FilePath {
    if path.contains("://") {
        if let Ok(u) = tauri::Url::parse(path) {
            return FilePath::Url(u);
        }
    }
    FilePath::Path(PathBuf::from(path))
}

/// 跨平台读整个文件。
///
/// `file://` 会顺带申请 iOS 的安全作用域（沙箱外的文件必须这么做才能读），
/// `content://` 走 ContentResolver 拿到 fd —— 这两件事 `std::fs` 都做不到。
fn read_any(app: &AppHandle, path: &str) -> Result<Vec<u8>, String> {
    if path.contains("://") {
        return app
            .fs()
            .read(to_file_path(path))
            .map_err(|e| format!("读取文件失败：{e}"));
    }
    std::fs::read(path).map_err(|e| format!("读取文件失败：{e}"))
}

/// 从对话框返回的地址里取文件名。
///
/// `file://` / 普通路径能转成真路径，文件名直接拿（顺带解掉百分号编码）；
/// 安卓 `content://` 的末段是 provider 的内部 id（数字），真名得看 query 里的
/// displayName —— 取不到就返回 None，由调用方用脚本里的 `@name` 兜底。
fn picked_name(f: &FilePath) -> Option<String> {
    if let Ok(p) = f.clone().into_path() {
        if let Some(n) = p.file_name().and_then(|s| s.to_str()) {
            if !n.is_empty() {
                return Some(n.to_string());
            }
        }
    }
    if let FilePath::Url(u) = f {
        for (k, v) in u.query_pairs() {
            if k.eq_ignore_ascii_case("displayname") || k.eq_ignore_ascii_case("display_name") || k == "name" {
                if !v.is_empty() {
                    return Some(v.to_string());
                }
            }
        }
    }
    None
}

/// 移动端的文件选择器不接受「按扩展名过滤」：安卓是按 MIME 匹配的，
/// `.lxmc` / `.m3u8` 这类自定义后缀查不到 MIME，加了过滤反而选不中文件。
/// 桌面上正常加，方便用户只看到候选。
fn file_filter<R: tauri::Runtime>(
    b: tauri_plugin_dialog::FileDialogBuilder<R>,
    list: &[&str],
) -> tauri_plugin_dialog::FileDialogBuilder<R> {
    #[cfg(desktop)]
    {
        b.add_filter("支持的文件", list).add_filter("全部文件", &["*"])
    }
    #[cfg(mobile)]
    {
        let _ = list;
        b
    }
}

/// 选本地 `.js` 脚本文件（可多选），收进音源清单。返回导入后的名字列表。
#[tauri::command]
async fn import_source_files(app: AppHandle) -> Result<Vec<String>, String> {
    let picked = file_filter(app.dialog().file(), &["js"]).blocking_pick_files();
    let files = match picked {
        Some(v) => v,
        None => return Ok(Vec::new()),
    };
    let dir = sources_dir(&app);
    let mut out = Vec::new();
    for f in files {
        let name = picked_name(&f).unwrap_or_else(|| "source.js".to_string());
        let bytes = app
            .fs()
            .read(f)
            .map_err(|e| format!("读取 {name} 失败：{e}"))?;
        if bytes.len() > 8 * 1024 * 1024 {
            return Err(format!("{name} 超过 8MB，不像是音源脚本"));
        }
        let code = String::from_utf8_lossy(&bytes).to_string();
        write_script(&dir, &name, &code)?;
        out.push(safe_script_name(&name));
    }
    Ok(out)
}

/// 直接粘贴脚本文本导入
#[tauri::command]
fn import_source_text(app: AppHandle, name: String, code: String) -> Result<String, String> {
    write_script(&sources_dir(&app), &name, &code)
}

/// 用 URL 导入（脚本放在 GitHub raw / gist / 任意直链上）
#[tauri::command]
async fn import_source_url(app: AppHandle, url: String, name: Option<String>) -> Result<String, String> {
    let url = url.trim().to_string();
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("请输入 http(s) 开头的脚本地址".to_string());
    }
    let fetch_url = url.clone();
    let code = tauri::async_runtime::spawn_blocking(move || {
        let mut headers = std::collections::HashMap::new();
        headers.insert("User-Agent".to_string(), "shuyin/0.2".to_string());
        net::request("GET", &fetch_url, &headers, None, None, false, 20_000).map(|r| r.body)
    })
    .await
    .map_err(|e| format!("下载线程异常：{e}"))??;

    // 文件名优先用用户给的，其次取 URL 最后一段
    let fallback = url
        .split(['?', '#'])
        .next()
        .unwrap_or(&url)
        .rsplit('/')
        .find(|s| !s.trim().is_empty())
        .unwrap_or("source.js")
        .to_string();
    write_script(&sources_dir(&app), name.as_deref().unwrap_or(&fallback), &code)
}

/* ---- 「其他应用打开」送进来的文件 ---- */

/// 文件名清洗：外部来源的名字可能带斜杠 / 引号，落盘前换成下划线。
fn safe_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if "\\/:*?\"<>|".contains(c) || c.is_control() { '_' } else { c })
        .collect();
    let t = cleaned.trim().to_string();
    if t.is_empty() {
        "open-file.bin".to_string()
    } else {
        t.chars().take(120).collect()
    }
}

/// 原生侧暂存文件的目录：`caches/inbox`。
///
/// 安卓在 `MainActivity.stageIncoming` 里拷一次，Apple 平台在 `RunEvent::Opened`
/// 里拷一次，都写到这个位置——目录名两端必须一致。
fn open_file_inbox(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_cache_dir().ok().map(|d| d.join("inbox"))
}

/// iOS：在「安全作用域」里读一个 `file://` 文件。
///
/// 外部 App /「文件」App 递过来的 URL 指向我们自己沙箱之外，没拿到
/// security-scoped 授权时 `std::fs::read` 是 EPERM。UIKit 的规矩是
/// `startAccessingSecurityScopedResource` → 读 → `stop...` 成对调用。
///
/// 为什么不用 `app.fs().read()`：那条路先过 fs 插件的 scope 校验，
/// 沙箱外路径一律 forbidden（而且这里写的是 `let Ok(..) else return`，
/// 失败是静默的）。放开 scope 又要写通配根目录，等于把整个文件系统开给前端。
#[cfg(target_os = "ios")]
fn read_scoped(url: &tauri::Url) -> Option<Vec<u8>> {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    unsafe {
        let c = std::ffi::CString::new(url.as_str()).ok()?;
        let s: Retained<AnyObject> = objc2::msg_send![
            objc2::class!(NSString),
            stringWithUTF8String: c.as_ptr()
        ];
        let u: Retained<AnyObject> = objc2::msg_send![
            objc2::class!(NSURL),
            URLWithString: &*s
        ];
        /* BOOL 用 i8 收：objc 的 BOOL 在这个 ABI 上是 signed char，
           objc2 对 `bool` 的 Encode 实现各版本不一致，i8 最稳 */
        let started: i8 = objc2::msg_send![&*u, startAccessingSecurityScopedResource];
        let out = url.to_file_path().ok().and_then(|p| std::fs::read(p).ok());
        if started != 0 {
            let _: () = objc2::msg_send![&*u, stopAccessingSecurityScopedResource];
        }
        out
    }
}

/// 「用疏音打开」失败时留一张便条给前端。
///
/// 以前这条链路上每一步都是静默 `return`：用户点完「用疏音打开」什么都不发生，
/// 只能得出「打不开」这个结论，我们这边也无从判断是权限、格式还是大小。
/// 现在把原因写进 pending.json，前端弹一句，日志里也留一份。
#[cfg(any(target_os = "macos", target_os = "ios"))]
fn stage_open_failed(app: &AppHandle, name: &str, msg: &str) {
    crate::append_log(app, &format!("open-file: {msg}"));
    let Some(inbox) = open_file_inbox(app) else { return };
    let _ = std::fs::create_dir_all(&inbox);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let obj = serde_json::json!({
        "id": format!("{now}-{name}"),
        "path": "",
        "name": name,
        "size": 0,
        "source": false,
        "error": msg,
    });
    let _ = std::fs::write(inbox.join("pending.json"), obj.to_string());
}

/// 把「用疏音打开」送进来的文件摆到 inbox 上。
///
/// 只落盘、不推送：Apple 平台的冷启动打开早于 WebView 就绪，推事件必丢；
/// 前端启动 / 回到前台时用 `take_open_file` 取一次，天然不漏。
#[cfg(any(target_os = "macos", target_os = "ios"))]
fn stage_opened_file(app: &AppHandle, url: &tauri::Url) {
    let Ok(src) = url.to_file_path() else {
        stage_open_failed(app, "open-file", "系统给的不是本地文件地址");
        return;
    };
    let Some(inbox) = open_file_inbox(app) else { return };
    let _ = std::fs::create_dir_all(&inbox);
    let raw = src
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("open-file.bin")
        .to_string();
    let dest = inbox.join(safe_file_name(&raw));
    /*
     * 读源文件这一步在 iOS 上**不能**走 fs 插件。
     *
     * `app.fs().read()` 会先做 scope 校验：外部 App /「文件」App 送来的路径
     * （`/private/var/mobile/...`）不在允许范围里，直接返回 forbidden，
     * 而这里写的是 `let Ok(..) else { return }`——于是静默什么都不发生，
     * 用户看到的就是「用疏音打开还是不行」（2026-11-22 iPhone 实测）。
     * 给 fs 插件放开「通配整个文件系统」是另一种写法，但那等于把沙箱开给前端。
     *
     * 改用原生那一套：`startAccessingSecurityScopedResource` 拿到临时授权，
     * 直接用 std::fs 读，读完立刻 stop。这才是沙箱外文件的正规姿势。
     */
    #[cfg(target_os = "ios")]
    let bytes = match read_scoped(url) {
        Some(b) => b,
        None => {
            /*
             * 安全作用域那条路走不通时再试一次「直接读」。
             *
             * 「用疏音打开」有两种落地方式：真正的 in-place（沙箱外的 URL，
             * 必须先 startAccessingSecurityScopedResource）和系统把文件先拷进
             * 我们容器里的 `Documents/Inbox/…`（这种本来就在沙箱内，不需要授权）。
             * 以前只有前一条路，后一种会静默失败——用户看到的就是
             * 「用疏音打开文件不能用」（2026-11-24）。
             */
            match std::fs::read(&src) {
                Ok(b) => b,
                Err(e) => {
                    stage_open_failed(app, &raw, &format!("读不出这个文件：{e}"));
                    return;
                }
            }
        }
    };
    #[cfg(not(target_os = "ios"))]
    let Ok(bytes) = app.fs().read(FilePath::Url(url.clone())) else {
        stage_open_failed(app, &raw, "读不出这个文件");
        return;
    };
    if bytes.len() > 32 * 1024 * 1024 {
        stage_open_failed(app, &raw, "文件超过 32MB，不像是音源或歌单");
        return;
    }
    if std::fs::write(&dest, &bytes).is_err() {
        stage_open_failed(app, &raw, "写不进暂存目录");
        return;
    }
    let head: String = String::from_utf8_lossy(&bytes).chars().take(6000).collect();
    let looks = head.contains("@name")
        || head.contains("module.exports")
        || head.contains("musicUrl")
        || head.contains("lx.");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let obj = serde_json::json!({
        "id": format!("{now}-{raw}"),
        "path": dest.to_string_lossy(),
        "name": raw,
        "size": bytes.len(),
        "source": looks,
    });
    let _ = std::fs::write(inbox.join("pending.json"), obj.to_string());
    crate::append_log(
        app,
        &format!("open-file: staged {raw} {}B source={looks}", bytes.len()),
    );
}

/// 把 iOS 冷启动攒下的 URL 摆到 inbox。
///
/// 通知观察者（`ios_openurl`）注册在 `UIApplicationMain` 之前，那时手里还没有
/// AppHandle，所以只能先收着；这里补上落盘那一步。
///
/// 两个调用点都留着（`setup` + `take_open_file`）：前者是正常时序，
/// 后者兜住「通知比 setup 更晚到」和「前端重新回前台再取一次」这两种情况。
/// `stage_opened_file` 本身幂等（同名文件覆盖、pending.json 覆盖），重复不坏事。
#[cfg(target_os = "ios")]
fn flush_cold_open(app: &AppHandle) {
    for raw in ios_openurl::drain() {
        if let Ok(u) = tauri::Url::parse(&raw) {
            stage_opened_file(app, &u);
        }
    }
}

/// 运行期事件：目前只接 Apple 平台的「用疏音打开」。
///
/// Tauri 在 macOS / iOS 上把 openURL 转成 `RunEvent::Opened`，URL 是 `file://`。
#[allow(unused_variables)]
fn on_run_event(app: &AppHandle, event: tauri::RunEvent) {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    if let tauri::RunEvent::Opened { urls } = event {
        for u in urls {
            stage_opened_file(app, &u);
        }
    }
}

/// 取走一次「其他应用打开」的文件（取走即删）。
///
/// 原生只负责把文件摆到桌上（`pending.json` 一行元信息），**导不导入由用户决定**，
/// 所以这里是「读走」而不是「导入」——前端拿到后弹确认框。
///
/// 为什么用文件而不是事件：iOS 的冷启动打开时机比 WebView 就绪早得多，
/// 事件必丢；文件放着不怕，前端启动/回到前台取一次就有。
#[tauri::command]
fn take_open_file(app: AppHandle) -> Option<serde_json::Value> {
    /* iOS 冷启动的文件 URL 是观察者收着、这里才落盘的（见 flush_cold_open） */
    #[cfg(target_os = "ios")]
    flush_cold_open(&app);
    let f = open_file_inbox(&app)?.join("pending.json");
    let text = std::fs::read_to_string(&f).ok()?;
    let _ = std::fs::remove_file(&f);
    serde_json::from_str(&text).ok()
}

/// 把一张本地封面读成 `data:` URL。
///
/// 只给 iOS 的 Live Activity 用：扩展进程跟主 App 各是各的沙箱，`file://`
/// 路径在那边是读不到的，所以图必须以字节形式塞进 ContentState。前端再把它
/// 压到 72×72（ContentState 只有 4KB 预算），尺寸压缩交给 canvas 更省事。
///
/// 限制 6MB：正常封面几百 KB，超了说明拿错文件了，不陪它玩。
#[tauri::command]
fn read_cover_data_url(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("封面读不出来：{e}"))?;
    if bytes.len() > 6 * 1024 * 1024 {
        return Err("封面文件过大".to_string());
    }
    // 只认魔数，不看扩展名：缓存目录里的文件是按哈希命名的，没有后缀
    let mime = match bytes.first().copied() {
        Some(0xFF) => "image/jpeg",
        Some(0x89) => "image/png",
        Some(b'G') => "image/gif",
        Some(b'R') => "image/webp",
        _ => "image/jpeg",
    };
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{mime};base64,{b64}"))
}

/// 把原生暂存的音源脚本收进清单，返回最终落下的名字。
#[tauri::command]
fn import_source_staged(app: AppHandle, path: String, name: Option<String>) -> Result<String, String> {
    let bytes = read_any(&app, &path)?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("文件超过 8MB，不像是音源脚本".to_string());
    }
    let code = String::from_utf8_lossy(&bytes).to_string();
    let fallback = picked_name(&to_file_path(&path)).unwrap_or_else(|| "source.js".to_string());
    write_script(&sources_dir(&app), name.as_deref().unwrap_or(&fallback), &code)
}

/// 删除一个音源：只从清单里摘掉一条。
/// 地址是合成地址（`…/sources.json#名字`）；兼容旧版直接传 .js 路径的情况。
#[tauri::command]
fn delete_source_script(path: String) -> Result<(), String> {
    if let Some((file, name)) = path.split_once('#') {
        let dir = PathBuf::from(file)
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));
        let mut m = load_manifest(&dir)?;
        let before = m.sources.len();
        m.sources.retain(|x| x.name != name);
        if m.sources.len() == before {
            return Err("音源不在清单里（可能已经删掉了）".to_string());
        }
        return save_manifest(&dir, &m);
    }
    // 旧版地址：一个 .js 文件——删文件，并顺手把同名条目从清单里去掉
    let p = PathBuf::from(&path);
    let stem = p.file_stem().and_then(|s| s.to_str()).map(|s| s.to_string());
    if let (Some(dir), Some(stem)) = (p.parent(), stem) {
        if let Ok(mut m) = load_manifest(dir) {
            let before = m.sources.len();
            m.sources.retain(|x| x.name != stem);
            if m.sources.len() != before {
                let _ = save_manifest(dir, &m);
            }
        }
    }
    std::fs::remove_file(&p).map_err(|e| format!("删除失败：{e}"))
}

#[tauri::command]
fn pause(player: State<'_, Player>) {
    player.pause();
}#[tauri::command]
fn resume(player: State<'_, Player>) {
    player.resume();
}

#[tauri::command]
fn stop(player: State<'_, Player>) {
    player.stop();
}

#[tauri::command]
fn seek(player: State<'_, Player>, position_secs: f64) {
    player.seek(position_secs);
}

#[tauri::command]
fn set_volume(player: State<'_, Player>, volume: f32) {
    player.set_volume(volume);
}

/// 音效：五段均衡增益（dB）+ 前置增益（dB）+ 声道平衡（-1..1）。
/// 频点见 `player::FX_BANDS_HZ`，必须与前端 `FX_BANDS_HZ` 一致。
/// 改完立刻生效，不需要重载当前曲目。
#[tauri::command]
fn set_fx(player: State<'_, Player>, bands: Vec<f32>, pre: f32, balance: f32, space: Option<u32>) {
    let mut b = [0f32; 5];
    for (i, v) in bands.iter().take(5).enumerate() {
        b[i] = *v;
    }
    player.set_fx(b, pre, balance, space.unwrap_or(0));
}

/// 频谱快照：40 个频段，0..1（前端按帧轮询，暂停时返回全 0）
#[tauri::command]
fn spectrum(player: State<'_, Player>) -> Vec<f32> {
    player.spectrum()
}

/// 封面文件绝对路径（前端 convertFileSrc 用）
#[tauri::command]
fn cover_abs_path(app: AppHandle, cover: String) -> Result<String, String> {
    let p = crate::db::covers_dir(&app).join(cover);
    Ok(p.to_string_lossy().to_string())
}

/* ------------------------------------------------------------------ */
/* 窗口 / 托盘 / 桌面歌词                                              */
/* ------------------------------------------------------------------ */

#[cfg(desktop)]
fn show_main_window(app: &AppHandle) {
    // 第二次启动时主窗口可能还没建好（单例回调比 setup 早），等它一会儿再唤
    if app.get_webview_window("main").is_none() {
        let a = app.clone();
        std::thread::spawn(move || {
            for _ in 0..20 {
                std::thread::sleep(Duration::from_millis(200));
                if let Some(w) = a.get_webview_window("main") {
                    raise_window(w);
                    return;
                }
            }
        });
        return;
    }
    if let Some(w) = app.get_webview_window("main") {
        raise_window(w);
    }
}

/// 把窗口从「最小化 / 托盘 / 被别的窗口盖住」三种状态里提出来。
#[cfg(desktop)]
fn raise_window(w: tauri::WebviewWindow) {
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
    /*
     * Windows 的前台窗口锁：焦点刚被别的进程拿走时，SetForegroundWindow 会被系统忽略，
     * 表现就是「双击图标，任务栏闪了一下，窗口没出来」。
     * 短暂置顶再取消能绕过去——这是各家启动器都在用的老办法。
     */
    #[cfg(windows)]
    {
        let _ = w.set_always_on_top(true);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(70));
            let _ = w.set_always_on_top(false);
            let _ = w.set_focus();
        });
    }
}

/// 桌面歌词窗口位置文件（记住上次拖到哪）
#[cfg(desktop)]
fn lyrics_pos_file(app: &AppHandle) -> PathBuf {
    app.path()
        .app_local_data_dir()
        .map(|d| d.join("lyrics.window.json"))
        .unwrap_or_else(|_| PathBuf::from("lyrics.window.json"))
}

#[cfg(desktop)]
fn read_lyrics_pos(app: &AppHandle) -> Option<(i32, i32)> {
    let raw = std::fs::read_to_string(lyrics_pos_file(app)).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    Some((v.get("x")?.as_i64()? as i32, v.get("y")?.as_i64()? as i32))
}

#[cfg(desktop)]
fn save_lyrics_pos(app: &AppHandle, x: i32, y: i32) {
    let state = app.try_state::<LyricsState>();
    if let Some(st) = state {
        let mut last = st.last_save.lock().unwrap_or_else(|e| e.into_inner());
        // 拖动时 Moved 事件很密，500ms 落一次盘就够
        if last.elapsed() < Duration::from_millis(500) {
            return;
        }
        *last = Instant::now();
    }
    let path = lyrics_pos_file(app);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let body = serde_json::json!({ "x": x, "y": y }).to_string();
    let _ = std::fs::write(path, body);
}

/* ------------------------------------------------------------------ */
/* 无边框窗口的最大化修正                                                */
/* ------------------------------------------------------------------ */

/// 无边框窗口（decorations: false）调用系统 maximize 时，Windows 按「整个显示器」
/// 算最大化尺寸：任务栏被盖住，窗口还会被往外推几个像素。DWM 的圆角也一并失效。
///
/// 标准修法是拦 WM_GETMINMAXINFO，把最大化尺寸改成当前显示器的工作区。
/// 这样 IsZoomed、Win+↑、Aero Snap、双击标题栏全都走系统逻辑，前端不需要伪造状态。
#[cfg(windows)]
fn install_max_fix(win: &WebviewWindow) {
    use core::ffi::c_void;
    let Ok(h) = win.hwnd() else { return };
    let hwnd = h.0;
    if hwnd.is_null() {
        return;
    }

    #[repr(C)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }
    #[repr(C)]
    struct MonitorInfo {
        cb_size: u32,
        rc_monitor: Rect,
        rc_work: Rect,
        flags: u32,
    }
    #[repr(C)]
    struct Point {
        x: i32,
        y: i32,
    }
    #[repr(C)]
    struct MinMaxInfo {
        pt_reserved: Point,
        pt_max_size: Point,
        pt_max_position: Point,
        pt_min_track_size: Point,
        pt_max_track_size: Point,
    }

    type SubclassProc =
        unsafe extern "system" fn(*mut c_void, u32, usize, isize, usize, usize) -> isize;

    #[link(name = "comctl32")]
    extern "system" {
        fn SetWindowSubclass(
            hwnd: *mut c_void,
            proc_: SubclassProc,
            id: usize,
            data: usize,
        ) -> i32;
        fn DefSubclassProc(hwnd: *mut c_void, msg: u32, wparam: usize, lparam: isize) -> isize;
    }
    #[link(name = "user32")]
    extern "system" {
        fn MonitorFromWindow(hwnd: *mut c_void, flags: u32) -> *mut c_void;
        fn GetMonitorInfoW(mon: *mut c_void, info: *mut MonitorInfo) -> i32;
    }

    #[repr(C)]
    struct WindowPos {
        hwnd: *mut c_void,
        hwnd_insert_after: *mut c_void,
        x: i32,
        y: i32,
        cx: i32,
        cy: i32,
        flags: u32,
    }

    unsafe extern "system" fn subclass(
        hwnd: *mut c_void,
        msg: u32,
        wparam: usize,
        lparam: isize,
        _id: usize,
        _data: usize,
    ) -> isize {
        const WM_GETMINMAXINFO: u32 = 0x0024;
        const WM_WINDOWPOSCHANGING: u32 = 0x0046;
        const SWP_NOSIZE: u32 = 0x0001;
        const MONITOR_DEFAULTTONEAREST: u32 = 2;

        if msg == WM_WINDOWPOSCHANGING {
            /*
             * 下限的第二道保险。
             *
             * ptMinTrackSize（tao 在 WM_GETMINMAXINFO 里按 size_constraints 填）
             * 只管「用户拖拽 / Aero Snap」——程序化 set_size、跨显示器 DPI 变化
             * 引起的缩小它一概不管，那两条路会把窗口压到下限以下、两列被挤扁。
             * 在这条消息里把拟议尺寸钳回下限：
             *   · 用户拖拽系统已经按 min tracking 夹过，这里是空转；
             *   · 最大化给的是工作区，必然大于下限，不会误伤；
             *   · SWP_NOSIZE 时 cx/cy 不被采用，不能碰（否则纯移动会被强行改尺寸）。
             */
            let mw = MIN_W.load(Ordering::Relaxed) as i32;
            let mh = MIN_H.load(Ordering::Relaxed) as i32;
            if mw > 0 && mh > 0 {
                let wp = lparam as *mut WindowPos;
                if !wp.is_null() && (*wp).flags & SWP_NOSIZE == 0 {
                    if (*wp).cx < mw {
                        (*wp).cx = mw;
                    }
                    if (*wp).cy < mh {
                        (*wp).cy = mh;
                    }
                }
            }
            return DefSubclassProc(hwnd, msg, wparam, lparam);
        }

        if msg == WM_GETMINMAXINFO {
            /*
             * 先把消息送给 tao 的原窗口过程：ptMinTrackSize / ptMaxTrackSize
             * 是它填的（tao event_loop.rs 的 WM_GETMINMAXINFO 分支）。
             * 以前这里自己盖完 ptMaxSize 就 return 0，原过程整条被跳过 →
             * ptMinTrackSize 留在系统默认值 → 最小尺寸整个失效
             * （实测能拖到 700×500，启动窗口也只有 616 CSS 高）。
             * 现在原过程先跑，我们只在它的基础上盖掉「最大化尺寸 = 工作区」。
             */
            let r = DefSubclassProc(hwnd, msg, wparam, lparam);
            let mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            if !mon.is_null() {
                let mut mi = MonitorInfo {
                    cb_size: core::mem::size_of::<MonitorInfo>() as u32,
                    rc_monitor: Rect { left: 0, top: 0, right: 0, bottom: 0 },
                    rc_work: Rect { left: 0, top: 0, right: 0, bottom: 0 },
                    flags: 0,
                };
                if GetMonitorInfoW(mon, &mut mi) != 0 {
                    let mmi = lparam as *mut MinMaxInfo;
                    if !mmi.is_null() {
                        (*mmi).pt_max_size = Point {
                            x: mi.rc_work.right - mi.rc_work.left,
                            y: mi.rc_work.bottom - mi.rc_work.top,
                        };
                        // 相对显示器左上角的偏移（任务栏在上时就是负值）
                        (*mmi).pt_max_position = Point {
                            x: mi.rc_work.left - mi.rc_monitor.left,
                            y: mi.rc_work.top - mi.rc_monitor.top,
                        };
                    }
                }
            }
            return r;
        }

        DefSubclassProc(hwnd, msg, wparam, lparam)
    }

    unsafe {
        let ok = SetWindowSubclass(hwnd, subclass, 0x5359, 0);
        append_log(
            win.app_handle(),
            if ok != 0 { "window.maxfix ok" } else { "window.maxfix fail" },
        );
    }
}

/// 非 Windows：无边框窗口最大化由系统按工作区处理，无需修正。
#[cfg(not(windows))]
fn install_max_fix(_win: &WebviewWindow) {}

/* ---------------- 主窗口位置 / 大小记忆 ---------------- */

#[cfg(desktop)]
fn main_geo_file(app: &AppHandle) -> PathBuf {
    app.path()
        .app_local_data_dir()
        .map(|d| d.join("main.window.json"))
        .unwrap_or_else(|_| PathBuf::from("main.window.json"))
}

#[cfg(desktop)]
fn read_main_geo(app: &AppHandle) -> Option<(i32, i32, u32, u32, bool)> {
    let raw = std::fs::read_to_string(main_geo_file(app)).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    Some((
        v.get("x")?.as_i64()? as i32,
        v.get("y")?.as_i64()? as i32,
        v.get("w")?.as_u64()? as u32,
        v.get("h")?.as_u64()? as u32,
        v.get("maximized").and_then(|m| m.as_bool()).unwrap_or(false),
    ))
}

/// 窗口至少要有这么一块落在某个显示器里，否则宁可用默认居中
#[cfg(desktop)]
fn geo_on_screen(app: &AppHandle, x: i32, y: i32, w: u32, h: u32) -> bool {
    let Ok(mons) = app.available_monitors() else { return true };
    if mons.is_empty() {
        return true;
    }
    mons.iter().any(|m| {
        let mp = m.position();
        let ms = m.size();
        let ix = (x + w as i32).min(mp.x + ms.width as i32) - x.max(mp.x);
        let iy = (y + h as i32).min(mp.y + ms.height as i32) - y.max(mp.y);
        ix >= 120 && iy >= 80
    })
}

#[cfg(desktop)]
fn save_main_geo(app: &AppHandle, force: bool) {
    let Some(win) = app.get_webview_window("main") else { return };
    // 最小化时 outer_position 是 -32000 之类的哨兵值，inner_size 也塌成最小值，
    // 存下来会把下次启动摆到屏幕外、缩成一条缝
    if win.is_minimized().unwrap_or(false) {
        return;
    }
    if let Some(st) = app.try_state::<WindowGeo>() {
        let mut last = st.last_save.lock().unwrap_or_else(|e| e.into_inner());
        if !force && last.elapsed() < Duration::from_millis(700) {
            return;
        }
        *last = Instant::now();
    }
    let (Ok(pos), Ok(size)) = (win.outer_position(), win.inner_size()) else {
        return;
    };
    // 系统 snap / Win+↑ 会真的 zoom；前端按钮是「伪最大化」。两种都算最大化态
    let hint = app
        .try_state::<WindowGeo>()
        .and_then(|s| s.max_hint.lock().ok().map(|v| *v))
        .unwrap_or(false);
    let maximized = win.is_maximized().unwrap_or(false) || hint;
    let prev = read_main_geo(app);
    // 最大化时 inner_size 是屏幕尺寸，存下来会让「还原」变成一个铺满的窗口：
    // 尺寸沿用上一次正常态的，只更新 maximized 标记。
    let (w, h, x, y) = if maximized {
        // 位置同样沿用上一次正常态：伪最大化的窗口被摆在 (0,0)，
        // 存下来会让「启动即最大化 → 还原」把窗口扔到屏幕左上角
        let (px, py, pw, ph, _) = prev.unwrap_or((0, 0, 1180, 760, false));
        (pw, ph, px, py)
    } else {
        (size.width, size.height, pos.x, pos.y)
    };
    let path = main_geo_file(app);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let body = serde_json::json!({
        "x": x, "y": y, "w": w, "h": h, "maximized": maximized
    })
    .to_string();
    let _ = std::fs::write(path, body);
}

/**
 * 还原上次的窗口位置与大小（越界则保持默认居中）。
 *
 * 尺寸会被夹到「最小尺寸」之上：存档里可能是旧版本（小窗口）存下来的尺寸，
 * 直接 set_size 会绕过 min_inner_size —— 窗口回到了比最小值还小的状态，
 * 两列布局被挤扁。最小尺寸按当前缩放算（和 apply_min_size 同一套值）。
 */
#[cfg(desktop)]
fn restore_main_geo(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else { return };
    let Some((x, y, w, h, maximized)) = read_main_geo(app) else { return };
    if w < 480 || h < 400 {
        return;
    }
    let sf = win.scale_factor().unwrap_or(1.0);
    let min_w = (1120.0 * sf).ceil() as u32;
    let min_h = (680.0 * sf).ceil() as u32;
    let (w, h) = (w.max(min_w), h.max(min_h));
    if !geo_on_screen(app, x, y, w, h) {
        append_log(app, "window.geo 忽略越界记录");
        return;
    }
    let _ = win.set_size(tauri::PhysicalSize::new(w, h));
    let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
    if maximized {
        // 最大化尺寸已由 install_max_fix 的 WM_GETMINMAXINFO 修正到工作区
        let _ = win.maximize();
    }
    append_log(app, &format!("window.geo restore {x},{y} {w}x{h} max={maximized}"));
}

/// 关掉 WebView 自己的双指缩放（iOS 捏合 / macOS 触控板）。
///
/// 这是**浏览器行为**，不是 App 行为：双指外滑整页放大、捏合缩小，
/// 手机上放大之后连退出播放页都回不到原尺寸，用户只会觉得界面错位。
///
/// viewport 里的 `user-scalable=no` 不能指望：iOS 10 之后 WebKit 出于
/// 无障碍考虑直接忽略它（Safari 和 WKWebView 都一样）。能钉死的只有
/// 原生滚动视图的缩放范围 —— iOS 上缩放全在 WKWebView 内部的 UIScrollView
/// 上，把 min/max 都压成 1，捏合手势再有效也缩不动，双击放大同样失效。
#[cfg(any(target_os = "ios", target_os = "macos"))]
fn disable_zoom(win: &WebviewWindow) {
    let _ = win.with_webview(|webview| {
        let wk = webview.inner() as *mut objc2::runtime::AnyObject;
        if wk.is_null() {
            return;
        }

        #[cfg(target_os = "ios")]
        unsafe {
            use objc2::msg_send;
            let scroll: *mut objc2::runtime::AnyObject = msg_send![wk, scrollView];
            if !scroll.is_null() {
                let _: () = msg_send![scroll, setMinimumZoomScale: 1.0f64];
                let _: () = msg_send![scroll, setMaximumZoomScale: 1.0f64];
                let _: () = msg_send![scroll, setZoomScale: 1.0f64];
            }
        }

        #[cfg(target_os = "macos")]
        unsafe {
            use objc2::msg_send;
            // macOS 上 WKWebView 自己就有开关（触控板捏合放大）
            let _: () = msg_send![wk, setAllowsMagnification: false];
        }
    });
}

/*
 * 无边框窗口的两件装饰（Windows）：
 *   圆角 —— Win11 上无装饰窗口默认是直角的，跟应用内的圆角卡片气质不搭；
 *   阴影 —— 无装饰窗口没有系统投影，窗口和桌面融为一体、边界看不清。
 * 两个都是 DWM 属性调用，失败（旧系统 / 主题禁用）时静默跳过即可。
 */
#[cfg(windows)]
fn decorate_frameless(win: &WebviewWindow) {    let Ok(h) = win.hwnd() else { return };
    let hwnd = h.0;
    if hwnd.is_null() {
        return;
    }
    use core::ffi::c_void;
    #[repr(C)]
    struct Margins {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }
    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmSetWindowAttribute(hwnd: *mut c_void, attr: u32, value: *const c_void, size: u32) -> i32;
        fn DwmExtendFrameIntoClientArea(hwnd: *mut c_void, margins: *const Margins) -> i32;
    }
    unsafe {
        // DWMWA_WINDOW_CORNER_PREFERENCE = 33；DWMWCP_ROUND = 2
        let pref: u32 = 2;
        DwmSetWindowAttribute(hwnd, 33, &pref as *const _ as *const c_void, 4);
        // 1px 边框扩进客户区，DWM 就会替窗口补上投影（不扩则无装饰窗口没有阴影）
        let m = Margins { left: 1, top: 1, right: 1, bottom: 1 };
        DwmExtendFrameIntoClientArea(hwnd, &m);
    }
}

/// 非 Windows：无 DWM 装饰概念，占位即可。
#[cfg(not(windows))]
fn decorate_frameless(_win: &WebviewWindow) {}

/// 桌面歌词窗口：透明、无边框、置顶、不进任务栏
#[cfg(desktop)]
fn build_lyrics_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(w) = app.get_webview_window("lyrics") {
        return Ok(w);
    }
    let win = WebviewWindowBuilder::new(app, "lyrics", WebviewUrl::App("lyrics.html".into()))
        .title("疏音 · 桌面歌词")
        .inner_size(900.0, 190.0)
        .additional_browser_args(browser_args())
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .focused(false)
        // 预建窗口一律「建出来就是隐藏的」：否则启动时会在屏幕上闪一下，
        // 用户看到的就是「开应用闪了好几个窗口然后都不见了」
        .visible(false)
        .build()
        .map_err(|e| format!("创建桌面歌词窗口失败：{e}"))?;

    // 位置优先级：上次拖到的位置 > 主屏底部居中
    if let Some((x, y)) = read_lyrics_pos(app) {
        // 简单越界保护：显示器数量/分辨率变了以后别把窗口丢在屏幕外
        if let Ok(Some(mon)) = win.primary_monitor() {
            let s = mon.size();
            if x > -200 && y > -200 && x < s.width as i32 - 120 && y < s.height as i32 - 60 {
                let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
            }
        }
    } else if let Ok(Some(mon)) = win.primary_monitor() {
        let size = mon.size();
        let scale = mon.scale_factor();
        let w = (900.0 * scale) as i32;
        let h = (190.0 * scale) as i32;
        let x = (size.width as i32 - w) / 2;
        let y = size.height as i32 - h - (108.0 * scale) as i32;
        let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
    }

    // 锁定状态要跟着窗口恢复（之前锁定着，重开还是锁定）
    if let Some(st) = app.try_state::<LyricsState>() {
        if st.locked.load(Ordering::SeqCst) {
            let _ = win.set_ignore_cursor_events(true);
        }
    }
    Ok(win)
}

#[cfg(desktop)]
#[tauri::command]
fn lyrics_open(app: AppHandle) -> Result<(), String> {
    // 建 WebView2 窗口必须回到主线程：IPC 线程没有 Win32 消息泵，
    // WebView2 的环境创建回调永远不会触发，表现就是"点了没反应"（卡死在 build）
    let a = app.clone();
    app.run_on_main_thread(move || match build_lyrics_window(&a) {
        Ok(w) => {
            let _ = w.show();
            let _ = w.set_focus();
            append_log(&a, "lyrics.open ok");
            // 用户主动打开 = 要操作它：顺手解锁，避免「打开后怎么点都没反应」的错觉
            if let Some(st) = a.try_state::<LyricsState>() {
                if st.locked.swap(false, Ordering::SeqCst) {
                    let _ = w.set_ignore_cursor_events(false);
                    let _ = a.emit(
                        "lyrics://action",
                        serde_json::json!({ "action": "lock", "locked": false }),
                    );
                }
            }
        }
        Err(e) => append_log(&a, &format!("lyrics.open fail {e}")),
    })
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(desktop)]
#[tauri::command]
fn lyrics_hide(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("lyrics") {
        let _ = w.hide();
    }
    Ok(())
}

#[cfg(desktop)]
#[tauri::command]
fn lyrics_close(app: AppHandle) -> Result<(), String> {
    // 只隐藏：窗口预建过一次，销毁后再开要走 WebView2 重建设路（容易卡）
    if let Some(w) = app.get_webview_window("lyrics") {
        let _ = w.hide();
    }
    Ok(())
}

/// 桌面歌词是否开着（前端按钮态用）
#[cfg(desktop)]
#[tauri::command]
fn lyrics_visible(app: AppHandle) -> bool {
    app.get_webview_window("lyrics")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false)
}

/// 锁定：锁定后鼠标穿透，不挡桌面操作（微信/QQ 音乐同款行为）
#[cfg(desktop)]
#[tauri::command]
fn lyrics_set_locked(app: AppHandle, locked: bool) -> Result<(), String> {
    if let Some(st) = app.try_state::<LyricsState>() {
        st.locked.store(locked, Ordering::SeqCst);
    }
    if let Some(w) = app.get_webview_window("lyrics") {
        w.set_ignore_cursor_events(locked).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(desktop)]
#[tauri::command]
fn lyrics_is_locked(app: AppHandle) -> bool {
    app.try_state::<LyricsState>()
        .map(|s| s.locked.load(Ordering::SeqCst))
        .unwrap_or(false)
}

/// 桌面歌词里双击/回车回到主窗口
#[cfg(desktop)]
#[tauri::command]
fn show_main(app: AppHandle) {
    show_main_window(&app);
}

/* ------------------------------------------------------------------ */
/* 音乐桌面：铺满主屏的「壁纸式」音乐屏                                  */
/* ------------------------------------------------------------------ */

/// 建窗口。**必须在主线程**（和桌面歌词同一个理由：IPC 线程没有消息泵）。
///
/// 三个关键属性：
///   · `always_on_bottom` —— 默认压在所有窗口下面，才谈得上「当桌面壁纸」。
///     代价是盖住桌面图标；用户点「置顶」可以随时浮上来。
///   · `skip_taskbar` —— 它是一块背景，不该在任务栏再占一格。
///   · `focused(false)` —— 打开时不要从主窗口抢走焦点，否则正在打字的输入框会被打断。
///
/// **`always_on_bottom` / `always_on_top` 不写在 builder 上，建完再设**。
/// 写进 builder 时 `build()` 会卡死（v0.5.5 实测：invoke 永不返回、主线程被锁住，
/// 之后连 `lyrics_visible` 这种纯读命令都超时）。桌面歌词窗口不设这两个属性，
/// 是这套建窗流程里唯一被线上验证过的组合——所以这里严格照抄它，
/// 层级放到 `build()` 之后用 `set_always_on_*` 显式设（两个都要设，不能只设一个）。
#[cfg(desktop)]
fn build_desk_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(w) = app.get_webview_window("musicdesk") {
        return Ok(w);
    }
    append_log(app, "musicdesk.build start");
    let win = WebviewWindowBuilder::new(app, "musicdesk", WebviewUrl::App("musicdesk.html".into()))
        .title("疏音 · 音乐桌面")
        .skip_taskbar(true)
        .shadow(false)
        .decorations(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .focused(false)
        .visible(false)
        .additional_browser_args(browser_args())
        .build()
        .map_err(|e| format!("创建音乐桌面窗口失败：{e}"))?;
    append_log(app, "musicdesk.build ok");

    // 铺满主屏。用物理像素直接设，别走 LogicalSize：
    // 这台机器上 WebView2 的 dpr（1.71）和显示器 scaleFactor（1.5）不一致，
    // 逻辑尺寸会让窗口比屏幕小一圈，四边露出主窗口。
    if let Ok(Some(mon)) = win.primary_monitor() {
        let size = mon.size();
        let pos = mon.position();
        let _ = win.set_position(tauri::PhysicalPosition::new(pos.x, pos.y));
        let _ = win.set_size(tauri::PhysicalSize::new(size.width, size.height));
        append_log(app, &format!("musicdesk.geom {}x{}", size.width, size.height));
    }
    Ok(win)
}

/// 音乐锁屏窗口：**和音乐桌面是两个独立窗口**（label `musiclock`）。
///
/// 之前锁屏是借音乐桌面那个窗口「拔出来置顶」实现的，副作用是：开锁屏等于把
/// 音乐桌面也打开了（壁纸层的显示状态被一起改掉），两个功能绑在一起。
/// 现在各自一个窗口，锁屏开关不影响壁纸，壁纸开关也不影响锁屏。
///
/// 建窗规则照抄 `build_desk_window`（主线程建 `build()` 会死锁，所以同样放在 setup 预建）。
#[cfg(desktop)]
fn build_lock_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(w) = app.get_webview_window("musiclock") {
        return Ok(w);
    }
    append_log(app, "musiclock.build start");
    let win = WebviewWindowBuilder::new(app, "musiclock", WebviewUrl::App("musiclock.html".into()))
        .title("疏音 · 音乐锁屏")
        .skip_taskbar(true)
        .shadow(false)
        .decorations(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .focused(false)
        .visible(false)
        .additional_browser_args(browser_args())
        .build()
        .map_err(|e| format!("创建音乐锁屏窗口失败：{e}"))?;
    append_log(app, "musiclock.build ok");

    if let Ok(Some(mon)) = win.primary_monitor() {
        let size = mon.size();
        let pos = mon.position();
        let _ = win.set_position(tauri::PhysicalPosition::new(pos.x, pos.y));
        let _ = win.set_size(tauri::PhysicalSize::new(size.width, size.height));
    }
    Ok(win)
}

/// 音乐桌面当前层级（bottom=嵌在壁纸层 / top=浮在最上面）
static DESK_LAYER_TOP: AtomicBool = AtomicBool::new(false);

#[cfg(windows)]
fn desk_hwnd(w: &WebviewWindow) -> Option<windows::Win32::Foundation::HWND> {
    // tauri 的 HWND 来自它自己的 windows 版本，跨版本按裸指针转
    w.hwnd().ok().map(|h| windows::Win32::Foundation::HWND(h.0))
}

/// 应用层级：`bottom` = **嵌进桌面壁纸层**（WorkerW，图标保留、Win+D 收不走）；
/// 嵌不进去再退回 `always_on_bottom`。`top` = 拔出来置顶。
/// **必须在主线程**（SetParent / 窗口样式都要求）。
#[cfg(desktop)]
fn apply_desk_layer(app: &AppHandle, layer: &str) {
    let Some(w) = app.get_webview_window("musicdesk") else { return };
    let top = layer == "top";
    DESK_LAYER_TOP.store(top, Ordering::Relaxed);

    #[cfg(windows)]
    {
        if top {
            if let Some(h) = desk_hwnd(&w) {
                wallpaper::detach(h);
            }
            let _ = w.set_always_on_top(true);
            let _ = w.set_always_on_bottom(false);
            let _ = w.set_focus();
            append_log(app, "desk.layer top");
        } else {
            let _ = w.set_always_on_top(false);
            // 嵌进桌面层：挂到「含 SHELLDLL_DefView 的父窗口」并压到 z 序最底
            // → 图标在上面、壁纸在下面（Win10 / Win11 结构不同，wallpaper.rs 里统一处理）
            let res = desk_hwnd(&w)
                .map(wallpaper::attach)
                .unwrap_or(wallpaper::Attach { ok: false, detail: "no-hwnd".into() });
            if res.ok {
                append_log(app, &format!("desk.wallpaper attach ok [{}]", res.detail));
            } else {
                // 精简系统 / shell 结构异常：退回置底，盖住图标但功能不缺
                let _ = w.set_always_on_bottom(true);
                append_log(
                    app,
                    &format!("desk.wallpaper attach fail [{}], fallback bottom", res.detail),
                );
            }
        }
    }
    let _ = w; // 非 windows 下只占位
}

/// 「音乐锁屏」显示：把**锁屏窗口**置顶铺满。主线程调用。
///
/// 完全不碰音乐桌面窗口：桌面该是壁纸就继续当壁纸（锁屏窗口全屏置顶会盖住它，
/// 退出后露出来的还是原来的壁纸，状态没被改过）。
#[cfg(desktop)]
fn desk_lock_show(app: &AppHandle) {
    match app.get_webview_window("musiclock") {
        Some(w) => {
            let _ = w.show();
            let _ = w.set_always_on_top(true);
            let _ = w.set_focus();
            let _ = app.emit("desk://autolock", true);
            append_log(app, "desk.lock show");
        }
        None => {
            // 预建失败（极少见）：换线程补建，别在主线程上等 WebView2
            let a = app.clone();
            std::thread::spawn(move || match build_lock_window(&a) {
                Ok(w) => {
                    let _ = w.show();
                    let _ = w.set_always_on_top(true);
                    let _ = a.emit("desk://autolock", true);
                    append_log(&a, "desk.lock show (rebuilt)");
                }
                Err(e) => append_log(&a, &format!("desk.lock fail {e}")),
            });
        }
    }
}

/// 「音乐锁屏」退出：只收锁屏窗口，音乐桌面的显示状态原样保留。主线程调用。
#[cfg(desktop)]
fn desk_lock_hide(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("musiclock") {
        let _ = w.set_always_on_top(false);
        let _ = w.hide();
    }
    let _ = app.emit("desk://autolock", false);
    append_log(app, "desk.lock hide");
}

/// 进入「音乐锁屏」（用户主动：快捷键 / 设置页按钮 / 托盘）。
#[cfg(desktop)]
#[tauri::command]
fn desk_lock_enter(app: AppHandle) -> Result<(), String> {
    let a = app.clone();
    app.run_on_main_thread(move || desk_lock_show(&a)).map_err(|e| e.to_string())?;
    Ok(())
}

/// 退出「音乐锁屏」：前端收到事件后按「进来前是否开着」决定收起或重新嵌回壁纸层。
#[cfg(desktop)]
#[tauri::command]
fn desk_lock_exit(app: AppHandle) -> Result<(), String> {
    let a = app.clone();
    app.run_on_main_thread(move || desk_lock_hide(&a)).map_err(|e| e.to_string())?;
    Ok(())
}

/// 打开某个平台的官方登录窗（目前只有网易云）。
///
/// 结果不走返回值、走 `platform://login` 事件：登录要人等，命令不能挂在那里。
/// 详见 `platform_login.rs`。
#[tauri::command]
async fn platform_login(app: AppHandle, source: String) -> Result<(), String> {
    #[cfg(desktop)]
    return platform_login::open(&app, &source);
    #[cfg(mobile)]
    {
        let _ = (app, source);
        Err("移动端暂不支持平台账号网页登录".to_string())
    }
}

/// 打开音乐桌面。`layer` = `bottom`（嵌壁纸）/ `top`（浮在最上面）。
///
/// **只做 show 和层级，不建窗口**：窗口在 setup 阶段就预建好了。
/// v0.5.5 实测过在主线程里 `build()` 会死锁——WebView2 的环境创建回调要主线程消息泵，
/// 而我们正堵在 `recv()` 上等它，表现是「点了没反应，整个应用一起卡死」。
/// setup 阶段建（同歌词窗 / 托盘窗）没有这个问题，顺带让「打开」秒出。
#[cfg(desktop)]
#[tauri::command]
fn musicdesk_open(app: AppHandle, layer: Option<String>) -> Result<(), String> {
    let layer = layer.unwrap_or_else(|| "bottom".into());
    let a = app.clone();
    app.run_on_main_thread(move || {
        match a.get_webview_window("musicdesk") {
            Some(w) => {
                /*
                 * **先 show 再挂壁纸层**（顺序不能反）。
                 *
                 * tao 的 `show()` 会把窗口 flags 整体重刷：顶层窗口按 WS_POPUP + WS_VISIBLE
                 * 重写样式。如果先 apply_desk_layer 再 show，刚设好的 WS_CHILD 就被抹掉，
                 * 窗口变成「有父窗口的弹窗」——Z 序跑到 SHELLDLL_DefView 前面，
                 * 把整块桌面图标盖住（双击图标自然没反应，用户看到的就是「退回老版本」）。
                 * 两步都在同一次主线程调用里，中间不出帧，所以看不到闪。
                 */
                let _ = w.show();
                apply_desk_layer(&a, &layer);
                append_log(&a, "musicdesk.open ok");
            }
            None => {
                // 极端情况（预建失败）：放到独立线程建，别在主线程上等
                let a2 = a.clone();
                let layer2 = layer.clone();
                std::thread::spawn(move || match build_desk_window(&a2) {
                    Ok(w) => {
                        // 同 Some 分支：先 show（tao 会重刷样式），再把壁纸层压上去
                        let _ = w.show();
                        let a3 = a2.clone();
                        let a4 = a3.clone();
                        let l = layer2.clone();
                        let _ = a3.run_on_main_thread(move || apply_desk_layer(&a4, &l));
                        append_log(&a2, "musicdesk.rebuild ok");
                    }
                    Err(e) => append_log(&a2, &format!("musicdesk.rebuild fail {e}")),
                });
                append_log(&a, "musicdesk.open late rebuild");
            }
        }
    })
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(desktop)]
#[tauri::command]
fn musicdesk_close(app: AppHandle) -> Result<(), String> {
    // 和歌词窗口一样只隐藏不销毁：销毁后重建走 WebView2 重建设路，容易卡
    if let Some(w) = app.get_webview_window("musicdesk") {
        let _ = w.hide();
    }
    Ok(())
}

#[cfg(desktop)]
#[tauri::command]
fn musicdesk_visible(app: AppHandle) -> bool {
    app.get_webview_window("musicdesk")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false)
}

/// 切换层级：`bottom` 嵌壁纸 / `top` 浮在最上面
#[cfg(desktop)]
#[tauri::command]
fn musicdesk_set_layer(app: AppHandle, layer: String) -> Result<(), String> {
    let a = app.clone();
    app.run_on_main_thread(move || apply_desk_layer(&a, &layer))
        .map_err(|e| e.to_string())?;
    Ok(())
}


#[cfg(desktop)]
#[tauri::command]
fn hide_main(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.state::<QuitFlag>().0.store(true, Ordering::SeqCst);
    #[cfg(desktop)]
    save_main_geo(&app, true);
    app.exit(0);
}

/* ------------------------------------------------------------------ */
/* 托盘：自绘菜单窗口                                                  */
/* ------------------------------------------------------------------ */

/// 托盘菜单窗口的几何信息。
/// 内容是前端按主题排出来的，尺寸只有前端量得准；DPR 也必须由前端报——
/// Windows 上逻辑尺寸不等于物理像素，窗口要按物理像素开才不会糊 / 被裁。
pub struct TrayGeom(pub Mutex<(f64, f64, f64)>);

impl Default for TrayGeom {
    fn default() -> Self {
        Self(Mutex::new((272.0, 320.0, 1.0)))
    }
}

/// 菜单弹出时刻：刚显示时收到的 Focused(false) 可能是系统的瞬态，不能立刻收起
pub struct TrayShownAt(pub Mutex<Option<Instant>>);

impl Default for TrayShownAt {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

/// 「正在播放」的展示信息：标题 / 歌手 / 封面只有前端知道（Rust 侧只有文件路径）
#[derive(Default, Clone)]
pub struct NowMeta {
    pub title: String,
    pub artist: String,
    pub cover: String,
    pub index: i64,
    pub total: i64,
}

pub struct NowMetaState(pub Mutex<NowMeta>);

impl Default for NowMetaState {
    fn default() -> Self {
        Self(Mutex::new(NowMeta::default()))
    }
}

#[derive(serde::Serialize)]
struct TrayState {
    playing: bool,
    position: f64,
    duration: f64,
    title: String,
    artist: String,
    cover: String,
    index: i64,
    total: i64,
    lyrics: bool,
    locked: bool,
}

/// 前端「伪最大化」：不用系统 zoom，由前端按工作区摆窗口，这里只记状态。
/// 存档沿用上一次正常态的尺寸，还原时才能回到用户原来的大小。
#[cfg(desktop)]
#[tauri::command]
fn window_max_hint(app: AppHandle, v: bool) {
    if let Some(st) = app.try_state::<WindowGeo>() {
        if let Ok(mut h) = st.max_hint.lock() {
            *h = v;
        }
    }
    save_main_geo(&app, true);
}

/// 还原时的目标几何：优先用前端 drag 时记下的，没有就回存档里的正常态尺寸
#[cfg(desktop)]
#[tauri::command]
fn main_geo(app: AppHandle) -> (i32, i32, u32, u32) {
    read_main_geo(&app)
        .map(|(x, y, w, h, _)| (x, y, w, h))
        .unwrap_or((0, 0, 1180, 760))
}

#[tauri::command]
fn now_meta_set(app: AppHandle, title: String, artist: String, cover: String, index: i64, total: i64) {
    if let Some(st) = app.try_state::<NowMetaState>() {
        if let Ok(mut m) = st.0.lock() {
            *m = NowMeta { title, artist, cover, index, total };
        }
    }
}

#[cfg(desktop)]
#[tauri::command]
fn tray_state(app: AppHandle) -> TrayState {
    let snap = app.try_state::<Player>().map(|p| p.snapshot());
    let meta = app
        .try_state::<NowMetaState>()
        .and_then(|st| st.0.lock().ok().map(|m| m.clone()))
        .unwrap_or_default();
    let lyrics = app
        .get_webview_window("lyrics")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    let locked = app
        .try_state::<LyricsState>()
        .map(|s| s.locked.load(Ordering::SeqCst))
        .unwrap_or(false);
    TrayState {
        playing: snap.as_ref().map(|s| s.playing).unwrap_or(false),
        position: snap.as_ref().map(|s| s.position).unwrap_or(0.0),
        duration: snap.as_ref().map(|s| s.duration).unwrap_or(0.0),
        title: meta.title,
        artist: meta.artist,
        cover: meta.cover,
        index: meta.index,
        total: meta.total,
        lyrics,
        locked,
    }
}

/// 前端量完内容尺寸后回报：窗口立刻跟着贴紧内容（多一像素都会露白边）
#[cfg(desktop)]
#[tauri::command]
fn tray_fit(app: AppHandle, w: f64, h: f64, dpr: f64) {
    let dpr = if dpr > 0.5 { dpr } else { 1.0 };
    if w < 60.0 || h < 60.0 {
        return;
    }
    if let Some(st) = app.try_state::<TrayGeom>() {
        if let Ok(mut g) = st.0.lock() {
            *g = (w, h, dpr);
        }
    }
    if let Some(win) = app.get_webview_window("tray") {
        let _ = win.set_size(tauri::PhysicalSize::new(
            (w * dpr).round() as u32,
            (h * dpr).round() as u32,
        ));
    }
}

#[cfg(desktop)]
#[tauri::command]
fn tray_hide(app: AppHandle) {
    if let Some(w) = app.get_webview_window("tray") {
        let _ = w.hide();
    }
}

#[cfg(desktop)]
#[tauri::command]
fn tray_action(app: AppHandle, id: String) {
    // 跳页/退出这类「一次性的动作」菜单直接收起；播放/歌词这类开关留在原地——
    // 点一下就整个消失的话，用户根本没法确认刚才那下有没有生效（反复被当成 bug 报）。
    let closes = matches!(id.as_str(), "show" | "settings" | "hide" | "quit");
    if closes {
        if let Some(w) = app.get_webview_window("tray") {
            let _ = w.hide();
        }
    }
    do_tray_action(&app, &id);
}

/// 托盘菜单窗口：透明、无边框、置顶、不进任务栏
#[cfg(desktop)]
fn build_tray_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(w) = app.get_webview_window("tray") {
        return Ok(w);
    }
    WebviewWindowBuilder::new(app, "tray", WebviewUrl::App("tray.html".into()))
        .title("疏音 · 菜单")
        .inner_size(272.0, 320.0)
        .additional_browser_args(browser_args())
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .visible(false)
        .build()
        .map_err(|e| format!("创建托盘菜单窗口失败：{e}"))
}

/// 在光标处弹出菜单。
/// 托盘一般在屏幕右下，所以默认「贴在光标左上」往上长；碰到显示器边缘再夹回来。
#[cfg(desktop)]
fn show_tray_menu(app: &AppHandle, at: Option<(f64, f64)>) {
    let a = app.clone();
    let _ = app.run_on_main_thread(move || {
        let win = match build_tray_window(&a) {
            Ok(w) => w,
            Err(e) => {
                append_log(&a, &format!("tray.menu fail {e}"));
                return;
            }
        };
        let (w, h, dpr) = a
            .try_state::<TrayGeom>()
            .and_then(|s| s.0.lock().ok().map(|g| *g))
            .unwrap_or((272.0, 320.0, 1.0));
        let pw = (w * dpr).round() as i32;
        let ph = (h * dpr).round() as i32;
        let _ = win.set_size(tauri::PhysicalSize::new(pw.max(1) as u32, ph.max(1) as u32));

        let cursor = at.or_else(|| win.cursor_position().ok().map(|p| (p.x, p.y)));
        // 先显示再摆位置：隐藏窗口上的 set_position 会被随后的 show 覆盖掉
        let _ = win.show();
        if let Some((cx, cy)) = cursor {
            let mon = a
                .monitor_from_point(cx, cy)
                .ok()
                .flatten()
                .or_else(|| win.current_monitor().ok().flatten());
            /*
             * 两个平台方向相反，不能共用一套：
             *   Windows 托盘在屏幕右下角，面板要「贴光标往左上长」；
             *   macOS 在顶部菜单栏，必须「往下长」——照 Windows 那套算出来的
             *   y 是负数，窗口整个跑到屏幕外，再被边缘夹取顶到菜单栏上，
             *   把状态栏盖住。
             */
            #[cfg(target_os = "macos")]
            let (mut x, mut y) = (cx.round() as i32 - pw / 2, cy.round() as i32 + 6);
            #[cfg(not(target_os = "macos"))]
            let (mut x, mut y) = (cx.round() as i32 - pw + 10, cy.round() as i32 - ph - 10);
            if let Some(m) = mon {
                let left = m.position().x;
                let top = m.position().y;
                let right = left + m.size().width as i32;
                let bottom = top + m.size().height as i32;
                x = x.max(left + 4).min(right - pw - 4);
                y = y.max(top + 4).min(bottom - ph - 4);
            }
            let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
            append_log(
                &a,
                &format!("tray.menu at {x},{y} size {pw}x{ph} cursor {cx},{cy}"),
            );
        }

        if let Some(st) = a.try_state::<TrayShownAt>() {
            if let Ok(mut t) = st.0.lock() {
                *t = Some(Instant::now());
            }
        }
        let _ = win.set_focus();
        let _ = win.emit("tray://show", ());
    });
}

#[cfg(desktop)]
fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    // 不再挂 menu：Windows 原生菜单是系统画的，样式无法统一。
    // 右击由下面的事件接住，改弹自绘窗口。
    let mut builder = TrayIconBuilder::with_id("shuyin-tray")
        .tooltip("疏音 · 本地音乐")
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } => show_main_window(tray.app_handle()),
            TrayIconEvent::Click {
                button: MouseButton::Right,
                button_state: MouseButtonState::Up,
                position,
                ..
            } => show_tray_menu(tray.app_handle(), Some((position.x, position.y))),
            _ => {}
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    append_log(app, "tray.ready");
    Ok(())
}

/// 菜单动作的统一入口：原生菜单和自绘菜单都走这里
#[cfg(desktop)]
fn do_tray_action(app: &AppHandle, id: &str) {
    append_log(app, &format!("tray.action {id}"));
    match id {
        "show" => show_main_window(app),
        "hide" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.hide();
            }
        }
        // 播放/暂停直接在 Rust 侧执行：不依赖主窗口前端是否在跑
        "playpause" => {
            if let Some(p) = app.try_state::<Player>() {
                let s = p.snapshot();
                /* 判断「有没有歌」必须把在线曲目算上。
                 *
                 * `snapshot.track_path` 对在线曲目恒为 None（值在 `track_url` 里，前端靠它区分
                 * 本地/在线）。以前只判 track_path → **播在线歌时托盘按钮完全没反应**，
                 * 而在线正是最常用的情况。
                 */
                let has = s
                    .track_path
                    .as_deref()
                    .map(|t| !t.is_empty())
                    .unwrap_or(false)
                    || s.track_url.as_deref().map(|t| !t.is_empty()).unwrap_or(false);
                if has {
                    let to_pause = s.playing;
                    if to_pause {
                        p.pause();
                    } else {
                        p.resume();
                    }
                    append_log(
                        app,
                        &format!("tray.playpause {} (was {})", if to_pause { "pause" } else { "resume" }, s.playing),
                    );
                } else {
                    append_log(app, "tray.playpause ignored: no track");
                }
            }
        }
        // 上一首 / 下一首需要播放队列，队列在前端，所以走事件
        "prev" => {
            let _ = app.emit("tray://action", serde_json::json!({ "action": "prev" }));
        }
        "next" => {
            let _ = app.emit("tray://action", serde_json::json!({ "action": "next" }));
        }
        "volup" | "voldown" => {
            if let Some(p) = app.try_state::<Player>() {
                let cur = p.snapshot().volume as f32;
                let step = if id == "volup" { 0.08 } else { -0.08 };
                p.set_volume((cur + step).clamp(0.0, 1.0));
            }
        }
        "lyrics" => {
            let _ = app.emit("tray://action", serde_json::json!({ "action": "lyrics" }));
        }
        "locklyrics" => {
            // 锁定后窗口收不到鼠标事件，所以解锁入口必须留在托盘
            let next = app
                .try_state::<LyricsState>()
                .map(|s| !s.locked.load(Ordering::SeqCst))
                .unwrap_or(false);
            if let Some(st) = app.try_state::<LyricsState>() {
                st.locked.store(next, Ordering::SeqCst);
            }
            if let Some(w) = app.get_webview_window("lyrics") {
                let _ = w.set_ignore_cursor_events(next);
            }
            let _ = app.emit(
                "lyrics://action",
                serde_json::json!({ "action": "lock", "locked": next }),
            );
        }
        "settings" => {
            show_main_window(app);
            let _ = app.emit("tray://action", serde_json::json!({ "action": "settings" }));
        }
        /* 音乐锁屏：托盘菜单是最顺手的入口（用户在桌面上时右键就能进）。
           走的是和快捷键 / 设置页「进入」完全同一条路——`desk_lock_show` 只显示
           独立的锁屏窗口（musiclock），不碰音乐桌面，然后广播 desk://autolock。 */
        "musiclock" => {
            let a = app.clone();
            let _ = app.run_on_main_thread(move || desk_lock_show(&a));
        }
        "quit" => {
            app.state::<QuitFlag>().0.store(true, Ordering::SeqCst);
            app.exit(0);
        }
        _ => {}
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .manage(QuitFlag(AtomicBool::new(false)))
        .manage(LyricsState::default())
        .manage(Boot::default())
        .manage(WindowGeo::default())
        .manage(TrayGeom::default())
        .manage(TrayShownAt::default())
        .manage(NowMetaState::default());

    /* 单实例是桌面概念：iOS 上重复启动由系统管理，插件也没有移动端实现 */
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            append_log(app, "single.instance 第二次启动，唤起主窗口");
            show_main_window(app);
        }));

    let builder = builder
        .setup(|app| {
            // Rust 侧 panic 也落日志：否则崩溃时只剩一个空窗口，无从查起
            let handle_for_panic = app.handle().clone();
            std::panic::set_hook(Box::new(move |info| {
                let msg = format!("PANIC {info}");
                eprintln!("{msg}");
                append_log(&handle_for_panic, &msg);
            }));
            append_log(app.handle(), "app.start");

            /*
             * iOS 冷启动「用疏音打开」：URL 是 `ios_openurl` 的观察者收着的
             * （它注册在 UIApplicationMain 之前，那时还没有 AppHandle），
             * 到这里才有 handle 能落盘。`take_open_file` 里还会兜一次。
             */
            #[cfg(target_os = "ios")]
            flush_cold_open(app.handle());

            /* 灵动岛 / 锁屏实时活动（仅 iOS 有实际动作）。
             * 放在这里是为了尽早接管上次残留的那条 activity——否则 App
             * 重启后锁屏会同时挂着新旧两条。 */
            liveactivity::init(app.handle());

            /*
             * iOS 的系统媒体会话：音频会话 + 锁屏「正在播放」卡片 + 远控命令。
             *
             * 必须赶在第一次播放之前配好——AVAudioSession 不设成 playback，
             * 熄屏/切后台时系统会直接把音频掐掉（cpal 的 iOS host 从不碰
             * 这套 API），静音拨片也会把声音吃掉。
             *
             * 桌面（Windows/macOS）不在这里：那两端的初始化要等主窗口建好
             * 之后再做（Windows 要 HWND），见下面建窗成功的分支。
             */
            #[cfg(target_os = "ios")]
            {
                match crate::smtc::init(app.handle(), 0) {
                    Ok(()) => append_log(app.handle(), "smtc ok (ios)"),
                    Err(e) => append_log(app.handle(), &format!("smtc fail (ios) {e}")),
                }
            }

            /* ---- 桌面专属：主窗口 / 无边框修饰 / 媒体会话 / 白屏看门狗 ----
             * 移动端（iOS）的 webview 由生成的 Swift 壳提供，不在这里建窗。 */
            #[cfg(desktop)]
            {
            append_log(app.handle(), &format!("browser.args {}", browser_args()));

            // 主窗口在代码里建：WebView2 启动参数要按机器情况动态决定，
            // 而且必须和桌面歌词窗口用同一串参数（否则 WebView2 会另起一套环境）
            let main = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("疏音")
                .inner_size(1180.0, 760.0)
                /*
                 * 最小尺寸。
                 *
                 * 以前是 480×400 —— 窗口能拉到手机那么大，然后播放页的两列（封面 + 歌词）、
                 * 播放条的三个分区、侧栏的图标全都挤在一起重叠。与其在每个组件里塞一堆断点补丁，
                 * 不如直接声明「这个应用最小就要这么宽」。
                 *
                 * 1024×640 还不够（用户反馈「限制了但还是会乱」）：播放页两列在 1024 下
                 * 右列只剩 400 出头，标题会被省略号截断、工具带换行。现在 1120×680：
                 *   · 1120 - 侧栏 240 - 左右 padding 56 = 824，两列 300 + 44 + 480，歌词能正常折行；
                 *   · 680 保证「封面 290 + 进度 + 控制 + 工具带」一屏放得下，不用滚。
                 * 1366×768 的笔记本工作区约 728 高，680 装得下。
                 */
                .min_inner_size(1120.0, 680.0)
                .center()
                // 无系统边框：最小化/最大化/关闭由前端自绘（TitleBar.tsx），
                // 否则标题栏是 Windows 原生的灰色块，跟应用内样式完全两个世界
                .decorations(false)
                .additional_browser_args(browser_args())
                .build();
            match main {
                Ok(_) => {
                    append_log(app.handle(), "window.main ok");
                    if let Some(w) = app.get_webview_window("main") {
                        decorate_frameless(&w);
                        install_max_fix(&w);
                        // macOS：触控板双指缩放和手机上的捏合是同一类误触
                        #[cfg(target_os = "macos")]
                        disable_zoom(&w);
                        /*
                         * 系统媒体会话：耳机线控（含蓝牙 AVRCP）与键盘媒体键的**唯一**可靠入口。
                         * Windows = SMTC（绑窗口 HWND）；macOS = Now Playing（进程级，不需要 HWND）。
                         * 失败不能影响启动——顶多是耳机按键不响应，窗口照常用。
                         */
                        #[cfg(target_os = "windows")]
                        {
                            let hwnd = w.hwnd().ok().map(|h| h.0 as isize).unwrap_or(0);
                            match crate::smtc::init(app.handle(), hwnd) {
                                Ok(()) => append_log(app.handle(), "smtc ok"),
                                Err(e) => append_log(app.handle(), &format!("smtc fail {e}")),
                            }
                        }
                        #[cfg(target_os = "macos")]
                        {
                            match crate::smtc::init(app.handle(), 0) {
                                Ok(()) => append_log(app.handle(), "smtc ok"),
                                Err(e) => append_log(app.handle(), &format!("smtc fail {e}")),
                            }
                        }
                    }
                    restore_main_geo(app.handle());
                }
                Err(e) => {
                    append_log(app.handle(), &format!("window.main fail {e}"));
                    return Err(Box::<dyn std::error::Error>::from(e.to_string()));
                }
            }

            // 白屏看门狗：9 秒还没画出界面，先记一笔，再尝试一次软件渲染
            let watchdog = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(9000));
                if watchdog.state::<Boot>().ok.load(Ordering::SeqCst) {
                    return;
                }
                append_log(&watchdog, "boot.stall 9 秒内未完成绘制");
                if gpu_off() {
                    append_log(&watchdog, "boot.stalled 软件渲染仍未绘制，详见图示日志与 gpu-off 标记");
                    return;
                }
                if let Some(marker) = gpu_off_marker() {
                    if let Some(dir) = marker.parent() {
                        let _ = std::fs::create_dir_all(dir);
                    }
                    let _ = std::fs::write(&marker, "1");
                    append_log(&watchdog, "boot.retry 改用软件渲染重启一次");
                    watchdog.restart();
                }
            });
            } // #[cfg(desktop)] 主窗口段结束

            // 先把后端状态装好，再建第二个 webview：
            // 歌词窗口一加载就会 invoke set_volume / lyrics_is_locked，
            // 如果 Player 还没 manage，前端会收到 "state not managed" 报错。
            let db = crate::db::init_db(app.handle())?;
            app.manage(db);

            let player = crate::player::Player::new()?;
            app.manage(player);
            // 音频线程没有 AppHandle，日志路径从这儿注入（打包版 stderr 看不到）
            crate::player::set_log_path(log_path(app.handle()));
            /* 曲终自动接下一首要顺手更新系统媒体卡片（锁屏/控制中心），那边要 AppHandle */
            crate::player::attach_app(app.handle().clone());

            /* ---- 移动端（iOS）：**必须**在这里显式建窗 ----
             *
             * tauri.conf.json 的 `app.windows` 是空数组（桌面主窗口也在下面的代码里
             * 建，配置驱动的那扇窗会和它撞 label），而 tauri 的 mobile 启动路径
             * **不会**从空配置里自动造 webview —— 结果就是：App 起来了、进程活着、
             * 日志正常，但 WKWebView 从来没实例化，用户看到纯黑一屏
             * （2026-11-22 iPhone 实测：签名装好后打开全黑，啥也没有）。
             *
             * 移动端 builder 不暴露 inner_size / center / decorations /
             * additional_browser_args 这些桌面专属方法（调了编译不过），这里只给 URL。
             * 放在 manage(db/player) 之后：前端一加载就会 invoke，后端状态必须先就位。
             */
            #[cfg(mobile)]
            {
                match WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    /*
                     * 底色必须给：wry 在 iOS 上若不指定 background_color，会把 WKWebView
                     * 的底色设成 `UIColor.systemBackgroundColor()`（浅色模式下就是**白**），
                     * 同时 `setOpaque(false)`。页面一旦没铺满（安全区、启动瞬间、
                     * 键盘弹出），露出来的就是这块白 —— 用户看到的就是上下两条白边。
                     * 给成应用底色（#0A0B0F）之后，没铺满的地方也是同一块黑。
                     */
                    .background_color(tauri::window::Color(10, 11, 15, 255))
                    .build()
                {
                    Ok(w) => {
                        append_log(app.handle(), "window.main ok (mobile)");
                        /* 双指缩放是浏览器行为，App 里全是误触（用户原话：
                         * 「双指外滑页面会被放大或者捏合可以缩小，就像浏览器一样」）。
                         * 窗一建好就把它钉死，别等用户先放大一次。 */
                        #[cfg(target_os = "ios")]
                        disable_zoom(&w);
                    }
                    Err(e) => append_log(app.handle(), &format!("window.main fail (mobile) {e}")),
                }
            }

            // 桌面歌词 / 托盘 / 桌面 / 锁屏窗口：全是桌面专属（移动端没有这些窗口）
            #[cfg(desktop)]
            {
            // 桌面歌词窗口一次性预建好（隐藏），之后只做 show/hide：
            // WebView2 的第二个 webview 在 IPC 线程里建会卡死在环境创建上，
            // 启动阶段建则没有问题，顺带让「打开歌词」秒出。
            match build_lyrics_window(app.handle()) {
                Ok(w) => {
                    let _ = w.hide();
                    append_log(app.handle(), "window.lyrics preload ok");
                }
                Err(e) => append_log(app.handle(), &format!("window.lyrics preload fail {e}")),
            }

            // 托盘菜单窗口同样预建：右击托盘要立刻出画面，现建会先闪一下空白
            match build_tray_window(app.handle()) {
                Ok(w) => {
                    let _ = w.hide();
                    append_log(app.handle(), "window.tray preload ok");
                }
                Err(e) => append_log(app.handle(), &format!("window.tray preload fail {e}")),
            }

            // 音乐桌面窗口同样预建（隐藏，铺满主屏）。
            // 它比歌词窗更严重：在 IPC 线程 / 主线程回调里同步 build 会**卡死整个应用**
            // （WebView2 环境创建回调需要主线程消息泵，v0.5.5 实测 invoke 12s 不返回、
            // 之后所有点击全没反应）。setup 阶段建则没有问题。
            match build_desk_window(app.handle()) {
                Ok(w) => {
                    let _ = w.hide();
                    append_log(app.handle(), "window.desk preload ok");
                }
                Err(e) => append_log(app.handle(), &format!("window.desk preload fail {e}")),
            }

            // 音乐锁屏窗口也是独立预建窗（和音乐桌面互不干扰），
            // 快捷键 / 托盘点下去要立刻出画面，不能现建。
            match build_lock_window(app.handle()) {
                Ok(w) => {
                    let _ = w.hide();
                    append_log(app.handle(), "window.lock preload ok");
                }
                Err(e) => append_log(app.handle(), &format!("window.lock preload fail {e}")),
            }

            // 状态广播线程：250ms 推送一次快照（ended 为一次性标记）
            // 顺带在曲目/播放态变化时刷新托盘菜单文案
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                loop {
                    let snap = match handle.try_state::<Player>() {
                        Some(p) => p.snapshot(),
                        None => break,
                    };
                    let _ = handle.emit("player://state", &snap);

                    std::thread::sleep(std::time::Duration::from_millis(250));
                }
            });

            // 调试钩子：SHUYIN_TRAY_DEMO="x,y" 启动后自动在指定屏幕坐标弹出托盘菜单，
            // 方便在没有真实鼠标操作的环境里核对样式（正常启动不会触发）
            if let Ok(v) = std::env::var("SHUYIN_TRAY_DEMO") {
                let h = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(2600));
                    let mut xy = (1400.0_f64, 900.0_f64);
                    if let Some((a, b)) = v.split_once(',') {
                        if let (Ok(x), Ok(y)) = (a.trim().parse::<f64>(), b.trim().parse::<f64>()) {
                            xy = (x, y);
                        }
                    }
                    show_tray_menu(&h, Some(xy));
                });
            }

            // 托盘失败不应阻断启动（部分精简版系统没有通知区域）
            if let Err(e) = setup_tray(app.handle()) {
                eprintln!("托盘图标初始化失败：{e}");
            }
            } // #[cfg(desktop)] 窗口/托盘段结束

            Ok(())
        });
    /* 窗口事件全是桌面概念（托盘菜单失焦、位置记忆、关闭收进托盘）——移动端没有窗口体系 */
    #[cfg(desktop)]
    let builder = builder.on_window_event(|window, event| {
            // 托盘菜单：点到别处（失焦）就收起；刚弹出的一瞬间的失焦事件忽略
            if window.label() == "tray" {
                match event {
                    tauri::WindowEvent::Focused(false) => {
                        let fresh = window
                            .app_handle()
                            .try_state::<TrayShownAt>()
                            .and_then(|s| s.0.lock().ok().and_then(|t| *t))
                            .map(|t| t.elapsed() < Duration::from_millis(260))
                            .unwrap_or(false);
                        if !fresh {
                            let _ = window.hide();
                        }
                    }
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                    _ => {}
                }
                return;
            }
            // 主窗口：记住位置与大小（拖动/缩放很密，内部做了节流）
            if window.label() == "main" {
                match event {
                    tauri::WindowEvent::Resized(_) => {
                        /* 最小化 / 从任务栏还原：见 WindowGeo::was_max 的注释。
                           最小化那一帧记下 zoom 态；还原后发现 zoom 丢了就补一次 maximize，
                           否则窗口会比最大化小一圈，用户还得手动再点一次。 */
                        if let Some(st) = window.app_handle().try_state::<WindowGeo>() {
                            let min = window.is_minimized().unwrap_or(false);
                            let max = window.is_maximized().unwrap_or(false);
                            let prev_min = st.was_min.lock().map(|mut g| {
                                let v = *g;
                                *g = min;
                                v
                            }).unwrap_or(false);
                            if min {
                                if let Ok(mut g) = st.was_max.lock() {
                                    *g = max;
                                }
                            } else if prev_min && !max {
                                // 只处理「最小化 → 还原」这一条路径：
                                // 用户自己点还原（窗口一直可见）时 prev_min 是 false，不会被这里抢回去
                                let was = st.was_max.lock().map(|g| *g).unwrap_or(false);
                                if was {
                                    let w = window.clone();
                                    std::thread::spawn(move || {
                                        std::thread::sleep(Duration::from_millis(90));
                                        if !w.is_minimized().unwrap_or(false)
                                            && !w.is_maximized().unwrap_or(false)
                                        {
                                            let _ = w.maximize();
                                        }
                                    });
                                }
                            }
                        }
                        save_main_geo(window.app_handle(), false)
                    }
                    tauri::WindowEvent::Moved(_) => save_main_geo(window.app_handle(), false),
                    _ => {}
                }
            }
            // 桌面歌词被拖动：记住位置，下次打开还在原地
            if window.label() == "lyrics" {
                if let tauri::WindowEvent::Moved(pos) = event {
                    save_lyrics_pos(window.app_handle(), pos.x, pos.y);
                }
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != "main" {
                    return;
                }
                save_main_geo(window.app_handle(), true);
                let app = window.app_handle();
                let quitting = app
                    .try_state::<QuitFlag>()
                    .map(|f| f.0.load(Ordering::SeqCst))
                    .unwrap_or(false);
                if !quitting {
                    // 主窗口关闭 = 收进右下角托盘，音频继续播放
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        });

    let app = builder
        .invoke_handler(tauri::generate_handler![
            check_update,
            app_version,
            open_url,
            scan_music,
            get_tracks,
            get_track_count,
            get_lyrics,
            remove_track,
            pick_music_folder,
            pick_playlist_file,
            read_text_abs,
            read_bin_abs,
            write_text_abs,
            pick_save_file,
            hotkeys_apply,
            hotkeys_clear,
            player_state,
            next_prefetch,
            play_file,
            play_url,
            net_request,
            smtc_update,
            liveactivity::live_activity_sync,
            liveactivity::live_activity_end,
            liveactivity::lyric_timeline,
            read_cover_data_url,
            update_dmg_install,
            probe_audio_url,
            local_audio_duration,
            local_audio_tags,
            sources_default_dir,
            downloads_dir,
            download_track,
            download_progress,
            cache_lookup,
            cache_slot,
            cache_drop,
            cache_size,
            cache_clear,
            cache_dir,
            cache_set_dir,
            save_lyrics_file,
            list_source_scripts,
            import_source_files,
            import_source_text,
            import_source_url,
            import_source_staged,
            take_open_file,
            delete_source_script,
            pause,
            resume,
            stop,
            seek,
            set_volume,
            set_fx,
            spectrum,
            cover_abs_path,
            diag_log,
            boot_ok,
            #[cfg(desktop)]
            apply_min_size,
            #[cfg(desktop)]
            lyrics_open,
            #[cfg(desktop)]
            lyrics_hide,
            #[cfg(desktop)]
            lyrics_close,
            #[cfg(desktop)]
            lyrics_visible,
            #[cfg(desktop)]
            lyrics_set_locked,
            #[cfg(desktop)]
            lyrics_is_locked,
            #[cfg(desktop)]
            musicdesk_open,
            #[cfg(desktop)]
            musicdesk_close,
            #[cfg(desktop)]
            musicdesk_visible,
            #[cfg(desktop)]
            musicdesk_set_layer,
            #[cfg(desktop)]
            desk_lock_enter,
            #[cfg(desktop)]
            desk_lock_exit,
            platform_login,
            #[cfg(desktop)]
            show_main,
            #[cfg(desktop)]
            hide_main,
            quit_app,
            #[cfg(desktop)]
            window_max_hint,
            #[cfg(desktop)]
            main_geo,
            now_meta_set,
            #[cfg(desktop)]
            tray_state,
            #[cfg(desktop)]
            tray_fit,
            #[cfg(desktop)]
            tray_hide,
            #[cfg(desktop)]
            tray_action,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    /*
     * 用 `build()` + `run(callback)` 而不是 `run(context)`：后者等价于
     * 「build 之后空回调」，换成带回调的版本不改变任何现有行为，
     * 只是给 Apple 平台留一个接收「用疏音打开」的入口。
     */
    /*
     * iOS 冷启动打开文件的 URL 只出现在 launchOptions / UISceneConnectionOptions
     * 里，tao 这两处都不读（见 ios_openurl.rs 顶部那张表）。
     * 观察者必须赶在 `UIApplicationMain` 之前挂上——而它在下面这行内部才被调用。
     */
    #[cfg(target_os = "ios")]
    ios_openurl::install();

    app.run(|app_handle, event| on_run_event(app_handle, event));
}
