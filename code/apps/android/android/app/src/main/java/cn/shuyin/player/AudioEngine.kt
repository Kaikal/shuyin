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
import androidx.media3.datasource.HttpDataSource
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy

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

    companion object {
        /**
         * 「音量保护」总闸（设置页那个开关的真值在这）。
         *
         * 关掉之后所有音量变化都回到瞬时的老行为——那是排查「是不是淡入淡出搞的鬼」
         * 时唯一能做的对照实验。
         */
        @Volatile
        var guard: Boolean = true

        /** 起播淡入：从 0 爬到用户音量。太短听得见「啪」，太长像卡了一下 */
        const val FADE_IN_MS = 260
        /** 暂停淡出：比淡入短得多，用户按了就得「立刻停」 */
        const val FADE_OUT_MS = 80
        /** 音量调整 / 被压低后恢复的默认时长 */
        const val RAMP_MS = 120
        /** 被系统压低（来电、导航播报）结束后的回升：慢一点，别把耳朵吓一跳 */
        const val UNDUCK_MS = 520
    }

    val exo: ExoPlayer

    private val ui = android.os.Handler(android.os.Looper.getMainLooper())

    /** 正在跑的渐变；新的变化直接顶掉旧的（否则两段会互相拉扯） */
    private var ramp: Runnable? = null
    private var rampSeq = 0

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

    /**
     * 最近一次错误的可读描述。
     *
     * `onError` 的签名为了兼容原来的 MediaPlayer 形状只带 (what, extra)，而
     * 「2001」这种码说不清是 DNS 挂了、WiFi 掉了还是 403 防盗链——
     * 排查「在线歌放着放着停了」时这四者要采取的动作完全不同。Service 拼日志时读这里。
     */
    var lastErrorDetail: String = ""
        private set

    /** 用户设定的音量（0..1）。暂停时 exo.volume 会被临时压成 0，恢复时按它还原 */
    private var userVolume = 1f

    /** 「现在不该出声」：暂停之后、`start()` 之前。见 [pause] */
    private var muted = false

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
            .setLoadErrorHandlingPolicy(NetTolerantPolicy())

        /*
         * **缓冲要够一首歌，不能停在默认的 50 秒。**
         *
         * ExoPlayer 的默认 LoadControl 是「最少 50 秒 / 最多 50 秒」：缓冲到 50 秒就
         * 停止下载。于是界面上那条淡色「已加载」在在线曲目上永远只走一小段
         * （两分钟的歌正好停在**一半**左右），用户以为「加载到一半坏了」；
         * 暂停之后也不再往下取，恢复播放时又一次卡在缓冲边界上。
         *
         * 这里把上限抬到 10 分钟（音乐文件 3~15MB，整首缓冲完全吃得下）：
         *   · 暂停时继续把整首下完——用户看到的是「加载满了」，恢复时立刻出声；
         *   · 拖动进度条落到未缓冲区间也不会卡；
         *   · 起播门槛单独压到 1.2 秒，比默认 2.5 秒更快出声。
         */
        val buffer = DefaultLoadControl.Builder()
            .setBufferDurationsMs(
                /* minBufferMs */ 20_000,
                /* maxBufferMs */ 10 * 60_000,
                /* bufferForPlaybackMs */ 1_200,
                /* bufferForPlaybackAfterRebufferMs */ 2_500,
            )
            .build()

        exo = ExoPlayer.Builder(context, renderers)
            .setMediaSourceFactory(sources)
            .setLoadControl(buffer)
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

        /*
         * **不许在 prepare 完成时自己开播。**
         *
         * ExoPlayer 的 `playWhenReady` 默认是 **true**：`prepare()` 一到 READY 就出声，
         * 不管你上层想不想播。而我们的 `open()` 是带 `autoplay` 的（会话恢复、
         * 恢复上次曲目那种情况明确要求「加载好但别放」），暂停也发生在
         * 「缓冲中」这个窗口里——结果就是：用户点了暂停，几秒后缓冲完，音乐自己响。
         * 这里把默认值压成 false，起播只能来自显式的 `start()`（= `exo.play()`），
         * 也就是 `onPrepared` 里那句 `if (wantPlay) player.start()`。
         */
        exo.playWhenReady = false

        /* 播放期间保 CPU 醒着（原 MediaPlayer.setWakeMode(PARTIAL_WAKE_LOCK) 的等价物） */
        try {
            exo.setWakeMode(C.WAKE_MODE_NETWORK)
            LockScreen.trace("wakeMode=NETWORK ok")
        } catch (t: Throwable) {
            /* 个别 ROM 不支持，最坏情况是息屏后网络流变慢，不影响正确性 */
            LockScreen.trace("wakeMode=NETWORK 失败 ${t.javaClass.simpleName}")
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
                lastErrorDetail = buildString {
                    append(error.errorCodeName)
                    val c = error.cause
                    if (c != null) {
                        append(' ')
                        append(c.javaClass.simpleName)
                        val m = c.message
                        if (!m.isNullOrBlank()) append(": ").append(m.take(160))
                    }
                }
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

    /**
     * **用户视角的「在播」：缓冲中 / 卡顿重缓冲也算。**
     *
     * 界面上的播放键、通知图标、媒体会话里的状态，判断依据必须是
     * 「用户觉得它现在该不该在放」，而不是「音频管线此刻有没有在吐样本」。
     *
     * `exo.isPlaying` 的定义是 `playWhenReady && state == READY`，于是**网络流缓冲
     * 那几秒里它是 false** —— 界面于是把按钮画成 ▶（暂停），用户看到「怎么自己在暂停」
     * 就点一下，前端按 `snapshot.playing === false` 把这一下翻译成 **resume**，
     * 结果声音照旧、缓冲一完就接着唱。用户的原话是「没加载好的歌，点了暂停它不停，
     * 过几秒才好」—— 就是这个错位。
     *
     * 换成「意图 + 没播完」：缓冲中仍然是「在播」（按钮该显示 ⏸，点下去就是暂停），
     * 播完（ENDED）和空转（IDLE）才算停。
     */
    val active: Boolean
        get() = exo.playWhenReady &&
            exo.playbackState != Player.STATE_ENDED &&
            exo.playbackState != Player.STATE_IDLE

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

    fun start() {
        /*
         * **起播必须淡入。**
         *
         * 用户说的「音量突然变大」有一半出在这里：上一首是满音量，切歌时新播放器
         * 一建好就是 `userVolume`，`play()` 的第一个采样直接顶满——听感是「啪」一下。
         * 被别的应用压低（duck）之后恢复、来电挂断后续播，也都是同一个形状。
         *
         * 所以起播先把增益压到 0，`play()` 之后再爬到用户音量。`wasMuted` 用来区分
         * 「从暂停里起来」（该淡入）和「已经在放、只是又被 start 一次」（不该有凹陷）。
         */
        val wasMuted = muted
        muted = false
        /*
         * **`play()` 不是「从任何状态都能出声」。**
         *
         * 用户报的那条很具体：「偶尔点击播放按钮但歌曲播不起来，这首歌是已缓存的
         * 歌曲，切换下一曲再切上一首又可以播放了」。缓存歌走的是本地文件、不涉及
         * 取链，那问题就只可能出在**播放器状态**上：
         *
         *   · `STATE_ENDED` —— 放到尾了。`play()` 只会把 `playWhenReady` 置回 true，
         *     状态还是 ENDED，一个样本都不吐。用户按了播放，界面翻了图标，没有声音。
         *     （队列放到最后一首 `advance` 返回 null 时前端会 `bridge.stop()`）
         *   · `STATE_IDLE` —— 被 `stop()` 过 / 上次 `prepare()` 失败了。同样不吐样本，
         *     得先 `prepare()` 才有 READY。
         *
         * 这两种状态在用户眼里都叫「暂停中」，按下去理应接着响。所以这里补上：
         * 放完的从头来，被停掉的重新准备一次（`stop()` 会保留播放位置，
         * `prepare()` 从原处继续）。
         */
        try {
            when (exo.playbackState) {
                Player.STATE_ENDED -> exo.seekTo(0)
                Player.STATE_IDLE -> exo.prepare()
                else -> Unit
            }
        } catch (_: Throwable) {
            /* 没有媒体项 / 源已经被释放：让这次 start 失败，前端有兜底（见 toggle 的 resume 守护） */
        }
        if (wasMuted) exo.volume = 0f
        exo.play()
        fadeTo(userVolume, if (wasMuted) FADE_IN_MS else RAMP_MS)
    }

    /**
     * **暂停要「当场静音」，不能只交给 `pause()`。**
     *
     * 真机实测（华为 ALN-AL00，外放，网络流）：点了暂停之后播放位置还会继续走
     * **约 1.1 秒**才冻住 —— `exo.pause()` 只是停止向 AudioSink 喂数据，
     * 而 AudioTrack 里已经排好的 PCM 会照常放完。用户听到的就是「我按了暂停，
     * 声音又唱了一两句才停」，越是缓冲充足（网络流刚下完一大段）越明显。
     *
     * 所以先把增益打到 0：音频线程一个回调周期（几十毫秒）内就听不见了，
     * `start()` 再把用户音量还回去。夹在 `setVolume` 里的 `muted` 保证
     * 「暂停期间调音量 / 被别家 App 压低」这些路径不会把尾巴放出来。
     *
     * 现在这 80ms 走的是渐变而不是硬切：硬切在波形上是一刀，会有轻微「咔」。
     * 80ms 在听感上仍然等于「立刻」，但尾巴断得干净。
     */
    fun pause() {
        /* 已经在静音态：说明上一次暂停还在淡出途中，这一下立刻静音，别再等 */
        if (muted) {
            cancelRamp()
            exo.volume = 0f
            safePause()
            return
        }
        muted = true
        /*
         * **状态先落账，声音再淡出。**
         *
         * `pause()` 只是 `playWhenReady = false`，AudioTrack 里已经排好的 PCM 照样放完
         * （老实现里那 1.1 秒的尾巴就是这么来的）。所以这里立刻把播放状态置为暂停，
         * 让 `active` / 通知 / 媒体会话当场翻面；同时用 80ms 把增益收到 0，
         * 把那条尾巴干净地掐掉——用户在听感上和视觉上都是「按了就停」，
         * 而不是「图标先停、声音又唱一句」或「声音停了、图标还是暂停中」。
         */
        safePause()
        if (!guard) {
            cancelRamp()
            exo.volume = 0f
            return
        }
        fadeTo(0f, FADE_OUT_MS)
    }

    fun stop() {
        cancelRamp()
        muted = false
        exo.volume = userVolume
        exo.stop()
    }

    /**
     * 慢慢收到静音再暂停（定时关闭用）。
     *
     * 和 [pause] 的区别只有时长：定时到点是「该睡了」，硬切会把半梦半醒的人吓醒，
     * 所以给 1.5~2.5 秒的淡出；中途用户自己按播放会走 [start]，`muted` 被清掉，
     * 这里挂着的回调发现 `muted == false` 就不再暂停了（等于「用户反悔」）。
     */
    fun fadeOutAndPause(ms: Int) {
        if (muted) return
        muted = true
        if (!guard || ms <= 0) {
            cancelRamp()
            exo.volume = 0f
            safePause()
            return
        }
        fadeTo(0f, ms) {
            if (!muted) return@fadeTo
            safePause()
        }
    }

    fun seekTo(ms: Int) = exo.seekTo(ms.coerceAtLeast(0).toLong())

    /**
     * 音量统一入口。
     *
     * `ms` 给「恢复」这类需要慢慢回来的场景留了口子：被压到 20% 之后一口气跳回
     * 100% 是 5 倍增益，听感上就是「突然变大」——那正是用户报的那一条。
     */
    fun setVolume(v: Float, ms: Int = RAMP_MS) {
        userVolume = v.coerceIn(0f, 1f)
        /* 暂停期间只记下来，别把被掐掉的尾巴又放出来 */
        if (muted) return
        fadeTo(userVolume, ms)
    }

    /**
     * 增益渐变。[then] 在到达目标之后执行（暂停就是靠它「先淡出再 pause」）。
     *
     * 用主线程 Handler 逐步走而不是 `AudioTrack.setVolume`：后者在 media3 里
     * 没有公开入口，而 `exo.volume` 每次赋值都会下发到 AudioSink，十几毫秒一次
     * 已经足够顺滑（16ms 一档、每档 <5% 增益，听不出台阶）。
     */
    private fun fadeTo(target: Float, ms: Int, then: (() -> Unit)? = null) {
        val end = target.coerceIn(0f, 1f)
        if (!guard || ms <= 0) {
            cancelRamp()
            exo.volume = end
            then?.invoke()
            return
        }
        cancelRamp()
        val from = try { exo.volume } catch (_: Throwable) { end }
        if (kotlin.math.abs(from - end) < 0.01f) {
            exo.volume = end
            then?.invoke()
            return
        }
        val seq = ++rampSeq
        val t0 = android.os.SystemClock.uptimeMillis()
        val step = object : Runnable {
            override fun run() {
                if (seq != rampSeq) return
                val k = ((android.os.SystemClock.uptimeMillis() - t0).toFloat() / ms).coerceIn(0f, 1f)
                try { exo.volume = from + (end - from) * k } catch (_: Throwable) { /* 已释放 */ }
                if (k >= 1f) {
                    ramp = null
                    then?.invoke()
                } else {
                    ui.postDelayed(this, 16)
                }
            }
        }
        ramp = step
        ui.post(step)
    }

    private fun cancelRamp() {
        rampSeq++
        ramp?.let { ui.removeCallbacks(it) }
        ramp = null
    }

    /** `pause()` 就是 `playWhenReady = false`；包一层免得释放之后抛异常 */
    private fun safePause() {
        try { exo.playWhenReady = false } catch (_: Throwable) {}
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
        /* 渐变还在跑的时候释放播放器，回调会摸到一个已 release 的 exo —— 先掐掉 */
        cancelRamp()
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

/**
 * 网络流的重试策略：**断网不要立刻判死**。
 *
 * 默认的 `DefaultLoadErrorHandlingPolicy` 只重试 3 次（1s/2s/3s），在网络流上
 * 意味着**断网 6 秒就彻底放弃**，播放器进入 IDLE、`onPlayerError` 报 2001。
 * 用户那边看到的就是「放着放着停了，亮屏一看停在某一首」——他 2026-11-16 报的
 * 「在线歌单过一段时间被系统冻结」正是这个形状（缓存歌不联网，所以不受影响）。
 *
 * 在线播放断网的来源不止一种：Doze 熄屏休眠、华为省电策略掐后台网络、
 * WiFi 休眠、路由器切换。它们全都是「过一会儿自己会好」，所以这里把
 * 网络类错误的重试窗口拉到约 5 分钟（40 次 × 退避 0.4→8s），网络一回来
 * ExoPlayer 自己就把缓冲接上了，不需要用户去点任何东西。
 *
 * **4xx 例外**：直链是平台临时签发的，过期/防盗链会回 403、歌被删回 404。
 * 这类错误重试一万次结果都一样，必须尽快交给上层换源，所以直接不给重试。
 * 429（限流）和 408（超时）是临时性的，照常退避重试。
 */
private class NetTolerantPolicy : DefaultLoadErrorHandlingPolicy() {

    override fun getMinimumLoadableRetryCount(dataType: Int): Int = 40

    override fun getRetryDelayMsFor(info: LoadErrorHandlingPolicy.LoadErrorInfo): Long {
        val http = (info.exception as? HttpDataSource.InvalidResponseCodeException)?.responseCode ?: 0
        if (http in 400..499 && http != 408 && http != 429) return C.TIME_UNSET
        if (info.errorCount > 60) return C.TIME_UNSET
        return when {
            info.errorCount <= 2 -> 400L
            info.errorCount <= 5 -> 1_500L
            info.errorCount <= 10 -> 4_000L
            else -> 8_000L
        }
    }
}

