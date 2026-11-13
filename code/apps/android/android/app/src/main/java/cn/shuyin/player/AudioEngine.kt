package cn.shuyin.player

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.net.Uri
import android.os.Build
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory

/**
 * 播放器的薄封装：里面是 ExoPlayer，外面保持 MediaPlayer 的那副脸。
 *
 * 为什么不直接在 PlaybackService 里到处写 `exo.xxx`：
 * 那个文件有 1500 行，`mp?.isPlaying` / `mp?.duration` / `safe { mp?.start() }`
 * 这类调用散在通知、锁屏、悬浮歌词、音频焦点、tick 里共二十多处。逐处改一遍，
 * 任何一处漏改都是「某个角落永远显示暂停」。包一层之后，
 * **换播放器这件事的影响面缩到这一个文件**，其余逻辑一行不动。
 *
 * 方法名故意取成 `start / pause / setVolume(v, v)` 这种 MediaPlayer 的形状，
 * 调用点连签名都不用动。
 */
@UnstableApi
class AudioEngine(context: Context, val tap: TapAudioProcessor) {

    val exo: ExoPlayer

    /**
     * 音效处理器：三段 EQ + 前置增益。
     *
     * 参数是**全局单例**（`FxAudioProcessor.set`），每首歌新建引擎时不需要再传一遍；
     * 在 AudioEngine 里创建只是为了让「音频链长什么样」全部留在这一个文件。
     */
    private val fx = FxAudioProcessor()

    /** prepare 完成（第一次 READY）。原 MediaPlayer 的 OnPreparedListener */
    var onPrepared: (() -> Unit)? = null

    /** 自然播完。原 OnCompletionListener */
    var onCompletion: (() -> Unit)? = null

    /** 出错。参数对齐 MediaPlayer 的 (what, extra)，调用点不用改 */
    var onError: ((Int, Int) -> Unit)? = null

    /** seek 落地。原 OnSeekCompleteListener */
    var onSeekComplete: (() -> Unit)? = null

    private var readyFired = false

    init {
        /*
         * 音频处理链里插我们的旁路。
         *
         * 注意：**没有** `DefaultRenderersFactory.setAudioProcessors` 这个方法
         * （那是网上示例里常见的写法，media3 里不存在）。处理器只能挂在 AudioSink 上，
         * 所以这里继承 RenderersFactory、重写 `buildAudioSink`，把 tap 塞进 sink 的链里。
         * `setAudioProcessors` 是**追加**在默认链之后的，拿到的已经是解码完成的 PCM。
         */
        val renderers = TapRenderers(context, tap, fx)

        /*
         * 出网：平台直链普遍按 UA / Referer 拦，和探测直链时保持同一副身份最容易复现
         * 「能播」的结果。原 MediaPlayer 走的是 setDataSource(ctx, uri, headers)。
         */
        val http = DefaultHttpDataSource.Factory()
            .setUserAgent("Mozilla/5.0 (Linux; Android ${Build.VERSION.RELEASE}) Shuyin")
            .setConnectTimeoutMs(15000)
            .setReadTimeoutMs(15000)
            .setAllowCrossProtocolRedirects(true)
        val sources = DefaultMediaSourceFactory(DefaultDataSource.Factory(context, http))

        exo = ExoPlayer.Builder(context, renderers)
            .setMediaSourceFactory(sources)
            /*
             * `handleAudioFocus = false`：焦点一直是 PlaybackService 自己在管
             * （带恢复栈的那套，见 requestFocus / onAudioFocusChange）。
             * 让 ExoPlayer 也管一份，两边会互相抢——正是之前修过的「两个应用互相踢」。
             */
            .setAudioAttributes(
                androidx.media3.common.AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                    .build(),
                /* handleAudioFocus = */ false,
            )
            .setHandleAudioBecomingNoisy(false)
            .build()

        /* 播放期间保 CPU 醒着（原 MediaPlayer.setWakeMode(PARTIAL_WAKE_LOCK) 的等价物） */
        try {
            exo.setWakeMode(C.WAKE_MODE_NETWORK)
        } catch (_: Throwable) {
            /* 个别 ROM 不支持，最坏情况是息屏后网络流变慢，不影响正确性 */
        }

        exo.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                when (state) {
                    Player.STATE_READY -> if (!readyFired) {
                        readyFired = true
                        onPrepared?.invoke()
                    }
                    Player.STATE_ENDED -> onCompletion?.invoke()
                    else -> Unit
                }
            }

            override fun onPlayerError(error: PlaybackException) {
                /*
                 * MediaPlayer 的 what/extra 是 PlaybackService 里拼错误文案用的。
                 * ExoPlayer 给的是 errorCode（1001 之类），形状塞进 extra 就够定位了。
                 */
                onError?.invoke(1, error.errorCode)
            }

            override fun onPositionDiscontinuity(
                oldPosition: Player.PositionInfo,
                newPosition: Player.PositionInfo,
                reason: Int,
            ) {
                if (reason == Player.DISCONTINUITY_REASON_SEEK) onSeekComplete?.invoke()
            }
        })
    }

    /* ---------------- MediaPlayer 形状的接口 ---------------- */

    val isPlaying: Boolean get() = exo.isPlaying

    /** 毫秒；未准备好时 ExoPlayer 给 C.TIME_UNSET，换算成 0（调用点都按 0 = 未知处理） */
    val duration: Int
        get() = exo.duration.let { if (it == C.TIME_UNSET || it < 0) 0 else it.toInt() }

    val currentPosition: Int
        get() = exo.currentPosition.coerceAtLeast(0L).toInt()

    /** 已缓冲百分比 0..100（原 OnBufferingUpdateListener 的产物，改成按需算） */
    val bufferedPercent: Int
        get() {
            val d = exo.duration
            if (d == C.TIME_UNSET || d <= 0) return 0
            return (exo.bufferedPosition * 100 / d).coerceIn(0L, 100L).toInt()
        }

    fun start() = exo.play()

    fun pause() = exo.pause()

    fun stop() = exo.stop()

    fun seekTo(ms: Int) = exo.seekTo(ms.coerceAtLeast(0).toLong())

    fun setVolume(v: Float) {
        exo.volume = v.coerceIn(0f, 1f)
    }

    /**
     * 切输出设备。返回 Boolean 是为了对齐 `MediaPlayer.setPreferredDevice`
     * 的签名——调用点（cycleOutput）拿它决定提示「已切换」还是「切换失败」。
     * ExoPlayer 这边没法确认路由真的落地了，只能回报「命令下发了」。
     */
    fun setPreferredDevice(dev: AudioDeviceInfo): Boolean = try {
        exo.setPreferredAudioDevice(dev)
        true
    } catch (_: Throwable) {
        /* 老版本 media3 / 个别 ROM：选不了设备就当没选，别崩 */
        false
    }

    fun release() {
        try { exo.release() } catch (_: Throwable) {}
    }

    /**
     * 换音源。本地文件给 path，网络直链给 url（二选一）。
     *
     * 原实现是 `setDataSource(...)` + `prepareAsync()` 两步，这里合成一步，
     * 但**真正开始缓冲仍然是 `prepareAsync()`**——调用顺序没变，
     * 那些「先 setDataSource 再等 onPrepared」的逻辑照旧成立。
     */
    fun setSource(path: String?, url: String?) {
        readyFired = false
        val item = if (url != null) {
            MediaItem.fromUri(Uri.parse(url))
        } else {
            val p = path ?: throw IllegalStateException("没有曲目路径")
            MediaItem.fromUri(if (p.startsWith("content://")) Uri.parse(p) else Uri.fromFile(java.io.File(p)))
        }
        exo.setMediaItem(item)
    }

    fun prepareAsync() = exo.prepare()

    /**
     * 唯一的目的：把 [tap] 挂进 AudioSink 的处理器链。
     *
     * `buildAudioSink` 是 DefaultRenderersFactory 留给子类的扩展点，
     * 这里返回的 sink 和默认那个完全相同，只是多了一个旁路处理器。
     *
     * **顺序是 [fx] 在前、[tap] 在后**：声音先过 EQ，再给频谱取样。
     * 反过来（先取样再处理）会出现「低音拉满、柱子却没变」——
     * 桌面端也是 FX → 频谱，两端观感才对得上。
     */
    private class TapRenderers(
        context: Context,
        private val tapProcessor: TapAudioProcessor,
        private val fxProcessor: FxAudioProcessor,
    ) : DefaultRenderersFactory(context) {
        override fun buildAudioSink(
            context: Context,
            enableFloatOutput: Boolean,
            enableAudioTrackPlaybackParams: Boolean,
        ): AudioSink = DefaultAudioSink.Builder(context)
            .setAudioProcessors(arrayOf<AudioProcessor>(fxProcessor, tapProcessor))
            .build()
    }
}
