package cn.shuyin.player

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Environment
import android.provider.DocumentsContract
import org.json.JSONObject
import java.io.File

/**
 * 「在文件夹中显示」在安卓上的落地。
 *
 * 桌面端一行 `revealItemInDir(path)` 就完事，安卓**没有等价的公开接口**：
 * 系统文件管理器能接受的是 DocumentsProvider 的 document uri，而不是普通路径。
 * 所以这里的策略是「先试一次真打开，不行就把路径塞进剪贴板」——
 * 用户点下去**必须**有反应，静默什么都不发生是最糟的（原来 `if (!isTauri) return`
 * 就是这个效果："下载页打不开、和目录相关的全都打不开"）。
 *
 * 能打开的前提：
 *   · 路径在**共享存储**里（`/storage/emulated/0/...` 或 SD 卡），能映射成
 *     `primary:相对路径` / `<卷ID>:相对路径`；
 *   · 不是应用私有目录，也不是 `Android/data` / `Android/obb`——Android 11 起
 *     文件管理器点进去只会看到「无法访问」，那种"打开成功"反而更让人困惑。
 *
 * 给的是**所在文件夹**，不是文件本身：动作名字就是「在文件夹中显示」，
 * 直接 ACTION_VIEW 一个音频会跳去音乐播放器，那是另一件事。
 */
object Paths {
    private const val AUTH = "com.android.externalstorage.documents"

    /**
     * @return `{ opened: Boolean, copied: Boolean, path: String }`
     *   `opened=true` 已交给文件管理器；否则一定 `copied=true`（路径在剪贴板里）。
     */
    fun reveal(raw: String): JSONObject {
        val path = raw.trim()
        if (path.isEmpty()) {
            return JSONObject().put("opened", false).put("copied", false).put("path", "")
        }
        if (tryOpen(path)) {
            return JSONObject().put("opened", true).put("copied", false).put("path", path)
        }
        copy(path)
        return JSONObject().put("opened", false).put("copied", true).put("path", path)
    }

    /** 共享存储绝对路径 → document id；私有目录返回 null（注定打不开） */
    private fun docIdOf(path: String): String? {
        if (path.startsWith("/data/") || path.contains("/Android/data/") || path.contains("/Android/obb/")) {
            return null
        }
        val primary = Environment.getExternalStorageDirectory()?.absolutePath ?: return null
        if (path == primary) return "primary:"
        if (path.startsWith("$primary/")) return "primary:" + path.removePrefix("$primary/")
        /* 可移动存储 /storage/XXXX-XXXX/… → "XXXX-XXXX:…" */
        val m = Regex("^/storage/([^/]+)/?(.*)$").find(path) ?: return null
        val vol = m.groupValues[1]
        if (vol == "emulated" || vol == "self") return null
        return vol + ":" + m.groupValues[2]
    }

    private fun tryOpen(path: String): Boolean {
        val f = File(path)
        /* 文件 → 打开它所在的文件夹（见文件头注释） */
        val dir = if (f.isDirectory) f else f.parentFile ?: return false
        val id = docIdOf(dir.absolutePath) ?: return false
        val uri = DocumentsContract.buildDocumentUri(AUTH, id)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, DocumentsContract.Document.MIME_TYPE_DIR)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        return try {
            Sy.app.startActivity(intent)
            true
        } catch (_: Exception) {
            /* 没有能接这个 uri 的文件管理器（多数定制 ROM）→ 交给调用方复制路径 */
            false
        }
    }

    private fun copy(text: String) {
        try {
            val cm = Sy.app.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            cm.setPrimaryClip(ClipData.newPlainText("路径", text))
        } catch (_: Exception) {
            /* 剪贴板被系统限流（Android 10+ 后台限制）也不该抛到前端 */
        }
    }
}
