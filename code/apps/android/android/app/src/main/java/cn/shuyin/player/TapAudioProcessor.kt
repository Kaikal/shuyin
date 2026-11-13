package cn.shuyin.player

import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.BaseAudioProcessor
import androidx.media3.common.util.UnstableApi
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.log10
import kotlin.math.pow
import kotlin.math.sqrt

/**
 * 频谱的数据源：在音频送去扬声器之前，把解码后的 PCM 复制一份。
 *
 * 为什么不用 `android.media.audiofx.Visualizer`：
 * Visualizer 走的是「采集系统输出音频」这条路，系统把它当成一次录音，
 * **必须授 RECORD_AUDIO**——一个音乐播放器张口要麦克风权限，用户第一反应就是
 * 「你想干什么」。而且实测（华为 ALN-AL00）即使给了权限，
 * `onFftDataCapture` 每帧 1024 字节也全是 0，只有时域波形能拿到真数据。
 *
 * 换成 ExoPlayer 的 AudioProcessor 之后：拿的是**自己解码出来的原始 PCM**，
 * 零权限、零额外流量，而且和播放进度严格同步（数据流经此处时正是要出声的那一刻）。
 *
 * 这个类是**纯旁路**：`queueInput` 把数据原样写到输出缓冲，音质、音量、
 * 声道数一个字节都不改；复制出来的那一份只喂给后台的分析线程。
 *
 * 线程模型：
 *   · `queueInput` 跑在 ExoPlayer 的音频线程上，只做一次数组拷贝（几 KB），
 *     绝不能在这里算 FFT——那一帧算不完就是爆音。
 *   · 分析线程每帧读走环形缓冲里最新的一段，算完写 `spectrum`。
 *   · 前端读 `spectrum`（volatile 引用，整帧替换，永远读到完整的一帧）。
 */
@UnstableApi
class TapAudioProcessor : BaseAudioProcessor() {

    companion object {
        /** 和桌面 Rust 侧、以及前端那圈柱子一致 */
        const val BANDS = 40

        /** 环形缓冲：48k 单声道下约 170ms，够分析窗口来回取 */
        private const val RING = 8192
        private const val RING_MASK = RING - 1

        /** 分析窗口取最近这么多点（48k 下约 42ms，够覆盖低频一个周期） */
        private const val WINDOW = 2048

        /** 分析节奏：约 20Hz。再快人眼看不出，只是白烧 CPU */
        private const val FRAME_MS = 50L
    }

    /* ---------------- 音频线程写、分析线程读 ---------------- */

    /** 单声道混合后的采样，-1..1 */
    private val ring = FloatArray(RING)

    /** 写指针（只有音频线程改）。用 @Volatile 发布给分析线程 */
    @Volatile
    private var written = 0L

    /** 采样率：`onConfigure` 给的真值，比猜系统 OUTPUT_SAMPLE_RATE 准 */
    @Volatile
    private var sampleRate = 44100

    @Volatile
    private var channels = 2

    @Volatile
    private var encoding = C.ENCODING_INVALID

    /** 当前这一帧频谱（整帧替换，读端不会看到半帧） */
    @Volatile
    var spectrum: FloatArray = FloatArray(BANDS)
        private set

    private var worker: Thread? = null

    @Volatile
    private var running = false

    /** 上一轮看到的写指针：没变说明音频没在流（暂停/缓冲中），频谱该归零 */
    private var lastSeen = -1L

    /* ---------------- AudioProcessor ---------------- */

    /**
     * 原样返回输入格式 = 只旁路不加工。
     *
     * 返回 NOT_SET 会让这个 processor 变「不活跃」，整条链就把它跳过，
     * `queueInput` 一次都不会被调到——那频谱就永远是静音。
     */
    override fun onConfigure(inputAudioFormat: AudioProcessor.AudioFormat): AudioProcessor.AudioFormat {
        sampleRate = inputAudioFormat.sampleRate
        channels = inputAudioFormat.channelCount.coerceAtLeast(1)
        encoding = inputAudioFormat.encoding
        /* 换格式（换歌、切输出设备）时清空，别把上一首的尾巴画出来 */
        written = 0
        ring.fill(0f)
        return inputAudioFormat
    }

    override fun queueInput(inputBuffer: ByteBuffer) {
        val size = inputBuffer.remaining()
        if (size <= 0) return
        /* 先抄一份给分析器：下面 `put` 会把 inputBuffer 读到底 */
        tap(inputBuffer)
        /* 再原样搬进输出缓冲——这一步是「放了」而不是「拦了」 */
        val out = replaceOutputBuffer(size)
        out.put(inputBuffer)
        out.flip()
    }

    override fun onFlush() {
        written = 0
        ring.fill(0f)
    }

    override fun onReset() {
        written = 0
        ring.fill(0f)
    }

    /* ---------------- 抄数据 ---------------- */

    /**
     * 把一帧 PCM 混成单声道写进环形缓冲。
     *
     * 用 `duplicate()` 是因为 `queueInput` 后面还要拿原 buffer 输出，
     * 在这里读掉 position 的话，送出去的就只剩半首歌了。
     */
    private fun tap(inputBuffer: ByteBuffer) {
        val dup = inputBuffer.duplicate().order(ByteOrder.nativeOrder())
        val ch = channels.coerceAtLeast(1)
        var w = written
        when (encoding) {
            C.ENCODING_PCM_16BIT -> {
                val frames = dup.remaining() / (2 * ch)
                for (i in 0 until frames) {
                    var acc = 0f
                    for (c in 0 until ch) acc += dup.getShort().toFloat() / 32768f
                    ring[(w++).toInt() and RING_MASK] = acc / ch
                }
            }
            C.ENCODING_PCM_FLOAT -> {
                val frames = dup.remaining() / (4 * ch)
                for (i in 0 until frames) {
                    var acc = 0f
                    for (c in 0 until ch) acc += dup.getFloat()
                    ring[(w++).toInt() and RING_MASK] = acc / ch
                }
            }
            C.ENCODING_PCM_8BIT -> {
                val frames = dup.remaining() / ch
                for (i in 0 until frames) {
                    var acc = 0f
                    for (c in 0 until ch) acc += ((dup.get().toInt() and 0xFF) - 128) / 128f
                    ring[(w++).toInt() and RING_MASK] = acc / ch
                }
            }
            else -> {
                /* 24/32 bit 之类少见格式：不抄，频谱退化成呼吸环，播放本身不受影响 */
                return
            }
        }
        written = w
    }

    /* ---------------- 分析线程 ---------------- */

    fun start() {
        if (running) return
        running = true
        worker = Thread({ loop() }, "sy-spectrum").apply {
            priority = Thread.MIN_PRIORITY
            isDaemon = true
            start()
        }
    }

    fun shutdown() {
        running = false
        worker?.interrupt()
        worker = null
        spectrum = FloatArray(BANDS)
    }

    private fun loop() {
        while (running) {
            try {
                val now = written
                if (now == lastSeen) {
                    /* 没有新数据（暂停 / 缓冲中）：衰减到 0，别把上一帧钉在屏幕上 */
                    spectrum = FloatArray(BANDS)
                } else {
                    lastSeen = now
                    val bands = analyse(now)
                    spectrum = bands
                }
            } catch (_: InterruptedException) {
                return
            } catch (_: Throwable) {
                /* 算崩了不能把播放带下水：这一帧跳过，下一帧接着来 */
            }
            try {
                Thread.sleep(FRAME_MS)
            } catch (_: InterruptedException) {
                return
            }
        }
    }

    /**
     * 取最近 WINDOW 个采样算 40 段。
     *
     * 用 Goertzel 而不是 FFT：我们只需要 40 个**指定的**频点（对数分布），
     * Goertzel 每个频点 O(N) 且不需要 2 的幂长度，40 × 2048 次乘加
     * 在低优先级线程上无感；而 FFT 要算全频谱再挑点，白算 20 倍。
     */
    private fun analyse(w: Long): FloatArray {
        val n = WINDOW.coerceAtMost(w.toInt().coerceAtLeast(0))
        if (n < 256) return FloatArray(BANDS)
        val fs = sampleRate.toDouble().takeIf { it > 8000 } ?: 44100.0
        val start = w - n
        val out = FloatArray(BANDS)
        for (i in 0 until BANDS) {
            /* 55Hz（贝斯）到 15kHz（镲片），对数等分——线性分箱会把柱子全挤在低频 */
            val f = 55.0 * (15000.0 / 55.0).pow(i.toDouble() / (BANDS - 1))
            val k = 2.0 * cos(2.0 * Math.PI * f / fs)
            var s1 = 0.0
            var s2 = 0.0
            for (j in 0 until n) {
                val v = ring[(start + j).toInt() and RING_MASK].toDouble()
                val s0 = v + k * s1 - s2
                s2 = s1
                s1 = s0
            }
            val power = (s1 * s1 + s2 * s2 - k * s1 * s2).coerceAtLeast(0.0)
            val amp = sqrt(power) / n
            /* 满幅正弦在这里约 -6dB；-84..-22 映射到 0..1，和原来波形那条路的标定一致 */
            val db = 20.0 * log10(amp + 1e-7)
            out[i] = ((db + 84.0) / 62.0).coerceIn(0.0, 1.0).toFloat()
        }
        /* 全静音时留一条平线，而不是一圈满格 */
        var peak = 0f
        for (v in out) if (abs(v) > peak) peak = v
        return if (peak < 0.02f) FloatArray(BANDS) else out
    }
}
