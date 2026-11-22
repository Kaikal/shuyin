//! iOS 灵动岛 / 锁屏实时活动（Live Activity）。
//!
//! 分工：
//!   · 这里只管**两头接线**——把前端推来的播放状态转成 JSON 交给 Swift，
//!     把灵动岛按钮的点击转成播放器动作；
//!   · 真正的 ActivityKit 调用在 `src-tauri/ios/ShuyinLiveActivity.swift`。
//!
//! 为什么中间要过一层 Rust 而不是让前端直连 Swift：
//!   Tauri 的 iOS 侧没有「JS → 任意 Swift 函数」的通道，要么写一个完整的
//!   mobile plugin（多一层没有收益的包装），要么就像现在这样——Rust 命令
//!   收数据，再用 dlsym 找 Swift 导出的 C 符号。后者零依赖、跨版本稳定。
//!
//! 非 iOS 平台整个模块是空转的：命令照常存在（前端不用分平台判断），
//! 只是什么都不做。

use std::sync::OnceLock;
use tauri::AppHandle;

#[cfg(target_os = "ios")]
use tauri::Manager;

#[cfg(target_os = "ios")]
use crate::player::Player;

/// 全局 AppHandle：灵动岛按钮回调是 C 函数（由系统在主 App 进程里调），
/// 没有上下文可传，只能从这里取。
static APP: OnceLock<AppHandle> = OnceLock::new();

/// 一次播放状态的快照，字段名与 Swift 侧的 `ShuyinLive.Payload` 一一对应。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct LiveState {
    pub title: String,
    pub artist: String,
    pub album: String,
    /// 封面缩略图：base64 JPEG，不带 data URI 前缀。
    /// ContentState 有 4KB 上限，前端压到 72×72 再传；空串 = 没有封面。
    #[serde(default)]
    pub art: String,
    pub playing: bool,
    /// 锚点时刻的播放位置（秒）
    pub position: f64,
    /// 整首时长（秒），0 = 未知
    pub duration: f64,
    /// 上面两个值对应的 Unix 时间戳（秒）
    pub anchor: f64,
}

pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
    #[cfg(target_os = "ios")]
    {
        /*
         * Swift 侧是 dlsym 动态查 shuyin_remote_command，静态引用链上看不到它，
         * 链接器的 -dead_strip 有理由认为这个符号没人用。这里取一次地址把它
         * 「点亮」——同一个 object 文件里的引用足以让链接器整个留下。
         */
        let _keep = shuyin_remote_command as *const ();
        std::hint::black_box(_keep);
        ffi::adopt();
    }
}

/// 推送一次播放状态。换歌 / 播放暂停 / 拖动进度时调用。
///
/// 不要拿它当心跳用：进度条由系统自己走秒（`Text(timerInterval:)`），
/// 每秒推一次只会白白消耗 Live Activity 的更新预算。
#[tauri::command]
pub fn live_activity_sync(state: LiveState) -> Result<(), String> {
    #[cfg(not(target_os = "ios"))]
    {
        let _ = state;
        Ok(())
    }
    #[cfg(target_os = "ios")]
    {
        let json = serde_json::to_string(&state).map_err(|e| e.to_string())?;
        ffi::sync(&json);
        Ok(())
    }
}

/// 收摊：队列清空、停止播放、用户关掉开关时调用。
#[tauri::command]
pub fn live_activity_end() -> Result<(), String> {
    #[cfg(target_os = "ios")]
    ffi::end();
    Ok(())
}

/* ------------------------------------------------------------------ */
/* 灵动岛按钮 → 播放器                                                  */
/* ------------------------------------------------------------------ */

/// 处理来自灵动岛 / 锁屏卡片的按钮（Swift 侧 `LiveActivityIntent.perform()` 调）。
#[cfg(target_os = "ios")]
fn handle_remote_command(cmd: &str) {
    use tauri::Emitter;

    let Some(app) = APP.get() else { return };
    match cmd {
        // 播放暂停直接在 Rust 侧执行：和托盘按钮同一套路数，不依赖前端在跑
        "playpause" => toggle_playback(app),
        // 上一首/下一首需要播放队列，队列在前端，只能发事件让它自己做
        "prev" | "next" => {
            let _ = app.emit(
                "hotkey://action",
                serde_json::json!({ "id": cmd, "source": "live" }),
            );
        }
        other => {
            crate::append_log(app, &format!("live.cmd unknown {other}"));
        }
    }
}

#[cfg(target_os = "ios")]
fn toggle_playback(app: &AppHandle) {
    let Some(p) = app.try_state::<Player>() else { return };
    let s = p.snapshot();
    /*
     * 「有没有歌」两个字段都得看：在线曲目的 track_path 恒为 None，
     * 值在 track_url 里。只判前者会让播在线歌时按钮完全没反应
     * （这个坑托盘那边已经踩过一次，见 do_tray_action 的注释）。
     */
    let has = s
        .track_path
        .as_deref()
        .map(|t| !t.is_empty())
        .unwrap_or(false)
        || s.track_url.as_deref().map(|t| !t.is_empty()).unwrap_or(false);
    if !has {
        crate::append_log(app, "live.playpause ignored: no track");
        return;
    }
    if s.playing {
        p.pause();
    } else {
        p.resume();
    }
    crate::append_log(
        app,
        &format!("live.playpause -> {} (was {})", if s.playing { "pause" } else { "resume" }, s.playing),
    );
}

/* ------------------------------------------------------------------ */
/* 与 Swift 的接线                                                      */
/* ------------------------------------------------------------------ */

/// 导出给 Swift 的 C 入口（`@_silgen_name` / `dlsym` 调）。
///
/// 只做字符串解码，真正的活交给 `handle_remote_command`。
#[cfg(target_os = "ios")]
#[no_mangle]
pub extern "C" fn shuyin_remote_command(cmd: *const std::ffi::c_char) {
    if cmd.is_null() {
        return;
    }
    let text = unsafe { std::ffi::CStr::from_ptr(cmd) }.to_string_lossy().to_string();
    handle_remote_command(&text);
}

#[cfg(target_os = "ios")]
mod ffi {
    use std::ffi::{c_char, c_void, CString};

    extern "C" {
        fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    }

    /// RTLD_DEFAULT == (void *) -2
    const RTLD_DEFAULT: *mut c_void = -2isize as *mut c_void;

    /// 运行时找 Swift 导出的符号。
    ///
    /// 故意不用 `extern "C" { fn shuyin_live_sync(..) }` 的静态声明：
    /// 那样一旦某次构建漏把 Swift 文件编进主 App，链接期就是
    /// undefined symbol，整个包直接出不来。dlsym 查不到只会让灵动岛
    /// 不出现——功能降级，包还是能装能跑。
    fn lookup(name: &str) -> *mut c_void {
        let Ok(c) = CString::new(name) else { return std::ptr::null_mut() };
        unsafe { dlsym(RTLD_DEFAULT, c.as_ptr()) }
    }

    pub fn sync(json: &str) {
        type Fn = unsafe extern "C" fn(*const c_char);
        let p = lookup("shuyin_live_sync");
        if p.is_null() {
            return;
        }
        let f: Fn = unsafe { std::mem::transmute(p) };
        if let Ok(c) = CString::new(json) {
            unsafe { f(c.as_ptr()) }
        }
    }

    pub fn end() {
        type Fn = unsafe extern "C" fn();
        let p = lookup("shuyin_live_end");
        if p.is_null() {
            return;
        }
        let f: Fn = unsafe { std::mem::transmute(p) };
        unsafe { f() }
    }

    pub fn adopt() {
        type Fn = unsafe extern "C" fn();
        let p = lookup("shuyin_live_adopt");
        if p.is_null() {
            return;
        }
        let f: Fn = unsafe { std::mem::transmute(p) };
        unsafe { f() }
    }
}
