package cn.shuyin.player

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.LinearLayout
import android.widget.TextView

/**
 * 平台登录：**内嵌各家的官方登录页，从 CookieManager 里取凭证**。
 *
 * 为什么不用「自己实现扫码协议」：
 *   · QQ / 酷狗 / 酷我的扫码要处理 qrsig / ptqrtoken / 二次验证，一家一套私有接口；
 *   · 官方页面里用户自己扫码或输密码，我们只做一件事——等那个凭证 cookie 出现。
 * 这也和桌面端的 `src-tauri/src/platform_login.rs` 是同一套思路，
 * 两边的判定标准（哪个 cookie 算登录成功）用的是同一张表。
 *
 * 三个必须踩对的点：
 *   1. 用**桌面 UA**：手机 UA 打开会被引导去下载 App（`openapp` 之类），根本出不来二维码；
 *   2. 登录卡片是**点出来的**，纯 URL 打开只有首页，所以要注入一段脚本去点「登录」；
 *   3. 未登录时酷狗/酷我也会写游客 cookie（`token` / `userid`），
 *      所以判据是「值相对打开时**变了**」，不是「存在」。
 */
class PlatformLoginActivity : Activity() {

    companion object {
        const val EXTRA_SOURCE = "source"
        const val EXTRA_COOKIE = "cookie"
        const val EXTRA_ERROR = "error"
        const val EXTRA_CANCEL = "cancel"

        /** 关窗不算失败：用户自己放弃的 */
        private const val TIMEOUT_MS = 5 * 60 * 1000L
        private const val POLL_MS = 900L

        data class Spec(
            val url: String,
            val cookieUrl: String,
            val keys: List<String>,
            val title: String,
        )

        fun spec(source: String): Spec? = when (source) {
            "wy" -> Spec(
                "https://music.163.com/login?targetUrl=%2F",
                "https://music.163.com/",
                listOf("MUSIC_U"),
                "登录网易云音乐",
            )
            "tx" -> Spec(
                "https://y.qq.com/",
                "https://y.qq.com/",
                listOf("qqmusic_key", "qm_keyst"),
                "登录 QQ 音乐",
            )
            "kg" -> Spec(
                "https://www.kugou.com/",
                "https://www.kugou.com/",
                listOf("KuGoo", "kg_login", "KugouToken"),
                "登录酷狗音乐",
            )
            "kw" -> Spec(
                "https://www.kuwo.cn/",
                "https://www.kuwo.cn/",
                listOf("kw_token", "userid", "token"),
                "登录酷我音乐",
            )
            else -> null
        }

        /** 桌面 Chrome 的 UA：站点按它给 PC 版页面，登录入口就是二维码 */
        private const val DESKTOP_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }

    private lateinit var web: WebView
    private val handler = Handler(Looper.getMainLooper())
    private var spec: Spec? = null
    /** 打开时的 cookie 快照：判「变了」的基线 */
    private var baseline: Map<String, String> = emptyMap()
    private var settled = false
    private var startedAt = 0L

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Sy.init(this)
        val source = intent.getStringExtra(EXTRA_SOURCE).orEmpty()
        val sp = spec(source)
        if (sp == null) {
            finishWith(error = "不认识的平台：$source")
            return
        }
        spec = sp
        startedAt = System.currentTimeMillis()

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#0E0F13"))
        }

        /* ---- 顶栏：标题 + 关闭 ---- */
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), dp(10) + statusBarHeight(), dp(10), dp(10))
        }
        val titleBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        titleBox.addView(TextView(this).apply {
            text = sp.title
            setTextColor(Color.parseColor("#F2F3F5"))
            textSize = 16f
            typeface = Typeface.DEFAULT_BOLD
        })
        titleBox.addView(TextView(this).apply {
            // 平台的登录框是它们自己的 JS 弹出来的，脚本点不动（isTrusted 校验），
            // 所以这里直接告诉用户点哪儿——比让他对着一个网页发呆强
            text = "在页面上点「登录」，登录成功后会自动返回"
            setTextColor(Color.parseColor("#8C93A0"))
            textSize = 11.5f
        })
        bar.addView(titleBox, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        bar.addView(TextView(this).apply {
            text = "关闭"
            setTextColor(Color.parseColor("#8C93A0"))
            textSize = 14f
            setPadding(dp(12), dp(6), dp(12), dp(6))
            setOnClickListener { finishWith(cancel = true) }
        })
        root.addView(bar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        /* ---- 网页 ---- */
        web = WebView(this).apply {
            setBackgroundColor(Color.parseColor("#0E0F13"))
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                databaseEnabled = true
                loadWithOverviewMode = true
                useWideViewPort = true
                // 桌面版页面缩到 412dp 宽只有一半大小，字很小；允许双指缩放自己放大
                setSupportZoom(true)
                builtInZoomControls = true
                displayZoomControls = false
                cacheMode = WebSettings.LOAD_DEFAULT
                userAgentString = DESKTOP_UA
                // 有些站点按 UA 里的 "Mobile" 判断，要把浏览客户端标识也改掉
                mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            }
        }
        // 注意不能写在 WebView(this).apply{} 里面：那时外层的 `web` 还没赋值
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(web, true)
        }
        web.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                // 页面每次导航都会换文档，注入的钩子跟着没了 → 每轮补一次
                hookLoginButton()
            }
        }
        web.webChromeClient = WebChromeClient()
        root.addView(web, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))

        setContentView(root)
        web.loadUrl(sp.url)

        handler.postDelayed(poll, POLL_MS)
    }

    private fun statusBarHeight(): Int {
        val id = resources.getIdentifier("status_bar_height", "dimen", "android")
        return if (id > 0) resources.getDimensionPixelSize(id) else dp(24)
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    /**
     * 把页面上的「登录」点一下。
     *
     * 遍历所有标签而不是只找 `<a>`：QQ 音乐 / 酷狗 / 酷我的入口是 div 上的 click 事件。
     * 只认**叶子节点 + 文本完全相等**，避免把「登录后可同步」那种整块容器点掉。
     */
    private fun hookLoginButton() {
        web.evaluateJavascript(HOOK_JS, null)
    }

    private val poll = object : Runnable {
        override fun run() {
            if (settled) return
            val sp = spec ?: return
            val cookie = CookieManager.getInstance().getCookie(sp.cookieUrl).orEmpty()
            val now = parseCookie(cookie)

            if (baseline.isEmpty()) {
                // 第一次读到 cookie 才算基线：onCreate 之后 CookieManager 要在页面加载中才回值
                if (cookie.isNotEmpty()) baseline = now
            } else {
                for (k in sp.keys) {
                    val before = baseline[k]
                    val after = now[k]
                    if (!after.isNullOrEmpty() && after != before) {
                        finishWith(cookie = cookie)
                        return
                    }
                }
            }

            if (System.currentTimeMillis() - startedAt > TIMEOUT_MS) {
                finishWith(error = "登录等太久了，可以重开一次")
                return
            }
            hookLoginButton()
            handler.postDelayed(this, POLL_MS)
        }
    }

    private fun parseCookie(raw: String): Map<String, String> {
        val out = HashMap<String, String>()
        for (seg in raw.split(";")) {
            val s = seg.trim()
            val i = s.indexOf('=')
            if (i <= 0) continue
            out[s.substring(0, i).trim()] = s.substring(i + 1).trim()
        }
        return out
    }

    private fun finishWith(cookie: String? = null, error: String? = null, cancel: Boolean = false) {
        if (settled) return
        settled = true
        handler.removeCallbacksAndMessages(null)
        val data = Intent().apply {
            putExtra(EXTRA_SOURCE, intent.getStringExtra(EXTRA_SOURCE))
            cookie?.let { putExtra(EXTRA_COOKIE, it) }
            error?.let { putExtra(EXTRA_ERROR, it) }
            putExtra(EXTRA_CANCEL, cancel)
        }
        setResult(if (cookie != null) RESULT_OK else RESULT_CANCELED, data)
        finish()
    }

    override fun onBackPressed() {
        finishWith(cancel = true)
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        try { web.destroy() } catch (_: Exception) { }
        super.onDestroy()
    }
}

/**
 * 点「登录」。每轮轮询都调一次，靠 `__syLoginHooked` 保证同一个文档里只点一次
 * （页面是单页应用，路由变化不会重新加载文档）。
 */
private const val HOOK_JS = """
(function () {
  /* 幂等：每轮轮询都调一次（900ms），点了的元素打标记，不重复点。 */
  function visible(el) {
    var r = el.getBoundingClientRect();
    return r.width > 4 && r.height > 4 && r.bottom > 0 && r.top < innerHeight;
  }
  function textOf(el) {
    return (el.textContent || '').replace(/\s+/g, '');
  }
  function clickOnce(el, tag) {
    if (!el || el.getAttribute('data-sy-clicked') === tag) return false;
    el.setAttribute('data-sy-clicked', tag);
    try { el.click(); } catch (e) { return false; }
    return true;
  }

  try {
    /* 1. 先关弹层：会员推广、App 引导这类浮层会盖住整个页面，不关掉点不到登录 */
    var closers = document.querySelectorAll('[class*=close],[class*=Close],[aria-label=关闭]');
    for (var i = 0; i < closers.length; i++) {
      var c = closers[i];
      if (!visible(c)) continue;
      var host = c.closest('[class*=popup],[class*=dialog],[class*=modal],[class*=layer],[class*=mask]');
      if (!host) continue;
      clickOnce(c, 'close');
    }

    /* 2. 登录入口：文字完全相等才算，避免点到「登录后可同步」那种整块容器 */
    var TEXTS = ['登录', '登陆', '立即登录', '登录/注册', '登录 / 注册', '去登录', '账号登录'];
    var nodes = document.querySelectorAll('a,button,span,div,li,p,[role=button]');
    for (var j = 0; j < nodes.length; j++) {
      var el = nodes[j];
      if (el.children.length > 0 || !visible(el)) continue;
      if (TEXTS.indexOf(textOf(el)) < 0) continue;
      if (clickOnce(el, 'login')) return;
    }

    /* 3. 手机版页面把登录藏在「我的」标签里：点一次，下一轮再找登录 */
    var MINE = ['我的', '我的音乐'];
    for (var k = 0; k < nodes.length; k++) {
      var m = nodes[k];
      if (m.children.length > 0 || !visible(m)) continue;
      if (MINE.indexOf(textOf(m)) < 0) continue;
      if (clickOnce(m, 'mine')) return;
    }
  } catch (e) {}
})();
"""
