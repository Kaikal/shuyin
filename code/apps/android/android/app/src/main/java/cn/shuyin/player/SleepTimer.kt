package cn.shuyin.player

import org.json.JSONObject

/**
 * 定时关闭（睡眠定时器）。
 *
 * ## 为什么放在原生而不是前端一个 `setTimeout`
 *
 * 息屏之后 WebView 的定时器会被系统摁住（同一根因已经坑过「放完一首就停」，
 * 见 PlaybackService.prefetch 的注释）。用户最需要定时的场景恰恰是**熄屏躺着听**：
 * 前端 setTimeout 在被冻结的进程里不会走，醒来一看歌还在放。
 * 所以真值放这边，由播放服务 250ms 一次的 tick 对表。
 *
 * ## 为什么用墙钟（currentTimeMillis）而不是 elapsedRealtime
 *
 * `elapsedRealtime` 在**深度睡眠期间会停**：用户设了 30 分钟、中途暂停播放放着不动，
 * 手机进深度睡眠，两小时后醒来发现「还剩 20 分钟」。定时关的是「到点」，用户对表
 * 对的是墙上的钟。代价是系统时间被手动改动时会有偏差——那个场景可以忽略。
 *
 * ## 状态
 *
 * `endAt == 0` 表示没开。「播完本曲」是另一种模式（`endOfTrack`）：它没有目标时间点，
 * 由 [PlaybackService] 在 onCompletion 里消费。两种模式互斥，设一个就清另一个。
 *
 * 定时器**不跨进程重启**：它在内存里，服务被回收 / 应用被杀就没了。这是刻意的——
 * 一个「昨天设的、今天还在倒计时」的定时器只会让人莫名其妙。
 */
object SleepTimer {

    /** 目标时间点（`System.currentTimeMillis()`）；0 = 没开 */
    @Volatile
    var endAt: Long = 0L
        private set

    /** 「播完当前这首就停」 */
    @Volatile
    var endOfTrack: Boolean = false
        private set

    /** 用户设的分钟数（仅用于回显 / 日志；播完本曲时是 -1） */
    @Volatile
    var minutes: Int = 0
        private set

    /** 设一个 N 分钟后关闭（N <= 0 等于关掉） */
    fun setMinutes(min: Int) {
        if (min <= 0) {
            clear()
            return
        }
        minutes = min
        endOfTrack = false
        endAt = System.currentTimeMillis() + min * 60_000L
        LockScreen.trace("sleep set ${min}min")
    }

    /** 播完当前这首就停 */
    fun setEndOfTrack() {
        minutes = -1
        endAt = 0L
        endOfTrack = true
        LockScreen.trace("sleep set end-of-track")
    }

    fun clear() {
        if (endAt != 0L || endOfTrack) LockScreen.trace("sleep clear")
        endAt = 0L
        endOfTrack = false
        minutes = 0
    }

    /** 还剩多少毫秒（没开 = 0，播完本曲 = -1 表示「没有时间点」） */
    fun remainMs(): Long = when {
        endOfTrack -> -1L
        endAt <= 0L -> 0L
        else -> (endAt - System.currentTimeMillis()).coerceAtLeast(0L)
    }

    /** 时间到了吗（播完本曲模式不由这里判） */
    fun due(): Boolean = endAt > 0L && System.currentTimeMillis() >= endAt

    /**
     * 给前端的状态。
     *
     * `remain` 用秒：前端只需要「还剩几分几秒」，毫秒精度没有意义，
     * 而且每秒都在变的数字越小越省事。
     */
    fun state(): JSONObject = JSONObject().apply {
        put("on", endAt > 0L || endOfTrack)
        put("track", endOfTrack)
        put("minutes", minutes)
        put("remain", if (endAt > 0L) ((remainMs() + 999) / 1000).toInt() else 0)
    }
}
