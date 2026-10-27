//! Windows 系统媒体控制（SMTC, System Media Transport Controls）。
//!
//! ## 为什么需要它
//!
//! 耳机上的播放键（有线三键线控、蓝牙耳机的 AVRCP 按键）在 Windows 里**不是普通按键**：
//! 系统把「播放/暂停」交给**当前活跃的媒体会话**，也就是 SMTC。谁注册了会话，按键就归谁，
//! 同时「音量浮层 / 锁屏 / 键盘媒体键」上也会显示这个会话的歌名。
//!
//! 之前用 `RegisterHotKey` 注册 `VK_MEDIA_PLAY_PAUSE` 是收不到的：媒体键不走热键表，
//! 注册往往还返回成功，于是表现为「自定义快捷键都能用，耳机按了没反应」。
//!
//! 桌面程序拿自己的 SMTC 实例只有一条路：`ISystemMediaTransportControlsInterop::GetForWindow`。
//! 这个接口 winrt 没有 C 头之外的 SDK 封装，所以下面的 vtable 是手写的（IID 取自
//! `SystemMediaTransportControlsInterop.h`，`ddb0472d-c911-4a1f-86d9-dc3d71a95f5a`）。
//!
//! ## 状态同步
//!
//! 前端在「换歌 / 播放状态变化」时调 `smtc_update`，系统浮层就能显示歌名与封面位。
//! 按键回发给前端的**仍然是 `hotkey://action`**，和自定义快捷键同一条派发链路——
//! 前端不用为媒体键写第二套逻辑。
//!
//! 所有 SMTC 调用都在主线程上做（`run_on_main_thread`）：这个对象不是 agile 的，
//! 从 tauri 的异步线程直接调会莫名失败。

use std::ffi::c_void;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

#[cfg(target_os = "windows")]
use windows::core::{factory, GUID, HSTRING, Interface};
#[cfg(target_os = "windows")]
use windows::Foundation::TypedEventHandler;
#[cfg(target_os = "windows")]
use windows::Media::{
    MediaPlaybackStatus, MediaPlaybackType, SystemMediaTransportControls,
    SystemMediaTransportControlsButton, SystemMediaTransportControlsButtonPressedEventArgs,
};
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::HWND;

/* ------------------------------------------------------------------ */
/* 手写的 interop 接口                                                  */
/* ------------------------------------------------------------------ */

#[cfg(target_os = "windows")]
const IID_INTEROP: GUID = GUID::from_u128(0xddb0472d_c911_4a1f_86d9_dc3d71a95f5a);

/*
 * 注意继承层级：WinRT 接口派生自 **IInspectable**，不是 IUnknown。
 * vtable 前面因此多出三个方法（GetIids / GetRuntimeClassName / GetTrustLevel），
 * `GetForWindow` 落在第 7 个槽位。少写这三个占位，调用会跳进 GetIids 里直接崩进程
 * （表现为窗口还没出来进程就没了，日志一句都没有）。
 */
#[cfg(target_os = "windows")]
#[repr(C)]
struct InteropVtbl {
    query_interface: unsafe extern "system" fn(*mut c_void, *const GUID, *mut *mut c_void) -> i32,
    add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
    release: unsafe extern "system" fn(*mut c_void) -> u32,
    get_iids: unsafe extern "system" fn(*mut c_void, *mut u32, *mut *mut GUID) -> i32,
    get_runtime_class_name: unsafe extern "system" fn(*mut c_void, *mut *mut c_void) -> i32,
    get_trust_level: unsafe extern "system" fn(*mut c_void, *mut i32) -> i32,
    /// `GetForWindow(HWND appWindow, REFIID riid, void** mediaTransportControl)`
    get_for_window:
        unsafe extern "system" fn(*mut c_void, HWND, *const GUID, *mut *mut c_void) -> i32,
}

/// COM 接口指针。
///
/// **必须是 `NonNull` 而不是裸指针**：`windows_core::factory()` 内部用
/// `Option<I>` 当 `RoGetActivationFactory` 的输出缓冲。裸指针没有 niche，
/// `Option<Interop>` 会变成 16 字节（payload + tag），而系统只写前 8 字节——
/// 结果 tag 被指针的低字节覆盖成「Some」，payload 才是空的。
/// 表现就是「工厂加载成功，一用就崩」，而且崩在 COM 调用里连 panic 日志都没有。
/// `NonNull` 有 null niche，`Option<Interop>` 回到 8 字节，布局与系统写入一致。
#[cfg(target_os = "windows")]
#[repr(transparent)]
struct Interop(std::ptr::NonNull<c_void>);

#[cfg(target_os = "windows")]
unsafe impl Interface for Interop {
    type Vtable = InteropVtbl;
    const IID: GUID = IID_INTEROP;
    /// 派生自 IInspectable，不是 IUnknown
    const UNKNOWN: bool = false;
}

#[cfg(target_os = "windows")]
impl Clone for Interop {
    fn clone(&self) -> Self {
        unsafe { (self.vtable().add_ref)(self.as_raw()) };
        Self(self.0)
    }
}

#[cfg(target_os = "windows")]
impl Drop for Interop {
    fn drop(&mut self) {
        unsafe { (self.vtable().release)(self.as_raw()) };
    }
}

/* ------------------------------------------------------------------ */
/* 会话                                                                */
/* ------------------------------------------------------------------ */

/// 持住 handler 不放：WinRT 的事件回调是引用计数的，句柄一丢回调就静默失效
#[cfg(target_os = "windows")]
struct Ctl {
    smtc: SystemMediaTransportControls,
    _handler:
        TypedEventHandler<SystemMediaTransportControls, SystemMediaTransportControlsButtonPressedEventArgs>,
}

/*
 * `TypedEventHandler` 里是裸 COM 指针，编译器不肯认它是 Send。
 * 这里的用法是安全的：整个 Ctl 只在主线程上被调用（update 走 run_on_main_thread，
 * init 在 setup 里就是主线程），`_handler` 甚至只负责保活、从不主动调用。
 */
#[cfg(target_os = "windows")]
unsafe impl Send for Ctl {}

#[cfg(target_os = "windows")]
static CTL: OnceLock<Mutex<Option<Ctl>>> = OnceLock::new();

#[cfg(target_os = "windows")]
fn cell() -> &'static Mutex<Option<Ctl>> {
    CTL.get_or_init(|| Mutex::new(None))
}

/// 把系统媒体键翻成前端的动作 id。
///
/// Play / Pause 都落到 `playpause`：系统会根据我们上报的播放状态只显示其中一个，
/// 用户按下去永远是「切换」，不会出现「按了播放却又暂停」。
#[cfg(target_os = "windows")]
fn action_of(btn: SystemMediaTransportControlsButton) -> Option<&'static str> {
    if btn == SystemMediaTransportControlsButton::Play || btn == SystemMediaTransportControlsButton::Pause {
        Some("playpause")
    } else if btn == SystemMediaTransportControlsButton::Next {
        Some("next")
    } else if btn == SystemMediaTransportControlsButton::Previous {
        Some("prev")
    } else if btn == SystemMediaTransportControlsButton::Stop {
        Some("playpause")
    } else {
        None
    }
}

/// 绑定到主窗口。**必须在主线程调用**（tauri 的 setup 里正好是）。
///
/// `hwnd` 传裸值而不是 `HWND`：这样非 Windows 平台也能有完全相同的签名。
pub fn init(app: &AppHandle, hwnd: isize) -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, hwnd);
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        init_win(app, HWND(hwnd as *mut c_void))
    }
}

#[cfg(target_os = "windows")]
fn init_win(app: &AppHandle, hwnd: HWND) -> Result<(), String> {
    if cell().lock().map(|g| g.is_some()).unwrap_or(false) {
        return Ok(());
    }
    let interop: Interop = factory::<SystemMediaTransportControls, Interop>()
        .map_err(|e| format!("系统媒体控制不可用（{e}）"))?;

    let mut out: *mut c_void = std::ptr::null_mut();
    let hr = unsafe {
        (interop.vtable().get_for_window)(
            interop.as_raw(),
            hwnd,
            &<SystemMediaTransportControls as Interface>::IID,
            &mut out,
        )
    };
    if hr < 0 || out.is_null() {
        return Err(format!("媒体会话绑定失败（HRESULT 0x{:08X}）", hr));
    }
    let smtc = unsafe { <SystemMediaTransportControls as Interface>::from_raw(out) };

    // 先把能用到的按钮全打开，再启用会话：顺序反了，系统浮层会短暂只有「停止」
    let _ = smtc.SetIsPlayEnabled(true);
    let _ = smtc.SetIsPauseEnabled(true);
    let _ = smtc.SetIsNextEnabled(true);
    let _ = smtc.SetIsPreviousEnabled(true);
    let _ = smtc.SetIsStopEnabled(true);
    let _ = smtc.SetPlaybackStatus(MediaPlaybackStatus::Paused);
    let _ = smtc.SetIsEnabled(true);

    let app2 = app.clone();
    let handler = TypedEventHandler::<
        SystemMediaTransportControls,
        SystemMediaTransportControlsButtonPressedEventArgs,
    >::new(move |_sender, args| {
        if let Some(args) = args.as_ref() {
            if let Ok(btn) = args.Button() {
                if let Some(id) = action_of(btn) {
                    // `source: smtc` 让前端能把「系统媒体键」和「自定义组合键」分开处理
                    // （比如用户在设置里关掉了媒体键，只该忽略前者）
                    let _ = app2.emit(
                        "hotkey://action",
                        serde_json::json!({ "id": id, "source": "smtc" }),
                    );
                }
            }
        }
        Ok(())
    });
    smtc.ButtonPressed(&handler)
        .map_err(|e| format!("媒体键回调注册失败（{e}）"))?;

    if let Ok(mut g) = cell().lock() {
        *g = Some(Ctl { smtc, _handler: handler });
    }
    Ok(())
}

/// 换歌 / 播放状态变化时调用。没有会话（初始化失败）就安静地什么都不做。
#[cfg(target_os = "windows")]
fn apply(title: &str, artist: &str, album: &str, playing: bool) {
    let g = match cell().lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    let Some(ctl) = g.as_ref() else { return };
    let _ = ctl.smtc.SetPlaybackStatus(if playing {
        MediaPlaybackStatus::Playing
    } else {
        MediaPlaybackStatus::Paused
    });
    if let Ok(up) = ctl.smtc.DisplayUpdater() {
        let _ = up.SetType(MediaPlaybackType::Music);
        if let Ok(mp) = up.MusicProperties() {
            let _ = mp.SetTitle(&HSTRING::from(title));
            let _ = mp.SetArtist(&HSTRING::from(artist));
            let _ = mp.SetAlbumTitle(&HSTRING::from(album));
        }
        let _ = up.Update();
    }
}

#[cfg(target_os = "windows")]
pub fn update(app: &AppHandle, title: String, artist: String, album: String, playing: bool) {
    let _ = app.run_on_main_thread(move || apply(&title, &artist, &album, playing));
}

/* ------------------------------------------------------------------ */
/* 非 Windows：保留同名接口，不报错                                      */
/* ------------------------------------------------------------------ */

#[cfg(not(target_os = "windows"))]
pub fn update(_app: &AppHandle, _t: String, _a: String, _al: String, _p: bool) {}
