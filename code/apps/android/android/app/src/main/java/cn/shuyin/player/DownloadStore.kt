package cn.shuyin.player

import android.annotation.TargetApi
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.MediaStore
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * 下载落盘：**公共存储**，不是应用私有目录。
 *
 * 用户的原话（2026-11-11）：「下载歌曲不应该下载到数据文件夹中，应该下载在公共空间，
 * 让别的软件也能访问」。以前落在 `getExternalFilesDir("Music")`
 * = `Android/data/cn.shuyin.player/files/Music`，Android 11 起连文件管理器点进去
 * 都只显示「无法访问」，别的播放器更扫不到——下完等于存在一个只有自己能看见的黑盒里。
 *
 * 现在的落点分三档，优先级从高到低：
 *   1. **用户自选的文件夹**（SAF 授权，`ACTION_OPEN_DOCUMENT_TREE`）——设置页「更改…」；
 *   2. **系统公共「音乐」里的 `疏音` 子目录**（`Music/疏音`）：
 *      · API 29+ 走 MediaStore（分区存储下这是唯一被允许的写法），
 *        顺带把 TITLE/ARTIST 写进媒体库，别的播放器扫出来就是正确的歌名歌手；
 *      · API 24~28 直接 File 写公共目录（需要有 WRITE_EXTERNAL_STORAGE）。
 *   3. 都没有 = 第 2 档的默认位置。
 *
 * **为什么要先下到临时文件再搬**：
 * MediaStore 的 IS_PENDING 只能保证「别的应用看不到写了一半的文件」，
 * 但边下边写 ContentResolver 流时，一旦网络中断就只能删掉重来；
 * 先落到 `cache/dl` 再整块复制，失败时公共目录里不会留下一堆半截文件。
 */
object DownloadStore {
    private const val PREFS = "shuyin.downloads"
    private const val KEY_TREE = "tree"
    /** 公共「音乐」下我们自己的子目录：一眼能认出是这个应用下的，又不跟用户的歌混在一起 */
    private const val SUBDIR = "疏音"

    private val prefs: android.content.SharedPreferences
        get() = Sy.app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val resolver get() = Sy.app.contentResolver
    private val tmpDir: File
        get() = File(Sy.app.cacheDir, "dl").apply { mkdirs() }

    /* ---------------- 目录 ---------------- */

    /** 默认公共目录：`<共享存储>/Music/疏音` */
    fun defaultDir(): File =
        File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC), SUBDIR)

    /**
     * 歌词（.lrc）的落点：`<共享存储>/Download/疏音`。
     *
     * 不是「和歌放一起」——在分区存储下，`MediaStore.Files` 只允许往
     * **Download / Documents** 里建非媒体文件，往 `Music/` 写文本会被
     * MediaProvider 直接拒绝（实测报「Primary directory Music not allowed」）。
     * 与其把 .lrc 伪装成音频塞进音乐库（那会让播放器扫出一条放不出来的“歌”），
     * 不如老实放在下载目录：文件管理器一眼能找到，也是别人拿到歌词最顺手的位置。
     */
    fun textDir(): File =
        File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), SUBDIR)

    fun tree(): Uri? {
        val s = prefs.getString(KEY_TREE, null) ?: return null
        return try { Uri.parse(s) } catch (_: Exception) { null }
    }

    fun setTree(uri: Uri?) {
        prefs.edit().apply {
            if (uri == null) remove(KEY_TREE) else putString(KEY_TREE, uri.toString())
        }.apply()
    }

    fun isCustom(): Boolean = tree() != null

    /**
     * 给前端展示 / 拼 dest 用的路径。
     *
     * SAF 目录也必须能换算成「人类可读的绝对路径」：前端的下载任务用
     * `目录 + 文件名` 拼 key、下载页也直接显示它，回一个 `content://` 只会让人看不懂。
     * `DocumentsContract.getTreeDocumentId` → `primary:Music/mine`，再拼回
     * `/storage/emulated/0/Music/mine` 就是完整路径。
     */
    fun displayDir(): String {
        val t = tree() ?: return defaultDir().absolutePath
        val id = try { DocumentsContract.getTreeDocumentId(t) } catch (_: Exception) { null }
            ?: return t.toString()
        val i = id.indexOf(':')
        if (i < 0) return id
        val vol = id.substring(0, i)
        val rel = id.substring(i + 1)
        val root = if (vol == "primary") {
            Environment.getExternalStorageDirectory().absolutePath
        } else {
            "/storage/$vol"
        }
        return if (rel.isBlank()) root else "$root/$rel"
    }

    /* ---------------- 下载 ---------------- */

    /** 只取文件名：前端拼的 dest 是「目录\文件名」，Windows 反斜杠也认 */
    private fun baseName(raw: String): String {
        val n = raw.substringAfterLast('/').substringAfterLast('\\').trim()
        return if (n.isBlank()) "未命名" else n
    }

    fun mimeOf(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
        "mp3" -> "audio/mpeg"
        "m4a" -> "audio/mp4"
        "aac" -> "audio/aac"
        "flac" -> "audio/flac"
        "wav" -> "audio/wav"
        "ogg" -> "audio/ogg"
        "lrc" -> "text/plain"
        else -> "application/octet-stream"
    }

    /**
     * `歌手 - 歌名 [320k].mp3` → (歌名, 歌手)。
     *
     * 前端就是按这个格式命名的（见 `DownloadsProvider.fileNameOf`），
     * 顺手写进媒体库，别的播放器/文件管理器显示出来才是「歌名 + 歌手」，
     * 而不是一整串带音质后缀的文件名。
     */
    private fun metaOf(name: String): Pair<String, String>? {
        val stem = name.substringBeforeLast('.').replace(Regex("\\s*\\[[^\\]]*]\\s*$"), "").trim()
        val at = stem.indexOf(" - ")
        if (at <= 0) return null
        val artist = stem.substring(0, at).trim()
        val title = stem.substring(at + 3).trim()
        if (artist.isBlank() || title.isBlank()) return null
        return title to artist
    }

    /** 边下边报进度：`onProgress(已写, 总量)`，总量未知时是 0 */
    private fun fetchToTemp(url: String, onProgress: (Long, Long) -> Unit): File {
        val tmp = File.createTempFile("dl-", ".part", tmpDir)
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 15_000
        conn.readTimeout = 30_000
        conn.instanceFollowRedirects = true
        try {
            val total = conn.contentLengthLong.coerceAtLeast(0)
            onProgress(0, total)
            var written = 0L
            conn.inputStream.use { input ->
                FileOutputStream(tmp).use { fos ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n <= 0) break
                        fos.write(buf, 0, n)
                        written += n
                        onProgress(written, total)
                    }
                }
            }
            if (written <= 0) throw IOException("下载到 0 字节，链接可能已过期")
            return tmp
        } catch (e: Throwable) {
            tmp.delete()
            throw e
        } finally {
            conn.disconnect()
        }
    }

    /** 下载 + 搬进公共目录；返回写入字节数 */
    fun save(url: String, rawName: String, onProgress: (Long, Long) -> Unit): Long {
        val name = baseName(rawName)
        val tmp = fetchToTemp(url, onProgress)
        try {
            val n = tmp.length()
            publish(tmp, name)
            // 整个文件都进去了才算完成：进度条最后那一格别停在 99%
            onProgress(n, n)
            return n
        } finally {
            tmp.delete()
        }
    }

    /**
     * 下载到**应用私有目录里的某个绝对路径**（播放缓存用）。
     *
     * 和 `save()` 的区别是「不发布」：`save()` 的语义是「给用户一个下载好的文件」，
     * 所以要落到公共音乐目录、要写 MediaStore、要让别的播放器扫得到。
     * 播放缓存只是「下次别再联网取一遍」的一块数据，它必须待在自己的 cache 里，
     * 绝不能出现在用户的音乐目录里。
     *
     * 这条命令以前是**没有的**：缓存复用了 `download_track`，而它拿到
     * `cache/audio/xxx.mp3` 这种绝对路径后只取 basename 再发布到 `Music/疏音`。
     * 结果 `cache_lookup` 永远找不到文件（缓存 100% 失效，每次播放都重新取链），
     * 同时每首听过的歌都在用户音乐库里留一份副本。
     */
    fun writeTo(url: String, dest: File, onProgress: (Long, Long) -> Unit): Long {
        val tmp = fetchToTemp(url, onProgress)
        return try {
            dest.parentFile?.mkdirs()
            tmp.copyTo(dest, overwrite = true)
            val n = dest.length()
            onProgress(n, n)
            n
        } finally {
            tmp.delete()
        }
    }

    /** 写一份文本（.lrc 歌词），返回它真正的绝对路径（前端拿它显示「保存到」） */
    fun saveText(rawName: String, text: String): String {
        val name = baseName(rawName)
        val tmp = File.createTempFile("txt-", ".part", tmpDir)
        try {
            tmp.writeText(text)
            val t = tree()
            if (t != null) {
                publishToTree(tmp, name, t)
                return joinDisplay(displayDir(), name)
            }
            if (Build.VERSION.SDK_INT >= 29) {
                publishTextToMediaStore(tmp, name)
            } else {
                val dir = textDir().apply { mkdirs() }
                if (!dir.isDirectory) throw IOException("建不了下载目录")
                tmp.copyTo(File(dir, name), overwrite = true)
            }
            return joinDisplay(textDir().absolutePath, name)
        } finally {
            tmp.delete()
        }
    }

    private fun joinDisplay(dir: String, name: String): String =
        dir.trimEnd('/', '\\') + "/" + name

    private fun publish(tmp: File, name: String) {
        val t = tree()
        when {
            t != null -> publishToTree(tmp, name, t)
            Build.VERSION.SDK_INT >= 29 -> publishToMediaStore(tmp, name)
            else -> {
                val dir = defaultDir().apply { mkdirs() }
                if (!dir.isDirectory) throw IOException("建不了公共音乐目录，去设置换个下载位置")
                // 旧的同名文件直接覆盖：重下一次是为了拿到更好的那份，不是再加一份
                val out = File(dir, name)
                tmp.copyTo(out, overwrite = true)
            }
        }
    }

    /* ---------------- MediaStore（API 29+） ---------------- */

    @TargetApi(29)
    private fun publishToMediaStore(tmp: File, name: String) {
        val mime = mimeOf(name)
        val audio = mime.startsWith("audio/")
        val collection = if (audio) {
            MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        } else {
            MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        }
        /* 音频进「音乐」，其它（理论上不会走到）进「下载」——Files 集合只认 Download */
        val rel = "${if (audio) Environment.DIRECTORY_MUSIC else Environment.DIRECTORY_DOWNLOADS}/$SUBDIR"

        /* 同名覆盖。只在本应用自己的目录里找，不会碰到别人的文件 */
        try {
            resolver.query(
                collection,
                arrayOf(MediaStore.MediaColumns._ID),
                "${MediaStore.MediaColumns.RELATIVE_PATH}=? AND ${MediaStore.MediaColumns.DISPLAY_NAME}=?",
                arrayOf("$rel/", name),
                null,
            )?.use { c ->
                while (c.moveToNext()) {
                    resolver.delete(ContentUris.withAppendedId(collection, c.getLong(0)), null, null)
                }
            }
        } catch (_: Exception) {
            /* 查不到就当没有：覆盖失败不该拦住这次下载 */
        }

        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.MIME_TYPE, mime)
            put(MediaStore.MediaColumns.RELATIVE_PATH, rel)
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        if (audio) metaOf(name)?.let { (title, artist) ->
            values.put(MediaStore.Audio.Media.TITLE, title)
            values.put(MediaStore.Audio.Media.ARTIST, artist)
        }
        val uri = resolver.insert(collection, values)
            ?: throw IOException("系统不允许写入公共「音乐」目录")
        try {
            resolver.openOutputStream(uri)?.use { out ->
                tmp.inputStream().use { it.copyTo(out, 64 * 1024) }
            } ?: throw IOException("打不开目标文件")
            resolver.update(
                uri,
                ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) },
                null,
                null,
            )
        } catch (e: Throwable) {
            // 写一半失败：把这条空壳记录删掉，别在音乐库里留一个 0 字节
            try { resolver.delete(uri, null, null) } catch (_: Exception) {}
            throw e
        }
    }

    /** 非媒体文件（.lrc）：只能进 Download / Documents，见 `textDir` 的注释 */
    @TargetApi(29)
    private fun publishTextToMediaStore(tmp: File, name: String) {
        /*
         * 用 Files 集合而不是 Downloads：后者会按 MIME 再补一次扩展名
         * ——实测 `xxx.lrc` + `text/plain` 落地成了 `xxx.lrc.txt`。
         */
        val collection = MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        val rel = "${Environment.DIRECTORY_DOWNLOADS}/$SUBDIR"

        try {
            resolver.query(
                collection,
                arrayOf(MediaStore.MediaColumns._ID),
                "${MediaStore.MediaColumns.RELATIVE_PATH}=? AND ${MediaStore.MediaColumns.DISPLAY_NAME}=?",
                arrayOf("$rel/", name),
                null,
            )?.use { c ->
                while (c.moveToNext()) {
                    resolver.delete(ContentUris.withAppendedId(collection, c.getLong(0)), null, null)
                }
            }
        } catch (_: Exception) { /* 查不到就当没有 */ }

        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            /*
             * 不能用 `text/plain`：MediaProvider 会按 MIME 把扩展名补一遍，
             * `xxx.lrc` 落盘就成了 `xxx.lrc.txt`（实测）。给一个它不认识的
             * `application/x-lrc`，它就不动 DISPLAY_NAME，同时外部仍能按 .lrc 打开。
             */
            put(MediaStore.MediaColumns.MIME_TYPE, "application/x-lrc")
            put(MediaStore.MediaColumns.RELATIVE_PATH, rel)
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val uri = resolver.insert(collection, values)
            ?: throw IOException("系统不允许写入公共「下载」目录")
        try {
            resolver.openOutputStream(uri)?.use { out ->
                tmp.inputStream().use { it.copyTo(out, 64 * 1024) }
            } ?: throw IOException("打不开目标文件")
            resolver.update(
                uri,
                ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) },
                null, null,
            )
        } catch (e: Throwable) {
            try { resolver.delete(uri, null, null) } catch (_: Exception) {}
            throw e
        }
    }

    /* ---------------- SAF（用户自选目录） ---------------- */

    private fun publishToTree(tmp: File, name: String, treeUri: Uri) {
        val docId = try {
            DocumentsContract.getTreeDocumentId(treeUri)
        } catch (e: Exception) {
            throw IOException("这个文件夹的授权已失效，去设置重新选一次")
        }
        val parent = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId)
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, docId)

        /* 同名覆盖：SAF 的 createDocument 遇到同名会自动变成「名字 (1)」，越下越多份 */
        try {
            resolver.query(
                children,
                arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME),
                null, null, null,
            )?.use { c ->
                while (c.moveToNext()) {
                    if (c.getString(1) != name) continue
                    val old = DocumentsContract.buildDocumentUriUsingTree(treeUri, c.getString(0))
                    try { DocumentsContract.deleteDocument(resolver, old) } catch (_: Exception) {}
                    break
                }
            }
        } catch (_: Exception) {
            /* 列不出来照样可以试着创建 */
        }

        val created = try {
            DocumentsContract.createDocument(resolver, parent, mimeOf(name), name)
        } catch (e: Exception) {
            null
        } ?: throw IOException("写不进这个文件夹，去设置换个下载位置")

        try {
            resolver.openOutputStream(created)?.use { out ->
                tmp.inputStream().use { it.copyTo(out, 64 * 1024) }
            } ?: throw IOException("打不开目标文件")
        } catch (e: Throwable) {
            try { DocumentsContract.deleteDocument(resolver, created) } catch (_: Exception) {}
            throw e
        }
    }

    /* ---------------- 给前端的状态 ---------------- */

    fun stateJson(cancel: Boolean = false): JSONObject = JSONObject()
        .put("dir", displayDir())
        .put("custom", isCustom())
        .put("cancel", cancel)

    /*
     * 旧版本缓存误落盘的副本（`Music/疏音/online_*.mp3`）。
     *
     * 0.6.96 及更早，播放缓存复用了「下载」那条命令，把 `cache/audio/xxx.mp3`
     * 当成文件名发布到了公共音乐目录。于是每首听过的在线歌都在用户音乐库里
     * 留了一份 `online_<平台>_<id>.<ext>` 副本，缓存目录却一直是空的。
     *
     * 新版本已经不会再生成了（见 writeTo），但老用户目录里那些还躺着。
     * 识别规则很窄：只认 `online_` 前缀 —— 用户点「下载」得到的文件名是
     * 「歌手 - 歌名 [320k].mp3」，永远不可能是这个形状。
     */
    private fun isCacheCopyName(name: String) = name.startsWith("online_")

    /** 统计误落盘副本：[个数, 字节数] */
    fun cacheCopies(): LongArray {
        var count = 0L
        var bytes = 0L
        val rel = "${Environment.DIRECTORY_MUSIC}/$SUBDIR"
        if (Build.VERSION.SDK_INT >= 29) {
            val collection = MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            try {
                Sy.app.contentResolver.query(
                    collection,
                    arrayOf(MediaStore.MediaColumns.SIZE, MediaStore.MediaColumns.DISPLAY_NAME),
                    "${MediaStore.MediaColumns.RELATIVE_PATH}=?",
                    arrayOf("$rel/"),
                    null,
                )?.use { c ->
                    while (c.moveToNext()) {
                        if (isCacheCopyName(c.getString(1) ?: continue)) {
                            count++
                            bytes += c.getLong(0)
                        }
                    }
                }
            } catch (_: Exception) { /* 查不到就当没有 */ }
        } else {
            File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC), SUBDIR)
                .listFiles()?.forEach { f ->
                    if (f.isFile && isCacheCopyName(f.name)) { count++; bytes += f.length() }
                }
        }
        return longArrayOf(count, bytes)
    }

    /** 删掉那些副本；返回 [删掉的个数, 释放的字节数] */
    fun purgeCacheCopies(): LongArray {
        var count = 0L
        var bytes = 0L
        val rel = "${Environment.DIRECTORY_MUSIC}/$SUBDIR"
        if (Build.VERSION.SDK_INT >= 29) {
            val resolver = Sy.app.contentResolver
            val collection = MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            try {
                val ids = ArrayList<Long>()
                resolver.query(
                    collection,
                    arrayOf(MediaStore.MediaColumns._ID, MediaStore.MediaColumns.SIZE, MediaStore.MediaColumns.DISPLAY_NAME),
                    "${MediaStore.MediaColumns.RELATIVE_PATH}=?",
                    arrayOf("$rel/"),
                    null,
                )?.use { c ->
                    while (c.moveToNext()) {
                        if (!isCacheCopyName(c.getString(2) ?: continue)) continue
                        ids.add(c.getLong(0))
                        bytes += c.getLong(1)
                    }
                }
                for (id in ids) {
                    try {
                        if (resolver.delete(ContentUris.withAppendedId(collection, id), null, null) > 0) count++
                    } catch (_: Exception) { /* 单条失败不影响其它 */ }
                }
            } catch (_: Exception) { /* 查询失败就什么都不删 */ }
        } else {
            File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC), SUBDIR)
                .listFiles()?.forEach { f ->
                    if (f.isFile && isCacheCopyName(f.name)) {
                        bytes += f.length()
                        if (f.delete()) count++
                    }
                }
        }
        return longArrayOf(count, bytes)
    }
}
