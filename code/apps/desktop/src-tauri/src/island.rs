//! iOS「灵动岛」：ActivityKit Live Activity 的 Rust 接线。
//!
//! ## 形态（用户 2026-11-27 按酷狗定稿，iPhone 是主目标）
//!
//! 系统灵动岛就长在摄像头挖孔周围，Live Activity 的 compact 视图画在挖孔两侧：
//! **点一下 = 打开疏音、长按 = 系统自动展开**——这两条都是系统默认行为，
//! 不用我们写一行手势代码。展开态由 Widget 扩展渲染（歌名 + 播控）。
//!
//! ## 为什么 UI 必须在 Widget 扩展里
//!
//! ActivityKit 的 `ActivityConfiguration` 只能放在 WidgetKit 扩展 target 里，
//! 主 App 只负责 `request` / `update` / `end`。扩展由 CI 的 `install-swift.rb`
//! 现场建 target（`tauri ios init` 每次都从零生成工程），共享的
//! `IslandAttributes` 两边各编一份。
//!
//! ## 为什么和画中画（lyrics_pip.rs）是两个独立功能
//!
//! 画中画是「边刷别的 App 边看词」，灵动岛是「锁屏/其它界面上那一小块
//! 播放状态」。开关、存档（`shuyin.island`）、心跳线程都各走各的。
//!
//! ## 跨 Rust↔Swift 一律 dlsym（项目铁律，理由见 lyrics_pip.rs 文件头）
//!
//! dlsym 的代价是 Swift 侧 `@_cdecl` 符号可能被 `-dead_strip` 剥掉，
//! 解法同款：App 启动时 dlsym 调一次 `shuyin_island_adopt` 点亮整个 object。
//!
//! ## 展开态的播控怎么回到主 App
//!
//! Live Activity 上的 `Button(intent:)` 跑在**扩展进程**里，dlsym 够不到
//! 主 App 二进制。用 Darwin 通知跨进程转发：扩展 post
//! `cn.shuyin.island.cmd.playpause` 等三条通知，主 App 侧的观察者收到后
//! dlsym 调 Rust 的 `shuyin_remote_command`（后台播歌时主 App 活着）。

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

    /// (title, artist, pos, playing, dur, art_ptr, art_len)
    /// art 是封面原图字节（JPEG/PNG 都行，Swift 侧自己压），只在换歌时传一次，
    /// 其余心跳传空切片——Swift 保留上一张，避免每 500ms 拖几十 KB 过 FFI。
    type SetFn = unsafe extern "C" fn(
        *const c_char, // title
        *const c_char, // artist
        f64,           // pos
        bool,          // playing
        f64,           // dur
        *const u8,     // art bytes
        usize,         // art len
    );
    type GetFn = unsafe extern "C" fn() -> bool;

    pub fn set(title: &str, artist: &str, pos: f64, playing: bool, dur: f64, art: &[u8]) {
        let p = lookup("shuyin_island_set");
        if p.is_null() {
            crate::player::log("island dlsym set: symbol NULL");
            return;
        }
        let f: SetFn = unsafe { std::mem::transmute(p) };
        let Ok(t) = CString::new(title) else { return };
        let Ok(a) = CString::new(artist) else { return };
        let art_ptr = if art.is_empty() {
            std::ptr::null::<u8>()
        } else {
            art.as_ptr()
        };
        unsafe { f(t.as_ptr(), a.as_ptr(), pos, playing, dur, art_ptr, art.len()) };
    }

    pub fn toggle() -> bool {
        let p = lookup("shuyin_island_toggle");
        if p.is_null() {
            crate::player::log("island dlsym toggle: symbol NULL");
            return false;
        }
        let f: GetFn = unsafe { std::mem::transmute(p) };
        unsafe { f() }
    }

    pub fn on() -> bool {
        let p = lookup("shuyin_island_on");
        if p.is_null() { return false; }
        let f: GetFn = unsafe { std::mem::transmute(p) };
        unsafe { f() }
    }

    /// 系统设置里「实时活动」允许了没有（false = 我们的 activity 根本起不来）。
    pub fn enabled() -> bool {
        let p = lookup("shuyin_island_enabled");
        if p.is_null() {
            crate::player::log("island dlsym enabled: symbol NULL");
            return false;
        }
        let f: GetFn = unsafe { std::mem::transmute(p) };
        unsafe { f() }
    }

    /// App 启动时调一次：点亮 ShuyinIsland.swift 的整个 object，
    /// 防 -dead_strip 剥掉 `shuyin_island_set` 等符号（开关会静默失效）。
    pub fn adopt() {
        let p = lookup("shuyin_island_adopt");
        if p.is_null() {
            crate::player::log("island dlsym adopt: symbol NULL (will dead-strip)");
            return;
        }
        crate::player::log("island dlsym adopt: OK");
        type Fn = unsafe extern "C" fn();
        let f: Fn = unsafe { std::mem::transmute(p) };
        unsafe { f() }
    }
}

/// App 启动时点亮 Swift 侧 C 入口。非 iOS 空实现。
#[cfg(target_os = "ios")]
pub fn adopt() {
    ffi::adopt();
}

#[cfg(not(target_os = "ios"))]
pub fn adopt() {}

/// 推一帧：歌名 / 歌手 / 播放位置（秒）/ 是否在播 / 当前曲时长（秒）/
/// 封面字节（只在换歌时给，其余传 `&[]` 表示沿用上一张）。
/// Swift 侧自己做节流：内容没变不 update（Live Activity 的 update 有系统配额）。
#[cfg(target_os = "ios")]
pub fn update(title: &str, artist: &str, pos: f64, playing: bool, dur: f64, art: &[u8]) {
    ffi::set(title, artist, pos, playing, dur, art);
}

#[cfg(not(target_os = "ios"))]
pub fn update(_title: &str, _artist: &str, _pos: f64, _playing: bool, _dur: f64, _art: &[u8]) {}

/// 开/关，返回关完之后应该显示的状态。非 iOS 恒 false。
#[cfg(target_os = "ios")]
pub fn toggle() -> bool {
    ffi::toggle()
}

#[cfg(not(target_os = "ios"))]
pub fn toggle() -> bool {
    false
}

/// 现在开着没有（用户开关，非「此刻有没有 activity」）。
#[cfg(target_os = "ios")]
pub fn on() -> bool {
    ffi::on()
}

#[cfg(not(target_os = "ios"))]
pub fn on() -> bool {
    false
}

/// 系统允许实时活动了没有。非 iOS 恒 true（安卓没有这个概念）。
#[cfg(target_os = "ios")]
pub fn enabled() -> bool {
    ffi::enabled()
}

#[cfg(not(target_os = "ios"))]
pub fn enabled() -> bool {
    true
}
