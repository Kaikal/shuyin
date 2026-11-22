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
#[cfg(target_os = "windows")]
pub fn init(app: &AppHandle, hwnd: isize) -> Result<(), String> {
    init_win(app, HWND(hwnd as *mut c_void))
}

/// Apple（macOS / iOS）：hwnd 用不上（Now Playing 是进程级的，不绑窗口）
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn init(app: &AppHandle, _hwnd: isize) -> Result<(), String> {
    apple::init(app)
}

#[cfg(not(any(
    target_os = "windows",
    target_os = "macos",
    target_os = "ios"
)))]
pub fn init(_app: &AppHandle, _hwnd: isize) -> Result<(), String> {
    Ok(())
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
pub fn update(
    app: &AppHandle,
    title: String,
    artist: String,
    album: String,
    playing: bool,
    _cover: String,
    _position: f64,
    _duration: f64,
) {
    let _ = app.run_on_main_thread(move || apply(&title, &artist, &album, playing));
}

/* ------------------------------------------------------------------ */
/* 非 Windows：保留同名接口，不报错                                      */
/* ------------------------------------------------------------------ */

#[cfg(not(any(
    target_os = "windows",
    target_os = "macos",
    target_os = "ios"
)))]
pub fn update(
    _app: &AppHandle,
    _t: String,
    _a: String,
    _al: String,
    _p: bool,
    _cover: String,
    _position: f64,
    _duration: f64,
) {
}

/* ------------------------------------------------------------------ */
/* Apple（macOS / iOS）：MPNowPlayingInfoCenter + MPRemoteCommandCenter  */
/*                                                                      */
/* 对应 Windows 的 SMTC：锁屏 / 控制中心 / 耳机按键都走这一套。          */
/* 两端 API 完全一样，所以共用一个模块；iOS 只多两件 macOS 没有的事：    */
/*   ① AVAudioSession 必须显式配成 playback + 激活，否则熄屏/切后台      */
/*      系统直接掐掉音频（cpal 的 iOS host 从不配，见其 mod.rs 的 TODO）*/
/*   ② UIApplication 要走 beginReceivingRemoteControlEvents            */
/* 按键回发同样是 `hotkey://action`（source=smtc），前端零改动。         */
/* 故意用裸 msg_send 而不是 objc2-media-player 的强类型包装：            */
/* 那套 API 的 NSDictionary 泛型值类型在 0.2/0.3 之间改过一轮，          */
/* 裸调用只依赖 selector 名，跨版本稳定得多。                            */
/* ------------------------------------------------------------------ */

#[cfg(any(target_os = "macos", target_os = "ios"))]
use objc2::rc::Retained;
#[cfg(any(target_os = "macos", target_os = "ios"))]
use objc2::runtime::AnyObject;

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod apple {
    use super::*;
    use objc2::class;
    use std::ffi::CString;
    use std::sync::OnceLock;

    static INSTALLED: OnceLock<()> = OnceLock::new();

    /// NSString：直接 stringWithUTF8String，免开 objc2-foundation 的强类型
    unsafe fn ns(s: &str) -> Retained<AnyObject> {
        let c = CString::new(s).unwrap_or_default();
        let p: Retained<AnyObject> =
            objc2::msg_send![class!(NSString), stringWithUTF8String: c.as_ptr()];
        p
    }

    /// NSNumber（double）：进度、时长、播放速率都走它
    unsafe fn num(v: f64) -> Retained<AnyObject> {
        objc2::msg_send![class!(NSNumber), numberWithDouble: v]
    }

    extern "C" {
        fn objc_autoreleasePoolPush() -> *mut std::ffi::c_void;
        fn objc_autoreleasePoolPop(ctx: *mut std::ffi::c_void);
        fn dlopen(path: *const std::ffi::c_char, mode: i32) -> *mut std::ffi::c_void;
    }

    /* ---------------- iOS：把音频会话与远控事件接起来 ---------------- */

    /// 把 MediaPlayer / AVFoundation 拉进进程。
    ///
    /// 为什么要 dlopen 而不是指望链接：`class!` 宏在类查不到时是**直接 panic**
    /// （objc2 的 CachedClass::get 里写着 `panic!("class {name} could not be found")`）。
    /// iOS 上 Rust 编成静态库再交给 Xcode 链接，rustc 记下的 framework 依赖不一定
    /// 传到最终那条链接命令；一旦没链上就是启动即崩，还不是「功能不可用」。
    /// dlopen 一个已经加载的库是幂等的，多调没代价。
    fn load_frameworks() {
        const RTLD_LAZY: i32 = 0x1;
        for p in [
            "/System/Library/Frameworks/MediaPlayer.framework/MediaPlayer",
            // iOS 12 起 AVAudioSession 拆进了 AVFAudio，但 AVFoundation 仍会
            // 把它带进来。两个都试，谁先到算谁。
            #[cfg(target_os = "ios")]
            "/System/Library/Frameworks/AVFAudio.framework/AVFAudio",
            #[cfg(target_os = "ios")]
            "/System/Library/Frameworks/AVFoundation.framework/AVFoundation",
        ] {
            if let Ok(c) = CString::new(p) {
                unsafe { dlopen(c.as_ptr(), RTLD_LAZY) };
            }
        }
    }

    /// 按名字取类，取不到就返回 None（不 panic）。
    /// `class!` 对缺失类会 panic，所有「可能不在」的类都走这里。
    fn cls(name: &str) -> Option<&'static objc2::runtime::AnyClass> {
        let c = CString::new(name).ok()?;
        objc2::runtime::AnyClass::get(&c)
    }

    /// NSError 的本地化描述，拼在错误信息后面用于排查
    #[cfg(target_os = "ios")]
    unsafe fn ns_err(e: *mut AnyObject) -> String {
        if e.is_null() {
            return String::new();
        }
        let d: *mut AnyObject = objc2::msg_send![e, localizedDescription];
        if d.is_null() {
            return String::new();
        }
        let p: *const std::ffi::c_char = objc2::msg_send![d, UTF8String];
        if p.is_null() {
            return String::new();
        }
        format!("：{}", std::ffi::CStr::from_ptr(p).to_string_lossy())
    }

    /// 把音频会话配成「播放」并激活。
    ///
    /// 这一步同时决定三件事，缺一件体验就是坏的：
    ///   · category = playback → **静音拨片不再掐掉声音**（默认的 SoloAmbient 会被静音键吃掉）
    ///   · category = playback → **允许熄屏/切后台继续出声**。Info.plist 里的
    ///     `UIBackgroundModes=audio` 只是「声明资格」，不配 category 等于没申请。
    ///   · setActive → 真正把会话从系统手里要过来
    ///
    /// cpal 的 iOS host 从头到尾没碰过这套 API（其 mod.rs 里只有 TODO 注释），
    /// 所以必须在 App 启动时自己来。
    #[cfg(target_os = "ios")]
    fn setup_audio_session() -> Result<(), String> {
        let Some(session_cls) = cls("AVAudioSession") else {
            return Err("AVAudioSession 类不存在（AVFAudio 未加载）".into());
        };
        unsafe {
            let sess: *mut AnyObject = objc2::msg_send![session_cls, sharedInstance];
            if sess.is_null() {
                return Err("AVAudioSession 拿不到（MediaPlayer/AVFAudio 未加载）".into());
            }
            let cat = ns("AVAudioSessionCategoryPlayback");
            let mode = ns("AVAudioSessionModeDefault");
            let mut err: *mut AnyObject = std::ptr::null_mut();
            let ok: bool = objc2::msg_send![
                sess,
                setCategory: &*cat,
                mode: &*mode,
                options: 0usize,
                error: &mut err
            ];
            if !ok {
                return Err(format!("setCategory(playback) 失败{}", ns_err(err)));
            }
            let mut err2: *mut AnyObject = std::ptr::null_mut();
            let ok2: bool = objc2::msg_send![sess, setActive: true, error: &mut err2];
            if !ok2 {
                return Err(format!("setActive 失败{}", ns_err(err2)));
            }
        }
        Ok(())
    }

    /// 让 App 接收远控事件（锁屏/控制中心/耳机线的按钮都经由此路）
    #[cfg(target_os = "ios")]
    unsafe fn begin_remote_events() {
        let app: *mut AnyObject = objc2::msg_send![class!(UIApplication), sharedApplication];
        if app.is_null() {
            return;
        }
        let _: () = objc2::msg_send![app, beginReceivingRemoteControlEvents];
    }

    /// 来电 / 别的 App 抢音频时的中断处理。
    ///
    /// 不处理的后果很具体：电话挂断后播放器仍然是 `playing`，但声音永远不回来
    /// ——cpal 还在往音频单元写，只是会话被系统挂起，谁也不会主动把它恢复。
    #[cfg(target_os = "ios")]
    fn observe_interruptions(app: &AppHandle) {
        use std::ptr::NonNull;
        unsafe {
            let center: *mut AnyObject =
                objc2::msg_send![class!(NSNotificationCenter), defaultCenter];
            if center.is_null() {
                return;
            }
            let name = ns("AVAudioSessionInterruptionNotification");
            let app2 = app.clone();
            let block = block2::StackBlock::new(move |note: NonNull<AnyObject>| {
                unsafe {
                    let user: *mut AnyObject = objc2::msg_send![note.as_ptr(), userInfo];
                    if user.is_null() {
                        return;
                    }
                    let k = ns("AVAudioSessionInterruptionTypeKey");
                    let v: *mut AnyObject = objc2::msg_send![user, objectForKey: &*k];
                    if v.is_null() {
                        return;
                    }
                    let t: usize = objc2::msg_send![v, unsignedIntegerValue];
                    match t {
                        // Began：别跟系统抢，先自己停
                        1 => dispatch(&app2, "pause", None),
                        // Ended：重新激活会话；系统说「建议恢复」才继续播
                        2 => {
                            let _ = setup_audio_session();
                            let ok = ns("AVAudioSessionInterruptionOptionKey");
                            let o: *mut AnyObject = objc2::msg_send![user, objectForKey: &*ok];
                            let resume = if o.is_null() {
                                false
                            } else {
                                let n: usize = objc2::msg_send![o, unsignedIntegerValue];
                                // AVAudioSessionInterruptionOptionShouldResume == 1
                                n & 1 != 0
                            };
                            if resume {
                                dispatch(&app2, "play", None);
                            }
                        }
                        _ => {}
                    }
                }
            });
            let _: Retained<AnyObject> = objc2::msg_send![
                center,
                addObserverForName: &*name,
                object: std::ptr::null_mut::<AnyObject>(),
                queue: std::ptr::null_mut::<AnyObject>(),
                usingBlock: &block
            ];
        }
    }

    /* ---------------- 锁屏按钮 → 播放器 ---------------- */

    /// 锁屏 / 控制中心 / 耳机按键的落地动作。
    ///
    /// 与灵动岛按钮（`liveactivity::handle_remote_command`）是两条独立入口：
    /// 那条来自 Swift 的 LiveActivityIntent，这条来自 MPRemoteCommandCenter。
    /// 播放暂停都在 Rust 侧直接做——前端可能已被系统挂起，不能指望它。
    fn dispatch(app: &AppHandle, cmd: &str, pos: Option<f64>) {
        use tauri::Manager;
        let Some(p) = app.try_state::<crate::player::Player>() else {
            return;
        };
        let s = p.snapshot();
        // 「有没有歌」两个字段都得看：在线曲目的 track_path 恒为 None
        let has = s
            .track_path
            .as_deref()
            .map(|t| !t.is_empty())
            .unwrap_or(false)
            || s.track_url.as_deref().map(|t| !t.is_empty()).unwrap_or(false);
        if !has {
            crate::append_log(app, &format!("smtc.cmd ignored ({cmd}): no track"));
            return;
        }
        match cmd {
            "play" => {
                if !s.playing {
                    p.resume();
                }
            }
            "pause" => {
                if s.playing {
                    p.pause();
                }
            }
            "playpause" => {
                if s.playing {
                    p.pause();
                } else {
                    p.resume();
                }
            }
            "next" | "prev" => {
                let _ = app.emit(
                    "hotkey://action",
                    serde_json::json!({ "id": cmd, "source": "smtc" }),
                );
            }
            "seek" => {
                if let Some(t) = pos {
                    let dur = s.duration;
                    let target = if dur > 0.0 {
                        t.clamp(0.0, dur)
                    } else {
                        t.max(0.0)
                    };
                    p.seek(target);
                    // 立刻通知前端把进度条挪过去：它的 2s 看门狗最终也会纠，
                    // 但拖着锁屏进度条、回到 App 看到条子弹回原处，很难解释。
                    let _ = app.emit("media://seek", serde_json::json!({ "position": target }));
                }
            }
            other => {
                crate::append_log(app, &format!("smtc.cmd unknown {other}"));
            }
        }
    }

    /* ---------------- Now Playing 卡片 ---------------- */

    /// 封面 → MPMediaItemArtwork。
    ///
    /// 只吃本地文件路径（前端给的是 mediaCache 缓存槽的绝对路径）。
    /// 网络地址一律不读：异步线程里下一张图会拖住整条 meta 推送，
    /// 而锁屏那张图晚半秒没人看得出来。
    fn artwork(path: &str) -> Option<Retained<AnyObject>> {
        use objc2::rc::Allocated;
        if path.is_empty() || path.contains("://") {
            return None;
        }
        let bytes = std::fs::read(path).ok()?;
        if bytes.is_empty() || bytes.len() > 8 * 1024 * 1024 {
            return None;
        }
        unsafe {
            /*
             * dataWithBytes: / imageWithData: 都是「无方法族」——返回 autoreleased，
             * objc2 会自动 retain 一次，Retained 析构时正好抵掉。
             * alloc + init 则不同：init 会**吃掉** alloc 的所有权，所以 alloc 的
             * 结果必须是 Allocated 而不是 Retained，否则两份所有权指向同一块内存，
             * 析构两次直接崩。
             */
            let data: Retained<AnyObject> = objc2::msg_send![
                class!(NSData),
                dataWithBytes: bytes.as_ptr(),
                length: bytes.len()
            ];
            #[cfg(target_os = "ios")]
            let img: Retained<AnyObject> =
                objc2::msg_send![class!(UIImage), imageWithData: &*data];
            #[cfg(target_os = "macos")]
            let img: Retained<AnyObject> = {
                let alloc: Allocated<AnyObject> = objc2::msg_send![class!(NSImage), alloc];
                objc2::msg_send![alloc, initWithData: &*data]
            };
            let alloc: Allocated<AnyObject> = objc2::msg_send![class!(MPMediaItemArtwork), alloc];
            let art: Retained<AnyObject> = objc2::msg_send![alloc, initWithImage: &*img];
            Some(art)
        }
    }

    /// 一次性把远控命令挂到共享命令中心。
    /// 每个块内捕获自己的 AppHandle，效果与 Windows 完全同形。
    pub fn init(app: &AppHandle) -> Result<(), String> {
        if INSTALLED.get().is_some() {
            return Ok(());
        }
        /*
         * iOS 的三件前置：配音频会话、注册中断观察、接管远控事件。
         * MediaPlayer / AVFoundation 两端都先拉进进程——`class!` 查不到类会 panic。
         */
        load_frameworks();
        #[cfg(target_os = "ios")]
        {
            setup_audio_session()?;
            unsafe { begin_remote_events() };
            observe_interruptions(app);
        }

        unsafe {
            let Some(center_cls) = cls("MPRemoteCommandCenter") else {
                return Err("MPRemoteCommandCenter 不存在（MediaPlayer 未加载）".into());
            };
            let center: Retained<AnyObject> = objc2::msg_send![center_cls, sharedCommandCenter];
            let mut count = 0usize;

            /*
             * 每个命令都 setEnabled + 挂 handler。
             *
             * 为什么 play / pause 分开注册、还要再注册 toggle：
             *   · 控制中心和锁屏的按钮发的是明确的 play / pause；
             *   · 耳机线控单击发的是 togglePlayPause。
             * 只注册 toggle 会让控制中心的按钮在部分系统版本上变灰。
             */
            macro_rules! hook {
                ($sel:ident, $action:expr) => {{
                    let cmd: Retained<AnyObject> = objc2::msg_send![&center, $sel];
                    let _: () = objc2::msg_send![&cmd, setEnabled: true];
                    let app2 = app.clone();
                    let act: &'static str = $action;
                    // StackBlock：栈上构造，addTargetWithHandler 内部会拷贝持有，
                    // 不需要 Rust 侧再持引用（block2 0.6 已移除 Block::new）
                    let block = block2::StackBlock::new(
                        move |_e: std::ptr::NonNull<AnyObject>| -> i64 {
                            dispatch(&app2, act, None);
                            0
                        },
                    );
                    let _t: Retained<AnyObject> =
                        objc2::msg_send![&cmd, addTargetWithHandler: &block];
                    count += 1;
                }};
            }

            hook!(playCommand, "play");
            hook!(pauseCommand, "pause");
            hook!(togglePlayPauseCommand, "playpause");
            hook!(nextTrackCommand, "next");
            hook!(previousTrackCommand, "prev");

            // 锁屏/控制中心拖进度条：事件对象自带 positionTime，单独接
            {
                let cmd: Retained<AnyObject> =
                    objc2::msg_send![&center, changePlaybackPositionCommand];
                let _: () = objc2::msg_send![&cmd, setEnabled: true];
                let app2 = app.clone();
                let block = block2::StackBlock::new(
                    move |evt: std::ptr::NonNull<AnyObject>| -> i64 {
                        let pos: f64 = objc2::msg_send![evt.as_ptr(), positionTime];
                        dispatch(&app2, "seek", Some(pos));
                        0
                    },
                );
                let _t: Retained<AnyObject> =
                    objc2::msg_send![&cmd, addTargetWithHandler: &block];
                count += 1;
            }

            if count == 0 {
                return Err("远控命令全部注册失败".into());
            }
            let _ = INSTALLED.set(());
        }
        Ok(())
    }

    /// 换歌 / 播放状态变化 / 拖进度：刷新 Now Playing 卡片。
    ///
    /// 进度只在这个时机推一次，**不每秒推**：系统拿「当前秒数 + 播放速率」自己
    /// 走秒，比我们每秒写一次准，也省得后台 JS 被节流时卡片卡住不动。
    pub fn apply(
        title: &str,
        artist: &str,
        album: &str,
        playing: bool,
        cover: &str,
        position: f64,
        duration: f64,
    ) {
        unsafe {
            /*
             * 这些对象是 autoreleased 的，而调用线程（Tauri 的命令线程）没有
             * autorelease pool。不在这里手动开一个，每切一首歌都会漏掉一份
             * 字典 + 一份 NSData，几百首之后就是几十兆。
             */
            let pool = objc_autoreleasePoolPush();

            /*
             * 队列空了 / 停止播放：把卡片彻底撤掉。
             * 不撤的话锁屏上会留一张没有歌名的空壳，点进去还占着「正在播放」的位置。
             */
            if title.is_empty() {
                if let Some(np_cls) = cls("MPNowPlayingInfoCenter") {
                    let center: *mut AnyObject = objc2::msg_send![np_cls, defaultCenter];
                    if !center.is_null() {
                        let nil: *mut AnyObject = std::ptr::null_mut();
                        let _: () = objc2::msg_send![center, setNowPlayingInfo: nil];
                    }
                }
                objc_autoreleasePoolPop(pool);
                return;
            }

            let info: Retained<AnyObject> =
                objc2::msg_send![class!(NSMutableDictionary), dictionaryWithCapacity: 7u64];
            macro_rules! put {
                ($k:expr, $v:expr) => {{
                    let k = ns($k);
                    let v: Retained<AnyObject> = $v;
                    let _: () = objc2::msg_send![&info, setObject: &*v, forKey: &*k];
                }};
            }

            /*
             * 键名必须用 MPMediaItemProperty* 的**真实值**（小写开头）。
             * 这里以前写的是 "Title" / "Artist" / "AlbumTitle"——那不是任何
             * 系统常量，字典照收，系统一个都不认：卡片上就只剩按钮没有歌名。
             */
            if !title.is_empty() {
                put!("title", ns(title));
            }
            if !artist.is_empty() {
                put!("artist", ns(artist));
            }
            if !album.is_empty() {
                put!("albumTitle", ns(album));
            }
            if duration > 0.0 {
                put!("playbackDuration", num(duration));
            }
            // 已播秒数 + 速率 → 系统自己算进度条位置
            put!(
                "MPNowPlayingInfoPropertyElapsedPlaybackTime",
                num(position.max(0.0))
            );
            // 播放速率：系统靠它判断该显示播放键还是暂停键
            put!(
                "MPNowPlayingInfoPropertyPlaybackRate",
                num(if playing { 1.0 } else { 0.0 })
            );
            if let Some(art) = artwork(cover) {
                put!("artwork", art);
            }

            let Some(np_cls) = cls("MPNowPlayingInfoCenter") else {
                objc_autoreleasePoolPop(pool);
                return;
            };
            let center: Retained<AnyObject> = objc2::msg_send![np_cls, defaultCenter];
            let _: () = objc2::msg_send![&center, setNowPlayingInfo: &*info];

            objc_autoreleasePoolPop(pool);
        }
    }
}

/// Apple：Now Playing 卡片本身线程安全，不需要绕 run_on_main_thread。
/// （iOS 那个主线程敏感的音频会话配置只在 init 里做一次）
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn update(
    _app: &AppHandle,
    title: String,
    artist: String,
    album: String,
    playing: bool,
    cover: String,
    position: f64,
    duration: f64,
) {
    apple::apply(&title, &artist, &album, playing, &cover, position, duration);
}
