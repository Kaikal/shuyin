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

    /** 平台登录的等待者：同上，登录窗是异步 Activity，命令是同步的 */
    private var loginResolve: ((org.json.JSONObject) -> Unit)? = null

    /**
     * 打开平台官方登录页（内嵌 WebView），凭证在 [PlatformLoginActivity] 里从
     * CookieManager 抓。回调结果统一在 onActivityResult 交给 loginResolve。
     */
    fun platformLogin(source: String, cb: (org.json.JSONObject) -> Unit) {
        loginResolve = cb
        val intent = android.content.Intent(this, PlatformLoginActivity::class.java)
            .putExtra(PlatformLoginActivity.EXTRA_SOURCE, source)
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

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: android.content.Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == 4102) {
            val cb = loginResolve ?: return
            loginResolve = null
            val cookie = data?.getStringExtra(PlatformLoginActivity.EXTRA_COOKIE)
            val error = data?.getStringExtra(PlatformLoginActivity.EXTRA_ERROR)
            val cancel = data?.getBooleanExtra(PlatformLoginActivity.EXTRA_CANCEL, false) ?: false
            cb(org.json.JSONObject().apply {
                put("ok", !cookie.isNullOrEmpty())
                if (!cookie.isNullOrEmpty()) put("cookie", cookie)
                if (!error.isNullOrEmpty()) put("error", error)
                put("cancel", cancel)
            })
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
    }

    /**
     * 把「WebView 距屏幕上下边缘各多少」写成 CSS 变量。
     *
     * 为什么不用 env(safe-area-inset-*)：那套要 viewport-fit=cover 且 WebView 支持，
     * 实测这里恒为 0。为什么不在 Kotlin 里给 WebView 加 padding：那样连背景图都会被挤下去。
     * 量屏幕坐标最直接——不管系统栏是浮在上面还是把窗口挤小了，算出来的就是真实差值。
     *
     * ⚠️ 只量坐标不够：主题里状态栏 / 导航栏都是透明的（styles.xml 的
     * statusBarColor=transparent + windowDrawsSystemBarBackgrounds），WebView 实际从
     * 屏幕 y=0 铺到底，`getLocationOnScreen` 给出 0 —— 但状态栏确实浮在内容上面。
     * 只信坐标的话 safe-top 恒为 0，手机上顶栏就被状态栏压住（「顶部按钮被挡住」）。
     * 所以再取一次系统栏 / 刘海的实际高度，两个取大的：谁大听谁的。
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

        val top = (maxOf(loc[1], barsTop) / density).toInt().coerceAtLeast(0)
        val bottom = (maxOf(screenH - loc[1] - web.height, barsBottom) / density)
            .toInt().coerceAtLeast(0)
        Log.i("Shuyin", "insets: top=${top}dp bottom=${bottom}dp webH=${web.height} bars=${barsTop}x${barsBottom}")
        web.evaluateJavascript(
            "(()=>{const s=document.documentElement.style;" +
                "s.setProperty('--sy-safe-top','${top}px');" +
                "s.setProperty('--sy-safe-bottom','${bottom}px');})()",
            null,
        )
    }

    /** 老系统的系统栏高度只能查 dimens */
    private fun dimenPx(name: String): Int {
        val id = resources.getIdentifier(name, "dimen", "android")
        return if (id > 0) resources.getDimensionPixelSize(id) else 0
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
     */
    private fun coverResponse(id: String): WebResourceResponse {
        val f = File(Sy.covers, "$id.jpg")
        if (!f.exists()) {
            var bmp = embeddedArt(id) ?: albumThumb(id)
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

    /** 文件里内嵌的封面（ID3 APIC / FLAC PICTURE / MP4 covr） */
    private fun embeddedArt(mediaId: String): Bitmap? {
        val uri = android.content.ContentUris.withAppendedId(
            android.provider.MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, mediaId.toLongOrNull() ?: return null
        )
        val mmr = MediaMetadataRetriever()
        return try {
            mmr.setDataSource(this, uri)
            mmr.embeddedPicture?.let { BitmapFactory.decodeByteArray(it, 0, it.size) }
        } catch (_: Exception) {
            null
        } finally {
            try { mmr.release() } catch (_: Exception) {}
        }
    }

    /** 退一步用媒体库的专辑缩略图（文件没内嵌封面但专辑里别处有） */
    private fun albumThumb(mediaId: String): Bitmap? {
        if (Build.VERSION.SDK_INT < 29) return null
        val mid = mediaId.toLongOrNull() ?: return null
        return try {
            val albumId = contentResolver.query(
                android.content.ContentUris.withAppendedId(
                    android.provider.MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, mid
                ),
                arrayOf(android.provider.MediaStore.Audio.Media.ALBUM_ID), null, null, null
            )?.use { c -> if (c.moveToFirst()) c.getLong(0) else 0L } ?: 0L
            if (albumId <= 0) null else {
                val albumUri = android.content.ContentUris.withAppendedId(
                    android.provider.MediaStore.Audio.Albums.EXTERNAL_CONTENT_URI, albumId
                )
                contentResolver.loadThumbnail(albumUri, android.util.Size(512, 512), null)
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun transparentPng(): WebResourceResponse {
        val headers = mapOf("Cache-Control" to "max-age=86400")
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
        try { web.destroy() } catch (_: Exception) {}
        super.onDestroy()
    }
}
