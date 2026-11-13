package cn.shuyin.player

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.text.TextPaint
import android.text.TextUtils
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import kotlin.math.abs
import kotlin.math.max


/**
 * 悬浮歌词：真正的「显示在其他应用上层」窗口。
 *
 * 通知栏那颗「词」、播放页「更多」里的开关，开的都是这个窗。
 * 为什么必须走 WindowManager 而不是通知里的大字：后者收进通知栏就没了，
 * 用户要的是「边刷微信边看词」——那就只能浮窗。
 *
 * 排版按电脑端桌面歌词来（2026-11-01 用户明确要求）：
 *   · **上下两行**：上排大字是这一句，下排小字是下一句；
 *   · **左右错开**：行序号的奇偶决定谁在左谁在右，唱一句换一次边（经典 KTV 斜对角）；
 *   · **逐字染色**：这一句唱到哪个字，哪个字就变成高亮色，前端每 250ms 推一次进度；
 *   · **右上角常驻 ×**：不点歌词也能直接关掉；
 *   · 点歌词出调色板（七套配色，与桌面端 LYRIC_COLORS 同一批），按住可拖动，松手记住位置。
 *
 * 权限：SYSTEM_ALERT_WINDOW 是特殊权限，不能运行时弹框授权，
 * 只能跳系统设置页让用户手动开。第一次开启必然经历一次「跳出去授权」。
 */
@SuppressLint("ClickableViewAccessibility")
object FloatingLyrics {

    private val main = Handler(Looper.getMainLooper())
    private var wm: WindowManager? = null
    private var root: LinearLayout? = null
    private var lyric: LyricBoard? = null
    private var bar: LinearLayout? = null
    private var dots: MutableList<View> = ArrayList()
    private var playBtn: ImageButton? = null
    private var lp: WindowManager.LayoutParams? = null
    private var appCtx: Context? = null
    private var hideBar: Runnable? = null
    private var closeBtn: View? = null
    private var transportRow: View? = null
    private var idleTimer: Runnable? = null

    /** 「完整界面」是否展开：展开时才有底板、× 和播控；闲置/锁定后只剩两行字 */
    private var chromeOn = true

    /**
     * 锁定态（对齐 Windows 版桌面歌词）：只留字、点击穿透。
     * 锁上之后窗自己收不到触摸，只能从播放页「更多」里那颗开关解开。
     */
    @Volatile
    var locked = false
        private set

    private const val K_LOCK = "lock"
    /** 多久不动就收成纯字幕 */
    private const val IDLE_MS = 8000L

    /** 开关真值在原生侧：前端面板那颗开关只是显示（响应里带回这个） */
    @Volatile
    var shown = false
        private set

    /**
     * 开/关**真正落地之后**回调一次。
     *
     * `show()` 要 post 到主线程才建窗，`toggle()` 返回时 `shown` 还是旧值——
     * 通知里那颗「词」如果紧跟着读，永远读到上一次的状态。挂这个回调，
     * 等窗真的加上/拆掉再刷通知才准。
     */
    var onShownChanged: ((Boolean) -> Unit)? = null

    /* 窗口还没建起来时收到的内容先存着，建窗时直接有东西可画 */
    private var pendingCur = ""
    private var pendingNext = ""
    private var pendingProg = 0f
    private var pendingFlip = false
    private var pendingPlaying = false
    private var pendingTitle = ""

    private const val PREFS = "float_lyrics"
    /** 展开态的底板浓度（收起态直接 0，只剩字） */
    private val PLATE_COLOR = Color.argb(118, 12, 14, 22)
    private const val K_COLOR = "color"
    private const val K_Y = "y"

    /**
     * 配色：与桌面端 `LYRIC_COLORS` 完全一致（流金 / 品红 / 冰蓝 / 青碧 / 紫霞 / 霞橙），
     * 末尾多一颗纯白——浮在浅色壁纸、白底文档上时，暖色系全都会糊。
     */
    private val PALETTE = arrayOf(
        "流金" to "#FFC94D",
        "品红" to "#FF6FAE",
        "冰蓝" to "#7BA6FF",
        "青碧" to "#4FE0B0",
        "紫霞" to "#B98BFF",
        "霞橙" to "#FF8A4C",
        "纯白" to "#FFFFFF",
    )
    private var colorIdx = 0

    fun toggle(ctx: Context) {
        if (shown) hide() else show(ctx)
    }

    /**
     * 开/关一次，并把「开关接下来应该是什么样」**立刻**回给前端。
     *
     * `show()` / `hide()` 都要 post 到主线程才真正建窗/拆窗，`toggle()` 返回时
     * `shown` 还是旧值——以前这里直接读 `stateJson()`，前端拿到的一定是
     * 「点之前」的那个状态：打开浮窗，面板里的开关还是关的（或反过来）。
     * 这就是用户说的「桌面歌词的开关显示不准确」。
     *
     * 真值仍然以原生为准：窗真的加上/拆掉时 `notifyFrontend()` 会再推一帧，
     * 期间前端先用这里返回的意图值显示，不会来回跳。
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
                val density = ctx.resources.displayMetrics.density
                fun dp(v: Int) = (v * density + 0.5f).toInt()
                val screenW = ctx.resources.displayMetrics.widthPixels
                val screenH = ctx.resources.displayMetrics.heightPixels
                val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                colorIdx = prefs.getInt(K_COLOR, 0).coerceIn(0, PALETTE.size - 1)
                NowPlaying.color = PALETTE[colorIdx].second
                appCtx = ctx.applicationContext
                /* 先按真实播放态画那颗播放键，别等前端下一次 250ms 的心跳 */
                pendingPlaying = PlaybackService.playingNow()

                val col = LinearLayout(ctx).apply {
                    orientation = LinearLayout.VERTICAL
                    gravity = Gravity.CENTER
                }

                /*
                 * 歌词板：两行字 + 右上角的 ×，两者叠在同一个 FrameLayout 里。
                 *
                 * **窗宽就是整屏宽**（2026-11-01 用户定稿）：字幕条铺满屏幕，
                 * 上排贴左、下排贴右，整条压在其他应用上面，不随句子长短伸缩。
                 * 预算给满屏宽，板子内部再扣掉内边距和 × 的让位。
                 */
                val budgetW = screenW
                /* 两行**同一个字号**（2026-11-01 用户要求）：字幕条不做「大字+小字」的层级 */
                val board = LyricBoard(ctx, null, 17f, 17f).apply {
                    maxWidth = budgetW
                    hl = Color.parseColor(PALETTE[colorIdx].second)
                    setLines(pendingCur, pendingNext, pendingProg, pendingFlip)
                    fallback = pendingTitle
                }
                val holder = FrameLayout(ctx)
                /* 板子撑满整屏宽：底板就是一条全宽字幕条，字在上排贴左、下排贴右 */
                holder.addView(board, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))

                /* 右上角常驻关闭键：不点歌词、不出色板也能一秒关掉 */
                val close = TextView(ctx).apply {
                    text = "×"
                    setTextColor(Color.parseColor("#F2F3F7"))
                    textSize = 17f
                    gravity = Gravity.CENTER
                    setPadding(0, 0, 0, dp(2))
                    background = GradientDrawable().apply {
                        shape = GradientDrawable.OVAL
                        setColor(Color.argb(126, 10, 12, 18))
                    }
                    setOnClickListener { hide() }
                    contentDescription = "关闭悬浮歌词"
                }
                holder.addView(
                    close,
                    FrameLayout.LayoutParams(dp(30), dp(30), Gravity.TOP or Gravity.END).apply {
                        topMargin = dp(3)
                        marginEnd = dp(5)
                    },
                )
                closeBtn = close
                col.addView(holder, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))

                /* 胶囊底：三颗播控和七颗色点各自一枚，浮在别人家界面上一根细线就够 */
                fun pill(alpha: Int) = GradientDrawable().apply {
                    cornerRadius = dp(16).toFloat()
                    setColor(Color.argb(alpha, 12, 14, 22))
                }

                /* 播控三颗：直接复用通知栏那套矢量图标（这里不是 RemoteViews，可以正常 tint） */
                fun iconBtn(resId: Int, label: String, tap: () -> Unit): ImageButton =
                    ImageButton(ctx).apply {
                        setImageDrawable(inkDrawable(resId))
                        background = null
                        setPadding(dp(6), dp(6), dp(6), dp(6))
                        contentDescription = label
                        setOnClickListener { tap() }
                    }

                /*
                 * 播控**常显示**（2026-11-01 用户要求）：切歌暂停是高频动作，
                 * 不该藏在「先点一下歌词」后面。占的高只有 34dp，不碍事。
                 */
                val transport = LinearLayout(ctx).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(dp(8), dp(4), dp(8), dp(4))
                    background = pill(150)
                }
                transport.addView(
                    iconBtn(R.drawable.notif_prev, "上一首") { PlaybackService.sendAction("prev") },
                    LinearLayout.LayoutParams(dp(34), dp(34)),
                )
                val play = iconBtn(
                    if (pendingPlaying) R.drawable.notif_pause else R.drawable.notif_play,
                    "播放 / 暂停",
                ) { PlaybackService.sendAction("playpause") }
                transport.addView(
                    play,
                    LinearLayout.LayoutParams(dp(34), dp(34)).apply { marginStart = dp(20) },
                )
                transport.addView(
                    iconBtn(R.drawable.notif_next, "下一首") { PlaybackService.sendAction("next") },
                    LinearLayout.LayoutParams(dp(34), dp(34)).apply { marginStart = dp(20) },
                )
                /*
                 * 这里原本还有一颗「锁定」（锁上只剩字 + 点击穿透）。
                 *
                 * 拿掉了：锁上之后这扇窗自己收不到任何触摸，解锁入口只能放在**别处**
                 * （以前是播放页「更多 → 锁定悬浮歌词」），而用户明确要求那颗开关不要。
                 * 一个只能锁、锁了就再也点不动的按钮，比没有这个功能更糟。
                 * 锁定态本身留着（`setLocked`），但开窗一律从解锁态起步。
                 */
                transportRow = transport
                col.addView(
                    transport,
                    LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { topMargin = dp(4) },
                )

                /* 色板：点一下歌词才出来（二次点击），6 秒自收 */
                val dotsRow = LinearLayout(ctx).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    visibility = View.GONE
                    setPadding(dp(9), dp(6), dp(9), dp(6))
                    background = pill(200)
                }
                dots = ArrayList()
                PALETTE.indices.forEach { i ->
                    val dot = View(ctx).apply {
                        background = dotBg(dp(1), i, i == colorIdx)
                        setOnClickListener { applyColor(i) }
                        contentDescription = PALETTE[i].first
                    }
                    dotsRow.addView(
                        dot,
                        LinearLayout.LayoutParams(dp(20), dp(20)).apply {
                            marginStart = dp(3)
                            marginEnd = dp(3)
                        },
                    )
                    dots.add(dot)
                }
                col.addView(
                    dotsRow,
                    LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { topMargin = dp(4) },
                )

                val type = if (android.os.Build.VERSION.SDK_INT >= 26)
                    WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                else
                    @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE
                val params = WindowManager.LayoutParams(
                    WindowManager.LayoutParams.MATCH_PARENT,
                    WRAP_CONTENT,
                    type,
                    // 不要焦点：浮窗弹出时输入法、返回键都不归它，背景应用照常运行
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                        WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                    PixelFormat.TRANSLUCENT,
                ).apply {
                    gravity = Gravity.TOP or Gravity.START
                    /* 满宽窗没有横向可拖的余地，只存高度 */
                    x = 0
                    y = prefs.getInt(K_Y, dp(90)).coerceIn(0, (screenH - dp(80)).coerceAtLeast(0))
                }

                /*
                 * 拖动 + 点击。
                 *
                 * 监听挂在**容器**上而不是歌词上：ViewGroup 的触摸派发是「先给孩子、
                 * 孩子不要才轮到自己」，所以色点 / × 照样能点，空白处照样能拖。
                 * 位移超过 4dp 才算拖（手指抖一下不算），松手才落盘。
                 */
                var downX = 0f
                var downY = 0f
                var startY = 0
                var downAt = 0L
                var moved = false
                col.setOnTouchListener { v, ev ->
                    if (ev.pointerCount > 1) return@setOnTouchListener false
                    when (ev.actionMasked) {
                        MotionEvent.ACTION_DOWN -> {
                            downX = ev.rawX
                            downY = ev.rawY
                            startY = params.y
                            downAt = SystemClock.uptimeMillis()
                            moved = false
                            true
                        }
                        MotionEvent.ACTION_MOVE -> {
                            val dx = (ev.rawX - downX).toInt()
                            val dy = (ev.rawY - downY).toInt()
                            if (!moved && (abs(dx) > dp(4) || abs(dy) > dp(4))) moved = true
                            if (moved) {
                                /*
                                 * 只让上下拖：窗已经是满屏宽，横向没有可去的地方。
                                 * 纵向也要夹住——拖飞了用户就再也点不到这颗窗，只能去设置里关。
                                 */
                                val maxY = (screenH - v.height).coerceAtLeast(0)
                                params.x = 0
                                params.y = (startY + dy).coerceIn(0, maxY)
                                try { service.updateViewLayout(v, params) } catch (_: Exception) {}
                            }
                            true
                        }
                        MotionEvent.ACTION_UP -> {
                            if (!moved && SystemClock.uptimeMillis() - downAt < 320) {
                                /* 收起状态下点一下 = 重新把按钮和底板叫出来 */
                                if (!chromeOn) {
                                    setChrome(true)
                                    scheduleIdle()
                                } else {
                                    toggleBar()
                                }
                            } else {
                                savePos()
                                scheduleIdle()
                            }
                            true
                        }
                        MotionEvent.ACTION_CANCEL -> {
                            savePos()
                            true
                        }
                        else -> false
                    }
                }

                service.addView(col, params)
                wm = service
                root = col
                lyric = board
                bar = dotsRow
                playBtn = play
                lp = params
                shown = true
                /*
                 * 开窗一律**从解锁态起步**。
                 *
                 * 以前这里读存档：上次锁上了，这次一开就是「只剩字 + 点击穿透」，
                 * 而唯一的解锁入口（播放页「更多 → 锁定桌面歌词」）已经拿掉了——
                 * 用户会得到一块点不动、也关不掉的窗。现在锁定态只活在这一次会话里，
                 * 关掉再开就是正常可交互的窗。
                 */
                locked = false
                ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                    .putBoolean(K_LOCK, false).apply()
                syncLockUi()
                notifyFrontend(true)
                onShownChanged?.invoke(true)
            } catch (_: Exception) {
                /* 某些 ROM（多为权限被后台回收）addView 会抛，吞掉不影响播放 */
            }
        }
    }

    fun hide() {
        main.post {
            cancelBarTimer()
            cancelIdle()
            val v = root ?: return@post
            try { wm?.removeView(v) } catch (_: Exception) {}
            root = null
            lyric = null
            bar = null
            dots = ArrayList()
            playBtn = null
            wm = null
            lp = null
            shown = false
            /* 从浮窗上的 × 关掉时，播放页「更多」里那颗开关还亮着——通知前端一声 */
            notifyFrontend(false)
            onShownChanged?.invoke(false)
        }
    }

    /**
     * 前端推来的这一屏内容：当前句 / 下一句 / 本句进度 / 行序奇偶。
     *
     * 进度是每 250ms 一次的，窗口没开时只存不发；开了才 setLines —
     * 重绘很便宜（一块几十像素高的画布），但不能每首歌都白建一次窗口。
     */
    fun setLines(
        cur: String,
        next: String,
        prog: Float,
        flip: Boolean,
        playing: Boolean,
        title: String = "",
        around: List<String> = emptyList(),
    ) {
        pendingCur = cur
        pendingNext = next
        pendingProg = prog
        pendingFlip = flip
        if (title.isNotBlank()) pendingTitle = title
        /* 锁屏播放页读的是同一份镜像，顺手写下 */
        NowPlaying.cur = cur
        NowPlaying.next = next
        NowPlaying.prog = prog
        NowPlaying.flip = flip
        NowPlaying.playing = playing
        /* 锁屏页用它铺多行（±2）；悬浮窗不读，还是两行 */
        if (around.isNotEmpty()) NowPlaying.around = around
        if (title.isNotBlank()) NowPlaying.title = title
        main.post {
            /*
             * 播放键图标**以播放器的真实状态为准**，不信前端这一路。
             *
             * 前端那条推送（PlayerProvider 里 250ms 的心跳）原来漏了 playing
             * 这个依赖：暂停之后位置不再变化、歌词也不变，effect 压根不重跑，
             * 于是「点了暂停、确实停了，但浮窗上那颗键还是 ⏸」（用户原话）。
             * 前端那边已经补了依赖，这里再直接问一次媒体播放器——
             * 图标是状态机，不该依赖某一路消息有没有触发。
             */
            syncPlayIcon(PlaybackService.playingNow())
            val b = lyric ?: return@post
            b.fallback = pendingTitle
            b.setLines(cur, next, prog, flip)
            /* 换句会改窗宽：宽了就把窗往左拉回屏幕内，别被系统裁掉一截 */
            root?.post { clampPos() }
        }
    }

    /**
     * 播放 / 暂停变了：把浮窗上那颗键的图标换过来。
     *
     * 由 `PlaybackService.updateNotif()` 在每次 play / pause 之后直接调，
     * 不走前端、不等 250ms 心跳——这条路才是「按下去图标当场翻面」的保证。
     */
    fun setPlaying(playing: Boolean) {
        syncPlayIcon(playing)
    }

    /** 图标只在**真的变了**的时候重设：setImageDrawable 会重新分配 drawable，
        每 250ms 无脑设一次等于白建对象（浮窗常驻，不值得）。
        建窗时用的就是 `pendingPlaying`，所以「值没变」= 图标本来就是对的 */
    private fun syncPlayIcon(playing: Boolean) {
        if (pendingPlaying == playing) return
        pendingPlaying = playing
        main.post {
            playBtn?.setImageDrawable(
                inkDrawable(if (playing) R.drawable.notif_pause else R.drawable.notif_play),
            )
        }
    }

    fun setMeta(title: String) {
        pendingTitle = title
        main.post { lyric?.fallback = title }
    }

    /** 开关 + 当前配色，供前端面板显示（真值都在原生侧）；cur/next 顺带给调试用 */
    fun stateJson() = org.json.JSONObject()
        .put("on", shown)
        .put("lock", locked)
        .put("color", colorIdx)
        .put("cur", NowPlaying.cur)
        .put("next", NowPlaying.next)
        .put("prog", NowPlaying.prog.toDouble())

    /* ---------------- 内部 ---------------- */

    private fun notifyFrontend(on: Boolean) {
        PlaybackService.emit?.invoke("float://state", "{\"on\":$on}")
    }

    /** 通知栏那套白色矢量图标 → 染成浮窗用的近白色（普通 View 可以直接 setTint） */
    private fun inkDrawable(resId: Int): Drawable? =
        appCtx?.getDrawable(resId)?.mutate()?.apply { setTint(Color.parseColor("#F2F3F7")) }

    private fun dotBg(stroke: Int, i: Int, on: Boolean) = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(Color.parseColor(PALETTE[i].second))
        /* 选中的那一颗套白圈：只看颜色分不出「选的是哪颗」 */
        if (on) setStroke(stroke * 2, Color.WHITE)
        else setStroke(stroke, Color.argb(90, 255, 255, 255))
    }

    private fun applyColor(i: Int) {
        colorIdx = i.coerceIn(0, PALETTE.size - 1)
        lyric?.hl = Color.parseColor(PALETTE[colorIdx].second)
        lyric?.invalidate()
        NowPlaying.color = PALETTE[colorIdx].second
        val d = appCtx?.resources?.displayMetrics?.density ?: 3f
        val stroke = (1 * d + 0.5f).toInt().coerceAtLeast(1)
        dots.forEachIndexed { idx, v -> v.background = dotBg(stroke, idx, idx == colorIdx) }
        appCtx?.getSharedPreferences(PREFS, Context.MODE_PRIVATE)?.edit()
            ?.putInt(K_COLOR, colorIdx)?.apply()
        scheduleBarHide()
    }

    /**
     * 展开 / 收起「完整界面」。
     *
     * 收起态就是一条纯字幕：没有底板、没有 ×、没有播控，隔着别的应用看词不挡东西
     * （用户 2026-11-01：「长时间没点的时候只显示歌词文字」）。
     */
    private fun setChrome(on: Boolean) {
        chromeOn = on
        closeBtn?.visibility = if (on) View.VISIBLE else View.GONE
        transportRow?.visibility = if (on) View.VISIBLE else View.GONE
        if (!on) {
            bar?.visibility = View.GONE
            cancelBarTimer()
        }
        lyric?.plateColor = if (on) PLATE_COLOR else 0
        lyric?.invalidate()
        /* 窗口是 WRAP_CONTENT，显隐改了高度，得主动 relayout 一次 */
        root?.let { c -> lp?.let { p -> try { wm?.updateViewLayout(c, p) } catch (_: Exception) {} } }
    }

    private fun scheduleIdle() {
        cancelIdle()
        if (locked) return
        val r = Runnable { if (!locked) setChrome(false) }
        idleTimer = r
        main.postDelayed(r, IDLE_MS)
    }

    private fun cancelIdle() {
        idleTimer?.let { main.removeCallbacks(it) }
        idleTimer = null
    }

    /**
     * 锁定 / 解锁。
     *
     * 锁上：只留字 + `FLAG_NOT_TOUCHABLE`，触摸直接穿到下面那个应用。
     * **界面上已经没有锁定入口了**（那颗图标会让窗再也点不动，解锁只能靠关掉重开）。
     * 这个方法留着是给「开窗时强制解锁」用的，别在外面再挂开关。
     */
    fun setLocked(on: Boolean) {
        locked = on
        appCtx?.getSharedPreferences(PREFS, Context.MODE_PRIVATE)?.edit()
            ?.putBoolean(K_LOCK, on)?.apply()
        /* 桥命令从 WebView 线程进来，动 View 必须回到主线程（否则显隐改了但窗不重排） */
        main.post { syncLockUi() }
    }

    /** 按 [locked] 把窗口属性和「展开态」对齐一次 */
    private fun syncLockUi() {
        val p = lp ?: return
        p.flags = if (locked) {
            p.flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
        } else {
            p.flags and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE.inv()
        }
        if (locked) cancelIdle() else scheduleIdle()
        setChrome(!locked)
        root?.let { c -> try { wm?.updateViewLayout(c, p) } catch (_: Exception) {} }
    }

    private fun toggleBar() {
        val b = bar ?: return
        val c = root ?: return
        if (b.visibility == View.VISIBLE) {
            b.visibility = View.GONE
            cancelBarTimer()
        } else {
            b.visibility = View.VISIBLE
            scheduleBarHide()
        }
        /* 窗口是 WRAP_CONTENT：显隐会改高度，主动 relayout 一次，别等下次拖动才发现 */
        lp?.let { try { wm?.updateViewLayout(c, it) } catch (_: Exception) {} }
    }

    private fun scheduleBarHide() {
        cancelBarTimer()
        val r = Runnable {
            bar?.visibility = View.GONE
            root?.let { c -> lp?.let { p -> try { wm?.updateViewLayout(c, p) } catch (_: Exception) {} } }
            scheduleIdle()
        }
        hideBar = r
        main.postDelayed(r, 6000)
    }

    private fun cancelBarTimer() {
        hideBar?.let { main.removeCallbacks(it) }
        hideBar = null
    }

    private fun savePos() {
        val c = appCtx ?: return
        val p = lp ?: return
        /* 只落盘纵向位置：满宽窗横向恒为 0 */
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putInt(K_Y, p.y).apply()
    }

    /** 把窗拉回屏幕内（换句变宽、或拖到边缘之后） */
    private fun clampPos() {
        val c = root ?: return
        val p = lp ?: return
        val s = wm ?: return
        if (c.width <= 0 || c.height <= 0) return
        val dm = c.resources.displayMetrics
        val maxY = (dm.heightPixels - c.height).coerceAtLeast(0)
        val ny = p.y.coerceIn(0, maxY)
        if (ny == p.y) return
        p.x = 0
        p.y = ny
        try { s.updateViewLayout(c, p) } catch (_: Exception) {}
    }

    private fun requestPermission(ctx: Context) {
        main.post {
            Toast.makeText(
                ctx,
                "先在系统设置里允许「显示在其他应用上层」，再回来打开悬浮歌词",
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
