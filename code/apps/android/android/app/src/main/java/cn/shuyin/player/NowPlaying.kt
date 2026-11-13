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
}
