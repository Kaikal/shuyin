//! 全局快捷键与媒体键（耳机线控）。
//!
//! 为什么要自己写一层：耳机线控和三键耳机（播放/暂停、上一首、下一首）在系统里
//! 走的就是**全局媒体键**，应用没在前台时也得响应。WebView 的 keydown 只在窗口
//! 聚焦时才有事件，用它做「耳机控制」等于没有。
//!
//! 这里用 Windows 的 `RegisterHotKey` + 一条常驻的消息循环线程：
//!   * 组合键（Ctrl+Alt+Space 之类）与媒体键（MediaPlayPause / MediaTrackNext / Prev）
//!     都按同一套 VK 码注册；
//!   * 线程把 `WM_HOTKEY` 翻译成动作 id，通过 `hotkey://action` 事件发给前端；
//!   * 注册结果**逐项**返回：某个键被别的程序占了，只影响它自己，不会让整组失效。
//!
//! 注意：`RegisterHotKey` 的注册与注销必须在**同一条线程**上，所以所有注册动作都
//! 走消息线程处理，调用方只负责投递命令并等结果。

use std::collections::HashMap;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// 一个待注册的快捷键：`id` 是动作标识（前端定义），`accel` 是组合键写法。
#[derive(serde::Deserialize, serde::Serialize, Clone)]
pub struct HotkeyItem {
    pub id: String,
    pub accel: String,
}

/// 注册结果：哪一项成功、哪一项被占用。
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyResult {
    pub id: String,
    pub ok: bool,
    pub error: Option<String>,
}

#[cfg(target_os = "windows")]
enum Cmd {
    Apply(Vec<HotkeyItem>, Sender<Vec<HotkeyResult>>),
    Clear(Sender<Vec<HotkeyResult>>),
}

#[cfg(target_os = "windows")]
struct Ctl {
    tx: Sender<Cmd>,
    /// 消息线程的 OS 线程 id：`PostThreadMessageW` 靠它把「有新命令」的消息塞进队列
    tid: u32,
}

#[cfg(target_os = "windows")]
static CTL: Mutex<Option<Ctl>> = Mutex::new(None);

/// 内部唤醒消息（WM_APP + 1），只在本进程这条线程队列里流转
#[cfg(target_os = "windows")]
const WM_APP_CMD: u32 = 0x8000 + 1;

/// 把前端写法解析成「修饰键 + 键码」。
///
/// 支持：`Ctrl`/`Control`、`Alt`、`Shift`、`Win`/`Super`/`Cmd`、`CommandOrControl`，
/// 主键可以是 A-Z、0-9、F1-F24、方向键、常见符号，或媒体键名。
fn parse_accel(accel: &str) -> Option<(u32, u32)> {
    let raw = accel.trim();
    if raw.is_empty() {
        return None;
    }
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
            MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, MOD_WIN,
        };

        let parts: Vec<&str> = raw.split('+').map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
        let (key, mods_raw) = parts.split_last()?;
        let mut mods: u32 = 0;
        for m in mods_raw {
            match m.to_ascii_lowercase().as_str() {
                "ctrl" | "control" | "commandorcontrol" | "cmdorctrl" => mods |= MOD_CONTROL,
                "alt" | "option" => mods |= MOD_ALT,
                "shift" => mods |= MOD_SHIFT,
                "win" | "super" | "meta" | "cmd" | "command" => mods |= MOD_WIN,
                _ => return None,
            }
        }
        // 长按时不要一秒触发十几次
        mods |= MOD_NOREPEAT;
        let vk = vk_of(key)?;
        Some((mods, vk))
    }
    #[cfg(target_os = "macos")]
    {
        mac::parse(raw)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = raw;
        None
    }
}

#[cfg(target_os = "windows")]
fn vk_of(key: &str) -> Option<u32> {
    let k = key.trim();
    let lower = k.to_ascii_lowercase();
    // 单字符：字母 / 数字 / 常见符号
    if k.chars().count() == 1 {
        let c = k.chars().next()?;
        if c.is_ascii_alphabetic() {
            return Some(c.to_ascii_uppercase() as u32);
        }
        if c.is_ascii_digit() {
            return Some(c as u32);
        }
        return Some(match c {
            ' ' => 0x20,
            ';' => 0xBA,
            '=' => 0xBB,
            ',' => 0xBC,
            '-' => 0xBD,
            '.' => 0xBE,
            '/' => 0xBF,
            '`' => 0xC0,
            '[' => 0xDB,
            '\\' => 0xDC,
            ']' => 0xDD,
            '\'' => 0xDE,
            _ => return None,
        });
    }
    // F1 - F24
    if let Some(n) = lower.strip_prefix('f').and_then(|s| s.parse::<u32>().ok()) {
        if (1..=24).contains(&n) {
            return Some(0x70 + n - 1);
        }
    }
    Some(match lower.as_str() {
        "space" | "spacebar" => 0x20,
        "enter" | "return" => 0x0D,
        "tab" => 0x09,
        "escape" | "esc" => 0x1B,
        "backspace" => 0x08,
        "delete" | "del" => 0x2E,
        "insert" | "ins" => 0x2D,
        "home" => 0x24,
        "end" => 0x23,
        "pageup" | "prior" => 0x21,
        "pagedown" | "next" => 0x22,
        "left" | "arrowleft" => 0x25,
        "up" | "arrowup" => 0x26,
        "right" | "arrowright" => 0x27,
        "down" | "arrowdown" => 0x28,
        "num0" => 0x60,
        "num1" => 0x61,
        "num2" => 0x62,
        "num3" => 0x63,
        "num4" => 0x64,
        "num5" => 0x65,
        "num6" => 0x66,
        "num7" => 0x67,
        "num8" => 0x68,
        "num9" => 0x69,
        "numadd" | "plus" => 0x6B,
        "numsub" | "minus" => 0x6D,
        // 媒体键：耳机线控 / 键盘上的播放键走的就是这几个
        "mediaplaypause" | "mediatoggleplaypause" | "playpause" | "mediaplay" => 0xB3,
        "mediatracknext" | "medianext" | "nexttrack" => 0xB0,
        "mediatrackprev" | "mediaprev" | "prevtrack" => 0xB1,
        "mediastop" => 0xB2,
        "volumeup" => 0xAF,
        "volumedown" => 0xAE,
        "volumemute" => 0xAD,
        _ => return None,
    })
}

#[cfg(target_os = "windows")]
fn worker(app: AppHandle, rx: Receiver<Cmd>, ready: Sender<u32>) {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, GetMessageW, PeekMessageW, PostThreadMessageW, TranslateMessage, MSG,
        PM_NOREMOVE, WM_HOTKEY,
    };

    unsafe {
        // 先摸一次队列：RegisterHotKey 拿到的消息要投到这条线程的队列上，
        // 队列不存在时部分系统版本会直接失败。
        let mut msg: MSG = std::mem::zeroed();
        PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_NOREMOVE);
        let tid = windows_sys::Win32::System::Threading::GetCurrentThreadId();
        let _ = ready.send(tid);

        // 注册用的整数 id（1..）→ 前端动作 id
        let mut map: HashMap<i32, String> = HashMap::new();
        let mut next_id: i32;

        loop {
            let r = GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0);
            if r <= 0 {
                break; // 0 = WM_QUIT，-1 = 出错：两种情况都退出
            }
            if msg.message == WM_HOTKEY {
                let id = msg.wParam as i32;
                if let Some(action) = map.get(&id) {
                    // 前端没开窗口也要能收到：直接广播到所有 webview
                    let _ = app.emit("hotkey://action", serde_json::json!({ "id": action }));
                }
                continue;
            }
            if msg.message == WM_APP_CMD {
                while let Ok(cmd) = rx.try_recv() {
                    match cmd {
                        Cmd::Apply(items, reply) => {
                            for id in map.keys() {
                                UnregisterHotKey(std::ptr::null_mut(), *id);
                            }
                            map.clear();
                            next_id = 1;
                            let mut out = Vec::with_capacity(items.len());
                            for it in items {
                                if it.accel.trim().is_empty() {
                                    // 空 = 用户清掉了这项，不是错误
                                    out.push(HotkeyResult { id: it.id, ok: true, error: None });
                                    continue;
                                }
                                let Some((mods, vk)) = parse_accel(&it.accel) else {
                                    out.push(HotkeyResult {
                                        id: it.id,
                                        ok: false,
                                        error: Some(format!("不认识这组按键：{}", it.accel)),
                                    });
                                    continue;
                                };
                                let ok = RegisterHotKey(std::ptr::null_mut(), next_id, mods, vk) != 0;
                                if ok {
                                    map.insert(next_id, it.id.clone());
                                    next_id += 1;
                                }
                                out.push(HotkeyResult {
                                    id: it.id,
                                    ok,
                                    error: if ok {
                                        None
                                    } else {
                                        Some("被系统或别的程序占用了".to_string())
                                    },
                                });
                            }
                            let _ = reply.send(out);
                        }
                        Cmd::Clear(reply) => {
                            for id in map.keys() {
                                UnregisterHotKey(std::ptr::null_mut(), *id);
                            }
                            map.clear();
                            let _ = reply.send(Vec::new());
                        }
                    }
                }
                continue;
            }
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        let _ = PostThreadMessageW(tid, 0, 0, 0);
    }
}

/// 非 Windows：保留接口，返回「不支持」而不是让前端报错。
#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn worker(_app: AppHandle, _rx: Receiver<Cmd>, ready: Sender<u32>) {
    let _ = ready.send(0);
}

#[cfg(target_os = "windows")]
fn ensure(app: &AppHandle) -> Result<(), String> {
    let mut g = CTL.lock().map_err(|_| "快捷键状态异常".to_string())?;
    if g.is_some() {
        return Ok(());
    }
    let (tx, rx) = channel::<Cmd>();
    let (ready_tx, ready_rx) = channel::<u32>();
    let app2 = app.clone();
    std::thread::Builder::new()
        .name("shuyin-hotkeys".into())
        .spawn(move || worker(app2, rx, ready_tx))
        .map_err(|e| format!("快捷键线程启动失败：{e}"))?;
    let tid = ready_rx
        .recv_timeout(Duration::from_secs(3))
        .map_err(|_| "快捷键线程没有响应".to_string())?;
    *g = Some(Ctl { tx, tid });
    Ok(())
}

#[cfg(target_os = "windows")]
fn send(f: impl FnOnce(Sender<Vec<HotkeyResult>>) -> Cmd) -> Vec<HotkeyResult> {
    let g = match CTL.lock() {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let Some(ctl) = g.as_ref() else {
        return Vec::new();
    };
    let (tx, rx) = channel();
    if ctl.tx.send(f(tx)).is_err() {
        return Vec::new();
    }
    // 叫醒消息线程去处理命令
    #[cfg(target_os = "windows")]
    unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::PostThreadMessageW(ctl.tid, WM_APP_CMD, 0, 0);
    }
    rx.recv_timeout(Duration::from_secs(3)).unwrap_or_default()
}

/// 重新注册一整套快捷键（先全部注销，再按顺序注册）。
#[cfg(target_os = "windows")]
pub fn apply(app: &AppHandle, items: Vec<HotkeyItem>) -> Vec<HotkeyResult> {
    if ensure(app).is_err() {
        return items
            .into_iter()
            .map(|it| HotkeyResult { id: it.id, ok: false, error: Some("快捷键线程不可用".into()) })
            .collect();
    }
    send(|reply| Cmd::Apply(items, reply))
}

/// 全部注销（关掉快捷键功能、或应用退出前调用）。
#[cfg(target_os = "windows")]
pub fn clear() -> Vec<HotkeyResult> {
    send(Cmd::Clear)
}

/* ------------------------------------------------------------------ */
/* macOS：Carbon RegisterEventHotKey                                     */
/*                                                                      */
/* 和 Windows 同一套「apply/clear + 逐项结果」对外形状，实现思路不同：    */
/* Windows 的注册/注销必须线程亲和（消息线程），macOS 的 Carbon 事件       */
/* 注册必须走主线程——所以这里不起新线程，apply/clear 都投给主线程执行，   */
/* 注册结果原路带回。媒体键不在此注册：系统媒体键归媒体会话（smtc.rs）管。 */
/* ------------------------------------------------------------------ */

#[cfg(target_os = "macos")]
mod mac {
    use super::{HotkeyItem, HotkeyResult};
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    use tauri::{AppHandle, Emitter};

    /* ---- Carbon FFI（自声明，不引第三方 crate） ---- */
    type Ref = *mut std::ffi::c_void;
    #[repr(C)]
    struct EventTypeSpec {
        class: u32,
        kind: u32,
    }
    #[repr(C)]
    struct HotKeyId {
        signature: u32,
        id: u32,
    }

    const K_EVENT_CLASS_KEYBOARD: u32 = 0x6B657962; // 'keyb'
    const K_EVENT_HOT_KEY_PRESSED: u32 = 5;
    const PARAM_DIRECT_OBJECT: u32 = 0x2D2D2D2D; // '----'
    const PARAM_TYPE_HOT_KEY_ID: u32 = 0x686B6964; // 'hkid'
    // Carbon 修饰键位（Events.h 的 EventModifiers）
    const CMD_KEY: u32 = 1 << 8;
    const SHIFT_KEY: u32 = 1 << 9;
    const OPTION_KEY: u32 = 1 << 11;
    const CONTROL_KEY: u32 = 1 << 12;

    unsafe extern "C" {
        fn InstallEventHandler(
            target: Ref,
            handler: extern "C" fn(Ref, Ref, *mut std::ffi::c_void) -> i32,
            count: isize,
            types: *const EventTypeSpec,
            user_data: *mut std::ffi::c_void,
            out: *mut Ref,
        ) -> i32;
        fn GetApplicationEventTarget() -> Ref;
        fn RegisterEventHotKey(
            key_code: u32,
            mods: u32,
            id: HotKeyId,
            target: Ref,
            options: u32,
            out: *mut Ref,
        ) -> i32;
        fn UnregisterEventHotKey(hot_key: Ref) -> i32;
        fn GetEventParameter(
            event: Ref,
            name: u32,
            want_type: u32,
            out_type: *mut u32,
            buf_size: usize,
            out_size: *mut usize,
            data: *mut std::ffi::c_void,
        ) -> i32;
    }

    /// 裸指针跨线程要显式承诺：这些 EventHotKeyRef 只在主线程被系统使用，
    /// Rust 侧只拿它做注销，指向的内容不由我们解引用
    struct SendRef(Ref);
    unsafe impl Send for SendRef {}

    static MAP: OnceLock<Mutex<HashMap<u32, (SendRef, String)>>> = OnceLock::new();
    static INSTALLED: OnceLock<()> = OnceLock::new();
    static APP: OnceLock<AppHandle> = OnceLock::new();
    static NEXT_ID: Mutex<u32> = Mutex::new(1);

    fn map_cell() -> &'static Mutex<HashMap<u32, (SendRef, String)>> {
        MAP.get_or_init(|| Mutex::new(HashMap::new()))
    }

    /// 按下热键：从事件里抽出 id → 查表 → 广播。主线程回调。
    unsafe extern "C" fn on_hotkey(_call: Ref, event: Ref, _ud: *mut std::ffi::c_void) -> i32 {
        let mut hk = HotKeyId { signature: 0, id: 0 };
        let st = GetEventParameter(
            event,
            PARAM_DIRECT_OBJECT,
            PARAM_TYPE_HOT_KEY_ID,
            std::ptr::null_mut(),
            std::mem::size_of::<HotKeyId>(),
            std::ptr::null_mut(),
            &mut hk as *mut HotKeyId as *mut std::ffi::c_void,
        );
        if st == 0 {
            if let Some(m) = MAP.get() {
                if let Ok(g) = m.lock() {
                    if let Some(action) = g.get(&hk.id) {
                        if let Some(app) = APP.get() {
                            let _ = app.emit(
                                "hotkey://action",
                                serde_json::json!({ "id": action }),
                            );
                        }
                    }
                }
            }
        }
        0
    }

    /// 主键码表（kVK_ANSI_*）。
    fn key_code_of(key: &str) -> Option<u32> {
        let k = key.trim();
        let lower = k.to_ascii_lowercase();
        if k.chars().count() == 1 {
            let c = k.chars().next()?;
            if c.is_ascii_alphabetic() {
                return Some(match c.to_ascii_lowercase() {
                    'q' => 0x0C, 'w' => 0x0D, 'e' => 0x0E, 'r' => 0x0F, 't' => 0x11,
                    'y' => 0x10, 'u' => 0x20, 'i' => 0x22, 'o' => 0x1F, 'p' => 0x23,
                    'a' => 0x00, 's' => 0x01, 'd' => 0x02, 'f' => 0x03, 'g' => 0x05,
                    'h' => 0x04, 'j' => 0x26, 'k' => 0x28, 'l' => 0x25,
                    'z' => 0x06, 'x' => 0x07, 'c' => 0x08, 'v' => 0x09, 'b' => 0x0B,
                    'n' => 0x2D, 'm' => 0x2E,
                    _ => return None,
                });
            }
            if c.is_ascii_digit() {
                return Some(match c {
                    '1' => 0x12, '2' => 0x13, '3' => 0x14, '4' => 0x15, '5' => 0x17,
                    '6' => 0x16, '7' => 0x1A, '8' => 0x1C, '9' => 0x19, '0' => 0x1D,
                    _ => return None,
                });
            }
            return Some(match c {
                ' ' => 0x31,
                ';' => 0x29,
                '=' => 0x18,
                ',' => 0x2B,
                '-' => 0x1B,
                '.' => 0x2F,
                '/' => 0x2C,
                '`' => 0x32,
                '[' => 0x21,
                '\\' => 0x2A,
                ']' => 0x1E,
                '\'' => 0x27,
                _ => return None,
            });
        }
        if let Some(n) = lower.strip_prefix('f').and_then(|s| s.parse::<u32>().ok()) {
            if (1..=20).contains(&n) {
                return Some(match n {
                    1 => 0x7A, 2 => 0x78, 3 => 0x63, 4 => 0x79, 5 => 0x60,
                    6 => 0x61, 7 => 0x62, 8 => 0x64, 9 => 0x65, 10 => 0x6D,
                    11 => 0x67, 12 => 0x6F, 13 => 0x69, 14 => 0x6B, 15 => 0x71,
                    16 => 0x6A, 17 => 0x40, 18 => 0x4F, 19 => 0x50, 20 => 0x5A,
                    _ => return None,
                });
            }
        }
        Some(match lower.as_str() {
            "space" | "spacebar" => 0x31,
            "enter" | "return" => 0x36,
            "tab" => 0x30,
            "escape" | "esc" => 0x35,
            "backspace" => 0x33,
            "delete" | "del" => 0x75,
            "home" => 0x73,
            "end" => 0x77,
            "pageup" | "prior" => 0x74,
            "pagedown" | "next" => 0x79,
            "left" | "arrowleft" => 0x7B,
            "up" | "arrowup" => 0x7E,
            "right" | "arrowright" => 0x7C,
            "down" | "arrowdown" => 0x7D,
            _ => return None,
        })
    }

    /// 前端写法 → (修饰键, 主键码)。媒体键不支持：它们归媒体会话管。
    pub fn parse(raw: &str) -> Option<(u32, u32)> {
        let parts: Vec<&str> =
            raw.split('+').map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
        let (key, mods_raw) = parts.split_last()?;
        let mut mods: u32 = 0;
        for m in mods_raw {
            match m.to_ascii_lowercase().as_str() {
                "ctrl" | "control" => mods |= CONTROL_KEY,
                "alt" | "option" => mods |= OPTION_KEY,
                "shift" => mods |= SHIFT_KEY,
                "win" | "super" | "meta" | "cmd" | "command" | "commandorcontrol"
                | "cmdorctrl" => mods |= CMD_KEY,
                _ => return None,
            }
        }
        let code = key_code_of(key)?;
        Some((mods, code))
    }

    /// 主线程上执行：先全部注销，再逐项注册。
    fn register_all(items: Vec<HotkeyItem>) -> Vec<HotkeyResult> {
        unsafe {
            if INSTALLED.get().is_none() {
                let spec = EventTypeSpec { class: K_EVENT_CLASS_KEYBOARD, kind: K_EVENT_HOT_KEY_PRESSED };
                let st = InstallEventHandler(
                    GetApplicationEventTarget(),
                    on_hotkey,
                    1,
                    &spec,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                );
                if st != 0 {
                    return items
                        .into_iter()
                        .map(|it| HotkeyResult { id: it.id, ok: false, error: Some(format!("事件处理器安装失败（{st}）")) })
                        .collect();
                }
                let _ = INSTALLED.set(());
            }
            let g = map_cell();
            let Ok(mut map) = g.lock() else {
                return items
                    .into_iter()
                    .map(|it| HotkeyResult { id: it.id, ok: false, error: Some("内部状态异常".into()) })
                    .collect();
            };
            for (r, _) in map.values() {
                let _ = UnregisterEventHotKey(r.0);
            }
            map.clear();
            let mut out = Vec::with_capacity(items.len());
            for it in items {
                if it.accel.trim().is_empty() {
                    out.push(HotkeyResult { id: it.id, ok: true, error: None });
                    continue;
                }
                let Some((mods, code)) = parse(&it.accel) else {
                    let is_media = ["mediaplaypause", "playpause", "mediatracknext", "mediatrackprev", "mediastop", "volumeup", "volumedown", "volumemute"]
                        .contains(&it.accel.trim().to_ascii_lowercase().as_str());
                    out.push(HotkeyResult {
                        id: it.id,
                        ok: false,
                        error: Some(if is_media {
                            "macOS 的媒体键由系统媒体会话接管，耳机按键直接可用，不需要在此注册".into()
                        } else {
                            format!("不认识这组按键：{}", it.accel)
                        }),
                    });
                    continue;
                };
                let next = NEXT_ID.lock().map(|mut g| { let v = *g; *g = v + 1; v }).unwrap_or(0);
                let id = HotKeyId { signature: 0x7379686B, id: next }; // 'syhk'
                let mut hk: Ref = std::ptr::null_mut();
                let st = RegisterEventHotKey(code, mods, id, GetApplicationEventTarget(), 0, &mut hk);
                let ok = st == 0 && !hk.is_null();
                if ok {
                    map.insert(next, (SendRef(hk), it.id.clone()));
                }
                out.push(HotkeyResult {
                    id: it.id,
                    ok,
                    error: if ok { None } else { Some("被系统或别的程序占用了".to_string()) },
                });
            }
            out
        }
    }

    pub fn apply(app: &AppHandle, items: Vec<HotkeyItem>) -> Vec<HotkeyResult> {
        let _ = APP.set(app.clone());
        let (tx, rx) = std::sync::mpsc::channel();
        let moved = app.clone();
        let into = items.clone();
        let r = moved.run_on_main_thread(move || {
            let _ = tx.send(register_all(into));
        });
        if r.is_err() {
            return items
                .into_iter()
                .map(|it| HotkeyResult { id: it.id, ok: false, error: Some("主线程忙，快捷键没注册上".into()) })
                .collect();
        }
        rx.recv_timeout(std::time::Duration::from_secs(3)).unwrap_or_default()
    }

    pub fn clear() -> Vec<HotkeyResult> {
        let Some(app) = APP.get() else { return Vec::new() };
        let (tx, rx) = std::sync::mpsc::channel();
        let moved = app.clone();
        let r = moved.run_on_main_thread(move || {
            if let Some(m) = MAP.get() {
                if let Ok(mut g) = m.lock() {
                    for (r, _) in g.values() {
                        unsafe { let _ = UnregisterEventHotKey(r.0); }
                    }
                    g.clear();
                }
            }
            let _ = tx.send(Vec::new());
        });
        if r.is_err() {
            return Vec::new();
        }
        rx.recv_timeout(std::time::Duration::from_secs(3)).unwrap_or_default()
    }
}

#[cfg(target_os = "macos")]
pub fn apply(app: &AppHandle, items: Vec<HotkeyItem>) -> Vec<HotkeyResult> {
    mac::apply(app, items)
}

#[cfg(target_os = "macos")]
pub fn clear() -> Vec<HotkeyResult> {
    mac::clear()
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn apply(_app: &AppHandle, items: Vec<HotkeyItem>) -> Vec<HotkeyResult> {
    items
        .into_iter()
        .map(|it| HotkeyResult { id: it.id, ok: false, error: Some("此平台暂不支持全局快捷键".into()) })
        .collect()
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn clear() -> Vec<HotkeyResult> {
    Vec::new()
}

/// 注册失败时给用户看的一句话总结
pub fn summarize(results: &[HotkeyResult]) -> String {
    let bad: Vec<&HotkeyResult> = results.iter().filter(|r| !r.ok).collect();
    if bad.is_empty() {
        return String::new();
    }
    bad.iter()
        .map(|r| r.error.clone().unwrap_or_else(|| r.id.clone()))
        .collect::<Vec<_>>()
        .join("；")
}
