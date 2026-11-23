package cn.shuyin.player

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Base64
import android.util.Log
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.app.Activity
import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.PowerManager
import android.os.SystemClock
import android.widget.FrameLayout
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileOutputStream

/**
 * 1×1 **全透明** PNG：封面抽不到时回它，避免 <img> 露出系统破图标。
 * 注意别抓网上的「1×1 base64」凑数——流传最广的那串其实是**红色**像素，
 * 结果封面变成一个红方块（实测踩过）。这串是用 zlib 现生成的 RGBA 全 0。
 */
private val EMPTY_PNG: ByteArray = Base64.decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=",
    Base64.DEFAULT,
)

/**
 * 唯一的界面容器：一个 WebView 装整个前端。
 *
 * 前端资源不走 `file://`（那是不透明来源，localStorage / fetch 全被卡），
 * 而是伪装成一个 https 域名 `appassets.androidplatform.net`，
 * 由 `shouldInterceptRequest` 从 APK 的 assets 里直接喂给 WebView。
 * 这样前端代码在桌面（Tauri）、浏览器预览、安卓三处行为一致，不用写任何分支。
 */
class MainActivity : Activity() {

    private lateinit var web: WebView

    /** 界面容器：WebView + 锁屏播放页（覆盖层） */
    private lateinit var rootView: FrameLayout

    private var lockPanel: LockScreenPanel? = null

    /** 当前是不是在前台（熄屏时判断「该不该弹锁屏页」用） */
    @Volatile
    private var resumed = false

    /** 最近一次 onPause 的时刻：熄屏广播常常比 onPause 晚到，得认这一下 */
    @Volatile
    private var pausedAt = 0L

    /**
     * 「熄屏时被服务从后台拉起来」还没铺面板。
     *
     * onCreate 里窗口刚建好、`NowPlaying` 可能还没同步，所以标志先挂上，
     * 等第一次 onResume 再决定要不要铺——那时播放状态一定是准的。
     */
    private var pendingLockNow = false

    /**
     * 这一屏是「熄屏时被服务从后台拉起来」才铺的（不是用户自己切回来的）。
     *
     * 用户 2026-11-17：「在别的应用里锁屏，锁屏页出来了，解锁后自己进了疏音」。
     * 这是必然的——面板是主窗口里的一层，服务为了让它在锁屏上出现，把整个任务
     * 拉到了前台；解锁之后锁屏旗子摘掉，露出来的就是主界面。
     *
     * 所以记一笔「这一趟是被拉起来的」，解锁时再把任务退回后台，用户回到他原本
     * 待着的那个应用。**只在这一种情况下退**：用户本来就是从疏音里熄屏的
     * （走 `onScreenOff` 那条），解锁后当然应该回到疏音。
     */
    private var pulledForLock = false

    /**
     * 解锁早鸟探测：比 `ACTION_USER_PRESENT` 早一步把面板收掉、把任务退回后台。
     *
     * 华为这条广播要等解锁动画**走完**才发，而窗口在动画第一帧就已经露出来了。
     * 2026-11-17 用户录屏逐帧对时：22:47:10.4 屏幕上已经是疏音搜索页，
     * 11.27 才收到 USER_PRESENT —— 中间那 0.9 秒就是「解锁后应用弹一下再退出」。
     * 亮屏后每 110ms 问一次 `isKeyguardLocked()`，它跟着 keyguard 消失立刻变，
     * 比广播早得多；连续两拍都是「已解锁」才动手，防 ROM 亮屏瞬间的假信号。
     */
    private val unlockProbe = Runnable { probeUnlock() }
    private var probeFrom = 0L
    private var probeTries = 0
    private var probeHits = 0

    /** 为了退场不露相把整棵视图树藏了，等窗口真的不可见（onStop）再亮回来 */
    private var restoreOnStop = false

    /** 锁屏页自己要求的全屏（与前端 `sysbars` 的 barsHidden 分开记，别互相覆盖） */
    private var lockBars = false

    private var bridge: Bridge? = null

    /**
     * 这一次「渲染进程崩了 → 重建」已经重试了几次。
     *
     * 页面正常加载完就清零（见 `onPageFinished`）：崩一次重建一次是正常的自愈，
     * 但同一份页面连续崩两次说明重建也救不了，再把用户往闪屏里推就没意义了。
     */
    private var webRebuilds = 0

    /** SAF 选文件的等待者：pick_playlist_file 是同步命令模型，安卓的选文件是异步回调，中间靠这个搭桥 */
    private var pickResolve: ((String?) -> Unit)? = null

    /** 下载目录选择器的等待者（`ACTION_OPEN_DOCUMENT_TREE`） */
    private var dirResolve: ((String?) -> Unit)? = null

    companion object {
        /**
         * 平台登录的等待者。
         *
         * **为什么放在 companion 而不是实例字段**：登录窗（`PlatformLoginActivity`）结束时
         * 直接往这里投结果，不经过 `startActivityForResult` 的 result 通道。
         * 主界面是 `launchMode="singleTask"`，这种 Activity 发起
         * `startActivityForResult` 时，系统可能在**立刻**先回调一次
         * `onActivityResult(RESULT_CANCELED, null)`——那一下把等待者消费掉之后，
         * 用户真正登完就没有人接了。四个平台全部「提示没拿到登录凭证」，
         * 最符合的就是这个共因。静态字段不受 Activity 实例被重建/result 提前到达影响。
         */
        @Volatile
        private var loginResolve: ((org.json.JSONObject) -> Unit)? = null

        /** 当前活动实例：Bridge 的命令跑在线程池里，要弹权限框必须回到它身上 */
        @Volatile
        var inst: MainActivity? = null

        /**
         * 熄屏时「从后台把主窗口拉回来」带的那颗标志。
         *
         * 用户在别的应用里熄屏时，这一层窗口根本不在前台，光挂 `showWhenLocked`
         * 没用——必须先把任务拉回来。拉回来之后要不要弹面板，靠这颗 extra 分辨。
         */
        const val EXTRA_LOCK_NOW = "lock_now"

        /**
         * 「该铺锁屏页」这颗 extra 的**发出时刻**（`elapsedRealtime`）。
         *
         * 熄屏拉起那条路里有一手是 AlarmManager 代发的 PendingIntent（700ms 后）。
         * 锁屏状态下系统会把它压后执行，**可能压到用户解锁之后**才送到——那时
         * 窗口已经在前台了，extra 还是真的，一收到就铺一屏锁屏页盖在应用上
         * （用户的原话：「点桌面图标，打开的是锁屏页」）。
         * 带上时间戳，过期的一律当没收到。
         */
        const val EXTRA_LOCK_AT = "lock_at"

        /** 熄屏拉起那颗 extra 的有效期：超过这么久的迟到通知不再铺面板 */
        private const val LOCK_NOW_TTL_MS = 3000L


        /**
         * 主窗口现在算不算「在用户眼前」。
         *
         * 熄屏广播（SCREEN_OFF）经常比 `onPause` 晚几百毫秒，所以给 1.2 秒宽限；
         * 超过说明用户早就切走了，那种情况窗口不在前台、也看不见。
         */
        fun foregroundNow(): Boolean {
            val a = inst ?: return false
            if (a.resumed) return true
            return a.pausedAt > 0 && android.os.SystemClock.uptimeMillis() - a.pausedAt < 1200
        }

        /**
         * 严格版：**此刻**窗口就在前台。
         *
         * 只用在「事后抽查」上（熄屏拉起后 1.2 秒回看窗口到没到），那种场合不能有
         * `foregroundNow` 那条 1.2 秒宽限——刚 onPause 的窗口会被算成看得见，
         * 结论就变成「没被拦」，恰恰是最需要报出来的时候。
         */
        fun visibleNow(): Boolean = inst?.resumed == true

        /**
         * 窗口自己处理熄屏的时刻。
         *
         * 熄屏这件事**两边都在听**：Activity 的那份负责铺面板，服务的那份负责
         * 把后台窗口拉回来。可华为的 `ACTION_SCREEN_OFF` 会来两趟（系统广播一趟、
         * `onPause` 里发现屏幕已黑再兜一趟），第二趟到服务时窗口已经 onPause，
         * `foregroundNow()` 过了 1.2 秒宽限就变成 false —— 服务以为窗口不在前台，
         * 又去 `startActivity` + `moveTaskToFront` + 挂一个 700ms 的闹钟 PendingIntent
         * 把任务栈重排一遍。真机日志（19:09:12 / 19:09:14）就是这个时序，
         * 用户看到的是「解锁后落到桌面」「点图标进来却弹着锁屏页」。
         *
         * 所以：窗口只要**真的铺了面板**（或面板本来就开着），就记一笔，服务端看到就跳过。
         */
        @Volatile
        private var screenOffAt = 0L

        fun markScreenOffHandled() {
            screenOffAt = android.os.SystemClock.uptimeMillis()
        }

        /**
         * 屏幕又亮了：上一轮熄屏的账作废。
         *
         * 以前只靠 5 秒 TTL 自然过期，于是「应用内熄屏看到面板 → 解锁 → 马上切到
         * 微信 → 立刻熄屏」这一串（间隔常常不到 5 秒）会被当成同一轮，服务端直接
         * skip —— 用户看到的就是「应用里能弹，换个应用就不弹」。按「亮屏即清账」
         * 分轮次，TTL 只用来吃掉同一次熄屏的两趟广播。
         */
        fun clearScreenOffHandled() {
            screenOffAt = 0L
        }

        /** 同一次熄屏的两趟广播之间：窗口已经处理过（面板已铺好），服务端别再拉任务 */
        fun screenOffHandled(): Boolean =
            screenOffAt > 0 && android.os.SystemClock.uptimeMillis() - screenOffAt < 2000

        /**
         * 冷启动时「其他应用打开」送进来的文件。
         *
         * 那一刻 WebView 还没加载完，`evaluateJavascript` 打出去是丢的
         * （页面随后导航到真地址，连 about:blank 上的执行结果都一起没了）。
         * 所以先存在这里，前端启动后自己来 `take_open_file` 取一次；
         * 运行期间再送进来的走 `app://open-file` 事件，两条路都通。
         */
        @Volatile
        private var pendingOpen: String? = null

        /**
         * 前端已经起来了（它第一次来 `take_open_file` 就算就位）。
         *
         * 只靠 `onPageFinished` 判断太早：那一刻 React 还没挂载，`evaluateJavascript`
         * 推过去的事件没有人订阅，静默丢掉——真机第一次测就是这么「什么都没发生」。
         * 以「前端主动来取过」为准，之后送进来的文件才走事件推送。
         */
        @Volatile
        private var jsReady = false

        /** 取走并清空（前端只取一次，避免每次重挂载都弹一遍导入框） */
        fun takePendingOpen(): String? {
            jsReady = true
            val v = pendingOpen ?: return null
            pendingOpen = null
            return v
        }

        /**
         * 把登录结果交给等待者。**幂等**：result 通道和进程内直投两条路都会调它，
         * 谁先到谁算，后到的那次因为等待者已经是 null 而什么也不做。
         */
        fun deliverLogin(r: org.json.JSONObject) {
            val cb = loginResolve ?: return
            loginResolve = null
            try { cb(r) } catch (_: Exception) { }
        }

        /**
         * 把登录结果当**原生事件**推给前端（`platform://login`）。
         *
         * 命令通道那条路依赖「此刻正好有一个 JS 调用在等」；等待者一旦被提前消费
         * （singleTask 的假回调、调用超时先到），用户真登成了也没人接。
         * 事件这条路不看有没有人在等，前端收到就落盘——这是三条路里最可靠的一条。
         */
        fun postLoginEvent(json: org.json.JSONObject) {
            val act = inst ?: return
            try { act.bridge?.emit("platform://login", json.toString()) } catch (_: Exception) { }
        }
    }

    /**
     * 打开平台官方登录页（内嵌 WebView），凭证在 [PlatformLoginActivity] 里从
     * CookieManager 抓。结果由 `deliverLogin` 交回（result 通道 / 进程内直投双保险）。
     */
    fun platformLogin(source: String, force: Boolean = false, cb: (org.json.JSONObject) -> Unit) {
        loginResolve = cb
        val intent = android.content.Intent(this, PlatformLoginActivity::class.java)
            .putExtra(PlatformLoginActivity.EXTRA_SOURCE, source)
            .putExtra(PlatformLoginActivity.EXTRA_FORCE, force)
        try {
            startActivityForResult(intent, 4102)
        } catch (e: Exception) {
            loginResolve = null
            cb(org.json.JSONObject().put("ok", false).put("error", "打不开登录页：${e.message}"))
        }
    }

    /** 打开系统文件选择器（歌单导入）。回调结果在 onActivityResult 里交给 pickResolve */
    fun pickPlaylistFile(cb: (String?) -> Unit) {
        pickResolve = cb
        val intent = android.content.Intent(android.content.Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(android.content.Intent.CATEGORY_OPENABLE)
            type = "*/*"
            putExtra(android.content.Intent.EXTRA_MIME_TYPES, arrayOf(
                "application/json", "text/*", "application/octet-stream", "*/*",
            ))
        }
        try {
            startActivityForResult(intent, 4101)
        } catch (e: Exception) {
            pickResolve = null
            cb(null)
        }
    }

    /**
     * 选下载目录（设置 → 下载 → 保存目录 → 更改…）。
     *
     * 为什么必须是 SAF：Android 10 起分区存储不允许应用随便写公共目录的绝对路径，
     * 唯一能「写进用户指定的任意文件夹」的合法通道就是 `ACTION_OPEN_DOCUMENT_TREE`。
     * 拿到授权后 `takePersistableUriPermission` **持久化**这一次授权——否则重启应用
     * 这份 Uri 就失效了，用户选过的目录等于没选。
     */
    fun pickDownloadDir(cb: (String?) -> Unit) {
        dirResolve = cb
        val intent = android.content.Intent(android.content.Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
            addFlags(
                android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION or
                    android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                    android.content.Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or
                    android.content.Intent.FLAG_GRANT_PREFIX_URI_PERMISSION,
            )
        }
        try {
            startActivityForResult(intent, 4103)
        } catch (e: Exception) {
            dirResolve = null
            cb(null)
        }
    }

    /* ---------------- 「其他应用打开」送进来的音源脚本 ---------------- */

    /**
     * 处理外部应用送进来的文件（VIEW = 点文件选「其他应用打开」，SEND = 从别的应用分享过来）。
     *
     * 只认 `content://` / `file://` 的音源脚本；文件名与内容都由
     * [stageIncoming] 拷进 cache/inbox 再交给前端，因为 content Uri 的读取权
     * 跟着当初那个 Intent 走，放到工作线程或稍后再读都可能已经失效。
     *
     * **这里不做导入**：导入是用户的决定，要由前端弹确认框（用户的原话：
     * 「并让他确认是否要导入音源」）。这一层只负责把文件摆到桌上。
     */
    private fun handleIncoming(intent: android.content.Intent?) {
        if (intent == null) return
        val uri: Uri = when (intent.action) {
            android.content.Intent.ACTION_VIEW -> intent.data
            android.content.Intent.ACTION_SEND -> {
                @Suppress("DEPRECATION")
                intent.getParcelableExtra(android.content.Intent.EXTRA_STREAM) as? Uri
            }
            else -> null
        } ?: return
        Log.i("Shuyin", "open-file: action=${intent.action} uri=$uri jsReady=$jsReady")
        val b = bridge
        Thread {
            val json = stageIncoming(uri)?.toString()
            if (json == null) {
                Log.w("Shuyin", "打开方式：读不到这个文件 $uri")
                return@Thread
            }
            /*
             * **两条路都留着**：存一份给「前端还没就位」的时候取，前端就位了再推事件。
             * 前端按 payload 里的 id 去重，所以同一份文件被取到又被推到也只弹一个框。
             * 只推不存会在启动竞态里丢（第一次真机测试就是这么无声无息的）。
             */
            pendingOpen = json
            if (jsReady && b != null) b.emit("app://open-file", json)
        }.start()
    }

    /**
     * 把外部 Uri 拷进 `cache/inbox`，顺手判断「像不像音源脚本」。
     *
     * 返回 `{ path, name, size, source }`；`source=false` 表示内容里找不到
     * `@name` / `module.exports` 这类洛雪脚本的痕迹——前端据此把确认文案
     * 改成「这个文件看起来不是音源脚本，仍要导入吗」。
     */
    private fun stageIncoming(uri: Uri): org.json.JSONObject? {
    return try {
        var name = ""
        try {
            contentResolver.query(
                uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null,
            )?.use { c -> if (c.moveToFirst() && !c.isNull(0)) name = c.getString(0) ?: "" }
        } catch (_: Exception) { /* 查不到名字不影响导入，后面按 Uri 猜 */ }
        if (name.isBlank()) {
            name = uri.lastPathSegment?.substringAfterLast('/')?.takeIf { it.isNotBlank() } ?: "音源脚本.js"
        }
        val dir = File(cacheDir, "inbox").apply { mkdirs() }
        /* 文件名只用来显示，落盘用安全名（外部来源的名字可能带斜杠 / 引号） */
        val safe = name.replace(Regex("[\\\\/:*?\"<>|\\s]"), "_").takeLast(90).ifBlank { "source.js" }
        val f = File(dir, safe)
        val input = contentResolver.openInputStream(uri) ?: return null
        input.use { src -> FileOutputStream(f).use { out -> src.copyTo(out) } }
        val head = try { f.readText().take(6000) } catch (_: Exception) { "" }
        val looks = head.contains("@name") || head.contains("module.exports") ||
            head.contains("musicUrl") || head.contains("lx.")
        Log.i("Shuyin", "open-file: staged ${f.name} ${f.length()}B source=$looks")
        val obj = org.json.JSONObject()
            .put("id", "${System.currentTimeMillis()}-${uri.hashCode()}")
            .put("path", f.absolutePath)
            .put("name", name)
            .put("size", f.length())
            .put("source", looks)
        /*
         * 再落一份 pending.json：前端启动时用 Rust 的 take_open_file 主动取一次。
         *
         * 只靠 emit 事件在冷启动会丢——WebView 就绪的时刻晚于 Intent 到达，
         * 那一下没人接就永远丢了（真机第一次测试就是这么无声无息的）。
         * 目录 / 文件名两端必须一致：caches/inbox/pending.json。
         */
        try {
            File(dir, "pending.json").writeText(obj.toString())
        } catch (e: Exception) {
            Log.w("Shuyin", "open-file: 写 pending.json 失败 ${e.message}")
        }
        obj
    } catch (e: Exception) {
        Log.w("Shuyin", "打开方式：${e.message}")
        null
    }
    }

    override fun onNewIntent(intent: android.content.Intent?) {
        super.onNewIntent(intent)
        /* singleTask：应用已经在后台时，新的「打开方式」走这里而不是 onCreate */
        setIntent(intent)
        /*
         * 熄屏时被服务拉回来的（窗口还活着、只是在后台）：直接铺面板。
         * 不能等 onResume —— 那时窗口已经画了一帧主界面出去了。
         */
        if (intent?.getBooleanExtra(EXTRA_LOCK_NOW, false) == true) {
            intent.removeExtra(EXTRA_LOCK_NOW)
            /* 拉起这件事本身成功了就先记账：迟到的 extra 不该被算成「系统拦截」 */
            LockScreen.markAck()
            if (lockNowWanted(intent)) {
                applyLockWindow(true)
                if (LockScreen.enabled(this) && NowPlaying.playing) {
                    showLockPanel(preview = false)
                    if (lockPanel?.shown != true) applyLockWindow(false)
                    else pulledForLock = true
                } else {
                    applyLockWindow(false)
                }
            } else {
                applyLockWindow(false)
                /*
                 * 这一次是**我们自己**发出去的「熄屏拉起」，只是迟到（或者屏幕已经解锁）。
                 *
                 * 那一发 `startActivity` / 那颗迟到的闹钟 PendingIntent 已经把任务带到
                 * 前台了，extra 虽被忽略，窗口却留在前台 —— 用户看到的就是
                 * 「解锁后过一会儿应用自己又打开了」。所以这里要把任务退回去。
                 *
                 * 只在「窗口原本在后台」时退：用户正用着应用的时候收到一颗历史 extra，
                 * 不能把他踢出去。
                 */
                if (!resumed) {
                    LockScreen.trace("lock_now 无效且窗口原在后台 → 任务退回后台")
                    dropTaskNow(hideWeb = true)
                }
            }
        }
        handleIncoming(intent)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: android.content.Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == 4102) {
            /*
             * 登录窗已经把结果**进程内直投**过了（见 companion 里的 deliverLogin），
             * 这里只是 result 通道的兜底：直投那一手因为进程/回调丢失没送到时，
             * 靠这一份补上。两条都幂等，不会重复回调。
             *
             * `data == null` = 登录 Activity 没走我们自己的收尾（按系统返回退出、
             * 被 singleTask 的 result 提前取消、被系统回收）——**这不叫「没拿到登录凭证」**。
             * 以前这种情况把 cancel=false 传上去，前端只能落到兜底文案
             * 「没拿到登录凭证」，用户明明是自己退出来的，却像功能坏了。
             */
            if (data == null) {
                /*
                 * 但**窗还开着**的时候这一次一定是假的：singleTask 发起 startActivityForResult
                 * 时系统会抢在真结果之前回一个 data=null。这时候把它当「用户取消」，
                 * 等待者就被消费掉了，用户接下来真登成功也回不来
                 * （「每次都提示没拿到登录凭证」的真身）。窗还活着就当作没看见。
                 */
                if (!PlatformLoginActivity.alive) {
                    deliverLogin(org.json.JSONObject().put("ok", false).put("cancel", true))
                }
                return
            }
            val cookie = data.getStringExtra(PlatformLoginActivity.EXTRA_COOKIE)
            val error = data.getStringExtra(PlatformLoginActivity.EXTRA_ERROR)
            val cancel = data.getBooleanExtra(PlatformLoginActivity.EXTRA_CANCEL, false)
            deliverLogin(
                org.json.JSONObject().apply {
                    put("ok", !cookie.isNullOrEmpty())
                    if (!cookie.isNullOrEmpty()) put("cookie", cookie)
                    if (!error.isNullOrEmpty()) put("error", error)
                    put("cancel", cancel)
                },
            )
            return
        }
        if (requestCode == 4103) {
            val uri = if (resultCode == RESULT_OK) data?.data else null
            if (uri != null) {
                /* 持久化授权：重启后还要能往这个目录里写 */
                try {
                    contentResolver.takePersistableUriPermission(
                        uri,
                        android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION or
                            android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
                    )
                } catch (_: Exception) {
                    /* 个别 ROM 的 DocumentsProvider 不支持持久化；这一次仍可用，下次会要求重选 */
                }
                /*
                 * 在这里就落盘，而不是等 Bridge 那边拿结果再存。
                 *
                 * 用户在系统选择器里慢慢翻是常事，命令那头的等待可能早就超时了；
                 * 只靠返回值的话，「选了但界面还是旧路径」就会变成新的 bug。
                 * 存 + 推事件是幂等的：Bridge 那头再到手时重复设置一次而已。
                 */
                DownloadStore.setTree(uri)
                bridge?.emit("downloads://dir", DownloadStore.stateJson().toString())
            }
            val cb = dirResolve
            dirResolve = null
            cb?.invoke(uri?.toString())
            return
        }
        if (requestCode != 4101) return
        val cb = pickResolve ?: return
        pickResolve = null
        // content:// URI 直接回给前端；read_text_abs / read_bin_abs 都认它
        val uri = if (resultCode == RESULT_OK) data?.data?.toString() else null
        cb(uri)
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Sy.init(this)
        inst = this

        // 车机：锁横屏 + 常亮。车机屏本来就是横的，跟着传感器转会把界面拧过来
        if (BuildConfig.CAR) {
            requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }

        /*
         * 容器从「直接 setContentView(web)」换成一个 FrameLayout：
         * 锁屏播放页是叠在它上面的一层（见 [LockScreenPanel]）。
         * 这一层是懒加载的 —— 没开锁屏页、或者从没熄过屏的用户，
         * 根本不会 inflate 那份布局，内存和首帧都不受影响。
         */
        rootView = FrameLayout(this)
        setContentView(rootView)
        /*
         * **永远让 Chromium 认为「页面可见」。**
         *
         * WebView 把「窗口可见性」当页面可见性：有别的 Activity 盖上来时窗口变
         * GONE，Chromium 就把文档标成 hidden，JS 定时器整组冻住——当年独立
         * LockActivity 时代实测「6 秒一次的 setInterval 一次都不跑，
         * performance.now() 照走」就是这个。现在跨应用熄屏会拉起那个独立
         * 锁屏 Activity（见 LockActivity），主窗口被它盖住，这一手必须兜住：
         * 自动切歌整条链（take 直链 → play_url）捏在 JS 里，冻了就是
         * 「锁屏听完一首就停在两首之间」。
         *
         * 代价是应用在后台时 JS 照跑（渲染合成仍会被 INVISIBLE 挡住，不费 GPU），
         * 对音乐播放器这是想要的：预告表、暂停预缓存本来就需要后台的 JS 定时器。
         */
        web = object : WebView(this) {
            override fun onWindowVisibilityChanged(visibility: Int) {
                super.onWindowVisibilityChanged(View.VISIBLE)
            }
        }
        rootView.addView(
            web,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            // 自动播放：界面里点一下歌就该出声，不要每个文件都再要一次手势
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            allowFileAccess = false
            allowContentAccess = true
            cacheMode = WebSettings.LOAD_DEFAULT
            useWideViewPort = true
            loadWithOverviewMode = false
            textZoom = 100
            /*
             * 禁掉 WebView 自己的缩放与滚动。
             *
             * 真机上「整个界面能左右上下拖」不是页面里有宽元素那么简单：
             * useWideViewPort 一旦认为文档比视口宽，WebView 就建立一个可平移的
             * 画布，双指还能再缩放。这些手势在 App 里全是误触——横向拖走半个
             * 界面、纵向拖出一片底色，用户以为界面错位。
             * 页面内的滚动一律交给 .page 这个自绘容器，WebView 只负责渲染。
             */
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            // 音源脚本靠 Worker 跑（洛雪脚本的宿主约定），必须开
            setSupportMultipleWindows(false)
        }
        // 到边界别再回弹/发光：那是「还能继续滑」的暗示
        web.overScrollMode = View.OVER_SCROLL_NEVER
        web.isHorizontalScrollBarEnabled = false
        web.isVerticalScrollBarEnabled = false
        web.setBackgroundColor(0xFF0A0B0F.toInt())

        bridge = Bridge(web)
        web.addJavascriptInterface(bridge!!, "ShuyinNative")

        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val url = request.url ?: return null
                if (url.host != "appassets.androidplatform.net") return null
                val path = url.path ?: "/"
                if (path.startsWith("/cover/")) return coverResponse(path.removePrefix("/cover/"))
                if (path.startsWith("/cachefile")) return cacheFileResponse(url)
                return assetResponse(if (path == "/" || path.isBlank()) "www/index.html" else "www" + path)
            }

            /**
             * 渲染进程崩了：**默认行为是把整个应用一起杀掉**。
             *
             * 真机日志（华为 ALN-AL00 / EMUI 14，2026-11-17）：
             *   `Abort message: '[FATAL:crashpad_client_linux.cc(798)] Render process
             *    (25079)'s crash wasn't handled by all associated webviews,
             *    triggering application crash.'`
             * 之后 `Process cn.shuyin.player has died: prcp FGS` —— 播放中的
             * 前台服务、预告表、锁屏页一起没了，用户听到的就是「放着放着突然停」。
             *
             * 返回 true 表示「我处理了」，系统就不会再杀进程；播放本身在
             * `PlaybackService` 里，跟 WebView 无关，还能继续响。界面靠重建
             * Activity 恢复（页面重新加载后，前端会走原生恢复那条路把队列和
             * 进度接管回来）。
             *
             * 连续崩就认输：同一份页面对同一台机器反复崩，重建只会让用户看到
             * 反复闪屏；留一份音频在那儿放，比来回闪强。
             */
            @android.annotation.TargetApi(26)
            override fun onRenderProcessGone(
                view: WebView?,
                detail: android.webkit.RenderProcessGoneDetail?,
            ): Boolean {
                val crashed = detail?.didCrash() == true
                LockScreen.trace("webview 渲染进程没了 didCrash=$crashed 重建=${webRebuilds + 1}")
                if (webRebuilds < 2) {
                    webRebuilds++
                    /* 不能在这一帧里 recreate：崩溃回调还没走完，窗口正在拆 */
                    rootView.postDelayed({ runCatching { recreate() } }, 500)
                }
                return true
            }

            override fun onPageFinished(view: WebView, url: String?) {
                Log.i("Shuyin", "page finished: $url")
                /* 页面真的加载完了：崩溃重建的额度还回去，下次崩还能自愈 */
                webRebuilds = 0
                /*
                 * 必须在这里再推一次。
                 * onCreate 里那次跑在页面还没加载完的时刻，evaluateJavascript 写在
                 * about:blank 上，随后导航到真页面就冲掉了——日志里能看到
                 * 「insets: top=41dp」出现在「page finished」之前，而页面里读到的
                 * --sy-safe-top 是空的，顶栏于是被状态栏压住。
                 */
                pushInsets()
                /*
                 * 再补一次，并且**先重置守卫**。
                 *
                 * 上面那次仍可能打在一个还没提交的文档上被丢掉，但守卫已经记成
                 * 「这个值推过了」，之后所有调用都被跳过——实测冷启动后
                 * `--sy-safe-top` 一直是空串，直到第一次打开播放页调 sysbars 才补上。
                 * 而那次写入恰好落在进场动画里：`<html>` 上写自定义属性会让**整棵文档**
                 * 重算样式（真机 1217 个元素 / 36ms + 28ms），开页那三下顿卡有一半是它的。
                 * 现在把这次补写挪到启动期（splash 还盖着屏幕），进场时就不会再有 HTML 级写入。
                 */
                view.postDelayed({
                    lastInsetTop = Int.MIN_VALUE
                    lastInsetBottom = Int.MIN_VALUE
                    pushInsets()
                }, 600)
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                Log.d("ShuyinJS", "${m.message()} (${m.sourceId()}:${m.lineNumber()})")
                return true
            }
        }

        // 允许用 chrome://inspect 调试：出问题时连一下就能看到 console
        WebView.setWebContentsDebuggingEnabled(true)

        web.loadUrl("${Sy.HOST}/index.html")

        // 系统栏可能压在 WebView 上（沉浸页尤其明显），把真实内缩量告诉前端
        web.post { pushInsets() }

        // 键盘弹出 / 旋转 / 分屏都会改 WebView 尺寸，安全区要跟着重算（否则播放条被键盘盖住）
        web.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> pushInsets() }

        askPermissions()

        /*
         * 冷启动就是「用其他应用打开某个音源脚本」进来的：
         * 只有在没有 savedInstanceState 时处理——转屏重建会带着同一个 intent 回来，
         * 再处理一次等于每转一次屏弹一个导入框。
         */
        /*
         * 熄屏 / 亮屏 / 解锁：锁屏播放页的三个时机。页面是本窗口的一层 View，
         * 所以判断必须跟着窗口走（窗口标志也只有 Activity 有）。
         */
        try {
            registerReceiver(
                screenRx,
                IntentFilter().apply {
                    addAction(Intent.ACTION_SCREEN_OFF)
                    addAction(Intent.ACTION_SCREEN_ON)
                    addAction(Intent.ACTION_USER_PRESENT)
                },
            )
        } catch (_: Exception) { /* 个别 ROM 限制动态注册：只是没有锁屏页，不影响播放 */ }

        if (savedInstanceState == null) handleIncoming(intent)

        /*
         * 熄屏时被服务从后台拉起来的（用户在别的应用里按了电源键）：窗口刚创建，
         * 锁屏标志必须**赶在第一次绘制之前**挂上，否则亮屏那一瞬先看到的是主界面。
         */
        if (intent?.getBooleanExtra(EXTRA_LOCK_NOW, false) == true) {
            intent.removeExtra(EXTRA_LOCK_NOW)
            LockScreen.markAck()
            /*
             * 只有「现在真的该铺」才挂标志 + 挂起待办。
             * 迟到的 extra（锁屏期间被压后的闹钟）进到这里就是用户点了图标，
             * 再挂 `showWhenLocked` 会在**第一次绘制之前**就把窗口置成锁屏形态。
             */
            if (lockNowWanted(intent)) {
                pendingLockNow = true
                applyLockWindow(true)
            }
        }
    }

    /**
     * 把「WebView 距屏幕上下边缘各多少」写成 CSS 变量。
     *
     * 为什么不用 env(safe-area-inset-*)：那套要 viewport-fit=cover 且 WebView 支持，
     * 实测这里恒为 0。为什么不在 Kotlin 里给 WebView 加 padding：那样连背景图都会被挤下去。
     * 量屏幕坐标最直接——不管系统栏是浮在上面还是把窗口挤小了，算出来的就是真实差值。
     *
     * ⚠️ 两种形态都要能应付：
     *   · 主题让窗口铺到屏幕边（边缘贴边）→ WebView 压在状态栏下面，要留出 barsTop；
     *   · 主题让窗口被系统栏挤小（当前这台就是这样）→ WebView 已经从状态栏下面开始，
     *     再按 barsTop 留白就重复了。
     * 所以取的是「系统栏高度 − WebView 已经让开的那段」= 真正被盖住的量，
     * 下面 `top` / `bottom` 里就是这两行。
     */
    private fun pushInsets() {
        val loc = IntArray(2)
        web.getLocationOnScreen(loc)
        val density = resources.displayMetrics.density.coerceAtLeast(1f)
        val screenH = if (Build.VERSION.SDK_INT >= 30) {
            window.windowManager.currentWindowMetrics.bounds.height()
        } else {
            @Suppress("DEPRECATION") resources.displayMetrics.heightPixels
        }

        // 系统栏 + 刘海的真实高度（dp 像素）。透明状态栏下这就是被盖住的那一截
        var barsTop = 0
        var barsBottom = 0
        if (Build.VERSION.SDK_INT >= 30) {
            val insets = window.windowManager.currentWindowMetrics.windowInsets
                .getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
            barsTop = insets.top
            barsBottom = insets.bottom
        } else {
            barsTop = dimenPx("status_bar_height")
            barsBottom = dimenPx("navigation_bar_height")
        }

        /*
         * 关键：要算的是「系统栏**压在 WebView 上**的那一截」，不是系统栏本身有多高。
         *
         * 以前是 `maxOf(loc[1], barsTop)`：WebView 铺到屏幕 y=0 时 loc[1]=0，取
         * barsTop 正好是重叠量；可 WebView 被主题挤到状态栏下面时 loc[1]=barsTop=40dp，
         * 取 40 就等于**把状态栏的高度又让了一遍**——内容顶部凭空多出 40dp 空白
         * （用户：「顶部又空出来一截，手机屏幕本来就小」）。
         *
         * 现在按「重叠量」算：WebView 已经让开的那部分减掉，让开多少都是 0。
         *   · 边缘贴着屏幕：loc[1]=0 → 重叠 = barsTop（照旧留白）
         *   · 已有内缩：loc[1]=barsTop → 重叠 = 0（不再重复留白）
         * 底部同理：WebView 底边离屏幕底还有 gap，只有 barsBottom 比 gap 大时才真被盖住。
         */
        val top = ((barsTop - loc[1]).coerceAtLeast(0) / density).toInt()
        val bottom = ((barsBottom - (screenH - loc[1] - web.height)).coerceAtLeast(0) / density).toInt()
        /*
         * 播放页全屏态（barsHidden）：系统栏已经收掉，此时再量的 top 是**挖孔**
         * 的 inset（短边缘模式下 cutout 恒报）——照它留白的话页头上方还是空一截
         * （用户：「顶部完全去掉」）。挖孔在屏幕正中，页头左右两颗按钮本来就在
         * 孔的两侧，直接顶到 y=0 没有遮挡，所以隐藏态一律推 0。
         */
        val topOut = if (barsHidden) 0 else top
        val bottomOut = if (barsHidden) 0 else bottom
        Log.i("Shuyin", "insets: top=${topOut}dp bottom=${bottomOut}dp webH=${web.height} bars=${barsTop}x${barsBottom}")
        /*
         * 值没变就**别写**。
         *
         * `documentElement.style` 上写自定义属性会让整棵文档的样式失效——真机实测一次
         * recalc 要扫 1217 个元素、34ms。这块以前是「谁触发谁写」：splash 退场、
         * sysbars、布局变化各来一遍，打开播放页那一下集中写 6 次，光样式重算就 88ms，
         * 表现就是「第一次点进播放页动画一顿一顿」。
         * 实际上这台机器上 top/bottom 一直是 40/0，后面那几次全是同一个值。
         */
        if (topOut == lastInsetTop && bottomOut == lastInsetBottom) return
        lastInsetTop = topOut
        lastInsetBottom = bottomOut
        web.evaluateJavascript(
            "(()=>{const s=document.documentElement.style;" +
                "s.setProperty('--sy-safe-top','${topOut}px');" +
                "s.setProperty('--sy-safe-bottom','${bottomOut}px');})()",
            null,
        )
    }

    /** 老系统的系统栏高度只能查 dimens */
    private fun dimenPx(name: String): Int {
        val id = resources.getIdentifier(name, "dimen", "android")
        return if (id > 0) resources.getDimensionPixelSize(id) else 0
    }

    /* ---------------- 播放页全屏化 ---------------- */

    /**
     * 前端进沉浸播放页时把系统栏（状态栏 + 导航栏）收起来，退出时恢复。
     *
     * 用户反馈「播放页顶部还是空着一截」——那截就是状态栏和给它让位的 safe-top。
     * 播放页是沉浸场景，收掉系统栏后安全区重算为 0，页头自然顶到屏幕最上沿；
     * BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE 保证边缘一划系统栏以临时形态出现，
     * 不挡操作，几秒后自动再藏回去。
     */
    private var barsHidden = false

    /** 上一次推给 WebView 的安全区（dp）。同一个值重复写会让整棵文档重算样式 */
    private var lastInsetTop = Int.MIN_VALUE
    private var lastInsetBottom = Int.MIN_VALUE

    /** Bridge 线程池里调进来，必须 post 回主线程再动窗口 */
    fun setSystemBarsHidden(hidden: Boolean) {
        barsHidden = hidden
        web.post { applySystemBars() }
    }

    @SuppressLint("NewApi")
    private fun applySystemBars() {
        /*
         * MIUI 实测（M2011K2C / Android 13）两条教训：
         * 1. InsetsController.hide(statusBars) 只收导航栏，状态栏纹丝不动；
         * 2. hide() 之后再加 FLAG_FULLSCREEN 也没用——InsetsController 一动手
         *    就会把 legacy 旗标迁移/清掉（dumpsys 里 mAttrs 见不到 FULLSCREEN）。
         * 所以隐藏走**纯 legacy 路线**（IMMERSIVE_STICKY + FLAG_FULLSCREEN，
         * 这是老播放器一直管用的那条路），恢复时才用新 API show()。
         */
        if (barsHidden) {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility =
                View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            window.addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN)
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility =
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            if (Build.VERSION.SDK_INT >= 30) {
                window.insetsController?.show(WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars())
            }
        }
        // 系统栏显隐改变安全区：立即推一次，350ms 后再推一次（收起动画有滞后）
        web.post { pushInsets() }
        web.postDelayed({ pushInsets() }, 350)
    }

    override fun onResume() {
        super.onResume()
        resumed = true
        LockScreen.trace("lifecycle onResume kg=${keyguardShowing()} pulled=$pulledForLock shown=${lockPanel?.shown == true}")
        /*
         * 上一次「解锁退任务」为了不闪主界面把整棵树藏住了（见 `dropTaskNow`），
         * 正常情况下由 onStop 亮回来。用户在这几百毫秒内点通知回来时窗口直接
         * 回到前台、可能走不到 onStop，这里也兜一手。
         */
        /*
         * 上一次「解锁退任务」为了不闪主界面把整棵树藏住了（见 `dropTaskNow`），
         * 正常情况下由 onStop 亮回来。用户在这几百毫秒内点通知回来时窗口直接
         * 回到前台、可能走不到 onStop，这里也兜一手。
         *
         * **但「熄屏拉起的这一趟」还没退完时不能亮**：那说明窗口又被系统带到前台
         * 了（解锁转场、锁屏重排），这时候亮出主界面就是用户看到的那一下闪。
         */
        if (!pulledForLock) {
            restoreOnStop = false
            if (lockPanel?.shown != true && web.visibility != View.VISIBLE) web.visibility = View.VISIBLE
            if (rootView.visibility != View.VISIBLE) rootView.visibility = View.VISIBLE
        }
        /*
         * 熄屏时被拉起来的：这时播放状态、曲目信息都已经就绪，铺面板正合适。
         * 已经不放了（或用户把开关关了）就把刚挂上的锁屏标志摘掉。
         */
        if (pendingLockNow) {
            pendingLockNow = false
            /*
             * 只有「还锁着」或者「屏幕黑着」才铺。
             *
             * 屏幕亮着、锁也解了，说明这一趟是用户自己点图标回来的（或者是那次
             * 熄屏拉起留下的一颗迟到 extra）——这时候再铺上去，就是他说的
             * 「点桌面图标，打开的是我们应用的锁屏页」。
             */
            val wanted = LockScreen.enabled(this) && NowPlaying.playing &&
                (!isInteractive() || keyguardShowing())
            if (wanted) {
                showLockPanel(preview = false)
                if (lockPanel?.shown != true) applyLockWindow(false) else pulledForLock = true
            } else {
                applyLockWindow(false)
            }
        }
        /*
         * 个别 ROM 在息屏/亮屏之间会把 FLAG_SHOW_WHEN_LOCKED 清掉，清了就会露出系统锁屏。
         *
         * 但**锁已经解开就一定要收**：不管面板是被哪条路径留下的（上滑收起被顶掉、
         * USER_PRESENT 广播没来、任务被重排），只要此刻能到 onResume 且系统已经解锁，
         * 再把 WebView 藏起来就是「应用打不开，只有一屏锁屏页」。
         * 用户自己点开的预览（`isPreview`）不算——那是屏幕亮着时他主动看的。
         */
        lockPanel?.takeIf { it.shown }?.let { panel ->
            /*
             * 只在**屏幕亮着**时才敢做这个判断：熄屏期间个别 ROM 的
             * `isKeyguardLocked` 会返回 false，那时候误收就等于「熄屏拉起白做一遍」。
             */
            if (!panel.isPreview() && isInteractive() && !keyguardShowing()) {
                hideLockPanel(fromUser = false, revealWeb = false)
                dropTaskAfterUnlock()
                return@let
            }
            applyLockWindow(true)
            web.visibility = View.INVISIBLE
            lockBars = true
            web.post { applySystemBars() }
        }
        if (barsHidden || lockBars) web.post { applySystemBars() }
        /*
         * 解锁那一趟：面板可能已经被别的路径收掉了（USER_PRESENT 没来、系统直接把
         * 窗口压下去），所以这一句**不能挂在「面板还开着」里**，否则最该退任务的
         * 时候恰好什么都不做。
         */
        if (isInteractive() && !keyguardShowing()) dropTaskAfterUnlock()
        /*
         * 回到前台了。**必须告诉前端一声**：在后台这段时间里，原生侧能单方面
         * 改掉一些只有它知道的状态——最典型的就是悬浮歌词（通知栏那颗「词」、
         * 浮窗自己的 ×、锁屏页让位时先 hide 后 show）。这些 `float://state`
         * 推送在前端处于后台时是收不到的，等用户切回来，面板里那颗开关还停在
         * 离开前的样子（用户说的「桌面歌词的开关显示不准确」）。
         */
        bridge?.emit("app://resume", "{}")
    }

    override fun onPause() {
        super.onPause()
        LockScreen.trace("lifecycle onPause kg=${keyguardShowing()} pulled=$pulledForLock shown=${lockPanel?.shown == true}")
        pausedAt = SystemClock.uptimeMillis()
        /*
         * 兜底：屏幕已经灭了但 SCREEN_OFF 广播还没到（或压根没收到）。
         * 屏幕还亮着时说明只是切到别的应用，不是熄屏——那种情况绝不弹。
         */
        if (!isInteractive()) {
            onScreenOff()
        } else if (lockPanel?.shown == true && !keyguardShowing()) {
            /*
             * 屏幕亮着、锁也解开了，却在离开前台：说明用户已经离开锁屏
             * （按了 HOME / 从通知栏跳走）。这一层没有理由再挂着。
             */
            hideLockPanel(fromUser = false)
        }
        /*
         * 屏幕亮着却离开了这个应用：说明「借任务栈显示锁屏页」那一趟已经结束，
         * 不管是解锁退回去的，还是用户自己按 HOME 走的 —— 别再记着要退任务了。
         *
         * **锁还在的时候不能清。** 解锁的第一拍是「锁屏页这一层被系统挡住 → 本
         * Activity onPause」，此刻屏幕已经亮了、锁还没解开，按这条清掉标记的话，
         * 紧接着那次 onResume 就什么都不做——用户解锁后照样落在疏音的界面上
         * （2026-11-17 真机复现）。
         */
        if (isInteractive() && !keyguardShowing()) pulledForLock = false
        resumed = false
    }

    override fun onStop() {
        super.onStop()
        LockScreen.trace("lifecycle onStop kg=${keyguardShowing()} hidden=$restoreOnStop")
        /*
         * 窗口真的不可见了：`dropTaskNow` 藏的那一树可以放心亮回来。
         * 用户下次从最近任务 / 图标回来，onResume 看到的就是正常界面。
         */
        restoreViewsIfHidden()
        if (!isInteractive()) stopUnlockProbe()
    }

    /* ---------------- 锁屏播放页 ---------------- */

    /**
     * 熄屏 / 亮屏 / 解锁三个时机。
     *
     * 页面是**本窗口的一层 View**，能不能盖住系统锁屏取决于窗口标志，而窗口只有
     * Activity 有。所以这三个时机必须跟窗口走，不能挂在服务上。
     */
    private val screenRx = object : BroadcastReceiver() {
        override fun onReceive(c: Context?, intent: Intent?) {
            when (intent?.action) {
                Intent.ACTION_SCREEN_OFF -> onScreenOff()
                Intent.ACTION_SCREEN_ON -> {
                    /* 新的一轮：上一次熄屏「窗口已处理」的账必须清掉（见 clearScreenOffHandled） */
                    clearScreenOffHandled()
                    /* 熄屏时 tick 降到 800ms，亮屏第一眼可能差半拍：先补一帧 */
                    PlaybackService.instance?.pushNow()
                    lockPanel?.takeIf { it.shown }?.let {
                        applyLockWindow(true)
                        it.setAwake(true)
                    }
                    /* 抢在 USER_PRESENT 之前发现解锁（见 `unlockProbe`） */
                    startUnlockProbe()
                }
                Intent.ACTION_USER_PRESENT -> onUserPresent()
            }
        }
    }

    /**
     * 熄屏那一刻：要不要把锁屏播放页顶上来。
     *
     * 这里只挂标志 + 显示这一层，**一行点屏的代码都没有**：
     *   · 不调 `setTurnScreenOn` / 不加 `FLAG_TURN_SCREEN_ON`；
     *   · 不发全屏意图（鸿蒙上 IMPORTANCE_HIGH 必点亮屏幕）。
     * 屏幕由用户按电源键点亮，那一刻这一层已经在窗口里了。
     */
    private fun onScreenOff() {
        stopUnlockProbe()
        lockPanel?.setAwake(false)
        LockScreen.trace(
            "SCREEN_OFF in activity fg=${foregroundNow()} playing=${NowPlaying.playing} " +
                "shown=${lockPanel?.shown == true}",
        )
        if (!LockScreen.enabled(this)) return
        if (!NowPlaying.playing) return
        if (lockPanel?.shown == true) {
            /*
             * 面板已经在（熄屏来了两趟的第二趟，或者上个熄屏周期还没收）。
             * 记一笔告诉服务端「窗口这边处理过了」，别再去拉任务——那条路径
             * 会 `moveTaskToFront` 并挂一个 700ms 的闹钟 PendingIntent，
             * 解锁之后任务栈就被它搅乱了。
             */
            markScreenOffHandled()
            return
        }
        /*
         * **只认「此刻窗口真的在前台」。**
         *
         * 这里以前用 `foregroundNow()`（带 1.2 秒 onPause 宽限）：用户刚切到微信
         * 就按电源键时，窗口明明已经不可见却被判成可见 → 这里铺了面板（在后台，
         * 看不见）并 markScreenOffHandled → 服务端以为「窗口处理过了」直接 skip。
         * 结果就是「在疏音里熄屏有、在别的应用里熄屏没有」。
         * 窗口不在前台就一个像素都不铺，把这一趟完整让给服务（LockActivity）。
         */
        if (!visibleNow()) return
        showLockPanel(preview = false)
        if (lockPanel?.shown == true) markScreenOffHandled()
    }

    /** 用户真的解开了锁：自动弹的那一次收掉（预览态是用户自己点开的，留着） */
    private fun onUserPresent() {
        /*
         * 熄屏期间也会收到一次 USER_PRESENT（真机实测：熄屏拉起 3 秒后就来了一条，
         * 而那时候屏幕还黑着）——多半是我们这层 showWhenLocked 窗口让系统认成
         * 「锁已经没了」。
         *
         * 这条假信号代价很大：它会把「熄屏拉起的这一趟」记的账抹掉、把面板收掉、
         * 再把任务退回后台 —— 用户按电源键亮屏时，看到的是光秃秃的系统锁屏；
         * 而真正的解锁反倒是「没账可退」，任务又被留在前台。
         * 真解锁时屏幕一定是亮的，拿它当判据。
         */
        if (!isInteractive()) {
            LockScreen.trace("USER_PRESENT 但屏幕没亮（熄屏期间），忽略")
            return
        }
        onUnlockDetected("USER_PRESENT")
    }

    /**
     * 解锁早鸟：亮屏之后每 110ms 问一次 keyguard，抢在解锁动画放完之前收摊。
     *
     * 只在「这一屏是熄屏拉起的」或者「锁屏页还开着」时才值这个开销 ——
     * 用户正常解锁自己的手机，跟疏音没有关系。
     */
    private fun startUnlockProbe() {
        stopUnlockProbe()
        if (!isInteractive()) return
        if (!pulledForLock && lockPanel?.shown != true) return
        probeFrom = SystemClock.elapsedRealtime()
        probeTries = 0
        probeHits = 0
        LockScreen.trace("unlockProbe 启动 pulled=$pulledForLock")
        web.postDelayed(unlockProbe, 110)
    }

    private fun stopUnlockProbe() {
        web.removeCallbacks(unlockProbe)
        probeTries = 0
        probeHits = 0
    }

    private fun probeUnlock() {
        if (!isInteractive()) { stopUnlockProbe(); return }
        if (!pulledForLock && lockPanel?.shown != true) { stopUnlockProbe(); return }
        val age = SystemClock.elapsedRealtime() - probeFrom
        /*
         * 亮屏后 350ms 内的「没锁」不当真：华为从 AOD / 熄屏过渡时会短暂报
         * `isKeyguardLocked=false`，那时候动手等于把刚铺好的锁屏页收掉。
         */
        if (!keyguardShowing() && age >= 350) {
            probeHits++
            if (probeHits >= 2) {
                stopUnlockProbe()
                LockScreen.trace("解锁(probe)：keyguard 已消失 ${age}ms，先收摊再退任务")
                onUnlockDetected("probe")
                return
            }
        } else {
            probeHits = 0
        }
        probeTries++
        /*
         * 前 15 秒盯得紧（110ms，覆盖「按电源键顺手就解锁」的绝大多数）；
         * 之后松到 1 秒一直盯到熄屏 —— 用户也可能亮屏看半天时间才解锁。
         *
         * 注意华为实测（2026-11-17）：`isKeyguardLocked` 跟 `ACTION_USER_PRESENT`
         * 只差 12ms，这条探针在这个 ROM 上抢不到提前量。留着是给别的 ROM 用，
         * 真正兜住闪屏的是 `hideLockPanel` 的 `!pulledForLock` 与 `onStop` 恢复。
         */
        if (probeTries > 140) web.postDelayed(unlockProbe, 1000) else web.postDelayed(unlockProbe, 110)
    }

    /**
     * 解锁那一下该做的事（probe 与 USER_PRESENT 共用，先到先做、后来的幂等）。
     *
     * 顺序是**先撤面板再退任务**：面板占满整屏，先 moveTaskToBack 的话，
     * 退场动画那几帧里画的还是它。
     */
    private fun onUnlockDetected(why: String) {
        val p = lockPanel
        if (p != null && p.shown && !p.isPreview()) hideLockPanel(fromUser = false, revealWeb = false)
        /*
         * 面板收没收都要问一句「这一屏是不是被拉起来的」：
         * 换歌把面板收掉、或者当次没铺成功，用户在别的应用里解锁之后
         * 露出来的仍然是我们的主界面，一样该退回后台。
         */
        if (pulledForLock) LockScreen.trace("解锁($why)：这一屏是熄屏拉起的 → 任务退回后台")
        dropTaskAfterUnlock()
    }

    /**
     * 解锁之后把任务退回后台（只对「熄屏时被服务拉起来」的那一趟生效）。
     *
     * 为什么用 `moveTaskToBack` 而不是 `finish()`：这一趟只是「借你的任务栈
     * 把锁屏页显示出来」，任务本身、WebView、播放队列都得留着。退到后面去，
     * 原来的应用就露出来了，用户点通知 / 图标还能立刻回来。
     *
     * 注意这和「用户上滑收起面板」不是一回事：那种情况**绝不能**退任务
     * （见 `hideLockPanel` 的注释），因为在锁屏上把任务挪走会落到系统锁屏后面。
     */
    private fun dropTaskAfterUnlock() {
        if (!pulledForLock) {
            /*
             * 已经在退场藏相（`dropTaskNow` 把整棵树藏了，等 onStop 才亮回来）：
             * **绝不能在这里亮回来**。
             *
             * `onResume` 会连着调两次这里（面板那一支退完，末尾那一句又退一次），
             * 第二次走到这个分支时账已经清了，于是视图被立刻恢复 —— 退场动画还在
             * 走，用户看到的就是「解锁后应用闪一下」。2026-11-17 录屏那 0.9 秒
             * 的闪，一半来自 USER_PRESENT 太晚，另一半就是这一下抢跑。
             */
            if (restoreOnStop) return
            /*
             * 没有要退的任务。但调用方可能已经把 WebView 藏住了（解锁时先藏再退，
             * 见 `dropTaskNow`）—— 这里必须恢复，否则用户看到是一片空白。
             */
            if (lockPanel?.shown != true && web.visibility != View.VISIBLE) web.visibility = View.VISIBLE
            if (rootView.visibility != View.VISIBLE) rootView.visibility = View.VISIBLE
            return
        }
        pulledForLock = false
        LockScreen.trace("解锁：这一屏是熄屏拉起的 → 任务退回后台")
        /*
         * **无条件藏 WebView**，不看它此刻是什么可见性。
         *
         * 这一趟的用户预期是「回到我原来的应用」，不该看见疏音的主界面。之前按
         * 「web 已经藏着才藏」来判断，漏掉了最常见的一种：面板先被别的路径收掉
         * （换歌清空、SCREEN_ON、上滑），`hideLockPanel` 已经把 WebView 亮回来了，
         * 解锁退任务那几十毫秒里主界面就露了一下 —— 用户的原话「解锁还是会出现
         * 一下，然后退出」。
         */
        dropTaskNow(hideWeb = true)
    }

    /**
     * 把任务退回后台（`dropTaskAfterUnlock` / 迟到 extra 两条路共用）。
     *
     * @param hideWeb 退场前要不要把 WebView 一起藏住。
     *   `moveTaskToBack` 不是瞬间生效的，它有一段几十~几百毫秒的退场动画；
     *   这段时间主界面已经露出来了，用户看到的就是「解锁后应用闪一下打开了」。
     *   藏住 WebView，这一下看到的是「锁屏页淡出、回到原来的应用」，没有闪。
     *   退完 600ms 再恢复（那时窗口已经在后台，恢复无感）。
     */
    private fun dropTaskNow(hideWeb: Boolean) {
        if (hideWeb) {
            /*
             * 光藏 WebView 还不够：窗口本身的底色（主题背景）还会被画出来，
             * 退场那一两百毫秒里用户看到的是一块纯色 —— 仍然是「出现一下」。
             * 把整棵视图树藏掉，这一趟就不留任何一个属于疏音的像素。
             */
            if (lockPanel?.shown != true) web.visibility = View.INVISIBLE
            rootView.visibility = View.INVISIBLE
            restoreOnStop = true
        }
        /*
         * 退到后台。**不要指望「回到上一个应用」**：`moveTaskToBack` 的语义就是按 Home
         * （2026-11-18 实测：退完后桌面 `visible=true`，微信 task 还活着却在下面）。
         * 曾经用「使用情况访问」记下熄屏前的前台再拉回来，真机上判不准
         * （华为浏览器被判成不可返回），还得额外要一个权限，已撤。
         *
         * 现在这条路只会出现在「疏音自己在前台时熄屏、用户又上滑收起」——
         * 用户本来就在我们这里，退后台落桌面是对的。
         */
        moveTaskToBack(true)
        if (hideWeb) {
            /*
             * **恢复的时机必须等窗口真的不可见，不能看钟**。
             *
             * 以前写死 600ms：`moveTaskToBack` 撞上解锁动画时，华为要 1 秒出头
             * 才把这一层挪下去，600ms 一到视图先亮了，用户看到的就是那一下
             * 「应用闪一下」。window 不可见时会走 onStop（见下面的恢复），
             * 这里只留一颗 2.5 秒的兜底，防某些 ROM 不 stop。
             */
            web.postDelayed({ restoreViewsIfHidden() }, 2500)
        }
    }

    /** 把 `dropTaskNow` 藏起来的视图还回来（onStop / 兜底 / onResume 三处共用，幂等） */
    private fun restoreViewsIfHidden() {
        if (!restoreOnStop) return
        restoreOnStop = false
        rootView.visibility = View.VISIBLE
        if (lockPanel?.shown != true) web.visibility = View.VISIBLE
    }

    private fun isInteractive(): Boolean = try {
        (getSystemService(Context.POWER_SERVICE) as PowerManager).isInteractive
    } catch (_: Exception) {
        true
    }

    private fun keyguardShowing(): Boolean = try {
        (getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager).isKeyguardLocked
    } catch (_: Exception) {
        false
    }

    /**
     * 这一趟 `EXTRA_LOCK_NOW` 还该不该真的铺一屏锁屏页（调用方已确认 extra 在）。
     *
     * 两条都会让它失效：
     *   · **过期**。熄屏拉起有一手是 700ms 后的闹钟 PendingIntent，锁屏期间系统
     *     可能把它压到用户解锁之后才送进来——窗口已经在前台，extra 却还是真的。
     *   · **屏幕亮着且已解锁**。这就是「用户自己点图标进来」：他要看主界面。
     *
     * 两个条件缺一个都会变成用户报的那条「点图标打开应用，结果给我看锁屏页」。
     */
    private fun lockNowWanted(intent: android.content.Intent?): Boolean {
        val at = intent?.getLongExtra(EXTRA_LOCK_AT, 0L) ?: 0L
        if (at > 0) {
            val age = android.os.SystemClock.elapsedRealtime() - at
            if (age > LOCK_NOW_TTL_MS) {
                LockScreen.trace("lock_now 迟到 ${age}ms，忽略")
                return false
            }
        }
        if (isInteractive() && !keyguardShowing()) {
            LockScreen.trace("lock_now 但已解锁在前台，忽略")
            return false
        }
        return true
    }

    /**
     * 锁屏页浮在上面时停掉 WebView 的**合成**（不是执行）。
     *
     * `INVISIBLE` 只是不参与绘制，JS 照跑 —— 队列推进、取链、歌词推送全靠它。
     */
    fun setWebHidden(hidden: Boolean) {
        runOnUiThread { web.visibility = if (hidden) View.INVISIBLE else View.VISIBLE }
    }

    /** 设置页点「预览」：屏幕亮着、用户正看着这一次 */
    fun previewLockPanel() = showLockPanel(preview = true)

    /**
     * 把锁屏播放页拿上来。
     *
     * @param preview true = 用户主动预览（屏幕亮着），false = 熄屏时自动弹的。
     */
    fun showLockPanel(preview: Boolean) {
        if (android.os.Looper.myLooper() != android.os.Looper.getMainLooper()) {
            runOnUiThread { showLockPanel(preview) }
            return
        }
        if (!LockScreen.enabled(this)) return
        if (NowPlaying.title.isBlank()) return
        val p = lockPanel ?: LockScreenPanel(this) { byUser -> hideLockPanel(byUser) }.also {
            rootView.addView(
                it,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT,
                ),
            )
            lockPanel = it
        }
        if (p.shown) { p.show(preview); return }
        p.show(preview)
        applyLockWindow(true)
        web.visibility = View.INVISIBLE
        lockBars = true
        web.post { applySystemBars() }
        if (preview && LockScreen.guideNeeded(this)) LockScreen.postGuide(this)
    }

    /**
     * 收起锁屏播放页。
     *
     * @param fromUser 用户上滑 / 点提示条收的（区别于解锁、换歌为空、开关关掉）。
     * @param revealWeb 收起后要不要把 WebView 亮出来。解锁那一趟要传 false：
     *   任务马上要退到后台，先亮出来只会让主界面在退场动画里闪一下。
     */
    fun hideLockPanel(fromUser: Boolean, revealWeb: Boolean = true) {
        if (android.os.Looper.myLooper() != android.os.Looper.getMainLooper()) {
            runOnUiThread { hideLockPanel(fromUser, revealWeb) }
            return
        }
        val p = lockPanel ?: return
        if (!p.shown) return
        /*
         * 用户上滑收起，而这一屏本来就是「熄屏时被服务拉起来」的：
         * 他要的是离开（回系统锁屏、回他原来的应用），**绝不能把我们的主界面亮出来**。
         *
         * 2026-11-17 23:05:30 实测日志（用户录屏那一下）：
         *   hidePanel byUser=true reveal=true pulled=true kg=true
         *   → 32.017 onResume（窗口回到前台，主界面可见）
         *   → 32.363 才收到 USER_PRESENT，退任务
         * 中间这 0.35 秒屏幕上就是疏音搜索页。面板收起了、账还在，露出来的只能是
         * 主界面 —— 这是那段视频里「闪一下」的真正入口，比广播迟到更致命。
         */
        val leaveTask = fromUser && pulledForLock
        /*
         * 只要这一屏是「被拉起来的」，收起面板就**不许亮主界面**——
         * 不管是用户上滑、系统把我们 pause 掉，还是换歌把面板清空。
         * 用户要的那一屏从来不是我们的主界面。
         */
        val reveal = revealWeb && !pulledForLock
        LockScreen.trace(
            "hidePanel byUser=$fromUser reveal=$reveal leaveTask=$leaveTask pulled=$pulledForLock kg=${keyguardShowing()}",
        )
        p.hide()
        applyLockWindow(false)
        if (reveal) web.visibility = View.VISIBLE
        lockBars = false
        web.post { applySystemBars() }
        if (leaveTask) {
            /*
             * 面板都收了，这一趟也到站了。直接退任务：等系统自己解锁再退的话，
             * 从「面板收起」到「USER_PRESENT」之间那段窗口是前台可见的。
             *
             * 退场前摘掉 `showWhenLocked`，系统锁屏自然回到最前面；
             * 视图保持隐藏，等 onStop（窗口真的不可见）再亮回来 —— 用户从最近任务
             * 或图标回来时看到的是正常主界面。
             */
            pulledForLock = false
            LockScreen.trace("上滑收起：这一屏是熄屏拉起的 → 任务退回后台")
            dropTaskNow(hideWeb = true)
            return
        }
        /*
         * 用户上滑收起、而手机还锁着：他想要的是回到系统锁屏。
         *
         * **只摘掉 `showWhenLocked`，绝不 `moveTaskToBack`。**
         *
         * 以前这里退后台，本意是「让系统锁屏露出来」，实际后果是：
         * 用户解锁时那次上滑本来就会被这一层吃掉（`LockScreenPanel` 把向上的拖
         * 全接了），于是「上滑解锁」直接变成「收起锁屏页 + 任务退到后台」——
         * 解锁完成，桌面就上来了。用户的原话是「锁屏后打开，被退回了桌面」，
         * 而任务在后台还留着，点图标回来时 `NowPlaying.playing` 仍为真，
         * 又是那一层开着的样子（「点图标打开的是锁屏页」）。
         *
         * 摘掉窗口标志就够了：Activity 一旦不再盖在 keyguard 之上，系统锁屏
         * 自己会回到最前面；用户要真想离开应用，按 HOME 就行。
         */
    }

    /**
     * 窗口标志：压在系统锁屏之上。
     *
     * 这是「能不能在锁屏上看到」的唯一开关 —— Activity 窗口带 `showWhenLocked`
     * 时，系统允许它盖在 keyguard 上面（悬浮窗没有这个待遇，见 LockScreen 的注释）。
     */
    private fun applyLockWindow(on: Boolean) {
        try {
            if (Build.VERSION.SDK_INT >= 27) {
                setShowWhenLocked(on)
            } else {
                @Suppress("DEPRECATION")
                if (on) window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED)
            }
        } catch (_: Exception) { /* 标志设不上：退回系统锁屏，不影响播放 */ }
        if (!on) {
            @Suppress("DEPRECATION")
            window.clearFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED)
        }
    }

    /* ---------------- 权限 ---------------- */

    private fun askPermissions() {
        val want = mutableListOf<String>()
        if (Build.VERSION.SDK_INT >= 33) {
            if (checkSelfPermission(Manifest.permission.READ_MEDIA_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                want.add(Manifest.permission.READ_MEDIA_AUDIO)
            }
            if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                want.add(Manifest.permission.POST_NOTIFICATIONS)
            }
        } else {
            if (checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                want.add(Manifest.permission.READ_EXTERNAL_STORAGE)
            }
            /*
             * Android 9 及以下没有分区存储：往公共「音乐」里写下载要这个权限。
             * 10 起由 MediaStore 接管，manifest 里已经用 maxSdkVersion=28 限住，
             * 这里就不该再要（否则成了「播放器要存储权限」）。
             */
            if (Build.VERSION.SDK_INT <= 28 &&
                checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED
            ) {
                want.add(Manifest.permission.WRITE_EXTERNAL_STORAGE)
            }
        }
        if (want.isNotEmpty()) {
            try { requestPermissions(want.toTypedArray(), 1001) } catch (_: Exception) {}
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        // 授权变化后重扫一次：曲库页此刻可能正停在「还没有歌曲」
        if (requestCode == 1001) {
            web.evaluateJavascript("window.__syOnPermission&&window.__syOnPermission()", null)
        }
        /*
         * 1003 那条（频谱的 RECORD_AUDIO）已经没了：频谱现在从 ExoPlayer 的
         * 音频处理链上旁路 PCM，不需要任何权限，也就没有需要回给前端的结果。
         */
    }

    /**
     * 跳本应用的系统设置页。
     *
     * 权限弹窗一旦被「不再询问」锁死，应用再 `requestPermissions` 也不会弹了，
     * 只有这一个入口能改。顺便把「权限」那一栏摆在最显眼的位置。
     */
    fun openAppPermissionSettings() {
        val intents = listOf(
            /* 直接落在「权限」列表上（EMUI / HarmonyOS 认这个） */
            android.content.Intent(
                "android.intent.action.MANAGE_APP_PERMISSIONS",
                android.net.Uri.parse("package:$packageName"),
            ),
            android.content.Intent(
                android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                android.net.Uri.parse("package:$packageName"),
            ),
        )
        for (i in intents) {
            i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
            try {
                startActivity(i)
                return
            } catch (_: Exception) {
                /* 这个 ROM 没这个 Activity，换下一个 */
            }
        }
        try {
            startActivity(
                android.content.Intent(android.provider.Settings.ACTION_SETTINGS)
                    .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        } catch (_: Exception) { /* 彻底打不开就算了，别崩 */ }
    }

    /* ---------------- 资源 ---------------- */

    private fun assetResponse(path: String): WebResourceResponse? {
        return try {
            val input = assets.open(path)
            WebResourceResponse(mimeOf(path), "utf-8", 200, "OK", noCacheHeaders(), input)
        } catch (_: Exception) {
            // SPA 兜底：任何找不到的路径都回 index.html，避免刷新后 404 白屏
            try {
                WebResourceResponse("text/html", "utf-8", 200, "OK", noCacheHeaders(), assets.open("www/index.html"))
            } catch (_: Exception) {
                WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
            }
        }
    }

    /**
     * 本地歌曲封面：按**媒体 id** 现取，落盘缓存后直接回图。
     *
     * 为什么不是按专辑 id（最初是那么写的）：Android 10+ 对「专辑信息缺失」的文件
     * 会塞一个哈希出来的 album_id（实测 6539316500227728566 这种天文数字），
     * 拿它去 loadThumbnail 必然失败 —— 页面上就是一片破图标。
     * 媒体 id 一定解析得回来，而且能直接从文件里抽内嵌封面（绝大多数 flac/mp3 都有）。
     *
     * 抽不到也**不许回 404**：404 会让 <img> 露出系统的破图标。
     * 回一张 1×1 透明 PNG，下面的渐变兜底就能透出来。
     *
     * 抽取逻辑在 CoverArt（通知大图 / 媒体会话共用同一份实现）。
     */
    private fun coverResponse(id: String): WebResourceResponse {
        val f = File(Sy.covers, "$id.jpg")
        /* 半截文件（上次写盘时进程被杀）当成没有：否则 decodeFile 回 null，图就一直是空的 */
        if (f.exists() && f.length() <= 0) {
            try { f.delete() } catch (_: Exception) {}
        }
        if (!f.exists()) {
            val bmp = CoverArt.embeddedArt(this, id) ?: CoverArt.albumThumb(this, id)
            if (bmp != null) {
                try {
                    FileOutputStream(f).use { bmp.compress(Bitmap.CompressFormat.JPEG, 88, it) }
                } catch (_: Exception) { /* 落盘失败就当没缓存，下次再抽 */ }
            } else {
                return transparentPng()
            }
        }
        return try {
            WebResourceResponse("image/jpeg", null, f.inputStream())
        } catch (_: Exception) {
            transparentPng()
        }
    }

    private fun transparentPng(): WebResourceResponse {
        /*
         * **不要**给这张兜底图长缓存（以前是 max-age=86400）。
         *
         * 「抽不到封面」只是**这一次**的结果：换台设备拷进来的同一首歌、系统媒体库
         * 索引重建之后，都有可能再抽得出来。缓存一天等于给这个 id 判了一天死刑 ——
         * 用户看到的是「有几首歌永远没有封面，重启也不行」。
         * no-store 之后，前端那份 `<Cover>` 的重试才真的能再走一遍拦截器。
         */
        val headers = mapOf("Cache-Control" to "no-store")
        return WebResourceResponse(
            "image/png", null, 200, "OK", headers,
            ByteArrayInputStream(EMPTY_PNG),
        )
    }

    /**
     * 前端缓存目录里的文件（离线封面）。
     *
     * 为什么需要这条路由：`allowFileAccess = false`，`file://` 的图在 WebView 里
     * 一律加载不出来；而离线封面就躺在 `Sy.cacheAudio` 里。前端把绝对路径
     * 拼成 `/cachefile/?p=` 交过来，这里读出来喂回去（见 `mediaCache.localFileUrl`）。
     *
     * 只放行缓存目录下的文件：这条路由对着的是 WebView，别让它变成任意文件读取口子。
     */
    private fun cacheFileResponse(url: Uri): WebResourceResponse? {
        val p = try { url.getQueryParameter("p") } catch (_: Exception) { null } ?: return null
        val target = try { File(p).canonicalFile } catch (_: Exception) { return null }
        val root = try { Sy.cacheAudio.canonicalFile } catch (_: Exception) { return null } ?: return null
        if (!target.path.startsWith(root.path + File.separator)) return null
        if (!target.exists() || target.length() <= 0) return null
        val mime = when (target.extension.lowercase()) {
            "png" -> "image/png"
            "webp" -> "image/webp"
            else -> "image/jpeg"
        }
        return try {
            // 封面是不会变的内容，缓存一天；文件名带地址哈希，换了地址就是另一个文件
            WebResourceResponse(
                mime, null, 200, "OK",
                mapOf("Cache-Control" to "max-age=86400"),
                target.inputStream(),
            )
        } catch (_: Exception) {
            null
        }
    }

    private fun noCacheHeaders(): Map<String, String> = mapOf(
        // index.html 必须每次都要新的，否则换版后用户装着旧界面还以为是 bug
        "Cache-Control" to "no-cache",
    )

    private fun mimeOf(path: String): String = when (path.substringAfterLast('.', "").lowercase()) {
        "html" -> "text/html"
        "js", "mjs" -> "application/javascript"
        "css" -> "text/css"
        "json" -> "application/json"
        "svg" -> "image/svg+xml"
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "webp" -> "image/webp"
        "woff2" -> "font/woff2"
        "woff" -> "font/woff"
        "ttf" -> "font/ttf"
        "mp3" -> "audio/mpeg"
        else -> "application/octet-stream"
    }

    /* ---------------- 返回键 ---------------- */

    override fun onBackPressed() {
        /* 锁屏页在最上面时，返回键收的是它（用户不该透过它去操作底下的应用） */
        if (lockPanel?.shown == true) { hideLockPanel(fromUser = true); return }
        // 先问前端「这一下该关的是哪一层」：沉浸式播放页 / 队列抽屉 / 子页都比退出优先
        web.evaluateJavascript("(function(){try{return !!(window.__syBack&&window.__syBack())}catch(e){return false}})()") { r ->
            if (r == "true") return@evaluateJavascript
            if (web.canGoBack()) web.goBack() else moveTaskToBack(true)
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        /* 窗口什么时候真正拿到焦点 = 系统把锁屏让开的那一刻，排查闪屏全靠它对齐 */
        if (hasFocus) LockScreen.trace("window focus on kg=${keyguardShowing()}")
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        // 转屏后让前端重算布局（CSS 断点靠 innerWidth，不重算会停在旧模式）
        web.post { pushInsets() }
        web.evaluateJavascript("window.__syOnResize&&window.__syOnResize()", null)
    }

    override fun onDestroy() {
        if (inst === this) inst = null
        try { web.removeCallbacks(unlockProbe) } catch (_: Exception) {}
        try { unregisterReceiver(screenRx) } catch (_: Exception) { /* 没注册成功 */ }
        try { lockPanel?.dispose() } catch (_: Exception) { /* 跟着窗口一起销毁 */ }
        try { web.destroy() } catch (_: Exception) {}
        super.onDestroy()
    }
}
