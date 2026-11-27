//! iOS 媒体相关的原生桥接：系统「正在播放」卡对账 + 桌面歌词心跳 + 歌词时间轴。
//!
//! 这里只留三件必须原生做的事：
//!   · `spawn_state_ticker`：曲终 / 暂停 / 接不上这些前端 JS 冻着时也发生的动作，
//!     由原生直接刷新系统媒体卡（MPNowPlayingInfoCenter）；
//!   · `lyric_timeline` + `spawn_pip_ticker`：整首歌词时间轴由原生按播放位置算
//!     当前句与句内进度，喂给画中画（桌面歌词）；
//!   · `shuyin_remote_command`：画中画窗口上的播放/切歌键与关窗通知。
//!
//! Swift 侧对应 `ios/ShuyinLyricsPiP.swift`。跨 Rust↔Swift 一律 dlsym
//! （静态 `extern "C"` 会在 cargo 阶段就因 Swift .o 还没生成而链接失败）。

use std::sync::OnceLock;
use tauri::AppHandle;

#[cfg(target_os = "ios")]
use tauri::Manager;

#[cfg(target_os = "ios")]
use crate::player::Player;

/// 全局 AppHandle：Swift 侧的 C 回调没有上下文可传，只能从这里取。
static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
    #[cfg(target_os = "ios")]
    {
        /* 取一次地址让链接器看见（CI 会校验这些符号都在），不能只靠 dlsym。 */
        let _keep = shuyin_remote_command as *const ();
        std::hint::black_box(_keep);
        /* 启动即申请通知授权：系统媒体卡与桌面歌词都属通知体系，首次「允许通知」正常。 */
        ffi::notif_bootstrap();
        /* 点亮 ShuyinLyricsPiP.swift 的 C 入口，防 -dead_strip 剥掉符号。 */
        crate::lyrics_pip::adopt();
        /* 点亮 ShuyinIsland.swift（灵动岛）的 C 入口，同理。 */
        crate::island::adopt();
        /* 系统卡状态对账 + 桌面歌词心跳。 */
        spawn_state_ticker();
        spawn_pip_ticker();
        spawn_island_ticker();
    }
}

/* ------------------------------------------------------------------ */
/* 歌词时间轴（原生按播放位置算当前句）                                */
/* ------------------------------------------------------------------ */

/// 一整首歌的歌词时间轴（秒, 文本），换歌时整表替换。
///
/// App 进后台后 WebView 的 JS 会被冻住，桌面歌词要显示的那一句得由原生自己算。
#[cfg(target_os = "ios")]
static LYRICS: std::sync::Mutex<(Vec<f64>, Vec<String>)> =
    std::sync::Mutex::new((Vec::new(), Vec::new()));

/// 一条歌词。字段与安卓 `lyric_timeline` 那条命令一致（`t` 秒 / `x` 文本）。
#[derive(serde::Deserialize)]
pub struct LyricLine {
    #[serde(default)]
    pub t: f64,
    #[serde(default)]
    pub x: String,
}

/// 前端把整首歌词的时间轴交过来（换歌时还会先发一条空表清场）。
#[tauri::command]
pub fn lyric_timeline(lines: Vec<LyricLine>) {
    #[cfg(not(target_os = "ios"))]
    {
        let _ = lines;
    }
    #[cfg(target_os = "ios")]
    {
        let mut ts = Vec::with_capacity(lines.len());
        let mut xs = Vec::with_capacity(lines.len());
        for l in lines {
            if l.x.is_empty() {
                continue;
            }
            ts.push(l.t);
            xs.push(l.x);
        }
        if let Ok(mut g) = LYRICS.lock() {
            *g = (ts, xs);
        }
    }
}

/// 当前句 + 句内进度（0~1）。画中画的字幕要按进度逐字染色。
#[cfg(target_os = "ios")]
fn line_progress_at(pos: f64) -> (String, f64) {
    let Ok(g) = LYRICS.lock() else { return (String::new(), 0.0) };
    let (ts, xs) = &*g;
    if ts.is_empty() {
        return (String::new(), 0.0);
    }
    let mut lo = 0usize;
    let mut hi = ts.len();
    while lo < hi {
        let mid = (lo + hi) / 2;
        if ts[mid] <= pos {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    if lo == 0 {
        return (String::new(), 0.0);
    }
    let start = ts[lo - 1];
    let end = ts.get(lo).copied().unwrap_or(start + 4.0);
    let prog = if end > start {
        ((pos - start) / (end - start)).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let mut text = xs[lo - 1].clone();
    if text.chars().count() > 60 {
        text = text.chars().take(60).collect();
    }
    (text, prog)
}

/// 桌面歌词（画中画）的心跳：120ms 一帧驱动句内进度跑马灯。
/// 只在开关打开时才真正走到 IPC。
#[cfg(target_os = "ios")]
pub fn spawn_pip_ticker() {
    std::thread::spawn(|| loop {
        std::thread::sleep(std::time::Duration::from_millis(120));
        if !crate::lyrics_pip::on() {
            continue;
        }
        let Some(app) = APP.get() else { continue };
        let Some(p) = app.try_state::<Player>() else { continue };
        /*
         * state_lite 的时长：画中画窗口上那颗键是「播放/暂停」还是「停止」由
         * timeRangeForPlayback 的时长决定——正无穷（直播语义）= 停止键。
         */
        let (_, playing, pos, dur) = p.state_lite();
        let (line, prog) = line_progress_at(pos);
        crate::lyrics_pip::update(&line, prog, playing, dur);
    });
}

/* ------------------------------------------------------------------ */
/* 系统「正在播放」卡状态对账                                          */
/* ------------------------------------------------------------------ */

/// 灵动岛（Live Activity）心跳：500ms 一帧，比画中画慢——胶囊上没有逐字
/// 跑马灯，进度条不用那么密。开关打开才走到 IPC。
///
/// 歌名 / 歌手以系统卡那份为准（`smtc::last_meta`：card_for / smtc_update
/// 都从那里过）。没有曲目（idx<0）时推 playing=false，Swift 侧宽限后
/// end 掉 activity。
#[cfg(target_os = "ios")]
pub fn spawn_island_ticker() {
    std::thread::spawn(|| loop {
        std::thread::sleep(std::time::Duration::from_millis(500));
        if !crate::island::on() {
            continue;
        }
        let Some(app) = APP.get() else { continue };
        let Some(p) = app.try_state::<Player>() else { continue };
        let (idx, playing, pos, dur) = p.state_lite();
        if idx < 0 {
            crate::island::update("", "", pos, false, dur, &[]);
            continue;
        }
        let (title, artist) = crate::smtc::last_meta();

        /*
         * 封面：系统卡那份 cover（网址→coverart 落盘文件）只在**换歌**时读一次
         * 字节过 FFI，其余心跳传空切片（Swift 沿用上一张）。每 500ms 拖几百 KB
         * 过 dlsym 纯属浪费，而且 ContentState 塞大图也吃 update 配额。
         */
        static LAST_ART: std::sync::Mutex<(String, Vec<u8>)> =
            std::sync::Mutex::new((String::new(), Vec::new()));
        let cover = crate::smtc::last_cover();
        let mut art: Vec<u8> = Vec::new();
        let changed = LAST_ART.lock().map(|g| g.0 != cover).unwrap_or(false);
        if !cover.is_empty() && changed {
            let local = if cover.contains("://") {
                crate::coverart::lookup(&cover).map(|c| c.path)
            } else {
                Some(cover.clone())
            };
            if let Some(path) = local {
                if let Ok(bytes) = std::fs::read(&path) {
                    if !bytes.is_empty() && bytes.len() < 4 * 1024 * 1024 {
                        art = bytes;
                    }
                }
            }
            /* 没读到也记下网址：别每 500ms 重试一次文件 IO */
            if let Ok(mut g) = LAST_ART.lock() {
                g.0 = cover.clone();
                if !art.is_empty() {
                    g.1 = art.clone();
                }
            }
        }
        crate::island::update(&title, &artist, pos, playing, dur, &art);
    });
}

/// 原生发现「暂停了 / 歌到底了」就直接刷新系统卡。
///
/// 换歌那一步由 `player::card_for` 推过，这里只管播放态和时长变化：
/// `Cmd::Stop`、曲终接不上、系统中断这些只改 playing 标志的路径，不刷新
/// 锁屏就会一直画着「在播 + 进度条走到头」。
#[cfg(target_os = "ios")]
pub fn spawn_state_ticker() {
    std::thread::spawn(|| {
        let mut last_playing = false;
        let mut last_dur = -1.0f64;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(700));
            let Some(app) = APP.get() else { continue };
            let Some(p) = app.try_state::<Player>() else { continue };
            let (idx, playing, pos, dur) = p.state_lite();
            if idx < 0 {
                last_playing = false;
                last_dur = -1.0;
                continue;
            }
            if playing == last_playing && (dur - last_dur).abs() <= 0.5 {
                continue;
            }
            last_playing = playing;
            last_dur = dur;
            crate::smtc::refresh_state(playing, pos.max(0.0), dur);
        }
    });
}

/* ------------------------------------------------------------------ */
/* 画中画按钮 → 播放器                                                 */
/* ------------------------------------------------------------------ */

/// 处理从 Swift 侧（画中画窗口）发来的命令。
///
/// 播放/暂停直接在 Rust 侧执行（和托盘同一套路数，不依赖前端在跑）；
/// 上一首/下一首要队列，只能发事件让前端做。
#[cfg(target_os = "ios")]
fn handle_remote_command(cmd: &str) {
    use tauri::Emitter;

    let Some(app) = APP.get() else { return };
    match cmd {
        "playpause" => toggle_playback(app),
        "prev" | "next" => {
            let _ = app.emit(
                "hotkey://action",
                serde_json::json!({ "id": cmd, "source": "pip" }),
            );
        }
        /* 用户在画中画窗口按了 ×：通知前端把开关拨回关。 */
        "pipclosed" => {
            let _ = app.emit("pip://state", serde_json::json!({ "on": false }));
        }
        other => {
            crate::append_log(app, &format!("pip.cmd unknown {other}"));
        }
    }
}

#[cfg(target_os = "ios")]
fn toggle_playback(app: &AppHandle) {
    let Some(p) = app.try_state::<Player>() else { return };
    let (_, playing, _, _) = p.state_lite();
    if !p.has_track() {
        crate::append_log(app, "pip.playpause ignored: no track");
        return;
    }
    if playing {
        p.pause();
    } else {
        p.resume();
    }
    crate::append_log(
        app,
        &format!("pip.playpause -> {} (was {})", if playing { "pause" } else { "resume" }, playing),
    );
}

/// Swift 侧画中画用 dlsym 找这个 C 入口（`@_silgen_name` 会导致链接失败）。
#[cfg(target_os = "ios")]
#[no_mangle]
pub extern "C" fn shuyin_remote_command(cmd: *const std::ffi::c_char) {
    if cmd.is_null() {
        return;
    }
    let text = unsafe { std::ffi::CStr::from_ptr(cmd) }.to_string_lossy().to_string();
    handle_remote_command(&text);
}

/* ------------------------------------------------------------------ */
/* 与 Swift 的接线（dlsym）                                            */
/* ------------------------------------------------------------------ */

#[cfg(target_os = "ios")]
mod ffi {
    use std::ffi::{c_char, c_void, CString};

    extern "C" {
        fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    }

    const RTLD_DEFAULT: *mut c_void = -2isize as *mut c_void;

    fn lookup(name: &str) -> *mut c_void {
        let Ok(c) = CString::new(name) else { return std::ptr::null_mut() };
        unsafe { dlsym(RTLD_DEFAULT, c.as_ptr()) }
    }

    /// 启动即申请通知授权（Swift `shuyin_notif_bootstrap`）。
    pub fn notif_bootstrap() {
        type Fn = unsafe extern "C" fn();
        let p = lookup("shuyin_notif_bootstrap");
        if p.is_null() {
            crate::player::log("media dlsym notif_bootstrap: symbol NULL");
            return;
        }
        let f: Fn = unsafe { std::mem::transmute(p) };
        unsafe { f() }
    }
}
