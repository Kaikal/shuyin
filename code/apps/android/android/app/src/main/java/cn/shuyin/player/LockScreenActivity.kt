package cn.shuyin.player

import android.app.Activity
import android.app.KeyguardManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.TextView
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 锁屏播放页（QQ 音乐那种「音乐锁屏」）。
 *
 * 为什么必须是 Activity：系统锁屏盖在**所有**窗口之上，TYPE_APPLICATION_OVERLAY
 * 的悬浮窗只能解锁后才看得见。要压在锁屏上，只有 showWhenLocked 的 Activity 能做到。
 *
 * 什么时候弹出：服务收到 ACTION_SCREEN_OFF 且确实在放歌（见 PlaybackService）。
 * 也可以在播放页「更多」里手动打开预览（桥命令 lock_show）。
 *
 * 数据从 [NowPlaying] 读（前端 250ms 推一次歌词、服务更新播放态），这个页面不持有任何业务状态。
 */
class LockScreenActivity : Activity() {

    companion object {
        private const val PREFS = "lock_screen"
        private const val K_ON = "on"
        /** 「上次提示用户去开小米权限」的时间戳（毫秒），用来做一天一次的节流 */
        private const val K_GUIDE_AT = "guide_at"
        /** 「上次提示用户去开 Android 14 全屏通知」的时间戳（毫秒） */
        private const val K_FSI_AT = "fsi_at"
        /** 点亮屏幕那条通知的 id / 频道（和播放通知分开，别互相覆盖） */
        private const val LOCK_NOTI_ID = 0x5A17
        /** 「去开小米锁屏显示」那条提示通知的 id（也是单独一条，别和上面撞） */
        private const val GUIDE_NOTI_ID = 0x5A18
        private const val CH_LOCK = "lock_screen"

        /**
         * 这一页是「被系统锁屏压在下面」的那一次（MIUI 拒了「显示在锁屏上」）。
         *
         * 带这个标记的页面：息屏时不会亮屏、也没有全屏意图，用户解锁那一刻它才露出来。
         * 所以 [unlockRx] **不能**像正常情况那样在解锁时把它收掉——收掉就等于
         * 「开了这个开关，锁屏什么都没发生」，正是用户反馈的那个 bug。
         */
        private const val EXTRA_BEHIND_GUARD = "behind_guard"

        /** 锁屏时要不要弹这一页（默认开：用户装了就想要这个能力） */
        fun enabled(ctx: android.content.Context): Boolean = try {
            ctx.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE).getBoolean(K_ON, true)
        } catch (_: Exception) {
            true
        }

        fun setEnabled(ctx: android.content.Context, on: Boolean) {
            try {
                ctx.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
                    .edit().putBoolean(K_ON, on).apply()
            } catch (_: Exception) { /* 存不下就按默认走 */ }
        }

        /** MIUI 的「锁屏显示」appop（AGP 里没有这个名字，只能按数字用） */
        private const val MIUI_OP_SHOW_WHEN_LOCKED = 10020

        /**
         * MIUI 给 Intent 偷偷加的那个标志位：带上它，系统在
         * `checkActivityStart` 开头就直接放行，跳过 10020「锁屏显示」和
         * 10021「后台弹出界面」两道 appop（真机日志里的
         * `MIUILOG- Show when locked PermissionDenied` 就是被这两道拦下的）。
         */
        private const val MIUI_FLAG_SKIP_CHECK = 0x2

        /** 隐藏 API 豁免只做一次（每做一次都要重建一次方法解析，没必要） */
        @Volatile
        private var exempted = false

        /**
         * 这个进程**实际**能不能给 intent 打上 MIUI 标志（设置页据此决定要不要提示用户去开权限）。
         *
         * 实测（小米 11 · MIUI V140 / Android 13）：`Intent.addMiuiFlags` 是黑名单里的
         * 隐藏接口，`getMethod` 直接抛 `NoSuchMethodException`；连绕过它的
         * `VMRuntime.setHiddenApiExemptions` 自己也被同一道闸拦着
         * （`NoSuchMethodException: dalvik.system.VMRuntime.setHiddenApiExemptions`）。
         * 也就是说这条「免用户操作」的路在新版 MIUI 上走不通，只能退回
         * 「引导用户去开『锁屏显示』」——但仍留着这段反射：老版本 MIUI 上它确实有效，
         * 成功了设置页就不再打扰用户。
         */
        @Volatile
        private var miuiBypass = false

        private fun isMiui(): Boolean = try {
            val mf = (android.os.Build.MANUFACTURER ?: "").lowercase()
            val brand = (android.os.Build.BRAND ?: "").lowercase()
            mf.contains("xiaomi") || mf.contains("redmi") || brand.contains("xiaomi") ||
                brand.contains("redmi") || brand.contains("poco") ||
                (android.os.Build.DISPLAY ?: "").uppercase().contains("MIUI")
        } catch (_: Throwable) {
            false
        }

        /**
         * 息屏那一刻：**一个字都不改**，页面原样躺着。
         *
         * 用户要的节奏是「锁屏 → 屏幕黑着 → 我按电源键 → 看到疏音锁屏」。
         * 所以这条路径绝不点屏、绝不发全屏意图，也**绝不去动 showWhenLocked**。
         *
         * 上一版在这里 `setShowWhenLocked(false)`（为了躲「resumed 但没有焦点窗口」
         * 那条 ANR），结果正好造出用户描述的那串闪跳：息屏那一下系统立刻重新评估遮挡
         * → 页面让位、系统锁屏顶上来（用户看到一次系统锁屏），亮屏时再挂回去
         * → 又变回疏音锁屏。摘一次、挂一次，就是「疏音锁屏 → 系统锁屏 → 疏音锁屏」。
         *
         * 现在只做一件有用的事：把重绘停掉（黑着屏每 200ms 补间一次纯属烧电）。
         * 页面不在了（用户上滑收过、进程刚被回收）才悄悄补建一个，同样不点屏。
         */
        fun onScreenOff(ctx: Context) {
            val a = inst
            if (a == null) {
                quietCreate(ctx)
                /*
                 * 后台建不出来（用户是在别的应用里锁的屏）→ 退回全屏意图。
                 *
                 * **必须在这一刻发**，不能等亮屏再发。SystemUI 的
                 * `NotificationInterruptStateProviderImpl.shouldLaunchFullScreenIntentWhenAdded()`
                 * 只在「这条通知不会弹横幅」或「状态 == KEYGUARD」时才启动那个 Activity；
                 * 而屏幕已经亮着的时候它会走 heads-up 分支——通知被降级成一条横幅，
                 * 页面永远起不来（这正是以前的死结，真机日志里一条
                 * "full screen intent" 都找不到，只有我们自己 startActivity 被
                 * `Abort background activity starts` 拦下的记录）。
                 *
                 * 发送方是 system_server，压根不走「后台不许启动 Activity」那道闸门。
                 * 页面本身不带 turnScreenOn（见 bring 的注释），所以屏幕该黑还是黑。
                 *
                 * 但要**等一下**：`ACTION_SCREEN_OFF` 到达时 PowerManager 的
                 * wakefulness 还常常是 Awake（系统正在跑息屏动画），SystemUI 此刻
                 * 判出来的是「屏幕亮着」，照样只弹横幅。实测 700ms 之后
                 * `isInteractive` 才翻成 false，那才是系统愿意执行全屏意图的时机。
                 */
                main.postDelayed({
                    /*
                     * 用 Display 状态判「屏幕真的黑了」，**不要**用 PowerManager.isInteractive()：
                     * 这台机器（HarmonyOS 4.2 / API 31）上 `input keyevent 223` 之后
                     * wakefulness 报的还是 Awake，isInteractive 也一直是 true，
                     * 判断会一直为假 —— 全屏意图那条通知压根发不出去（真机里
                     * 连 enqueue 日志都没有，看上去像「系统不支持」，其实是自己没发）。
                     * 用户动作快、屏幕又亮了这种情况仍然跳过，留给亮屏那条路。
                     */
                    if (screenOff(ctx)) postPullUp(ctx)
                }, 700)
                return
            }
            a.setAwake(false)
            a.promoteIfBehind()
        }

        /**
         * 亮屏那一刻：页面在就接着用（它一直压在锁屏之上，屏幕点亮那一帧就在），
         * 把重绘恢复即可；不在才退回「拉起来」那条路。
         */
        fun onScreenOn(ctx: Context) {
            val a = inst
            if (a != null) {
                a.setAwake(true)
                a.reassertLocked()
                /*
                 * 页面还在、但躺在后台（用户中途回过桌面 / 从别的应用锁的屏）：
                 * 把**已有任务**提到前台。
                 *
                 * 这一步不能用 `startActivity`：应用此刻在后台，`startActivity` 会被
                 * Android 10+ 的「后台不许启动 Activity」直接拦掉（真机日志
                 * `Abort background activity starts`，`callingUidHasAnyVisibleWindow: false`——
                 * 系统锁屏一显示，第三方悬浮窗还会被置成不可见，SAW 那条豁免也用不上）。
                 * `moveTaskToFront` 只是调任务层级、不启动任何 Activity，管不到它。
                 */
                a.promoteIfBehind()
                /* 页面本来就躺着，不会再走一次 onResume —— 这里补一次「有没有被压住」的判断 */
                a.markBehind()
                return
            }
            bring(ctx, light = true)
        }

        /**
         * 悄悄建一个页面：只把 Activity 挂到栈顶，不点亮屏幕、不发全屏意图。
         *
         * 唯一目的是「用户按下电源键那一刻它已经在栈顶」。这条路能不能走通取决于
         * 我们当时还在不在前台：应用在后台时，Android 10+ 会直接拦掉后台启动 Activity
         * （真机日志：`activity start fail: Abort background activity starts`，
         * 即便 SYSTEM_ALERT_WINDOW 已经 allow，华为也照样拦）。拦住就算了——绝不为这个
         * 去点屏（用户明确要求「锁屏后自己保持黑着」），亮屏那一刻还会再试一次。
         */
        private fun quietCreate(ctx: Context) {
            val intent = Intent(ctx, LockScreenActivity::class.java).addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP,
            )
            addMiuiFlags(intent)
            try {
                ctx.startActivity(intent)
            } catch (_: Exception) { /* 后台启动被拦：等亮屏那条路再试 */ }
        }

        /** 手动预览（播放页「更多 → 锁屏播放页」）：屏幕亮着、用户正看着，什么都不用点 */
        fun preview(ctx: Context) = bring(ctx, light = false)

        /**
         * 把锁屏页送到栈顶。
         *
         * 这里**一行点屏的代码都没有**：`setTurnScreenOn` / `FLAG_TURN_SCREEN_ON` /
         * `ACQUIRE_CAUSES_WAKEUP` 全部删掉了。以前它在息屏那一刻把屏幕点回来，
         * 用户看到的是「一锁屏自己亮一下」；更糟的是 `setTurnScreenOn` 在
         * ActivityRecord 上留的是**持久标志**，屏幕熄了之后每次 relayout
         * （换句歌词、进度重绘）系统都会再唤醒一次——真机日志里是每 1.3 秒一条
         * `TURN_ON:handleTurnScreenOn`，用户描述成「锁屏会隔一段时间亮一下」。
         *
         * 现在点亮屏幕这件事**只由用户按电源键完成**，我们只在用户亮屏之后把页面准备好。
         *
         * @param light 要不要补一条全屏意图通知（只在「屏幕已经亮着」时用：
         *   息屏时会点亮屏幕，绝对不能用）
         */
        private fun bring(ctx: Context, light: Boolean) {
            /*
             * 「这一页会不会被系统锁屏压在下面」**不再靠猜**。
             *
             * 老写法拿 appops 10020 反射去探 MIUI 的「锁屏显示」，探不到就当放行。
             * 真机（小米 11 · MIUI V140）实测：日志里明明写着
             * `MIUILOG- Show when locked PermissionDenied`，可反射拿回来的不是
             * MODE_IGNORED，于是 `behindGuard` 一直是 false —— 页面照建、建完被压在
             * 锁屏下面，解锁那一刻 [unlockRx] 又按「正常页」把它收掉，用户看到的
             * 就是「猛然出现一下然后就消失」。
             *
             * 现在改成**看事实**：页面起来之后到底有没有拿到焦点（见 markBehind）。
             * 拿不到 = 被压在锁屏下面，跟是哪家的 ROM 无关，也不用再维护那张权限表。
             */
            val intent = Intent(ctx, LockScreenActivity::class.java).addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP,
            )
            /*
             * 小米：给 intent 打上 MIUI 自己的「系统级」标志位（0x2）。
             *
             * MIUI 在 ActivityTaskManager 里加了两道 appop —— 10020「锁屏显示」、
             * 10021「后台弹出界面」，默认都是拒绝，第三方应用 startActivity 时被拦下。
             * MIUI 的 Intent 里有个隐藏的 addMiuiFlags()，带上 0x2 会跳过这两道检查
             * （系统应用/白名单应用走的就是这条路）。拿不到就退化成普通 startActivity，
             * 下面的全屏意图仍然有机会把页面拉起来。
             */
            addMiuiFlags(intent)
            try {
                ctx.startActivity(intent)
            } catch (_: Exception) { /* 后台启动被拦：下面那条全屏意图会补上 */ }
            /*
             * 只有「用户刚按亮屏幕」那条路径才补全屏意图：
             * 屏幕亮着的时候它只是「借系统的手把 Activity 拉起来」，
             * 不会再点亮任何东西；息屏 / 预览路径一条都不发。
             */
            if (!light) return
            postPullUp(ctx)
            /*
             * 亮屏后再补几发 startActivity。
             *
             * 亮屏那一刻系统状态很「毛」：第一次后台启动常被记成拒绝、连异常都不抛
             * （MIUI 只在日志里写一句 PermissionDenied），页面压根没建出来。
             * 隔一拍再补，成功率不同；页面一起来（`alive`）后面的自然都是空操作。
             *
             * 补发**救不了**「应用在后台被华为拦住」那条路：真机日志是
             * `activity start fail: Background activity start ... callingUidHasAnyVisibleWindow: false`，
             * 系统锁屏一旦显示出来，第三方悬浮窗也会被策略置为不可见
             * （`mPolicyVisibility=false`），补多少次都一样。那条路只能靠通知，
             * 见交付说明里的限制。
             *
             * 刚被收掉过（用户上滑 / 解锁）就不补了，否则会跟「收页」打架，
             * 表现成页面闪一下又消失。
             *
             * 注意**不要**在这里反复调 `applyShowWhenLocked(true)`：以前这里排了 300ms /
             * 900ms 两把，说是「补挂」，其实每次都让系统重跑一遍遮挡评估 → 全屏 relayout，
             * 亮屏那一瞬正好被它切成「疏音锁屏 → 系统锁屏 → 疏音锁屏」。标志位现在是
             * 常开的（见 onCreate），没有需要补挂的时机。
             */
            for (d in longArrayOf(200, 600, 1200, 2000)) {
                main.postDelayed({
                    if (!alive && android.os.SystemClock.uptimeMillis() - dismissedAt > 2500) {
                        val again = Intent(ctx, LockScreenActivity::class.java).addFlags(
                            Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP,
                        )
                        addMiuiFlags(again)
                        try { ctx.startActivity(again) } catch (_: Exception) {}
                    }
                }, d)
            }
        }

        /** 屏幕真的黑着吗（Display 状态，比 isInteractive 可靠，见 onScreenOff 的注释） */
        private fun screenOff(ctx: Context): Boolean = try {
            val dm = ctx.getSystemService(Context.DISPLAY_SERVICE) as android.hardware.display.DisplayManager
            val st = dm.getDisplay(android.view.Display.DEFAULT_DISPLAY)?.state
            st != null && st != android.view.Display.STATE_ON
        } catch (_: Throwable) {
            false
        }

        private val main = Handler(Looper.getMainLooper())

        /** 上一次主动收页的时刻（毫秒）：亮屏补发的 startActivity 用它避开「刚收掉又建」的打架 */
        @Volatile
        private var dismissedAt = 0L

        /** 页面活着吗（补发 startActivity 的判断依据） */
        @Volatile
        private var alive = false

        /** 活着的那一个实例：息屏时要把它收掉（见 [onScreenOff]） */
        @Volatile
        private var inst: LockScreenActivity? = null

        private fun isInteractive(ctx: Context): Boolean = try {
            (ctx.getSystemService(Context.POWER_SERVICE) as PowerManager).isInteractive
        } catch (_: Exception) {
            true
        }

        /**
         * 系统锁屏现在是不是锁着。
         *
         * 用来判断这一页会不会被压在锁屏**下面**：小米拒了「显示在锁屏上」时，
         * 只要锁屏是锁着的，无论屏幕亮没亮，这一页都上不去。亮屏那条路径
         * （[onScreenOn]）进来时 `isInteractive` 是 true，光看它会把
         * [EXTRA_BEHIND_GUARD] 漏掉——用户解锁那一刻页面就被收走了。
         */
        private fun keyguardLocked(ctx: Context): Boolean = try {
            (ctx.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager).isKeyguardLocked
        } catch (_: Exception) {
            false
        }

        /**
         * 解除「隐藏 API」限制，让 [addMiuiFlags] 反射得到 `Intent.addMiuiFlags`。
         *
         * Android 9 起非 SDK 接口被 `VMRuntime` 拦：不走这一步，真机日志里只有一句
         * `Accessing hidden method Landroid/content/Intent;->addMiuiFlags(I)…
         * (blocked, reflection, denied)`，方法根本没调到，随后就是
         * `MIUILOG- Show when locked PermissionDenied` —— 表现正是用户说的
         * 「小米要先解锁，锁屏页才出来」。
         *
         * 用的是 FreeReflection 那套「二次反射」：`Class.getDeclaredMethod` 本身是公开
         * API，但**经由反射去调它**时，调用的发起方是 `java.lang.reflect`，
         * 隐藏 API 的访问检查会跳过，于是能拿到 `VMRuntime` 上的隐藏方法。
         * 豁免只开 `Landroid/content/Intent;` 一个类，不放开整个框架。
         *
         * **实测结论（MIUI V140 / Android 13）**：这一步在本机走不通 —— 连
         * `setHiddenApiExemptions` 自己都在黑名单里（NoSuchMethodException），
         * 于是 `addMiuiFlags` 也拿不到。所以新版 MIUI 只能走「用户手动开权限」，
         * 见 [postGuide]。留着它是为了老版本 MIUI（那里确实有效），
         * 成功了 `miuiBypass` 就是 true，设置页与提示都不会再来烦。
         */
        private fun exemptHiddenApi() {
            if (exempted) return
            exempted = true
            try {
                /*
                 * 拿 `Class.forName` / `Class.getDeclaredMethod` 这两个 Method 对象，
                 * 是为了后面「经由反射」去解析 VMRuntime 上的隐藏方法 —— 只有发起点
                 * 是反射框架时，隐藏 API 检查才会被跳过。
                 * 从任意一个 Class 实例（这里借 String.class）上取即可，不必写出
                 * java.lang.Class 的类字面量。
                 */
                val anyCls = String::class.java
                /* `anyCls.javaClass` 就是 java.lang.Class 本身 —— 我们要的是
                   Class 自己的 forName / getDeclaredMethod，不是 String 的 */
                val clsCls = anyCls.javaClass
                val forName = clsCls.getMethod("forName", String::class.java)
                val getDeclaredMethod = clsCls.getMethod(
                    "getDeclaredMethod", String::class.java, emptyArray<Class<*>>().javaClass,
                )
                val vmRuntime = forName.invoke(null, "dalvik.system.VMRuntime") as Class<*>
                val getRuntime = getDeclaredMethod.invoke(vmRuntime, "getRuntime", null)
                    as java.lang.reflect.Method
                val setExemptions = getDeclaredMethod.invoke(
                    vmRuntime, "setHiddenApiExemptions",
                    /* 形参表得是**数组**（Class[]），不能塞一个裸 Class 进去 */
                    arrayOf<Class<*>>(emptyArray<String>().javaClass),
                ) as java.lang.reflect.Method
                setExemptions.invoke(
                    getRuntime.invoke(null), arrayOf<Any>(arrayOf("Landroid/content/Intent;")),
                )
            } catch (_: Throwable) { /* 厂商锁死：退化成引导用户去开权限 */ }
        }

        /** MIUI 的隐藏 API：给 intent 打「系统级」标志，跳过锁屏显示/后台弹窗两道 appop */
        private fun addMiuiFlags(intent: Intent) {
            exemptHiddenApi()
            try {
                Intent::class.java
                    .getMethod("addMiuiFlags", Int::class.javaPrimitiveType)
                    .invoke(intent, MIUI_FLAG_SKIP_CHECK)
                miuiBypass = true
            } catch (_: Throwable) {
                miuiBypass = false /* 非 MIUI / 方法被裁掉 / 豁免没成功：原样发 */
            }
        }

        /**
         * 小米把「锁屏显示」拒了，而我们又绕不过去 —— 这时候才需要打扰用户。
         *
         * 只认**明确的 deny**：小米官方文档说这个权限「暂时没有查询接口」，
         * 万一某个版本上 `checkOpNoThrow` 抛异常（返回 null），宁可当它放行，
         * 也别给一个根本没问题的用户每天弹提示。
         */
        private fun miuiBlocked(): Boolean =
            isMiui() && !miuiBypass && miuiShowWhenLocked() == false

        /**
         * 「页面被小米挡住了，点这里去开权限」的那条通知。
         *
         * 为什么不用 toast / 悬浮窗：息屏那一刻应用在后台，toast 不一定画得出来，
         * 悬浮窗又压在锁屏之上（用户解锁后才看到，等于没提示）。通知栏是唯一
         * 在锁屏上就能被看到、并且能直接点进去的地方。
         *
         * **一天最多提一次**（记在 prefs 里，重启也认）：用户每次锁屏放歌都会走到
         * [show]，提示要是每 10 分钟来一条，等于把「解决不了」变成「骚扰」。
         * 看完决定不开，那是他的选择，明天再说一句就够。
         */
        private fun postGuide(ctx: Context) {
            val now = System.currentTimeMillis()
            val prefs = try {
                ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            } catch (_: Exception) {
                null
            }
            if (prefs != null && now - prefs.getLong(K_GUIDE_AT, 0L) < 24 * 3600_000L) return
            try { prefs?.edit()?.putLong(K_GUIDE_AT, now)?.apply() } catch (_: Exception) {}
            try {
                val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CH_LOCK) == null) {
                    nm.createNotificationChannel(
                        NotificationChannel(
                            CH_LOCK, "锁屏播放页", NotificationManager.IMPORTANCE_HIGH,
                        ).apply { setSound(null, null); enableVibration(false) },
                    )
                }
                /*
                 * 直接给 MIUI 的权限编辑器，而且**写死组件名**。
                 *
                 * 不能先 `resolveActivity` 探一下再决定：Android 11 的包可见性会让
                 * 我们查不到 securitycenter（要查得在 Manifest 里额外声明 <queries>），
                 * 探出来永远是 null，于是每次都退到「应用详情页」——那一页里根本没有
                 * 「显示在锁屏上」这一项。而**启动**不受包可见性限制（受限的是查询），
                 * 所以显式组件名照发就好。
                 */
                val edit = Intent("miui.intent.action.APP_PERM_EDITOR")
                    .addCategory(Intent.CATEGORY_DEFAULT)
                    .setClassName(
                        "com.miui.securitycenter",
                        "com.miui.permcenter.permissions.PermissionsEditorActivity",
                    )
                    .putExtra("extra_pkgname", ctx.packageName)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                val pi = PendingIntent.getActivity(
                    ctx, 2, edit,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
                val n = Notification.Builder(ctx, CH_LOCK)
                    .setSmallIcon(R.mipmap.ic_notif)
                    .setContentTitle("锁屏播放页被小米挡住了")
                    .setContentText("点这里 →「其他权限」→ 打开「显示在锁屏上」，之后按亮屏幕就能直接看到它")
                    .setStyle(
                        Notification.BigTextStyle().bigText(
                            "MIUI 默认不许第三方应用显示在锁屏上，所以这一页要等你解锁才冒出来。\n" +
                                "点这条通知 → 权限管理页「其他权限」→ 打开「显示在锁屏上」（部分版本叫「锁屏显示」），" +
                                "之后按亮屏幕就会直接看到这一页。",
                        ),
                    )
                    .setContentIntent(pi)
                    .setAutoCancel(true)
                    .setCategory(Notification.CATEGORY_ERROR)
                    .setTimeoutAfter(10 * 60_000L)
                    .build()
                nm.notify(GUIDE_NOTI_ID, n)
            } catch (_: Exception) { /* 没通知权限：设置页里那行说明还在 */ }
        }

        /**
         * MIUI 的「锁屏显示」现在允不允许（null = 问不出来，比如非 MIUI）。
         * 设置页拿它决定要不要提示用户去开。
         */
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

        /**
         * 给设置页的状态：开没开 / 是不是小米 / 小米那边放不放行。
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
            /*
             * 「我们自己有办法绕过去吗」。有的话就不必逼用户去系统设置里翻那个
             * 藏得很深的「锁屏显示」——appop 仍然是 deny，但 intent 带上 MIUI 标志后
             * 系统在检查开头就放行了。拿一个临时 intent 探一次（不启动任何东西）。
             */
            try {
                addMiuiFlags(Intent(ctx, LockScreenActivity::class.java))
                o.put("bypass", miuiBypass)
            } catch (_: Throwable) {
                try { o.put("bypass", false) } catch (_: Throwable) {}
            }
            return o
        }

        /**
         * 打开系统里「锁屏显示」那一页。
         *
         * MIUI 的这个权限只能在它自己的权限编辑器里开（设置 → 应用 → 疏音 → 权限管理
         * → 其他权限），普通的应用详情页里根本没有这一项。
         */
        fun openPermissionEditor(ctx: Context): Boolean {
            /*
             * 小米：先进它自己的权限编辑器（「锁屏显示」只在那一页里）。
             * 两种写法都试：有的 MIUI 版本只认 action（由系统解析），
             * 有的要显式给 securitycenter 的类名。都不行就退到系统应用详情页
             * ——那一页里也有「权限管理 → 其他权限」，用户照样能开。
             */
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

        /**
         * 用一条全屏意图通知让**系统自己**把页面拉到前台。
         *
         * 只给「屏幕已经亮着」的那条路径用（[onScreenOn]）。全屏意图的设计意图是
         * 来电那种「屏幕黑着也要弹出来」，系统收到它会顺手把屏幕点亮——所以
         * **绝不能**在息屏那一刻发（那就是用户说的「一锁屏自己亮一下」）。
         * 屏幕亮着的时候发它，等于借系统的手绕过「后台启动 Activity」的限制，
         * 不会再点亮任何东西。
         */
        private fun postPullUp(ctx: Context) {
            /*
             * Android 14 起，「全屏通知」不再默认授予非通话/闹钟类应用：
             * `setFullScreenIntent` 会被系统**静默降级成一条横幅**，页面根本不会起来。
             * 没有这个权限时别再白发一条注定无效的通知，改成引导用户去开（见 postFsiGuide）。
             */
            if (!fsiAllowed(ctx)) {
                postFsiGuide(ctx)
                return
            }
            try {
                val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CH_LOCK) == null) {
                    nm.createNotificationChannel(
                        NotificationChannel(
                            CH_LOCK,
                            "锁屏播放页",
                            NotificationManager.IMPORTANCE_HIGH,
                        ).apply {
                            /* 静音：这是「把页面拉起来」的信使，不该响一声吓人 */
                            setSound(null, null)
                            enableVibration(false)
                            setShowBadge(false)
                            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
                        },
                    )
                }
                val intent = Intent(ctx, LockScreenActivity::class.java).addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP,
                )
                /* 和 startActivity 那条路一样带上 MIUI 的「系统级」标志：
                   全屏意图最终也是它自己 startActivity，同样过那两道 appop */
                addMiuiFlags(intent)
                val pi = PendingIntent.getActivity(
                    ctx,
                    1,
                    intent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
                /*
                 * 先收掉上一条，再发一条新的。
                 *
                 * 全屏意图只在「通知是新的」那一刻被系统处理：同一个 id 反复 notify
                 * 会被当成更新，第二次息屏就不再拉起页面了（`setOnlyAlertOnce` 更狠，
                 * 直接连横幅都不给）。cancel + notify 才是每次都全新的一条。
                 */
                nm.cancel(LOCK_NOTI_ID)
                val n = Notification.Builder(ctx, CH_LOCK)
                    .setSmallIcon(R.mipmap.ic_notif)
                    .setContentTitle(NowPlaying.title.ifBlank { "疏音" })
                    .setContentText(NowPlaying.artist)
                    .setContentIntent(pi)
                    .setFullScreenIntent(pi, true)
                    .setCategory(Notification.CATEGORY_TRANSPORT)
                    /*
                     * **绝对不能设 ongoing。**
                     *
                     * 系统判断「这条通知要不要走全屏意图」用的是
                     * `StatusBarNotification.isFullScreenIntent()`，而它的实现是
                     * `(flags & FLAG_FULLSCREEN_INTENT) != 0 && (flags & FLAG_ONGOING_EVENT) == 0`
                     * —— ongoing 的那一位会直接把全屏意图**否掉**。
                     *
                     * 真机日志里能直接看出这件事：一条正常的 FSI 通知 flags=0x80，我们这条
                     * 打出来是 0x82（0x80 | 0x2），随后系统只当它是普通通知排进通知栏，
                     * `NotificationService` 里一句 "full screen intent" 都没有，Activity 那边
                     * 还是自己 startActivity → `Abort background activity starts`。
                     *
                     * 表现就是用户说的「酷狗不在它的应用里锁屏也能弹锁屏页，我们不行」：
                     * 酷狗走的是系统代发（FSI 由 system_server 拉起，不受后台启动限制），
                     * 我们这条被自己的 ongoing 位堵死，只能退化成后台 startActivity。
                     *
                     * 不去 ongoing 也不怕被用户划掉：下面还有 6 秒的 timeoutAfter。
                     */
                    .setShowWhen(false)
                    /* 几秒还没被系统拉起来就自己收：别在通知栏/锁屏上留一张没人管的卡片。
                       华为这类不执行第三方全屏意图的 ROM 上，这条通知只会变成一条普通通知，
                       所以收回得更快一点（3500ms），别让它挡在锁屏通知里碍眼。 */
                    .setTimeoutAfter(3500)
                    .build()
                nm.notify(LOCK_NOTI_ID, n)
            } catch (_: Exception) { /* 没通知权限 / 被 ROM 拦：退化成上面那条 startActivity */ }
        }

        /**
         * Android 14+ 上我们还能不能用全屏意图。
         *
         * 低版本没有这道闸门（也是本机 HarmonyOS 4.2 / API 31 的实际情况），一律放行；
         * 问不出来时也按放行处理——宁可发一条可能被降级的通知，也不要对好好的用户
         * 每天弹一次「去开权限」。
         */
        private fun fsiAllowed(ctx: Context): Boolean {
            if (Build.VERSION.SDK_INT < 34) return true
            return try {
                (ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                    .canUseFullScreenIntent()
            } catch (_: Throwable) {
                true
            }
        }

        /**
         * 「去把全屏通知打开」那条提示。
         *
         * 和 [postGuide]（小米锁屏显示）同一套节流：一天最多一次，跳的是系统那个
         * 「允许全屏通知」开关页。Android 14 上这一项藏在应用通知设置里，
         * 系统没给查询接口之外的入口，只能直接把人送到那一页。
         */
        private fun postFsiGuide(ctx: Context) {
            val now = System.currentTimeMillis()
            val prefs = try {
                ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            } catch (_: Exception) {
                null
            }
            if (prefs != null && now - prefs.getLong(K_FSI_AT, 0L) < 24 * 3600_000L) return
            try { prefs?.edit()?.putLong(K_FSI_AT, now)?.apply() } catch (_: Exception) {}
            try {
                val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                if (nm.getNotificationChannel(CH_LOCK) == null) {
                    nm.createNotificationChannel(
                        NotificationChannel(CH_LOCK, "锁屏播放页", NotificationManager.IMPORTANCE_HIGH)
                            .apply { setSound(null, null); enableVibration(false) },
                    )
                }
                val open = Intent("android.settings.MANAGE_APP_USE_FULL_SCREEN_INTENT")
                    .setData(android.net.Uri.parse("package:${ctx.packageName}"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                val pi = PendingIntent.getActivity(
                    ctx, 3, open,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
                val n = Notification.Builder(ctx, CH_LOCK)
                    .setSmallIcon(R.mipmap.ic_notif)
                    .setContentTitle("还差一步：允许疏音的全屏通知")
                    .setContentText("点这里打开「允许全屏通知」，锁屏播放页才能在锁屏上弹出来")
                    .setStyle(
                        Notification.BigTextStyle().bigText(
                            "Android 14 起，音乐类应用默认拿不到「全屏通知」。\n" +
                                "点这条通知 → 打开「允许全屏通知」，之后无论在哪个界面锁屏，" +
                                "按亮屏幕都会直接看到疏音的锁屏播放页。",
                        ),
                    )
                    .setContentIntent(pi)
                    .setAutoCancel(true)
                    .setCategory(Notification.CATEGORY_ERROR)
                    .setTimeoutAfter(10 * 60_000L)
                    .build()
                nm.notify(GUIDE_NOTI_ID, n)
            } catch (_: Exception) { /* 没通知权限：设置页里那行说明还在 */ }
        }
    }

    private val main = Handler(Looper.getMainLooper())

    /** 当前窗口是否挂着 showWhenLocked（只在值变化时才真的调系统接口，见 applyShowWhenLocked） */
    private var showLockedOn = false

    /** 屏幕亮着吗（息屏后停重绘，见 setAwake） */
    private var awake = true

    /** 上次把任务提到前台的时刻（毫秒）：onPause 的自动收页用它躲开「刚提上来」那一下 */
    private var promotedAt = 0L

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
    private var bar: android.widget.ProgressBar? = null

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
    /** 底部「上滑收起」箭头的浮动动画，页面销毁时要停 */
    private var arrowAnim: android.animation.ObjectAnimator? = null

    /** 是「锁屏时自动弹的」还是「预览」。预览不随解锁自动关闭 */
    private var fromLock = false

    /**
     * 这一页是「被系统锁屏压在下面」的那一次（MIUI 拒了「显示在锁屏上」）。
     *
     * 这种页面息屏时**没有亮屏、也没有全屏意图**，用户解锁那一下才是它的第一次露面。
     * 所以解锁时不能收它——收了就是「开了开关，锁屏什么都没发生」。
     * 见 [EXTRA_BEHIND_GUARD] 与 unlockRx。
     */
    private var behindGuard = false

    /** 进锁屏页之前悬浮歌词是开着的 → 退出时把它叫回来 */
    private var resumeFloat = false

    /**
     * 「用户真的把锁解开了」——撤页的唯一可靠信号。
     *
     * 不能只靠 onPause：这一页挂着 `showWhenLocked` 压在锁屏**之上**，
     * 解锁那一刻系统只是把 keyguard 收起来，我们的窗口还留在栈顶——
     * 不暂停、也不失焦，页面就那样杵在桌面前面，用户得再上滑一次才收得掉。
     * ACTION_USER_PRESENT 是系统在解锁完成后发的广播，正好对应这件事。
     */
    private val unlockRx = object : android.content.BroadcastReceiver() {
        override fun onReceive(c: Context?, intent: Intent?) {
            if (intent?.action != Intent.ACTION_USER_PRESENT) return
            if (!fromLock) return
            /*
             * 被系统锁屏压着的那一次（[behindGuard]）：解锁才是它的「登场」，
             * 绝不能收——用户要的就是「解锁之后显示锁屏播放页」。
             * 只有确实压在锁屏之上正常显示过的那次，解锁才把页面收掉
             * （否则它会在桌面前面杵着，用户得再上滑一次）。
             * 顺带：这一页放了很久、歌早就停了的话，也别在解锁时突然冒出来。
             */
            if (behindGuard) {
                if (!NowPlaying.playing) dismiss()
                return
            }
            dismiss()
        }
    }

    private val ticker = object : Runnable {
        override fun run() {
            sync()
            /* 息屏没人看：200ms 的重绘（歌词补间 + 进度条）纯耗电，降到 1.5s 够用 */
            val onScreen = try {
                (getSystemService(Context.POWER_SERVICE) as PowerManager).isInteractive
            } catch (_: Exception) {
                true
            }
            main.postDelayed(this, if (onScreen) 200 else 1500)
        }
    }
    private val clockTicker = object : Runnable {
        override fun run() {
            tickClock()
            main.postDelayed(this, 10_000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        alive = true
        inst = this
        /* 页面起来了，那条「拉页面」的通知就该收摊（它只是信使，不是给人看的） */
        try {
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .cancel(LOCK_NOTI_ID)
        } catch (_: Exception) {}
        /*
         * 压在锁屏之上——**只压，不点屏**。
         *
         * 这一页绝不许主动点亮屏幕（用户明确要求「锁屏后按电源键才出现」），所以：
         *   · 不调 `setTurnScreenOn(true)` / 不加 `FLAG_TURN_SCREEN_ON`。
         *     这两个不只是「开页时亮一下」——它们在 ActivityRecord 上留的是**持久标志**，
         *     屏幕熄了之后每次 relayout（换句歌词、进度重绘）系统都会再唤醒一次，
         *     真机日志里是每 1.3 秒一条 `TURN_ON:handleTurnScreenOn`，
         *     用户看到的就是「锁屏会隔一段时间亮一下」。
         *   · 不拿 `FULL_WAKE_LOCK | ACQUIRE_CAUSES_WAKEUP`（同理，也是自己点屏）。
         * 屏幕由用户按电源键点亮，页面在那一刻已经在栈顶了。
         *
         * **也不要** `FLAG_KEEP_SCREEN_ON`：这一页本身就是锁屏，用户放进口袋、
         * 扣在桌上时该按系统超时正常息屏。加了它等于「只要放着歌、只要停在锁屏页，
         * 屏幕就永不熄灭」——表现就是「锁屏页会阻拦息屏」，一晚上开着屏幕，烧电也烧屏。
         *
         * **永远挂上**，不看屏幕亮没亮：以前这里写的是 `applyShowWhenLocked(isInteractive(this))`，
         * 想在息屏时先不挂、亮屏再挂（躲 ANR）。但「挂/摘」这个动作本身就会让系统重新评估
         * 遮挡关系，一摘一挂之间系统锁屏会顶上来 —— 用户看到的就是
         * 「疏音锁屏 → 系统锁屏 → 疏音锁屏」。标志位保持常开，页面在栈顶就一直是它。
         * 屏幕亮不亮由电源键决定，跟挂不挂这个标志无关。
         */
        applyShowWhenLocked(true)
        setContentView(R.layout.activity_lock)

        /*
         * 这一页上只有两种图：封面大图、或者一片黑。
         *
         * 封面是服务异步取的，弱网时第一把常常失败（见 PlaybackService.loadArtAsync
         * 的重试）。页面每次起来都催一次：上一次彻底失败了就现在再试一把，
         * 免得「歌放了五分钟，锁屏一直是黑的」。
         */
        PlaybackService.instance?.refetchArt()

        /* 解锁 → 收页（见 unlockRx 的注释）。只在「锁屏自动弹的」那一次生效，
           手动预览时用户正在看着它，不该因为解锁动作把它撤掉。 */
        try {
            registerReceiver(unlockRx, android.content.IntentFilter(Intent.ACTION_USER_PRESENT))
        } catch (_: Exception) { /* 个别 ROM 限制动态注册，注册失败只是少了自动收页 */ }

        /*
         * 悬浮歌词是 TYPE_APPLICATION_OVERLAY，压在**所有**窗口之上——
         * 包括这一页。它一起，锁屏页上就是「浮窗两行字 + 标题 + 歌词板」三份
         * 文字叠在同一条高度上（真机截图里糊成一团，用户说的「布局乱了」）。
         *
         * 锁屏页自己就有歌词板，这一屏让浮窗歇着；退出时（onDestroy）再叫回来。
         * 只在自己开着时才动它，别把用户的开关状态改了。
         */
        if (FloatingLyrics.shown) {
            resumeFloat = true
            FloatingLyrics.hide()
        }

        val km = getSystemService(KEYGUARD_SERVICE) as KeyguardManager
        fromLock = km.isKeyguardLocked
        /* 「被压在锁屏下面」的那一次：解锁时不能收页（见 unlockRx） */
        behindGuard = intent?.getBooleanExtra(EXTRA_BEHIND_GUARD, false) == true

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
        /* 进度色跟歌词主色走（同一首歌的两个「已唱」标识要一致） */
        try {
            bar?.progressTintList =
                android.content.res.ColorStateList.valueOf(Color.parseColor(NowPlaying.color))
        } catch (_: Exception) {}

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
        board?.maxWidth = resources.displayMetrics.widthPixels -
            (52 * resources.displayMetrics.density).toInt()
        /*
         * 锁屏页铺**多行**（当前句居中、上下渐远渐淡），不放两行 KTV 字幕条：
         * 这一屏是整屏，只有两行字会显得空，也不像「音乐锁屏」。
         * 悬浮窗那边不开这个模式——它是条小窗，五行会糊成一团。
         */
        board?.multi = true
        board?.plateColor = Color.TRANSPARENT
        board?.hl = Color.parseColor(NowPlaying.color)

        findViewById<ImageButton>(R.id.lk_prev).setOnClickListener {
            PlaybackService.sendAction("prev")
        }
        playBtn?.setOnClickListener { PlaybackService.sendAction("playpause") }
        findViewById<ImageButton>(R.id.lk_next).setOnClickListener {
            PlaybackService.sendAction("next")
        }
        favBtn?.setOnClickListener { PlaybackService.sendAction("fav") }
        /* 上一首 / 下一首不会随状态变，开页就先摆好并染白 */
        findViewById<ImageButton>(R.id.lk_prev).apply {
            setImageResource(R.drawable.notif_prev)
            setColorFilter(Color.parseColor("#F2F3F7"))
        }
        findViewById<ImageButton>(R.id.lk_next).apply {
            setImageResource(R.drawable.notif_next)
            setColorFilter(Color.parseColor("#F2F3F7"))
        }

        /*
         * 上滑解锁：**跟手，而且整屏都能拖**。
         *
         * 之前把手势挂在 lk_root 的 OnTouchListener 上，只有「没被子 View 消费」
         * 的空白处才收得到——播控那三颗 ImageButton 和底部提示条都是 clickable，
         * 按下就被它们吃掉。用户的原话是「我不知道拖哪，我拖最下面却拖不动」。
         * 现在统一在 [dispatchTouchEvent] 里判手势：点按照旧给按钮（不抢事件），
         * 一旦识别为「向上拖」就把事件从子 View 手里收回来（先补一个 CANCEL 撤掉按下态）。
         *
         * 位移加在**内容列**（lk_body）而不是整页：封面和压暗层留在原地，
         * 拖的时候背景不跟着跑，也就不会在底部露出一条纯黑（那是「整页平移」的破绽）。
         */
        bodyView = findViewById(R.id.lk_body)
        limitPx = 110 * resources.displayMetrics.density
        slopPx = 8 * resources.displayMetrics.density
        /* 提示条：点一下也能收起（手动预览时用户往往就是点它） */
        findViewById<View>(R.id.lk_hint).setOnClickListener { dismiss() }
        /*
         * 箭头上下浮动：静止的图标只是个装饰，动起来才像「往上推」。
         * 1.1s 一个来回、有缓动，不抢眼但足够被发现。
         */
        findViewById<View>(R.id.lk_hint_arrow)?.let { arrow ->
            arrowAnim = android.animation.ObjectAnimator.ofFloat(
                arrow, View.TRANSLATION_Y, 0f, -6f * resources.displayMetrics.density,
            ).apply {
                duration = 1100
                repeatMode = android.animation.ValueAnimator.REVERSE
                repeatCount = android.animation.ValueAnimator.INFINITE
                interpolator = android.view.animation.AccelerateDecelerateInterpolator()
                startDelay = 500
                start()
            }
        }
    }

    /* ---------------- 上滑手势（整屏可拖） ---------------- */

    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        val body = bodyView ?: return super.dispatchTouchEvent(ev)
        val rootH = findViewById<View>(R.id.lk_root).height.coerceAtLeast(1)

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
                return super.dispatchTouchEvent(ev)
            }

            MotionEvent.ACTION_MOVE -> {
                if (!holding) {
                    val dy = ev.rawY - downY
                    val dx = ev.x - downX
                    /* 只抢「明显的向上手势」：横向滑动、往下拉、点按都留给子 View */
                    if (dy < -slopPx && kotlin.math.abs(dy) > kotlin.math.abs(dx)) {
                        holding = true
                        /*
                         * 子 View 已经收到 DOWN 了（按钮处于按下态），
                         * 补一个 CANCEL 让它复位，否则松手时会补发 click ——
                         * 用户只是往上滑，结果「上一首」被按了。
                         */
                        val cancel = MotionEvent.obtain(ev)
                        cancel.action = MotionEvent.ACTION_CANCEL
                        super.dispatchTouchEvent(cancel)
                        cancel.recycle()
                    } else {
                        return super.dispatchTouchEvent(ev)
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
                return super.dispatchTouchEvent(ev)
            }
        }
        return super.dispatchTouchEvent(ev)
    }

    /** 弹回原位：Overshoot 比线性更像「有弹性的页面」，而不是硬贴回去 */
    private fun settleBack() {
        val body = bodyView ?: return
        body.animate().cancel()
        body.animate()
            .translationY(0f)
            .alpha(1f)
            .setDuration(260)
            .setInterpolator(android.view.animation.OvershootInterpolator(1.15f))
            .withEndAction { body.translationY = 0f; body.alpha = 1f }
            .start()
    }

    /** 甩出去再收页：加速飞出，比匀速更像被「甩走」 */
    private fun flyOut() {
        val body = bodyView ?: return
        val h = findViewById<View>(R.id.lk_root).height.coerceAtLeast(1)
        body.animate().cancel()
        body.animate()
            .translationY(-h * 0.45f)
            .alpha(0f)
            .setDuration(190)
            .setInterpolator(android.view.animation.AccelerateInterpolator(1.7f))
            .withEndAction { dismiss() }
            .start()
    }

    /**
     * 页面已经在栈里、又被 `show()` 叫一次时走这里（`FLAG_ACTIVITY_CLEAR_TOP`）。
     *
     * **必须把两个标记重新读一遍**：`onCreate` 只在第一次跑，复用旧实例时那两行
     * 不会执行。不读的话，一次「正常显示」的页面被下一次「被压在锁屏下面」的
     * 请求复用时，`behindGuard` 还是旧的 false —— 用户解锁那一刻它就被收掉了，
     * 又变回「完全不显示」。反过来也一样：预览态被息屏请求复用会误留着不收。
     */
    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        if (intent == null) return
        setIntent(intent)
        fromLock = isKeyguardLocked()
        behindGuard = intent.getBooleanExtra(EXTRA_BEHIND_GUARD, false)
    }

    override fun onResume() {
        super.onResume()
        /* 亮屏才起重绘；息屏建出来的页面就静静躺着（见 setAwake） */
        setAwake(isInteractiveNow())
        markBehind()
        /*
         * 这里**故意不做**「多久拿不到焦点就收页」那种兜底。
         *
         * 早先怀疑「息屏时建出来的页面 resumed 却没焦点窗口」会触发
         * `ANR … does not have a focused window`，于是加了一道闸门。实测下来
         * （华为 Android 12 / HarmonyOS，页面在纯黑屏状态躺 150 秒）一条 ANR 都没有，
         * 页面好好活着，亮屏那一刻直接就位 —— 当年的 ANR 是 `setTurnScreenOn`
         * 反复点屏和电源键打架造成的，跟「留着页面」无关。闸门留着只会在正常场景
         * 里把页面误收掉，反而退回「亮屏看不见」。
         */
    }

    /**
     * 这一页到底有没有被系统锁屏压在下面 —— **看事实，不看 ROM 品牌**。
     *
     * 刚 resume 那一刻焦点还没分下来（系统要先跑完遮挡评估），所以延后 350ms 再问。
     * 拿到了焦点 = 我们压在锁屏之上（华为就是这条路，`mKeyguardOccluded=true`）；
     * 拿不到 = 被压在下面（MIUI 拒了「显示在锁屏上」，焦点留在 NotificationShade）。
     *
     * 判成「被压住」之后做两件事：
     *   1. 解锁时**不收页**（见 [unlockRx]）—— 那一瞬正是它第一次露面，收掉就是
     *      「猛然出现一下然后就消失」；
     *   2. 补一条通知告诉用户去哪儿开权限（一天一次）。
     */
    private var behindCheck: Runnable? = null

    private fun markBehind() {
        behindCheck?.let { main.removeCallbacks(it) }
        val r = Runnable {
            if (isFinishing || isDestroyed) return@Runnable
            /*
             * 只在屏幕亮着时判断。息屏那一刻这一页也会 resume，而那时
             * `hasWindowFocus()` 一定是 false、`isKeyguardLocked()` 一定是 true ——
             * 照着判会把华为（页面其实好好压着锁屏）也误判成「被压住」，
             * 解锁之后页面就赖在桌面前面不走了。
             */
            if (!isInteractiveNow()) return@Runnable
            if (!hasWindowFocus() && isKeyguardLocked()) {
                behindGuard = true
                postGuide(this)
            }
        }
        behindCheck = r
        main.postDelayed(r, 350)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        /*
         * 解锁之后这一页真的露出来了（拿到焦点、锁屏也收了），标记就该清掉：
         * 否则之后用户按 home 走人，[onPause] 会因为 behindGuard 一直不收页，
         * 这一页就永远堆在最近任务里。
         */
        if (hasFocus && !isKeyguardLocked()) behindGuard = false
    }

    override fun onPause() {
        super.onPause()
        main.removeCallbacks(ticker)
        main.removeCallbacks(clockTicker)
        /*
         * 用户用指纹/密码解锁了：系统会把我们压到后台，这里直接收掉，
         * 否则解锁后回桌面还能在最近任务里看到这一页。
         *
         * `behindGuard` 那一次例外：它本来就被压在系统锁屏**下面**，解锁正是它第一次
         * 露面的时刻。有的 ROM 会在收 keyguard 和发 ACTION_USER_PRESENT 之间插一次
         * pause/resume，这里要是先把页收了，用户解锁后还是什么都看不到——
         * 那就又变回「完全不显示」了。由 [unlockRx] 决定去留，它把标记清掉之后，
         * 下一次 pause（用户真的走了）照常收。
         *
         * **必须再要求「屏幕是亮的」**：息屏那一刻这一页也会 pause，而 `isKeyguardLocked`
         * 在部分 ROM（MIUI 实测）上要等息屏动画走完才翻成 true —— 只看它就会在息屏
         * 那一刻把页面收掉；下一次亮屏再重建，用户看到的就是「疏音锁屏 → 系统锁屏 →
         * 疏音锁屏」来回跳。屏幕黑着时一律不收。
         */
        if (fromLock && !behindGuard && !justPromoted() && isInteractiveNow() && !isKeyguardLocked()) dismiss()
    }

    /**
     * 刚被息屏那一刻提到前台吗（3 秒内）。
     *
     * `ACTION_SCREEN_OFF` 到达时 PowerManager 的 wakefulness 常常还没翻成 Asleep，
     * `isInteractive` 仍回 true —— 这时「暂停就要收页」和「刚提上来」会打架，
     * 把刚刚摆好的页面当场收掉。用时间窗把这一段盖掉。
     */
    private fun justPromoted(): Boolean =
        android.os.SystemClock.uptimeMillis() - promotedAt < 3000

    private fun isInteractiveNow(): Boolean = try {
        (getSystemService(Context.POWER_SERVICE) as PowerManager).isInteractive
    } catch (_: Exception) {
        true
    }

    override fun onDestroy() {
        alive = false
        if (inst === this) inst = null
        try { unregisterReceiver(unlockRx) } catch (_: Exception) {}
        main.removeCallbacks(ticker)
        main.removeCallbacks(clockTicker)
        /* 无限循环的箭头动画必须显式停：页面销毁了它还挂在 Choreographer 上烧帧 */
        arrowAnim?.cancel()
        arrowAnim = null
        bodyView = null
        /* 锁屏页走了，把刚才让位的悬浮歌词叫回来（用户本来就是开着的） */
        if (resumeFloat) {
            resumeFloat = false
            FloatingLyrics.show(this)
        }
        super.onDestroy()
    }

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        dismiss()
    }

    private fun isKeyguardLocked(): Boolean = try {
        (getSystemService(KEYGUARD_SERVICE) as KeyguardManager).isKeyguardLocked
    } catch (_: Exception) {
        false
    }

    /**
     * 挂上 / 摘下「压在系统锁屏之上」。
     *
     * **只在值真的要变时才动手**：`setShowWhenLocked` 会让系统重新跑一遍遮挡评估，
     * 每次调用都是一次全屏 relayout（真机上就是看得见的一闪）。所以用 [showLockedOn]
     * 记着当前状态，重复请求直接返回。
     *
     * 挂的时候**不带** turnScreenOn：亮屏是用户按电源键做的事。
     */
    private fun applyShowWhenLocked(on: Boolean) {
        if (showLockedOn == on) return
        try {
            if (Build.VERSION.SDK_INT >= 27) {
                setShowWhenLocked(on)
            } else {
                @Suppress("DEPRECATION")
                if (on) {
                    window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED)
                } else {
                    window.clearFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED)
                }
            }
            showLockedOn = on
        } catch (_: Exception) { /* 窗口已经没了：下次 onCreate 会重新挂 */ }
    }

    /**
     * 亮屏那一刻确认一次「还压在锁屏之上」。
     *
     * 正常情况下标志位从 onCreate 起就没摘过，这里是个空操作（见 [applyShowWhenLocked]）。
     * 留着它是为了两张意外情况：ROM 在息屏时自己把标志清了；或者页面刚好在这一刻
     * 被复用来重建，标志还没来得及挂。
     */
    private fun reassertLocked() {
        if (!showLockedOn) applyShowWhenLocked(true)
    }

    /**
     * 页面建好了、但不在前台（被别的应用盖住、或者干脆躺在后台）：
     * 把整个任务提到前台。
     *
     * 这和 `startActivity` 是两件事：它不「启动」任何 Activity，只是把已有任务的层级
     * 调上来（只要 REORDER_TASKS 这个普通权限，已在清单里声明），所以 Android 10+
     * 那道「后台不许启动 Activity」的闸门（真机日志
     * `Abort background activity starts`）管不到它。息屏时屏幕是黑的，这一下
     * 「提到前台」用户看不见，按下电源键才看到页面。
     */
    private fun promoteIfBehind() {
        promotedAt = android.os.SystemClock.uptimeMillis()
        /* 先把「压在锁屏之上」挂回去：等它回到前台时已经是压着锁屏的状态，
           亮屏那一帧就是它，不会先露出系统锁屏 */
        reassertLocked()
        if (hasWindowFocus()) return
        try {
            val am = getSystemService(Context.ACTIVITY_SERVICE) as android.app.ActivityManager
            am.moveTaskToFront(taskId, 0)
        } catch (_: Exception) { /* ROM 不让就算了，亮屏时还会再试一轮 */ }
    }

    /**
     * 息屏 / 亮屏：停 / 起重绘。
     *
     * 黑着屏时那一串 200ms 的补间（歌词染色、进度、频谱）纯耗电，而且会让系统
     * 一直有绘制请求 —— 用户明确说过「不能阻止息屏，太费电」。停掉重绘，
     * 页面本身留在栈顶，亮屏那一帧原样就在。
     */
    private fun setAwake(on: Boolean) {
        awake = on
        main.removeCallbacks(ticker)
        main.removeCallbacks(clockTicker)
        if (!on) return
        main.post(ticker)
        main.post(clockTicker)
        /* 黑屏期间没跑的那几拍：立刻同步一帧，亮屏第一眼不是旧进度 */
        sync()
    }

    /**
     * 收页。
     *
     * `isFinishing` 那道闸是给「息屏」这条路径的：它会主动来收页，而那时用户
     * 可能刚好也在上滑、或者页面已经在收尾，重复 `finish()` + `overridePendingTransition`
     * 在个别 ROM 上会抛 `IllegalStateException`（已经走完收场动画的窗口不再接受转场）。
     */
    private fun dismiss() {
        if (isFinishing) return
        dismissedAt = android.os.SystemClock.uptimeMillis()
        finish()
        @Suppress("DEPRECATION")
        try {
            overridePendingTransition(0, android.R.anim.fade_out)
        } catch (_: Exception) { /* 窗口已经收掉：转场没得可放 */ }
    }

    /* ---------------- 刷新 ---------------- */

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

    private fun sync() {
        /* 没有曲目了就把这页收掉，别留一张写着上一首的假锁屏 */
        if (NowPlaying.title.isBlank()) {
            dismiss()
            return
        }
        /* 文本只在**真的变了**的时候写。
           `TextView.setText` 每次都会重建一份 Layout 并让整页重新测量——这一屏
           200ms 一 tick，歌名/歌手/时长这三行要是每拍都写一遍，就是每 200ms
           把整个锁屏页 layout 一次，正在扫过去的歌词必然掉帧（用户反馈的「染色卡」）。 */
        val t = NowPlaying.title
        if (t != lastTitle) { lastTitle = t; titleTv?.text = t }
        val ar = NowPlaying.artist.ifBlank { "疏音" }
        if (ar != lastArtist) { lastArtist = ar; artistTv?.text = ar }
        /* 悬浮窗里换过色，锁屏页跟着换（两处读同一份 NowPlaying） */
        if (NowPlaying.color != lastColor) {
            lastColor = NowPlaying.color
            val c = try { Color.parseColor(NowPlaying.color) } catch (_: Exception) { Color.parseColor("#FFC94D") }
            board?.hl = c
            try { bar?.progressTintList = android.content.res.ColorStateList.valueOf(c) } catch (_: Exception) {}
        }
        if (board?.multi == true) {
            /* 多行版：整版上下文由前端推（±2），这里只管画 */
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
