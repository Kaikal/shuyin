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

/// 要不要画**我们自己的**实时活动（灵动岛 + 锁屏那张卡）。
///
/// 2026-11-25 的反复：
///   1. 先开着 → 用户说锁屏出现两张卡（系统那张 + 我们这张），只要系统那张；
///   2. 关掉之后系统卡确实干净了，但**点击灵动岛打不开 App**——系统媒体会话
///      那张卡的点击落点由 SpringBoard 管，我们没有任何可挂的入口；
///   3. 用户对照酷狗（酷狗能点开）要求「灵动岛必须能打开应用」→ 改回 true；
///   4. 2026-11-26 用户连发三张图（灵动岛并排两个、锁屏两卡、授权提示卡），
///      明确「只要上面那个（系统播放卡），这个（自绘卡）不要」。
///
/// 最终按用户 11-26 的明确诉求关掉：锁屏 / 灵动岛只留系统媒体会话那张卡。
/// 代价是「点灵动岛回 App」失效（系统卡的点击由 SpringBoard 管，插不进手）——
/// 这是 iOS 的系统限制，和酷狗的差别只在于酷狗自己画了 Live Activity。
/// 要恢复时把这里改回 true 即可，Swift 侧全套 intent 都还在。
///
/// 关掉时 `init()` 会调一次 `ffi::end()` 清掉上一版遗留的卡，
/// `live_activity_sync()` 直接空转，`spawn_*ticker()` 都不起。
pub const DRAW_OWN_CARD: bool = false;


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
         * Swift 侧是 dlsym 动态查 shuyin_remote_command，静态引用链上看不到它。
         * 取一次地址让链接器看见（`-dead_strip` 已经关了，这里当零成本保险）。
         * **不能挪进 `if DRAW_OWN_CARD`**：CI 会校验这 8 个符号都在，
         * 少了直接判构建失败。
         */
        let _keep = shuyin_remote_command as *const ();
        std::hint::black_box(_keep);
        if DRAW_OWN_CARD {
            ffi::adopt();
        } else {
            /*
             * 上一版装上来的用户手里可能还挂着一条实时活动（锁屏第二张卡）。
             * 关掉之后不再有人推它，它会一直僵在那儿，所以启动时收一次摊。
             */
            ffi::end();
        }
        /*
         * 桌面歌词（画中画）的 Swift C 入口没有任何静态引用链，Release 的
         * -dead_strip 会剥掉 shuyin_pip_toggle 等符号 → dlsym 恒 NULL →
         * 开关永远返回 false。这里 dlsym 调一次 shuyin_pip_adopt 把整个
         * ShuyinLyricsPiP.swift 的 object 点亮保留（同灵动岛 adopt 机制）。
         */
        crate::lyrics_pip::adopt();
        if DRAW_OWN_CARD {
            /* 锁屏歌词：App 进后台后 JS 会被冻住，词得由原生自己往前推 */
            spawn_lyric_ticker();
            /* 状态对账：换歌 / 暂停发生在 JS 冻着的时候，岛和锁屏卡得由原生自己跟上 */
            spawn_state_ticker();
        }
        /* 桌面歌词（画中画）：200ms 一帧，只在用户开着的时候跑 */
        spawn_pip_ticker();
    }
}

/// 推送一次播放状态。换歌 / 播放暂停 / 拖动进度时调用。
///
/// 不要拿它当心跳用：进度条由系统自己走秒（`Text(timerInterval:)`），
/// 每秒推一次只会白白消耗 Live Activity 的更新预算。
#[tauri::command]
#[allow(unreachable_code)]
pub fn live_activity_sync(state: LiveState) -> Result<(), String> {
    /* 自绘卡关着：连序列化都没必要，直接空转（见 DRAW_OWN_CARD） */
    if !DRAW_OWN_CARD {
        let _ = state;
        return Ok(());
    }
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
        /*
         * 同曲更新（收藏 / 换句）时，前端这一帧的 `position` 可能是**旧的**。
         *
         * 典型经过：App 进后台，JS 被 iOS 冻住；用户点岛上的收藏 → Rust 乐观
         * 翻星并 push_last()（那时按锚点补到「现在」，是对的）→ 前端被事件唤醒，
         * 拿**冻住那一刻**的 `snapshot.position` 配一个「现在」的 anchor 再推一次。
         * widget 按 `anchor - position` 算出起点，进度条当场跳回旧位置；随后
         * 心跳发现 drift > 6s 又拽回真值。用户看到的就是「点收藏进度条跳到
         * 中间又立马跳回去当前播放时刻」（2026-11-25 反馈）。
         *
         * 进度真值只有原生知道（`current_position()` 从音频引擎现读，不依赖 JS）。
         * 只要还是同一首歌（标题 + 专辑没变，说明这不是切歌），就用原生快照的
         * position/duration 加当下 anchor 覆盖前端那份。切歌时标题会变，那一次
         * 照用前端的——它带的是新曲起点，原生这一刻可能还没把队列切过去。
         */
        let same_track = LAST
            .lock()
            .ok()
            .and_then(|g| {
                g.as_ref().map(|s| s.title == state.title && s.album == state.album)
            })
            .unwrap_or(false);
        if same_track {
            if let Some(app) = APP.get() {
                if let Some(p) = app.try_state::<Player>() {
                    let (_, _, pos, dur) = p.state_lite();
                    if let Some(app) = APP.get() {
                        crate::append_log(
                            app,
                            &format!(
                                "live.pos native {:.1} (front {:.1})",
                                pos, state.position
                            ),
                        );
                    }
                    state.position = pos.max(0.0);
                    if dur > 0.0 {
                        state.duration = dur;
                    }
                    state.anchor = unix_now();
                }
            }
        }
        if let Ok(mut g) = LAST.lock() {
            *g = Some(state.clone());
        }
        /*
         * 顺手把系统「正在播放」卡那颗 ♥ 也翻过来。
         *
         * 锁屏/控制中心的 ♥ 是 `likeCommand` 自己画的，和灵动岛那颗星是**两套 UI**：
         * 岛上点了收藏，岛上变实心，系统那张卡还是空心的（用户 2026-11-24
         * 「通知栏的收藏按钮状态不会切换」）。这里用同一份 fav 真值把它对齐。
         */
        crate::smtc::set_like(state.fav);
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

/// 当前句 + 句内进度（0~1）。画中画的字幕要按进度逐字染色，比 `line_at` 多这一步。
#[cfg(target_os = "ios")]
fn line_progress_at(pos: f64) -> (String, f64) {
    let Ok(g) = LYRICS.lock() else { return (String::new(), 0.0) };
    let (ts, xs) = &*g;
    if ts.is_empty() {
        return (String::new(), 0.0);
    }
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
        return (String::new(), 0.0);
    }
    let start = ts[lo - 1];
    /* 下一句的开头就是这一句的结尾；最后一句没有下一句，按 4 秒估算 */
    let end = ts.get(lo).copied().unwrap_or(start + 4.0);
    let prog = if end > start {
        ((pos - start) / (end - start)).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let mut text = xs[lo - 1].clone();
    if text.chars().count() > 60 {
        text = text.chars().take(60).collect();
    }
    (text, prog)
}

/// 桌面歌词（画中画）的心跳。
///
/// 200ms 一帧：句内进度要连得上，但画中画是常驻窗口、每秒重绘 5 次已经足够
/// （Swift 侧还会把进度量化到 2% 再决定要不要真重画）。
/// **只在开关打开时工作**——关着的时候这个线程几乎不占资源。
#[cfg(target_os = "ios")]
pub fn spawn_pip_ticker() {
    std::thread::spawn(|| loop {
        /*
         * 120ms 而不是 200ms：长句超过画布宽度时要靠这条心跳驱动跑马灯位移，
         * 200ms 只有 5 帧/秒，滚起来一顿一顿的。120ms 约 8 帧/秒，够连续，
         * 而且只有「开着桌面歌词」时才真正走到 IPC（上面 `on()` 的早退）。
         */
        std::thread::sleep(std::time::Duration::from_millis(120));
        if !crate::lyrics_pip::on() {
            continue;
        }
        let Some(app) = APP.get() else { continue };
        let Some(p) = app.try_state::<Player>() else { continue };
        let (playing, pos) = p.playing_and_pos();
        let (line, prog) = line_progress_at(pos);
        crate::lyrics_pip::update(&line, prog, playing);
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
         * 用户在画中画窗口上按了 ×：Swift 侧已经把开关真值改成关了，这里只要
         * 通知前端把界面上的开关拨回去。没有这一条，用户看着「开」的开关、
         * 实际上什么都没有——就是他报的「开关和是否显示不一致」。
         */
        "pipclosed" => {
            let _ = app.emit("pip://state", serde_json::json!({ "on": false }));
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
        /*
         * 回 App：2026-11-25 第四次修，这回走通了 intent。
         *
         * 之前这一支是空的——回 App 全靠 Link/widgetURL 的自定义 scheme，
         * 在 iOS 18 锁屏上被吞（用户实测：按钮全有反应，点空白处没反应）。
         * 现在 `ShuyinOpenIntent` 设了 openAppWhenRun=true，系统会先把 App 拉到
         * 前台再执行到这里。落一个标记让前端回前台取走、展开播放页——用文件
         * 而不是 emit，是因为 intent 执行时机早于 WebView 就绪，事件会丢。
         */
        "open" => {
            if let Some(dir) = app.path().app_cache_dir().ok() {
                let _ = std::fs::create_dir_all(&dir);
                let _ = std::fs::write(dir.join("open_now.flag"), b"1");
            }
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

/// 推送一次「换歌」。原生自己接了下一首（直链表 / 现场取链）时调。
///
/// 为什么要从原生推：那一瞬间后台 JS 还冻着，前端那条 `live_activity_sync`
/// 不会发生。少了这一推，锁屏/灵动岛就**整块停在上一首**——歌名不动、
/// 倒计时按上一首的时长走完停在那儿、播放键一直画着「暂停」。
/// 用户 2026-11-24 报的「倒计时结束了但歌还在播」「岛上的状态不跟 App 联动」
/// 都是这一条缺失造成的。
///
/// `art` 是 72×72 JPEG 的 base64（见 `coverart`）；空串就画音符占位。
pub fn push_track(
    title: &str,
    artist: &str,
    album: &str,
    art: &str,
    playing: bool,
    position: f64,
    duration: f64,
) {
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (title, artist, album, art, playing, position, duration);
    }
    #[cfg(target_os = "ios")]
    {
        /* 还没有任何一条 activity（用户没推过 / 开关关着）：别在这儿凭空造一条 */
        let Ok(mut g) = LAST.lock() else { return };
        let Some(s) = g.as_mut() else { return };
        s.title = title.to_string();
        s.artist = artist.to_string();
        s.album = album.to_string();
        s.art = art.to_string();
        /* 新的一首：上一首那句词、那颗星都不该留在卡上 */
        s.line = String::new();
        s.fav = false;
        s.playing = playing;
        s.position = position.max(0.0);
        if duration > 0.0 {
            s.duration = duration;
        }
        s.anchor = unix_now();
        s.big = BIG_ART.load(std::sync::atomic::Ordering::Relaxed);
        drop(g);
        flush();
    }
}

/// 状态对账线程：**原生自己发现「换歌了 / 暂停了」就直接推一次**。
///
/// 为什么不能只靠前端推：iOS 后台会把 WebView 的 JS 冻住，而原生接歌、系统
/// 中断、耳机线控这些动作都发生在 JS 冻着的时候。前端那一推要等用户打开 App
/// 才来——在这之前灵动岛和锁屏卡全是旧的（用户看到的就是「岛上的播放键不跟
/// App 联动」「倒计时走完了歌还在放」）。
///
/// 700ms 是「够快」和「别烧更新预算」的折中：只在**状态真的变了**（下标 /
/// 播放态 / 时长）时才推，正常播一首歌期间一次都不推（进度由系统自己走秒）。
#[cfg(target_os = "ios")]
pub fn spawn_state_ticker() {
    std::thread::spawn(|| {
        let mut last_idx: i64 = i64::MIN;
        let mut last_playing = false;
        let mut last_dur = -1.0f64;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(700));
            let Some(app) = APP.get() else { continue };
            let Some(p) = app.try_state::<Player>() else { continue };
            let (idx, playing, pos, dur) = p.state_lite();
            if idx < 0 {
                /* 没有在放的歌：什么都不用推（收摊由前端 live_activity_end 负责） */
                last_idx = i64::MIN;
                continue;
            }
            if idx != last_idx {
                /*
                 * 元信息得先拿到：`meta_of` 查的是原料链 / 直链表，启动那一两秒
                 * 里可能还没递到。拿不到就**不动 last_idx**，下一轮再试。
                 */
                let Some((title, artist, album, cover, hint)) = p.meta_of(idx) else { continue };
                last_idx = idx;
                last_playing = playing;
                last_dur = dur;
                /*
                 * 前端已经推过同一首（它比我们快的时候）：只记账，不再推。
                 * 每条更新都要占灵动岛的预算，能不推就不推。
                 */
                let already = LAST
                    .lock()
                    .ok()
                    .and_then(|g| g.as_ref().map(|s| s.title == title && s.album == album))
                    .unwrap_or(false);
                if already {
                    continue;
                }
                let art = crate::coverart::resolve(&cover)
                    .map(|a| a.b64)
                    .unwrap_or_default();
                crate::append_log(
                    app,
                    &format!("live.track idx={idx} \"{title}\" art={}B", art.len()),
                );
                push_track(
                    &title,
                    &artist,
                    &album,
                    &art,
                    playing,
                    pos,
                    if dur > 0.0 { dur } else { hint },
                );
                continue;
            }
            if playing == last_playing && (dur - last_dur).abs() <= 0.5 {
                /* 状态没变，再看一眼**进度有没有漂**（下面这段的理由） */
                let drift = {
                    let Ok(g) = LAST.lock() else { continue };
                    match g.as_ref() {
                        Some(s) => {
                            let expect = if s.playing {
                                s.position + (unix_now() - s.anchor).max(0.0)
                            } else {
                                s.position
                            };
                            pos - expect
                        }
                        None => 0.0,
                    }
                };
                /*
                 * 漂了 6 秒以上：卡上那条锚点是错的，重推一次真值。
                 *
                 * 什么时候会错：JS 在后台冻了几分钟，醒来时用一帧**很旧**的位置
                 * 推了一次（`snapshot.position` 还停在冻住那一刻），进度条和倒计时
                 * 就按那个错锚点走——用户看到「倒计时结束了，歌还在播」。
                 * 只在漂得多的时候纠正，正常走秒一次都不推。
                 */
                if drift.abs() <= 6.0 {
                    continue;
                }
                crate::append_log(app, &format!("live.drift {drift:+.1}s -> 重推"));
            }
            last_playing = playing;
            last_dur = dur;
            push_native_state(&app, playing);
        }
    });
}

#[cfg(target_os = "ios")]
fn unix_now() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

/// 把 LAST 原样推给 Swift（`push_last` 会先按锚点把进度补到「现在」，
/// 而刚构造出来的状态本身就是「现在」，不用再补）。
#[cfg(target_os = "ios")]
fn flush() {
    let json = {
        let Ok(g) = LAST.lock() else { return };
        match g.as_ref().and_then(|s| serde_json::to_string(s).ok()) {
            Some(j) => j,
            None => return,
        }
    };
    ffi::sync(&json);
}

#[cfg(target_os = "ios")]
fn toggle_playback(app: &AppHandle) {
    let Some(p) = app.try_state::<Player>() else { return };
    let (_, playing, _, _) = p.state_lite();
    if !p.has_track() {
        crate::append_log(app, "live.playpause ignored: no track");
        return;
    }
    if playing {
        p.pause();
    } else {
        p.resume();
    }
    crate::append_log(
        app,
        &format!("live.playpause -> {} (was {})", if playing { "pause" } else { "resume" }, playing),
    );
    /*
     * 立刻用**原生真值**把岛上的图标翻过来（前端醒来后会用绝对值覆盖一次）。
     *
     * `playing` 传**意图**而不是快照：`resume()` 只是往音频线程投了一条命令，
     * 紧接着读状态还会是 false——照抄就把刚翻过来的岛又推回暂停了。
     */
    push_native_state(app, !playing);
}

/// 用原生快照的位置/时长 + 指定的播放状态覆盖 LAST，然后重推一次。
#[cfg(target_os = "ios")]
fn push_native_state(app: &AppHandle, playing: bool) {
    let Some(p) = app.try_state::<Player>() else { return };
    /* 走 `state_lite`：`snapshot()` 会把「曲终」这个一次性标记读走 */
    let (_, _, pos, dur) = p.state_lite();
    let now = unix_now();
    {
        /* guard 必须圈在这个块里：push_last() 还要再锁一次（Mutex 不可重入） */
        let Ok(mut g) = LAST.lock() else { return };
        let Some(last) = g.as_mut() else { return };
        last.playing = playing;
        last.position = pos.max(0.0);
        if dur > 0.0 {
            last.duration = dur;
        }
        last.anchor = now;
    }
    /* 锁屏那张系统卡（Now Playing）也一起翻：它不经过 liveactivity 这条链路 */
    crate::smtc::refresh_state(playing, pos.max(0.0), dur);
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
