package cn.shuyin.player

import android.content.Context
import java.io.File

/**
 * 全局路径与常量。
 *
 * 数据根刻意和桌面端「各管各的」：安卓用应用私有目录，卸载即清干净，
 * 不需要存储权限（除了读用户已有的音乐库）。
 */
object Sy {
    lateinit var app: Context
        private set

    fun init(ctx: Context) {
        if (!::app.isInitialized) app = ctx.applicationContext
    }

    /** 内部数据：音源清单等 */
    val files: File get() = app.filesDir
    val sourcesDir: File get() = File(files, "sources").apply { mkdirs() }

    /** 播放缓存（听过的歌留一份），清缓存不动它以外的任何东西 */
    val cacheAudio: File get() = File(app.cacheDir, "audio").apply { mkdirs() }

    /**
     * 下载目录：**公共存储**的 `Music/疏音`（不是 `Android/data/…`）。
     *
     * 以前是 `getExternalFilesDir("Music")`——不需要权限、卸载即清，听起来干净，
     * 但 Android 11 起文件管理器点进去只显示「无法访问」，别的播放器更扫不到，
     * 用户下完的歌在系统里等于不存在。落盘细节见 `DownloadStore`。
     */
    val downloads: File
        get() = DownloadStore.defaultDir()

    /** 本地歌曲封面导出目录（WebView 通过本地资产域取图） */
    val covers: File get() = File(app.cacheDir, "covers").apply { mkdirs() }

    /**
     * 界面（含本地图片）走这个虚拟域名，由 MainActivity 的 shouldInterceptRequest
     * 从 assets / 文件系统直接喂给 WebView。
     *
     * 用 https + 真实域名而不是 file://：file:// 是「不透明来源」，
     * localStorage、IndexedDB、fetch 都会被卡；换成 https 之后前端那些
     * 存储与请求代码一行都不用改。
     */
    const val HOST = "https://appassets.androidplatform.net"

    val isCar: Boolean get() = BuildConfig.CAR

    fun humanSize(bytes: Long): String = when {
        bytes >= 1L shl 30 -> String.format("%.1f GB", bytes / 1073741824.0)
        bytes >= 1L shl 20 -> String.format("%.1f MB", bytes / 1048576.0)
        bytes >= 1L shl 10 -> String.format("%.0f KB", bytes / 1024.0)
        else -> "$bytes B"
    }
}

/** md5（曲目 id 用文件地址算，跨扫描稳定） */
fun md5Hex(s: String): String {
    val d = java.security.MessageDigest.getInstance("MD5").digest(s.toByteArray())
    val sb = StringBuilder()
    for (b in d) sb.append(String.format("%02x", b))
    return sb.toString()
}
