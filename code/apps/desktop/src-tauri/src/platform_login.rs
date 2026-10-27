//! 平台账号登录：**内嵌官方登录页，从 WebView2 的 cookie 里取凭证**。
//!
//! 为什么不用「扫码接口 + 自己画二维码」：
//!   · 二维码要自己编码（Reed-Solomon / 掩码 / 版本表），错一处就是「扫不出来」，
//!     而这类 bug 在开发机上根本看不出来；
//!   · 各家登录流程不一样（QQ / 酷狗是微信或 QQ 互联的 iframe，酷我要短信），
//!     自己实现意味着一家一套私有接口，平台一改就全废。
//!
//! 走官方页面就绕开了这一切：用户在**官方页面**上扫码 / 输密码，我们只做一件事——
//! 轮询这个 webview 的 cookie，看到目标凭证就把它取出来存进设置。密码、验证码、
//! 二次验证都在网易云自己的页面里，我们既拿不到也不需要。
//!
//! 两个平台无关的坑记在这里：
//!   · `WebviewWindowBuilder::build()` **不能在主线程**调用（会等 WebView2 初始化死锁），
//!     所以整段建窗 + 轮询都放在 std::thread 里；
//!   · 读 cookie 在 Windows 上同样不能在同步命令 / 事件回调里做
//!     （wry #583，WebView2 的 CookieManager 要主线程泵消息才能回），
//!     用独立线程 + `cookies_for_url` 才不会把界面卡住。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindowBuilder};

use crate::{append_log, browser_args};

/// 一个平台的登录窗配置。
///
/// `cookie_url` 不是「登录页地址」，而是**用来查 cookie 的那个 URL**：
/// WebView2 按 scheme + domain + path 匹配，所以给站点根地址最准。
pub struct LoginSpec {
    /// 登录页（官方页面）
    pub url: &'static str,
    /// 查 cookie 用的 URL（站点根）
    pub cookie_url: &'static str,
    /// 登录凭证的候选 cookie 名，命中**任意一个**且值相对「打开时」变了就算登录成功。
    ///
    /// 为什么是「变了」而不是「存在」：酷狗 / 酷我未登录也会写 `token` / `userid`
    /// 这类游客 cookie，只判存在会在窗口打开的一瞬间就误判成功。
    pub keys: &'static [&'static str],
    pub title: &'static str,
    pub size: (f64, f64),
}

pub fn spec(source: &str) -> Option<LoginSpec> {
    Some(match source {
        // 网易云：MUSIC_U 是登录态主凭证（httpOnly），未登录时压根不存在
        "wy" => LoginSpec {
            url: "https://music.163.com/login?targetUrl=%2F",
            cookie_url: "https://music.163.com/",
            keys: &["MUSIC_U"],
            title: "疏音 · 登录网易云音乐",
            // 站点是桌面布局（min-width 近千像素），窗口太窄会横着出滚动条
            size: (960.0, 720.0),
        },
        // QQ 音乐：登录弹窗在 y.qq.com 自己那层，凭证落在 .y.qq.com（qqmusic_key）
        //
        // 窗口尺寸按「一张登录卡片」给：QQ 的扫码卡片约 860×580，
        // 窗口比它略大一圈——看起来就是一张卡片，而不是一个网页。
        "tx" => LoginSpec {
            url: "https://y.qq.com/",
            cookie_url: "https://y.qq.com/",
            keys: &["qqmusic_key", "qm_keyst"],
            title: "疏音 · 登录 QQ 音乐",
            size: (900.0, 660.0),
        },
        // 酷狗：`KuGoo` 是登录后才有的一整串（含 uid / token），游客态没有
        "kg" => LoginSpec {
            url: "https://www.kugou.com/",
            cookie_url: "https://www.kugou.com/",
            keys: &["KuGoo", "kg_login", "KugouToken"],
            title: "疏音 · 登录酷狗音乐",
            size: (940.0, 680.0),
        },
        // 酷我：`kw_token` 游客态也可能有，所以同样靠「值变了」这条判据
        "kw" => LoginSpec {
            url: "https://www.kuwo.cn/",
            cookie_url: "https://www.kuwo.cn/",
            keys: &["kw_token", "userid", "token"],
            title: "疏音 · 登录酷我音乐",
            size: (940.0, 680.0),
        },
        _ => return None,
    })
}

/// 「点一下登录」的钩子。
///
/// 四家的登录框都是**点出来的**，不是 URL 出来的：`/login` 这类地址会被站点
/// 重定向回单页首页，页面上只有一个「登录」链接 / 按钮，点它才弹出扫码框。
/// 所以这里注入一小段脚本，等这个按钮出现就点一下。
///
/// 为什么不是「建窗时 eval 一次」：页面会再导航一次，注入的脚本跟着没了。
/// 所以每轮轮询都补一次，靠 `__syLoginHooked` 保证同一个文档里只点一次。
///
/// 为什么遍历所有标签而不是只找 `<a>`：QQ 音乐 / 酷狗 / 酷我的登录入口是
/// `div` / `span` 加 click 事件，只找 `<a>` 会一个都点不到。只认**叶子节点** +
/// 文本完全相等，避免把「登录后可同步」这种整块容器点掉。
const HOOK_JS: &str = r#"(function () {
  if (window.__syLoginHooked) return;
  window.__syLoginHooked = true;

  /* 窗口比页面小，留着滚动条就是「一个网页」的样子，得藏掉。
     注意必须**在页面加载完之后**再挂：脚本第一次 eval 时文档可能还是
     about:blank，那时插的 <style> 会随导航一起消失（实测酷狗/酷我的
     滚动条就是这么漏出来的）。所以这里挂一次，选卡成功时再挂一次。 */
  window.__syKillScroll = function () {
    try {
      if (document.getElementById('__sy_noscroll')) return;
      var st = document.createElement('style');
      st.id = '__sy_noscroll';
      st.textContent =
        'html,body{overflow:hidden!important}' +
        '*{scrollbar-width:none!important;-ms-overflow-style:none!important}' +
        '*::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}';
      (document.head || document.documentElement).appendChild(st);
      document.documentElement.style.setProperty('overflow', 'hidden', 'important');
      if (document.body) document.body.style.setProperty('overflow', 'hidden', 'important');
    } catch (e) {}
  };
  window.__syKillScroll();

  /* 此刻已经在 DOM 里的登录弹层，不可能是「用户点出来的那张卡片」。
     酷我 / QQ 这类单页应用把登录弹层预先写好在 DOM 里（display:none），
     不打标记的话「新弹层」和「老占位」分不出来。 */
  try {
    [].slice.call(document.querySelectorAll(
      '[class*=login],[class*=Login],[class*=dialog],[class*=Dialog],[class*=modal],[class*=popup]'
    )).forEach(function (el) { el.setAttribute('data-sy-old', '1') });
  } catch (e) {}

  var TEXT = ['登录', '登陆', '立即登录', '登录/注册', '登录 / 注册', '登录/註冊'];
  var tries = 0;
  var iv = setInterval(function () {
    tries++;
    if (tries > 80) { clearInterval(iv); return; }
    var all = document.querySelectorAll('a,button,span,div,[role="button"]');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.children && el.children.length) continue;
      var t = (el.textContent || '').trim();
      if (!t || t.length > 8 || TEXT.indexOf(t) < 0) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      el.click();
      window.__syClicked = 1;
      clearInterval(iv);
      return;
    }
  }, 500);
})();

/* ------------------------------------------------------------------ *
 * 只留登录卡片。
 *
 * 用户的原话是「只要二维码，不要页面」。四家里只有网易云给外部二维码
 * 接口（酷狗 20006 参数错误、酷我要 csrf、QQ 的码在跨域 iframe 里），
 * 剩下三家的办法只有一个：等它们自己把登录框弹出来，再把页面主体全藏掉。
 *
 * 找卡片按两级来，**顺序不能反**：
 *
 *   ① **登录弹层优先**——class/id 带 login / dialog / modal / popup 的容器。
 *      这是「用户点出来的那张卡片」本身，四家都有；
 *   ② 图形候补——万一层名不含这些词，退到「视口内最大的方形
 *      canvas/img/svg/iframe」（酷狗的登录框是个 iframe，QQ 也是）。
 *
 * 早先只看 ②「面积最大的方形图形」，在酷我上会翻车：它首页那条轮播横幅
 * 300×220、宽高比 1.37，正好落在方形容差里，于是被当成二维码，
 * 爬上去把整页隐掉、只留一条视口外的横幅——用户看到的就是**一屏全黑**。
 * 所以三个硬条件缺一不可：
 *   · 必须在视口内（横幅在 x=-1800）
 *   · 不能是全屏遮罩（酷我 .reg_login 只是卡片底下的黑幕，不是卡片）
 *   · **一个都找不到就什么都不动**——宁可显示整页，也不能黑屏。
 * ------------------------------------------------------------------ */
(function () {
  if (window.__syFocusing) return;
  window.__syFocusing = true;
  var tries = 0;

  function inView(r) {
    if (r.width < 1 || r.height < 1) return false;
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    return cx > 0 && cy > 0 && cx < window.innerWidth && cy < window.innerHeight;
  }

  function shown(el) {
    var s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0) return false;
    return inView(el.getBoundingClientRect());
  }

  /* 全屏：比视口小不了多少的那一层，是遮罩不是卡片 */
  function fullscreen(r) {
    return r.width >= window.innerWidth * 0.94 && r.height >= window.innerHeight * 0.94;
  }

  var LAYERS = '[class*=login],[id*=login],[class*=Login],[id*=Login],' +
    '[class*=dialog],[id*=dialog],[class*=Dialog],[class*=popup],[class*=modal],[class*=Modal]';

  function layerOf() {
    var all = [].slice.call(document.querySelectorAll(LAYERS)).filter(function (el) {
      var r = el.getBoundingClientRect();
      if (r.width < 240 || r.height < 240) return false;
      if (fullscreen(r)) return false;
      return shown(el);
    });
    if (!all.length) return null;
    // 点之前就在 DOM 里的那批不是我们的目标（酷我 / QQ 的弹层是预置的）
    var fresh = all.filter(function (el) { return !el.hasAttribute('data-sy-old'); });
    var pool = fresh.length ? fresh : all;
    pool.sort(function (a, b) {
      var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return rb.width * rb.height - ra.width * ra.height;
    });
    return pool[0];
  }

  /* 从码往上爬，停在「再往上就铺满视口」的那一层——那就是卡片本身 */
  function cardOf(el) {
    var node = el;
    while (node.parentElement && node.parentElement !== document.body) {
      var p = node.parentElement;
      var r = p.getBoundingClientRect();
      if (r.width >= window.innerWidth * 0.92 || r.height >= window.innerHeight * 0.92) break;
      node = p;
    }
    return node;
  }

  function shapeOf() {
    var cands = [].slice.call(document.querySelectorAll('canvas,img,svg,iframe')).filter(function (el) {
      var r = el.getBoundingClientRect();
      if (r.width < 120 || r.height < 120) return false;
      if (fullscreen(r)) return false;
      var q = r.width / r.height;
      if (q < 0.55 || q > 1.85) return false;
      return shown(el);
    });
    if (!cands.length) return null;
    cands.sort(function (a, b) {
      var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return rb.width * rb.height - ra.width * ra.height;
    });
    return cardOf(cands[0]);
  }

  /* 认出卡片之后怎么「只留它」——用一段注入的 CSS，不是逐个元素写 inline style。
   *
   * 一开始是逐节点设 `visibility:hidden`：酷狗（静态页）很好，到 QQ 音乐就漏。
   * 它是 Vue 应用，登录框弹出来之后页面还在异步渲染，站点会把节点整棵换掉，
   * 我们写在旧节点上的 inline style 跟着旧节点一起消失 → 卡片左右各漏出一条灰带
   * 加一张专辑封面碎片（`elementsFromPoint` 查到那是 `.mod_index--hot`）。
   *
   * 改成注入 `<style>`：它待在 head 里不受重渲染影响，新节点自动套用同一条规则。
   * 规则就两句：
   *   body * { visibility: hidden }              —— 全隐
   *   <卡片>, <卡片> * { visibility: visible }    —— 卡片和它内部全部放出来
   * （CSS 规范：子孙自己写 visible 就能盖过祖先的 hidden，所以不用管祖先那一串）
   */
  function selectorOf(el) {
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return '#' + el.id;
    var cls = (el.className || '').toString().trim().split(/\s+/).filter(function (c) {
      return c && /^[A-Za-z_][\w-]*$/.test(c);
    });
    if (cls.length) return '.' + cls.join('.');
    return null;
  }

  /* 没有 id 也没有可用的 class（少见）：退回逐节点 inline，至少能挡住一批 */
  function isolateInline(card) {
    var node = card;
    while (node && node !== document.body) {
      var parent = node.parentElement;
      if (!parent) break;
      [].slice.call(parent.children).forEach(function (el) {
        if (el === node) return;
        if (/^(SCRIPT|STYLE|LINK|META)$/.test(el.tagName)) return;
        el.style.setProperty('visibility', 'hidden', 'important');
      });
      node = parent;
    }
    var keep = card;
    while (keep) {
      keep.style.setProperty('visibility', 'visible', 'important');
      if (keep === document.body) break;
      keep = keep.parentElement;
    }
  }

  function paint(card) {
    var sel = selectorOf(card);
    if (!sel) { isolateInline(card); window.__syFocused = 1; return; }
    var css =
      'html,body{background:#0b0d11!important;overflow:hidden!important}' +
      '*{scrollbar-width:none!important;-ms-overflow-style:none!important}' +
      '*::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}' +
      'body *{visibility:hidden!important}' +
      sel + ',' + sel + ' *{visibility:visible!important}';
    var st = document.getElementById('__sy_iso');
    if (!st) {
      st = document.createElement('style');
      st.id = '__sy_iso';
      (document.head || document.documentElement).appendChild(st);
    }
    if (st.textContent !== css) st.textContent = css;
    window.__syFocused = 1;
  }

  /*
   * 每 600ms 重算一次。两个要点：
   *
   * ① **先把自己上一轮注入的规则撤掉再算**。规则一旦生效，页面除了那张卡片全是
   *    `visibility:hidden`，`shown()` 自然只认卡片那棵子树——第一轮要是抢跑选错了
   *   （弹层还没渲染出来时 `shapeOf()` 会选中页面里的广告图），后面每轮都在自己
   *   造的假象里选，规则就锁死在那块上，真正的登录卡片永远出不来。
   *   撤掉 → 算 → 重新插入，全在同一个同步 tick 里，浏览器不会绘制中间态。
   * ② 这轮没找到（站点正在跳转/动画中间态）就把上一轮规则放回去，别把页面放开。
   */
  function tick() {
    if (!window.__syClicked) return;
    var st = document.getElementById('__sy_iso');
    var prev = st ? st.textContent : '';
    if (st) st.remove();
    var card = layerOf() || shapeOf();
    if (!card) {
      if (prev) {
        var back = document.createElement('style');
        back.id = '__sy_iso';
        back.textContent = prev;
        (document.head || document.documentElement).appendChild(back);
      }
      return;
    }
    paint(card);
  }

  /* 跑 600 次 = 6 分钟，覆盖整个扫码过程（一轮三次 `querySelectorAll`，忽略不计） */
  var iv = setInterval(function () {
    tries++;
    if (tries > 600) { clearInterval(iv); return; }
    try { tick(); } catch (e) {}
  }, 600);
})();"#;

/// 拍一张 cookie 快照（名字 → 值），用来判断「哪些 cookie 是登录之后才变的」
fn snapshot(win: &tauri::WebviewWindow, url: &Url) -> Vec<(String, String)> {
    match win.cookies_for_url(url.clone()) {
        Ok(list) => list
            .into_iter()
            .filter(|c| !c.value().is_empty())
            .map(|c| (c.name().to_string(), c.value().to_string()))
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// 打开某平台的登录窗。**立刻返回**，结果通过 `platform://login` 事件回来：
///   · `{ source, ok: true, cookie }` —— 登录成功，cookie 已可用来请求接口
///   · `{ source, ok: false, error? }` —— 用户关掉了窗口 / 建窗失败
pub fn open(app: &AppHandle, source: &str) -> Result<(), String> {
    let Some(spec) = spec(source) else {
        return Err(format!("{source} 暂不支持账号登录"));
    };
    let label = format!("login-{source}");

    // 已经开着：把窗口叫回前台，别开第二个（登录页也不希望被重复打开）
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return Ok(());
    }

    let app2 = app.clone();
    let src = source.to_string();
    std::thread::spawn(move || {
        if let Err(e) = run(&app2, &src, &label, &spec) {
            append_log(&app2, &format!("login.fail {src}: {e}"));
            let _ = app2.emit("platform://login", json!({ "source": src, "ok": false, "error": e }));
        }
    });
    Ok(())
}

fn run(app: &AppHandle, source: &str, label: &str, spec: &LoginSpec) -> Result<(), String> {
    let url = Url::parse(spec.url).map_err(|e| format!("登录页地址不合法：{e}"))?;
    append_log(app, &format!("login.build {source}"));

    let win = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title(spec.title)
        .inner_size(spec.size.0, spec.size.1)
        .min_inner_size(360.0, 480.0)
        .center()
        .resizable(true)
        .additional_browser_args(browser_args())
        .build()
        .map_err(|e| format!("创建登录窗口失败：{e}"))?;
    append_log(app, &format!("login.build ok {source}"));

    /*
     * 窗口被关掉的信号。
     *
     * 只靠 `get_webview_window().is_none()` 不够：页面自己调 `window.close()`
     * （或者 WebView2 内部把 webview 销毁了）时，Tauri 那边的窗口对象还在，
     * 于是这个循环会一直转下去——前端 `pending` 永远不清，用户之后再点任何平台
     * 都会得到「已经有一个登录窗口在等着了」。
     */
    let gone = Arc::new(AtomicBool::new(false));
    {
        let gone = gone.clone();
        win.on_window_event(move |e| {
            if matches!(
                e,
                tauri::WindowEvent::Destroyed | tauri::WindowEvent::CloseRequested { .. }
            ) {
                gone.store(true, Ordering::Relaxed);
            }
        });
    }

    let probe = Url::parse(spec.cookie_url).map_err(|e| format!("cookieUrl 不合法：{e}"))?;

    // 钩子内部自己 setInterval，这里先挂一次（页面换文档后要重挂，见下面每轮补一次）
    let _ = win.eval(HOOK_JS);

    /*
     * 等页面把**游客** cookie 写完，再拍「登录前」快照。
     *
     * 少了这 3 秒，酷狗 / 酷我的游客 `token` 会在快照之后才写进来，
     * 于是「目标 cookie 出现了」被当成「用户刚登录」，窗口开一秒就自己关掉。
     */
    std::thread::sleep(Duration::from_millis(3000));
    let before = snapshot(&win, &probe);
    append_log(app, &format!("login.ready {source} ({} cookies)", before.len()));

    // 轮询间隔 700ms：即时感够（扫码后 1 秒内就回来），又不至于把 CookieManager 打满
    let mut logged_err = false;
    // 连续读不到 cookie 的次数：读不到 = webview 已经没了，别在这里空转
    let mut fails = 0u32;
    /*
     * 轮次计数 + 补钩子的节奏。
     *
     * **eval 必须在确认 webview 还活着之后再做**：对已销毁的 webview 调 eval，
     * tauri-runtime-wry 内部的消息通道会 `unwrap()` 失败——那是进程级 panic
     * （实测酷狗就是这么挂的）。所以顺序是「先读 cookie（探活）→ 再 eval」，
     * 而且只在读得到 cookie 的那些轮次里补。
     */
    let mut rounds = 0u32;
    loop {
        std::thread::sleep(Duration::from_millis(700));

        // 窗口没了 = 用户自己关掉了（或者已经登录成功、下面 close 过）
        if gone.load(Ordering::Relaxed) || app.get_webview_window(label).is_none() {
            append_log(app, &format!("login.cancel {source}"));
            let _ = app.emit("platform://login", json!({ "source": source, "ok": false, "cancel": true }));
            return Ok(());
        }

        let cookies = match win.cookies_for_url(probe.clone()) {
            Ok(c) => {
                fails = 0;
                c
            }
            Err(e) => {
                if !logged_err {
                    logged_err = true;
                    append_log(app, &format!("login.cookie err {source}: {e}"));
                }
                fails += 1;
                // 连续 6 次（约 4 秒）都读不到：webview 已经废了，当作用户关窗收尾，
                // 否则前端那个 pending 永远清不掉
                if fails >= 6 {
                    append_log(app, &format!("login.dead {source}"));
                    let _ = win.close();
                    let _ = app.emit("platform://login", json!({ "source": source, "ok": false, "cancel": true }));
                    return Ok(());
                }
                continue;
            }
        };

        /*
         * 补钩子（点「登录」+ 只留登录卡片）。前 3 轮每轮一次 —— 页面刚加载，
         * 钩子要尽早挂上；之后每 4 轮一次，覆盖「页面慢、后面才渲染出登录框」
         * 和「二次导航把脚本清掉」这两种情况。
         */
        if rounds < 3 || rounds % 4 == 0 {
            let _ = win.eval(HOOK_JS);
        }
        rounds += 1;

        /*
         * 判据：候选凭证 cookie 里**任意一个**的值相对打开窗口时变了。
         * 只判「存在」不够——酷狗 / 酷我未登录也有 token / userid，
         * 那会让窗口在用户还没扫码的时候就断定成功。
         */
        let hit = cookies.iter().any(|c| {
            let name = c.name();
            if c.value().is_empty() || !spec.keys.contains(&name) {
                return false;
            }
            match before.iter().find(|(n, _)| n == name) {
                None => true,
                Some((_, v)) => v != c.value(),
            }
        });
        if !hit {
            continue;
        }

        // 整个站点的 cookie 一起带走：接口除了主凭证，还要 __csrf / NMTID 这些东西
        let cookie = cookies
            .iter()
            .filter(|c| !c.value().is_empty())
            .map(|c| format!("{}={}", c.name(), c.value()))
            .collect::<Vec<_>>()
            .join("; ");
        let _ = win.close();
        append_log(app, &format!("login.ok {source} ({} chars)", cookie.len()));
        let _ = app.emit("platform://login", json!({ "source": source, "ok": true, "cookie": cookie }));
        return Ok(());
    }
}
