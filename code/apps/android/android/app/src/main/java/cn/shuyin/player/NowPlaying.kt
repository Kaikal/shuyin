package cn.shuyin.player

import android.graphics.Bitmap

/**
 * 当前播放面的只读镜像。
 *
 * 悬浮歌词和锁屏播放页都在**进程内自己画**，但它们拿不到前端 React 的状态：
 * 前端的歌词是 250ms 推一次到原生（`float_lyric`），播放状态在服务里。
 * 这里把两边都需要的字段收在一处，谁更新谁写、谁显示谁读，省得再穿一层回调。
 */
object NowPlaying {
    /** [around] 里当前句的下标：前后各三条 → 3 */
    const val AROUND_CUR = 3
    /** [around] 的长度：当前句 ±3。锁屏是整屏，五行填不满，会看着空 */
    const val AROUND_N = 7

    @Volatile var title = ""
    @Volatile var artist = ""
    @Volatile var album = ""
    @Volatile var cur = ""
    @Volatile var next = ""
    /**
     * 锁屏页的多行歌词：当前句前后各两条（固定 5 条，索引 [AROUND_CUR] 是当前句）。
     *
     * 悬浮窗只要两行就够（它是个小条），但锁屏页是整屏——用户要的是
     * 「像歌词页那样铺多行，正在唱的在中间，越远越淡」。
     */
    @Volatile var around: List<String> = emptyList()
    @Volatile var prog = 0f
    @Volatile var flip = false
    @Volatile var playing = false
    /** 播放位置 / 总时长（秒）。锁屏页的进度条读它——以前这一屏没有进度条，
     *  中间一大片空着，看着就像半成品。 */
    @Volatile var pos = 0.0
    @Volatile var dur = 0.0
    @Volatile var fav = false
    @Volatile var cover: Bitmap? = null
    @Volatile var color = "#FFC94D"

    /* ---------------- 歌词时间轴（锁屏页自己算） ---------------- */

    /**
     * 整首歌的「时间(ms) → 文本」，换歌时整份替换。
     *
     * 为什么不在原生里也算一遍：锁屏页要的是**跟人耳同步**。以前这些字段全靠前端
     * 每 250ms 推一次（`float_lyric`），而前端那条链上还压着 React 的提交阈值
     * （位置跨过半秒才提交一次）——两段延迟叠起来，金线比歌声慢半句到一句，
     * 用户一眼就能看出来。原生手里本来就有 `mp.currentPosition`（毫秒级、
     * 每 250ms 一 tick），把歌词表和播放位置放在同一个进程里算，误差就只剩一拍。
     *
     * 顺带把「页面被系统藏起来」这件事也解掉了：WebView 不绘制时前端照样推
     * 得出来（JS 没停），但推送节奏会被浏览器节流，而原生 tick 不受影响。
     */
    @Volatile private var tlT: LongArray = LongArray(0)
    @Volatile private var tlX: Array<String> = emptyArray()

    /** 原生手里有没有时间轴。没有时（老前端 / 歌词还没到）仍走前端推送那条路 */
    fun hasTimeline(): Boolean = tlT.isNotEmpty()

    /** 上一次算出的句号。-2 = 需要重算（刚换表），-1 = 还没到第一句 */
    private var tlIdx = -2
    /** 上一次写出去的进度（量化到 1%）。目标没变就不碰 View */
    private var tlProg = -1f

    fun setTimeline(times: LongArray, texts: Array<String>) {
        tlT = times
        tlX = texts
        tlIdx = -2
        tlProg = -1f
    }

    fun clearTimeline() {
        tlT = LongArray(0)
        tlX = emptyArray()
        tlIdx = -2
        tlProg = -1f
        cur = ""
        next = ""
        around = emptyList()
        prog = 0f
        flip = false
    }

    /**
     * 按播放位置（秒）重算当前句、上下文与句内进度。每个 tick 调一次。
     *
     * 只在**换句**时重建 [around] / [cur] / [next] / [flip]：`around` 换一份新 List
     * 会让歌词板 `requestLayout()` 一次，250ms 一次是白给主线程加活。
     */
    fun syncLyrics(posSec: Double) {
        val t = tlT
        if (t.isEmpty()) return
        val ms = if (posSec.isFinite() && posSec > 0) (posSec * 1000).toLong() else 0L

        /* 二分找「最后一个时间 <= 当前位置」的那句；前奏里没有，idx = -1 */
        var lo = 0
        var hi = t.size - 1
        var idx = -1
        while (lo <= hi) {
            val mid = (lo + hi) ushr 1
            if (t[mid] <= ms) { idx = mid; lo = mid + 1 } else hi = mid - 1
        }

        if (idx != tlIdx) {
            tlIdx = idx
            val arr = ArrayList<String>(AROUND_N)
            for (k in -AROUND_CUR..AROUND_CUR) {
                val j = idx + k
                arr.add(if (idx >= 0 && j >= 0 && j < tlX.size) tlX[j] else "")
            }
            around = arr
            cur = if (idx >= 0) tlX[idx] else ""
            next = if (idx >= 0 && idx + 1 < tlX.size) tlX[idx + 1] else ""
            flip = idx % 2 == 1
        }

        val p = if (idx < 0) 0f else {
            val start = t[idx]
            /* 最后一句没有下一句：按 4 秒算，和前端同一套约定 */
            val end = if (idx + 1 < t.size) t[idx + 1] else start + 4000L
            val span = (end - start).coerceAtLeast(400L)
            ((ms - start).toFloat() / span).coerceIn(0f, 1f)
        }
        val q = Math.round(p * 100) / 100f
        if (q != tlProg) {
            tlProg = q
            prog = q
        }
    }
}
