package cn.shuyin.player

import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.BaseAudioProcessor
import androidx.media3.common.util.UnstableApi
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.math.tanh

/**
 * 音效：五段图形均衡器 + 前置增益 + 声道平衡 + 空间音效。
 *
 * 频点与前端 `FX_BANDS_HZ` 一一对应：60 / 230 / 910 / 3.6k / 14k。
 * 首尾用架式滤波器（低架 / 高架），中间三段用峰值 —— 主流 5 段 EQ 的典型结构，
 * 曲线在两端不会「翘头」。系数公式与桌面 Rust 侧（`player.rs` 的 `FxSource`）逐行一致。
 *
 * 为什么不用 `android.media.audiofx.Equalizer`：
 *   · 频段/增益范围由机型写死，各家 Q 不同；
 *   · 蓝牙耳机（A2DP）下多数机型直接 `ERROR_NOT_SUPPORTED`，开关打开等于没开；
 *   · 要挂 `audioSessionId`，换歌重建播放器就得重新 attach，漏一次就静默失效。
 * 挂在解码之后的 PCM 上没有这些问题。
 *
 * 处理顺序：前置增益 → 5 段 EQ → 空间音效 → 声道平衡 → 软限幅，然后是频谱取样。
 *
 * ## 关于「电流音」（0.6.100 的回归）
 *
 * 旧版软限幅写的是 `if (x > 0.98) x = tanh(x)`。tanh(0.98) ≈ 0.753 ——
 * 也就是说一次采样刚过 0.98 就直接掉到 0.75，波形上是一个**垂直的台阶**，
 * 每次越过都在制造高频谐波，听感就是持续的「滋滋」电流声；低音预设抬得越狠越明显。
 * 现在换成**连续**的软拐点（0.85 以上才压，且一阶导数连续），越过拐点是平滑弯折。
 *
 * 另外 pre / 平衡增益改成逐采样一阶平滑（约 12ms 到位）：拖动推子时参数是一跳一跳
 * 下发的，直接乘上去就是台阶 → 又是「咔哒」声。
 *
 * 线程：`queueInput` 跑在 ExoPlayer 的音频线程上。参数放在 AtomicReference 里
 * 整组替换，避免读到「新的低频 + 旧的平衡」这种半套值。
 */
@UnstableApi
class FxAudioProcessor : BaseAudioProcessor() {

    companion object {
        /** 与前端 `FX_BANDS_HZ` 必须一致 */
        private val BANDS_HZ = floatArrayOf(60f, 230f, 910f, 3600f, 14000f)
        private val BAND_Q = floatArrayOf(0f, 1.0f, 1.0f, 1.0f, 0f)
        private const val MID_Q = 1.0f

        /** 空间音效：与前端 `FX_SPACES[].code` 一一对应 */
        const val SPACE_OFF = 0
        const val SPACE_ROTATE = 1
        const val SPACE_WIDE = 2
        const val SPACE_EAR = 3
        const val SPACE_LIVE = 4

        /** 下标 0..4 = 五段 dB，5 = 前置增益 dB，6 = 声道平衡，7 = 空间音效 */
        private val params = AtomicReference(FloatArray(8))
        private val version = AtomicInteger(0)

        /**
         * 参数下发口。没有播放器时也照存：下一首歌建引擎、`onConfigure` 时读到，
         * 于是「先调音效再放歌」也是对的。
         */
        fun set(bands: FloatArray?, pre: Float, balance: Float, space: Int) {
            val next = FloatArray(8)
            if (bands != null) {
                for (i in 0 until 5) {
                    next[i] = (bands.getOrNull(i) ?: 0f).coerceIn(-12f, 12f)
                }
            }
            next[5] = pre.coerceIn(-12f, 12f)
            next[6] = balance.coerceIn(-1f, 1f)
            next[7] = space.toFloat().coerceIn(0f, 4f)
            params.set(next)
            version.incrementAndGet()
        }

        /** 软限幅的拐点：低于它一个比特都不动 */
        private const val KNEE = 0.85f
    }

    private var sampleRate = 44100
    private var channels = 2
    private var encoding = C.ENCODING_INVALID

    private val filters = Array(5) { Biquad.PASS }
    private var preGain = 1f
    private var gainL = 1f
    private var gainR = 1f
    private var spaceCode = SPACE_OFF
    private var flat = true

    /** 每声道五段的状态（每段 z1/z2 = 10 个 float） */
    private var states = Array(2) { FloatArray(10) }
    /** 增益平滑用的一阶系数与当前值 */
    private var rampK = 0.002f
    private var preCur = 1f
    private var gainLCur = 1f
    private var gainRCur = 1f

    private var seenVersion = -1

    /** 复用的成帧缓冲：空间音效要同时看到左右，只能按帧处理 */
    private var frame = FloatArray(2)
    private val spatial = Spatial()

    override fun onConfigure(inputAudioFormat: AudioProcessor.AudioFormat): AudioProcessor.AudioFormat {
        sampleRate = inputAudioFormat.sampleRate.coerceAtLeast(8000)
        channels = inputAudioFormat.channelCount.coerceAtLeast(1)
        encoding = inputAudioFormat.encoding
        states = Array(channels) { FloatArray(10) }
        frame = FloatArray(channels.coerceAtLeast(1))
        /* 12ms 到位：再快就听得见「啪」，再慢推子会拖尾 */
        rampK = (1.0 - exp(-1.0 / (0.012 * sampleRate))).toFloat()
        spatial.prepare(sampleRate, channels)
        preCur = 1f
        gainLCur = 1f
        gainRCur = 1f
        refresh(force = true)
        /* 原样返回 = 只加工不换格式；返回 NOT_SET 会整条链被跳过 */
        return inputAudioFormat
    }

    override fun queueInput(inputBuffer: ByteBuffer) {
        val size = inputBuffer.remaining()
        if (size <= 0) return
        refresh()

        val out = replaceOutputBuffer(size)
        out.order(ByteOrder.nativeOrder())

        /* 原声 / 少见的 8·24·32bit：原样搬运，一个字节都不改 */
        if (flat || (encoding != C.ENCODING_PCM_16BIT && encoding != C.ENCODING_PCM_FLOAT)) {
            out.put(inputBuffer)
            out.flip()
            return
        }

        when (encoding) {
            C.ENCODING_PCM_16BIT -> process16(inputBuffer, out)
            C.ENCODING_PCM_FLOAT -> processFloat(inputBuffer, out)
            else -> out.put(inputBuffer)
        }
        out.flip()
    }

    override fun onFlush() = clearState()

    override fun onReset() = clearState()

    private fun clearState() {
        for (s in states) s.fill(0f)
        spatial.reset()
    }

    /**
     * 参数变了才重算系数。
     *
     * 参数没变时公式算出来是同一组数，状态完全有效；以前的版本无条件清滤波器状态，
     * 等于每个音频块都把滤波器瞬态重来一次 —— 那是「滋滋」声的另一个来源。
     * 现在只在 flush / seek / 换格式时清。
     */
    private fun refresh(force: Boolean = false) {
        val v = version.get()
        if (!force && v == seenVersion) return
        seenVersion = v

        val p = params.get()
        var any = false
        val fs = sampleRate.toFloat()
        for (i in 0 until 5) {
            val db = p[i]
            if (abs(db) >= 0.01f) any = true
            filters[i] = when (i) {
                0 -> Biquad.lowShelf(BANDS_HZ[0], db, fs)
                4 -> Biquad.highShelf(BANDS_HZ[4], db, fs)
                else -> Biquad.peaking(BANDS_HZ[i], db, BAND_Q[i].takeIf { it > 0f } ?: MID_Q, fs)
            }
        }

        val preDb = p[5]
        val bal = p[6]
        val sp = p[7].roundToInt().coerceIn(0, 4)
        if (abs(preDb) >= 0.01f || abs(bal) >= 0.001f || sp != SPACE_OFF) any = true
        preGain = 10f.pow(preDb / 20f)
        /* 平衡：往哪边偏就把另一侧压下去，居中时两侧都是 1 */
        gainL = if (bal <= 0f) 1f else 1f - bal
        gainR = if (bal >= 0f) 1f else 1f + bal
        if (sp != spaceCode) {
            spaceCode = sp
            spatial.setMode(sp)
        }

        flat = !any
    }

    private fun process16(input: ByteBuffer, out: ByteBuffer) {
        val src = input.duplicate().order(ByteOrder.nativeOrder())
        val ch = channels
        val f = frame
        val frames = src.remaining() / (2 * ch)
        for (n in 0 until frames) {
            for (c in 0 until ch) {
                f[c] = src.getShort().toFloat() / 32768f
            }
            runFrame(f, ch)
            for (c in 0 until ch) {
                out.putShort((f[c] * 32768f).roundToInt().coerceIn(-32768, 32767).toShort())
            }
        }
        /*
         * 必须把输入读到底：`BaseAudioProcessor` 靠 position 判断这一块有没有被消费，
         * 停在 0 会被当成「没处理完」，同一块 PCM 会被反复送进来。
         * 读的时候用的是 duplicate()，所以这里得手动把原 buffer 推到末尾。
         */
        input.position(input.limit())
    }

    private fun processFloat(input: ByteBuffer, out: ByteBuffer) {
        val src = input.duplicate().order(ByteOrder.nativeOrder())
        val ch = channels
        val f = frame
        val frames = src.remaining() / (4 * ch)
        for (n in 0 until frames) {
            for (c in 0 until ch) {
                f[c] = src.getFloat()
            }
            runFrame(f, ch)
            for (c in 0 until ch) {
                out.putFloat(f[c])
            }
        }
        input.position(input.limit())
    }

    /** 一帧：前置增益 → EQ → 空间音效 → 平衡 → 软限幅 */
    private fun runFrame(b: FloatArray, ch: Int) {
        preCur += (preGain - preCur) * rampK
        gainLCur += (gainL - gainLCur) * rampK
        gainRCur += (gainR - gainRCur) * rampK

        val pre = preCur
        for (c in 0 until ch) {
            var x = b[c] * pre
            val st = states[c]
            for (i in 0 until 5) {
                x = filters[i].tick(x, st, i * 2)
            }
            b[c] = x
        }

        if (spaceCode != SPACE_OFF) spatial.process(b, ch)

        for (c in 0 until ch) {
            b[c] = softClip(b[c] * if (c % 2 == 0) gainLCur else gainRCur)
        }
    }

    /**
     * 连续软限幅。
     *
     * 拐点以下原样返回；以上用 `KNEE + 余量 * tanh(...)`，在拐点处值与一阶导数都连续，
     * 所以越过拐点不会出现「波形台阶」。渐近线是 1.0，输出天然不越界。
     */
    private fun softClip(x: Float): Float {
        val a = abs(x)
        if (a <= KNEE) return x
        val head = 1f - KNEE
        val y = KNEE + head * tanh((a - KNEE) / head)
        return if (x < 0f) -y else y
    }

    /** RBJ cookbook 的三种双二阶，系数与 `player.rs` 的 `Biquad` 完全一致 */
    private class Biquad(
        private val b0: Float,
        private val b1: Float,
        private val b2: Float,
        private val a1: Float,
        private val a2: Float,
    ) {
        /** 转置直接 II 型；`st[o]`/`st[o+1]` 是这一段的 z1/z2 */
        fun tick(x: Float, st: FloatArray, o: Int): Float {
            val y = b0 * x + st[o]
            st[o] = b1 * x - a1 * y + st[o + 1]
            st[o + 1] = b2 * x - a2 * y
            return y
        }

        companion object {
            val PASS = Biquad(1f, 0f, 0f, 0f, 0f)

            fun lowShelf(f0: Float, gainDb: Float, fs: Float): Biquad {
                if (abs(gainDb) < 0.01f) return PASS
                val a = 10f.pow(gainDb / 40f)
                val w0 = 2f * PI.toFloat() * (f0 / fs).coerceIn(1e-4f, 0.49f)
                val cw = cos(w0)
                val sw = sin(w0)
                val alpha = sw / 2f * sqrt(2f) // S = 1
                val sa = sqrt(a)
                val b0 = a * ((a + 1f) - (a - 1f) * cw + 2f * sa * alpha)
                val b1 = 2f * a * ((a - 1f) - (a + 1f) * cw)
                val b2 = a * ((a + 1f) - (a - 1f) * cw - 2f * sa * alpha)
                val a0 = (a + 1f) + (a - 1f) * cw + 2f * sa * alpha
                val a1 = -2f * ((a - 1f) + (a + 1f) * cw)
                val a2 = (a + 1f) + (a - 1f) * cw - 2f * sa * alpha
                return Biquad(b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0)
            }

            fun highShelf(f0: Float, gainDb: Float, fs: Float): Biquad {
                if (abs(gainDb) < 0.01f) return PASS
                val a = 10f.pow(gainDb / 40f)
                val w0 = 2f * PI.toFloat() * (f0 / fs).coerceIn(1e-4f, 0.49f)
                val cw = cos(w0)
                val sw = sin(w0)
                val alpha = sw / 2f * sqrt(2f)
                val sa = sqrt(a)
                val b0 = a * ((a + 1f) + (a - 1f) * cw + 2f * sa * alpha)
                val b1 = -2f * a * ((a - 1f) + (a + 1f) * cw)
                val b2 = a * ((a + 1f) + (a - 1f) * cw - 2f * sa * alpha)
                val a0 = (a + 1f) - (a - 1f) * cw + 2f * sa * alpha
                val a1 = 2f * ((a - 1f) - (a + 1f) * cw)
                val a2 = (a + 1f) - (a - 1f) * cw - 2f * sa * alpha
                return Biquad(b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0)
            }

            fun peaking(f0: Float, gainDb: Float, q: Float, fs: Float): Biquad {
                if (abs(gainDb) < 0.01f) return PASS
                val a = 10f.pow(gainDb / 40f)
                val w0 = 2f * PI.toFloat() * (f0 / fs).coerceIn(1e-4f, 0.49f)
                val cw = cos(w0)
                val sw = sin(w0)
                val alpha = sw / (2f * q.coerceAtLeast(0.1f))
                val b0 = 1f + alpha * a
                val b1 = -2f * cw
                val b2 = 1f - alpha * a
                val a0 = 1f + alpha / a
                val a1 = -2f * cw
                val a2 = 1f - alpha / a
                return Biquad(b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0)
            }
        }
    }

    /**
     * 空间音效。全部逐帧处理（需要同时看到左右声道）。
     *
     * · 3D 旋转：等功率左右摆动 + 双耳时差（ITD，最多 0.5ms）。
     *   这是「8D 音乐」的经典做法——只靠音量摆位不够，加上时差才会觉得声音在**绕**。
     * · 宽广环绕：Mid/Side 拉开侧信号，声场变宽但人声不散。
     * · 耳机增强：对侧串音 + 700Hz 低通（模拟头部遮挡），久听不累。
     * · 现场：左右一组短梳状滤波器做出小型厅堂的早期反射。
     */
    private class Spatial {
        private var mode = 0
        private var fs = 44100

        /* rotate / ear 共用的延时环（≈3ms，够 0.5ms 的 ITD 用） */
        private val ringL = FloatArray(160)
        private val ringR = FloatArray(160)
        private var ri = 0

        private var lfoPhase = 0.0
        private var wRot = 0.0
        private var itdMax = 22

        private var lpL = 0f
        private var lpR = 0f
        private var lpA = 0.1f
        private var earDelay = 14

        private var cL = FloatArray(0)
        private var cR = FloatArray(0)
        private var ciL = 0
        private var ciR = 0
        private var dampL = 0f
        private var dampR = 0f

        fun prepare(sampleRate: Int, channels: Int) {
            fs = sampleRate
            /* 一圈约 12 秒，和主流「8D 环绕」的节奏接近 */
            wRot = 2.0 * PI * 0.085 / fs
            itdMax = (fs * 0.0005f).toInt().coerceIn(1, ringL.size - 2)
            earDelay = (fs * 0.00032f).toInt().coerceIn(1, ringL.size - 2)
            lpA = (1.0 - exp(-2.0 * PI * 700.0 / fs)).toFloat()
            /* 左右两条梳状用不同的长度，避免两耳听到同一个回声 */
            cL = FloatArray((fs * 0.023f).toInt().coerceAtLeast(8))
            cR = FloatArray((fs * 0.029f).toInt().coerceAtLeast(8))
            reset()
        }

        fun setMode(m: Int) {
            if (m == mode) return
            mode = m
            reset()
        }

        fun reset() {
            ringL.fill(0f)
            ringR.fill(0f)
            cL.fill(0f)
            cR.fill(0f)
            ri = 0
            ciL = 0
            ciR = 0
            dampL = 0f
            dampR = 0f
            lpL = 0f
            lpR = 0f
            lfoPhase = 0.0
        }

        fun process(b: FloatArray, ch: Int) {
            val l = b[0]
            val r = if (ch > 1) b[1] else b[0]
            ringL[ri] = l
            ringR[ri] = r
            val n = ringL.size

            var ol = l
            var or = r
            when (mode) {
                SPACE_ROTATE -> {
                    lfoPhase += wRot
                    if (lfoPhase > 2.0 * PI) lfoPhase -= 2.0 * PI
                    val s = sin(lfoPhase).toFloat()
                    /* 等功率摆位：pan 0 = 全左，1 = 全右 */
                    val pan = 0.5f + 0.5f * s
                    val gl = cos(pan * 1.5707964f)
                    val gr = sin(pan * 1.5707964f)
                    /* 右侧（远耳）延迟随位置变化：最多 0.5ms。
                       至少 1 个采样——ri 指的那格是给本帧写的，读它会拿到一圈前的旧值 */
                    val d = ((0.5f - 0.5f * s) * itdMax).toInt().coerceIn(1, n - 1)
                    val rDel = ringR[(ri - d + n) % n]
                    /* 留 45% 干声，听感是「绕」而不是「忽左忽右」 */
                    ol = (0.45f + 0.55f * gl) * l
                    or = (0.45f + 0.55f * gr) * rDel
                }
                SPACE_WIDE -> {
                    val m = (l + r) * 0.5f
                    val sd = (l - r) * 0.5f * 1.75f
                    ol = m + sd
                    or = m - sd
                }
                SPACE_EAR -> {
                    val rDel = ringR[(ri - earDelay + n) % n]
                    val lDel = ringL[(ri - earDelay + n) % n]
                    lpL += (rDel - lpL) * lpA
                    lpR += (lDel - lpR) * lpA
                    ol = 0.92f * l + 0.30f * lpL
                    or = 0.92f * r + 0.30f * lpR
                }
                SPACE_LIVE -> {
                    val yL = cL[ciL]
                    dampL = yL * 0.55f + dampL * 0.45f
                    cL[ciL] = l + dampL * 0.52f
                    ciL = (ciL + 1) % cL.size
                    val yR = cR[ciR]
                    dampR = yR * 0.55f + dampR * 0.45f
                    cR[ciR] = r + dampR * 0.52f
                    ciR = (ciR + 1) % cR.size
                    ol = l + yL * 0.32f
                    or = r + yR * 0.32f
                }
                else -> {
                    /* off */
                }
            }
            ri = (ri + 1) % n
            b[0] = ol
            if (ch > 1) b[1] = or
        }
    }
}
