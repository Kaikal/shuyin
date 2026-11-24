//! iOS「桌面歌词」：画中画里的一条自绘字幕。
//!
//! ## 为什么是画中画
//!
//! iOS 沙箱不允许 App 往别人的界面上开悬浮窗（安卓的 `SYSTEM_ALERT_WINDOW`
//! 在这里没有对应物）。系统里唯一能合法浮在主屏 / 其他 App 之上的通道是
//! **画中画**：`AVPictureInPictureController` 支持 `AVSampleBufferDisplayLayer`
//! 作为内容源，而那个 layer 允许 App 自己喂帧——把歌词画成位图喂进去，
//! 窗口里显示的就是歌词。酷狗那条「桌面歌词」走的就是这条路（窗口上那颗
//! 方框箭头是系统给的「回到 App / 全屏」按钮）。
//!
//! Swift 侧实现见 `ios/ShuyinLyricsPiP.swift`；本文件只做 dlsym 接线与心跳。
//!
//! ## 为什么用 dlsym 而不是 `extern "C" { fn ... }`
//!
//! iOS 的 Rust 是编成静态库再交给 Xcode 链接的。Swift 文件万一某次没被装进
//! 主 App（见 `ios/install-swift.rb`），静态声明就是链接期 undefined symbol，
//! 整个包都出不来；dlsym 查不到只会让桌面歌词不出现——功能降级，包照样能装。

#[cfg(target_os = "ios")]
mod ffi {
    use std::ffi::{c_char, c_void, CString};

    extern "C" {
        fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    }

    /// RTLD_DEFAULT == (void *) -2
    const RTLD_DEFAULT: *mut c_void = -2isize as *mut c_void;

    fn lookup(name: &str) -> *mut c_void {
        let Ok(c) = CString::new(name) else { return std::ptr::null_mut() };
        unsafe { dlsym(RTLD_DEFAULT, c.as_ptr()) }
    }

    type SetFn = unsafe extern "C" fn(*const c_char, f64, bool);
    type GetFn = unsafe extern "C" fn() -> bool;

    pub fn set(line: &str, prog: f64, playing: bool) {
        let p = lookup("shuyin_pip_set");
        if p.is_null() {
            return;
        }
        let f: SetFn = unsafe { std::mem::transmute(p) };
        if let Ok(c) = CString::new(line) {
            unsafe { f(c.as_ptr(), prog, playing) };
        }
    }

    pub fn toggle() -> bool {
        let p = lookup("shuyin_pip_toggle");
        if p.is_null() {
            return false;
        }
        let f: GetFn = unsafe { std::mem::transmute(p) };
        unsafe { f() }
    }

    pub fn on() -> bool {
        let p = lookup("shuyin_pip_on");
        if p.is_null() {
            return false;
        }
        let f: GetFn = unsafe { std::mem::transmute(p) };
        unsafe { f() }
    }
}

/// 推一帧：当前句 + 句内进度（0~1）+ 是否在播。
#[cfg(target_os = "ios")]
pub fn update(line: &str, prog: f64, playing: bool) {
    ffi::set(line, prog, playing);
}

#[cfg(not(target_os = "ios"))]
pub fn update(_line: &str, _prog: f64, _playing: bool) {}

/// 开/关，返回关完之后应该显示的状态。非 iOS 恒 false。
#[cfg(target_os = "ios")]
pub fn toggle() -> bool {
    ffi::toggle()
}

#[cfg(not(target_os = "ios"))]
pub fn toggle() -> bool {
    false
}

/// 现在开着没有。
#[cfg(target_os = "ios")]
pub fn on() -> bool {
    ffi::on()
}

#[cfg(not(target_os = "ios"))]
pub fn on() -> bool {
    false
}
