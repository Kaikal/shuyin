package cn.shuyin.player

import android.content.ContentUris
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 本地曲库：走系统的 MediaStore。
 *
 * 和桌面端「自己扫目录 + lofty 读标签」不同——安卓上全盘遍历既慢又要额外权限，
 * 而系统媒体库已经把标题/歌手/专辑/时长/封面都索引好了，直接读它又快又准。
 * 代价是：只认系统扫描过的音频（用户新拷进来的歌，系统媒体扫描器会自己加进去）。
 *
 * 输出形状严格对齐 `LocalTrack`（见 packages/core/src/index.ts），
 * 少一个字段前端就可能判成「不是本地曲目」。
 */
object Library {
    private val cacheFile: File get() = File(Sy.files, "library.json")

    /** 内存里的曲库：扫描一次之后 get_tracks 直接读它，不再查库 */
    @Volatile
    private var cached: JSONArray? = null

    fun tracks(): String {
        cached?.let { return it.toString() }
        val f = cacheFile
        if (f.exists()) {
            try {
                val arr = JSONArray(f.readText())
                cached = arr
                return arr.toString()
            } catch (_: Exception) { /* 坏档就当没有，下面会重扫 */ }
        }
        val arr = query()
        cached = arr
        save(arr)
        return arr.toString()
    }

    fun count(): Int = JSONArray(tracks()).length()

    /**
     * 扫描 = 重新查一次 MediaStore，并与上次结果比对，给出新增/更新/移除数。
     * 安卓上没有「增量遍历」的意义（系统库本身就是最新的），incremental 只影响返回文案。
     */
    fun scan(incremental: Boolean): JSONObject {
        val t0 = System.currentTimeMillis()
        val before = try { JSONArray(tracks()) } catch (_: Exception) { JSONArray() }
        val old = HashMap<String, JSONObject>()
        for (i in 0 until before.length()) old[before.getJSONObject(i).getString("id")] = before.getJSONObject(i)

        val arr = query()
        cached = arr
        save(arr)

        var added = 0
        var updated = 0
        val seen = HashSet<String>()
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            val id = o.getString("id")
            seen.add(id)
            val prev = old[id]
            if (prev == null) added++
            else if (prev.optLong("mtime") != o.optLong("mtime")) updated++
        }
        val removed = old.keys.count { it !in seen }

        return JSONObject().apply {
            put("total", arr.length())
            put("added", added)
            put("updated", updated)
            put("removed", removed)
            put("durationMs", System.currentTimeMillis() - t0)
            put("incremental", incremental)
            put("roots", JSONArray().put("系统媒体库"))
            put("skipped", 0)
        }
    }

    private fun save(arr: JSONArray) {
        try { cacheFile.writeText(arr.toString()) } catch (_: Exception) { /* 写不进去也不影响本次使用 */ }
    }

    private fun query(): JSONArray {
        val out = JSONArray()
        val cols = mutableListOf(
            MediaStore.Audio.Media._ID,
            MediaStore.Audio.Media.TITLE,
            MediaStore.Audio.Media.ARTIST,
            MediaStore.Audio.Media.ALBUM,
            MediaStore.Audio.Media.ALBUM_ID,
            MediaStore.Audio.Media.DURATION,
            MediaStore.Audio.Media.DISPLAY_NAME,
            MediaStore.Audio.Media.MIME_TYPE,
            MediaStore.Audio.Media.SIZE,
            MediaStore.Audio.Media.DATE_MODIFIED,
            MediaStore.Audio.Media.YEAR,
            MediaStore.Audio.Media.TRACK,
        )
        if (Build.VERSION.SDK_INT >= 30) cols.add(MediaStore.Audio.Media.BITRATE)

        val sel = "${MediaStore.Audio.Media.IS_MUSIC}!=0 AND ${MediaStore.Audio.Media.DURATION}>=8000"
        val cur = try {
            Sy.app.contentResolver.query(
                MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
                cols.toTypedArray(), sel, null,
                "${MediaStore.Audio.Media.TITLE} COLLATE NOCASE ASC",
            )
        } catch (_: Exception) {
            null
        } ?: return out

        cur.use { c ->
            val iId = c.getColumnIndexOrThrow(MediaStore.Audio.Media._ID)
            val iTitle = c.getColumnIndexOrThrow(MediaStore.Audio.Media.TITLE)
            val iArtist = c.getColumnIndexOrThrow(MediaStore.Audio.Media.ARTIST)
            val iAlbum = c.getColumnIndexOrThrow(MediaStore.Audio.Media.ALBUM)
            val iAlbumId = c.getColumnIndexOrThrow(MediaStore.Audio.Media.ALBUM_ID)
            val iDur = c.getColumnIndexOrThrow(MediaStore.Audio.Media.DURATION)
            val iName = c.getColumnIndexOrThrow(MediaStore.Audio.Media.DISPLAY_NAME)
            val iMime = c.getColumnIndexOrThrow(MediaStore.Audio.Media.MIME_TYPE)
            val iSize = c.getColumnIndexOrThrow(MediaStore.Audio.Media.SIZE)
            val iMod = c.getColumnIndexOrThrow(MediaStore.Audio.Media.DATE_MODIFIED)
            val iYear = c.getColumnIndexOrThrow(MediaStore.Audio.Media.YEAR)
            val iTrack = c.getColumnIndexOrThrow(MediaStore.Audio.Media.TRACK)
            val iBr = if (Build.VERSION.SDK_INT >= 30) c.getColumnIndex(MediaStore.Audio.Media.BITRATE) else -1

            while (c.moveToNext()) {
                val id = c.getLong(iId)
                val uri = ContentUris.withAppendedId(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, id)
                val name = c.getString(iName) ?: ""
                val mime = c.getString(iMime) ?: ""
                val title = c.getString(iTitle)?.takeIf { it.isNotBlank() } ?: name.substringBeforeLast('.')
                // MediaStore 里「未知歌手」是字面量 <unknown>
                val artist = (c.getString(iArtist) ?: "").let { if (it == "<unknown>") "未知歌手" else it }
                val album = (c.getString(iAlbum) ?: "").let { if (it == "<unknown>") "" else it }

                out.put(JSONObject().apply {
                    put("id", md5Hex(uri.toString()))
                    // path 用 content:// —— 播放、读时长都靠它，且不需要任何存储权限
                    put("path", uri.toString())
                    put("title", title)
                    put("artist", artist)
                    put("album", album)
                    put("duration", Math.round((c.getLong(iDur) / 1000.0) * 10) / 10.0)
                    put("format", formatOf(mime, name))
                    if (iBr >= 0 && !c.isNull(iBr)) put("bitrate", c.getInt(iBr) / 1000) else put("bitrate", JSONObject.NULL)
                    put("sampleRate", JSONObject.NULL)
                    // 封面按**媒体 id** 现取（见 MainActivity 的 cover 分支）。
                    // 别用 album_id：Android 10+ 对缺专辑信息的文件会给哈希值，取缩略图必失败。
                    put("cover", "${Sy.HOST}/cover/$id")
                    put("mtime", c.getLong(iMod) * 1000)
                    put("size", c.getLong(iSize))
                    if (!c.isNull(iYear) && c.getInt(iYear) > 0) put("year", c.getInt(iYear)) else put("year", JSONObject.NULL)
                    if (!c.isNull(iTrack) && c.getInt(iTrack) > 0) put("trackNo", c.getInt(iTrack) % 1000) else put("trackNo", JSONObject.NULL)
                    put("genre", JSONObject.NULL)
                })
            }
        }
        return out
    }

    private fun formatOf(mime: String, name: String): String {
        val ext = name.substringAfterLast('.', "").lowercase()
        if (ext in setOf("flac", "mp3", "m4a", "aac", "ogg", "opus", "wav", "wma", "ape")) return ext
        return when {
            mime.contains("flac") -> "flac"
            mime.contains("mpeg") || mime.contains("mp3") -> "mp3"
            mime.contains("mp4") || mime.contains("aac") -> "m4a"
            mime.contains("ogg") -> "ogg"
            mime.contains("wav") -> "wav"
            else -> "mp3"
        }
    }

    /** 读音频真实时长（缓存校验用）：content:// 和本地路径都吃 */
    fun duration(pathOrUri: String): Double {
        val r = MediaMetadataRetriever()
        return try {
            if (pathOrUri.startsWith("content://")) r.setDataSource(Sy.app, Uri.parse(pathOrUri))
            else r.setDataSource(pathOrUri)
            val ms = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
            ms / 1000.0
        } catch (_: Exception) {
            0.0
        } finally {
            try { r.release() } catch (_: Exception) {}
        }
    }
}
