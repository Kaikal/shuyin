//! 定时关闭（睡眠定时器）——**桌面 / iOS 这一侧**。
//!
//! 安卓的真值在 Kotlin `SleepTimer.kt`（由播放服务每 250ms 对表）。iOS/桌面
//! 的播放引擎在 Rust 里，所以同一件事在这里做：用户设「30 分钟后停」或
//! 「播完这首就停」，到点由原生自己暂停——**不能靠前端 `setTimeout`**：
//!
//!   · 用户最需要定时的场景是「熄屏躺着听」，iOS 切后台后 WebView 的 JS 会被
//!     冻住，`setTimeout` 根本不走（同一根因坑过「放完一首就停」）；
//!   · 桌面收进托盘时主窗口虽然还在跑，但状态推送会被节流，同样不准。
//!
//! ## 为什么用墙钟
//!
//! 定时关的是「到点」，用户对表对的是墙上的钟。所以存的是
//! `SystemTime` 毫秒时间戳，不是 `Instant` 的经过时长（设备休眠时两个都会停，
//! 但墙钟至少和用户看到的一致）。
//!
//! ## 两种模式互斥
//!
//!   · `END_AT > 0`：N 分钟后暂停；
//!   · `AFTER_TRACK`：曲终不接下一首（由播放线程在曲终分支消费）。
//!
//! 定时器**不跨进程重启**：进程被杀就没了。这是刻意的——「昨天设的、今天还在
//! 倒计时」只会让人莫名其妙（和安卓那份保持同一语义）。

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};

/// 目标时间点（墙钟毫秒）；0 = 没开
static END_AT: AtomicI64 = AtomicI64::new(0);
/// 「播完当前这首就停」
static AFTER_TRACK: AtomicBool = AtomicBool::new(false);
/// 用户设的分钟数（回显 / 日志用；播完本曲时是 -1）
static MINUTES: AtomicI64 = AtomicI64::new(0);

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 设一个 N 分钟后关闭（`minutes <= 0` 等于关掉）。
pub fn set_minutes(minutes: i64) {
    if minutes <= 0 {
        clear();
        return;
    }
    MINUTES.store(minutes, Ordering::SeqCst);
    AFTER_TRACK.store(false, Ordering::SeqCst);
    END_AT.store(now_ms() + minutes.saturating_mul(60_000), Ordering::SeqCst);
    crate::player::log(&format!("sleep set {minutes}min"));
}

/// 播完当前这首就停。
pub fn set_end_of_track() {
    MINUTES.store(-1, Ordering::SeqCst);
    END_AT.store(0, Ordering::SeqCst);
    AFTER_TRACK.store(true, Ordering::SeqCst);
    crate::player::log("sleep set end-of-track");
}

pub fn clear() {
    if END_AT.load(Ordering::SeqCst) != 0 || AFTER_TRACK.load(Ordering::SeqCst) {
        crate::player::log("sleep clear");
    }
    END_AT.store(0, Ordering::SeqCst);
    AFTER_TRACK.store(false, Ordering::SeqCst);
    MINUTES.store(0, Ordering::SeqCst);
}

/// 给前端的状态：(剩余秒数, 是否「播完本曲」)。
/// 没开 = (0, false)；播完本曲没有时间点，`remain` 恒 0。
pub fn state() -> (i64, bool) {
    let track = AFTER_TRACK.load(Ordering::SeqCst);
    let end = END_AT.load(Ordering::SeqCst);
    let remain = if end > 0 {
        ((end - now_ms()).max(0) + 999) / 1000
    } else {
        0
    };
    (remain, track)
}

/// 计时模式到点了吗（一次性：读到就清掉，调用方负责暂停）。
pub fn due() -> bool {
    let end = END_AT.load(Ordering::SeqCst);
    if end > 0 && now_ms() >= end {
        END_AT.store(0, Ordering::SeqCst);
        MINUTES.store(0, Ordering::SeqCst);
        return true;
    }
    false
}

/// 曲终分支问一次：true = 「播完这首就停」已生效，**不要接下一首**。
/// 读过即消费（一次性），由播放线程在曲终时调用。
pub fn stop_after_track() -> bool {
    if AFTER_TRACK.swap(false, Ordering::SeqCst) {
        MINUTES.store(0, Ordering::SeqCst);
        true
    } else {
        false
    }
}
