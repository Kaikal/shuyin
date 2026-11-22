package cn.shuyin.player

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.Toast

/**
 * 状态栏歌词：一条贴着屏幕顶端、水平居中的单行字幕。
 *
 * **和桌面歌词（[FloatingLyrics]）是两个独立功能，互不影响**（2026-11-22 用户明确要求）：
 *
 * | | 桌面歌词 | 状态栏歌词 |
 * |---|---|---|
 * | 位置 | 可拖动的两行 KTV 字幕条 | 固定贴顶；**水平位置可调**（贴左/居中/贴右） |
 * | 宽度 | 恒为满屏宽 | **可调**（35%~100%），面板里改 |
 * | 触摸 | 能拖、能点出色板、带播控 | **完全穿透**，不挡下面任何操作 |
 * | 关闭 | 窗上那颗 × | 只能从 App 弹窗里关 |
 * | 存档 | `float_lyrics` | `status_lyrics` |
 * | 配色 | 写 `NowPlaying.color`（锁屏跟着变） | **不碰 NowPlaying**，只染自己 |
 *
 * 为什么贴顶只能是「状态栏下方一条」：`TYPE_APPLICATION_OVERLAY` 的窗口层级低于
 * SystemUI，画不到状态栏那一行本身（普通 App 都做不到，所谓「状态栏歌词」类应用
 * 也是贴在状态栏下沿）。y=0 在这个坐标系里就是紧贴状态栏底边。
 *
 * 为什么触摸穿透：它是一条常驻字幕，挡住的却是整条屏幕顶部的下拉手势区——
 * 不穿透的话用户在状态栏附近下拉通知栏都会失灵。代价是窗自己收不到任何点击，
 * 所以开关和宽度只能放在 App 的弹窗里（这也是用户要的形态）。
 *
 * 权限与桌面歌词共用同一个 `SYSTEM_ALERT_WINDOW`：那边能开，这边就能开。
 */
@SuppressLint("StaticFieldLeak")
object StatusLyrics {

    private val main = Handler(Looper.getMainLooper())
    private var wm: WindowManager? = null
    private var root: FrameLayout? = null
    private var board: LyricBoard? = null
    private var lp: WindowManager.LayoutParams? = null
    private var appCtx: Context? = null

    /** 开关真值在原生侧：前端弹窗照它显示 */
    @Volatile
    var shown = false
        private set

    /* 窗口还没建起来时先攒着，建窗时一次画对（不然会闪一下空白） */
    private var pendingCur = ""
    private var pendingProg = 0f
    private var pendingTitle = ""

    private const val PREFS = "status_lyrics"
    private const val K_WIDTH = "width"
    private const val K_COLOR = "color"
    private const val K_POS = "pos"

    /**
     * 宽度下限 35%：再窄一点，一句正常长度的歌词就只剩省略号。
     * 上限就是满屏宽——比屏幕还宽没有意义（窗会被系统裁掉）。
     */
    private const val MIN_RATIO = 0.35f
    private const val MAX_RATIO = 1f

    /**
     * 默认 70%：留出两侧空白，**水平位置才有可调空间**。
     * 默认满屏的话，位置滑块一打开就是灰的（剩余空间为 0），
     * 看着像功能坏了——所以宁可默认窄一点。
     */
    private const val DEFAULT_RATIO = 0.7f

    /**
     * 配色：与桌面歌词同一批（流金 / 品红 / 冰蓝 / 青碧 / 紫霞 / 霞橙 / 纯白）。
     * 那边是 private，这里独立一份——**刻意不共享**，将来任何一边改配色都不会串味。
     */
    private val PALETTE = arrayOf(
        "#FFC94D",
        "#FF6FAE",
        "#7BA6FF",
        "#4FE0B0",
        "#B98BFF",
        "#FF8A4C",
        "#FFFFFF",
    )

    private var ratio = DEFAULT_RATIO
    private var colorIdx = 0

    /**
     * 水平位置：0 = 贴左、0.5 = 居中、1 = 贴右。
     *
     * 存的是**剩余空间的占比**，不是绝对像素——这样宽度一改、旋转屏、
     * 换分辨率，条子都还在同一个相对位置上，不会跑到屏幕外。
     * 宽度拉满（1.0）时剩余空间是 0，这个值就不起作用了（也没意义）。
     */
    private var posX = 0.5f

    /**
     * 按当前宽度与水平位置算出窗口 x（剩余空间按 [posX] 分配）。
     * 建窗和之后每次调宽度/位置都走这一处，避免两处各自算 x 走偏。
     */
    private fun xFor(screenW: Int, widthPx: Int): Int =
        ((screenW - widthPx) * posX).toInt().coerceAtLeast(0)

    /* 落盘走这一处，省得每个 setter 都抄一遍 getSharedPreferences */
    private fun put(key: String, v: Float) {
        appCtx?.getSharedPreferences(PREFS, Context.MODE_PRIVATE)?.edit()?.putFloat(key, v)?.apply()
    }

    private fun put(key: String, v: Int) {
        appCtx?.getSharedPreferences(PREFS, Context.MODE_PRIVATE)?.edit()?.putInt(key, v)?.apply()
    }

    /**
     * 开 / 关一次，并把「接下来应该是什么样」立刻回给前端。
     *
     * 与 [FloatingLyrics.toggleState] 同样的道理：`show()` 要 post 到主线程才建窗，
     * 返回时 `shown` 还是旧值，前端若紧跟着读 `stateJson()` 拿到的永远是上一次的状态。
     */
    fun toggleState(ctx: Context): org.json.JSONObject {
        if (shown) {
            hide()
            return stateJson().put("on", false)
        }
        if (!Settings.canDrawOverlays(ctx)) {
            requestPermission(ctx)
            return stateJson().put("on", false).put("needPermission", true)
        }
        show(ctx)
        return stateJson().put("on", true)
    }

    fun show(ctx: Context) {
        if (shown) return
        if (!Settings.canDrawOverlays(ctx)) {
            requestPermission(ctx)
            return
        }
        main.post {
            if (shown) return@post
            try {
                val service = ctx.getSystemService(Context.WINDOW_SERVICE) as WindowManager
                appCtx = ctx.applicationContext
                val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                ratio = prefs.getFloat(K_WIDTH, DEFAULT_RATIO).coerceIn(MIN_RATIO, MAX_RATIO)
                colorIdx = prefs.getInt(K_COLOR, 0).coerceIn(0, PALETTE.size - 1)
                posX = prefs.getFloat(K_POS, 0.5f).coerceIn(0f, 1f)

                val dm = ctx.resources.displayMetrics
                val widthPx = (dm.widthPixels * ratio).toInt().coerceAtLeast(1)

                val holder = FrameLayout(ctx)
                /*
                 * 单行：`next` 传空串，LyricBoard 的高度就只算一行（见它的 onMeasure）。
                 * 字号 15sp 比桌面歌词（17sp）小一档——这条字幕更窄也更常驻。
                 */
                val b = LyricBoard(ctx, null, 15f, 12f).apply {
                    maxWidth = widthPx
                    /* 没有关闭键，别给右上角留 42dp，否则整句看着像偏左 */
                    reserveClose = false
                    /* 状态栏字幕要居中，不是桌面歌词那种上左下右 */
                    alignCenter = true
                    /* 比桌面歌词的底板实一点：顶上这一条经常压在浅色壁纸/白底文档上 */
                    plateColor = Color.argb(200, 8, 10, 16)
                    hl = Color.parseColor(PALETTE[colorIdx])
                    fallback = pendingTitle
                    setLines(pendingCur, "", pendingProg, false)
                }
                holder.addView(b, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))

                val type = if (Build.VERSION.SDK_INT >= 26)
                    WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                else
                    @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE

                val params = WindowManager.LayoutParams(
                    widthPx,
                    WRAP_CONTENT,
                    type,
                    /*
                     * NOT_FOCUSABLE：不抢输入法和返回键。
                     * NOT_TOUCHABLE：整条穿透——它是字幕，不是控件，挡住顶部下拉手势区
                     * 比看不到歌词更糟。
                     *
                     * **刻意不加 LAYOUT_NO_LIMITS**：加上它窗口就能画进状态栏那一行，
                     * 把时间、信号、电量图标盖住（视觉上很脏）。不加的话 y=0 就是
                     * 「紧贴状态栏下沿」，全屏时状态栏消失则自动贴到屏幕最顶端——
                     * 两种情形都正好，也不需要去算状态栏高度。
                     */
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                        WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE,
                    PixelFormat.TRANSLUCENT,
                ).apply {
                    gravity = Gravity.TOP or Gravity.START
                    /* y=0 在这个坐标系里就是紧贴状态栏下沿（overlay 层级低于 SystemUI） */
                    y = 0
                    x = xFor(dm.widthPixels, widthPx)
                }

                service.addView(holder, params)
                wm = service
                root = holder
                board = b
                lp = params
                shown = true
                notifyFrontend(true)
            } catch (_: Exception) {
                /* 个别 ROM 在权限被回收后 addView 会抛：吞掉，不影响播放 */
            }
        }
    }

    fun hide() {
        main.post {
            val v = root ?: return@post
            try { wm?.removeView(v) } catch (_: Exception) {}
            root = null
            board = null
            wm = null
            lp = null
            shown = false
            notifyFrontend(false)
        }
    }

    /**
     * 喂当前句与进度（由 `float_lyric` 那条 250ms 的心跳带过来）。
     *
     * 窗口没开时只记不发：这里每 250ms 被调一次，没开窗时不该有任何对象分配。
     */
    fun setLines(cur: String, prog: Float, title: String = "") {
        pendingCur = cur
        pendingProg = prog
        if (title.isNotBlank()) pendingTitle = title
        if (!shown) return
        main.post {
            val b = board ?: return@post
            b.fallback = pendingTitle
            b.setLines(cur, "", prog, false)
        }
    }

    /** 调宽度（0.35~1.0 的屏宽比例），当场重排窗口，并落盘 */
    fun setWidth(r: Float) {
        ratio = r.coerceIn(MIN_RATIO, MAX_RATIO)
        put(K_WIDTH, ratio)
        main.post {
            val p = lp ?: return@post
            val c = root ?: return@post
            val s = wm ?: return@post
            val dm = c.resources.displayMetrics
            val w = (dm.widthPixels * ratio).toInt().coerceAtLeast(1)
            p.width = w
            /* 宽度一变，剩余空间跟着变——位置按同一个 posX 重算，条子不会跑偏 */
            p.x = xFor(dm.widthPixels, w)
            /*
             * maxWidth 是个普通字段，改了不会自己触发测量——
             * 必须显式 requestLayout，否则窗变窄了字还按旧预算排，右边被硬裁掉。
             */
            board?.let { b ->
                b.maxWidth = w
                b.requestLayout()
                b.invalidate()
            }
            try { s.updateViewLayout(c, p) } catch (_: Exception) {}
        }
    }

    /**
     * 调水平位置（0 贴左 ~ 0.5 居中 ~ 1 贴右）。
     *
     * 只动 x：宽度和字号没变，不需要 requestLayout，也不必重绘——拖动滑块时
     * 每次只做一次 updateViewLayout，比走 [setWidth] 那套轻得多。
     */
    fun setPos(v: Float) {
        posX = v.coerceIn(0f, 1f)
        put(K_POS, posX)
        main.post {
            val p = lp ?: return@post
            val c = root ?: return@post
            val s = wm ?: return@post
            p.x = xFor(c.resources.displayMetrics.widthPixels, p.width)
            try { s.updateViewLayout(c, p) } catch (_: Exception) {}
        }
    }

    /** 调配色（索引对齐 [PALETTE]）；**不写 `NowPlaying.color`**，锁屏颜色归桌面歌词管 */
    fun setColor(i: Int) {
        colorIdx = i.coerceIn(0, PALETTE.size - 1)
        put(K_COLOR, colorIdx)
        main.post { board?.hl = Color.parseColor(PALETTE[colorIdx]) }
    }

    /** 开关 + 宽度 + 水平位置 + 配色，供前端弹窗显示 */
    fun stateJson() = org.json.JSONObject()
        .put("on", shown)
        .put("width", ratio.toDouble())
        .put("pos", posX.toDouble())
        .put("color", colorIdx)

    private fun notifyFrontend(on: Boolean) {
        PlaybackService.emit?.invoke("status://state", "{\"on\":$on}")
    }

    private fun requestPermission(ctx: Context) {
        main.post {
            Toast.makeText(
                ctx,
                "先在系统设置里允许「显示在其他应用上层」，再打开状态栏歌词",
                Toast.LENGTH_LONG,
            ).show()
            try {
                val i = Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:${ctx.packageName}"),
                )
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                ctx.startActivity(i)
            } catch (_: Exception) {
                /* 个别 ROM 没有这个页面 */
            }
        }
    }
}
