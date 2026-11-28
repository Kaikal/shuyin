//! iOS「灵动岛」：ActivityKit Live Activity 的 Rust 接线。
//!
//! ## 2026-11-28 起：**岛上完全交给系统**，这套只负责收拾历史遗留
//!
//! 用户定案「用系统那个，不要自绘」，设置里「用疏音胶囊替代系统『正在播放』」
//! 那一项也一并删掉。所以 iOS 上岛 = iOS 自带的「正在播放」：我们只管照常发
//! `MPNowPlayingInfoCenter`（见 `smtc::apply`），胶囊与展开态全由系统画，
//! 点一下开 App 也是系统行为。零权限、零配额、零扩展依赖，永远不会空。
//!
//! 本模块在这条路上是**惰性的**：Swift 侧启动时把存档 `shuyin.island.own`
//! 改回 false 并 end 掉还挂着的 activity，`on()` 恒 false → 心跳线程空转、
//! `smtc` 不压系统卡、`live()` 恒 false。
//!
//! 为什么彻底关掉：2026-11-27 为了让岛上只留我们的胶囊，把系统卡
//! `setNowPlayingInfo: nil` 压掉了；一旦我们的 activity 起不来（系统「实时活动」
//! 被关 / 扩展没嵌上 / 免费证书重装后授权重置），**岛上和锁屏一起变空**，
//! 表现就是「灵动岛没了 / 状态和歌对不上」。
//!
//! ## 保留的实现（开关恒关，走不到）
//!
//! 系统灵动岛长在摄像头挖孔周围，Live Activity 的 compact 视图画在挖孔两侧：
//! 点一下 = 打开疏音、长按 = 系统自动展开，都是系统默认行为。展开态由 Widget
//! 扩展渲染（`IslandWidget.swift`）。UI 必须放在 WidgetKit 扩展 target 里——
//! 扩展由 CI 的 `install-swift.rb` 现场建（`tauri ios init` 每次从零生成工程）。
//!
//! ## 跨 Rust↔Swift 一律 dlsym（项目铁律，理由见 lyrics_pip.rs 文件头）
//!
//! dlsym 的代价是 Swift 侧 `@_cdecl` 符号可能被 `-dead_strip` 剥掉，
//! 解法同款：App 启动时 dlsym 调一次 `shuyin_island_adopt` 点亮整个 object。

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

    /// 岛上此刻真的挂着我们的 activity 没有（开关开 ≠ 挂上了）。
    pub fn running() -> bool {
        let p = lookup("shuyin_island_running");
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

/// 开/关。2026-11-28 起设置里已经没有这颗开关，iOS 恒返回 false
/// （Swift 侧会顺手把历史遗留的 activity 收掉）。
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

/// **系统「正在播放」卡能不能被压掉** = 用户开了自绘胶囊 **且** 我们的 activity
/// 真的挂上了。
///
/// 只判 `on()` 是不够的：系统「实时活动」被拒、扩展没嵌上、请求失败时开关照样是
/// true，可 activity 根本没起来——这时再压系统卡，岛上和锁屏就一起空了
/// （2026-11-27 用户报「灵动岛没了」就是这个）。宁可不压，让系统卡顶上来。
/// 非 iOS 恒 false（安卓没有这个概念）。
#[cfg(target_os = "ios")]
pub fn live() -> bool {
    ffi::on() && ffi::running()
}

#[cfg(not(target_os = "ios"))]
pub fn live() -> bool {
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
