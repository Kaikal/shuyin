package cn.shuyin.player

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout

/**
 * 锁屏播放页的「跨应用宿主」。
 *
 * ## 为什么又要一个独立 Activity（2026-11-18 晚）
 *
 * 「锁屏页并进主 Activity」解决的是**应用内熄屏**的场景：窗口本来就在前台，
 * 挂个 `showWhenLocked` 就能盖住 keyguard，WebView 与面板同窗口、同状态。
 * 但用户在**别的应用**（微信/浏览器/桌面）里熄屏时，主窗口在后台，
 * 挂了标志也看不见。老做法是服务把主任务 `moveTaskToFront` 拉上来——
 * 代价在 2026-11-18 上午实测过（ALN-AL00 / EMUI 14.2）：
 *
 *   · 我们一 Resume 就成了「用户当前的应用」，把用户的任务栈整个顶掉；
 *   · 退场只有 `moveTaskToBack`，实测语义 = 按 Home：退完后桌面 visible=true，
 *     微信 task 明明活着却在下面 → 用户看到「解锁落到了桌面」。
 *
 * 现在换个思路：**主任务从头到尾一个像素都不动**。
 *
 *   · 这个 Activity 有自己的 taskAffinity（`cn.shuyin.player.lock`）+ excludeFromRecents，
 *     服务在跨应用熄屏时把它 `startActivity` 上来——浮在 keyguard 和原应用之上；
 *   · WebView 停留在它原来的位置（主任务还在微信底下歇着），JS 由
 *     MainActivity 的「窗口可见性伪装」兜着继续跑（见 MainActivity.onCreate 的
 *     WebView 子类注释——老独立锁屏 Activity 时代 JS 冻住的问题从根上补掉）；
 *   · 退场是 `finish()`：独立任务整个消失，系统把压在它底下的**原应用**亮回来。
 *     没有 moveTaskToBack，就没有「落桌面」——解锁后回到锁屏前那个应用，
 *     疏音主界面连闪的机会都没有。
 *
 * ## 界面
 *
 * 复用 [LockScreenPanel]（纯原生、宿主无关：读全局 `NowPlaying` 镜像、
 * 自己带 ticker、播控直连 [PlaybackService]，一行 MainActivity 的代码都不依赖）。
 * 「应用内熄屏」那条路（MainActivity 里的面板）保持原样，两条路互不干扰。
 *
 * ## 启动与退场的时机
 *
 *   · 服务在跨应用 `SCREEN_OFF` 时直接 startActivity（持有 SYSTEM_ALERT_WINDOW
 *     的应用不受「后台不许启动 Activity」约束；被 ROM 的 appop 拦掉时由服务
 *     落 `bg_blocked` 并用闹钟代发兜底，见 PlaybackService.screenRx）；
 *   · 解锁用与 MainActivity 同款的「早鸟探测」：亮屏后每 110ms 问一次
 *     `isKeyguardLocked`，连续两拍没锁就 `finish()`，抢在解锁动画露帧之前；
 *   · 用户上滑收面板 = 也 `finish()`（锁还着就露出系统锁屏，锁开了就回到原应用）；
 *   · 歌没了 / 没在放 → 面板自己回调 dismiss → `finish()`。
 *
 * 绝不 `setTurnScreenOn` / 不发全屏意图：鸿蒙上那两条必然点亮屏幕。
 */
class LockActivity : Activity() {

    private var panel: LockScreenPanel? = null
    private val main = Handler(Looper.getMainLooper())

    /* ---------------- 解锁早鸟探测 ---------------- */

    private val probe = Runnable { probeUnlock() }
    private var probeFrom = 0L
    private var probeTries = 0
    private var probeHits = 0

    companion object {
        /** 活着没有：服务据此去重（华为 SCREEN_OFF 会来两趟） */
        @Volatile
        var alive = false
            private set

        /** 服务直接启动用的 intent（NEW_TASK 必须；NO_ANIMATION 免得熄屏时还跑转场动画） */
        fun launchIntent(c: Context): Intent =
            Intent(c, LockActivity::class.java)
                .addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK or
                        Intent.FLAG_ACTIVITY_NO_ANIMATION or
                        Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS,
                )

        /**
         * 闹钟代发的那颗 PendingIntent：后台 startActivity 被 ROM 拦掉时的兜底
         * （系统替我们发，不算「应用自己在后台拉 Activity」）。
         * 带 `EXTRA_LOCK_AT` 时间戳，被锁屏压到解锁之后才送到的那颗会被丢弃。
         */
        fun alarmPending(c: Context): android.app.PendingIntent {
            val i = launchIntent(c)
                .putExtra(MainActivity.EXTRA_LOCK_NOW, true)
                .putExtra(MainActivity.EXTRA_LOCK_AT, SystemClock.elapsedRealtime())
            val fl = if (Build.VERSION.SDK_INT >= 23)
                android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE
            else
                android.app.PendingIntent.FLAG_UPDATE_CURRENT
            return android.app.PendingIntent.getActivity(c, 0x4C01, i, fl)
        }

        private const val LOCK_NOW_TTL_MS = 3000L
    }

    /* ---------------- 生命周期 ---------------- */

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        alive = true
        LockScreen.markAck()
        trace("onCreate kg=${keyguardShowing()} interactive=${isInteractive()} playing=${NowPlaying.playing}")

        /*
         * showWhenLocked：API 28+ 走 Activity 方法；以下用旧窗口标志
         * （deprecated 但在 24-27 上仍是唯一手段）。没这个，这一页盖不到锁屏上。
         */
        if (Build.VERSION.SDK_INT >= 28) {
            setShowWhenLocked(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED)
        }
        /*
         * 绝不自己点亮屏幕。用户按电源键亮屏的那一刻，这一页已经在窗口里了。
         */
        if (Build.VERSION.SDK_INT >= 27) {
            setTurnScreenOn(false)
        } else {
            @Suppress("DEPRECATION")
            window.clearFlags(WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
        }

        /*
         * 迟到的启动（多半是那颗被锁屏压后的闹钟）：屏幕亮着、锁也解了——
         * 这一趟作废。不能这时候铺：用户正看着别的应用。
         */
        if (isInteractive() && !keyguardShowing()) {
            trace("onCreate: 已解锁在前台 → 放弃")
            finish()
            return
        }
        /* 闹钟被压后太久（超 TTL）：同样作废 */
        val at = intent?.getLongExtra(MainActivity.EXTRA_LOCK_AT, 0L) ?: 0L
        if (at > 0 && SystemClock.elapsedRealtime() - at > LOCK_NOW_TTL_MS) {
            trace("onCreate: extra 迟到 ${SystemClock.elapsedRealtime() - at}ms → 放弃")
            finish()
            return
        }

        val root = FrameLayout(this)
        root.setBackgroundColor(0xFF000000.toInt())
        setContentView(root)
        panel = LockScreenPanel(this) { byUser -> onPanelDismissed(byUser) }
        root.addView(
            panel,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )
        hideBars()

        /*
         * 没在放、开关关着、连曲目都没有 —— 都不该铺一页假锁屏。
         * 服务端启动前查过一遍，这里再查一次（中间可能隔了几百毫秒）。
         */
        val wanted = LockScreen.enabled(this) && NowPlaying.playing && NowPlaying.title.isNotBlank()
        if (!wanted) {
            trace("onCreate: enabled=${LockScreen.enabled(this)} playing=${NowPlaying.playing} 不铺 → 放弃")
            finish()
            return
        }

        panel?.show(asPreview = false)
        /* 封面是服务异步取的，弱网时第一把常常失败；上来催一次 */
        PlaybackService.instance?.refetchArt()

        try {
            registerReceiver(
                rx,
                IntentFilter().apply {
                    addAction(Intent.ACTION_SCREEN_OFF)
                    addAction(Intent.ACTION_SCREEN_ON)
                    addAction(Intent.ACTION_USER_PRESENT)
                },
            )
        } catch (_: Exception) { /* 收不到就靠 USER_PRESENT 之外的路径兜，不影响功能 */ }
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        LockScreen.markAck()
        trace("onNewIntent")
        /* 迟到的闹钟 + 已经解锁：别把正在用的界面盖掉 */
        if (isInteractive() && !keyguardShowing()) {
            trace("onNewIntent: 已解锁 → 放弃")
            close()
        }
    }

    override fun onDestroy() {
        alive = false
        try { unregisterReceiver(rx) } catch (_: Exception) {}
        main.removeCallbacksAndMessages(null)
        panel?.dispose()
        panel = null
        trace("onDestroy")
        super.onDestroy()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        /* 全屏偶尔被系统栏回弹抢回去：拿到焦点就再压一次 */
        if (hasFocus) hideBars()
    }

    /* ---------------- 熄屏 / 亮屏 / 解锁 ---------------- */

    private val rx = object : BroadcastReceiver() {
        override fun onReceive(c: Context?, intent: Intent?) {
            when (intent?.action) {
                Intent.ACTION_SCREEN_OFF -> {
                    panel?.setAwake(false)
                    stopProbe()
                }
                Intent.ACTION_SCREEN_ON -> {
                    /* 熄屏期间 tick 降到 800ms，亮屏第一眼可能差半拍：先补一帧 */
                    PlaybackService.instance?.pushNow()
                    panel?.setAwake(true)
                    startProbe()
                }
                Intent.ACTION_USER_PRESENT -> if (isInteractive()) unlockDetected("USER_PRESENT")
            }
        }
    }

    private fun startProbe() {
        stopProbe()
        if (!isInteractive()) return
        probeFrom = SystemClock.elapsedRealtime()
        probeTries = 0
        probeHits = 0
        main.postDelayed(probe, 110)
    }

    private fun stopProbe() {
        main.removeCallbacks(probe)
        probeTries = 0
        probeHits = 0
    }

    private fun probeUnlock() {
        if (!isInteractive()) { stopProbe(); return }
        val age = SystemClock.elapsedRealtime() - probeFrom
        /*
         * 亮屏后 350ms 内的「没锁」不当真：华为从 AOD / 熄屏过渡时会短暂报
         * `isKeyguardLocked=false`，那时候动手等于把刚铺好的锁屏页收掉。
         */
        if (!keyguardShowing() && age >= 350) {
            probeHits++
            if (probeHits >= 2) {
                stopProbe()
                unlockDetected("probe")
                return
            }
        } else {
            probeHits = 0
        }
        probeTries++
        main.postDelayed(probe, if (probeTries > 140) 1000 else 110)
    }

    /**
     * 解锁那一下：收面板 + `finish()`。
     *
     * 独立任务整个消失，系统把压在底下的原应用亮回来——没有 moveTaskToBack，
     * 没有任务重排，「解锁落到桌面」从根上不存在。
     */
    private fun unlockDetected(why: String) {
        trace("解锁($why) → finish，回到原应用")
        panel?.takeIf { it.shown }?.hide()
        close()
    }

    /** 面板要求收起（上滑 / 点提示条 / 歌没了）。锁还着就回系统锁屏，锁开了就回原应用 */
    private fun onPanelDismissed(byUser: Boolean) {
        trace("dismiss byUser=$byUser → finish")
        panel?.hide()
        close()
    }

    private fun close() {
        @Suppress("DEPRECATION")
        overridePendingTransition(0, 0)
        finish()
    }

    /* ---------------- 杂项 ---------------- */

    private fun hideBars() {
        try {
            if (Build.VERSION.SDK_INT >= 30) {
                window.insetsController?.hide(
                    android.view.WindowInsets.Type.statusBars() or android.view.WindowInsets.Type.navigationBars(),
                )
            } else {
                @Suppress("DEPRECATION")
                window.decorView.systemUiVisibility =
                    View.SYSTEM_UI_FLAG_FULLSCREEN or
                    View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                    View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
                    View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            }
        } catch (_: Throwable) { /* 系统栏收不起来不致命：面板自带压暗层 */ }
    }

    private fun isInteractive(): Boolean = try {
        (getSystemService(Context.POWER_SERVICE) as PowerManager).isInteractive
    } catch (_: Exception) {
        false
    }

    private fun keyguardShowing(): Boolean = try {
        (getSystemService(Context.KEYGUARD_SERVICE) as android.app.KeyguardManager).isKeyguardLocked
    } catch (_: Exception) {
        false
    }

    /** 走 [LockScreen.trace] 的异步队列，主线程一行 I/O 都不做（见那边的注释） */
    private fun trace(msg: String) = LockScreen.trace("LockAct $msg")
}
