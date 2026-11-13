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
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * 平台登录：**内嵌各家的官方登录页，从 CookieManager 里取凭证**。
 *
 * 为什么不用「自己实现扫码协议」：
 *   · QQ / 酷狗 / 酷我的扫码要处理 qrsig / ptqrtoken / 二次验证，一家一套私有接口；
 *   · 官方页面里用户自己扫码或输密码，我们只做一件事——等那个凭证 cookie 出现。
 * 这也和桌面端的 `src-tauri/src/platform_login.rs` 是同一套思路，
 * 两边的判定标准（哪个 cookie 算登录成功）用的是同一张表。
 *
 * **手机上不摆二维码**（改于 2026-10）：
 * 扫码的前提是「手边还有另一台设备」，而这台设备本身就是手机——让用户拿手机
 * 扫自己屏幕上的码，荒唐且走不通（很多人只有一台手机）。四家各有各的给法：
 *   · 网易云 → 移动版 H5（`y.music.163.com/m/login`），手机号 + 短信；
 *   · 酷狗   → 登录组件页 + 切「手机登录在这里」，手机号 + 短信；
 *   · QQ     → ptlogin 组件页 + 切「密码登录」，QQ号 / 邮箱 / 手机号 + 密码；
 *   · 酷我   → 只有 PC 站有登录（移动站全是「页面没有找到」），把 PC 登录框
 *              按设备宽度重排后翻出账号密码表单。
 * 后三家靠 `fitWidth`：改 viewport 让 PC 页面按 393 排版，1 CSS px = 1 dp。
 *
 * 三个必须踩对的点：
 *   1. 用**桌面 UA**：手机 UA 打开会被引导去下载 App（`openapp` 之类），
 *      移动站上根本没有登录入口——除了网易云，它的移动站是完整的 H5；
 *   2. 登录卡片是**点出来的**，纯 URL 打开只有首页，所以要注入一段脚本去点「登录」；
 *      但登录页/登录框里的「登录」是**提交按钮**，绝不能自动点（会反复提交空表单）；
 *   3. 未登录时酷狗/酷我也会写游客 cookie（`token` / `userid`），
 *      所以判据是「值相对打开时**变了**」，不是「存在」。
 */
class PlatformLoginActivity : Activity() {

    companion object {
        const val EXTRA_SOURCE = "source"
        const val EXTRA_COOKIE = "cookie"
        const val EXTRA_ERROR = "error"
        const val EXTRA_CANCEL = "cancel"

        /**
         * 不认「已有凭证」，强制用户真走一遍登录。
         *
         * 前端在 `existingOk` 拿到的那份 cookie **校验失败**（过期 / 被顶号）时会带这个再来一次：
         * 否则点登录 → 秒成功 → 校验失败 → 再点又秒成功，来回死循环，用户永远登不上。
         */
        const val EXTRA_FORCE = "force"

        /** 关窗不算失败：用户自己放弃的 */
        /*
         * 30 分钟。
         *
         * 之前给 10 分钟，结果真机上出现「人还在拖滑块 / 一张张点验证码，窗口自己关了」
         * ——用户看到的只是「又失败了」，实际是我这边超时收工。QQ 的选图验证一轮一轮
         * 出题，三轮下来五六分钟很正常，再叠上收短信、输密码，10 分钟就是不够。
         */
        private const val TIMEOUT_MS = 30 * 60 * 1000L
        private const val POLL_MS = 900L

        /**
         * 二维码钉住多久。
         *
         * 实测一张码在服务器上活 **123 秒**；留 20 秒余量，
         * 到点就放开让页面换新的 —— 别把已经失效的码一直挂在那儿。
         */
        private const val QR_PIN_MS = 100_000L

        /**
         * 登录窗还开着吗。
         *
         * 主界面是 `singleTask`，用 `startActivityForResult` 拉登录窗时系统可能**立刻**
         * 先回一次 `onActivityResult(RESULT_CANCELED, null)`。那一下要是被当成
         * 「用户取消了」，等待者当场被消费掉，用户真登完就没人接了。
         * 主界面靠这个标志区分「提前的假回调」和「窗真的没了」。
         */
        @Volatile
        var alive = false
            private set

        /**
         * 超过这个时间还没登完，顶栏才把「读到几项 cookie / 缺哪个 key」亮出来。
         *
         * 正常登录（几秒到几十秒）时不该给用户看 cookie 名这种技术噪音；
         * 但卡住的时候，这行字是唯一能说明「到底卡在哪」的东西——
         * 没有它，四次失败在用户眼里全是同一句「没拿到登录凭证」。
         */
        private const val DIAG_AFTER_MS = 20_000L

        data class Spec(
            val url: String,
            val cookieUrl: String,
            val keys: List<String>,
            val title: String,
            /** 顶栏那行提示。写清「怎么登」，别让用户对着网页发呆 */
            val hint: String,
            /**
             * 用**移动版**页面打开（目前只有网易云）。
             *
             * 手机上用桌面 UA 打开网易云，拿到的是 PC 站——它的登录方式只有二维码，
             * 于是「在手机上登网易云」变成了「拿另一台手机扫这台手机的屏幕」，
             * 荒唐且走不通（很多人手边就一台手机）。
             * 移动版 H5 是手机号 + 密码 / 短信验证码，和 App 里的登录是一回事。
             */
            val mobile: Boolean = false,
            /**
             * 备用的读取域：cookie 可能种在另一个域上，两个域取并集。
             *
             * 只有网易云用得到：移动站登录后 MUSIC_U 有时种在 `.music.163.com`、
             * 有时只种在 `y.music.163.com`。只读一个域的话，选错就是
             * 「用户明明登录成功了，回来还是未登录」——最难解释的那种失败。
             */
            val altCookieUrl: String? = null,
            /**
             * >0 时注入 `<meta name="viewport" content="width=N">`。
             *
             * 酷狗 / 酷我 / QQ 的登录**只有 PC 站有**（移动站只导流下载 App，
             * 翻遍了都没有登录入口）。PC 站没有 viewport，WebView 按 980/1000
             * 的宽视口渲染，再缩到 393dp 的屏幕上 = 0.4 倍，输入框只有 16dp 高，
             * 点都点不准——这才是「手机上登录难用」的真正原因，不是扫码。
             *
             * 把排版宽度改成设备宽度（393），1 CSS px = 1 dp，登录框原样铺满屏幕，
             * 输入框回到 40dp，和打开一个手机网页没有区别。
             */
            val fitWidth: Int = 0,
            /** 配合 fitWidth 的适配 CSS（每家布局不一样，各自写） */
            val fitCss: String = "",
            /** 打开后要自动点的元素（切到账号密码 tab），CSS 选择器，点过打标记不重复点 */
            val taps: List<String> = emptyList(),
            /**
             * 打开后要注入的**自定义入口脚本**（每轮轮询都跑，脚本自己保证幂等）。
             *
             * `taps` 只能"按选择器点一次"，而网易云 PC 站要把登录框点出来得走
             * 三步状态机（登录 → 选择其他登录模式 → 勾协议 + 手机号登录/注册），
             * 所以给它单独一段脚本（见 [WY_HOOK_JS]）。
             */
            val entryJs: String? = null,
            /**
             * 是否用「点页面上文字叫登录的入口」那套钩子。
             *
             * 酷我的登录框是首页里点出来的，没有独立的登录页 URL；其余三家都能
             * 直接打开登录页，页面上那颗「登录」是**提交按钮**，自动点它会反复提交空表单。
             */
            val tapLoginEntry: Boolean = false,
            /**
             * `keys` 里的项「存在即已登录」，不需要看到它从无到有。
             *
             * 只给**未登录时压根不会有那个 key** 的平台开（网易云 MUSIC_U、
             * QQ 的 qm_keyst）。酷狗/酷我不能开：它们未登录也会写 token/userid
             * 的游客值，一开就变成「一进登录页就算成功」。
             *
             * 为什么必须有这个：判定原本只认「值相对基线变了」。用户**曾经登录成功、
             * 但那次没被判出来**（Activity 被回收、轮询竞态）之后再点登录，
             * 页面一加载 MUSIC_U 就已经在了，基线直接就是它，后面永远「没变化」
             * ——于是彻底登不进去，重试多少次都一样。
             */
            val existingOk: Boolean = false,
        )

        fun spec(source: String): Spec? = when (source) {
            /*
             * 网易云：**PC 站 + 桌面 UA**（不是移动 H5）。
             *
             * 移动 H5（`y.music.163.com/m/login`）在这台机器的 WebView 里是坏的：
             * 点「手机号登录」之后，登录表单其实在 `dl.reg.163.com` 的跨域 iframe 里，
             * 而那个 iframe 在移动版里**永远渲染不出来**（页面停在它自己的 spinner 上，
             * `#j-app` 里只剩一个空 div）。用户看到的就是「点了没反应」，
             * 等 5 分钟超时 → 前端只能说「没拿到登录凭证」。
             *
             * PC 站（`music.163.com`）的登录弹层用的是同一个 iframe，但能正常出表单：
             * 手机号 + 短信验证码 + 图形风控。差别在渲染视口——PC 站走的是
             * 「桌面宽视口 + fitWidth 重排」，iframe 拿到了尺寸。
             *
             * 代价是要多点两步（`WY_HOOK_JS` 自动点）：登录 → 选择其他登录模式 →
             * 勾协议 + 手机号登录/注册。登录框里的「登录」在跨域 iframe 里，
             * 我们点不到（也不该点）——提交永远由用户自己按，或由外部点在它上面。
             */
            "wy" -> Spec(
                "https://music.163.com/",
                "https://music.163.com/",
                listOf("MUSIC_U"),
                "登录网易云音乐",
                "点「手机号登录/注册」→ 勾选协议 → 填手机号，收短信验证码",
                fitWidth = 393,
                fitCss = WY_FIT_CSS,
                altCookieUrl = "https://y.music.163.com/",
                entryJs = WY_HOOK_JS,
                existingOk = true,
            )
            /*
             * QQ 音乐：开 **QQ 互联的 authorize 页**（就是 y.qq.com 登录弹层里那个 iframe）。
             *
             * 以前这里拼的是 `xui.ptlogin2.qq.com/cgi-bin/xlogin?...&s_url=https%3A%2F%2Fy.qq.com%2F`，
             * 二维码和图都出不来——实测：`s_url`/`u1` 带 y.qq.com **一律 403**，
             * 带 QQ 互联注册过的回调才 200。那张「二维码失效 / 扫码 403」不是风控，
             * 是我们自己把回调参数拼错了。
             *
             * 但光把 s_url 换成 `graph.qq.com/oauth2.0/login_jump` 也不行：那是给
             * QQ 互联 JS SDK 的中间页，要靠父页面（y.qq.com）带着 client_id 继续换票，
             * 单独开一个 iframe 等于把它扔在半路——登录成立了却没有 `qqmusic_key`
             * （手机 cookie 罐里只剩 `ptui_loginuin`，正是用户遇到的症状）。
             *
             * 下面这条是 y.qq.com 弹层里**真实在用的** iframe 地址（从页面上扒下来的，
             * client_id / redirect_uri 都是 QQ 音乐注册过的那一份）：
             *   · 一进来就是扫码框，扫完自动确认授权 → 跳 `portal/wx_redirect.html?code=…`
             *   · 那一步会把 `qqmusic_key` / `qm_keyst` 种进 WebView 的 cookie 罐
             *   · 不想扫码的还可以点「密码登录」
             * 走平台自己的流程，参数永远不会拼错。
             */
            "tx" -> Spec(
                "https://graph.qq.com/oauth2.0/authorize?response_type=code" +
                    "&client_id=100497308" +
                    "&redirect_uri=https%3A%2F%2Fy.qq.com%2Fportal%2Fwx_redirect.html" +
                    "%3Flogin_type%3D1%26surl%3Dhttps%253A%252F%252Fy.qq.com%252F" +
                    "&state=state&display=pc&scope=get_user_info%2Cget_app_friends",
                "https://y.qq.com/",
                listOf("qqmusic_key", "qm_keyst"),
                "登录 QQ 音乐",
                "手机 QQ 扫码后确认。只有一台手机：先截图 → QQ「扫一扫·相册」选它 → **用最近任务切回来**（点桌面图标会关掉本窗）",
                altCookieUrl = "https://ptlogin2.qq.com/",
                fitWidth = 393,
                existingOk = true,
            )
            /*
             * 酷狗：`login-user.kugou.com/login/` 是酷狗自己的登录组件页
             * （www.kugou.com 的登录弹窗就是拿 iframe 套的它）。
             * 它默认显示二维码，右上角那颗 `a.lgn_account` 是「手机登录在这里」，
             * 点开就是手机号 + 短信验证码——比扫码合理得多。
             */
            /*
             * 酷狗：网页版统一登录页（`login-user.kugou.com`），手机号 + 短信验证码。
             *
             * 三个坑，都实测过：
             *
             * 1) **短信发不出去，是因为前面挡着一道滑块。**
             *    点「发送验证码」不会立刻发短信，先弹腾讯 TCaptcha 拼图
             *    （`turing.captcha.gtimg.com/1/template/drag_ele.html`，360×360），
             *    拖过才真发 `gateway.kugou.com/v8/send_mobile_code`。滑块不过就一直静悄悄——
             *    用户以为「点了没反应」。所以 `hint` 必须把这一步写出来，
             *    并且给一条不需要滑块的退路（页面右上角那颗切扫码的按钮）。
             *
             * 2) **UA 必须是本机的**（`mobile = true`，见 `stripWebViewMarks`）。
             *    桌面 Chrome 的 UA 跑在安卓 WebView 里，机型 / 触摸 / 屏幕三处自相矛盾，
             *    腾讯风控正好拿这个判高风险，滑块会一直失败。
             *
             * 3) **登录成功后写的是 `KuGoo` 这一个 cookie**，值里再放子键：
             *    `KugooID=…&t=…&UserName=…&NickName=…&Pic=…`（酷狗自己的
             *    `KgUser.Cookie.read("KuGoo","KugooID")` 就是按 `&` 拆开读的，
             *    平台层 `kg.ts` 的 `loginOf` 同构解析）。
             *    所以判定「登上了」只能看 `KuGoo`——别把 `UserName` 当独立 cookie，
             *    它只是 `KuGoo` 里的一个子键，永远不会单独出现。
             *    `token` / `kg_login` 留着兜底：新版接口若改成平铺写，也能接住。
             */
            "kg" -> Spec(
                "https://login-user.kugou.com/login/?appid=1014" +
                    "&ref=https://www.kugou.com/reg/web/" +
                    "&redirect_uri=https://staticssl.kugou.com/common/html/login/regok.html" +
                    "&callback=UsLoginCallback",
                "https://www.kugou.com/",
                listOf("KuGoo", "token", "kg_login", "KugouToken"),
                "登录酷狗音乐",
                "① 输手机号 →「发送验证码」→ 先拖滑块拼完图 → ②收到短信填验证码 → ③登录\n" +
                    "滑块反复不过，就点右上的二维码图标，改用酷狗 App 扫码",
                mobile = true,
                altCookieUrl = "https://login-user.kugou.com/",
                fitWidth = 393,
                taps = listOf("a.lgn_account"),
            )
            /*
             * 酷我：没有独立的登录页 URL（移动站全是「页面没有找到」的 SPA 兜底），
             * 只能开 www.kuwo.cn 再点登录。它的登录框是页内 DOM，两处要掰：
             *   · `body { min-width:1000px }` 顶着，不放开注入的 viewport 就不生效；
             *   · 默认显示的是 QQ / 微信 / 微博那一屏（`.platforms`），
             *     账号密码表单在 `.account` 里被盖着，直接把它翻上来，
             *     省得用户去点「酷我帐号」那颗图标（点它还要滚，手机上很难点中）。
             */
            "kw" -> Spec(
                "https://www.kuwo.cn/",
                "https://www.kuwo.cn/",
                listOf("kw_token", "userid", "token"),
                "登录酷我音乐",
                "填入酷我帐号（手机号 / 邮箱）和密码，图形验证码点一下图片会刷新",
                fitWidth = 393,
                fitCss = KW_FIT_CSS,
                tapLoginEntry = true,
            )
            else -> null
        }

        /** 桌面 Chrome 的 UA：站点按它给 PC 版页面，登录入口就是二维码 */
        private const val DESKTOP_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

        /** 安卓 Chrome 的 UA：站点给移动版页面（手机号登录）。只在拿不到本机 UA 时兜底 */
        private const val MOBILE_UA =
            "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"

        /**
         * 把 WebView 默认 UA 洗成「看起来像真手机浏览器」。
         *
         * WebView 自报的 UA 长这样：
         *   `… (Linux; Android 14; FMR0223A26015945 Build/…; wv) … Version/4.0 Chrome/104…`
         * 两处标记会被风控和人眼同时识别成「这是个壳」：
         *   · `; wv)` —— WebView 专用标记；
         *   · `Version/4.0` —— 安卓 WebView 的版本段，真 Chrome 没有。
         * 摘掉这两处，剩下的是机型 + Build + Chrome 版本，跟真机浏览器一致。
         *
         * 别改成 `replace("Android", "Windows")` 那类「装成电脑」的做法：
         * touch 支持、屏幕尺寸、机型全在 JS 里露着，装得越像越可疑。
         */
        private fun stripWebViewMarks(ua: String): String {
            val cleaned = ua
                .replace("; wv)", ")")
                .replace(" Version/4.0", "")
                .trim()
            return if (cleaned.contains("Mobile")) cleaned else MOBILE_UA
        }
    }

    private lateinit var web: WebView
    /** 整个窗口的根容器：WebView 塌成 0 高时要靠它重新测量 */
    private lateinit var rootBox: LinearLayout
    private val handler = Handler(Looper.getMainLooper())
    /** 高度自愈走到第几步了（0 重排 / 1 摘挂），防止无限循环 */
    private var healStep = -1
    /** 被钉住的二维码图片字节（null = 还没取过） */
    private var qrPinBytes: ByteArray? = null
    /** 与上面那张图配套的 `qrsig`，必须与 CookieManager 里唯一的那个一致 */
    private var qrPinSig: String? = null
    /** 什么时候取的这张图，用来判定「寿命到了」 */
    private var qrPinAt = 0L
    /** 当前是不是 QQ 音乐的登录页（只有它需要钉码） */
    private var isQq = false
    private var spec: Spec? = null
    /** 打开时的 cookie 快照：判「变了」的基线 */
    private var baseline: Map<String, String> = emptyMap()
    /**
     * 基线是否已经采过了。
     *
     * **不能拿 `baseline.isEmpty()` 当这个标志**（之前就是这么写的，是个真 bug）：
     * 页面刚打开、CookieManager 还没回值时读到的是空串，那是**一次合法的基线**，
     * 但 map 为空 → 下一轮又进「初始化」分支 → 只要该域在第一轮真的没有任何 cookie，
     * 就永远初始化不完，后面的「值变了没」一次都不会检查。
     * 表现就是：用户明明登录成功，窗口一直转到 5 分钟超时才弹回来。
     */
    private var baselined = false
    private var settled = false
    private var startedAt = 0L
    /** 顶栏那行小字。加载失败 / 等太久要改它，用户才知道现在卡在哪 */
    private var hintView: TextView? = null
    private var lastHint = ""
    /** 见 EXTRA_FORCE：为 true 时不认已有凭证 */
    private var force = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Sy.init(this)
        alive = true
        val source = intent.getStringExtra(EXTRA_SOURCE).orEmpty()
        val sp = spec(source)
        if (sp == null) {
            finishWith(error = "不认识的平台：$source")
            return
        }
        spec = sp
        isQq = sp.url.contains("graph.qq.com")
        force = intent.getBooleanExtra(EXTRA_FORCE, false)
        startedAt = System.currentTimeMillis()

        rootBox = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#0E0F13"))
        }
        val root = rootBox

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
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
        })
        /*
         * 提示文字**必须限行**。
         *
         * 它是 `WRAP_CONTENT` 高度，跟着 bar（也是 WRAP_CONTENT）一起把根容器的
         * 高度占掉，WebView 靠 `weight=1` 吃剩下的。平时宽度正常、两三行也就
         * 几十 dp；但只要哪一次测量宽度还是 0（页面刚切完、窗口尺寸还没落定，
         * 或者键盘收起的那一拍），这行字就会按 0 宽无限换行——高度一路涨到超过
         * 整屏，WebView 的 weight 只能分到 **0 高**。
         *
         * 黑屏就是这么来的：页面 DOM、二维码、勾选框全在，`window.innerHeight`
         * 却是 0，内容整片被裁到窗口外。限成三行，这条路径彻底堵死。
         */
        titleBox.addView(TextView(this).apply {
            // 平台的登录框是它们自己的 JS 弹出来的，脚本点不动（isTrusted 校验），
            // 所以这里直接告诉用户点哪儿——比让他对着一个网页发呆强
            text = sp.hint
            setTextColor(Color.parseColor("#8C93A0"))
            textSize = 11.5f
            maxLines = 3
            ellipsize = android.text.TextUtils.TruncateAt.END
        }.also { hintView = it; lastHint = sp.hint })
        bar.addView(titleBox, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        /*
         * 重新加载。
         *
         * 平台登录页是它们自己那套单页应用，偶尔会有「一直转圈、表单不出来」的时候
         * （实测网易云点完「手机号登录」卡在 spinner 上，资源明明能拉到）。
         * 没有这颗按钮，用户唯一的出路是关掉重开；有它，卡住时点一下就好——
         * 而且**不会**丢会话：cookie 和已填的账号是 CookieManager 里的，刷新不带走。
         */
        bar.addView(TextView(this).apply {
            text = "刷新"
            setTextColor(Color.parseColor("#8C93A0"))
            textSize = 14f
            setPadding(dp(12), dp(6), dp(12), dp(6))
            setOnClickListener {
                /*
                 * 先自愈再重载：黑屏那种情况是 WebView 被量成 0 高，
                 * 单靠 reload 拿到的新页面还是同一个 0 高视口，点了等于没点。
                 */
                healStep = -1
                unpinQr()
                healWebHeight()
                web.reload()
                setHint(spec?.hint ?: "")
            }
        })
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
                cacheMode = WebSettings.LOAD_DEFAULT
                if (sp.mobile) {
                    /*
                     * 移动版页面自己带 viewport，让 WebView 再按「桌面宽屏」缩放会把表单压成
                     * 一窄条，聚焦输入框时还会自动放大。这里全部交给页面的 viewport。
                     */
                    loadWithOverviewMode = false
                    useWideViewPort = false
                    setSupportZoom(false)
                    builtInZoomControls = false
                } else {
                    loadWithOverviewMode = true
                    useWideViewPort = true
                    // 桌面版页面缩到 412dp 宽只有一半大小，字很小；允许双指缩放自己放大
                    setSupportZoom(true)
                    builtInZoomControls = true
                    displayZoomControls = false
                }
                /*
                 * `mobile` 的页面用**本机 WebView 自报的 UA**，只把 `; wv` 和
                 * `Version/4.0` 这两个「我是内嵌浏览器」的标记摘掉。
                 *
                 * 为什么不用硬编码的 `MOBILE_UA`：那串写的是 `Pixel 8`，而这台机器
                 * 是华为——机型、Build 号、Chrome 版本全都跟真实设备对不上。
                 * 酷狗发短信前要过**腾讯 TCaptcha 拼图滑块**（`turing.captcha.gtimg.com`），
                 * 那套风控拿 UA / 触摸能力 / 屏幕参数互相印证，UA 自相矛盾就判高风险，
                 * 表现是「滑块怎么拖都过不去、短信永远发不出来」——
                 * 用户看到的只是一句「登录不了」。用真机身自报的 UA 才不会有这个矛盾。
                 *
                 * 读的时候这个属性还是 WebView 的默认值（下面这行才把它改掉），
                 * 所以能直接拿来自净。`MOBILE_UA` 留作兜底。
                 */
                userAgentString = if (sp.mobile) stripWebViewMarks(userAgentString) else DESKTOP_UA
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
            /**
             * 主文档开始加载 = 新一轮登录，钉住的旧码作废。
             *
             * 不清的话，用户手动点「刷新」或在别处重新打开登录页时，
             * 会沿用上一轮那张已经快过期的图，看起来像「码一直是旧的」。
             */
            override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                super.onPageStarted(view, url, favicon)
                unpinQr()
                spec?.let { setHint(it.hint) }
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                // 页面每次导航都会换文档，注入的钩子跟着没了 → 每轮补一次
                hookLoginButton()
                /*
                 * 页面换完之后量一次高度。
                 *
                 * QQ 音乐扫码成功那一下，页面会从「登录框」切到「授权确认」，
                 * 实测在这台机器上切完 WebView 会被量成 0 高：DOM 全在
                 * （文字、二维码、勾选框都读得到），但 `window.innerHeight === 0`，
                 * 内容整片被裁到窗口外，用户看到的就是一块黑屏，怎么点都没反应。
                 */
                handler.postDelayed({ healWebHeight() }, 900)
            }

            /**
             * 拦掉一切非 http(s) 跳转。
             *
             * 这是「点了登录，跳过去又跳回来」的真正原因：网易云 / 酷狗 / 酷我的页面里
             * 都有「打开 App」的引流逻辑（`orpheus://`、`kugou://`、`intent://`、`openapp`）。
             * 手机上装了对应 App 时，这串跳转会**真的把系统切到那个 App**，我们的登录页
             * 被压到后台；用户再切回来（或按返回）就以为「登录失败，退回来了」。
             * 而这些页面本身在 WebView 里是能正常登录的，根本不需要跳出去。
             */
            override fun shouldOverrideUrlLoading(view: WebView?, req: WebResourceRequest?): Boolean {
                val u = req?.url?.toString().orEmpty()
                return u.isNotEmpty() && !u.startsWith("http://") && !u.startsWith("https://")
            }

            @Deprecated("旧机型走这个重载")
            override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
                val u = url.orEmpty()
                return u.isNotEmpty() && !u.startsWith("http://") && !u.startsWith("https://")
            }

            /**
             * **把二维码钉住**（只对 QQ 生效）。
             *
             * 实测：登录页只要一被判为「不可见」（切去 QQ 扫码、按 HOME），
             * 1~2 秒内就会自己重发 `ptqrshow` 换一张新码 —— 用户手里那张当场作废，
             * 在 QQ 里点「确认」也确认到一张服务器已丢弃的码上，轮询永远停在 66。
             * 这就是「截图 → 相册扫码」这条路怎么都登不上的真正原因。
             *
             * 做法：第一次由我们自己取图，**同时**把 Set-Cookie 里的 `qrsig` 写成
             * 全罐唯一的一份（先删掉别的域上的同名 cookie —— 两个 qrsig 会让
             * 页面算出的 `ptqrtoken` 与图片对不上，第一次轮询就 65，务必先删）。
             * 之后寿命内的换码请求一律返回同一张图和同一个 `qrsig`，
             * 页面据此算出的 token 不变，服务器上那张码也还在有效期内。
             */
            override fun shouldInterceptRequest(
                view: WebView?,
                req: WebResourceRequest?,
            ): WebResourceResponse? {
                val u = req?.url?.toString() ?: return null
                if (!u.contains("ptqrshow")) return null
                if (!isQq) return null
                android.util.Log.i("Shuyin", "qr-intercept 命中 钉住=${qrPinSig?.take(8)} 码龄=${(System.currentTimeMillis() - qrPinAt) / 1000}s")
                val r = pinOrFetchQr(u)
                android.util.Log.i("Shuyin", "qr-intercept 返回 ${if (r == null) "放行(自己请求)" else "缓存图"}")
                return r
            }

            /** 主文档加载失败：白屏不说原因的话，用户只会以为「卡住了」然后退出 */
            override fun onReceivedError(
                view: WebView?,
                req: WebResourceRequest?,
                err: WebResourceError?,
            ) {
                if (req?.isForMainFrame != true) return
                setHint("页面打不开（${err?.description ?: "网络错误"}）—— 检查网络后重开", warn = true)
            }
        }
        web.webChromeClient = WebChromeClient()
        root.addView(web, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))

        setContentView(root)
        /*
         * `force`：先把这家平台的凭证 cookie 清掉，再打开登录页。
         *
         * 不清的话会撞上一个死循环：WebView 里还留着上一次的 MUSIC_U / qm_keyst，
         * 网易云的 `/m/login` 读到它就**直接跳回首页**——用户看到的就是
         * 「跳转不到登录页面」，紧接着我们这边 existingOk 又把这份旧 cookie
         * 原样退回去，前端校验失败 → 提示「没拿到登录凭证」→ 弹回来。
         * 只清本平台的几个 key，不动别的站点。
         */
        if (force) clearSpecCookies(sp)
        /*
         * QQ 的二维码有个隐蔽的坏法：`qrsig` 可能在 `.ptlogin2.qq.com` 和
         * `xui.ptlogin2.qq.com` 各存一份（历史会话残留、或早期实验写进去的）。
         * 浏览器会把**两个都**塞进同一个 Cookie 头，服务器取到旧的那个，
         * 而页面用新的那个算 `ptqrtoken` —— 两边不一致，**第一次轮询就回 65
         * 「二维码已失效」**。用户看到的现象是「码刚出来两三秒就废了，都不用人走开」，
         * 跟寿命、切后台都无关。开窗前先删干净，让页面自己种唯一一份。
         */
        if (source == "tx") dedupeQrCookie()
        web.loadUrl(sp.url)

        handler.postDelayed(poll, POLL_MS)
    }

    /**
     * 钉住二维码：寿命内一律返回同一张图 + 同一个 `qrsig`；到点放行一张新的。
     *
     * 返回 null 表示「这次不拦」，交给 WebView 自己发请求（取图失败时的兜底）。
     */
    private fun pinOrFetchQr(url: String): WebResourceResponse? {
        val now = System.currentTimeMillis()
        val cachedBytes = qrPinBytes
        val cachedSig = qrPinSig
        if (cachedBytes != null && cachedSig != null && now - qrPinAt < QR_PIN_MS) {
            return qrResponse(cachedBytes, cachedSig)
        }
        val cm = CookieManager.getInstance()
        return try {
            val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = 8000
                readTimeout = 8000
                instanceFollowRedirects = true
                cm.getCookie(url)?.let { setRequestProperty("Cookie", it) }
            }
            if (conn.responseCode != 200) {
                conn.disconnect()
                return null
            }
            val fresh = conn.inputStream.use { it.readBytes() }
            val headers = conn.headerFields["Set-Cookie"].orEmpty() +
                conn.headerFields["set-cookie"].orEmpty()
            conn.disconnect()
            val newSig = headers.firstNotNullOfOrNull { line ->
                Regex("qrsig=([^;]+)").find(line)?.groupValues?.get(1)
            }
            if (fresh.isEmpty() || newSig == null) return null
            // 先删干净再种：两个同名 qrsig 会让页面算的 token 与图片对不上（55 变 65）
            dedupeQrCookie()
            cm.setCookie("https://xui.ptlogin2.qq.com/", "qrsig=$newSig; Path=/")
            cm.flush()
            qrPinBytes = fresh
            qrPinSig = newSig
            qrPinAt = now
            qrResponse(fresh, newSig)
        } catch (_: Throwable) {
            null
        }
    }

    private fun qrResponse(bytes: ByteArray, sig: String): WebResourceResponse =
        WebResourceResponse(
            "image/png",
            null,
            200,
            "OK",
            mapOf(
                "Content-Type" to "image/png",
                "Cache-Control" to "no-store",
                "Set-Cookie" to "qrsig=$sig; Path=/",
            ),
            ByteArrayInputStream(bytes),
        )

    /** 放弃当前钉住的码（用户主动点「刷新」时用），下一次换码才会真的换新 */
    private fun unpinQr() {
        qrPinBytes = null
        qrPinSig = null
        qrPinAt = 0L
    }

    /**
     * 清掉 ptlogin 域上所有 `qrsig`（只为 QQ 音乐服务）。
     *
     * 为什么要清：`qrsig` 是二维码的会话种子，页面拿它算出 `ptqrtoken` 去轮询。
     * CookieManager 允许同名 cookie 在不同域上共存，取回时会被拼进同一个 Cookie 头；
     * 服务端认第一个，页面算的是自己那份 —— 一旦两者不是同一个值，轮询立刻 65。
     * 删完本次会话由页面重新种一份，不会再有歧义。
     */
    private fun dedupeQrCookie() {
        val cm = CookieManager.getInstance()
        for (h in listOf("xui.ptlogin2.qq.com", "ptlogin2.qq.com")) {
            cm.setCookie("https://$h/", "qrsig=; Max-Age=0; Path=/")
            cm.setCookie("https://$h/", "qrsig=; Max-Age=0; Path=/; Domain=.$h")
        }
        cm.flush()
    }

    /** 改顶栏那行小字。同文案不重复设，省得每轮轮询都触发一次重绘 */
    private fun setHint(text: String, warn: Boolean = false) {
        if (text == lastHint) return
        lastHint = text
        hintView?.apply {
            this.text = text
            setTextColor(Color.parseColor(if (warn) "#FF8C8C" else "#8C93A0"))
        }
    }

    override fun onResume() {
        super.onResume()
        /*
         * 从 QQ / 微信 App 扫码回来、或键盘收起之后，WebView 有可能被量成 0 高。
         * 延迟一点再量：resume 当下窗口尺寸还没算完，立刻测量拿到的还是旧值。
         */
        handler.postDelayed({ healWebHeight() }, 320)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) handler.postDelayed({ healWebHeight() }, 320)
    }

    /**
     * WebView 高度自愈。
     *
     * 起因是一次真实故障：QQ 音乐扫码确认后，登录窗**整片黑**。
     * 连上调试通道后发现页面其实活得好好的——DOM、文字、二维码全在，
     * 只有 `window.innerHeight` / `document.documentElement.clientHeight` 是 **0**。
     * 也就是 WebView 自己被测成了 0 高，内容全部被裁到窗口外；这种情况下
     * 用户点「刷新」也没用，重载后拿到的还是同一个 0 高视口。
     *
     * 只做两种**不碰页面内容**的修复，**永远不自动 reload**（改于 2026-11）：
     *   1. `requestLayout()` 让系统重新测一次（大多数情况够）；
     *   2. 把 WebView 摘下来再装回去——视图树测量缓存坏了时只有这招管用。
     *
     * 为什么不能自动重载：切去 QQ 扫码时 Activity 会 stop，回到前台那一刻窗口还没
     * 测完，`web.height` 读出来就是 **0**，于是这条链被「量不到」触发，
     * 320 + 260 + 260 ms 后走到 `reload()` —— 实测从回到前台到 `ptqrshow`
     * （新二维码）**只隔 0.8 秒**，正好是这条链的时长。用户刚扫的那张码当场作废，
     * 这才是「切一次 App 换一次码、扫码永远登不上」的真正原因。
     * 而重载本来也救不了 0 高视口（重载后还是同一个容器），有害无益。
     * 真要刷新时右上角有「刷新」，那是用户主动点的，另当别论。
     */
    private fun healWebHeight() {
        if (isFinishing || !::web.isInitialized || !::rootBox.isInitialized) return
        if (web.height > 0) {
            healStep = -1
            return
        }
        val step = healStep + 1
        healStep = step
        when (step) {
            0 -> {
                rootBox.requestLayout()
                web.requestLayout()
            }
            1 -> {
                /* 摘下来再装回去：只调 requestLayout 修不好测量缓存 */
                try {
                    val lp = web.layoutParams
                    rootBox.removeView(web)
                    rootBox.addView(web, lp)
                } catch (_: Throwable) {
                }
            }
            else -> {
                /* 只提示不动页面；healStep 归零让下次回到前台还能再试一遍 */
                setHint("页面显示异常，可点右上角「刷新」重试", warn = true)
                healStep = -1
                return
            }
        }
        handler.postDelayed({ healWebHeight() }, 260)
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
        val sp = spec ?: return
        /*
         * QQ 音乐授权页的两段处理，见 [TX_FIT_JS] / [TX_AGREE_JS]：
         * 布局修正随时跑（幂等）；**同意那一声绝不能在这跑**——
         * 授权勾选框在扫码之前就渲染好了，页面侧自动点 = 用户还没扫码就被提交，
         * 服务器弹回 → 再点 → 无限重载（真机复现过，用户看到的就是「一开就闪」）。
         * 时机由 [maybeAutoAgree] 用 cookie 里的 `p_skey` 把关。
         */
        if (web.url?.contains("graph.qq.com") == true) {
            web.evaluateJavascript(TX_FIT_JS, null)
        }
        /*
         * 移动版页面**本身就是登录表单**，页面上那颗「登录」是提交按钮——
         * 自动点它等于反复提交空表单，用户刚输一半就被清空/报错。
         * 所以这里不跑 `HOOK_JS`，只跑「适配 + 切 tab」。
         *
         * 但**不能只跑关弹层**（以前就是这么写的，踩过两次）：
         *
         *   · 酷狗移动页默认停在**扫码**，手机号表单要切一下（`taps` 里的
         *     `a.lgn_account`）。不跑 `taps` 的话，用户看到一张二维码，
         *     而我们提示里让他「输入手机号」——两边对不上，只能干瞪眼。
         *   · 那段「关弹层」在酷狗身上是**反效果**：整个登录框就挂在 `.kg_popup` 里，
         *     里面的 `a.kg_popup_close` 正好命中 `[class*=close]`，
         *     点中就等于用户自己把窗关了。
         */
        if (sp.mobile) {
            if (sp.fitWidth > 0 || sp.taps.isNotEmpty() || sp.fitCss.isNotEmpty()) {
                web.evaluateJavascript(fitScript(sp), null)
            }
            // 自定义入口脚本（同上：自己保证幂等）
            sp.entryJs?.let { web.evaluateJavascript(it, null) }
            return
        }
        /*
         * fitWidth 模式下页面上那颗「登录」同样是提交按钮（酷狗 / QQ 都是），
         * 绝对不能再跑 HOOK_JS。要点的只有 `taps` 里那几个「切到账号密码」的 tab。
         * 酷我是例外：登录框要在首页里点出来，所以额外跑一次只点入口的钩子。
         */
        if (sp.fitWidth > 0) {
            web.evaluateJavascript(fitScript(sp), null)
            /*
             * 自定义入口脚本（网易云 PC 站那三步）。它自己按 DOM 状态推进，
             * 每轮跑一次是安全的：已经到了表单（`#captcha-login-box`）就什么都不做。
             */
            sp.entryJs?.let { web.evaluateJavascript(it, null) }
            if (sp.tapLoginEntry) web.evaluateJavascript(HOOK_JS, null)
        } else {
            web.evaluateJavascript(HOOK_JS, null)
        }
    }

    /**
     * 把 PC 登录页改造成「手机上能用」的形状。
     *
     * 三件事，每轮轮询都刷一遍（页面是 SPA，DOM 随时重建，只做一次会失效）：
     *   1. 注入 viewport，把排版宽度改成设备宽度——1 CSS px = 1 dp，
     *      PC 登录框原样铺满屏幕，输入框从 16dp 回到 40dp；
     *   2. 刷一遍适配 CSS（酷我要放开 `body{min-width:1000px}`，
     *      并把被第三方登录盖住的账号密码表单翻上来）；
     *   3. 点 `taps` 里的 tab（酷狗「手机登录在这里」、QQ「密码登录」），
     *      点过打标记，不重复点。
     *
     * 酷我那个登录框给它加上 `.sy-login` 再定位：`.login` 这个名字太通用，
     * 直接选组容易把页面上别的登录按钮一起钉到屏幕中央。
     */
    private fun fitScript(sp: Spec): String {
        val css = sp.fitCss.replace("\\", "\\\\").replace("'", "\\'").replace("\n", " ").trim()
        val taps = sp.taps.joinToString(",") { "'" + it.replace("\\", "\\\\").replace("'", "\\'") + "'" }
        return """
(function () {
  var W = ${sp.fitWidth};
  var CSS = '$css';
  var TAPS = [$taps];
  try {
    var m = document.querySelector('meta[name=viewport]');
    if (!m) {
      m = document.createElement('meta');
      m.setAttribute('name', 'viewport');
      (document.head || document.documentElement).appendChild(m);
    }
    var want = 'width=' + W + ', initial-scale=1';
    if (m.getAttribute('content') !== want) m.setAttribute('content', want);
  } catch (e) {}
  /* 酷我：给「含第三方登录图标那颗 .login」打标记，别误伤同名的其他块 */
  try {
    var plat = document.querySelector('.login .platforms');
    if (plat) {
      var host = plat.parentElement;
      if (host && host.className.indexOf('sy-login') < 0) host.className += ' sy-login';
    }
  } catch (e) {}
  if (CSS) {
    try {
      var s = document.getElementById('__sy_fit');
      if (!s) {
        s = document.createElement('style');
        s.id = '__sy_fit';
        (document.head || document.documentElement).appendChild(s);
      }
      if (s.textContent !== CSS) s.textContent = CSS;
    } catch (e) {}
  }
  for (var i = 0; i < TAPS.length; i++) {
    try {
      var el = document.querySelector(TAPS[i]);
      if (!el) continue;
      /*
       * 最多点 6 次（约 5 秒），不是 1 次。
       * `onPageFinished` 时页面的 click 处理器往往还没绑上（ptlogin 的 tab 是
       * 异步 init 的），第一次点击就是空点；只点一次的话后面永远不再试，
       * 用户看到的就是「停在扫码页，怎么点都不动」。多试两次，且 tab 切换是幂等的。
       */
      var n = parseInt(el.getAttribute('data-sy-tap') || '0', 10);
      if (n < 6) {
        el.setAttribute('data-sy-tap', String(n + 1));
        el.click();
      }
    } catch (e) {}
  }
  /*
   * 酷我：图形验证码 `<img class="login_code">` 初始是**空 src**，
   * 只有点它才会去拉图。不点的话那个框就是一块空白，用户以为「验证码坏了」，
   * 其实只是没加载——这是「酷我登不上」里最冤的一条。
   * 只在 src 为空时点：刷过一次之后 src 是 data:image/png，不会反复刷新
   * （反复刷新会把用户刚看清的验证码换掉）。
   */
  try {
    var cap = document.querySelector('.login_code');
    if (cap && !cap.getAttribute('src')) cap.click();
  } catch (e) {}
})();
"""
    }

    private val poll = object : Runnable {
        override fun run() {
            if (settled) return
            val sp = spec ?: return
            val cookie = readCookie(sp)
            val now = parseCookie(cookie)

            if (!baselined) {
                /*
                 * 第一轮无条件把当前 cookie 当基线——哪怕是空的。
                 * 以前只在 `cookie.isNotEmpty()` 时才采，页面还没开始写 cookie 的话
                 * 就永远采不到基线，后面所有「值变了没」的判断一次都跑不到。
                 */
                baseline = now
                baselined = true
                /*
                 * 已经登录过的人：凭证在进页面之前就存在，基线等于直接抄了它，
                 * 后面永远不会「变化」——所以这里先认一次，别再让他重登。
                 */
                if (sp.existingOk && !force && sp.keys.any { !now[it].isNullOrEmpty() }) {
                    setHint("读到已保存的登录凭证，正在返回…")
                    finishWith(cookie = cookie)
                    return
                }
            } else {
                for (k in sp.keys) {
                    val before = baseline[k]
                    val after = now[k]
                    if (!after.isNullOrEmpty() && after != before) {
                        setHint("已拿到登录凭证，正在返回…")
                        finishWith(cookie = cookie)
                        return
                    }
                }
                /*
                 * 兜底：打开时没清干净的旧凭证（用户是「重新登录」，但 baseline 里
                 * 已经有那个 key）—— 值没变，可它其实一直是有效的，认它。
                 * 只对 `existingOk` 的平台开：酷狗/酷我未登录也写游客 token/userid，
                 * 无脑认会把「一进页面」判成登录成功。
                 */
                if (sp.existingOk && !force && sp.keys.any { !now[it].isNullOrEmpty() }) {
                    setHint("已有登录凭证，正在返回…")
                    finishWith(cookie = cookie)
                    return
                }
            }

            if (System.currentTimeMillis() - startedAt > TIMEOUT_MS) {
                /*
                 * 超时要把「卡在哪」说清楚，不能只说「等太久」。
                 * 实测过的一种真实现象：用户以为点完「手机号登录」就登上了，
                 * 其实还被协议弹层挡着（`服务协议和隐私政策等指引`），页面一步没走。
                 * 把当前 URL 和已拿到的 cookie 项数带出去，一眼能分出
                 * 「没登完」和「登完了但我们没认出来」。
                 */
                val got = parseCookie(readCookie(sp)).keys
                val where = web.url?.substringAfter("://")?.take(46) ?: "未知页面"
                val lack = sp.keys.filter { got.none { k -> k == it } }.joinToString("/")
                finishWith(error = "登录没完成：页面还停在 $where，没读到 $lack")
                return
            }
            hookLoginButton()
            maybeAutoAgree()
            showProgress(sp, now)
            handler.postDelayed(this, POLL_MS)
        }
    }

    /**
     * 等久了才把状态亮到顶栏第二行（见 `DIAG_AFTER_MS`）。
     *
     * 内容是「现在停在哪一页 + 读到几项 cookie + 还缺哪个 key」：
     * 三种失败（页面没打开 / 页面打开了但没登 / 登了但没认出来）在界面上长得一模一样，
     * 只有这行字能分开它们。用户拍一张截图就能定位，不用连电脑抓 logcat。
     */
    private fun showProgress(sp: Spec, now: Map<String, String>) {
        if (System.currentTimeMillis() - startedAt < DIAG_AFTER_MS) return
        val where = web.url?.substringAfter("://")?.take(30) ?: "加载中"
        val lack = sp.keys.filter { now[it].isNullOrEmpty() }
        val state = if (lack.isEmpty()) {
            "已读到 ${sp.keys.joinToString("/")}，正在校验…"
        } else {
            "等 ${lack.joinToString("/")} · 页面 $where · cookie ${now.size} 项"
        }
        setHint("${sp.hint}\n$state")
    }

    /**
     * 把这家平台的凭证 cookie 过期掉（只动 `sp.keys` 里那几个 key）。
     *
     * 用 `Max-Age=0` 逐条过期，而不是 `removeAllCookies()`：CookieManager 是
     * 进程级的，一把清空会把主界面 WebView 里别的东西（云同步、来源设置）一起带走。
     *
     * **必须连父域一起删**（这是「重新登录永远登不上」的真凶）：
     * 网易云的 MUSIC_U 种在 `.music.163.com`，而这里原来只拿
     * `https://y.music.163.com/` 去删——那删的是 y 这个子域下的同名 cookie，
     * 父域那份纹丝不动。于是页面一打开就读到旧凭证、直接跳走，
     * 用户看到的是「点了登录，页面跳一下又回来，还是没登上」。
     * 现在把 `y.music.163.com → music.163.com`、`www.kugou.com → kugou.com`
     * 这些层级都试一遍，带 `Domain=` 和不带都删一次。
     */
    private fun clearSpecCookies(sp: Spec) {
        val cm = CookieManager.getInstance()
        val hosts = LinkedHashSet<String>()
        for (u in listOfNotNull(sp.cookieUrl, sp.altCookieUrl)) {
            val h = android.net.Uri.parse(u).host ?: continue
            hosts.add(h)
            val parts = h.split('.')
            // y.music.163.com → music.163.com（不去到 .com/.cn 这一级）
            for (i in 1 until parts.size - 1) {
                hosts.add(parts.drop(i).joinToString("."))
            }
        }
        for (h in hosts) {
            val url = "https://$h/"
            val jar = parseCookie(cm.getCookie(url).orEmpty())
            for (k in sp.keys) {
                if (!jar.containsKey(k)) continue
                cm.setCookie(url, "$k=; Max-Age=0; Path=/")
                cm.setCookie(url, "$k=; Max-Age=0; Path=/; Domain=.$h")
            }
        }
        /*
         * QQ 音乐：登录起点在 graph.qq.com（授权页），不在上面的域清单里。
         * 强制重登时要把 `p_skey`（QQ 互联会话票据）一并清掉——
         * 不清的话 [maybeAutoAgree] 会把旧票据当成「刚扫完码」，
         * 在用户还没扫的时候先替他「同意」一次（0.6.88 的闪屏就是这么来的）。
         */
        if (hosts.none { it.endsWith("qq.com") }) return
        for (h in listOf("graph.qq.com", "ptlogin2.qq.com")) {
            val url = "https://$h/"
            val jar = parseCookie(cm.getCookie(url).orEmpty())
            for (k in listOf("p_skey", "ptui_loginuin", "qlogin_uid")) {
                if (!jar.containsKey(k)) continue
                cm.setCookie(url, "$k=; Max-Age=0; Path=/")
                cm.setCookie(url, "$k=; Max-Age=0; Path=/; Domain=.qq.com")
            }
        }
        cm.flush()
    }

    /**
     * 读这个平台在该域下的 cookie，有 `altCookieUrl` 时取两个域的并集。
     *
     * `CookieManager.getCookie(url)` 只回**域名匹配 url** 的那些；
     * 同一份登录态在不同版本里可能种到父域或子域，只看一个就会漏（见 Spec 的注释）。
     * 合并时以主域为准：同名的 key 保留主域那份。
     */
    private fun readCookie(sp: Spec): String {
        val cm = CookieManager.getInstance()
        val main = cm.getCookie(sp.cookieUrl).orEmpty()
        val alt = sp.altCookieUrl?.let { cm.getCookie(it).orEmpty() }.orEmpty()
        if (alt.isBlank()) return main
        val seen = parseCookie(main).keys.toMutableSet()
        val out = StringBuilder(main)
        for (seg in alt.split(";")) {
            val s = seg.trim()
            val i = s.indexOf('=')
            if (i <= 0) continue
            if (!seen.add(s.substring(0, i).trim())) continue
            if (out.isNotEmpty()) out.append("; ")
            out.append(s)
        }
        return out.toString()
    }

    private fun parseCookie(raw: String): Map<String, String> {        val out = HashMap<String, String>()
        for (seg in raw.split(";")) {
            val s = seg.trim()
            val i = s.indexOf('=')
            if (i <= 0) continue
            out[s.substring(0, i).trim()] = s.substring(i + 1).trim()
        }
        return out
    }

    /**
     * QQ 音乐：确认用户已在 QQ 里点过「确认登录」之后，替他点授权页那颗
     * 不存在的「同意」按钮（见 [TX_AGREE_JS]）。
     *
     * 信号是 cookie 罐里出现 `p_skey`——QQ 互联的会话票据，**只在用户于
     * QQ App 里确认扫码之后**才由服务器种下，扫码前页面侧任何东西
     * （授权勾选框、`Q.agree` 函数）都已经就位，唯独它不可能提前出现。
     * 用它当闸门，第一次登录的用户也能安稳走到二维码出来。
     *
     * `p_skey` 是 httpOnly 的，页面 JS 读不到，但 CookieManager 读得到——
     * 这正好：也杜绝了页面侧脚本伪造信号的可能。
     *
     * 每**一份**票据只同意一次（值存进 [agreedPskey]）：同意之后页面会跳走
     * 换 `qqmusic_key`，若期间值变了说明是新一次扫码，需要再同意。
     */
    private var agreedPskey: String? = null

    private fun maybeAutoAgree() {
        val sp = spec ?: return
        if (sp.keys.none { it == "qqmusic_key" || it == "qm_keyst" }) return
        val url = web.url.orEmpty()
        if (!url.contains("graph.qq.com")) return
        /*
         * `p_skey` 种在 .graph.qq.com（httpOnly），readCookie() 的两个域
         * （y.qq.com / ptlogin2.qq.com）都读不到它——必须按授权页自己的域取。
         */
        val pskey = parseCookie(CookieManager.getInstance().getCookie("https://graph.qq.com/").orEmpty())["p_skey"].orEmpty()
        if (pskey.isEmpty() || pskey == agreedPskey) return
        agreedPskey = pskey
        setHint("扫码成功，正在确认授权…")
        web.evaluateJavascript(TX_AGREE_JS, null)
    }

    private fun finishWith(cookie: String? = null, error: String? = null, cancel: Boolean = false) {
        if (settled) return
        settled = true
        handler.removeCallbacksAndMessages(null)
        /*
         * 诊断留痕：登录窗自己关掉之后，「到底有没有拿到凭证」在界面上无从查起——
         * 前端只会给一句 toast，用户复述不准，抓 logcat 是唯一可靠的办法。
         */
        android.util.Log.i(
            "Shuyin",
            "platform-login finish ok=${!cookie.isNullOrEmpty()} len=${cookie?.length ?: 0}" +
                " cancel=$cancel err=$error keys=${parseCookie(cookie.orEmpty()).keys}" +
                " head=${cookie?.take(48).orEmpty()}",
        )
        /* 把 cookie 落盘再交给前端：主界面那边是从同一份 jar 里再取一次的，
         * 只留在内存里的话，紧接着的一次冷启/进程回收就会读到旧值 */
        if (!cookie.isNullOrEmpty()) {
            try { CookieManager.getInstance().flush() } catch (_: Exception) { }
        }
        val r = JSONObject().apply {
            put("ok", !cookie.isNullOrEmpty())
            if (!cookie.isNullOrEmpty()) put("cookie", cookie)
            if (!error.isNullOrEmpty()) put("error", error)
            put("cancel", cancel)
        }
        /*
         * **两条路同时投**，谁先到谁算。
         *
         * 1. 进程内直投 `MainActivity.deliverLogin`：不经过 startActivityForResult。
         *    主界面是 `launchMode="singleTask"`，而 singleTask 的 Activity 用
         *    `startActivityForResult` 时，系统有相当大概率**立刻**回调
         *    `onActivityResult(RESULT_CANCELED, data=null)`——那一下会被当成
         *    「用户取消了」，等用户真登完，回调早被消费掉了，登录窗白开一场。
         *    这就是「四个平台一个都登不上、每次都是同一句提示」最可能的共因。
         * 2. `setResult` 照旧：直投这条万一因为进程重建接不上（回调对象丢了），
         *    result 还能兜住。两条都幂等（见 deliverLogin）。
         */
        /*
         * **第三条路：原生事件**。
         *
         * 前两条（进程内直投 / result 通道）都挂在「有一个 JS 调用正在等」这个前提上：
         * 只要那个等待者早一步被消费掉（singleTask 的提前回调、命令通道丢回包、
         * 用户中途退到别的页面导致 invoke 的超时先到），后面真登成了也没人接——
         * 用户看到的就是「登了，但每次都说没拿到登录凭证」。
         * 事件这条路不依赖等待者：前端只要还活着，收到就把凭证落盘。
         */
        runCatching {
            MainActivity.postLoginEvent(JSONObject(r.toString()).put("source", intent.getStringExtra(EXTRA_SOURCE)))
        }
        MainActivity.deliverLogin(r)
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
        alive = false
        handler.removeCallbacksAndMessages(null)
        try { web.destroy() } catch (_: Exception) { }
        super.onDestroy()
    }
}

/**
 * 网易云 PC 站在 393dp 宽下的重排。
 *
 * PC 站是固定宽布局（`body` 上有 min-width），不放开的话注入的 viewport 白注，
 * 页面还是按 980 排版再缩到 0.4 倍 —— 登录框里的输入框只有 16dp 高，点不准。
 * 放开之后登录弹层（`.mrc-modal-container`）会自己铺满屏宽。
 *
 * 顺手把右下角那颗「下载客户端」悬浮球藏掉：它正好压在登录框底部，手机上一点就跳走。
 */
private const val WY_FIT_CSS = "html,body{min-width:0!important;width:100%!important;overflow-x:hidden!important}" +
    ".mrc-modal-container{max-width:100%!important}" +
    ".m-download,.m-app-download,[class*=download-client]{display:none!important}"

/**
 * 网易云 PC 站的登录入口是**点三步**点出来的。
 *
 *   1. 首页顶栏「登录」→ 弹出登录框；
 *   2. 登录框默认是二维码（手机上没法扫自己的屏）→「选择其他登录模式」；
 *   3. 模式列表里勾「同意条款」+「手机号登录/注册」→ 出现手机号 + 短信验证码表单。
 *
 * 表单本身在 `dl.reg.163.com` 的**跨域 iframe** 里（`#captcha-login-box`），
 * 我们既读不到也点不到它里面的「登录」——所以提交永远留给用户自己按。
 * 这段脚本只负责把表单请出来，看到 `#captcha-login-box` 就彻底收手，
 * 之后用户输入、点验证码、点登录，一概不碰。
 *
 * 幂等 + 节流：每轮轮询（900ms）都会跑，内部限速 1.2s，且按 DOM 状态推进，
 * 不会把已经打开的弹层点关（「登录」在弹层打开时不再匹配顶栏那颗）。
 */
private const val WY_HOOK_JS = """
(function () {
  var w = window;
  var now = Date.now();
  w.__syWy = w.__syWy || { t: 0 };
  if (now - w.__syWy.t < 1200) return;
  function T(e) { return (e.textContent || '').replace(/\s+/g, ''); }
  function pick(label, root) {
    var all = (root || document).querySelectorAll('a,button,span,div,li,p');
    var hit = null;
    for (var i = 0; i < all.length; i++) {
      var e = all[i];
      if (T(e) !== label) continue;
      var inner = false;
      for (var j = 0; j < e.children.length; j++) {
        if (T(e.children[j]) === label) { inner = true; break; }
      }
      if (inner) continue;
      var r = e.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      hit = e;
    }
    return hit;
  }
  try {
    var modal = document.querySelector('.mrc-modal-show,.mrc-modal');
    if (!modal) {
      /* 只在顶栏里找「登录」：页脚也有同样的词，点错了就跳去帮助中心 */
      var bar = document.querySelector('.m-topbar') || document.querySelector('#g-topbar') || document.body;
      var entry = pick('登录', bar);
      if (entry) { w.__syWy.t = now; entry.click(); }
      return;
    }
    /* 已经在短信表单上（跨域 iframe）：收手，一个键都别替用户按 */
    if (document.querySelector('#captcha-login-box')) { w.__syWy.t = now; return; }
    var body = T(modal);
    if (body.indexOf('手机号登录/注册') >= 0) {
      var box = modal.querySelector('input[type=checkbox]');
      if (box && !box.checked) box.click();
      var phone = pick('手机号登录/注册', modal);
      if (phone) { w.__syWy.t = now; phone.click(); }
      return;
    }
    if (body.indexOf('扫码登录') >= 0) {
      var other = pick('选择其他登录模式', modal);
      if (other) { w.__syWy.t = now; other.click(); }
    }
  } catch (e) {}
})();
"""

/**
 * 酷我最难搞：它的登录框是首页里点出来的页内 DOM，两处要掰。
 *
 * 1. `body { min-width: 1000px }` —— 不放开的话注入的 viewport 白注，页面还是 1000 宽，
 *    登录框照样被缩到 0.4 倍；
 * 2. 默认一屏是 QQ / 微信 / 微博 / 酷我帐号四颗图标（`.platforms`），
 *    账号密码表单在 `.account` 里被盖着。手机上点那颗「酷我帐号」图标本来就难点中，
 *    点完还要等一帧才翻上来——直接把表单翻上来，用户少一步。
 *
 * `.sy-login` 是注入脚本给「含第三方图标的那个 .login」打的标记（见 fitScript）：
 * `.login` 这个名字太通用，直接选组会把页面上别的登录按钮也钉到屏幕中央。
 */
private const val KW_FIT_CSS = "html,body{min-width:0!important;width:100%!important;overflow-x:hidden!important}" +
    ".sy-login{position:fixed!important;left:50%!important;top:50%!important;margin:0!important;" +
    "transform:translate(-50%,-50%)!important;z-index:99999!important}" +
    ".sy-login .platforms{display:none!important}.sy-login .account{display:block!important}"

/**
 * 移动版登录页：只关**推广**浮层，协议 / 隐私弹层绝不碰。
 *
 * **当前没有任何平台在用它**（保留着是因为这套判断本身是对的，见下）：
 * 唯一的移动版平台是酷狗，而酷狗整个登录框就挂在 `.kg_popup` 里，
 * 里面的 `a.kg_popup_close` 正好命中 `[class*=close]`——跑这段等于自动帮用户
 * 把登录窗关掉，比不跑糟糕得多。移动分支现在只跑 `fitScript`（适配 + 切 tab）。
 *
 * 网易云的移动登录页点了「手机号登录」会先弹一层
 * 「服务协议和隐私政策等指引 / 不同意 · 同意并继续」。以前这段脚本把弹层右上角
 * 的 `X` 当广告关掉了 —— 点 X 等于「不同意」，页面原地不动，用户看到的就是
 * 「点了登录没反应」，然后关窗 → 前端只能说「没拿到登录凭证」。
 *
 * 所以这里做两条硬约束：
 *   1. 弹层里出现「协议 / 隐私 / 条款 / 政策」字样的，**一律跳过**（不能替用户同意，
 *      也不能替用户拒绝——要他自己点那颗「同意并继续」）；
 *   2. 同意与否交给用户，顶栏那行提示会明确告诉他点哪儿（见 `Spec.tapHint`）。
 */
private const val CLOSE_POPUP_JS = """
(function () {
  function visible(el) {
    var r = el.getBoundingClientRect();
    return r.width > 4 && r.height > 4 && r.bottom > 0 && r.top < innerHeight;
  }
  function clickOnce(el, tag) {
    if (!el || el.getAttribute('data-sy-clicked') === tag) return false;
    el.setAttribute('data-sy-clicked', tag);
    try { el.click(); } catch (e) { return false; }
    return true;
  }
  var LEGAL = /协议|隐私|条款|政策|同意/;
  try {
    var closers = document.querySelectorAll('[class*=close],[class*=Close],[aria-label=关闭]');
    for (var i = 0; i < closers.length; i++) {
      var c = closers[i];
      if (!visible(c)) continue;
      var host = c.closest('[class*=popup],[class*=dialog],[class*=modal],[class*=layer],[class*=mask],[class*=banner]');
      if (!host) continue;
      /* 协议弹层：X 是「不同意」。跳过，等用户自己点「同意并继续」 */
      if (LEGAL.test(host.textContent || '')) continue;
      clickOnce(c, 'close');
    }
  } catch (e) {}
})();
"""

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
  /** 登录框已经弹出来了？入口再点一次，有些站是 toggle，会把框关掉 */
  function dialogOpen() {
    var d = document.querySelector('.login, [class*=login_dialog], [class*=loginDialog]');
    if (!d) return false;
    var r = d.getBoundingClientRect();
    return r.width > 120 && r.height > 120;
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
      if (!visible(el)) continue;
      var t = textOf(el);
      if (TEXTS.indexOf(t) < 0) continue;
      /*
       * 以前这里要求 `children.length === 0`（只认叶子节点）。
       * 酷我的登录入口是 `<div class="reg_text"><span>登录</span> / <span>注册</span></div>`，
       * 三个子节点 → 永远挑不中 → 页面停在首页、登录框压根没弹出来，
       * 用户看到的就是「酷我登录不了」。
       *
       * 现在放宽到「文字完全相等」的**最内层**那个：只要某个子元素的文字和它一模一样，
       * 说明还有更精确的目标，跳过它；否则就认它（div 上的 click 事件照样是它自己）。
       */
      var inner = false;
      for (var q = 0; q < el.children.length; q++) {
        if (textOf(el.children[q]) === t) { inner = true; break; }
      }
      if (inner) continue;
      /*
       * 有限重试，不是「点一次就永远算点过」。
       *
       * 第一轮轮询（约 900ms）常常比页面绑 click 处理器还早：那一下是空点，
       * 但旧写法已经把 `data-sy-clicked` 打上了，之后永远不再点——酷我的登录框
       * 就是这么一直弹不出来的。这里改成记次数（最多 4 次，约 3.6 秒），
       * 每轮点一次；登录框一出来就收手（再点可能是 toggle，会把框关掉）。
       */
      if (dialogOpen()) return;
      var n = parseInt(el.getAttribute('data-sy-login') || '0', 10);
      if (n >= 4) continue;
      el.setAttribute('data-sy-login', String(n + 1));
      try { el.click(); } catch (e) {}
      return;
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

/**
 * QQ 音乐授权页的**布局**修正（不碰任何登录逻辑）。
 *
 * `graph.qq.com/oauth2.0/show?which=Login` 是给 688px 桌面宽度写的：
 * 塞进 393dp 的屏幕后授权区被 `margin-left:130px` 推到右边、文字被裁。
 * 页面自带 `vertical` 竖排模式，但它只在**页面脚本执行时**按视口宽度判断一次，
 * 我们注入得比它晚，所以要手动补上。
 */
private const val TX_FIT_JS = """
(function () {
  try {
    var cp = document.getElementById('combine_page');
    if (cp && cp.className.indexOf('vertical') < 0) cp.className += ' vertical';
    var top = document.getElementById('lay_top');
    if (top) top.style.display = 'none';
  } catch (e) {}
})();
"""

/**
 * QQ 音乐授权页：替用户点那颗**不存在的**「同意」按钮。
 *
 * 授权区 DOM 里没有任何提交元素（真机 + 桌面视口都验过），提交靠外部
 * `qlogin_v2.js` 挂上来的 `Q.agree()`。**这一段绝不能由页面侧自动触发**：
 * 授权勾选框在扫码之前就渲染好了，页面侧任何「看见授权区就点」的逻辑
 * 都会在用户还没扫码时提交 → 服务器弹回登录页 → 再点 → 再弹，
 * 页面无限重载（用户看到的就是「一打开就闪」）。
 * 由 Kotlin 侧确认 `p_skey` 已出现（等于用户已在 QQ 里点过「确认登录」）
 * 之后才注入这一段，见 [maybeAutoAgree]。
 */
private const val TX_AGREE_JS = """
(function () {
  try {
    if (window.__syAgreed) return;
    var items = document.getElementsByName('api_choose');
    if (!items || items.length === 0) return;
    var f = (window.Q && window.Q.agree) || window.agree;
    if (typeof f !== 'function') return;
    /* 内联桩只有几十个字符；完整版靠它提交，短的就是还没加载好 */
    if (f.toString().length < 500) return;
    window.__syAgreed = true;
    window.disabled = false;
    f();
  } catch (e) {}
})();
"""

