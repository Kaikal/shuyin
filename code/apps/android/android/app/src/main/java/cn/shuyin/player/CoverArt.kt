package cn.shuyin.player

import android.content.ContentUris
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import android.os.Build
import android.provider.MediaStore
import java.io.File

/**
 * 封面位图解析：通知大图 / 媒体会话封面共用这一份。
 *
 * 输入是前端传来的 cover 字符串，两种形状：
 *   * 本地曲目：`https://appassets.androidplatform.net/cover/<媒体id>`
 *     （WebView 里由 MainActivity 的 shouldInterceptRequest 现取并落盘到 Sy.covers）；
 *   * 在线曲目：平台 CDN 的 http(s) 直链。
 *
 * 与 MainActivity 的差别只在返回类型：那边要 WebResourceResponse（喂 <img>），
 * 这边要 Bitmap（喂 MediaMetadata）。落盘缓存的 JPG 是两边共享的——
 * WebView 播放页先点开过的话，通知这里直接读缓存，不再过一遍 MediaMetadataRetriever。
 */
object CoverArt {

    /** 文件里内嵌的封面（ID3 APIC / FLAC PICTURE / MP4 covr） */
    fun embeddedArt(ctx: Context, mediaId: String): Bitmap? {
        val uri = ContentUris.withAppendedId(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, mediaId.toLongOrNull() ?: return null)
        val mmr = MediaMetadataRetriever()
        return try {
            mmr.setDataSource(ctx, uri)
            mmr.embeddedPicture?.let { BitmapFactory.decodeByteArray(it, 0, it.size) }
        } catch (_: Exception) {
            null
        } finally {
            try { mmr.release() } catch (_: Exception) {}
        }
    }

    /** 退一步用媒体库的专辑缩略图（文件没内嵌封面但专辑里别处有） */
    fun albumThumb(ctx: Context, mediaId: String): Bitmap? {
        if (Build.VERSION.SDK_INT < 29) return null
        val mid = mediaId.toLongOrNull() ?: return null
        return try {
            val albumId = ctx.contentResolver.query(
                ContentUris.withAppendedId(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, mid),
                arrayOf(MediaStore.Audio.Media.ALBUM_ID), null, null, null
            )?.use { c -> if (c.moveToFirst()) c.getLong(0) else 0L } ?: 0L
            if (albumId <= 0) null else {
                val albumUri = ContentUris.withAppendedId(MediaStore.Audio.Albums.EXTERNAL_CONTENT_URI, albumId)
                ctx.contentResolver.loadThumbnail(albumUri, android.util.Size(512, 512), null)
            }
        } catch (_: Exception) {
            null
        }
    }

    /** cover 字符串 → Bitmap。任何失败都返回 null（没有图总比崩掉强） */
    fun fromCoverUrl(ctx: Context, cover: String?): Bitmap? {
        if (cover.isNullOrBlank()) return null
        return try {
            when {
                cover.startsWith("${Sy.HOST}/cover/") -> {
                    val id = cover.removePrefix("${Sy.HOST}/cover/")
                    val f = File(Sy.covers, "$id.jpg")
                    if (f.exists() && f.length() > 0) BitmapFactory.decodeFile(f.absolutePath)
                    else embeddedArt(ctx, id) ?: albumThumb(ctx, id)
                }
                cover.startsWith("http") -> Http.bytes(cover)?.let { BitmapFactory.decodeByteArray(it, 0, it.size) }
                else -> null
            }
        } catch (_: Exception) {
            null
        }
    }
}
