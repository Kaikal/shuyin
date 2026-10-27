package cn.shuyin.player

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 音源脚本清单（`sources.json`）。
 *
 * 与桌面端同一套约定：**只认清单里的 code**，不扫目录、不认散落的 .js。
 * 好处是「加/删音源」只有导入与删除两条路，用户不会因为手改文件而得到半生效状态。
 *
 * 安卓这边额外做一件事：首次启动时把打包进 APK 的 `assets/sources.json`
 * 落成初始清单——也就是桌面端已经导入过的那几个音源，装完就能直接放歌，
 * 不用在手机上再找一遍脚本。
 */
object Sources {
    private val manifest: File get() = File(Sy.sourcesDir, "sources.json")
    private val assetSeed = "sources.json"

    private fun load(): JSONArray {
        val f = manifest
        if (!f.exists()) {
            seed()
            if (!f.exists()) return JSONArray()
        }
        return try {
            JSONObject(f.readText()).optJSONArray("sources") ?: JSONArray()
        } catch (_: Exception) {
            JSONArray()
        }
    }

    /** 首次启动：把内置清单复制到数据目录。已经有清单就不动，绝不覆盖用户的导入。 */
    private fun seed() {
        if (manifest.exists()) return
        try {
            val text = Sy.app.assets.open(assetSeed).bufferedReader().use { it.readText() }
            // 校验一下确实是合法清单再落盘，坏档比没有更麻烦
            JSONObject(text).optJSONArray("sources") ?: return
            manifest.writeText(text)
        } catch (_: Exception) {
            // 没打包内置清单也正常（纯净版）：直接给一份空清单
            try { manifest.writeText("""{"version":1,"sources":[]}""") } catch (_: Exception) {}
        }
    }

    private fun save(arr: JSONArray) {
        Sy.sourcesDir.mkdirs()
        val tmp = File(Sy.sourcesDir, "sources.json.tmp")
        tmp.writeText(JSONObject().put("version", 1).put("sources", arr).toString())
        if (!tmp.renameTo(manifest)) {
            manifest.writeText(tmp.readText())
            tmp.delete()
        }
    }

    /** 前端要的形状：`path` 是合成地址（`…/sources.json#名字`），sourceManager 拿它算 id */
    fun list(): JSONArray {
        val arr = load()
        val out = JSONArray()
        val base = manifest.absolutePath
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            out.put(
                JSONObject()
                    .put("path", "$base#${o.optString("name")}")
                    .put("name", o.optString("name"))
                    .put("code", o.optString("code"))
            )
        }
        return out
    }

    fun importText(nameIn: String, code: String): String {
        if (code.isBlank()) throw IllegalStateException("脚本内容为空")
        val name = nameIn.ifBlank { guessName(code) ?: "未命名音源" }
        val arr = load()
        // 同名覆盖：用户改完版本再导入一次，不该出现两个同名音源
        var replaced = false
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            if (o.optString("name") == name) {
                arr.put(i, JSONObject().put("name", name).put("code", code))
                replaced = true
                break
            }
        }
        if (!replaced) arr.put(JSONObject().put("name", name).put("code", code))
        save(arr)
        return name
    }

    fun importUrl(url: String, nameIn: String): String {
        val res = Http.request(url, timeoutMs = 20_000)
        val status = res.optInt("status")
        if (status !in 200..299) throw IllegalStateException("下载脚本失败：HTTP $status")
        val code = res.optString("body")
        val name = nameIn.ifBlank { url.substringAfterLast('/').substringBeforeLast(".js", "") }
        return importText(name, code)
    }

    fun delete(path: String) {
        val name = path.substringAfterLast('#')
        val arr = load()
        val keep = JSONArray()
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            if (o.optString("name") != name) keep.put(o)
        }
        save(keep)
    }

    /** 从脚本头部的 `@name` 注释里猜名字（洛雪音源的通用约定） */
    private fun guessName(code: String): String? {
        val m = Regex("@name\\s+(.+)").find(code.take(2000)) ?: return null
        return m.groupValues[1].trim().take(40)
    }
}
