package cn.shuyin.player

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.View
import android.view.animation.AccelerateDecelerateInterpolator
import android.view.animation.AccelerateInterpolator
import android.view.animation.OvershootInterpolator
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.ProgressBar
import android.widget.TextView
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.abs

/**
 * 锁屏播放页的「开关 + 平台权限」这一半（跟界面无关）。
 *
 * 以前它长在 `LockScreenActivity` 的 companion 里，现在页面并进了主 Activity
 * （见 [LockScreenPanel]），但这几个方法仍被 `Bridge` 的 `lock_state / lock_toggle /
 * lock_perm_open` 和设置页直接引用，所以单独拎成一个 object，签名保持不变。
 */
object LockScreen {

    private const val PREFS = "lock_screen"
    private const val K_ON = "on"
    /** 「上次提示用户去开系统权限」的时间戳（毫秒），用来做一天一次的节流 */
    private const val K_GUIDE_AT = "guide_at"
    /** 上一次「把窗口拉回来」是不是被系统拦了（设置页据此给「后台启动」的引导） */
    private const val K_BG_BLOCKED = "bg_blocked"
    private const val CH_LOCK = "lock_screen"

    /** MIUI 的「锁屏显示」appop（AGP 里没有这个名字，只能按数字用） */
    private const val MIUI_OP_SHOW_WHEN_LOCKED = 10020

    /**
     * MIUI 给 Intent 偷偷加的那个标志位：带上它，系统在 `checkActivityStart` 开头就放行，
     * 跳过 10020「锁屏显示」和 10021「后台弹出界面」两道 appop。
     */
    private const val MIUI_FLAG_SKIP_CHECK = 0x2

    @Volatile
    private var exempted = false

    /** 这个进程**实际**能不能给 intent 打上 MIUI 标志 */
    @Volatile
    private var miuiBypass = false

    /** 锁屏时要不要弹这一页（默认开：用户装了就想要这个能力） */
    fun enabled(ctx: Context): Boolean = try {
        prefs(ctx).getBoolean(K_ON, true)
    } catch (_: Exception) {
        true
    }

    fun setEnabled(ctx: Context, on: Boolean) {
        try { prefs(ctx).edit().putBoolean(K_ON, on).apply() } catch (_: Exception) { /* 存不下就按默认走 */ }
    }

    private fun isMiui(): Boolean = try {
        val mf = (Build.MANUFACTURER ?: "").lowercase()
        val brand = (Build.BRAND ?: "").lowercase()
        mf.contains("xiaomi") || mf.contains("redmi") || brand.contains("xiaomi") ||
            brand.contains("redmi") || brand.contains("poco") ||
            (Build.DISPLAY ?: "").uppercase().contains("MIUI")
    } catch (_: Throwable) {
        false
    }

    /** MIUI 的「锁屏显示」现在允不允许（null = 问不出来，比如非 MIUI） */
    private fun miuiShowWhenLocked(): Boolean? = try {
        val am = Sy.app.getSystemService(Context.APP_OPS_SERVICE) as android.app.AppOpsManager
        val m = android.app.AppOpsManager::class.java.getDeclaredMethod(
            "checkOpNoThrow",
            Int::class.javaPrimitiveType, Int::class.javaPrimitiveType, String::class.java,
        )
        val r = m.invoke(am, MIUI_OP_SHOW_WHEN_LOCKED, android.os.Process.myUid(), Sy.app.packageName) as Int
        r == android.app.AppOpsManager.MODE_ALLOWED
    } catch (_: Throwable) {
        null
    }

    /** MIUI 的 Intent 偷渡旗（10020/10021 两道 appop 一起绕）。服务拉起 LockActivity 前也要打 */
    fun addMiuiFlags(intent: Intent) {
        if (!isMiui()) { miuiBypass = false; return }
        if (!exempted) {
            exempted = true
            try {
                val vm = Class.forName("dalvik.system.VMRuntime")
                val get = vm.getDeclaredMethod("getRuntime")
                get.isAccessible = true
                val rt = get.invoke(null)
                val set = vm.getDeclaredMethod("setHiddenApiExemptions", Array<String>::class.java)
                set.isAccessible = true
                set.invoke(rt, arrayOf("Landroid/content/Intent;", "Lmiui/"))
            } catch (_: Throwable) { /* 被同一道闸拦着：下面那次反射自然也会失败 */ }
        }
        try {
            Intent::class.java
                .getMethod("addMiuiFlags", Int::class.javaPrimitiveType)
                .invoke(intent, MIUI_FLAG_SKIP_CHECK)
            miuiBypass = true
        } catch (_: Throwable) {
            miuiBypass = false /* 非 MIUI / 方法被裁掉 / 豁免没成功：原样发 */
        }
    }

    /*
     * 这里原本是 `bringMainUp()`：熄屏时把主窗口从后台顶到前台再挂 `showWhenLocked`，
     * 好让「在微信 / 浏览器 / 桌面里熄屏」也能看到整屏歌词页。2026-11-18 撤掉了。
     *
     * 撤掉的原因不是它不工作，而是它的代价：安卓上唯一能盖住锁屏的画布就是 Activity，
     * 一 Resume 就成了「用户当前的应用」，任务栈被我们重排到最前；退场只有
     * `moveTaskToBack`（语义 = 按 Home 键），解锁必然落到桌面 —— 用户原话
     * 「我们锁屏凭什么影响人家的应用」。
     *
     * 试过的两条补救都不成立：
     *   · 悬浮窗：keyguard 下系统隐藏所有非系统 overlay，实测 `isVisible=false`；
     *   · 使用情况访问记下熄屏前的前台再拉回来：真机判不准（华为浏览器被判成
     *     「不可返回」），还得额外要一个系统权限。
     *
     * 现在分两条路铺页（2026-11-18 晚）：
     *   · **疏音自己在前台时熄屏** → 还是主窗口里的那一层（见 [LockScreenPanel]），
     *     窗口本来就在，只需挂标志，见 `MainActivity.screenRx`；
     *   · **别的应用里熄屏** → 启动独立的 `LockActivity`（自有任务栈）铺页，
     *     主任务一个像素都不动，退场 `finish()` 后原应用亮回来 —— 不再有
     *     「moveTaskToBack = 按 Home → 解锁落桌面」。见 LockActivity 顶部注释。
     */

    private fun prefs(ctx: Context) =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** 熄屏拉起到底送没送到：由窗口收到 `EXTRA_LOCK_NOW` 时回打一下时间戳 */
    @Volatile
    private var ackAt = 0L

    fun markAck() {
        ackAt = System.currentTimeMillis()
    }

    fun ackedSince(t: Long) = ackAt >= t

    /** 跨应用锁屏拉起被 ROM 的「后台弹出界面」appop 静默拦了（设置页据此给引导） */
    fun markBgBlocked(ctx: Context) {
        try { prefs(ctx).edit().putBoolean(K_BG_BLOCKED, true).apply() } catch (_: Exception) {}
    }

    /**
     * 给设置页的状态。
     *
     * 三段各自 try/catch：这是**读状态**，任何一段出问题都不该让整条命令失败
     * （失败的表现是设置页那颗开关点不动、永远显示关——排查起来毫无线索）。
     */
    fun stateJson(ctx: Context): org.json.JSONObject {
        val o = org.json.JSONObject()
        try { o.put("on", enabled(ctx)) } catch (_: Throwable) {}
        try { o.put("miui", isMiui()) } catch (_: Throwable) {}
        try {
            o.put(
                "allowed",
                when (miuiShowWhenLocked()) {
                    true -> "allow"
                    false -> "deny"
                    null -> "unknown"
                },
            )
        } catch (_: Throwable) {
            try { o.put("allowed", "unknown") } catch (_: Throwable) {}
        }
        try {
            addMiuiFlags(Intent(ctx, MainActivity::class.java))
            o.put("bypass", miuiBypass)
        } catch (_: Throwable) {
            try { o.put("bypass", false) } catch (_: Throwable) {}
        }
        /*
         * 上一次熄屏拉起被系统拦了没有。这个只有**跑过一次**才知道
         * （系统静默丢弃，MIUI 的 10021 不在公开 AppOps 里）。
         */
        try { o.put("bgBlocked", prefs(ctx).getBoolean(K_BG_BLOCKED, false)) } catch (_: Throwable) {}
        /*
         * 悬浮窗（SAW）给没给。**跨应用熄屏拉起靠它豁免「后台弹出界面」**
         * ——华为平板 2026-11-21 实测：没给时 `startActivity` 返回 ok=true
         * 但锁屏页永远不出来（rejectTime 记在 appops 里）。设置页据此
         * 把开关锁住 + 给「去开启」的引导，不再让用户开一个
         * 必然不工作的功能。
         */
        try { o.put("saw", Settings.canDrawOverlays(ctx)) } catch (_: Throwable) {}
        return o
    }

    /**
     * 跳系统「显示在其他应用上层」的授权页（悬浮窗）。
     *
     * 和悬浮歌词那套文案分开：锁屏页要它的原因是「别的应用里熄屏时，
     * 得靠悬浮窗权限把锁屏页从后台压到 keyguard 上面」。
     */
    fun requestOverlayPerm(ctx: Context) {
        android.os.Handler(android.os.Looper.getMainLooper()).post {
            try {
                android.widget.Toast.makeText(
                    ctx,
                    "先在系统设置里允许「显示在其他应用上层」，跨应用熄屏才能弹出锁屏页",
                    android.widget.Toast.LENGTH_LONG,
                ).show()
                val i = Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${ctx.packageName}"))
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                ctx.startActivity(i)
            } catch (_: Throwable) { /* 个别 ROM 没有这个页面 */ }
        }
    }

    /**
     * 小米把「锁屏显示」拒了、我们又绕不过去 —— 这时候才需要打扰用户。
     * 只认**明确的 deny**：问不出来（null）就当作放行。
     */
    fun guideNeeded(ctx: Context): Boolean =
        isMiui() && !miuiBypass && miuiShowWhenLocked() == false

    /**
     * 熄屏拉起这条链的痕迹（release 包在华为上不出 logcat）。
     *
     * **必须异步写。** 早先是当场 `appendText`，而它被 `PlaybackService` 在
     * `setPlayingInService` / `open()` 里调用——也就是说**播放/暂停的主线程**
     * 上做了一次「打开外部存储文件 → 追加 → 关闭」。在线曲目正在下载、缓存正在
     * 落盘的时候盘面很忙，这一次追加能卡到**一秒以上**，于是用户按的暂停
     * 要等日志写完才轮到 —— 真机复现出来的形状正是「网络歌按暂停，声音又唱了
     * 一两秒才停；本地歌（不写盘）就没这个问题」。
     *
     * 现在只往内存队列里塞一行，由后台单线程按批刷盘，主线程一行 I/O 都不做。
     */
    private val traceQ = ArrayDeque<String>()
    private val traceLock = Any()
    @Volatile
    private var traceBusy = false
    private val traceThread = java.util.concurrent.Executors.newSingleThreadExecutor { r ->
        Thread(r, "sy-trace").apply { isDaemon = true }
    }

    fun trace(msg: String) {
        val line = java.text.SimpleDateFormat("MM-dd HH:mm:ss.SSS", java.util.Locale.US)
            .format(java.util.Date()) + " " + msg + "\n"
        val take: List<String>
        synchronized(traceLock) {
            traceQ.addLast(line)
            /* 写盘卡住时别把内存吃光：只留最近 500 行，多的丢老的 */
            while (traceQ.size > 500) traceQ.removeFirst()
            if (traceBusy) return
            traceBusy = true
            take = ArrayList(traceQ)
            traceQ.clear()
        }
        traceThread.execute {
            try {
                val dir = Sy.app.getExternalFilesDir(null)
                if (dir != null) {
                    val f = java.io.File(dir, "lock.log")
                    /*
                     * 64KB 太小：一天下来（每首歌两条 meta + 每轮 pf plan）不到半天就轮转，
                     * 「昨天还停过」这种事根本查不到前因。512KB 能覆盖两三天，
                     * 超了留一份 lock.log.1 再重建 —— 用户报「播着播着停了」时要看的是
                     * 停止**之前**那几首发生了什么。
                     */
                    if (f.exists() && f.length() > 512 * 1024) {
                        try {
                            val old = java.io.File(dir, "lock.log.1")
                            if (old.exists()) old.delete()
                            f.renameTo(old)
                        } catch (_: Throwable) {
                            f.delete()
                        }
                    }
                    f.appendText(take.joinToString(""))
                }
            } catch (_: Throwable) {
                /* 没存储权限就算了，不影响功能 */
            } finally {
                traceBusy = false
            }
        }
    }

    /** 「页面可能被挡住」的那条通知（一天最多一次） */
    fun postGuide(ctx: Context) {
        val now = System.currentTimeMillis()
        val p = try { prefs(ctx) } catch (_: Exception) { null }
        if (p != null && now - p.getLong(K_GUIDE_AT, 0L) < 24 * 3600_000L) return
        try { p?.edit()?.putLong(K_GUIDE_AT, now)?.apply() } catch (_: Exception) {}
        try {
            val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
            if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CH_LOCK) == null) {
                nm.createNotificationChannel(
                    android.app.NotificationChannel(
                        CH_LOCK, "锁屏播放页", android.app.NotificationManager.IMPORTANCE_HIGH,
                    ).apply { setSound(null, null); enableVibration(false) },
                )
            }
            val edit = Intent("miui.intent.action.APP_PERM_EDITOR")
                .addCategory(Intent.CATEGORY_DEFAULT)
                .setClassName(
                    "com.miui.securitycenter",
                    "com.miui.permcenter.permissions.PermissionsEditorActivity",
                )
                .putExtra("extra_pkgname", ctx.packageName)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            val pi = android.app.PendingIntent.getActivity(
                ctx, 2, edit,
                android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE,
            )
            val n = android.app.Notification.Builder(ctx, CH_LOCK)
                .setSmallIcon(R.mipmap.ic_notif)
                .setContentTitle("锁屏播放页被小米挡住了")
                .setContentText("点这里 →「其他权限」→ 打开「显示在锁屏上」")
                .setContentIntent(pi)
                .setAutoCancel(true)
                .setCategory(android.app.Notification.CATEGORY_ERROR)
                .setTimeoutAfter(10 * 60_000L)
                .build()
            nm.notify(0x5A18, n)
        } catch (_: Exception) { /* 没通知权限：设置页里那行说明还在 */ }
    }

    /**
     * 打开系统的权限页。
     *
     * 小米的「锁屏显示」只在它自己的权限编辑器里；其他系统退到应用详情页
     * （华为的「允许后台活动」在「应用启动管理」里，从这里也能找到入口）。
     */
    fun openPermissionEditor(ctx: Context): Boolean {
        if (isMiui()) {
            val tries = listOf(
                Intent("miui.intent.action.APP_PERM_EDITOR").addCategory(Intent.CATEGORY_DEFAULT),
                Intent("miui.intent.action.APP_PERM_EDITOR")
                    .addCategory(Intent.CATEGORY_DEFAULT)
                    .setClassName(
                        "com.miui.securitycenter",
                        "com.miui.permcenter.permissions.PermissionsEditorActivity",
                    ),
            )
            for (i in tries) {
                i.putExtra("extra_pkgname", ctx.packageName)
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                try {
                    ctx.startActivity(i)
                    return true
                } catch (_: Exception) { /* 换下一种写法 */ }
            }
        }
        val d = Intent(
            android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            android.net.Uri.parse("package:${ctx.packageName}"),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return try {
            ctx.startActivity(d)
            true
        } catch (_: Exception) {
            false
        }
    }
}

/**
 * 锁屏播放页 —— 现在是**主 Activity 里的一层覆盖视图**，不再是独立的 Activity。
 *
 * ## 为什么不再单开一个 Activity
 *
 * 用户的四条反馈其实是同一个根因：锁屏页一起来，主界面的 WebView 就被系统判定为
 * 「不可见」，JS **执行停摆**（实测 6 秒一次的 setInterval 一次都没跑，
 * 而 `performance.now()` 照走 —— 不是被杀，是冻住）。于是：
 *
 *   · 歌名 / 歌词 / 专辑不会更新 —— 前端那 250ms 一次的 `float_lyric` 推不出来；
 *   · 队列断了 —— 自动切歌整条链（take 直链 → play_url）捏在 JS 里，
 *     只有原生 `prefetch` 那 10 首能自己接，听完就停在两首之间；
 *   · 锁屏上的播放键点了「播的不是锁屏上这首」 —— 两个 Activity 各读一份状态，
 *     播放器却只有一个，谁先醒谁说了算。
 *
 * 并进主 Activity 之后这一层和 WebView 在**同一个窗口、同一个进程、同一份状态**里：
 * 熄屏时窗口仍在（带 showWhenLocked），WebView 不会 hidden，JS 继续跑，
 * 上面三条一起消失；也不用再 `startActivity`（华为上后台启动必被拦），
 * 更不用全屏意图（那玩意儿在鸿蒙上一定点亮屏幕）。
 *
 * ## 什么时候显示
 *
 * 由 [MainActivity] 决定（它管窗口标志），这里只负责「画」和「手势」。
 * 开关关着、或没在放歌，宿主根本不会把这一层拿上来 —— 此时行为与没有这个功能完全一致。
 *
 * ## 为什么它现在挂在**悬浮窗**上而不是 Activity 里
 *
 * 宿主是主 Activity（见 [MainActivity.showLockPanel]），但这里只跟 context / 回调
 * 打交道，一行 Activity 的代码都不该有——这样将来换宿主时不用动界面。
 */
class LockScreenPanel(
    ctx: Context,
    /** 这一层要收起时回调（true = 用户上滑 / 点提示条；false = 解锁、没歌了） */
    private val onDismiss: (byUser: Boolean) -> Unit,
) : FrameLayout(ctx) {

    /** 这一层现在是不是在演示（宿主据此决定窗口标志、WebView 显隐） */
    var shown = false
        private set

    /** 手动预览（播放页「更多 → 锁屏播放页」）：解锁时不自动收；息屏自动弹的则为 false */
    private var preview = false

    private val main = Handler(Looper.getMainLooper())

    private var board: LyricBoard? = null
    private var bg: ImageView? = null
    private var titleTv: TextView? = null
    private var artistTv: TextView? = null
    private var playBtn: ImageButton? = null
    private var favBtn: ImageButton? = null
    private var clock: TextView? = null
    private var date: TextView? = null
    private var posTv: TextView? = null
    private var durTv: TextView? = null
    private var bar: ProgressBar? = null

    private var lastCover: android.graphics.Bitmap? = null
    private var lastPlaying: Boolean? = null
    private var lastFav: Boolean? = null
    private var lastColor = ""
    /** 进度条只在千分比变化时才写，200ms 一 tick 不必每帧都碰 View */
    private var lastBar = -1
    /* 文本内容缓存：同名的 setText 也会重建 Layout 并触发整页测量 (见 sync) */
    private var lastTitle = ""
    private var lastArtist = ""
    private var lastPosText = ""
    private var lastDurText = ""

    /* ---------------- 上滑手势状态 ---------------- */
    /** 跟着手指走的是内容列（封面/压暗层留在原地，拖到一半也不会露出窗口黑底） */
    private var bodyView: View? = null
    /** 收页阈值：拖过这么多就飞出去（110dp ≈ 手指推过小半个屏） */
    private var limitPx = 0f
    /** 判定「这是拖，不是点」的最小位移 */
    private var slopPx = 0f
    private var downY = 0f
    private var downX = 0f
    private var lastY = 0f
    private var lastT = 0L
    /** px/ms，负值 = 往上 */
    private var vel = 0f
    /** 已经从子 View 手里收回手势（按钮不会再补发 click） */
    private var holding = false
    /** 底部「上滑收起」箭头的浮动动画 */
    private var arrowAnim: android.animation.ObjectAnimator? = null

    /** 进锁屏页之前悬浮歌词是开着的 → 退出时把它叫回来 */
    private var resumeFloat = false

    private val ticker = object : Runnable {
        override fun run() {
            if (!shown) return
            sync()
            /* 息屏没人看：200ms 的重绘（歌词补间 + 进度条）纯耗电，降到 1.5s 够用 */
            main.postDelayed(this, if (interactive()) 200 else 1500)
        }
    }

    private val clockTicker = object : Runnable {
        override fun run() {
            if (!shown) return
            tickClock()
            main.postDelayed(this, 10_000)
        }
    }

    init {
        visibility = GONE
        /* 这一层要自己吃触摸，否则点在空白处会穿透到底下的 WebView */
        isClickable = true
        LayoutInflater.from(ctx).inflate(R.layout.activity_lock, this, true)

        board = findViewById(R.id.lk_lyrics)
        bg = findViewById(R.id.lk_bg)
        titleTv = findViewById(R.id.lk_title)
        artistTv = findViewById(R.id.lk_artist)
        playBtn = findViewById(R.id.lk_play)
        favBtn = findViewById(R.id.lk_fav)
        clock = findViewById(R.id.lk_clock)
        date = findViewById(R.id.lk_date)
        posTv = findViewById(R.id.lk_pos)
        durTv = findViewById(R.id.lk_dur)
        bar = findViewById(R.id.lk_bar)

        /* 压暗层：上面留一点让时钟可读、中间透出封面、底部压死给播控 */
        findViewById<View>(R.id.lk_scrim).background = GradientDrawable(
            GradientDrawable.Orientation.TOP_BOTTOM,
            intArrayOf(
                Color.parseColor("#B3000000"),
                Color.parseColor("#1A000000"),
                Color.parseColor("#33000000"),
                Color.parseColor("#E6000000"),
            ),
        )

        /*
         * 歌词板的排版预算 = 屏幕宽 - 外层 26dp 左右内边距 × 2。
         * 预算给多了板子会撑出父容器被裁掉；给少了整句又被截半（悬浮窗那边踩过）。
         */
        val w = resources.displayMetrics.widthPixels
        board?.maxWidth = w - (52 * resources.displayMetrics.density).toInt()
        /*
         * 铺**多行**（当前句居中、上下渐远渐淡）：这一屏是整屏，只有两行字会显得空。
         */
        board?.multi = true
        board?.plateColor = Color.TRANSPARENT
        board?.hl = Color.parseColor(NowPlaying.color)

        findViewById<ImageButton>(R.id.lk_prev).apply {
            setImageResource(R.drawable.notif_prev)
            setColorFilter(Color.parseColor("#F2F3F7"))
            setOnClickListener { PlaybackService.sendAction("prev") }
        }
        findViewById<ImageButton>(R.id.lk_next).apply {
            setImageResource(R.drawable.notif_next)
            setColorFilter(Color.parseColor("#F2F3F7"))
            setOnClickListener { PlaybackService.sendAction("next") }
        }
        playBtn?.setOnClickListener {
            /*
             * 播放暂停**就地切**，不再绕 WebView。
             *
             * 以前这里发 `hotkey://action → 前端 togglePlay → 再下发 pause`：
             * 小米上从桌面熄屏进来时，主 Activity 可能已经被系统回收，Bridge 是空的，
             * 这一下就石沉大海（用户原话「小米上锁屏的按钮点了都没反应」）；华为上
             * 前端那份 playing 与播放器真实状态错半拍，一次点击被算成「继续播放」，
             * 于是「点了暂停，一下又开始播」。声音到底响不响只有播放器自己知道，
             * 通知栏那颗键早就是就地切了（见 `setPlayingInService`），这里跟它对齐。
             */
            val svc = PlaybackService.instance
            if (svc != null) svc.toggleFromUi()
            else PlaybackService.sendAction("playpause")
        }
        favBtn?.setOnClickListener { PlaybackService.sendAction("fav") }

        /*
         * 上滑解锁：**跟手，而且整屏都能拖**。
         *
         * 手势判在 [onInterceptTouchEvent]：点按照旧给按钮（不抢事件），
         * 一旦识别为「向上拖」就把事件从子 View 手里收回来 —— 框架会自动补一个
         * CANCEL 撤掉按下态，松手时不会补发 click（不然「上滑」会变成「上一首」）。
         */
        bodyView = findViewById(R.id.lk_body)
        limitPx = 110 * resources.displayMetrics.density
        slopPx = 8 * resources.displayMetrics.density
        /* 提示条：点一下也能收起（手动预览时用户往往就是点它） */
        findViewById<View>(R.id.lk_hint).setOnClickListener { dismiss(true) }

        /*
         * 箭头上下浮动：静止的图标只是个装饰，动起来才像「往上推」。
         */
        findViewById<View>(R.id.lk_hint_arrow)?.let { arrow ->
            arrowAnim = android.animation.ObjectAnimator.ofFloat(
                arrow, View.TRANSLATION_Y, 0f, -6f * resources.displayMetrics.density,
            ).apply {
                duration = 1100
                repeatMode = android.animation.ValueAnimator.REVERSE
                repeatCount = android.animation.ValueAnimator.INFINITE
                interpolator = AccelerateDecelerateInterpolator()
                startDelay = 500
            }
        }
    }

    /* ---------------- 显示 / 收起 ---------------- */

    /**
     * 把这一层拿出来演示。
     *
     * @param asPreview true = 用户自己点「锁屏播放页」预览，此时屏幕亮着、用户正看着，
     *                  解锁时不自动收；false = 熄屏时自动弹的。
     */
    fun show(asPreview: Boolean) {
        preview = asPreview
        if (shown) { sync(); return }
        shown = true
        visibility = VISIBLE
        /* 上一次收起来时可能留着拖拽位移 */
        bodyView?.let { it.translationY = 0f; it.alpha = 1f }
        resetCache()
        tickClock()
        sync()
        main.removeCallbacks(ticker)
        main.removeCallbacks(clockTicker)
        main.post(ticker)
        main.post(clockTicker)
        arrowAnim?.let { if (interactive()) it.start() else it.cancel() }

        /*
         * 悬浮歌词是 TYPE_APPLICATION_OVERLAY，压在**所有**窗口之上——包括这一层。
         * 它一起，锁屏页上就是「浮窗两行字 + 标题 + 歌词板」三份文字叠在同一条高度上。
         * 这一屏自己就有歌词板，让浮窗歇着；收起时再叫回来（只动自己开着的，别改用户开关）。
         */
        if (FloatingLyrics.shown) {
            resumeFloat = true
            FloatingLyrics.hide()
        }
        /*
         * 封面是服务异步取的，弱网时第一把常常失败。每次上来都催一次，
         * 免得「歌放了五分钟，锁屏一直是黑的」。
         */
        PlaybackService.instance?.refetchArt()

        alpha = 0f
        animate().alpha(1f).setDuration(160)
            .setInterpolator(AccelerateDecelerateInterpolator()).start()
    }

    /** 收起这一层（不动窗口标志，宿主自己管） */
    fun hide() {
        if (!shown) return
        shown = false
        main.removeCallbacks(ticker)
        main.removeCallbacks(clockTicker)
        arrowAnim?.cancel()
        bodyView?.let { it.translationY = 0f; it.alpha = 1f }
        animate().cancel()
        alpha = 1f
        visibility = GONE
        if (resumeFloat) {
            resumeFloat = false
            FloatingLyrics.show(context)
        }
        preview = false
    }

    /** 从设置页关掉开关时也要能立刻收（用户不该还留在这一屏上） */
    fun isPreview(): Boolean = preview

    /**
     * 屏幕亮了/灭了。
     *
     * 只做一件小事：把底部那个无限循环的箭头动画停掉。
     * 黑着屏还每 1.1 秒跑一次 ObjectAnimator 纯属烧电（用户对耗电很敏感），
     * 而这时屏幕上根本没人看得见它。ticker 的 200ms → 1.5s 降频在 run() 里自己判。
     */
    fun setAwake(on: Boolean) {
        if (!shown) return
        if (on) {
            if (arrowAnim?.isStarted != true) arrowAnim?.start()
        } else {
            arrowAnim?.cancel()
        }
    }

    /** 宿主销毁前收摊：把挂在这个 View 上的定时任务全摘掉 */
    fun dispose() {
        shown = false
        main.removeCallbacksAndMessages(null)
        arrowAnim?.cancel()
        if (resumeFloat) {
            resumeFloat = false
            FloatingLyrics.show(context)
        }
    }

    /* ---------------- 上滑手势 ---------------- */

    override fun onInterceptTouchEvent(ev: MotionEvent): Boolean {
        val body = bodyView ?: return false
        when (ev.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downY = ev.rawY
                downX = ev.x
                lastY = ev.rawY
                lastT = ev.eventTime
                vel = 0f
                holding = false
                /* 正在弹回的半路又被按住：先掐掉动画再接管，否则两个动效打架 */
                body.animate().cancel()
                return false
            }

            MotionEvent.ACTION_MOVE -> {
                if (holding) return true
                val dy = ev.rawY - downY
                val dx = ev.x - downX
                /* 只抢「明显的向上手势」：横向滑动、往下拉、点按都留给子 View */
                if (dy < -slopPx && abs(dy) > abs(dx)) {
                    holding = true
                    return true
                }
                return false
            }
        }
        return false
    }

    override fun onTouchEvent(ev: MotionEvent): Boolean {
        val body = bodyView ?: return false
        when (ev.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                /*
                 * 必须**消费** DOWN。
                 *
                 * 空白处按下时没有任何子 View 接手，事件会落到这里；返回 false 的话
                 * 这一串手势当场就被丢掉了 —— 之后的 MOVE 不再派给我们，
                 * `onInterceptTouchEvent` 也不会再被问，表现就是「上滑完全没反应」。
                 * 按钮上的按下态不受影响：那些地方 DOWN 被子 View 消费，
                 * 根本走不到这里（见 onInterceptTouchEvent 的注释）。
                 */
                downY = ev.rawY
                downX = ev.x
                lastY = ev.rawY
                lastT = ev.eventTime
                vel = 0f
                holding = false
                body.animate().cancel()
                return true
            }

            MotionEvent.ACTION_MOVE -> {
                /*
                 * 这里必须**自己再判一次**「这是不是一次上滑」。
                 *
                 * 空白处按下时 DOWN 由这个方法的 [MotionEvent.ACTION_DOWN] 分支消费，
                 * ViewGroup 之后就把所有 MOVE/UP 直接交给这里，**不再问
                 * onInterceptTouchEvent**（那是给「子 View 吃掉 DOWN」的情况用的）。
                 * 之前只在那条分支里置 `holding`，于是空白处上滑时 `holding` 永远是 false：
                 * 页面跟着手指走、松手却不飞出也不弹回，停在半空 —— 用户看到的就是
                 * 「拖到一半卡住、收不掉」。
                 */
                if (!holding) {
                    val dy0 = ev.rawY - downY
                    val dx0 = ev.x - downX
                    if (dy0 < -slopPx && abs(dy0) > abs(dx0)) {
                        holding = true
                    } else {
                        return true
                    }
                }
                val dt = (ev.eventTime - lastT).coerceAtLeast(1L)
                vel = (ev.rawY - lastY) / dt
                lastY = ev.rawY
                lastT = ev.eventTime
                val dy = ev.rawY - downY
                /* 只跟往上：往下拉给 0.25 阻尼，手感上像被顶住 */
                body.translationY = if (dy < 0f) dy else dy * 0.25f
                /* 往上拖约一屏就淡到 0.3：看得见「在离开」，又不至于拖一半就没了 */
                val rootH = height.coerceAtLeast(1)
                body.alpha = (1f + body.translationY / (rootH * 0.85f)).coerceIn(0.3f, 1f)
                return true
            }

            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                if (holding) {
                    val up = -body.translationY
                    val fling = ev.actionMasked == MotionEvent.ACTION_UP &&
                        (up > limitPx || vel < -1.1f)
                    if (fling) flyOut() else settleBack()
                    holding = false
                    return true
                }
                holding = false
                return false
            }
        }
        return false
    }

    /** 弹回原位：Overshoot 比线性更像「有弹性的页面」，而不是硬贴回去 */
    private fun settleBack() {
        val body = bodyView ?: return
        body.animate().cancel()
        body.animate()
            .translationY(0f)
            .alpha(1f)
            .setDuration(260)
            .setInterpolator(OvershootInterpolator(1.15f))
            .withEndAction { body.translationY = 0f; body.alpha = 1f }
            .start()
    }

    /** 甩出去再收页：加速飞出，比匀速更像被「甩走」 */
    private fun flyOut() {
        val body = bodyView ?: return
        val h = height.coerceAtLeast(1)
        body.animate().cancel()
        /*
         * 收尾走两条路：`withEndAction` 是常规路径；`postDelayed` 是兜底。
         *
         * 真机实测遇到过「动画跑到了终点、endAction 却没执行」——这一层停在半空，
         * 用户怎么点都收不掉（只能杀进程）。原因大概率是动画被后续某次
         * `animate()` 调用顶掉了（ViewPropertyAnimator 只认最后一个 endAction）。
         * 收页是**必须发生**的事，不赌回调：到点再看一眼，还开着就直接收。
         */
        val target = body
        body.animate()
            .translationY(-h * 0.45f)
            .alpha(0f)
            .setDuration(190)
            .setInterpolator(AccelerateInterpolator(1.7f))
            .withEndAction {
                if (shown) dismiss(true)
            }
            .start()
        main.postDelayed({
            if (shown && target.translationY < -h * 0.4f) dismiss(true)
        }, 320)
    }

    /**
     * 用户主动收起（上滑 / 点提示条）。
     *
     * 交给宿主处理：如果此刻手机还锁着（他只是想回到系统锁屏），宿主会把任务退到后台，
     * 让系统锁屏重新露出来；如果是在应用里预览，就只收这一层。
     */
    private fun dismiss(byUser: Boolean) {
        if (!shown) return
        android.util.Log.i("Shuyin", "lockPanel: dismiss byUser=$byUser")
        onDismiss(byUser)
    }

    /* ---------------- 刷新 ---------------- */

    private fun interactive(): Boolean = try {
        (context.getSystemService(Context.POWER_SERVICE) as PowerManager).isInteractive
    } catch (_: Exception) {
        true
    }

    /** 秒 → `m:ss`；非数 / 负数一律按 0 显示 */
    private fun fmtTime(s: Double): String {
        val t = if (s.isFinite() && s > 0) s.toInt() else 0
        return String.format(Locale.US, "%d:%02d", t / 60, t % 60)
    }

    private fun tickClock() {
        val now = Date()
        clock?.text = SimpleDateFormat("HH:mm", Locale.getDefault()).format(now)
        date?.text = SimpleDateFormat("M月d日 EEEE", Locale.CHINA).format(now)
    }

    private fun resetCache() {
        lastTitle = "\u0000"
        lastArtist = "\u0000"
        lastColor = "\u0000"
        lastBar = -1
        lastPosText = "\u0000"
        lastDurText = "\u0000"
        lastPlaying = null
        lastFav = null
        lastCover = null
    }

    private fun sync() {
        /* 没有曲目了就把这页收掉，别留一张写着上一首的假锁屏 */
        if (NowPlaying.title.isBlank()) {
            onDismiss(false)
            return
        }
        /* 文本只在**真的变了**的时候写。
           `TextView.setText` 每次都会重建一份 Layout 并让整页重新测量——这一屏
           200ms 一 tick，歌名/歌手/时长这三行要是每拍都写一遍，就是每 200ms
           把整个锁屏页 layout 一次，正在扫过去的歌词必然掉帧。 */
        val t = NowPlaying.title
        if (t != lastTitle) { lastTitle = t; titleTv?.text = t }
        val ar = NowPlaying.artist.ifBlank { "疏音" }
        if (ar != lastArtist) { lastArtist = ar; artistTv?.text = ar }
        /* 悬浮窗里换过色，锁屏页跟着换（两处读同一份 NowPlaying） */
        if (NowPlaying.color != lastColor) {
            lastColor = NowPlaying.color
            val c = try { Color.parseColor(NowPlaying.color) } catch (_: Exception) { Color.parseColor("#FFC94D") }
            board?.hl = c
            try { bar?.progressTintList = ColorStateList.valueOf(c) } catch (_: Exception) {}
        }
        if (board?.multi == true) {
            /* 多行版：整版上下文由前端推（±3），这里只管画 */
            board?.setAround(NowPlaying.around, NowPlaying.prog)
        } else {
            board?.setLines(NowPlaying.cur, NowPlaying.next, NowPlaying.prog, NowPlaying.flip)
        }
        /* 还没拿到歌词时板上显示歌名，不是「疏音」那种空壳 */
        board?.fallback = NowPlaying.title

        /* 进度：千分比没变就不碰 View，200ms 一 tick 别把主线程喂满 */
        val dur = NowPlaying.dur
        val pos = NowPlaying.pos.coerceAtLeast(0.0)
        val ms = if (dur > 0) ((pos / dur) * 1000).toInt().coerceIn(0, 1000) else 0
        if (ms != lastBar) {
            lastBar = ms
            bar?.progress = ms
            val p = fmtTime(pos)
            if (p != lastPosText) { lastPosText = p; posTv?.text = p }
        }
        val d = fmtTime(dur)
        if (d != lastDurText) { lastDurText = d; durTv?.text = d }

        val cover = NowPlaying.cover
        if (cover !== lastCover) {
            lastCover = cover
            if (cover != null) bg?.setImageBitmap(cover) else bg?.setImageDrawable(null)
        }
        val playing = NowPlaying.playing
        if (playing != lastPlaying) {
            lastPlaying = playing
            playBtn?.setImageResource(if (playing) R.drawable.notif_pause else R.drawable.notif_play)
            tint(playBtn)
        }
        val fav = NowPlaying.fav
        if (fav != lastFav) {
            lastFav = fav
            favBtn?.setImageResource(if (fav) R.drawable.notif_fav_on else R.drawable.notif_fav)
            tint(favBtn)
        }
    }

    /** 锁屏是深底，图标统一染近白（收藏态另给一层暖色） */
    private fun tint(btn: ImageButton?) {
        btn ?: return
        val isFavOn = btn.id == R.id.lk_fav && NowPlaying.fav
        btn.setColorFilter(if (isFavOn) Color.parseColor("#FF7BA6") else Color.parseColor("#F2F3F7"))
    }
}
