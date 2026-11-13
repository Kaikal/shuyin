package cn.shuyin.player

import android.content.Intent
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * 前端 ↔ 原生 的命令桥。
 *
 * 设计要点：**命令名与返回形状照抄桌面端 Rust 的那套**（`src-tauri/src/lib.rs`）。
 * 前端 `src/lib/bridge.ts` 里的 `invoke(cmd, args)` 在安卓上原地换成这里，
 * 于是 30 个组件、9 个页面、整套在线取链逻辑一行都不用改——
 * 这是「复用桌面 UI」这条路能成立的全部秘密。
 *
 * 线程模型：WebView 的 JS 桥线程只负责转发，真正的活在固定线程池里做；
 * 结果统一回到 WebView 线程用 `evaluateJavascript` 回调，
 * 避免大列表（几千首）在主线程序列化时卡住界面。
 */
class Bridge(private val web: WebView) {

    /**
     * 命令线程池。
     *
     * 原来是 4 条。真正的瓶颈在**连点「下一首」**：每一次切歌都会并发发起
     * 「本平台各档取链 + 跨平台搜索 + 直链探活」十几二十个请求，全都排在这 4 条线程后面。
     * 前端给搜索留的超时是 5 秒，排队排过 5 秒就直接判失败，最后报出来的却是
     * 「这首歌的搜索信息已过期」——用户看到的就是「快速切歌会播放失败」。
     *
     * 抬到 12 条：这些任务几乎全是网络等待（HttpURLConnection 阻塞在 IO 上），
     * 线程本身不占 CPU，真正会并发的是几十个 socket——那是正常的。
     * 同时前端那边也加了「连点合并」（见 PlayerProvider startLoad 的 RAPID_LOAD），
     * 两边一起把请求峰值压下来。
     */
    private val pool = Executors.newFixedThreadPool(12) { r ->
        Thread(r, "shuyin-bridge").apply { isDaemon = true }
    }

    /** 下载进度表：dest → [已写, 总量] */
    private val dl = ConcurrentHashMap<String, LongArray>()

    init {
        PlaybackService.emit = { name, json -> emit(name, json) }
    }

    /* ---------------- 与 JS 的协议 ---------------- */

    @JavascriptInterface
    fun appInfo(): String = JSONObject().apply {
        put("platform", "android")
        put("car", Sy.isCar)
        put("sdk", android.os.Build.VERSION.SDK_INT)
        put("device", android.os.Build.MODEL)
        put("downloads", Sy.downloads.absolutePath)
    }.toString()

    /**
     * 异步调用。`id` 由前端生成，完成后回调 `window.__syNative(id, ok, base64(json))`。
     * 用 base64 传 payload：曲目列表里全是中文与引号，直接拼进 JS 字符串会碎。
     */
    @JavascriptInterface
    fun call(id: String, cmd: String, argsJson: String) {
        val args = try {
            if (argsJson.isBlank()) JSONObject() else JSONObject(argsJson)
        } catch (_: Exception) {
            JSONObject()
        }
        pool.execute {
            try {
                val out = dispatch(cmd, args)
                reply(id, true, encode(out))
            } catch (e: Throwable) {
                // 错误也要按 JSON 编码：前端会把它 JSON.parse 出来当提示文案
                reply(id, false, JSONObject.quote(e.message ?: e.toString()))
            }
        }
    }

    private fun reply(id: String, ok: Boolean, payload: String) {
        val b64 = Base64.encodeToString(payload.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
        web.post {
            val js = "window.__syNative&&window.__syNative('$id',$ok,'$b64')"
            try { web.evaluateJavascript(js, null) } catch (_: Exception) {}
        }
    }

    /**
     * 把命令结果编码成**合法 JSON 文本**再回给 JS。
     *
     * 这里必须区分类型：JSONObject / JSONArray / 数字 / 布尔 的 toString() 本身就是
     * 合法 JSON，但**裸字符串不是**——`sources_default_dir` 回的是个路径，
     * 直接 toString() 得到 `/data/user/0/.../sources`，前端 JSON.parse 一抛，
     * 整条命令就变成 null：音源目录显示「—」、缓存永远不命中、
     * 导入音源拿不到名字。这些症状看着毫不相干，根因是同一行。
     */
    private fun encode(v: Any?): String = when (v) {
        null -> "null"
        is String -> JSONObject.quote(v)
        is JSONObject, is JSONArray -> v.toString()
        else -> v.toString()
    }

    /** 原生主动推事件（播放状态、媒体键） */
    fun emit(name: String, json: String) {
        val b64 = Base64.encodeToString(json.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
        web.post {
            val js = "window.__syNativeEvent&&window.__syNativeEvent('$name','$b64')"
            try { web.evaluateJavascript(js, null) } catch (_: Exception) {}
        }
    }

    /* ---------------- 命令分发 ---------------- */

    private fun dispatch(cmd: String, a: JSONObject): Any? = when (cmd) {
        /* ---- 曲库 ---- */
        "scan_music" -> Library.scan(a.optBoolean("incremental", false))
        "get_tracks" -> JSONArray(Library.tracks())
        "get_track_count" -> Library.count()
        "get_lyrics" -> JSONObject().put("source", "none").put("text", "")
        "remove_track" -> null // 曲库就是系统媒体库，删条目没有意义（下次扫描又回来）
        "pick_music_folder" -> null

        /* ---- 播放 ---- */
        "play_file" -> {
            send(
                PlaybackService.ACT_PLAY_FILE,
                "path" to (a.optString("path")),
                "index" to a.optInt("index", -1),
                "startAt" to a.optDouble("startAt", 0.0),
                "autoplay" to a.optBoolean("autoplay", true),
            )
            null
        }
        "play_url" -> {
            send(
                PlaybackService.ACT_PLAY_URL,
                "url" to (a.optString("url")),
                "index" to a.optInt("index", -1),
                "durationHint" to a.optDouble("durationHint", 0.0),
                "startAt" to a.optDouble("startAt", 0.0),
                "autoplay" to a.optBoolean("autoplay", true),
            )
            null
        }
        "pause" -> { send(PlaybackService.ACT_PAUSE); null }
        "resume" -> { send(PlaybackService.ACT_RESUME); null }
        "stop" -> { send(PlaybackService.ACT_STOP); null }
        "seek" -> { send(PlaybackService.ACT_SEEK, "secs" to a.optDouble("positionSecs", 0.0)); null }
        "set_volume" -> {
            send(PlaybackService.ACT_VOLUME, "volume" to a.optDouble("volume", 1.0).toFloat())
            null
        }
        "player_state" -> PlaybackService.snapshot
        /*
         * 频谱：40 段，0..1。
         *
         * 数据来自 ExoPlayer 音频处理链上旁路出来的 PCM（TapAudioProcessor），
         * **不需要任何权限**——这也是换掉 MediaPlayer 的唯一理由。
         * 没有播放器时回 40 个 0，前端画成一条平线，而不是因为空数组报错。
         */
        "spectrum" -> JSONArray().apply {
            val v = PlaybackService.instance?.spectrumSnapshot()
                ?: FloatArray(PlaybackService.BANDS)
            for (x in v) put(x.toDouble())
        }

        /*
         * 兼容垫片：这两个命令是「频谱要录音权限」时代的产物，现在没用了。
         *
         * 保留是因为前端（SpectrumSheet / android.ts）还在读它来判断要不要显示
         * 「开启录音权限」那行提示——恒回 granted 就等于「一切正常」，
         * 那行提示自然不出现。真正该删的入口是 request_audio_permission，
         * 已经删了：前端再调会走 catch，什么都不会发生。
         */
        "spectrum_permission" -> "granted"
        /** 跳本应用系统设置页（还有别的权限引导在用） */
        "open_permission_settings" -> {
            web.post { MainActivity.inst?.openAppPermissionSettings() }
            null
        }
        /*
         * 音效：五段均衡 + 前置增益 + 声道平衡，参数直接写进音频处理器
         * （`FxAudioProcessor`）。
         *
         * **不用走 PlaybackService 的 intent**：处理器是全局单例，正在放的歌
         * 下一块 PCM 就生效；没在放歌时也存着，下一首建引擎时读到。
         * 前端存了自己的副本，重启应用后挂载时会重发一次。
         */
        "set_fx" -> {
            val arr = a.optJSONArray("bands")
            val bands = FloatArray(5)
            if (arr != null) {
                for (i in 0 until minOf(5, arr.length())) {
                    bands[i] = arr.optDouble(i, 0.0).toFloat()
                }
            }
            FxAudioProcessor.set(
                bands,
                a.optDouble("pre", 0.0).toFloat(),
                a.optDouble("balance", 0.0).toFloat(),
                a.optInt("space", 0),
            )
            null
        }
        /*
         * 「下一首预告」：前端把接下来几首的直链先递过来。
         *
         * 息屏后 WebView 的任务会被系统摁住，自动下一首那条「等前端来拉」的链路
         * 就断了（放完停在两首之间，亮屏才接上）。递过来之后原生放完自己接，
         * 整段不经过 JS。返回 null 就够了，前端不等结果。
         */
        "next_prefetch" -> {
            PlaybackService.instance?.setPrefetch(a.optJSONArray("items") ?: org.json.JSONArray())
            null
        }
        "smtc_update" -> {
            // cover / fav 是安卓通知用的：大图修 MIUI 空白卡片，fav 让那颗心跟着亮/灭
            send(
                PlaybackService.ACT_META,
                "title" to a.optString("title"),
                "artist" to a.optString("artist"),
                "album" to a.optString("album"),
                "cover" to a.optString("cover"),
                "fav" to a.optBoolean("fav", false),
            )
            null
        }

        /* ---- 悬浮歌词（其他应用上层）---- */
        // 当前句 / 下一句 / 本句进度 / 行序奇偶：窗口没开时原生只存不发
        "float_lyric" -> {
            /* 锁屏页铺多行用的 ±2 上下文（固定 5 条，中间那条是当前句） */
            val around = ArrayList<String>(NowPlaying.AROUND_N)
            a.optJSONArray("around")?.let { arr ->
                for (i in 0 until arr.length()) around.add(arr.optString(i, ""))
            }
            FloatingLyrics.setLines(
                a.optString("cur"),
                a.optString("next"),
                a.optDouble("prog", 0.0).toFloat(),
                a.optBoolean("flip", false),
                a.optBoolean("playing", false),
                a.optString("title"),
                around,
            )
            null
        }
        // 开/关（未授权时会跳系统设置页）。返回「切完之后」的开关态，
        // 前端面板照它显示——别返回 toggle 之前那份（见 FloatingLyrics.toggleState）
        "float_lyric_toggle" -> FloatingLyrics.toggleState(Sy.app)
        // 只读当前状态：面板每次打开都对一次，别拿一份可能过期的本地开关
        "float_lyric_state" -> FloatingLyrics.stateJson()

        /* ---- 锁屏播放页 ---- */
        // 立刻打开一次（手动预览；不点亮屏幕，也不会因为开关一变就自己跳过去）
        "lock_show" -> { LockScreenActivity.preview(Sy.app); null }
        // 开关态 + 是不是小米 + 小米那边「锁屏显示」放不放行（设置页拿它决定要不要提示）
        "lock_state" -> LockScreenActivity.stateJson(Sy.app)
        "lock_toggle" -> {
            val on = !LockScreenActivity.enabled(Sy.app)
            LockScreenActivity.setEnabled(Sy.app, on)
            LockScreenActivity.stateJson(Sy.app)
        }
        // 打开系统里「锁屏显示」那一页（小米的权限编辑器）
        "lock_perm_open" -> JSONObject().put("ok", LockScreenActivity.openPermissionEditor(Sy.app))

        /* ---- 播放页全屏化：隐藏 / 恢复系统栏 ---- */
        // 前端进播放页时 hide=true，退出时 hide=false；隐藏后安全区重算（top→0），
        // 页头自然顶到屏幕最上沿——「顶部空着一截」就是状态栏 + 给它让的安全区
        "sysbars" -> { (web.context as? MainActivity)?.setSystemBarsHidden(a.optBoolean("hide", false)); null }

        /* ---- 出网 ---- */
        "net_request" -> {
            val req = a.optJSONObject("req") ?: JSONObject()
            val headers = HashMap<String, String>()
            req.optJSONObject("headers")?.let { h ->
                for (k in h.keys()) headers[k] = h.optString(k)
            }
            Http.request(
                url = req.optString("url"),
                method = req.optString("method", "GET"),
                headers = headers,
                body = if (req.has("body") && !req.isNull("body")) req.optString("body") else null,
                timeoutMs = req.optInt("timeout", 10_000),
                // 文件上传是 multipart 字节，不能走上面的文本字段（见 Http.request 的注释）
                bodyB64 = if (req.has("bodyB64") && !req.isNull("bodyB64")) req.optString("bodyB64") else null,
                wantBytes = req.optBoolean("wantBytes", false),
            )
        }
        "probe_audio_url" -> Http.probe(a.optString("url"))
        "local_audio_duration" -> Library.duration(a.optString("path"))

        /* ---- 版本 / 外链（更新弹窗用，和桌面端 check_update / open_url 对齐）---- */
        "app_version" -> BuildConfig.VERSION_NAME
        "open_url" -> {
            val u = a.optString("url")
            if (!u.startsWith("http://") && !u.startsWith("https://")) {
                throw IllegalArgumentException("只支持 http/https 链接")
            }
            val it = Intent(Intent.ACTION_VIEW, android.net.Uri.parse(u))
            it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            Sy.app.startActivity(it)
            null
        }

        /*
         * 应用内更新：下 APK + 拉起系统安装器（见 UpdateApk）。
         *
         * 进度走事件 `app://update-dl`（{pct,got,total}），不走返回值——
         * 一次下载要推几十次，没有哪个调用方能等；返回值只报最终结果
         * `{status:"installed"|"need_perm", path}`。
         */
        "update_download" -> {
            val urls = ArrayList<String>()
            a.optJSONArray("urls")?.let { arr ->
                for (i in 0 until arr.length()) urls.add(arr.optString(i))
            }
            /* 兼容单地址调用，省得以后改前端还要动这里 */
            if (urls.isEmpty()) urls.add(a.optString("url"))
            UpdateApk.downloadAndInstall(urls, a.optString("name", "shuyin-update.apk")) { p ->
                emit("app://update-dl", p.toString())
            }
        }
        /* 从「安装未知应用」设置页回来之后续装（文件还在缓存里） */
        "update_install" -> UpdateApk.installDownloaded(a.optString("path")) { p ->
            emit("app://update-dl", p.toString())
        }

        /*
         * 「在文件夹中显示」：安卓没有等价的公开接口，见 `Paths`。
         * 回 `{ opened, copied, path }` —— 前端按结果给不同提示，
         * 不能像以前那样 `if (!isTauri) return` 静默什么都不做。
         */
        "reveal_path" -> Paths.reveal(a.optString("path"))

        /* ---- 系统分享 ----
         *
         * 前端原来走 `navigator.share`：WebView 里**根本不存在**这个 API，
         * 于是每次都掉到「复制文本」的兜底上，用户点了看不出任何反应
         * （原话：「现在的分享按钮点不了」）。安卓的正解是拉起系统分享面板，
         * 微信 / QQ / 短信都在里面，也不需要我们申请任何权限。
         */
        "share_text" -> {
            val text = a.optString("text")
            if (text.isBlank()) throw IllegalStateException("没有可分享的内容")
            val send = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_TEXT, text)
                val subject = a.optString("title")
                if (subject.isNotBlank()) putExtra(Intent.EXTRA_SUBJECT, subject)
            }
            val chooser = Intent.createChooser(send, a.optString("chooser", "分享到"))
            val latch = java.util.concurrent.CountDownLatch(1)
            var err: String? = null
            web.post {
                try {
                    chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    Sy.app.startActivity(chooser)
                } catch (e: Exception) {
                    err = e.message ?: "打不开分享面板"
                } finally {
                    latch.countDown()
                }
            }
            latch.await(4, java.util.concurrent.TimeUnit.SECONDS)
            err?.let { throw IllegalStateException("分享失败：$it") }
            true
        }

        /* ---- 其他应用「打开方式」送进来的音源脚本 ---- */
        /* 启动时那一次（进程还没起来的 intent）由 MainActivity 存在这里，取走即清空 */
        "take_open_file" -> MainActivity.takePendingOpen()?.let { JSONObject(it) }
        "import_source_staged" -> {
            val path = a.optString("path")
            if (path.isBlank()) throw IllegalStateException("缺少文件")
            Sources.importFile(path, a.optString("name"))
        }

        /* ---- 音源清单 ---- */
        "sources_default_dir" -> Sy.sourcesDir.absolutePath
        "list_source_scripts" -> Sources.list()
        "import_source_text" -> Sources.importText(a.optString("name"), a.optString("code"))
        "import_source_url" -> Sources.importUrl(a.optString("url"), a.optString("name"))
        "import_source_files" -> throw IllegalStateException("安卓端请用「粘贴脚本」或「从链接导入」")
        "delete_source_script" -> { Sources.delete(a.optString("path")); null }

        /* ---- 下载 ----
         *
         * 落点是**公共存储**（`Music/疏音` 或用户自选的文件夹），见 `DownloadStore`。
         * 前端传下来的 `dest` 只用来取文件名 + 当进度表的 key——安卓上
         * 「目录」由原生自己决定（MediaStore / SAF 都没有「随便写一个绝对路径」这回事）。
         */
        "downloads_dir" -> DownloadStore.displayDir()
        /* 目录 + 是不是自选的（前端启动时以原生为准，别被过期的 localStorage 带偏） */
        "downloads_state" -> DownloadStore.stateJson()
        /* 恢复默认：清掉自选的 SAF 授权，回到公共「音乐/疏音」 */
        "downloads_reset_dir" -> {
            DownloadStore.setTree(null)
            DownloadStore.displayDir()
        }
        /* 选目录：拉起系统文件夹选择器，等待用户回来（Binder 线程阻塞，同 pick_playlist_file） */
        "download_pick_dir" -> {
            val latch = java.util.concurrent.CountDownLatch(1)
            val picked = arrayOfNulls<String>(1)
            web.post {
                val act = web.context as? MainActivity
                if (act == null) {
                    latch.countDown()
                } else {
                    act.pickDownloadDir { uri ->
                        picked[0] = uri
                        latch.countDown()
                    }
                }
            }
            /*
             * 用户在系统选择器里翻很久是常事（找目录、建新文件夹、翻两层）。
             * 给 10 分钟；就算这里超时了，MainActivity 那侧也已经把选择存好并推过事件，
             * 界面不会停在旧路径上。
             */
            latch.await(600, java.util.concurrent.TimeUnit.SECONDS)
            val uri = picked[0]
            if (uri != null) DownloadStore.setTree(android.net.Uri.parse(uri))
            DownloadStore.stateJson(cancel = uri == null)
        }
        "download_track" -> {
            val dest = a.optString("dest")
            val url = a.optString("url")
            try {
                /*
                 * 两种 dest，两条路：
                 *   · 绝对路径（以 / 开头）= 播放缓存要的「写到这个文件」，
                 *     直写、不发布——见 DownloadStore.writeTo 里那段说明；
                 *   · 单纯文件名 = 用户点「下载」，按老规矩落进公共音乐目录。
                 *
                 * 以前不区分，缓存的绝对路径被当成文件名发布到了 Music/疏音，
                 * 缓存目录永远是空的（`cache_lookup` 100% miss），
                 * 顺带把用户音乐库塞满 `online_*` 副本。
                 */
                if (dest.startsWith("/")) {
                    DownloadStore.writeTo(url, java.io.File(dest)) { done, total ->
                        dl[dest] = longArrayOf(done, total)
                    }
                } else {
                    DownloadStore.save(url, dest) { done, total ->
                        dl[dest] = longArrayOf(done, total)
                    }
                }
            } finally {
                dl.remove(dest)
            }
        }
        "download_progress" -> {
            val e = dl[a.optString("dest")] ?: throw IllegalStateException("no task")
            JSONArray().put(e[0]).put(e[1])
        }

        /* ---- 播放缓存 ---- */
        "cache_lookup" -> {
            val f = cacheFile(a.optString("key"), a.optString("ext"))
            if (f.exists() && f.length() > 0) f.absolutePath else null
        }
        "cache_slot" -> cacheFile(a.optString("key"), a.optString("ext")).absolutePath
        "cache_drop" -> cacheFile(a.optString("key"), a.optString("ext")).delete()
        "cache_size" -> dirSize(Sy.cacheAudio)
        "cache_clear" -> {
            val before = dirSize(Sy.cacheAudio)
            Sy.cacheAudio.listFiles()?.forEach { it.deleteRecursively() }
            before
        }
        /* 旧版本把缓存副本误发布到了 Music/疏音，见 DownloadStore.purgeCacheCopies */
        "cache_orphans" -> {
            val r = DownloadStore.cacheCopies()
            JSONObject().put("count", r[0]).put("bytes", r[1])
        }
        "cache_orphans_clean" -> {
            val r = DownloadStore.purgeCacheCopies()
            JSONObject().put("count", r[0]).put("bytes", r[1])
        }
        "cache_dir" -> JSONObject().put("dir", Sy.cacheAudio.absolutePath).put("custom", false)
        // 安卓没有「换缓存目录」这个概念（应用私有目录是最优解），按要求返回默认值即可
        "cache_set_dir" -> JSONObject()
            .put("dir", Sy.cacheAudio.absolutePath)
            .put("custom", false)
            .put("moved", 0)
            .put("failed", 0)

        /* ---- 文件（导入歌单 / 配置包 / 歌词导出） ---- */
        "read_text_abs" -> readAnyText(a.optString("path"))
        /* 字节太大会把 JSON 撑爆（还得转义），按 base64 文本回；前端 atob 回字节 */
        "read_bin_abs" -> android.util.Base64.encodeToString(
            readAnyBytes(a.optString("path")), android.util.Base64.NO_WRAP,
        )
        "write_text_abs" -> { File(a.optString("path")).writeText(a.optString("text")); null }
        /* 歌词走「下载/疏音」：分区存储只允许非媒体文件落到 Download，见 DownloadStore.textDir */
        "save_lyrics_file" -> DownloadStore.saveText(a.optString("path"), a.optString("text"))
        "pick_save_file" -> null
        /* SAF 选文件是异步的，命令模型是同步的：挂线程池等 MainActivity 的回调 */
        "pick_playlist_file" -> {
            val latch = java.util.concurrent.CountDownLatch(1)
            val picked = arrayOfNulls<String>(1)
            web.post {
                (web.context as? MainActivity)?.pickPlaylistFile { uri ->
                    picked[0] = uri
                    latch.countDown()
                } ?: latch.countDown()
            }
            latch.await(15, java.util.concurrent.TimeUnit.SECONDS)
            picked[0]
        }

        /* ---- 平台登录：内嵌官方登录页，抓 cookie ---- */
        "platform_login" -> {
            val src = a.optString("source")
            if (src.isBlank()) throw IllegalStateException("缺少平台标识")
            /*
             * `force` = 「别认已存的凭证，让我真登一次」。
             * 前端在「校验失败 / 本来就是重新登录」时会带它；漏传的话登录窗会
             * 带着旧 cookie 秒返回 → 校验又失败 → 用户看到的是「跳一下就弹回来」。
             */
            val force = a.optBoolean("force", false)
            val latch = java.util.concurrent.CountDownLatch(1)
            val out = arrayOfNulls<JSONObject>(1)
            web.post {
                val act = web.context as? MainActivity
                if (act == null) {
                    out[0] = JSONObject().put("ok", false).put("error", "登录窗打不开")
                    latch.countDown()
                } else {
                    act.platformLogin(src, force) { r ->
                        out[0] = r
                        latch.countDown()
                    }
                }
            }
            // 登录要等用户收短信 / 一轮轮点验证码，比选文件久得多：给 31 分钟（窗口自己 30 分钟才超时）
            latch.await(31, java.util.concurrent.TimeUnit.MINUTES)
            out[0]?.toString() ?: JSONObject().put("ok", false).put("error", "登录窗没有返回").toString()
        }

        /* ---- 桌面端专属 / 安卓无对应物：一律安全地当成「什么都不用做」 ---- */
        "show_main", "hide_main", "apply_min_size", "boot_ok",
        "tray_state", "tray_hide", "tray_fit", "tray_action",
        "hotkeys_apply", "hotkeys_clear", "now_meta_set",
        "lyrics_open", "lyrics_close", "lyrics_hide", "lyrics_visible",
        "lyrics_set_locked", "lyrics_is_locked",
        "musicdesk_open", "musicdesk_close", "musicdesk_visible", "musicdesk_set_layer",
        "desk_lock_enter", "desk_lock_exit" -> null

        "diag_log" -> {
            Log.i("Shuyin", a.optString("event") + " :: " + a.optString("detail"))
            null
        }

        else -> throw IllegalStateException("安卓端未实现：$cmd")
    }

    /* ---------------- 小工具 ---------------- */

    private fun cacheFile(key: String, ext: String): File {
        val safe = key.replace(Regex("[^0-9a-zA-Z_\\-]"), "_").ifBlank { "x" }
        val e = ext.trimStart('.').ifBlank { "bin" }
        return File(Sy.cacheAudio, "$safe.$e")
    }

    private fun dirSize(dir: File): Long {
        var n = 0L
        dir.listFiles()?.forEach { f -> n += if (f.isDirectory) dirSize(f) else f.length() }
        return n
    }

    private fun send(action: String, vararg extras: Pair<String, Any>) {
        val i = Intent(Sy.app, PlaybackService::class.java).setAction(action)
        for ((k, v) in extras) {
            when (v) {
                is String -> i.putExtra(k, v)
                is Int -> i.putExtra(k, v)
                is Boolean -> i.putExtra(k, v)
                is Float -> i.putExtra(k, v)
                is Double -> i.putExtra(k, v)
            }
        }
        try {
            /*
             * 停止 → 走普通 startService。
             *
             * `startForegroundService` 要求 5 秒内必须 startForeground，而停止这条路
             * 一进来就 stopForeground + stopSelf，容易被系统判成「没兑现承诺」；
             * 而且清空队列那一刻服务本来就不该再以「前台」身份被拉起来——
             * 被拉起来就会重新挂一张空的通知（MIUI 上就是那块白板）。
             */
            if (action == PlaybackService.ACT_STOP) Sy.app.startService(i)
            else if (android.os.Build.VERSION.SDK_INT >= 26) Sy.app.startForegroundService(i)
            else Sy.app.startService(i)
        } catch (e: Exception) {
            Log.w("Shuyin", "启动播放服务失败：${e.message}")
        }
    }

    /**
     * 下载到指定路径（dest 由前端按「下载目录 + 文件名」拼好）。
     * 单线程顺序写：音乐文件几 MB 到几十 MB，分段并发在手机上收益不大，
     * 反而容易把弱网下的连接数打满。
     */
    /* ---------------- SAF / 混合路径读取 ---------------- */

    /**
     * 读文本：`content://`（SAF 选的）与普通路径都认。
     * 编码顺序 UTF-8 → GB18030，与桌面 Rust 的 read_text_abs 保持一致
     * （大量国产 APP 导出的 txt 是 GBK）。
     */
    private fun readAnyText(p: String): String {
        val bytes = readAnyBytes(p)
        return try { String(bytes, Charsets.UTF_8) }
        catch (_: Exception) { String(bytes, charset("GB18030")) }
    }

    /** 读字节（lxmc 这类 gzip 容器）。超过 16MB 当不是歌单文件拒绝，与桌面一致 */
    private fun readAnyBytes(p: String): ByteArray {
        if (p.startsWith("content://")) {
            val uri = android.net.Uri.parse(p)
            web.context.contentResolver.openInputStream(uri)?.use { input ->
                val out = java.io.ByteArrayOutputStream()
                val buf = ByteArray(64 * 1024)
                var total = 0L
                while (true) {
                    val n = input.read(buf)
                    if (n <= 0) break
                    total += n
                    if (total > 16 * 1024 * 1024) throw IllegalStateException("文件超过 16MB，疑似不是歌单文件")
                    out.write(buf, 0, n)
                }
                return out.toByteArray()
            } ?: throw IllegalStateException("打不开这个文件")
        }
        val f = File(p)
        if (f.length() > 16 * 1024 * 1024) throw IllegalStateException("文件超过 16MB，疑似不是歌单文件")
        return f.readBytes()
    }
}
