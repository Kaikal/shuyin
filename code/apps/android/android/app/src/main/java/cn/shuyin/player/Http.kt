package cn.shuyin.player

import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * 出网层：平台 API 代理 + 直链探测。
 *
 * 和桌面端（src-tauri/src/net.rs）一一对应，返回的 JSON 形状必须完全一致——
 * 前端 `tauriNet.ts` / `online.ts` 那一套取链、校验、兜底逻辑是照着这个形状写的，
 * 这里少一个字段，那边就会把「能播」判成「放错歌」。
 *
 * 为什么要走原生而不是 WebView 里 fetch：音乐平台接口一律不回
 * `Access-Control-Allow-Origin`，WebView 里直接请求会被 CORS 挡死。
 */
object Http {

    /**
     * 一次普通请求。返回值：{"status":200,"headers":{...},"body":"..."}
     * headers 的 key 一律小写（前端按 content-type 这种写法取）。
     */
    fun request(
        url: String,
        method: String = "GET",
        headers: Map<String, String> = emptyMap(),
        body: String? = null,
        timeoutMs: Int = 10_000,
    ): JSONObject {
        var current = url
        var verb = method.uppercase()
        var hops = 0
        while (true) {
            val conn = open(current, verb, headers, body, timeoutMs)
            val code = conn.responseCode
            // 跨协议重定向（http→https）HttpURLConnection 默认不跟，自己跟
            if (code in 301..308 && hops < 5) {
                val loc = conn.getHeaderField("Location")
                conn.disconnect()
                if (!loc.isNullOrBlank()) {
                    current = if (loc.startsWith("http")) loc else URL(URL(current), loc).toString()
                    hops++
                    if (code == 303) { verb = "GET"; }
                    continue
                }
            }
            val text = try {
                conn.inputStream.use { readText(it, charsetOf(conn.contentType)) }
            } catch (e: Exception) {
                // 4xx/5xx 的 body 在 errorStream 里——平台经常把错误原因写在里面，
                // 丢掉它会让排查变成猜谜
                conn.errorStream?.use { readText(it, charsetOf(conn.contentType)) } ?: ""
            }
            val h = JSONObject()
            for ((k, v) in conn.headerFields) {
                if (k == null) continue
                // Set-Cookie 是多值且值里自带 `Expires=Wed, 21 Oct…` 这种逗号，
                // 用 ", " 拼起来会再也拆不开（登录凭证就是这么丢的）——按行拼。
                val joined = if (k.equals("set-cookie", true)) v.joinToString("\n") else v.joinToString(", ")
                h.put(k.lowercase(), joined)
            }
            val out = JSONObject()
            out.put("status", code)
            out.put("headers", h)
            out.put("body", text)
            conn.disconnect()
            return out
        }
    }

    private fun open(
        url: String,
        verb: String,
        headers: Map<String, String>,
        body: String?,
        timeoutMs: Int,
    ): HttpURLConnection {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.requestMethod = verb
        conn.instanceFollowRedirects = false
        conn.connectTimeout = timeoutMs.coerceIn(1_000, 60_000)
        conn.readTimeout = timeoutMs.coerceIn(1_000, 60_000)
        conn.useCaches = false
        // Host / Content-Length 交给 JVM 自己算，手写会和实际字节数对不上
        for ((k, v) in headers) {
            if (k.equals("host", true) || k.equals("content-length", true)) continue
            conn.setRequestProperty(k, v)
        }
        if (body != null && verb != "GET" && verb != "HEAD") {
            conn.doOutput = true
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
        }
        return conn
    }

    private fun charsetOf(contentType: String?): String {
        val m = Regex("charset=([\\w\\-]+)", RegexOption.IGNORE_CASE).find(contentType ?: "")
        return m?.groupValues?.get(1) ?: "UTF-8"
    }

    /** 读成文本。按 Content-Type 声明的字符集解；解不了就 UTF-8，再不行 GB18030（国产接口偶有 GBK） */
    private fun readText(input: InputStream, charset: String): String {
        val bytes = input.readBytes()
        if (bytes.isEmpty()) return ""
        val enc = try {
            java.nio.charset.Charset.forName(charset)
        } catch (_: Exception) {
            Charsets.UTF_8
        }
        var s = String(bytes, enc)
        // UTF-8 解出来的替换符太多 → 多半其实是 GBK 一类的编码
        if (s.count { it == '\uFFFD' } > 2) {
            val alt = try { String(bytes, java.nio.charset.Charset.forName("GB18030")) } catch (_: Exception) { null }
            if (alt != null && alt.count { it == '\uFFFD' } < s.count { it == '\uFFFD' }) s = alt
        }
        return s
    }

    /* ------------------------------------------------------------------ */
    /* 直链探测                                                            */
    /* ------------------------------------------------------------------ */

    /**
     * 探测一条直链是否真能播，并尽量读出「真实时长」。
     *
     * 取链成功 ≠ 能播：平台经常回 403 / 空 body / HTML 错误页。
     * 而「能播」也不等于「是这首歌」——音源给错歌是常态，
     * 所以要把时长读回来给上层比对（见 online.ts 的 verify）。
     */
    fun probe(url: String): JSONObject {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.requestMethod = "GET"
        conn.instanceFollowRedirects = true
        conn.connectTimeout = 12_000
        conn.readTimeout = 12_000
        conn.useCaches = false
        // 16KB：带封面的 ID3 常常超过 2KB，只读一点连第一帧都摸不到
        conn.setRequestProperty("Range", "bytes=0-16383")

        val status = try { conn.responseCode } catch (e: Exception) {
            throw IllegalStateException("探测失败：${e.message}")
        }
        val ct = conn.contentType ?: ""
        var total = 0L
        val cr = conn.getHeaderField("Content-Range")
        if (cr != null) {
            cr.substringAfterLast('/', "").trim().toLongOrNull()?.let { total = it }
        } else {
            conn.contentLengthLong.let { if (it > 0) total = it }
        }

        val buf = ByteArrayOutputStream()
        try {
            val input = conn.inputStream
            val chunk = ByteArray(4096)
            while (buf.size() < 16384) {
                val n = input.read(chunk)
                if (n <= 0) break
                buf.write(chunk, 0, n)
            }
            input.close()
        } catch (_: Exception) { /* 只读到一部分也算 */ }
        conn.disconnect()

        val head = buf.toByteArray()
        val dur = sniffDuration(head, total, ct)
        return JSONObject().apply {
            put("got", head.size)
            put("total", total)
            // 两个键都写：Rust 侧结构体叫 content_type，前端 TS 接口写的是 contentType，
            // 历史上各取各的，这里一并给出，避免任何一边读到 undefined
            put("content_type", ct)
            put("contentType", ct)
            put("status", status)
            put("duration", dur)
        }
    }

    /* ------------------------------------------------------------------ */
    /* 文件头里读时长（移植自 net.rs）                                      */
    /* ------------------------------------------------------------------ */

    private fun be32(b: ByteArray, at: Int): Long {
        if (at + 4 > b.size) return 0
        return ((b[at].toLong() and 0xFF) shl 24) or
            ((b[at + 1].toLong() and 0xFF) shl 16) or
            ((b[at + 2].toLong() and 0xFF) shl 8) or
            (b[at + 3].toLong() and 0xFF)
    }

    private fun at(b: ByteArray, i: Int): Int = if (i < b.size) b[i].toInt() and 0xFF else 0

    /** ID3v2 标签长度（MP3 音频数据从它之后开始） */
    private fun id3Len(h: ByteArray): Int {
        if (h.size >= 10 && h[0] == 'I'.code.toByte() && h[1] == 'D'.code.toByte() && h[2] == '3'.code.toByte()) {
            val sz = (at(h, 6) shl 21) or (at(h, 7) shl 14) or (at(h, 8) shl 7) or at(h, 9)
            return 10 + sz
        }
        return 0
    }

    private fun flacDuration(h: ByteArray): Double {
        if (h.size < 42) return 0.0
        if (!(h[0] == 'f'.code.toByte() && h[1] == 'L'.code.toByte() && h[2] == 'a'.code.toByte() && h[3] == 'C'.code.toByte())) return 0.0
        val s = 8 // STREAMINFO 起点
        val sr = ((at(h, s + 10).toLong()) shl 12) or (at(h, s + 11).toLong() shl 4) or (at(h, s + 12).toLong() shr 4)
        val total = ((at(h, s + 13).toLong() and 0x0F) shl 32) or be32(h, s + 14)
        if (sr == 0L || total == 0L) return 0.0
        return total.toDouble() / sr.toDouble()
    }

    private val BR_MPEG1 = intArrayOf(0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0)
    private val BR_MPEG2 = intArrayOf(0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0)

    private fun mp3Duration(h: ByteArray, total: Long): Double {
        val off = id3Len(h)
        if (off >= h.size) return 0.0
        var i = off
        while (i < h.size - 4) {
            if (at(h, i) != 0xFF || (at(h, i + 1) and 0xE0) != 0xE0) { i++; continue }
            val ver = (at(h, i + 1) shr 3) and 0x03   // 3=MPEG1 2=MPEG2 0=MPEG2.5
            val layer = (at(h, i + 1) shr 1) and 0x03 // 1=Layer III
            val brI = (at(h, i + 2) shr 4) and 0x0F
            val srI = (at(h, i + 2) shr 2) and 0x03
            if (layer != 1 || brI == 0 || brI == 15 || srI == 3) { i++; continue }
            val mpeg1 = ver == 3
            val br = if (mpeg1) BR_MPEG1[brI] else BR_MPEG2[brI]
            val sr = when {
                mpeg1 && srI == 0 -> 44100
                mpeg1 && srI == 1 -> 48000
                mpeg1 && srI == 2 -> 32000
                !mpeg1 && srI == 0 -> 22050
                !mpeg1 && srI == 1 -> 24000
                !mpeg1 && srI == 2 -> 16000
                else -> 11025
            }
            val mono = ((at(h, i + 3) shr 6) and 0x03) == 3
            val spf = if (mpeg1) 1152 else 576
            val side = if (mpeg1) (if (mono) 17 else 32) else (if (mono) 9 else 17)
            val x = i + 4 + side
            if (x + 12 <= h.size) {
                val tag = String(h, x, 4, Charsets.ISO_8859_1)
                if (tag == "Xing" || tag == "Info") {
                    val flags = be32(h, x + 4)
                    if (flags and 1L != 0L) {
                        val frames = be32(h, x + 8)
                        if (frames > 0) return frames.toDouble() * spf.toDouble() / sr.toDouble()
                    }
                }
            }
            // 没有 Xing：按首帧码率当 CBR 估算（真 CBR 很准，VBR 偏，够用）
            if (total > 0 && br > 0) return total.toDouble() * 8.0 / (br.toDouble() * 1000.0)
            return 0.0
        }
        return 0.0
    }

    private fun mp4FindMvhd(b: ByteArray, start: Int, end: Int, depth: Int): Double {
        if (depth > 3) return 0.0
        var p = start
        val e = minOf(end, b.size)
        while (p + 8 <= e) {
            val size = be32(b, p).toInt()
            val typ = String(b, p + 4, 4, Charsets.ISO_8859_1)
            val body = p + 8
            if (typ == "mvhd") return mp4Mvhd(b, body)
            if (typ == "moov") {
                val r = mp4FindMvhd(b, body, if (size > 8) p + size else e, depth + 1)
                if (r > 0.0) return r
            }
            if (size < 8) break
            p += size
        }
        return 0.0
    }

    private fun mp4Mvhd(b: ByteArray, body: Int): Double {
        if (body + 20 > b.size) return 0.0
        val ver = at(b, body)
        return if (ver == 1) {
            if (body + 32 > b.size) return 0.0
            val scale = be32(b, body + 20)
            val dur = be32(b, body + 24)
            if (scale > 0) dur.toDouble() / scale.toDouble() else 0.0
        } else {
            val scale = be32(b, body + 12)
            val dur = be32(b, body + 16)
            if (scale > 0) dur.toDouble() / scale.toDouble() else 0.0
        }
    }

    fun sniffDuration(h: ByteArray, total: Long, contentType: String): Double {
        val ct = contentType.lowercase()
        val isFlac = ct.contains("flac") || (h.size > 4 && h[0] == 'f'.code.toByte() && h[1] == 'L'.code.toByte())
        val isMp4 = ct.contains("mp4") || ct.contains("m4a") || (h.size > 8 && String(h, 4, 4, Charsets.ISO_8859_1) == "ftyp")
        val isMp3 = ct.contains("mpeg") || ct.contains("mp3")
        val d = when {
            isFlac -> flacDuration(h)
            isMp4 -> mp4FindMvhd(h, 0, h.size, 0)
            isMp3 -> mp3Duration(h, total)
            else -> 0.0
        }
        // 一小时以下的才算数：读歪了会得到天文数字，那种宁可不给
        return if (d > 0.0 && d < 36_000.0) Math.round(d * 10.0) / 10.0 else 0.0
    }
}
