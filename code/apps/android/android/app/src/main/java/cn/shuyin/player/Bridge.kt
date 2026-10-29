package cn.shuyin.player

import android.content.Intent
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
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

    private val pool = Executors.newFixedThreadPool(4)

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
        // MediaPlayer 没有解码后的采样输出，做不了真频谱。返回 40 个 0，
        // 前端那条进度条/频谱会画成一条平线，而不是因为空数组报错。
        "spectrum" -> JSONArray().apply { for (i in 0 until 40) put(0.0) }
        "set_fx" -> null
        "smtc_update" -> {
            send(
                PlaybackService.ACT_META,
                "title" to a.optString("title"),
                "artist" to a.optString("artist"),
                "album" to a.optString("album"),
            )
            null
        }

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

        /* ---- 音源清单 ---- */
        "sources_default_dir" -> Sy.sourcesDir.absolutePath
        "list_source_scripts" -> Sources.list()
        "import_source_text" -> Sources.importText(a.optString("name"), a.optString("code"))
        "import_source_url" -> Sources.importUrl(a.optString("url"), a.optString("name"))
        "import_source_files" -> throw IllegalStateException("安卓端请用「粘贴脚本」或「从链接导入」")
        "delete_source_script" -> { Sources.delete(a.optString("path")); null }

        /* ---- 下载 ---- */
        "downloads_dir" -> Sy.downloads.absolutePath
        "download_track" -> download(a.optString("url"), a.optString("dest"))
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
        "save_lyrics_file" -> { File(a.optString("path")).writeText(a.optString("text")); null }
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
            val latch = java.util.concurrent.CountDownLatch(1)
            val out = arrayOfNulls<JSONObject>(1)
            web.post {
                val act = web.context as? MainActivity
                if (act == null) {
                    out[0] = JSONObject().put("ok", false).put("error", "登录窗打不开")
                    latch.countDown()
                } else {
                    act.platformLogin(src) { r ->
                        out[0] = r
                        latch.countDown()
                    }
                }
            }
            // 登录要等用户扫码 / 输密码，比选文件久得多：给 6 分钟（窗口自己 5 分钟就超时）
            latch.await(6, java.util.concurrent.TimeUnit.MINUTES)
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
            if (android.os.Build.VERSION.SDK_INT >= 26) Sy.app.startForegroundService(i)
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
    private fun download(url: String, dest: String): Long {
        val out = File(dest)
        out.parentFile?.mkdirs()
        dl[dest] = longArrayOf(0, 0)
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 15_000
        conn.readTimeout = 30_000
        conn.instanceFollowRedirects = true
        try {
            val total = conn.contentLengthLong.coerceAtLeast(0)
            dl[dest] = longArrayOf(0, total)
            var written = 0L
            conn.inputStream.use { input ->
                FileOutputStream(out).use { fos ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n <= 0) break
                        fos.write(buf, 0, n)
                        written += n
                        dl[dest] = longArrayOf(written, total)
                    }
                }
            }
            return written
        } finally {
            conn.disconnect()
            dl.remove(dest)
        }
    }

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
