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
//! ## 为什么只能是 dlsym（不能用静态 `extern "C"`）
//!
//! iOS 上 Rust 先编成静态库，Swift 之后才由 Xcode 编译、链接。Rust 静态库
//! 里若写 `extern "C" { fn shuyin_pip_*(); }`，`cargo build` 阶段链接器就要
//! 解析这个符号，而 Swift 的 .o 此时还不存在 → 直接 undefined symbol，
//! 整个包编译失败（2026-11-25 实测，CI run 45557865951）。
//! 这就是项目铁律：**跨 Rust↔Swift 的桥只能两边都 dlsym**。
//!
//! dlsym 的代价是 Swift 侧 `@_cdecl` 符号可能被 Release 的 `-dead_strip` 剥掉
//! （链接器看不到静态引用）。解法见 `adopt()`：App 启动时 dlsym 调一次
//! `shuyin_pip_adopt`，那个 C 入口所在的 object 就被整个点亮保留。

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

    type SetFn = unsafe extern "C" fn(*const c_char, f64, bool, f64);
    type GetFn = unsafe extern "C" fn() -> bool;

    pub fn set(line: &str, prog: f64, playing: bool, dur: f64) {
        let p = lookup("shuyin_pip_set");
        if p.is_null() {
            crate::player::log("pip dlsym set: symbol NULL");
            return;
        }
        let f: SetFn = unsafe { std::mem::transmute(p) };
        if let Ok(c) = CString::new(line) {
            unsafe { f(c.as_ptr(), prog, playing, dur) };
        }
    }

    pub fn toggle() -> bool {
        let p = lookup("shuyin_pip_toggle");
        if p.is_null() {
            crate::player::log("pip dlsym toggle: symbol NULL");
            return false;
        }
        let f: GetFn = unsafe { std::mem::transmute(p) };
        unsafe { f() }
    }

    pub fn on() -> bool {
        let p = lookup("shuyin_pip_on");
        if p.is_null() { return false; }
        let f: GetFn = unsafe { std::mem::transmute(p) };
        unsafe { f() }
    }

    /// App 启动时调一次：dlsym 命中 `shuyin_pip_adopt` 这个 C 入口，
    /// 让链接器把 ShuyinLyricsPiP.swift 的整个 object 保留下来，
    /// 否则 -dead_strip 会剥掉 `shuyin_pip_toggle` 等符号，开关恒 false。
    pub fn adopt() {
        let p = lookup("shuyin_pip_adopt");
        if p.is_null() {
            crate::player::log("pip dlsym adopt: symbol NULL (will dead-strip)");
            return;
        }
        crate::player::log("pip dlsym adopt: OK");
        type Fn = unsafe extern "C" fn();
        let f: Fn = unsafe { std::mem::transmute(p) };
        unsafe { f() }
    }

    /// 前端把播放页画出来了：放行系统那条「放大回 App」的动画。
    ///
    /// 见 Swift 里 `restoreUserInterfaceForPictureInPictureStopWithCompletionHandler`
    /// 的注释：以前固定等 150ms 就回调，WebView 那会儿还没画完 → 放大落点是
    /// 一张黑屏，用户看到「黑一下再滑上来」。
    pub fn restore_ready() {
        let p = lookup("shuyin_pip_restore_ready");
        if p.is_null() {
            return;
        }
        type Fn = unsafe extern "C" fn();
        let f: Fn = unsafe { std::mem::transmute(p) };
        unsafe { f() }
    }
}

/// App 启动时点亮 Swift 侧 C 入口，防 -dead_strip 剥掉符号。
/// 非 iOS 空实现。
#[cfg(target_os = "ios")]
pub fn adopt() {
    ffi::adopt();
}

#[cfg(not(target_os = "ios"))]
pub fn adopt() {}

/// 推一帧：当前句 + 句内进度（0~1）+ 是否在播 + 当前曲时长（秒，0=未知）。
#[cfg(target_os = "ios")]
pub fn update(line: &str, prog: f64, playing: bool, dur: f64) {
    ffi::set(line, prog, playing, dur);
}

#[cfg(not(target_os = "ios"))]
pub fn update(_line: &str, _prog: f64, _playing: bool, _dur: f64) {}

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

/// 前端播完「回到播放页」这一帧了，放行画中画收尾动画。
#[cfg(target_os = "ios")]
pub fn restore_ready() {
    ffi::restore_ready();
}

#[cfg(not(target_os = "ios"))]
pub fn restore_ready() {}
