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
//! Swift 侧实现见 `ios/ShuyinLyricsPiP.swift`；本文件只做 C 桥接线与心跳。
//!
//! ## 为什么是静态 `extern "C"` 而不是 dlsym
//!
//! 原来用 dlsym 运行时查 Swift 的 `@_cdecl` 符号，结果 Release 包里符号被
//! `-dead_strip` 剥掉、dlsym 恒返回 NULL，开关永远打不开（详见 ffi 模块注释）。
//! 改成静态声明后由链接器强制绑定：符号缺失会在 CI 链接期直接报错，不再静默降级。

#[cfg(target_os = "ios")]
mod ffi {
    use std::ffi::{c_char, CString};

    /*
     * 这里刻意**不用 dlsym**，改成静态 extern 声明（2026-11-25 第五轮定案）。
     *
     * 症状：iPhone 点「桌面歌词」开关，前端永远收到 false，toast「已关闭」。
     * 前端拿到的 false 只有两个来源：Swift `shuyinPiPToggle()` 首次点击必返回
     * true（wanted false→true），所以 false 只能来自下面的 dlsym 空指针分支。
     *
     * 死因：Swift 侧 `ShuyinPiP` 类没有任何**静态引用链**——`@_cdecl` 导出的
     * C 入口只被 Rust 在运行时 dlsym 查找，链接器看不到有人用它，Release 的
     * `-dead_strip` 就把符号剥掉了。dlsym 于是恒返回 NULL，开关恒 false。
     * 对比灵动岛能用：那边 `ShuyinLive` 被 live activity 入口静态引用，连带
     * `@_cdecl` 符号一起被保留。本项目 Rust 侧反向桥接（`shuyin_remote_command`）
     * 早有 `_keep` 防剥离的先例，只是这条 Rust→Swift 方向一直漏了。
     *
     * 静态声明的好处：
     *   1. 链接器直接绑定地址，不依赖 dyld 导出表，dead_strip 也剥不掉
     *      （Rust 静态库里的 undefined symbol 会强制 Xcode 去 Swift .o 里解析）；
     *   2. 万一 Swift 符号真没编进来，CI 链接期就报 undefined symbol，
     *      不再「静默降级」让人装 N 次包还查不出原因（fail fast）。
     *
     * 前提：install-swift.rb 把 ShuyinLyricsPiP.swift 装进主 App 且有回读校验；
     * 该函数 Swift 侧是 public + @_cdecl，符号名逐字对应下面三个声明。
     */
    extern "C" {
        fn shuyin_pip_set(line: *const c_char, prog: f64, playing: bool);
        fn shuyin_pip_toggle() -> bool;
        fn shuyin_pip_on() -> bool;
    }

    pub fn set(line: &str, prog: f64, playing: bool) {
        if let Ok(c) = CString::new(line) {
            unsafe { shuyin_pip_set(c.as_ptr(), prog, playing) };
        }
    }

    pub fn toggle() -> bool {
        unsafe { shuyin_pip_toggle() }
    }

    pub fn on() -> bool {
        unsafe { shuyin_pip_on() }
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
