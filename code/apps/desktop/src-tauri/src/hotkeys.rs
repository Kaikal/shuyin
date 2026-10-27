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

enum Cmd {
    Apply(Vec<HotkeyItem>, Sender<Vec<HotkeyResult>>),
    Clear(Sender<Vec<HotkeyResult>>),
}

struct Ctl {
    tx: Sender<Cmd>,
    /// 消息线程的 OS 线程 id：`PostThreadMessageW` 靠它把「有新命令」的消息塞进队列
    tid: u32,
}

static CTL: Mutex<Option<Ctl>> = Mutex::new(None);

/// 内部唤醒消息（WM_APP + 1），只在本进程这条线程队列里流转
const WM_APP_CMD: u32 = 0x8000 + 1;

/// 把前端写法解析成 Windows 的「修饰键 + VK 码」。
///
/// 支持：`Ctrl`/`Control`、`Alt`、`Shift`、`Win`/`Super`/`Cmd`、`CommandOrControl`，
/// 主键可以是 A-Z、0-9、F1-F24、方向键、常见符号，或媒体键名。
fn parse_accel(accel: &str) -> Option<(u32, u32)> {
    let raw = accel.trim();
    if raw.is_empty() {
        return None;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = raw;
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
#[cfg(not(target_os = "windows"))]
fn worker(_app: AppHandle, _rx: Receiver<Cmd>, ready: Sender<u32>) {
    let _ = ready.send(0);
}

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
pub fn clear() -> Vec<HotkeyResult> {
    send(Cmd::Clear)
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
