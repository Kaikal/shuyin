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
    private var bridge: Bridge? = null

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
        org.json.JSONObject()
            .put("id", "${System.currentTimeMillis()}-${uri.hashCode()}")
            .put("path", f.absolutePath)
            .put("name", name)
            .put("size", f.length())
            .put("source", looks)
    } catch (e: Exception) {
        Log.w("Shuyin", "打开方式：${e.message}")
        null
    }
    }

    override fun onNewIntent(intent: android.content.Intent?) {
        super.onNewIntent(intent)
        /* singleTask：应用已经在后台时，新的「打开方式」走这里而不是 onCreate */
        setIntent(intent)
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

        web = WebView(this)
        setContentView(web)

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
                return assetResponse(if (path == "/" || path.isBlank()) "www/index.html" else "www" + path)
            }

            override fun onPageFinished(view: WebView, url: String?) {
                Log.i("Shuyin", "page finished: $url")
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
        if (savedInstanceState == null) handleIncoming(intent)
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
        // 从别的应用/登录窗回来后，系统可能把隐藏态还原了；照前端最后的意思再补一次
        if (barsHidden) web.post { applySystemBars() }
        /*
         * 回到前台了。**必须告诉前端一声**：在后台这段时间里，原生侧能单方面
         * 改掉一些只有它知道的状态——最典型的就是悬浮歌词（通知栏那颗「词」、
         * 浮窗自己的 ×、锁屏页让位时先 hide 后 show）。这些 `float://state`
         * 推送在前端处于后台时是收不到的，等用户切回来，面板里那颗开关还停在
         * 离开前的样子（用户说的「桌面歌词的开关显示不准确」）。
         */
        bridge?.emit("app://resume", "{}")
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
        // 先问前端「这一下该关的是哪一层」：沉浸式播放页 / 队列抽屉 / 子页都比退出优先
        web.evaluateJavascript("(function(){try{return !!(window.__syBack&&window.__syBack())}catch(e){return false}})()") { r ->
            if (r == "true") return@evaluateJavascript
            if (web.canGoBack()) web.goBack() else moveTaskToBack(true)
        }
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        // 转屏后让前端重算布局（CSS 断点靠 innerWidth，不重算会停在旧模式）
        web.post { pushInsets() }
        web.evaluateJavascript("window.__syOnResize&&window.__syOnResize()", null)
    }

    override fun onDestroy() {
        if (inst === this) inst = null
        try { web.destroy() } catch (_: Exception) {}
        super.onDestroy()
    }
}
