package cn.shuyin.player

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * 应用内更新：下 APK → 拉起系统安装器。
 *
 * 为什么不用 `DownloadManager`：它把文件丢进公共下载目录，装完要用户自己去
 * 通知栏点，还要过一遍「未知来源」——和跳浏览器的体验一样碎。这里直接把
 * 3~4MB 的包下到 `cacheDir/updates`，然后 `ACTION_VIEW` 交给系统安装器，
 * 全程只有一个进度条。
 *
 * 几个必须踩准的点：
 *   · **file:// 在 Android 7 起会被 `FileUriExposedException` 拒掉**，所以走
 *     `FileProvider`（authority = `${applicationId}.fileprovider`，见 AndroidManifest）。
 *   · **「安装未知应用」是特殊权限**，装不上就是装不上，只能跳系统设置页；
 *     用户授权后 `onResume` 回来，前端用 `update_install` 续装（文件还在缓存里）。
 *   · **进度要节流**：每 64KB 往 WebView 推一次，8MB 就是 130 次跨进程调用，
 *     下载时界面会明显卡顿。这里按 2% 或 300ms 取其一。
 *   · 多源：Gitee 拉不动就换 GitHub（国内直连 GitHub 时通时不通）。
 *     中途失败要**删掉半截文件**，否则 System 会拿一个残缺包去解析。
 */
object UpdateApk {
    private val main = Handler(Looper.getMainLooper())

    /** 缓存目录：跟播放缓存分开，清缓存时不会误删正在下的安装包 */
    private fun dir(): File = File(Sy.app.cacheDir, "updates").apply { mkdirs() }

    /**
     * 下载并安装。
     *
     * @param urls 按顺序尝试的下载地址（主源在前）
     * @return `{status:"installed"|"need_perm", path}`
     */
    fun downloadAndInstall(urls: List<String>, name: String, emit: (JSONObject) -> Unit): JSONObject {
        var lastErr: Exception? = null
        for ((i, url) in urls.withIndex()) {
            if (url.isBlank()) continue
            try {
                val file = fetch(url, name, emit)
                return install(file, emit)
            } catch (e: Exception) {
                lastErr = e
                // 还有备用源就继续；换源时把进度重置，否则进度条会从 60% 掉回 0 显得像出错
                if (i < urls.size - 1) emit(JSONObject().put("pct", 0).put("got", 0).put("total", 0))
            }
        }
        throw lastErr ?: IllegalStateException("没有可用的下载地址")
    }

    /** 续装：文件已经下好了，只做权限判断 + 拉起安装器 */
    fun installDownloaded(path: String, emit: (JSONObject) -> Unit): JSONObject {
        val f = File(path)
        if (!f.isFile || f.length() < 1024) throw IllegalStateException("安装包不存在，请重新下载")
        return install(f, emit)
    }

    /* ---------------- 下载 ---------------- */

    private fun fetch(url: String, name: String, emit: (JSONObject) -> Unit): File {
        val safe = name.replace(Regex("[^\\w.\\-]"), "_")
        val out = File(dir(), safe)
        /* 同一个版本重下：先删掉旧的，避免断点续传拼出坏包（我们不支持 Range） */
        if (out.exists()) out.delete()

        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15_000
            readTimeout = 30_000
            instanceFollowRedirects = true
            requestMethod = "GET"
            setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android) Shuyin")
            /* Gitee 的 raw 对没有 Referer 的大文件会 403，给一个自家域名最省事 */
            setRequestProperty("Referer", "https://gitee.com/")
        }
        try {
            val code = conn.responseCode
            if (code >= 400) throw IllegalStateException("HTTP $code")
            val total = conn.contentLengthLong.coerceAtLeast(0L)
            var got = 0L
            var lastPct = -1
            var lastAt = 0L
            conn.inputStream.use { input ->
                out.outputStream().use { os ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n <= 0) break
                        os.write(buf, 0, n)
                        got += n
                        val pct = if (total > 0) ((got * 100) / total).toInt() else -1
                        val now = System.currentTimeMillis()
                        if (now - lastAt >= 300 || (pct >= 0 && pct / 2 != lastPct / 2)) {
                            lastAt = now
                            lastPct = pct
                            emit(JSONObject().put("pct", pct).put("got", got).put("total", total))
                        }
                    }
                    os.flush()
                }
            }
            if (got < 1024) throw IllegalStateException("下载内容为空（$got 字节）")
            emit(JSONObject().put("pct", 100).put("got", got).put("total", total))
            return out
        } catch (e: Exception) {
            out.delete()
            throw e
        } finally {
            try { conn.disconnect() } catch (_: Exception) {}
        }
    }

    /* ---------------- 安装 ---------------- */

    private fun install(file: File, emit: (JSONObject) -> Unit): JSONObject {
        val pkg = Sy.app.packageName
        /* Android 8 起才有「按应用授权未知来源」；7 及以下装着就能装（靠系统全局开关） */
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            !Sy.app.packageManager.canRequestPackageInstalls()
        ) {
            openUnknownSources(pkg)
            emit(JSONObject().put("pct", 100).put("got", file.length()).put("total", file.length()))
            return JSONObject().put("status", "need_perm").put("path", file.absolutePath)
        }
        val uri: Uri = FileProvider.getUriForFile(Sy.app, "$pkg.fileprovider", file)
        val it = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        /*
         * startActivity 必须在主线程。Bridge 的 dispatch 跑在线程池里，
         * 直接调会在部分 ROM 上抛「Calling startActivity() from outside of an
         * Activity context」的变体错误（华为那批尤其严）。
         */
        main.post {
            try { Sy.app.startActivity(it) } catch (_: Exception) {}
        }
        return JSONObject().put("status", "installed").put("path", file.absolutePath)
    }

    private fun openUnknownSources(pkg: String) {
        main.post {
            try {
                val it = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
                    .setData(Uri.parse("package:$pkg"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                Sy.app.startActivity(it)
            } catch (_: Exception) {
                /* 极少数 ROM 没有这一页：让前端提示用户自己去「设置 → 应用」里开 */
            }
        }
    }
}
