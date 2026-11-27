package cn.shuyin.player

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.RectF
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.hardware.display.DisplayManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.sin

/**
 * 灵动岛：贴在摄像头挖孔周围的迷你胶囊（酷狗同款形态）。
 *
 * 形态与手势对齐用户 2026-11-27 的描述：
 *   · **摄像头后面有一个胶囊**：黑色小药丸包住挖孔，两侧各两根波形条，
 *     播放时随节拍跳动，暂停时停住；
 *   · **点一下 = 回 App**（酷狗那颗 K 图标的用途）；
 *   · **长按 = 展开胶囊**：歌名 + 上一首 / 播放暂停 / 下一首，5 秒不动自动收起。
 *
 * 为什么必须是独立悬浮窗而不是长按通知：通知胶囊点开的是通知面板，
 * 没法「包住挖孔」，也做不到长按展开。系统层面能做到的就是
 * `TYPE_APPLICATION_OVERLAY` 窗口 + `LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS`
 * 开口子画进异形区（StatusLyrics 已验证这条路走得通）。
 *
 * 和桌面歌词（FloatingLyrics）、状态栏歌词（StatusLyrics）是**三个独立功能**，
 * 各走各的命令与存档（`float_lyrics` / `status_lyrics` / `dynamic_island`），
 * 不互相影响。
 *
 * 显示策略：开关打开后**播放期间常驻**（前后台都显示——挖孔就占那一小块，
 * 不挡任何操作），暂停超过宽限期整窗撤下，恢复播放自动回来。
 * 权限与桌面歌词共用 `SYSTEM_ALERT_WINDOW`：缺权限时只提醒不代跳
 * （用户 2026-11-23「缺啥权限告诉我，我自己去开」）。
 */
@SuppressLint("ClickableViewAccessibility")
object DynamicIsland {

    private val main = Handler(Looper.getMainLooper())
    private var wm: WindowManager? = null
    private var root: FrameLayout? = null
    private var pill: IslandPill? = null
    private var capsule: LinearLayout? = null
    private var titleView: TextView? = null
    private var playBtn: ImageButton? = null
    private var lp: WindowManager.LayoutParams? = null
    private var appCtx: Context? = null

    /** 用户开关（真值，落盘）。窗撤不撤看它 + 播放状态。 */
    @Volatile
    var enabled = false
        private set

    /** 窗当前真的挂着吗。 */
    @Volatile
    var shown = false
        private set

    /** 展开态（歌名 + 播控胶囊）还是收起态（包挖孔的小药丸）。 */
    @Volatile
    var expanded = false
        private set

    /** 最近一次播放状态（原生推送的镜像，宽限期判断用）。 */
    private var playing = false

    /* 窗没开时收到的内容先攒着 */
    private var pendingTitle = ""
    private var pendingArtist = ""

    private const val PREFS = "dynamic_island"
    private const val K_ON = "on"

    /** 暂停后过这么久才撤窗；期间恢复播放就直接续上。 */
    private const val PAUSE_GRACE_MS = 6000L

    /** 展开态不动多久自动收起。 */
    private const val IDLE_COLLAPSE_MS = 5000L

    /** 长按判定时长。 */
    private const val LONG_PRESS_MS = 420L

    /* ---------------- 尺寸（dp） ---------------- */

    /** 收起态：挖孔两侧各留这么宽画波形。 */
    private const val PILL_SIDE_DP = 24

    /** 收起态最小宽 / 高，没读到挖孔信息时的兜底。 */
    private const val PILL_MIN_W_DP = 88
    private const val PILL_MIN_H_DP = 30
    private const val PILL_MAX_H_DP = 44

    /** 展开态胶囊尺寸。 */
    private const val CAPSULE_W_DP = 248
    private const val CAPSULE_H_DP = 46

    private val BG = Color.argb(242, 12, 13, 18)
    private val INK = Color.parseColor("#F2F3F7")
    private val WAVE = Color.parseColor("#FFC94D")

    /* 各家 ROM 的 overlay 坐标原点不一定在屏幕绝对顶端（StatusLyrics 285 行同款坑），
       第一次摆完实测偏差记下来，之后按偏差换算 */
    private var biasX = 0
    private var biasY = 0
    private var calibrated = false

    /** 播放暂停后的撤窗任务（恢复播放要 cancel 它）。 */
    private var hideTask: Runnable? = null

    /** 展开态自动收起任务。 */
    private var collapseTask: Runnable? = null

    /* ---------------- 开关（前端设置页走这条） ---------------- */

    /**
     * 开 / 关一次，返回「接下来应该是什么样」。
     *
     * show/hide 都是 post 到主线程异步做的，返回时读取的是意图值，
     * 前端照它显示（对齐 FloatingLyrics.toggleState 的教训）。
     */
    fun toggleState(ctx: Context): org.json.JSONObject {
        enabled = !enabled
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putBoolean(K_ON, enabled).apply()
        if (!enabled) {
            expanded = false
            hide()
        } else {
            /* 关掉宽限：开着开关的那一拍，有歌就立刻把窗挂上 */
            cancelHide()
            if (PlaybackService.playingNow()) show(ctx)
        }
        return stateJson()
    }

    fun stateJson() = org.json.JSONObject()
        .put("on", enabled)
        .put("shown", shown)
        .put("playing", playing)
        .put("saw", try { Settings.canDrawOverlays(Sy.app) } catch (_: Throwable) { false })

    /* ---------------- 播放状态钩子（PlaybackService 调） ---------------- */

    /**
     * 播放 / 暂停变了（由 `updateNotif()` 推，与 FloatingLyrics.setPlaying 同一条路）。
     *
     * 播放中：开关开着就把窗挂上（没权限就静默——不每次播放都念叨）。
     * 暂停：宽限 [PAUSE_GRACE_MS] 后撤窗，恢复播放取消。
     */
    fun onPlaying(ctx: Context, now: Boolean) {
        playing = now
        if (!enabled) return
        if (now) {
            cancelHide()
            show(ctx)
        } else {
            cancelHide()
            val t = Runnable {
                hideTask = null
                expanded = false
                hide()
            }
            hideTask = t
            main.postDelayed(t, PAUSE_GRACE_MS)
        }
    }

    /** 换歌 / 元数据变了（由 ACT_META 推）。 */
    fun setMeta(title: String, artist: String) {
        pendingTitle = title
        pendingArtist = artist
        if (!shown) return
        main.post {
            titleView?.text = if (title.isBlank()) "疏音" else title
        }
    }

    /** 服务销毁：窗和状态全部复位，别留着悬在别人界面上。 */
    fun shutdown() {
        cancelHide()
        cancelCollapse()
        expanded = false
        playing = false
        hide()
    }

    /* ---------------- 开窗 / 撤窗 ---------------- */

    private fun show(ctx: Context) {
        if (shown) return
        if (!Settings.canDrawOverlays(ctx)) return
        main.post {
            if (shown) return@post
            try {
                val service = ctx.getSystemService(Context.WINDOW_SERVICE) as WindowManager
                appCtx = ctx.applicationContext
                calibrated = false

                val holder = FrameLayout(ctx)

                /* 收起态：包住挖孔的小药丸，两侧波形条 */
                val p = IslandPill(ctx)
                holder.addView(p, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT))

                /* 展开态：歌名 + 播控胶囊，先藏起来 */
                val cap = buildCapsule(ctx)
                cap.visibility = View.GONE
                holder.addView(cap, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT))

                val type = if (Build.VERSION.SDK_INT >= 26)
                    WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                else
                    @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE
                val params = WindowManager.LayoutParams(
                    WRAP_CONTENT,
                    WRAP_CONTENT,
                    type,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                        WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                    PixelFormat.TRANSLUCENT,
                ).apply {
                    gravity = Gravity.TOP or Gravity.START
                    /* 真正的位置由 placeWindow() 按挖孔算 */
                    if (Build.VERSION.SDK_INT >= 30) {
                        layoutInDisplayCutoutMode =
                            WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
                    } else if (Build.VERSION.SDK_INT >= 28) {
                        layoutInDisplayCutoutMode =
                            WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
                    }
                }

        /* 触摸手势：收起=点开 App / 长按展开；展开=点歌名收起，按钮各管各的 */
        attachGestures(holder)

                service.addView(holder, params)
                wm = service
                root = holder
                pill = p
                capsule = cap
                lp = params
                shown = true
                expanded = false
                p.visibility = View.VISIBLE
                cap.visibility = View.GONE
                p.playing = playing
                p.startBeat()
                titleView?.text = if (pendingTitle.isBlank()) "疏音" else pendingTitle
                placeWindow()
                notifyFrontend()
            } catch (_: Exception) {
                /* 个别 ROM 在权限被后台回收后 addView 会抛，吞掉不影响播放 */
            }
        }
    }

    private fun hide() {
        main.post {
            cancelCollapse()
            val v = root ?: return@post
            try { wm?.removeView(v) } catch (_: Exception) {}
            root = null
            pill = null
            capsule = null
            titleView = null
            playBtn = null
            wm = null
            lp = null
            shown = false
            expanded = false
            notifyFrontend()
        }
    }

    /* ---------------- 展开 / 收起 ---------------- */

    private fun expand() {
        if (!shown || expanded) return
        expanded = true
        cancelCollapse()
        pill?.visibility = View.GONE
        pill?.stopBeat()
        capsule?.visibility = View.VISIBLE
        titleView?.text = if (pendingTitle.isBlank()) "疏音" else pendingTitle
        syncPlayIcon()
        placeWindow()
        scheduleCollapse()
    }

    private fun collapse() {
        if (!shown || !expanded) return
        expanded = false
        cancelCollapse()
        capsule?.visibility = View.GONE
        pill?.visibility = View.VISIBLE
        pill?.startBeat()
        placeWindow()
    }

    private fun scheduleCollapse() {
        cancelCollapse()
        val t = Runnable {
            collapseTask = null
            collapse()
        }
        collapseTask = t
        main.postDelayed(t, IDLE_COLLAPSE_MS)
    }

    private fun cancelCollapse() {
        collapseTask?.let { main.removeCallbacks(it) }
        collapseTask = null
    }

    private fun cancelHide() {
        hideTask?.let { main.removeCallbacks(it) }
        hideTask = null
    }

    /* ---------------- 布局：算挖孔位置 ---------------- */

    /**
     * 挖孔区域（屏幕绝对坐标）。API 28+ 从 Display 拿；拿不到（无挖孔 / 旧系统）
     * 返回 null——药丸退化为屏幕顶部居中的一条。
     */
    private fun cutoutRect(): android.graphics.Rect? {
        if (Build.VERSION.SDK_INT < 28) return null
        val ctx = appCtx ?: return null
        return try {
            val dm = ctx.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
            val display = dm.getDisplay(android.view.Display.DEFAULT_DISPLAY) ?: return null
            val r = display.cutout?.boundingRectTop ?: return null
            if (r.isEmpty()) null else r        } catch (_: Exception) {
            null
        }
    }

    private fun density(): Float =
        appCtx?.resources?.displayMetrics?.density ?: 1f

    private fun dp(v: Int): Int = (v * density() + 0.5f).toInt()

    /** 收起态药丸尺寸（px）。宽 = 挖孔宽 + 两侧波形区；高贴齐挖孔高度。 */
    private fun pillSize(): IntArray {
        val r = cutoutRect()
        val w = max(
            PILL_MIN_W_DP.dpPx(),
            (r?.width()?.plus(2 * dp(PILL_SIDE_DP)) ?: dp(PILL_MIN_W_DP)),
        )
        val h = r?.height()?.coerceIn(dp(PILL_MIN_H_DP), dp(PILL_MAX_H_DP)) ?: dp(PILL_MIN_H_DP)
        return intArrayOf(w, h)
    }

    private fun Int.dpPx(): Int = dp(this)

    /** 挖孔中心（屏幕绝对坐标），读不到就取屏幕顶部正中。 */
    private fun cutoutCenter(): IntArray {
        val ctx = appCtx
        val screenW = ctx?.resources?.displayMetrics?.widthPixels ?: dp(PILL_MIN_W_DP)
        val r = cutoutRect()
        if (r != null && r.width() < screenW / 2) {
            return intArrayOf(r.centerX(), r.centerY())
        }
        /* 有些 ROM 的 boundingRectTop 是整条上边框的包围盒，那只能退回居中 */
        val sb = statusBarPx()
        return intArrayOf(screenW / 2, sb / 2)
    }

    private fun statusBarPx(): Int {
        val ctx = appCtx ?: return dp(24)
        return try {
            val id = ctx.resources.getIdentifier("status_bar_height", "dimen", "android")
            if (id > 0) ctx.resources.getDimensionPixelSize(id) else dp(24)
        } catch (_: Exception) {
            dp(24)
        }
    }

    /**
     * 把窗摆到「中心对齐挖孔中心」的位置（展开态也是同一个中心，
     * 对齐 iOS 灵动岛的原地展开）。首次摆放后实测一次坐标偏差校正
     * （各家 ROM overlay 原点不一致，见 StatusLyrics 的 topBias）。
     */
    private fun placeWindow() {
        val c = root ?: return
        val p = lp ?: return
        val s = wm ?: return
        val size = if (expanded)
            intArrayOf(dp(CAPSULE_W_DP), dp(CAPSULE_H_DP))
        else
            pillSize()
        /* 窗是 WRAP_CONTENT：内容 view 显式定尺寸，窗跟着内容走 */
        (if (expanded) c.findChild(capsule) else c.findChild(pill))?.let { v ->
            v.layoutParams = FrameLayout.LayoutParams(size[0], size[1])
        }
        c.requestLayout()
        val center = cutoutCenter()
        val tx = center[0] - size[0] / 2
        val ty = center[1] - size[1] / 2
        p.x = tx - biasX
        p.y = ty - biasY
        try { s.updateViewLayout(c, p) } catch (_: Exception) { return }
        if (calibrated) return
        c.post {
            val loc = IntArray(2)
            try { c.getLocationOnScreen(loc) } catch (_: Exception) { return@post }
            /* loc = lp + bias → bias = loc - lp */
            biasX = loc[0] - p.x
            biasY = loc[1] - p.y
            calibrated = true
            p.x = tx - biasX
            p.y = ty - biasY
            try { s.updateViewLayout(c, p) } catch (_: Exception) {}
        }
    }

    private fun FrameLayout.findChild(v: View?): View? = v?.takeIf { it.parent === this }

    /* ---------------- 展开态胶囊 ---------------- */

    @SuppressLint("ClickableViewAccessibility")
    private fun buildCapsule(ctx: Context): LinearLayout {
        val col = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            background = GradientDrawable().apply {
                cornerRadius = dp(23).toFloat()
                setColor(BG)
            }
            elevation = dp(6).toFloat()
            /* 手势挂在 holder 上（attachGestures），胶囊本身只把按钮事件放行 */
        }

        val title = TextView(ctx).apply {
            setSingleLine(true)
            ellipsize = android.text.TextUtils.TruncateAt.MARQUEE
            marqueeRepeatLimit = 2
            isSelected = true
            setTextColor(INK)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setPadding(dp(14), 0, dp(6), 0)
            /* 长按从 holder 触发，点歌名 = 收起 */
            setOnClickListener { collapse() }
        }
        col.addView(
            title,
            LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT, 1f),
        )
        titleView = title

        fun iconBtn(resId: Int, label: String, tap: () -> Unit): ImageButton =
            ImageButton(ctx).apply {
                setImageDrawable(inkDrawable(resId))
                background = null
                setPadding(dp(4), dp(4), dp(4), dp(4))
                contentDescription = label
                setOnClickListener { tap() }
            }

        col.addView(
            iconBtn(R.drawable.notif_prev, "上一首") {
                PlaybackService.sendAction("prev")
                scheduleCollapse()
            },
            LinearLayout.LayoutParams(dp(32), dp(32)),
        )
        val play = iconBtn(
            if (PlaybackService.playingNow()) R.drawable.notif_pause else R.drawable.notif_play,
            "播放 / 暂停",
        ) {
            PlaybackService.sendAction("playpause")
            scheduleCollapse()
        }
        col.addView(play, LinearLayout.LayoutParams(dp(32), dp(32)))
        playBtn = play
        col.addView(
            iconBtn(R.drawable.notif_next, "下一首") {
                PlaybackService.sendAction("next")
                scheduleCollapse()
            },
            LinearLayout.LayoutParams(dp(32), dp(32)),
        )
        return col
    }

    /** 图标只在真变了时重设（见 FloatingLyrics.syncPlayIcon 的注释）。 */
    private var pendingPlaying = false

    private fun syncPlayIcon() {
        val now = PlaybackService.playingNow()
        if (pendingPlaying == now) return
        pendingPlaying = now
        playing = now
        main.post {
            playBtn?.setImageDrawable(
                inkDrawable(if (now) R.drawable.notif_pause else R.drawable.notif_play),
            )
        }
    }

    /**
     * 收起态 / 展开态统一的手势。
     *
     * 收起：点一下 = 回 App（酷狗同款）；长按 = 展开。
     * 展开：点非按钮区 = 收起；按钮 click 自己消费事件到不了这里。
     * 位移超过 4dp 算拖动——这颗窗不做拖动，拖动一律取消手势。
     */
    private fun attachGestures(holder: FrameLayout) {
        var downX = 0f
        var downY = 0f
        var downAt = 0L
        var moved = false
        var longFired = false
        val longRunnable = Runnable {
            longFired = true
            expand()
        }
        holder.setOnTouchListener { _, ev ->
            if (ev.pointerCount > 1) return@setOnTouchListener false
            when (ev.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = ev.rawX
                    downY = ev.rawY
                    downAt = SystemClock.uptimeMillis()
                    moved = false
                    longFired = false
                    if (!expanded) main.postDelayed(longRunnable, LONG_PRESS_MS)
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    if (!moved && (abs(ev.rawX - downX) > dp(4) || abs(ev.rawY - downY) > dp(4))) {
                        moved = true
                        main.removeCallbacks(longRunnable)
                    }
                    true
                }
                MotionEvent.ACTION_UP -> {
                    main.removeCallbacks(longRunnable)
                    if (!longFired && !moved && SystemClock.uptimeMillis() - downAt < LONG_PRESS_MS) {
                        if (expanded) {
                            collapse()
                        } else {
                            openApp(holder.context)
                        }
                    }
                    true
                }
                MotionEvent.ACTION_CANCEL -> {
                    main.removeCallbacks(longRunnable)
                    true
                }
                else -> false
            }
        }
    }

    /** 点胶囊回 App（与 FloatingLyrics.openApp 同款：浮窗不关，拉起主任务）。 */
    private fun openApp(ctx: Context) {
        try {
            val i = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName) ?: return
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
            ctx.startActivity(i)
        } catch (_: Exception) { /* 没权限拉 Activity：不影响听歌 */ }
    }

    private fun notifyFrontend() {
        PlaybackService.emit?.invoke(
            "island://state",
            "{\"on\":$enabled,\"shown\":$shown}",
        )
    }

    private fun inkDrawable(resId: Int): Drawable? =
        appCtx?.getDrawable(resId)?.mutate()?.apply { setTint(INK) }

    /* ---------------- 收起态药丸（自绘） ---------------- */

    /**
     * 包住挖孔的黑色药丸：中段留空（摄像头透出来），左右各两根波形条。
     * 播放时波形按相位跳动（约 12fps 的 invalidate，开销极小），
     * 暂停时停成两根静置的短条。
     */
    private class IslandPill(ctx: Context) : View(ctx) {

        var playing: Boolean = false
            set(v) {
                field = v
                invalidate()
            }

        private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
        private val round = RectF()
        private var phase = 0f
        private var beating = false
        private val beat = object : Runnable {
            override fun run() {
                if (!beating) return
                phase += 0.45f
                invalidate()
                postDelayed(this, 80)
            }
        }

        fun startBeat() {
            if (beating) return
            beating = true
            postDelayed(beat, 80)
        }

        fun stopBeat() {
            beating = false
            removeCallbacks(beat)
        }

        override fun onDetachedFromWindow() {
            beating = false
            removeCallbacks(beat)
            super.onDetachedFromWindow()
        }

        override fun onDraw(canvas: Canvas) {
            val w = width.toFloat()
            val h = height.toFloat()
            round.set(0f, 0f, w, h)
            paint.color = BG
            canvas.drawRoundRect(round, h / 2f, h / 2f, paint)

            /* 波形条：左右各两根，中段（摄像头区域）留黑 */
            val side = w * 0.30f
            paint.color = WAVE
            val mid = h / 2f
            val maxBar = h * 0.46f
            val minBar = h * 0.16f
            /* 4 根条的位置比例（左 2 右 2） */
            val xs = floatArrayOf(
                w * 0.08f, w * 0.20f, w - w * 0.20f, w - w * 0.08f,
            )
            for (i in xs.indices) {
                val k = if (playing) {
                    0.55f + 0.45f * abs(
                        sin(phase + i * 1.1f),
                    )
                } else {
                    0.22f
                }
                val bar = minBar + (maxBar - minBar) * k
                canvas.drawRoundRect(
                    RectF(xs[i] - side * 0.10f, mid - bar / 2, xs[i] + side * 0.10f, mid + bar / 2),
                    side * 0.10f, side * 0.10f, paint,
                )
            }
        }
    }
}
