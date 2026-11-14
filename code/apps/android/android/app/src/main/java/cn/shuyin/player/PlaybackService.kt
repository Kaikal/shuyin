package cn.shuyin.player

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.BroadcastReceiver
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.BitmapShader
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PorterDuff
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.net.Uri
import android.os.Build
import android.util.Log
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.widget.RemoteViews
import android.widget.Toast
import androidx.media3.common.util.UnstableApi
import org.json.JSONObject

/**
 * 播放服务：界面上所有「出声」的事都归它。
 *
 * 为什么必须是前台服务：安卓在应用退到后台后随时会回收进程，
 * 音乐播放器一旦被回收就是「切出去两分钟歌就停了」。前台服务 + MediaSession
 * 还顺带把锁屏 / 通知栏 / 蓝牙耳机 / 车机方控的按键都接了进来。
 *
 * 播放器是 media3 ExoPlayer，但**通过 [AudioEngine] 使用**——它保持了
 * MediaPlayer 的方法形状，所以这个文件里二十多处 `mp?.isPlaying` 之类一行没改。
 * 换播放器的唯一理由是频谱：ExoPlayer 允许插 AudioProcessor 旁路解码后的 PCM，
 * 不用申请 RECORD_AUDIO（见 TapAudioProcessor）。
 */
@UnstableApi
class PlaybackService : Service() {

    companion object {
        const val ACT_PLAY_FILE = "play_file"
        const val ACT_PLAY_URL = "play_url"
        const val ACT_PAUSE = "pause"
        const val ACT_RESUME = "resume"
        const val ACT_STOP = "stop"
        const val ACT_SEEK = "seek"
        const val ACT_VOLUME = "volume"
        const val ACT_META = "meta"
        const val ACT_TOGGLE = "toggle"
        /** 通知栏进度条的分段点击：extra 里带 zone 序号（0..19） */
        const val ACT_SEEK_ZONE = "seek_zone"
        /** 进度条切成几段热区（和 notif_media.xml 里的 n_s0..n_s19 一一对应） */
        const val SEEK_ZONES = 20

        /** 当前快照：`player_state` 命令直接读它 */
        @Volatile
        var snapshot: JSONObject = emptySnapshot()

        /** 状态推给前端的出口（由 Bridge 注入） */
        @Volatile
        var emit: ((String, String) -> Unit)? = null

        /** 媒体键 → 前端动作（复用桌面的 hotkey://action 事件） */
        private fun action(id: String) {
            emit?.invoke("hotkey://action", JSONObject().put("id", id).put("source", "smtc").toString())
        }

        /**
         * 自绘界面（悬浮歌词 / 将来的锁屏）点上一首、下一首、播放暂停时走这里。
         *
         * 不直接操作 MediaPlayer：队列里「下一首是谁」只有前端有一份（含循环模式、
         * 随机顺序、在线曲目取链），原生自己切必然和界面不一致。
         */
        fun sendAction(id: String) = action(id)

        /** 当前是否真的在出声：浮窗上的播放键要按它画 ▶ / ⏸ */
        fun playingNow(): Boolean = instance?.let {
            try { it.mp?.isPlaying == true } catch (_: Exception) { false }
        } ?: false

        /**
         * 服务实例：Bridge 的 `spectrum` 命令是同步回答的，拿不到 Service 就没法读频段。
         * 前台服务在整个播放期间都活着，实例引用比 bindService 省事得多。
         */
        @Volatile
        var instance: PlaybackService? = null

        /** 频段数：和桌面 Rust 侧一致（40 段对数分箱） */
        const val BANDS = 40

        /** 封面最多试几把（弱网下第一次常常只拿到一半就断了，见 loadArtAsync） */
        private const val ART_TRIES = 3

        fun emptySnapshot(): JSONObject = JSONObject().apply {
            put("playing", false)
            put("position", 0.0)
            put("duration", 0.0)
            put("volume", 1.0)
            put("track_path", JSONObject.NULL)
            put("track_url", JSONObject.NULL)
            put("index", -1)
            put("ended", false)
            put("seeking", false)
            put("error", JSONObject.NULL)
            put("buffered", 0.0)
        }
    }

    /**
     * 播放器。ExoPlayer 包在 [AudioEngine] 里，对外保持 MediaPlayer 的方法形状，
     * 所以下面二十多处 `mp?.isPlaying` / `mp?.duration` 全都不用改。
     *
     * 换掉 MediaPlayer 的唯一动机是频谱：它只能靠 Visualizer 采集输出音频，
     * 那要 RECORD_AUDIO；ExoPlayer 允许在解码后、出声前旁路一份 PCM（零权限）。
     */
    private var mp: AudioEngine? = null

    /** 频谱旁路器跟着播放器走，换歌重建播放器时一起换（见 open） */
    private val idleSpectrum = FloatArray(BANDS)

    /**
     * prepare 之前读 duration / currentPosition 没有意义（MediaPlayer 会打错误日志，
     * ExoPlayer 给的是 C.TIME_UNSET）。每 250ms 的 tick 都读一次，
     * 所以用这个标记把「还没准备好」的读取挡在外面。
     */
    private var prepared = false
    private var session: MediaSession? = null
    private var focus: AudioFocusRequest? = null
    /*
     * 音频焦点状态。
     *
     * 以前 `setOnAudioFocusChangeListener { }` 是个空实现——别的应用一开声，
     * 系统把这个回调发过来，我们什么都不做，于是两边的声音叠在一起响
     * （用户原话「会与其他应用同时播放」）。
     *
     * 现在按三种情况分开处理：
     *   · LOSS / LOSS_TRANSIENT：暂停，并记下 `focusPaused`，等焦点还回来再续播。
     *     注意**不能放弃焦点请求**——Android 的焦点是带恢复栈的：我们只要还挂在栈里，
     *     抢占者一松手系统就会给我们回一个 GAIN，这正是「等它结束后继续播」。
     *   · LOSS_TRANSIENT_CAN_DUCK：只把音量压到 20%（系统提示音这类不打断听歌）。
     *   · GAIN：恢复音量；若之前是被抢占而暂停的，自动续播。
     */
    private var focusPaused = false
    /** 被压低音量前的原始音量；-1 表示当前没有被压低 */
    private var duckedFrom: Float = -1f

    private var trackPath: String? = null
    private var trackUrl: String? = null
    private var index: Int = -1
    private var volume: Float = 1f
    private var pendingSeekSec: Double = 0.0
    private var endedFlag = false
    private var seekingFlag = false
    private var errorText: String? = null
    private var wantPlay = false

    /**
     * 「下一首预告」里的一个条目（见 [setPrefetch]）。
     *
     * 字段和 `play_file` / `play_url` 那两条 intent 一一对应：原生接上时
     * 走的是同一条 `open()`，不复制第二套播放逻辑。
     */
    class Prefetch(
        val index: Int,
        val path: String?,
        val url: String?,
        val duration: Double,
        val title: String,
        val artist: String,
        val album: String,
        val cover: String?,
        val fav: Boolean,
    )

    /**
     * 前端递过来的「接下来会放的几首」。
     *
     * 为什么要有这东西：自动下一首整条链路（取直链 → play_url）捏在前端手里，
     * 而息屏之后 WebView 的定时器与任务会被系统摁住——上一首自然放完时，
     * `ended` 推过去没有人处理，声音就停在两首之间，亮屏才接着走。
     * （用户 2026-11-09：「听着听着会停，几次都是切歌期间，亮屏又接着播放」。）
     *
     * 现在前端在放当前这首时，顺手把后面几首的直链先递过来（`next_prefetch`），
     * 原生放完直接接上，完全不经过 JS。
     */
    private val prefetch = java.util.ArrayDeque<Prefetch>()

    /**
     * 上一次「原生自己接上了下一首」的队列下标，`-1` = 没有。
     *
     * 一直挂在 `player://state` 里，直到前端主动发来新的 `next_prefetch`
     * 或者自己下发一次播放命令才清掉——前端在息屏期间可能一帧都收不到，
     * 等它醒来必须还能看到这个标记，否则界面上停在上上首。
     */
    @Volatile
    private var autoAdvanced = -1

    private val main = Handler(Looper.getMainLooper())
    private var ticker: Runnable? = null
    private var lastNotifPlaying: Boolean? = null
    /** 上一次写进通知进度的整秒数：每秒重建一次通知就够，别跟着 250ms 的 tick 刷 */
    private var lastNotifSec = -1
    /** 通知动作图标按「资源 + 颜色」缓存，每秒重建时不重复画 bitmap */
    private val notifIcons = HashMap<String, Bitmap>()
    /** 通知进度条的位图（复用同一张，每秒只重画不重分配） */
    private var notifBarBmp: Bitmap? = null
    /** 封面圆角化缓存：源图不变就直接复用上一张 */
    private var coverRoundedSrc: Bitmap? = null
    private var coverRoundedOut: Bitmap? = null
    private var metaTitle = ""
    private var metaArtist = ""
    private var metaAlbum = ""
    private var metaCover: String? = null
    private var metaFav = false

    /** 通知大图 / 媒体会话封面（异步解码，按 cover URL 判重） */
    private var art: Bitmap? = null
    private var artLoadedFor: String? = null
    private var artThread: Thread? = null

    /** 用户选过的输出设备类型（换歌后 MediaPlayer 会重建，onPrepared 里按类型补选） */
    private var preferredOutType: Int? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Sy.init(this)
        instance = this
        createChannel()
        /*
         * 悬浮歌词的开关真值在 FloatingLyrics 里，建窗/拆窗是 post 到主线程异步做的。
         * 挂这个回调，等窗真挂了再刷通知——那颗「词」才不会一直停在旧样式。
         */
        FloatingLyrics.onShownChanged = { updateNotif() }
        session = MediaSession(this, "shuyin").apply {
            /*
             * 这三样是「系统肯不肯把你当播放器」的入场券，缺一样华为控制中心
             * 就把卡片画成「未在播放」（真机 dumpsys 对出来的差异，见下面的注释）。
             *
             *   · flags：MediaSessionCompat 会自动带上 HANDLES_MEDIA_BUTTONS |
             *     HANDLES_TRANSPORT_CONTROLS，直接用平台 MediaSession 就是 0。
             *     控制中心靠这一位判断「这个会话接不接播放/上一首/下一首」；
             *   · sessionActivity：点控制中心那张卡片要跳回应用，没有它就点不动，
             *     华为索性不画（酷狗那边是个 startActivity 的 PendingIntent）；
             *   · mediaButtonReceiver：线控/耳机键在会话失活时也要能落到应用上。
             *
             * 补齐前真机 dumpsys media_session 里我们是 launchIntent=null /
             * mediaButtonReceiver=null / flags=0，而酷狗是三个都齐 —— 就在同一台机上，
             * 它的卡片在控制中心里显示，我们的不显示。
             */
            setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS or MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS)
            setSessionActivity(openAppPending())
            setMediaButtonReceiver(mediaButtonPending())
            setCallback(object : MediaSession.Callback() {
                /*
                 * 耳机 / 车机方控这类按键发的是**明确的** onPlay / onPause，
                 * 以前两个都映射成「playpause」（切换）——在播的时候收到 onPlay
                 * 反而会暂停。现在按语义走，只有通知栏那颗键才是切换。
                 */
                override fun onPlay() = setPlayingInService(true)
                override fun onPause() = setPlayingInService(false)
                override fun onSkipToNext() = action("next")
                override fun onSkipToPrevious() = action("prev")
                override fun onSeekTo(pos: Long) {
                    // 从通知/锁屏拖进度：直接 seek，并让前端把界面跟上
                    doSeek(pos / 1000.0)
                    push()
                }
                override fun onStop() = stopPlayback()
            })
            isActive = true
        }
        /* 息屏 / 亮屏监听：见 screenRx 的注释（锁屏播放页靠它摆好位置） */
        try {
            registerReceiver(
                screenRx,
                IntentFilter().apply {
                    addAction(Intent.ACTION_SCREEN_OFF)
                    addAction(Intent.ACTION_SCREEN_ON)
                },
            )
        } catch (_: Exception) { /* 个别 ROM 限制动态注册，注册失败只是没有锁屏页 */ }
        startTick()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        /*
         * Android 12+ 的硬规定：startForegroundService() 之后 5 秒内必须 startForeground()，
         * 超时直接抛 ForegroundServiceDidNotStartInTimeException —— 是「整个进程被干掉」，
         * 不是播放失败。在线音源要等 HTTP 首包 + prepareAsync，冷启实测 6 秒以上，
         * 所以不能等 onPrepared 才升前台（那是最初的写法，一放网络歌就崩）：
         * 一进 onStartCommand 就先升上去，通知里先写「正在缓冲」。
         */
        if (intent?.action != ACT_STOP) startForegroundSafe()
        when (intent?.action) {
            ACT_PLAY_FILE -> {
                trackPath = intent.getStringExtra("path")
                trackUrl = null
                index = intent.getIntExtra("index", -1)
                autoAdvanced = -1
                open(intent.getDoubleExtra("startAt", 0.0), intent.getBooleanExtra("autoplay", true), 0.0)
            }
            ACT_PLAY_URL -> {
                trackUrl = intent.getStringExtra("url")
                trackPath = null
                index = intent.getIntExtra("index", -1)
                autoAdvanced = -1
                open(intent.getDoubleExtra("startAt", 0.0), intent.getBooleanExtra("autoplay", true), intent.getDoubleExtra("durationHint", 0.0))
            }
            /*
             * 前端点暂停 / 继续。这两条是**用户意图**，必须先清掉「焦点补偿」标记，
             * 否则被别的应用抢过焦点之后，用户自己按了暂停，等对方结束
             * 我们还会自作主张续播一次。
             */
            ACT_PAUSE -> {
                focusPaused = false
                wantPlay = false
                safe { mp?.pause() }
                push()
                updateNotif()
            }
            ACT_RESUME -> {
                focusPaused = false
                wantPlay = true
                startForegroundSafe()
                requestFocus()
                safe { mp?.start() }
                push()
                updateNotif()
            }
            ACT_TOGGLE -> toggleInService()
            ACT_STOP -> stopPlayback()
            ACT_SEEK -> doSeek(intent.getDoubleExtra("secs", 0.0))
            ACT_SEEK_ZONE -> {
                /*
                 * 通知栏里拖不动进度条（RemoteViews 塞不进 SeekBar），所以整条
                 * 切成 20 段，点哪段就跳到那段的中间。粒度 5%，四分钟的歌约 12 秒。
                 */
                val zone = intent.getIntExtra("zone", 0).coerceIn(0, SEEK_ZONES - 1)
                val durMs = try { mp?.duration ?: 0 } catch (_: Exception) { 0 }
                if (durMs > 0) doSeek(durMs.toDouble() * (zone + 0.5) / SEEK_ZONES / 1000.0)
            }
            ACT_VOLUME -> {
                volume = intent.getFloatExtra("volume", 1f).coerceIn(0f, 1f)
                safe { applyVolume() }
                push()
            }
            ACT_META -> {
                metaTitle = intent.getStringExtra("title") ?: ""
                metaArtist = intent.getStringExtra("artist") ?: ""
                metaAlbum = intent.getStringExtra("album") ?: ""
                metaCover = intent.getStringExtra("cover")
                metaFav = intent.getBooleanExtra("fav", false)
                FloatingLyrics.setMeta(metaTitle)
                syncSessionMeta()
                loadArtAsync()
                /*
                 * 队列清空那一刻前端会推一次 title 为空的 meta。照单全收的话
                 * 通知标题回落到「疏音」、又没有封面大图，MIUI 就画出那块白板。
                 * 没有播放器 + 没有曲名 = 真的什么都没在放，收摊。
                 */
                if (mp == null && metaTitle.isBlank()) { shutdownIdle(); return START_NOT_STICKY }
                updateNotif()
            }
            // 通知栏的上一首 / 下一首：交给前端决定放哪一首
            "key:prev" -> action("prev")
            "key:next" -> action("next")
            // 收藏也回前端：收藏列表只有前端有一份
            "key:fav" -> action("fav")
            // 切换输出：原生侧直接轮换（不涉及队列）
            "key:out" -> cycleOutput()
            // 悬浮歌词：真正的「其他应用上层」窗口，开/关都在原生侧
            "key:lyric" -> {
                /*
                 * 这里不刷通知：toggle() 只是 post 出去，此刻 shown 还是旧值，
                 * 立刻刷会把上一轮的样式再画一遍。交给 onShownChanged 回调。
                 */
                FloatingLyrics.toggle(this)
            }
        }
        return START_NOT_STICKY
    }

    /* ---------------- 打开一条音源 ---------------- */


    /**
     * 已缓冲到整首的百分之几（0..100），来自 `setOnBufferingUpdateListener`。
     *
     * 桌面端的进度条有两层：亮的是「已播放」，淡的是「已加载」。
     * 安卓这边以前这一项**恒为 0**（当时的注释写的是「MediaPlayer 不暴露已缓冲位置」——
     * 那是错的，它有 `getBufferPercentage()` 和缓冲回调），于是手机上永远看不到
     * 淡色那一层，弱网时用户只能盯着不动的进度条猜「到底加载了没有」。
     *
     * 只有网络流会回调；播本地缓存文件时它一直是 0，此时按「整首都在本地」算满。
     */
    @Volatile
    private var bufferedPct = 0

    /**
     * 给 Bridge 的 `spectrum` 命令用：只读快照。
     *
     * 数据由 [TapAudioProcessor] 在音频线程旁路出来、在它自己的低优先级线程上算好。
     * 这里只读一个 volatile 引用——桥是 70ms 一次**同步**调用，
     * 在调用线程上现算 40 个 Goertzel 会直接拖住 WebView 的 JS 线程。
     */
    fun spectrumSnapshot(): FloatArray = mp?.tap?.spectrum ?: idleSpectrum

    private fun open(startAt: Double, autoplay: Boolean, durationHint: Double) {
        wantPlay = autoplay
        errorText = null
        endedFlag = false
        pendingSeekSec = startAt
        /* 队列清空那次 stopPlayback 会把会话置为失活（为了让 MIUI 不再画空白媒体卡），
           重新开一首时得把它唤回来，否则新歌没有媒体卡、锁屏也没有控制。 */
        safe { session?.isActive = true }
        safe { mp?.tap?.shutdown() }
        safe { mp?.release() }
        mp = null

        /*
         * 每次换歌建一个新的旁路器：它带着上一首的环形缓冲和采样率，
         * 复用同一个实例就得手动清干净，不如新建——反正只有一个 32KB 的数组。
         */
        val tap = TapAudioProcessor().apply { start() }
        val player = AudioEngine(this, tap)
        mp = player
        prepared = false
        bufferedPct = 0
        /* 换歌时也要守住「被压低」这个状态，否则新播放器一建就以全音量出声 */
        player.setVolume(if (duckedFrom >= 0f) volume * 0.2f else volume)

        player.onPrepared = {
            prepared = true
            applyPreferredOut(player)
            val dur = player.duration / 1000.0
            if (pendingSeekSec > 0 && dur > 0) {
                seekingFlag = true
                player.seekTo((pendingSeekSec * 1000).toInt())
                pendingSeekSec = 0.0
            }
            if (wantPlay) {
                player.start()
                startForegroundSafe()
                requestFocus()
            }
            syncSessionMeta()
            updateNotif()
            push()
        }
        player.onCompletion = {
            /*
             * 有预告就直接接上，**没有才**交给前端。
             *
             * 顺序不能反：先问 JS 再兜底都会留一个空档，而空档正是"停在两首
             * 之间"的那几秒。接上时不能置 `endedFlag`——一置前端就会再 advance
             * 一次，等于跳过一首。
             */
            val next = synchronized(prefetch) { prefetch.pollFirst() }
            if (next != null) main.post { playPrefetched(next) }
            else {
                endedFlag = true
                wantPlay = false
                push()
                updateNotif()
            }
        }
        player.onError = { what, extra ->
            errorText = "播放失败（$what/$extra）"
            wantPlay = false
            push()
        }
        player.onSeekComplete = {
            seekingFlag = false
            push()
        }

        try {
            player.setSource(trackPath, trackUrl)
            player.prepareAsync()
        } catch (e: Exception) {
            errorText = "无法打开音频：${e.message}"
            push()
        }

        // 时长提示：prepare 之前 duration 还是 0，前端界面先用平台的时长顶着
        if (durationHint > 0) {
            snapshot.put("duration", durationHint)
        }
    }

    /**
     * 前端递来「接下来几首」的直链（见 [prefetch]）。
     *
     * 整表替换而不是追加：前端每次都在自己最新的队列状态下重算一遍，
     * 拖过排序、删过歌之后，旧表里的下标可能已经指向别的曲目了。
     */
    fun setPrefetch(items: org.json.JSONArray) {
        /* 前端在 binder 线程写，播放结束回调在音频线程读：整表替换要加锁 */
        synchronized(prefetch) {
            prefetch.clear()
            for (i in 0 until items.length()) {
                val o = items.optJSONObject(i) ?: continue
                prefetch.addLast(
                    Prefetch(
                        index = o.optInt("index", -1),
                        path = o.optString("path").ifBlank { null },
                        url = o.optString("url").ifBlank { null },
                        duration = o.optDouble("duration", 0.0),
                        title = o.optString("title"),
                        artist = o.optString("artist"),
                        album = o.optString("album"),
                        cover = o.optString("cover").ifBlank { null },
                        fav = o.optBoolean("fav", false),
                    ),
                )
            }
        }
        /* 前端既然能发预告，就说明它活着并且已经知道现在放的是哪首了 */
        autoAdvanced = -1
    }

    /**
     * 原生自己接上下一首（不走 intent，也不等 JS）。
     *
     * 元信息、封面、通知、媒体会话都要一起换——否则会出现「声音已经是下一首、
     * 通知栏还挂着上一首」。`autoAdvanced` 是给前端的对账标记。
     */
    private fun playPrefetched(p: Prefetch) {
        if (mp == null && p.title.isBlank()) { shutdownIdle(); return }
        trackPath = p.path
        trackUrl = p.url
        index = p.index
        metaTitle = p.title
        metaArtist = p.artist
        metaAlbum = p.album
        metaCover = p.cover
        metaFav = p.fav
        FloatingLyrics.setMeta(metaTitle)
        syncSessionMeta()
        loadArtAsync()
        autoAdvanced = p.index
        open(0.0, true, p.duration)
        startForegroundSafe()
        requestFocus()
        updateNotif()
        push()
    }

    private fun doSeek(sec: Double) {
        val p = mp ?: return
        seekingFlag = true
        safe { p.seekTo((sec.coerceAtLeast(0.0) * 1000).toInt()) }
        push()
    }

    private fun stopPlayback() {
        wantPlay = false
        endedFlag = false
        /* 队列被清空 / 用户停了：预告作废，别再自己接一首出来 */
        synchronized(prefetch) { prefetch.clear() }
        autoAdvanced = -1
        safe { mp?.stop() }
        safe { mp?.tap?.shutdown() }
        safe { mp?.release() }
        mp = null
        prepared = false
        trackPath = null
        trackUrl = null
        index = -1
        push()
        abandonFocus()
        safe { session?.setPlaybackState(PlaybackState.Builder().setState(PlaybackState.STATE_STOPPED, 0, 1f).build()) }
        /*
         * 队列被清空时必须**同时**收掉两样东西：通知和媒体会话。
         *
         * 只 stopForeground 的话通知是没了，但 MediaSession 还挂着「活着」的状态，
         * MIUI 会照着会话画一张**没有任何内容**的媒体卡（用户看到的
         * 「播放列表为空时状态栏白的一片」）。会话失活之后系统才不再画那张卡。
         */
        clearNotif()
        if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE) else @Suppress("DEPRECATION") stopForeground(true)
        stopSelf()
    }

    /** 撤掉通知并让媒体会话失活：没有正在播的东西时，系统不该还留一张空卡片 */
    private fun clearNotif() {
        Log.i("Shuyin", "clearNotif: 撤通知 + 会话失活")
        safe { session?.isActive = false }
        try {
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(1)
        } catch (_: Exception) { /* 通知被用户关掉时这里会抛，无所谓 */ }
    }

    /**
     * 空转态：没有播放器、也没有曲目信息。
     *
     * 只 cancel 通知是不够的——服务还挂在前台时，系统会继续把这张「前台通知」
     * 画出来，内容全是空的，MIUI 就渲染成一块白板（用户：「播放列表为空时，
     * 小米的状态栏会显示白的一片」）。所以必须连前台态一起收掉并 stopSelf。
     */
    private fun shutdownIdle() {
        Log.i("Shuyin", "shutdownIdle: 无曲目，收前台态并停服务")
        clearNotif()
        if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE) else @Suppress("DEPRECATION") stopForeground(true)
        stopSelf()
    }

    /* ---------------- 锁屏播放页 ---------------- */

    /**
     * 息屏 → 页面原地不动，只停重绘；亮屏 → 页面已经在栈顶，直接就能看见。
     *
     * 只有 Activity 能压在系统锁屏之上（TYPE_APPLICATION_OVERLAY 浮窗解锁后才看得见），
     * 所以监听得挂在一直在跑的前台服务上：用户按电源键那一刻，应用可能早就退到后台了。
     * 没在放歌就不碰——锁屏上突然冒出一张音乐页比看不到更烦。
     *
     * **两条路径都不点亮屏幕**（用户原话：「我锁屏以后它会亮一下屏幕然后出现锁屏，
     * 实际我应该按亮屏幕它才出现」）。息屏那条也**不动 showWhenLocked**——一摘一挂之间
     * 系统锁屏会顶上来，那就是用户说的「疏音锁屏 → 系统锁屏 → 疏音锁屏」。
     */
    private val screenRx = object : BroadcastReceiver() {
        override fun onReceive(c: Context?, intent: Intent?) {
            val action = intent?.action ?: return
            if (action != Intent.ACTION_SCREEN_OFF && action != Intent.ACTION_SCREEN_ON) return
            if (!LockScreenActivity.enabled(this@PlaybackService)) return
            val playing = try { mp?.isPlaying == true } catch (_: Exception) { false }
            if (!playing) return
            if (action == Intent.ACTION_SCREEN_OFF) {
                LockScreenActivity.onScreenOff(this@PlaybackService)
            } else {
                LockScreenActivity.onScreenOn(this@PlaybackService)
            }
        }
    }

    /** 把「当前播放面」同步给悬浮歌词 / 锁屏页（它们只读这份镜像） */
    private fun syncNowPlaying() {
        NowPlaying.title = metaTitle
        NowPlaying.artist = metaArtist
        NowPlaying.album = metaAlbum
        NowPlaying.fav = metaFav
        NowPlaying.cover = art
        NowPlaying.playing = try { mp?.isPlaying == true } catch (_: Exception) { false }
    }

    /* ---------------- 状态 ---------------- */

    private fun push() {
        val p = mp
        val playing = try { p?.isPlaying == true } catch (_: Exception) { false }
        val onScreen = screenOn()
        /*
         * 频谱不再需要「息屏就放开」那套管理了。
         *
         * Visualizer 是连续采样，息屏时白烧 CPU，所以以前要 release/attach 来回折腾。
         * 现在数据是从音频处理链上旁路出来的——**本来就在跑**，多算一遍 Goertzel
         * 只在 TapAudioProcessor 自己的低优先级线程上，跟着采集节奏走，
         * 不需要也不应该在这里介入。
         */
        if (trackUrl != null && prepared) bufferedPct = p?.bufferedPercent ?: 0
        val dur = if (prepared) (try { (p?.duration ?: 0) / 1000.0 } catch (_: Exception) { 0.0 }) else 0.0
        val pos = if (prepared) (try { (p?.currentPosition ?: 0) / 1000.0 } catch (_: Exception) { 0.0 }) else 0.0
        /*
         * 「已加载」换算成秒，形状和桌面端一致（前端用 `buffered / duration` 画淡色那一层）。
         * 本地文件（缓存的在线曲 / 曲库里的歌）没有缓冲概念——整首都在磁盘上，
         * 直接报满，进度条上那条淡色就铺到底，语义是「随时能跳」。
         */
        val buffered = when {
            dur <= 0 -> 0.0
            trackUrl == null && trackPath != null -> dur
            else -> dur * bufferedPct / 100.0
        }

        /* 锁屏页的进度条要的就是这两个（秒），跟着 250ms 的 tick 一起刷 */
        NowPlaying.pos = if (dur > 0) pos.coerceAtMost(dur) else pos
        NowPlaying.dur = dur

        val snap = JSONObject().apply {
            put("playing", playing)
            put("position", if (dur > 0) pos.coerceAtMost(dur) else pos)
            put("duration", if (dur > 0) dur else snapshot.optDouble("duration", 0.0))
            put("volume", volume.toDouble())
            put("track_path", trackPath ?: JSONObject.NULL)
            put("track_url", trackUrl ?: JSONObject.NULL)
            put("index", index)
            put("ended", endedFlag)
            /* 原生自己接过下一首时要让前端知道它该显示哪一首（见 autoAdvanced） */
            put("auto", if (autoAdvanced >= 0) autoAdvanced else JSONObject.NULL)
            put("seeking", seekingFlag)
            put("error", errorText ?: JSONObject.NULL)
            put("buffered", buffered)
        }
        snapshot = snap
        // ended / error 是一次性的：推一次之后清掉，否则前端会反复「跳下一首」
        endedFlag = false
        errorText = null
        emit?.invoke("player://state", snap.toString())

        // 会话播放状态每个 tick 都刷：通知/锁屏上的进度条靠它走（只是 setPlaybackState，
        // 不重建通知——每 250ms 发一次通知会把通知栏刷出毛病）
        syncSessionState()
        /* 悬浮歌词 / 锁屏页每 250ms 从这里取一次当前播放面（只读镜像，不回调） */
        syncNowPlaying()

        /*
         * 自定义通知里的进度条不会自己走（那是 QQ 那套自绘卡片，不是 MIUI 模板），
         * 所以每秒重建一次通知；同一秒内不动，避免 250ms 的 tick 把通知栏刷出毛病。
         *
         * 息屏时**不重建**：通知栏和锁屏媒体卡都看不见，inflate RemoteViews + 一次
         * binder 通知对用户零收益，纯耗电。重新亮屏后 sec 必然变了，会自然补一帧。
         */
        val sec = (pos).toInt()
        if (playing && dur > 0 && sec != lastNotifSec && onScreen) {
            lastNotifSec = sec
            try {
                (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                    .notify(1, buildNotification(true))
            } catch (_: Exception) { /* 通知权限被拒时不影响播放 */ }
        }

        if (playing != lastNotifPlaying) {
            lastNotifPlaying = playing
            updateNotif()
            /*
             * 这里**不能**顺手 requestFocus()。
             *
             * 原来的写法是状态一变就重新申请焦点，包括「变回暂停」那一下：
             * 被别的应用抢走焦点、我们刚暂停，250ms 后这一拍又把焦点抢回来，
             * 对方收到 LOSS 暂停、我们再被打断……两边互相踢，声音一阵一阵的。
             * 申请焦点只放在真正开播的三条路上（prepare 完成、setPlayingInService、
             * 服务恢复），暂停不需要。
             */
        }
    }

    private fun startTick() {
        stopTick()
        val r = object : Runnable {
            override fun run() {
                try { push() } catch (_: Exception) {}
                main.postDelayed(this, tickInterval())
            }
        }
        ticker = r
        main.postDelayed(r, 250)
    }

    /** 屏幕是不是亮着（有人正看着）。查询本身很便宜，跟着 tick 走没问题。 */
    private fun screenOn(): Boolean = try {
        (getSystemService(Context.POWER_SERVICE) as PowerManager).isInteractive
    } catch (_: Exception) {
        true
    }

    /**
     * 刷新间隔：**有人在看才值得 250ms 一次**。
     *
     * 息屏以后这一串（算歌词进度、组 JSON、过桥推 JS、刷会话状态、重建通知）
     * 对用户没有任何可见产出，纯粹在耗电：4 次/秒的桥回调会把 WebView 的 JS
     * 一直拽醒，手机放兜里放一晚上就是实打实的电。所以息屏降到 800ms（播放中）
     * / 2500ms（暂停），歌词只在换句时变，慢一点也看不出来。
     */
    private fun tickInterval(): Long {
        if (screenOn()) return 250L
        val playing = try { mp?.isPlaying == true } catch (_: Exception) { false }
        return if (playing) 800L else 2500L
    }

    private fun stopTick() {
        ticker?.let { main.removeCallbacks(it) }
        ticker = null
    }

    /* ---------------- 通知 / 媒体会话 ---------------- */

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            val ch = NotificationChannel("playback", "播放控制", NotificationManager.IMPORTANCE_LOW)
            ch.setShowBadge(false)
            ch.lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(ch)
        }
    }

    private fun intentFor(action: String): PendingIntent {
        val i = Intent(this, PlaybackService::class.java).setAction(action)
        val flags = if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        else PendingIntent.FLAG_UPDATE_CURRENT
        return PendingIntent.getService(this, action.hashCode(), i, flags)
    }

    /** 点通知 / 点控制中心卡片 → 回到应用（会话的 sessionActivity 和通知的 contentIntent 共用） */
    private fun openAppPending(): PendingIntent {
        val open = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        return PendingIntent.getActivity(
            this, 0, open,
            if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE else PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }

    /**
     * 会话的「媒体键接收器」。
     *
     * 会话失活（队列播空、进程刚从后台起来）时，耳机线控 / 蓝牙方控发的是广播，
     * 系统要有这么一个 PendingIntent 才肯把按键转给我们。服务活着时按键本来
     * 直接走 [MediaSession.Callback]，这条只是兜底。
     */
    private fun mediaButtonPending(): PendingIntent {
        val i = Intent(this, MediaButtonReceiver::class.java).setAction(Intent.ACTION_MEDIA_BUTTON)
        return PendingIntent.getBroadcast(
            this, 1, i,
            if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE else PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }

    /** 供 [MediaBrowserBridge] 取会话 token：系统靠它把控制中心 / 车机接到我们这次播放上 */
    fun sessionToken(): MediaSession.Token? = session?.sessionToken

    /**
     * 收 [MediaButtonReceiver] 转来的按键。
     *
     * 平台 `MediaSession.dispatchMediaButtonEvent()` 不在公开 SDK 里（编译报
     * Unresolved reference），所以这里自己按 keyCode 分发——落点和
     * `MediaSession.Callback` 里的那几个回调**保持一致**：明确的 onPlay/onPause
     * 按语义走，只有「播放/暂停」那颗切换。
     */
    fun dispatchMediaButton(intent: Intent) {
        val e = intent.getParcelableExtra<android.view.KeyEvent>(Intent.EXTRA_KEY_EVENT) ?: return
        /* 长按会连发 repeat，只在第一下动手 */
        if (e.action != android.view.KeyEvent.ACTION_DOWN || e.repeatCount > 0) return
        when (e.keyCode) {
            android.view.KeyEvent.KEYCODE_MEDIA_PLAY -> setPlayingInService(true)
            android.view.KeyEvent.KEYCODE_MEDIA_PAUSE -> setPlayingInService(false)
            android.view.KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
            android.view.KeyEvent.KEYCODE_HEADSETHOOK,
            android.view.KeyEvent.KEYCODE_MEDIA_STOP -> toggleInService()
            android.view.KeyEvent.KEYCODE_MEDIA_NEXT -> action("next")
            android.view.KeyEvent.KEYCODE_MEDIA_PREVIOUS -> action("prev")
        }
    }

    private fun buildNotification(playing: Boolean): Notification {
        val openPi = openAppPending()
        val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, "playback")
        else @Suppress("DEPRECATION") Notification.Builder(this)

        val durMs = if (prepared) (try { (mp?.duration ?: 0).toLong() } catch (_: Exception) { 0L }) else 0L
        val posMs = try { (mp?.currentPosition ?: 0).toLong() } catch (_: Exception) { 0L }

        b.setContentTitle(metaTitle.ifBlank { "疏音" })
            .setContentText(subTitle())
            .setSmallIcon(R.mipmap.ic_notif)
            .setContentIntent(openPi)
            .setOngoing(playing)
            /* 官方媒体通知的标配：告诉系统「这是一条传输控制通知」。
               第三方播放器漏了这一条，个别 ROM 就不把它算进媒体卡（也在试控制中心） */
            .setCategory(Notification.CATEGORY_TRANSPORT)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
        /* 封面大图：锁屏 / 其它 ROM 的媒体模板要用；MIUI 的卡片走下面的自定义视图。
           没封面时同样退回应用图标——空着的那一格在锁屏上是纯黑/纯白的一块 */
        b.setLargeIcon(art ?: appTile(isNight(), 96))

        /*
         * 动作列表只服务「不认自定义视图」的地方（锁屏、别的 ROM、车机）。
         * 顺序对齐 QQ 那排：收藏 / 上一首 / 播放暂停 / 下一首 / 悬浮歌词，
         * 切换输出放最后（MIUI 的模板最多画 5 个，被吞是预期内的）。
         */
        b.addAction(
            Notification.Action.Builder(
                if (metaFav) R.drawable.notif_fav_on else R.drawable.notif_fav,
                if (metaFav) "已收藏" else "收藏",
                pendingFor("fav"),
            ).build()
        )
        b.addAction(Notification.Action.Builder(android.R.drawable.ic_media_previous, "上一首", pendingFor("prev")).build())
        b.addAction(
            Notification.Action.Builder(
                if (playing) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play,
                if (playing) "暂停" else "播放",
                intentFor(ACT_TOGGLE),
            ).build()
        )
        b.addAction(Notification.Action.Builder(android.R.drawable.ic_media_next, "下一首", pendingFor("next")).build())
        b.addAction(Notification.Action.Builder(R.drawable.notif_lyrics, "悬浮歌词", pendingFor("lyric")).build())
        b.addAction(Notification.Action.Builder(R.drawable.notif_output, "切换输出", pendingFor("out")).build())

        if (Build.VERSION.SDK_INT >= 21) {
            b.setStyle(Notification.MediaStyle().setMediaSession(session?.sessionToken).setShowActionsInCompactView(1, 2, 3))
        }
        /*
         * 自绘卡片，**所有机型都用同一套**。
         *
         * 不按厂商分流。曾经为了追华为控制中心试过「华为交给系统模板、其它 ROM 用自绘」，
         * 真机 A/B 之后撤了：华为控制中心认不认这个播放器跟通知长什么样没关系
         * （纯系统模板 + CATEGORY_TRANSPORT 也一样是「未在播放」，而它认的四家
         * 音乐 App 都实现了 MediaBrowserService，见 MediaBrowserBridge），
         * 所以没必要为它多留一条只在华为生效的分支。
         *
         * 自绘的理由本身没变：MIUI 的媒体模板把动作行第 4 位画成一颗巨大的心、
         * 还只给 5 个位置，我们的「悬浮歌词 / 切换输出」会被吞；一张自己画的卡
         * 在各家 ROM 上长得一致，也不用跟着系统的模板改版跑。
         */
        if (Build.VERSION.SDK_INT >= 24) {
            val rv = mediaView(playing, posMs, durMs)
            b.setCustomContentView(rv)
            b.setCustomBigContentView(rv)
        }
        return b.build()
    }

    /** 通知副标题：歌手 · 专辑（空的那半边自动省掉） */
    private fun subTitle(): String =
        listOf(metaArtist, metaAlbum).filter { it.isNotBlank() }.joinToString(" · ")

    private fun clock(ms: Long): String {
        val s = (ms / 1000).coerceAtLeast(0)
        return String.format(java.util.Locale.US, "%d:%02d", s / 60, s % 60)
    }

    /**
     * 自绘的媒体卡片（res/layout/notif_media.xml）。
     *
     * 颜色**显式给**：自定义通知视图由系统界面进程 inflate，`?android:attr/textColorPrimary`
     * 到底按谁的 Theme 解析各家 ROM 不一样，浅色卡片上万一解析成白字就整块看不见。
     * 这里按当前深/浅色算好颜色，文字用 setTextColor、图标染色成 bitmap 再塞进去
     * ——RemoteViews 不认 tint 属性，只能自己画。
     */
    /** 当前是不是深色界面：通知卡片的两套配色都按它选 */
    private fun isNight(): Boolean =
        (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
            Configuration.UI_MODE_NIGHT_YES

    private fun mediaView(playing: Boolean, posMs: Long, durMs: Long): RemoteViews {
        val night = isNight()
        val titleInk = Color.parseColor(if (night) "#F2F3F7" else "#15171C")
        val subInk = Color.parseColor(if (night) "#A6ABBA" else "#6B7080")
        val iconInk = Color.parseColor(if (night) "#E7E9F1" else "#23262E")

        val rv = RemoteViews(packageName, R.layout.notif_media)
        rv.setTextViewText(R.id.n_title, metaTitle.ifBlank { "疏音" })
        rv.setTextViewText(R.id.n_artist, subTitle())
        rv.setTextColor(R.id.n_title, titleInk)
        rv.setTextColor(R.id.n_artist, subInk)
        rv.setTextColor(R.id.n_pos, subInk)
        rv.setTextColor(R.id.n_dur, subInk)

        val cover = art
        /*
         * 没有封面时用**应用图标**，不再塞 ic_notif（那是个纯白单色剪影，
         * 贴到通知卡片的浅底上就是一块白，用户原话「显示纯白有点丑」）。
         */
        if (cover != null) {
            rv.setImageViewBitmap(R.id.n_cover, roundCover(cover))
            /* 背景那层封面色晕：没有封面就留空，卡片退回系统原本的底色 */
            rv.setImageViewBitmap(R.id.n_wash, washBitmap(cover, night))
        } else {
            rv.setImageViewBitmap(R.id.n_cover, appTile(night, 64))
            rv.setImageViewBitmap(R.id.n_wash, transparentPixel())
        }

        if (durMs > 0) {
            rv.setTextViewText(R.id.n_pos, clock(posMs))
            rv.setTextViewText(R.id.n_dur, clock(durMs))
            /*
             * VISIBLE 必须显式给回来。
             *
             * 同一 id 的通知复用同一套 View 层级，`setViewVisibility` 设过一次
             * INVISIBLE 就一直是 INVISIBLE——首包之前那几帧走的正是 else 分支，
             * 之后时长有了、位图也塞进去了，却因为这条残留状态整条看不见
             * （华为真机上「进度条一直不出现」就是这么来的）。
             */
            rv.setViewVisibility(R.id.n_bar, android.view.View.VISIBLE)
            rv.setImageViewBitmap(R.id.n_bar, barBitmap(posMs, durMs, night))
        } else {
            /* 时长还没拿到（在线歌首包之前）：显示占位，别画一条永远不动的空槽 */
            rv.setTextViewText(R.id.n_pos, "--:--")
            rv.setTextViewText(R.id.n_dur, "--:--")
            rv.setViewVisibility(R.id.n_bar, android.view.View.INVISIBLE)
        }

        rv.setImageViewBitmap(R.id.n_fav, tintedIcon(if (metaFav) R.drawable.notif_fav_on else R.drawable.notif_fav, iconInk))
        rv.setImageViewBitmap(R.id.n_prev, tintedIcon(R.drawable.notif_prev, iconInk))
        rv.setImageViewBitmap(R.id.n_toggle, accentDisc(if (playing) R.drawable.notif_pause else R.drawable.notif_play))
        rv.setImageViewBitmap(R.id.n_next, tintedIcon(R.drawable.notif_next, iconInk))
        /*
         * 「悬浮歌词」不再用引号图标：那对引号既不像歌词也没人认得出来
         * （用户：「你这个图标我也摸不着头脑这个是什么意思」）。
         * 直接画一个「词」字，与 QQ 音乐通知栏那颗一致，一眼就知道是歌词。
         *
         * 开着的时候**只换字色**，不铺底色。
         * 之前画的是强调色实心块 + 反白字，可通知卡片上其它四颗都是细线条图标，
         * 中间突然冒出一块实心方块，像多贴了一颗按钮（用户：「给个词这个图标
         * 改个颜色就行了，不要背景色」）。现在两态只差颜色：灰 = 关，主题色 = 开。
         */
        rv.setImageViewBitmap(
            R.id.n_lyric,
            glyphIcon("词", if (FloatingLyrics.shown) lyricAccent() else iconInk),
        )

        rv.setOnClickPendingIntent(R.id.n_fav, pendingFor("fav"))
        rv.setOnClickPendingIntent(R.id.n_prev, pendingFor("prev"))
        rv.setOnClickPendingIntent(R.id.n_toggle, intentFor(ACT_TOGGLE))
        rv.setOnClickPendingIntent(R.id.n_next, pendingFor("next"))
        rv.setOnClickPendingIntent(R.id.n_lyric, pendingFor("lyric"))
        /* 进度条 20 段：点哪跳哪（真正的拖动在通知栏里做不到） */
        for (i in 0 until SEEK_ZONES) {
            rv.setOnClickPendingIntent(seekZoneIds[i], seekZonePending(i))
        }
        return rv
    }

    /**
     * 通知里的进度条，画成一张位图。
     *
     * 为什么不用 ProgressBar：同一份 XML 在华为 HarmonyOS 上**整条都不画**
     * （`?android:attr/progressBarStyleHorizontal` 被系统界面进程解析成空样式，
     * 连 progressDrawable 一起丢）。位图没有解析空间，塞进去就一定看得见。
     * 位图复用同一张，每秒只重画不重分配。
     */
    private fun barBitmap(posMs: Long, durMs: Long, night: Boolean): Bitmap {
        val w = 400
        val h = (4 * resources.displayMetrics.density).toInt().coerceIn(9, 24)
        val bmp = notifBarBmp?.takeIf { it.width == w && it.height == h }
            ?: Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888).also { notifBarBmp = it }
        val c = Canvas(bmp)
        c.drawColor(Color.TRANSPARENT, PorterDuff.Mode.CLEAR)
        val r = h / 2f
        c.drawRoundRect(
            0f, 0f, w.toFloat(), h.toFloat(), r, r,
            Paint(Paint.ANTI_ALIAS_FLAG).apply {
                /* 浅色卡片本身是 #E9EAEF 上下，底色再浅一档就彻底看不出来了 */
                color = if (night) Color.parseColor("#414653") else Color.parseColor("#C2C7D3")
            },
        )
        val p = (posMs.coerceIn(0, durMs).toFloat() / durMs.toFloat()).coerceIn(0f, 1f)
        val fw = (w * p).coerceIn(0f, w.toFloat())
        if (fw > 0f) {
            c.drawRoundRect(
                0f, 0f, fw, h.toFloat(), r, r,
                Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#7C93FF") },
            )
            /*
             * 已播位置画一颗小圆点（头部）。一条纯色进度条在缩小看的时候只是
             * 一根线，有了圆头才像「进度」，也提示这条是可以点的（20 段热区）。
             * 起点画点没意义（0 位置那颗会顶到左边框），所以只在 >1% 时画。
             */
            if (p > 0.01f) {
                val cx = fw.coerceIn(r, w - r)
                c.drawCircle(
                    cx, h / 2f, h * 0.95f,
                    Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#B9C6FF") },
                )
            }
        }
        return bmp
    }

    /**
     * 封面圆角：RemoteViews 给不了 ImageView 的 clipToOutline，
     * 只能先把位图裁成圆角。源图没变就复用上一张，切歌时才重画。
     *
     * **必须先缩到视图尺寸再画圆角。** 直接在一千多像素的原图上画 12dp 圆角，
     * ImageView 的 centerCrop 只显示中间那一块，圆角全落在被裁掉的部分——
     * 屏幕上看到的是一个直角方块（用户看到的就是「封面没圆角，很糙」）。
     */
    private fun roundCover(src: Bitmap, dp: Int = 12): Bitmap {
        val px = (64 * resources.displayMetrics.density).toInt().coerceAtLeast(48)
        if (coverRoundedSrc === src && coverRoundedOut?.width == px) coverRoundedOut?.let { return it }
        /* 先中心裁成正方形 */
        val side = minOf(src.width, src.height)
        val sq = Bitmap.createBitmap(
            src, (src.width - side) / 2, (src.height - side) / 2, side, side,
        )
        val scaled = if (sq.width == px) sq else Bitmap.createScaledBitmap(sq, px, px, true)
        if (sq !== src && sq !== scaled) sq.recycle()
        val out = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888)
        val c = Canvas(out)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            shader = BitmapShader(scaled, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP)
        }
        val r = dp * resources.displayMetrics.density
        c.drawRoundRect(0f, 0f, px.toFloat(), px.toFloat(), r, r, paint)
        if (scaled !== src) scaled.recycle()
        coverRoundedSrc = src
        coverRoundedOut = out
        return out
    }

    /* ---------------- 通知卡片的「观感」三件套：色晕 / 主色 / 实心播放键 ---------------- */

    private var washSrc: Bitmap? = null
    private var washNight = false
    private var washOut: Bitmap? = null

    /**
     * 卡片背景那层封面色晕。
     *
     * 用户的原话是「通知栏的播放卡片感觉有点单调，你看酷狗的就没有这种感觉」——
     * 酷狗那张卡片本身结构和我们一样（封面 / 两行字 / 进度 / 一排键），
     * 差别就在背景里透着一层封面颜色。这里把那层颜色补上：
     * 从封面那一侧晕开、往右淡到全透明，所以右边那片系统卡片的底色原样保留，
     * 视觉上像「封面把颜色染进了卡片」，而不是贴了一块色块。
     *
     * 位图只有 300×170，靠 ImageView 的 fitXY 拉满整张卡——渐变本身没有细节，
     * 放大不会糊，也不占内存。按「封面对象 + 深/浅色」缓存，切歌才重画。
     */
    private fun washBitmap(cover: Bitmap, night: Boolean): Bitmap {
        if (washSrc === cover && washNight == night) washOut?.let { return it }
        val w = 300
        val h = 170
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        val tint = dominantColor(cover, night)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            shader = android.graphics.RadialGradient(
                w * 0.16f, h * 0.48f, w * 1.06f,
                intArrayOf(
                    withAlpha(tint, if (night) 0.52f else 0.44f),
                    withAlpha(tint, if (night) 0.20f else 0.16f),
                    withAlpha(tint, 0f),
                ),
                floatArrayOf(0f, 0.48f, 1f),
                Shader.TileMode.CLAMP,
            )
        }
        c.drawRect(0f, 0f, w.toFloat(), h.toFloat(), paint)
        washSrc = cover
        washNight = night
        washOut = bmp
        return bmp
    }

    /**
     * 从封面里挑一个「像它」的颜色。
     *
     * 直接求平均会发灰（一张图里深浅互相抵消），所以按 饱和度×明度 加权：
     * 越鲜艳、越亮的像素说话越响，这正是人眼从封面里记住的那块颜色。
     * 之后把饱和度和明度各夹进一个区间——太灰的染不出颜色，太艳的在浅色卡片上
     * 会把黑字压得看不清。
     */
    private fun dominantColor(cover: Bitmap, night: Boolean): Int {
        val n = 12
        val small = Bitmap.createScaledBitmap(cover, n, n, true)
        var r = 0f
        var g = 0f
        var b = 0f
        var sum = 0f
        val hsv = FloatArray(3)
        for (y in 0 until n) {
            for (x in 0 until n) {
                val px = small.getPixel(x, y)
                if (Color.alpha(px) < 40) continue
                Color.colorToHSV(px, hsv)
                val wgt = 0.12f + hsv[1] * hsv[2]
                r += Color.red(px) * wgt
                g += Color.green(px) * wgt
                b += Color.blue(px) * wgt
                sum += wgt
            }
        }
        small.recycle()
        if (sum <= 0f) return Color.parseColor(if (night) "#7C93FF" else "#5E77D8")
        val avg = Color.rgb(
            (r / sum).toInt().coerceIn(0, 255),
            (g / sum).toInt().coerceIn(0, 255),
            (b / sum).toInt().coerceIn(0, 255),
        )
        Color.colorToHSV(avg, hsv)
        hsv[1] = hsv[1].coerceIn(if (night) 0.45f else 0.34f, 0.85f)
        hsv[2] = hsv[2].coerceIn(if (night) 0.55f else 0.45f, if (night) 0.92f else 0.78f)
        return Color.HSVToColor(hsv)
    }

    private fun withAlpha(color: Int, a: Float): Int =
        Color.argb((a.coerceIn(0f, 1f) * 255).toInt(), Color.red(color), Color.green(color), Color.blue(color))

    /** 1×1 全透明：没有封面时把背景那层 ImageView 清干净，别留着上一首的色晕 */
    private fun transparentPixel(): Bitmap {
        notifIcons["px"]?.let { return it }
        val b = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)
        notifIcons["px"] = b
        return b
    }

    /**
     * 播放/暂停做成强调色实心圆。
     *
     * 卡片上另外四颗都是细线条图标，中间那颗如果也只是个线条三角，整行就没有
     * 视觉落点——这也是「单调」的一半来源。实心圆 + 反白图标等于给卡片一个焦点，
     * 和播放页、锁屏页上的主按钮是同一个语言。
     */
    private fun accentDisc(resId: Int, dp: Int = 38): Bitmap {
        val key = "disc/$resId/$dp"
        notifIcons[key]?.let { return it }
        val px = (dp * resources.displayMetrics.density).toInt().coerceAtLeast(24)
        val bmp = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#7C93FF") }
        c.drawCircle(px / 2f, px / 2f, px / 2f, paint)
        val glyph = tintedIcon(resId, Color.WHITE, (dp * 0.5f).toInt())
        c.drawBitmap(glyph, (px - glyph.width) / 2f, (px - glyph.height) / 2f, null)
        notifIcons[key] = bmp
        return bmp
    }

    /**
     * 没封面时的占位方图：应用图标裁圆角。
     *
     * 原来这里塞的是 `ic_notif`（通知小图标要求的纯白单色剪影），贴到浅色卡片上
     * 就是一块白，用户看着像图没加载出来。改成真·应用图标，一眼知道是疏音。
     * 深色卡片上再补一圈很淡的描边，否则深底图标贴着深底卡片看不见边界。
     */
    private fun appTile(night: Boolean, dp: Int = 54): Bitmap {
        val key = "tile/$night/$dp"
        notifIcons[key]?.let { return it }
        val px = (dp * resources.displayMetrics.density).toInt().coerceAtLeast(48)
        val bmp = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        val r = px * 0.19f
        val path = Path().apply {
            addRoundRect(RectF(0f, 0f, px.toFloat(), px.toFloat()), r, r, Path.Direction.CW)
        }
        c.save()
        c.clipPath(path)
        /* 图标自带深底，先铺一层同色：缩放开抗锯齿时边缘不会漏出白边 */
        c.drawColor(Color.parseColor("#1B1C20"))
        try {
            getDrawable(R.mipmap.ic_launcher)?.let { d ->
                d.setBounds(0, 0, px, px)
                d.draw(c)
            }
        } catch (_: Exception) { /* 图标读不出来就留一块纯色，通知不能因此崩 */ }
        c.restore()
        if (night) {
            c.drawPath(
                path,
                Paint(Paint.ANTI_ALIAS_FLAG).apply {
                    style = Paint.Style.STROKE
                    strokeWidth = px * 0.014f
                    color = Color.parseColor("#38FFFFFF")
                },
            )
        }
        notifIcons[key] = bmp
        return bmp
    }

    /**
     * 单字图标（通知里那颗「词」）。
     *
     * RemoteViews 没有「用图标字体」这种能力，系统图标库里也没有能表意的歌词符号，
     * 于是直接把字画在位图上：24dp 见方、水平居中、按当前墨色（深/浅色各一份缓存）。
     * 这和 QQ 音乐通知栏那颗「词」是同一个读法，比一对引号好认。
     *
     * 字身只占 0.68：矢量图标本身在 24dp 盒子里就有留白（实际笔画 ~18dp），
     * 中文字形却是**满格**的，按 0.86 画出来比其他四颗大一圈（用户：「那个词的
     * 图标有点大，和其他的不适配」）。压到 0.68 之后视觉重量才对齐。
     */
    private fun glyphIcon(text: String, color: Int, dp: Int = 24): Bitmap {
        val key = "g:$text/$color/$dp"
        notifIcons[key]?.let { return it }
        val px = (dp * resources.displayMetrics.density).toInt().coerceAtLeast(16)
        val bmp = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888)
        val p = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            this.color = color
            textSize = px * 0.68f
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            textAlign = Paint.Align.CENTER
        }
        /* 按字体度量居中，不能按字身框：中文的 ascent/descent 不对称，直接除 2 会偏上 */
        val fm = p.fontMetrics
        val baseline = px / 2f - (fm.ascent + fm.descent) / 2f
        Canvas(bmp).drawText(text, px / 2f, baseline, p)
        notifIcons[key] = bmp
        return bmp
    }

    /** 歌词强调色（和播放页/锁屏的「已唱」颜色保持一致），解析失败回退金色 */
    private fun lyricAccent(): Int = try {
        Color.parseColor(NowPlaying.color)
    } catch (_: Exception) {
        Color.parseColor("#FFC94D")
    }

    /** 矢量图标 → 指定颜色的位图（按资源+颜色+尺寸缓存，每秒重建通知时不重复画） */
    private fun tintedIcon(resId: Int, color: Int, dp: Int = 24): Bitmap {
        val key = "$resId/$color/$dp"
        notifIcons[key]?.let { return it }
        val px = (dp * resources.displayMetrics.density).toInt().coerceAtLeast(16)
        val bmp = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888)
        try {
            val d = getDrawable(resId)
            if (d != null) {
                d.mutate()
                d.setTint(color)
                d.setBounds(0, 0, px, px)
                d.draw(Canvas(bmp))
            }
        } catch (_: Exception) {
            /* 画不出来就交一张空图，通知不能因此崩 */
        }
        notifIcons[key] = bmp
        return bmp
    }

    /** 通知栏按键不直接操作播放器，而是回到前端：队列逻辑（下一首是谁）只在前端有一份 */
    /** 进度条 20 段热区的 view id，序号和 notif_media.xml 的 n_s0..n_s19 对齐 */
    private val seekZoneIds = intArrayOf(
        R.id.n_s0, R.id.n_s1, R.id.n_s2, R.id.n_s3, R.id.n_s4,
        R.id.n_s5, R.id.n_s6, R.id.n_s7, R.id.n_s8, R.id.n_s9,
        R.id.n_s10, R.id.n_s11, R.id.n_s12, R.id.n_s13, R.id.n_s14,
        R.id.n_s15, R.id.n_s16, R.id.n_s17, R.id.n_s18, R.id.n_s19,
    )

    /** 第 zone 段热区的点击意图：跳到该段中点 */
    private fun seekZonePending(zone: Int): PendingIntent {
        val i = Intent(this, PlaybackService::class.java)
            .setAction(ACT_SEEK_ZONE)
            .putExtra("zone", zone)
        val flags = if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        else PendingIntent.FLAG_UPDATE_CURRENT
        return PendingIntent.getService(this, 7000 + zone, i, flags)
    }

    private fun pendingFor(id: String): PendingIntent {
        val i = Intent(this, PlaybackService::class.java).setAction("key:$id")
        val flags = if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        else PendingIntent.FLAG_UPDATE_CURRENT
        return PendingIntent.getService(this, id.hashCode(), i, flags)
    }

    /**
     * 通知栏 / 耳机按键的播放暂停：**就地切**，不再绕一圈 WebView。
     *
     * 以前这里只发一条 `hotkey://action` 给前端，前端 togglePlay 再把命令下发回原生。
     * 一个来回要穿过 JS 主线程（那一刻它很可能正在渲染歌词），真机上的感受就是
     * 「点了等半拍才动，而且完全没有点击反馈」（用户 2026-11-01 的原话）。
     *
     * 音频到底在不在响只有原生知道，就地切完 `push()` 一帧，前端会跟随
     * `player://state` 更新界面（PlayerProvider 的 onPlayerEvent 就是干这个），
     * 语义不变、链路短了一大截。`updateNotif()` 立刻重建通知，图标当场翻面，
     * 这就是那颗键的「点击反馈」。
     *
     * 播放器还不存在 / 还没 prepared（首包前、正在取链）时仍然交给前端走完整链路。
     */
    private fun setPlayingInService(want: Boolean, fromFocus: Boolean = false) {
        val p = mp
        if (p == null || !prepared) {
            /* 焦点回调里没有播放器可动——绝不能退化成 `playpause`，那是反着切 */
            if (fromFocus) return
            /*
             * 服务里没有可用的播放器，但**预告里还有下一首**：直接用它开播。
             *
             * 用户在这个场景里看到的是「点了锁屏那颗播放键，响了，但歌名/歌词/封面
             * 全是上一首的，而且只放一首就又停」——因为老写法只把 `playpause` 递给
             * WebView：前端要是已经被系统回收/冻住，这一下就石沉大海；偶尔接上了，
             * 它也只能 resume 一个并不存在的播放器。
             *
             * 预告项里带着标题/歌手/专辑/封面/时长，[playPrefetched] 会把它们
             * 一起写进 `NowPlaying`、媒体会话和通知——所以走这条路的「信息」是对的，
             * 而且播完还能接着消费预告里的下一项，不会只放一首就断。
             *
             * 只在 `want = true` 时走：暂停一个不存在的播放器没有意义。
             */
            if (want) {
                val next = synchronized(prefetch) { if (prefetch.isEmpty()) null else prefetch.pollFirst() }
                if (next != null) {
                    playPrefetched(next)
                    return
                }
            }
            action("playpause")
            return
        }
        /* 用户自己按的这一下：焦点补偿作废，别再替他续播 */
        if (!fromFocus) focusPaused = false
        val playing = try { p.isPlaying } catch (_: Exception) { false }
        if (playing == want) {
            if (want) requestFocus()
            push()
            return
        }
        wantPlay = want
        if (want) requestFocus()
        safe { if (want) p.start() else p.pause() }
        push()
        updateNotif()
    }

    private fun toggleInService() {
        val p = mp
        if (p == null || !prepared) {
            /* 没有播放器可切，语义上就是「想开始放」：交给 setPlayingInService 走预告兜底 */
            setPlayingInService(true)
            return
        }
        setPlayingInService(try { !p.isPlaying } catch (_: Exception) { true })
    }

    private fun updateNotif() {
        /*
         * 没有播放器实例**不等于**队列空了。
         *
         * 前端点播放的顺序是「先推 meta（通知要显示歌名）→ 再 play_file 建播放器」，
         * 中间那一瞬 mp 还是 null。这里要是无条件 shutdownIdle()，服务会在这个缝隙里
         * stopSelf() 把自己拆掉，紧接着的 play_file 就落进一个正在销毁的服务里——
         * 表现就是「点播放没反应」，重启应用后第一次播放必现（华为真机复现）。
         *
         * 真正的空转判定看标题：前端清空队列时会推一次 title 为空的 meta。
         * 那种情况才需要收掉通知和前台态（否则 MIUI 会画一块白板）。
         */
        if (mp == null) {
            if (metaTitle.isBlank()) shutdownIdle()
            return
        }
        val playing = try { mp?.isPlaying == true } catch (_: Exception) { false }
        /*
         * 悬浮歌词的播放键跟着**真实播放状态**翻面。
         *
         * 以前它只认前端推来的那个 playing 字段，而前端那条推送在暂停之后
         * 不会再触发（位置不变、歌词不变，effect 不重跑）——用户看到的就是
         * 「点了暂停、声音停了，但浮窗上的键还是 ⏸」。这里在每次刷新通知的
         * 同一处顺手推一下，图标就成了播放器状态的直接映射。
         */
        FloatingLyrics.setPlaying(playing)
        val n = buildNotification(playing)
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(1, n)
        if (playing) startForegroundSafe()
    }

    private fun startForegroundSafe() {
        try {
            // 状态按真实情况给：刚进 onStartCommand（还没 prepare）时 playing 是 false，
            // 通知就显示「暂停」那套图标，等 onPrepared 后再 updateNotif 换回来。
            val playing = try { mp?.isPlaying == true } catch (_: Exception) { false }
            startForeground(1, buildNotification(playing))
        } catch (_: Exception) { /* 通知权限被拒时不影响出声 */ }
    }

    private fun syncSessionMeta() {
        val s = session ?: return
        val mb = MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, metaTitle)
            .putString(MediaMetadata.METADATA_KEY_ARTIST, metaArtist)
            .putString(MediaMetadata.METADATA_KEY_ALBUM, metaAlbum)
        val dur = if (prepared) (try { (mp?.duration ?: 0) / 1000.0 } catch (_: Exception) { 0.0 }) else 0.0
        if (dur > 0) mb.putLong(MediaMetadata.METADATA_KEY_DURATION, (dur * 1000).toLong())
        art?.let { mb.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, it) }
        s.setMetadata(mb.build())
        syncSessionState()
    }

    /** 只刷播放状态（position / speed），不重建 metadata —— tick 每 250ms 走的就是这条轻的 */
    private fun syncSessionState() {
        val s = session ?: return
        val playing = try { mp?.isPlaying == true } catch (_: Exception) { false }
        s.setPlaybackState(
            PlaybackState.Builder()
                .setActions(
                    PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or
                        PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_SKIP_TO_NEXT or
                        PlaybackState.ACTION_SKIP_TO_PREVIOUS or PlaybackState.ACTION_SEEK_TO or
                        PlaybackState.ACTION_STOP
                )
                .setState(
                    if (playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED,
                    try { (mp?.currentPosition ?: 0).toLong() } catch (_: Exception) { 0L },
                    if (playing) 1f else 0f,
                )
                .build()
        )
    }

    /* ---------------- 封面大图 ---------------- */

    /**
     * 按 cover URL 异步解码大图（同一 URL 不重复取）。加载完刷一次会话和通知。
     * 线程里只做 IO + 解码；回主线程再碰 session / 通知。
     *
     * **失败要重试**：`artLoadedFor` 以前在取图**之前**就写成当前 URL，
     * 于是弱网下第一把超时（`Http.bytes` 8s 返回 null）之后，这首歌就再也不取图了——
     * 通知、锁屏页、播放页背景全黑，用户看到的就是「封面偶尔出不来」。
     * 现在只有**真拿到图**才落标记；失败隔一会儿再试，最多三把。
     */
    private fun loadArtAsync(attempt: Int = 0) {
        val url = metaCover
        if (url == null || artLoadedFor == url) return
        if (attempt == 0) {
            /* 换歌先把旧图撤掉，慢网时通知上不该留着上一首的封面 */
            art = null
            artThread?.interrupt()
        }
        val my = Thread {
            val bmp = CoverArt.fromCoverUrl(this, url)
            if (Thread.currentThread().isInterrupted) return@Thread
            if (bmp == null && attempt < ART_TRIES - 1) {
                try { Thread.sleep(900L * (attempt + 1)) } catch (_: Exception) { return@Thread }
                if (Thread.currentThread().isInterrupted) return@Thread
                /* 期间换歌了就别续：metaCover 已经变了，新那把自然有自己的重试 */
                if (metaCover == url) main.post { loadArtAsync(attempt + 1) }
                return@Thread
            }
            art = bmp
            /* 成了记 URL；三把都没成也记——否则前端每推一次 meta 就再来三把，白耗流量 */
            artLoadedFor = url
            main.post {
                if (artLoadedFor == url) {
                    syncSessionMeta()
                    updateNotif()
                }
            }
        }
        artThread = my
        my.priority = Thread.MIN_PRIORITY
        my.start()
    }

    /**
     * 再来一次的机会：锁屏页 / 播放页起来时催一把。
     *
     * 上一把彻底失败了（网络刚断、DNS 抽风）也算数——用户现在正看着这一页，
     * 这张图值得再试一次。只在「确实没有图」时动手，不打扰已经拿到的封面。
     */
    fun refetchArt() {
        if (art != null) return
        if (metaCover.isNullOrBlank()) return
        artLoadedFor = null
        loadArtAsync()
    }

    /* ---------------- 输出设备切换 ---------------- */

    private val OUT_TYPES = intArrayOf(
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
        AudioDeviceInfo.TYPE_WIRED_HEADSET,
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
        AudioDeviceInfo.TYPE_USB_HEADSET,
        AudioDeviceInfo.TYPE_USB_DEVICE,
    )

    /**
     * 切换输出音频：在「扬声器 / 有线耳机 / 蓝牙 / USB」之间轮换。
     *
     * setPreferredDevice 只影响**我们这条**播放流，不动系统全局路由——
     * 系统级的输出面板没有公开 API，各 ROM 自带的那个切不了别的应用。
     * 用户选的类型存下来：MediaPlayer 换歌会整个重建，onPrepared 里按类型补选回来，
     * 否则「切到蓝牙后下一首又跑回扬声器」。
     */
    private fun cycleOutput() {
        if (Build.VERSION.SDK_INT < 23) { toastOut("此系统版本不支持切换输出"); return }
        val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val outputs = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
            .filter { OUT_TYPES.contains(it.type) }
        if (outputs.isEmpty()) { toastOut("没有可用的输出设备"); return }
        val target = if (outputs.size == 1) outputs[0] else {
            val curType = preferredOutType
            val at = outputs.indexOfFirst { it.type == curType }
            outputs[(at + 1).mod(outputs.size)]
        }
        preferredOutType = target.type
        val mp0 = mp
        val ok = if (mp0 != null && prepared) try { mp0.setPreferredDevice(target) } catch (_: Exception) { false } else true
        toastOut(if (ok) "音频输出：${deviceName(target.type)}" else "输出切换失败")
    }

    /** onPrepared 之后按上次选的类型补选输出（换歌重建播放器时路由会丢） */
    private fun applyPreferredOut(p: AudioEngine) {
        if (Build.VERSION.SDK_INT < 23) return
        val want = preferredOutType ?: return
        val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val dev = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS).firstOrNull { it.type == want }
        if (dev != null) try { p.setPreferredDevice(dev) } catch (_: Exception) {}
    }

    private fun deviceName(type: Int): String = when (type) {
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "扬声器"
        AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "有线耳机"
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "蓝牙耳机"
        AudioDeviceInfo.TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_USB_DEVICE -> "USB 音频"
        else -> "输出设备"
    }

    private fun toastOut(msg: String) {
        main.post { Toast.makeText(this, msg, Toast.LENGTH_SHORT).show() }
    }

    /* ---------------- 音频焦点 ---------------- */

    /**
     * 焦点变化的回调。`main.post` 是必须的：系统在自己的线程上回调，
     * 这里接着要动 MediaPlayer 和通知，都只能在主线程碰。
     */
    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        main.post { onFocusChange(change) }
    }

    private fun requestFocus() {
        val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        if (Build.VERSION.SDK_INT >= 26) {
            if (focus == null) {
                focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(
                        AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_MEDIA)
                            .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                            .build()
                    )
                    .setOnAudioFocusChangeListener(focusListener, main)
                    /*
                     * 系统提示音这类「可以压低」的情况，这里选**压低音量**而不是暂停：
                     * 通知响一下就停歌、响完再续，听感比压低更碎。
                     * 真正的另一个播放器申请的是 AUDIOFOCUS_GAIN，走 LOSS 那条分支暂停并续播。
                     */
                    .setWillPauseWhenDucked(false)
                    .build()
            }
            focus?.let { am.requestAudioFocus(it) }
        } else {
            @Suppress("DEPRECATION")
            am.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN)
        }
    }

    private fun onFocusChange(change: Int) {
        /*
         * 焦点这首状态机在真机上只能靠「另一台应用抢一下」来观察，
         * 留一行日志：产品反馈「又和别的应用一起响了」时，先看这行有没有来过。
         */
        Log.i("SyFocus", "change=$change focusPaused=$focusPaused ducked=$duckedFrom prepared=$prepared")
        when (change) {
            AudioManager.AUDIOFOCUS_GAIN -> {
                if (duckedFrom >= 0f) { duckedFrom = -1f; applyVolume() }
                /*
                 * 焦点还回来了：只有「因为被抢才停的」才续播。
                 * 用户自己在别处点过暂停时 `focusPaused` 已经被清掉，这里不会硬拉起。
                 */
                if (focusPaused) {
                    focusPaused = false
                    setPlayingInService(true, fromFocus = true)
                }
            }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
                val p = mp ?: return
                if (!prepared) return
                if (duckedFrom < 0f) duckedFrom = volume
                safe { p.setVolume(volume * 0.2f) }
            }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT, AudioManager.AUDIOFOCUS_LOSS -> {
                if (duckedFrom >= 0f) { duckedFrom = -1f; applyVolume() }
                val p = mp ?: return
                if (!prepared) return
                val playing = try { p.isPlaying } catch (_: Exception) { false }
                if (!playing && !wantPlay) return
                focusPaused = true
                setPlayingInService(false, fromFocus = true)
                /*
                 * 被永久抢走（另一个播放器）时**不放弃焦点请求**：
                 * 放弃就等于退出恢复栈，对方结束后再也轮不到我们。
                 * 真正的收尾在 stopPlayback / 服务销毁时做。
                 */
            }
        }
    }

    /** 音量统一从这里下发：被压低时仍然按 20% 算，别让一次「调音量」把压低态冲掉 */
    private fun applyVolume() {
        val v = if (duckedFrom >= 0f) volume * 0.2f else volume
        safe { mp?.setVolume(v) }
    }

    private fun abandonFocus() {
        val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        focusPaused = false
        duckedFrom = -1f
        if (Build.VERSION.SDK_INT >= 26) focus?.let { am.abandonAudioFocusRequest(it) }
        else @Suppress("DEPRECATION") am.abandonAudioFocus(focusListener)
    }

    override fun onDestroy() {
        stopTick()
        try { unregisterReceiver(screenRx) } catch (_: Exception) {}
        FloatingLyrics.onShownChanged = null
        if (instance === this) instance = null
        safe { mp?.tap?.shutdown() }
        safe { mp?.release() }
        mp = null
        session?.release()
        session = null
        super.onDestroy()
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // 应用被划掉：如果没在播就收摊，正在播则继续（音乐播放器的常识）
        if (mp?.isPlaying != true) stopPlayback()
        super.onTaskRemoved(rootIntent)
    }

    private inline fun safe(block: () -> Unit) {
        try { block() } catch (_: Exception) {}
    }
}
