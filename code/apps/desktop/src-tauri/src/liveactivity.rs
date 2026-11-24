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
    /// 当前那句歌词（空串 = 没有歌词，锁屏就不显示这一行）。
    ///
    /// 只在**换句那一刻**推一次，不要当心跳：ContentState 一次更新要序列化整份载荷，
    /// 每秒推会把 Live Activity 的更新预算烧光（表现是灵动岛越刷越慢）。
    #[serde(default)]
    pub line: String,
    /// 这首歌是不是已收藏（灵动岛/锁屏那颗星画实心还是空心）
    #[serde(default)]
    pub fav: bool,
    /// 锁屏卡放大封面（点封面切换，见 `handle_remote_command` 的 "art"）。
    ///
    /// 前端**不负责**这个字段：它只由灵动岛自己的点击改，Rust 侧记着真值，
    /// 每次 sync 都覆盖回去。前端要是也管，就有两份真值互相打架。
    #[serde(default)]
    pub big: bool,
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
        /* 锁屏歌词：App 进后台后 JS 会被冻住，词得由原生自己往前推 */
        spawn_lyric_ticker();
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
        let mut state = state;
        /* 放大封面是「灵动岛上的点击」定的，前端那份 payload 里没有它 */
        state.big = BIG_ART.load(std::sync::atomic::Ordering::Relaxed);
        /* 刚在岛上翻过收藏：这两秒里别让心跳把星又灭回去（见 FAV_GUARD） */
        if let Some(v) = fav_guard_of(&state.title) {
            if state.fav != v {
                if let Some(app) = APP.get() {
                    crate::append_log(
                        app,
                        &format!("live.fav guard \"{}\" push={} native={v}", state.title, state.fav),
                    );
                }
                state.fav = v;
            }
        }
        if let Ok(mut g) = LAST.lock() {
            *g = Some(state.clone());
        }
        let json = serde_json::to_string(&state).map_err(|e| e.to_string())?;
        ffi::sync(&json);
        Ok(())
    }
}

/* ------------------------------------------------------------------ */
/* 锁屏歌词：原生自己算当前句                                          */
/* ------------------------------------------------------------------ */

/// 一整首歌的歌词时间轴（秒, 文本），换歌时整表替换。
///
/// 为什么要搬到原生来算：iPhone 上的「桌面歌词」在系统层面做不到（iOS 不允许
/// 应用往别的 App 上面悬浮窗口，那是安卓的 SAW 权限），能显示歌词的地方只有
/// 锁屏卡 / 灵动岛。而那张卡的内容由前端推——App 进后台后 WebView 的 JS 会被
/// 系统冻住，词就停在冻住那一刻（酷狗那边看着「能显示」，是因为它的词由原生算）。
///
/// 所以这里存一张表，由下面那条后台线程按播放位置自己算当前句、自己推。
#[cfg(target_os = "ios")]
static LYRICS: std::sync::Mutex<(Vec<f64>, Vec<String>)> =
    std::sync::Mutex::new((Vec::new(), Vec::new()));

/// 一条歌词。字段与安卓 `lyric_timeline` 那条命令一致（`t` 秒 / `x` 文本）。
#[derive(serde::Deserialize)]
pub struct LyricLine {
    #[serde(default)]
    pub t: f64,
    #[serde(default)]
    pub x: String,
}

/// 前端把整首歌词的时间轴交过来（换歌时还会先发一条空表清场）。
///
/// 安卓走的是 Kotlin 那条同名命令；这里补齐 iOS / 桌面，前端才能不分平台地推。
#[tauri::command]
pub fn lyric_timeline(lines: Vec<LyricLine>) {
    #[cfg(not(target_os = "ios"))]
    {
        let _ = lines;
    }
    #[cfg(target_os = "ios")]
    {
        let mut ts = Vec::with_capacity(lines.len());
        let mut xs = Vec::with_capacity(lines.len());
        for l in lines {
            if l.x.is_empty() {
                continue;
            }
            ts.push(l.t);
            xs.push(l.x);
        }
        if let Ok(mut g) = LYRICS.lock() {
            *g = (ts, xs);
        }
    }
}

/// 按位置取「正在唱的那一句」（空串 = 还没到第一句 / 纯音乐）。
#[cfg(target_os = "ios")]
fn line_at(pos: f64) -> String {
    let Ok(g) = LYRICS.lock() else { return String::new() };
    let (ts, xs) = &*g;
    if ts.is_empty() {
        return String::new();
    }
    /* 二分找最后一个 t <= pos */
    let mut lo = 0usize;
    let mut hi = ts.len();
    while lo < hi {
        let mid = (lo + hi) / 2;
        if ts[mid] <= pos {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    if lo == 0 {
        return String::new();
    }
    let mut s = xs[lo - 1].clone();
    if s.chars().count() > 60 {
        s = s.chars().take(60).collect();
    }
    s
}

/// 后台线程：每 ~900ms 算一次当前句，变了才推（推一次就消耗一格更新预算）。
///
/// 900ms 的取样间隔对歌词足够（句与句之间通常好几秒），而「只有变了才推」
/// 把真正发出去的次数压到每句一次——进后台听一小时的歌也就几百次，
/// 和系统给本地更新的额度相比不算过分。JS 醒着的时候两边推的是同一句，
/// 不会来回跳。
#[cfg(target_os = "ios")]
pub fn spawn_lyric_ticker() {
    std::thread::spawn(|| {
        let mut last = String::new();
        loop {
            std::thread::sleep(std::time::Duration::from_millis(900));
            let Some(app) = APP.get() else { continue };
            let Some(p) = app.try_state::<Player>() else { continue };
            let (playing, pos) = p.playing_and_pos();
            if !playing {
                continue;
            }
            let line = line_at(pos);
            if line == last {
                continue;
            }
            let Ok(mut g) = LAST.lock() else { continue };
            let Some(s) = g.as_mut() else { continue };
            if s.line == line {
                last = line;
                continue;
            }
            s.line = line.clone();
            drop(g);
            last = line;
            push_last();
        }
    });
}

/// 收摊：队列清空、停止播放、用户关掉开关时调用。
#[tauri::command]
pub fn live_activity_end() -> Result<(), String> {    #[cfg(target_os = "ios")]
    {
        if let Ok(mut g) = LAST.lock() {
            *g = None;
        }
        ffi::end();
    }
    Ok(())
}

/* ------------------------------------------------------------------ */
/* 锁屏卡形态 / 状态缓存                                                */
/* ------------------------------------------------------------------ */

/// 锁屏卡是不是「大封面」形态（只有 iOS 会写它）。
///
/// 为什么要单独记：点封面这个动作发生在**扩展进程被点亮、主 App 进程里跑 intent**
/// 的时刻，那时前端 JS 可能冻着，指望它回推会把这一下吞掉。
#[cfg(target_os = "ios")]
static BIG_ART: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 最后一次推给 Swift 的载荷。
#[cfg(target_os = "ios")]
static LAST: std::sync::Mutex<Option<LiveState>> = std::sync::Mutex::new(None);

/// 刚从岛上翻过的收藏值 + 时刻 + 那首歌的标题。
///
/// 为什么需要这道闸：`fav` 的真值在前端（收藏列表只有它有一份），所以岛上那颗星
/// 是「Rust 先乐观翻一次，前端醒来再用真值对齐」。问题在于这两步之间有窗口——
/// 用户按星的同一瞬间，换句 / 暂停这些心跳也会各推一次 `live_activity_sync`，
/// 而它们带的是**翻之前**的 `fav`（前端那一刻还没处理完收藏写入）。
/// 那一条如果落在乐观翻转之后，星就又灭了，用户看到的就是「能收藏，但星不切换」。
///
/// 所以：记下刚翻的值，2 秒内同一首歌的推送里 `fav` 与它不一致就不用（用翻过的值）。
/// 2 秒足够跨过前端那一轮写库 + 重渲染；更久的真值变化（用户回 App 里取消收藏）
/// 照样能推下来。
#[cfg(target_os = "ios")]
static FAV_GUARD: std::sync::Mutex<Option<(String, bool, std::time::Instant)>> =
    std::sync::Mutex::new(None);

/// 乐观翻转留下的有效值（同一首歌、2 秒内）。
#[cfg(target_os = "ios")]
fn fav_guard_of(title: &str) -> Option<bool> {
    let Ok(g) = FAV_GUARD.lock() else { return None };
    let (t, v, at) = (*g).clone()?;
    if t == title && at.elapsed() < std::time::Duration::from_secs(2) {
        Some(v)
    } else {
        None
    }
}

/* ------------------------------------------------------------------ */
/* 灵动岛按钮 → 播放器                                                  */
/* ------------------------------------------------------------------ */

/// 处理来自灵动岛 / 锁屏卡片的按钮（Swift 侧 `LiveActivityIntent.perform()` 调）。
#[cfg(target_os = "ios")]
fn handle_remote_command(cmd: &str) {
    use tauri::Emitter;

    let Some(app) = APP.get() else { return };
    /*
     * 每一条都留痕。
     *
     * 灵动岛按钮的失败是**静默**的（Swift 侧 dlsym 查不到符号就 return，
     * 系统也不报错），用户看到的就是「点了没反应」。有这一行就能一刀切开：
     *   · 日志里没有 `live.cmd fav` → intent 根本没被系统执行
     *     （类型在 Release 下没导出，见 ShuyinIntents.swift 顶部的说明）；
     *   · 有，但星没翻 → 是推送到 ActivityKit 那一段的问题。
     */
    crate::append_log(app, &format!("live.cmd {cmd}"));
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
        /*
         * 收藏：真值在前端（收藏列表只有它有一份），但**先把岛上那颗星翻过来**。
         *
         * 因为前端 JS 在后台可能冻着，那条事件要等它醒过来才跑——用户点一下就
         * 盯着那颗星看，等几十秒不动等于「按钮坏了」。这里乐观翻一次，
         * 前端醒来后会用真值把载荷覆盖回去（它推的是绝对值，不是 toggle），
         * 所以不会翻两次。
         */
        "fav" => {
            {
                if let Ok(mut g) = LAST.lock() {
                    if let Some(s) = g.as_mut() {
                        s.fav = !s.fav;
                        /*
                         * 记下「刚翻成什么」，2 秒内挡住心跳里那份旧值
                         * （前端收藏写入是异步的，见 FAV_GUARD）。
                         */
                        if let Ok(mut fg) = FAV_GUARD.lock() {
                            *fg = Some((s.title.clone(), s.fav, std::time::Instant::now()));
                        }
                        crate::append_log(app, &format!("live.fav flip -> {} \"{}\"", s.fav, s.title));
                    }
                }
            }
            push_last();
            let _ = app.emit(
                "hotkey://action",
                serde_json::json!({ "id": "fav", "source": "live" }),
            );
        }
        /*
         * 点封面：锁屏卡在「大封面」和「普通卡（歌名 + 进度 + 一句词）」之间切换。
         *
         * 用户参考的是酷狗那张卡：点一下封面换成整屏封面，再点一下换回来。
         * 这个动作**不经过前端**——JS 在后台可能冻着，等它回推这一下就丢了，
         * 所以真值放在这里，直接拿上一份载荷重推一遍。
         */
        "art" => {
            let now = BIG_ART.load(std::sync::atomic::Ordering::Relaxed);
            BIG_ART.store(!now, std::sync::atomic::Ordering::Relaxed);
            push_last();
        }
        other => {
            crate::append_log(app, &format!("live.cmd unknown {other}"));
        }
    }
}

/// 拿上一份载荷重推一次（点封面切换形态用）。
///
/// 顺带把进度按锚点补到现在：载荷可能是几秒前推的，直接重推会让锁屏上的
/// 进度条往回跳一格。
#[cfg(target_os = "ios")]
fn push_last() {
    /* 先拷贝、松开锁再往下走：后面还要再锁一次写回去（Mutex 不可重入） */
    let snap = {
        let Ok(g) = LAST.lock() else { return };
        g.clone()
    };
    let Some(mut s) = snap else { return };
    if s.playing {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs_f64())
            .unwrap_or(s.anchor);
        let add = (now - s.anchor).max(0.0);
        s.position += add;
        if s.duration > 0.0 {
            s.position = s.position.min(s.duration);
        }
        s.anchor = now;
    }
    s.big = BIG_ART.load(std::sync::atomic::Ordering::Relaxed);
    if let Ok(mut g) = LAST.lock() {
        *g = Some(s.clone());
    }
    if let Ok(json) = serde_json::to_string(&s) {
        ffi::sync(&json);
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
    /*
     * 立刻用**原生真值**把岛上的图标翻过来。
     *
     * 以前这里只动了播放引擎，岛上那颗 ▶/⏸ 要等前端 JS 收到状态事件再推一次
     * `live_activity_sync` 才会变；主 App 在后台时 JS 被系统挂起，这一推可能
     * 几十秒都不到，用户看到的就是「歌在放，岛上还画着暂停」
     * （2026-11-23 反馈「灵动岛的状态和歌曲信息不匹配」）。
     * 现在按完就地更新 LAST 并重推，前端醒来后再用它的绝对值覆盖一次，不冲突。
     *
     * `playing` 传**意图**而不是快照：`resume()` 只是往音频线程投了一条命令，
     * 紧接着读快照还会是 false——照抄就把刚翻过来的岛又推回暂停了。
     * 位置/时长照抄快照（这两项此刻是准的：暂停时停在原地，恢复时也是原地起）。
     */
    push_native_state(app, !s.playing);
}

/// 用原生快照的位置/时长 + 指定的播放状态覆盖 LAST，然后重推一次。
#[cfg(target_os = "ios")]
fn push_native_state(app: &AppHandle, playing: bool) {
    let Some(p) = app.try_state::<Player>() else { return };
    let s = p.snapshot();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    {
        /* guard 必须圈在这个块里：push_last() 还要再锁一次（Mutex 不可重入） */
        let Ok(mut g) = LAST.lock() else { return };
        let Some(last) = g.as_mut() else { return };
        last.playing = playing;
        last.position = s.position.max(0.0);
        if s.duration > 0.0 {
            last.duration = s.duration;
        }
        last.anchor = now;
    }
    /* 锁屏那张系统卡（Now Playing）也一起翻：它不经过 liveactivity 这条链路 */
    crate::smtc::refresh_state(playing, s.position.max(0.0), s.duration);
    push_last();
}

/* ------------------------------------------------------------------ */
/* 自检：scheme 到底注册上没有                                          */
/* ------------------------------------------------------------------ */

/// `shuyin://live` 在本机能不能被打开。
///
/// 灵动岛 / 锁屏卡的 `Link` 与 `widgetURL` **只在 scheme 已注册时才有反应**：
/// 注册失败的表现不是「打开别的 App」，也不是「打开首页」，而是**点上去完全
/// 没反应**——所有点击事件被系统吞掉，连冷启动都不会发生。
///
/// 这个信息只能从 App 自己嘴里问出来（`canOpenURL`），CI 侧看不出来：
/// 即使 patch 逻辑跑过，也可能打在了错的 Info.plist 上。启动时记一行，
/// 下回用户回传 app.log 就能直接判死，不用再靠猜。
#[cfg(target_os = "ios")]
pub fn scheme_ok() -> Option<bool> {
    use objc2::class;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use std::ffi::CString;

    let c = CString::new("shuyin://live").ok()?;
    unsafe {
        /* 字符串/URL 全走裸 msg_send，和 smtc.rs 的 apple 模块同一套写法 */
        let s: Retained<AnyObject> =
            objc2::msg_send![class!(NSString), stringWithUTF8String: c.as_ptr()];
        let url: Retained<AnyObject> = objc2::msg_send![class!(NSURL), URLWithString: &*s];
        let app: Retained<AnyObject> = objc2::msg_send![class!(UIApplication), sharedApplication];
        let ok: bool = objc2::msg_send![&*app, canOpenURL: &*url];
        Some(ok)
    }
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
