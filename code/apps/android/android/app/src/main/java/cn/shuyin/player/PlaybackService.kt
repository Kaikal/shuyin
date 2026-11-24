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
import android.net.ConnectivityManager
import android.net.Network
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
import androidx.media3.common.PlaybackException
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
            try { it.mp?.active == true } catch (_: Exception) { false }
        } ?: false

        /**
         * 服务实例：Bridge 的 `spectrum` 命令是同步回答的，拿不到 Service 就没法读频段。
         * 前台服务在整个播放期间都活着，实例引用比 bindService 省事得多。
         */
        @Volatile
        var instance: PlaybackService? = null

        /**
         * 服务还没起来时前端递来的预告表（见 [next_prefetch] 与 onCreate 的注释）。
         *
         * 前端算预告不等播放，而 service 要等第一首 load 才会 start；这段空窗期
         * 里递的东西必须有地方存，否则整表丢掉，直接表现为「播完一首就停」。
         */
        @Volatile
        var pendingPrefetch: org.json.JSONArray? = null

        /** 上面那张表的起点（和它一起存，否则补收时会把起点丢掉） */
        @Volatile
        var pendingPrefetchBase: Int = -1

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
            put("sleep", 0)
            put("sleep_track", false)
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
     *
     * ## `focusLost` 是 2026-11-15 补的那一位
     *
     * 用户原话：「我听着听着来电话了，需要暂停，等他挂断后继续播放」——说明**没停**。
     * 根因是 LOSS 分支里那句 `if (!prepared) return`：换歌 / 首包还没到时
     * `prepared` 是 false，于是这次焦点丢失被整条丢掉；几百毫秒后 `onPrepared`
     * 一看 `wantPlay == true`，**在通话中把歌放了出来**。
     * 所以「焦点现在不在我们手里」必须单独记一位，`onPrepared` 也要看它。
     */
    private var focusPaused = false
    /** 「焦点此刻在别人手里」。不看 `prepared`，只看焦点回调本身 */
    private var focusLost = false
    /**
     * 上一次丢焦点是**永久**的（`AUDIOFOCUS_LOSS`），不是「来电这种等一下会还回来」的。
     *
     * 这一位的存在是因为 Android 的两种丢失语义完全不同：
     *   · `LOSS_TRANSIENT`（来电、导航播报）：我们还挂在焦点栈里，对方一松手系统就回一个 GAIN；
     *   · `LOSS`（另一个播放器抢走了）：**框架会立刻把我们移出焦点栈**，
     *     之后永远不会再有 GAIN。实测华为音乐一开播，`dumpsys audio` 里我们的条目
     *     当场消失——这就是用户说的「他打开了别的视频，播完也没给我接着放」。
     * 永久丢失只能靠 [probeFocusRecovery] 主动探：等到对方真的没在出声了，再申请回来。
     */
    private var lostPermanently = false
    /** 探测节流：2 秒一次就够，`isMusicActive()` 是系统调用，别每 250ms 摸一次 */
    private var focusProbeAt = 0L
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
     * 「网络断了，正在等它回来」。
     *
     * 在线曲目的音频是边下边放的，系统一休眠就容易把网掐掉（Doze、华为省电、
     * WiFi 休眠都是这个形状）。这时候**不能把 `wantPlay` 熄掉**：
     * 用户并没有要停，他只是离开了手机；熄掉之后网络回来也不会自己接上，
     * 界面上就停在某一首，用户回来只看到「播放」按钮——他 2026-11-16 报的
     * 「过一段时间被冻结、播放在线就停止」正是这条。
     *
     * 置位之后由 [netWatch] 的回调负责续播（见 onCreate）。
     * 本地缓存的曲目不联网，永远不会进这个状态——这也是为什么「已缓存的
     * 半小时都没事、在线的一段时间就停」。
     */
    @Volatile
    private var netStall = false
    private var netCb: ConnectivityManager.NetworkCallback? = null

    /**
     * 用户意图代号（前端 `epochRef` 发来的单调自增数）。
     *
     * 只解决一件事：**迟到的加载不许出声**。
     *
     * 真机日志（2026-11-15）里那个形状：
     *   `src=frontend pause` → `after pause playing=false`
     *   `open autoplay=true index=22`   ← 130ms 之后，上一轮取链回来了
     *
     * 前端下发 `play_url` 时读的是**那一刻**的 `autoCancel`，管不住已经在路上的
     * 命令。所以每条播放/暂停命令都带一个代号：原生记住最新代号，凡是代号更旧的
     * `play_file/play_url`，**音源照常准备**（进度、时长、后续秒播都在），
     * 但 `autoplay` 一律按 false 处理。弱网时这条链路能拖几秒，正是用户听到的
     * 「我明明暂停了，过一会儿又自己响」。
     */
    @Volatile
    private var intentEpoch = 0L

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
     * 上面那张表**从哪一首算起**（前端递表那一刻的队列下标）。
     *
     * 表是 FIFO，曲终只认队头。用户连点几次「下一首」之后队列已经跑到第 8 首，
     * 表还停在从第 5 首算的 `[6,7,8,9]`——队头一取，唱的就是**前面**那首。
     * 所以曲终先对起点：对不上就整表作废，交回前端（`endedFlag`）。
     * （iOS 侧同样的坑，见 `player.rs` 的 `take_next_prefetch`。）
     * `Int.MIN_VALUE` = 前端没给起点（老版本 / 补收），按老规矩信任这张表。
     */
    @Volatile
    private var prefetchBase = Int.MIN_VALUE

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
        /*
         * 补收「服务还没起来时递来的预告表」。
         *
         * 前端一挂载就算预告（不等播放），而这时 service 常常还没被 start——
         * 原来 `instance?.setPrefetch(...)` 是空安全的，于是整表**静默丢掉**，
         * 之后队列没再变过就不会重发，原生手里一首都没有：第一首放完就停在
         * 曲末（用户 2026-11-14 报的「只能播一首就暂停」）。冷启动恢复上次
         * 队列时最典型：index 没变，effect 不会再触发。
         */
        pendingPrefetch?.let { p ->
            val b = pendingPrefetchBase
            pendingPrefetch = null
            setPrefetch(p, b)
        }
        createChannel()
        /*
         * 悬浮歌词的开关真值在 FloatingLyrics 里，建窗/拆窗是 post 到主线程异步做的。
         * 挂这个回调，等窗真挂了再刷通知——那颗「词」才不会一直停在旧样式。
         */
        FloatingLyrics.onShownChanged = { updateNotif() }
        netWatch()
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
                override fun onPlay() {
                    LockScreen.trace("src=session onPlay")
                    setPlayingInService(true)
                }
                override fun onPause() {
                    LockScreen.trace("src=session onPause")
                    setPlayingInService(false)
                }
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
        /* 熄屏 / 亮屏 / 解锁 → 挂上或收起锁屏播放页那个悬浮窗 */
        try {
            registerReceiver(
                screenRx,
                IntentFilter().apply { addAction(Intent.ACTION_SCREEN_OFF) },
            )
        } catch (_: Exception) { /* 个别 ROM 限制动态注册：只是从别的应用熄屏时不弹，不影响播放 */ }
        /*
         * 拔耳机 / 断开蓝牙 → 立刻暂停。
         *
         * ExoPlayer 建的时候关掉了 `setHandleAudioBecomingNoisy(true)`（见 AudioEngine：
         * 让它自己暂停会绕过我们这套状态机，`wantPlay` 还是 true，界面和通知都会撒谎）。
         * 这里自己接这条广播，走 [setPlayingInService]，状态、通知、媒体会话一起更新。
         * 不做的话就是「拔了耳机，外放接着唱」——公共场合最尴尬的那种。
         */
        try {
            registerReceiver(
                noisyRx,
                IntentFilter().apply { addAction(AudioManager.ACTION_AUDIO_BECOMING_NOISY) },
            )
        } catch (_: Exception) { /* 同上：注册不上只是少了这个贴心动作 */ }
        /* 耳机重连自动恢复：配着 noisyRx 一起挂，缺一个就是「断了就再也回不来」 */
        try {
            (getSystemService(Context.AUDIO_SERVICE) as AudioManager)
                .registerAudioDeviceCallback(deviceCb, Handler(Looper.getMainLooper()))
        } catch (_: Exception) { /* 个别 ROM 限制：只是不会自动恢复，手动点一下照样放 */ }
        startTick()
    }

    /**
     * 盯住「默认网络回来了」这件事。
     *
     * 为什么要它，而不是只靠 ExoPlayer 自己重试：
     *
     *   · 重试有上限（见 AudioEngine 的 NetTolerantPolicy，40 次约 5 分钟）。真断得久，
     *     ExoPlayer 会放弃并进入 IDLE，之后**没有任何人**会再试一次——界面就停在那一首。
     *   · 系统休眠时 CPU 会被放掉，重试的退避可能落到 8 秒一档；而"网回来了"是个
     *     立刻可用的信号，没理由再等几秒。
     *   · 少数场景（WiFi 恢复但 IP 没变）连 `window 'online'` 都不发，只有
     *     `NetworkCallback` 靠得住。
     *
     * `mp.start()` 对 IDLE 的处理见 AudioEngine.start：先 prepare 再 play，
     * 播放位置原地保留，所以这一下就是从断点接上，不会回到 0:00。
     */
    private fun netWatch() {
        try {
            val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            val cb = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    if (!netStall) return
                    netStall = false
                    LockScreen.trace("net back → 续播 idx=$index pos=${NowPlaying.pos}")
                    main.post {
                        if (!wantPlay || mp == null) return@post
                        mp?.start()
                        push()
                        updateNotif()
                    }
                }
            }
            cm.registerDefaultNetworkCallback(cb)
            netCb = cb
            LockScreen.trace("netWatch 已注册")
        } catch (t: Throwable) {
            LockScreen.trace("netWatch 注册失败 ${t.javaClass.simpleName}")
        }
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
                val (auto, stale) = gateAutoplay(intent)
                trackPath = intent.getStringExtra("path")
                trackUrl = null
                index = intent.getIntExtra("index", -1)
                autoAdvanced = -1
                open(intent.getDoubleExtra("startAt", 0.0), auto, 0.0, if (stale) "play_file(迟到)" else "play_file")
                if (stale) LockScreen.trace("  迟到的加载（play_file）：准备音源但不出声")
            }
            ACT_PLAY_URL -> {
                val (auto, stale) = gateAutoplay(intent)
                trackUrl = intent.getStringExtra("url")
                trackPath = null
                index = intent.getIntExtra("index", -1)
                autoAdvanced = -1
                open(intent.getDoubleExtra("startAt", 0.0), auto, intent.getDoubleExtra("durationHint", 0.0), if (stale) "play_url(迟到)" else "play_url")
                if (stale) LockScreen.trace("  迟到的加载（play_url）：准备音源但不出声")
            }
            /*
             * 前端点暂停 / 继续。这两条是**用户意图**，必须先清掉「焦点补偿」标记，
             * 否则被别的应用抢过焦点之后，用户自己按了暂停，等对方结束
             * 我们还会自作主张续播一次。
             */
            /*
             * 前端的播放/暂停：**统一走 `setPlayingInService`**，不要在这里直接
             * `mp?.pause()` / `mp?.start()`。
             *
             * 直接动 `mp` 有个致命缺口：`mp == null` 时它什么也不做，而前端的
             * `loadedRef` 是**它自己**记的「我让原生加载过」。服务被系统回收、
             * 或进程从后台被系统重建时，前端记着「已加载」、原生却已经没有播放器 ——
             * 用户点播放，命令落到空处：界面乐观翻成「播放中」，下一帧又被真状态顶回来，
             * 表现就是「点了暂停一会儿又自己播 / 点了播放没反应」。
             * `setPlayingInService` 里带着兜底（没有播放器就用当前曲目或预告重新 open）。
             */
            ACT_PAUSE -> {
                LockScreen.trace(
                    "src=frontend pause why=${intent.getStringExtra("why") ?: ""} " +
                        "e=${intent.getLongExtra("epoch", 0L)} cur=$intentEpoch",
                )
                claimEpoch(intent)
                setPlayingInService(false)
            }
            ACT_RESUME -> {
                LockScreen.trace(
                    "src=frontend resume why=${intent.getStringExtra("why") ?: ""} " +
                        "e=${intent.getLongExtra("epoch", 0L)} cur=$intentEpoch",
                )
                claimEpoch(intent)
                startForegroundSafe()
                setPlayingInService(true)
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
                LockScreen.trace("meta <- \"$metaTitle\" idx=$index")
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
            "key:fav" -> {
                /*
                 * 先把那颗心翻过来，再回前端。
                 *
                 * 真值在看前端（收藏列表只有一份），但「点下去 → 前端处理完 →
                 * 推 meta 回来」在后台可能要好几秒，那几秒里图标一动不动，
                 * 用户看到的就是「点了收藏，通知栏没反应」（2026-11-24 反馈）。
                 * 先乐观翻转，前端那条 meta 到了再覆盖成真值——顺序不会错。
                 */
                metaFav = !metaFav
                NowPlaying.fav = metaFav
                updateNotif()
                action("fav")
            }
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

    private fun open(startAt: Double, autoplay: Boolean, durationHint: Double, why: String = "?") {
        /*
         * 一行日志，带**发起方**：排查「暂停之后过几秒又响」时，第一个要回答的问题
         * 就是「这条 open 是谁发的」——前端的 play_url、原生自己的兜底重开
         * （`setPlayingInService`）、还是预告表接下一首。以前三者长得一模一样，
         * 只能靠时间猜（2026-11-15 就是这么绕了两轮的）。
         */
        LockScreen.trace("open[$why] autoplay=$autoplay at=$startAt url=${trackUrl != null} index=$index")
        /*
         * 远程源：从「决定加载」这一刻就把网按住。
         *
         * 不能等起播 —— 在线歌最容易断网的位置正是**起播之前那几秒**（前端在取
         * 下一首直链、上一首已经停了，ExoPlayer 的 WAKE_MODE 锁不在手上）。
         * 本地文件则顺手把锁放掉（见 `keepNetAlive`）。
         */
        keepNetAlive(trackUrl != null)
        wantPlay = autoplay
        errorText = null
        netStall = false
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
                /*
                 * **焦点不在我们手里就不许起播。**
                 *
                 * 这一句是「来电话了歌还在放」的另一半：LOSS 到达时可能还在缓冲，
                 * 那时 `wantPlay` 已经被压成 false 了；但「先点播放、焦点后被人抢」
                 * 的时序下 `wantPlay` 还是 true，而 READY 恰好晚于 LOSS。
                 * 只有 `focusLost` 能把这两种时序分开。
                 */
                if (focusLost) {
                    LockScreen.trace("onPrepared: 焦点在别处，暂不起播")
                } else {
                    player.start()
                    startForegroundSafe()
                    requestFocus()
                }
            }
            syncSessionMeta()
            updateNotif()
            push()
        }
        player.onCompletion = {
            /*
             * 「播完当前这首就关」优先于预告表：这一首放完就该睡了，
             * 再自动接一首等于定时器白设。
             */
            if (SleepTimer.endOfTrack) {
                SleepTimer.clear()
                wantPlay = false
                endedFlag = true
                toastOut("定时关闭：这一首已播完")
                LockScreen.trace("sleep end-of-track → stop advance")
                push()
                updateNotif()
            } else {
                /*
                 * 有预告就直接接上，**没有才**交给前端。
                 *
                 * 顺序不能反：先问 JS 再兜底都会留一个空档，而空档正是"停在两首
                 * 之间"的那几秒。接上时不能置 `endedFlag`——一置前端就会再 advance
                 * 一次，等于跳过一首。
                 */
                val next = takePrefetch()
                val left = synchronized(prefetch) { prefetch.size }
                LockScreen.trace("end idx=$index prefetch=${if (next == null) "空" else next.index} 余=$left")
                if (next != null) main.post { playPrefetched(next) }
                else {
                    endedFlag = true
                    wantPlay = false
                    push()
                    updateNotif()
                }
            }
        }
        player.onError = { what, extra ->
            val net = extra == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED ||
                extra == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT
            /*
             * 这一行是排查「在线歌放着放着停了」的唯一线索，必须带全：
             * `code` 分得清 DNS 失败（2001）/ 读超时（2002）/ 403 防盗链（2003），
             * `detail` 里有 javaClass 名与原话。不带的话只能看到「播放失败（1/2001）」。
             */
            LockScreen.trace(
                "player err idx=$index code=$extra net=$net want=$wantPlay " +
                    "pos=${player.currentPosition / 1000} detail=${player.lastErrorDetail}",
            )
            if (net) {
                /*
                 * **断网不等于用户要停。**
                 *
                 * `wantPlay` 保持 true：ExoPlayer 自己会在 NetTolerantPolicy 的窗口里
                 * 一直重试；真拖到它放弃（IDLE），网络回来的那一刻由 [netWatch] 续上。
                 * 原来这里无条件 `wantPlay = false`，于是断网 6 秒后播放器判死、
                 * 意图也一起熄掉，网回来了也没有任何人再去 prepare ——
                 * 用户看到的就是「停在那不动，得手动点一下」。
                 */
                netStall = true
                errorText = "网络中断，恢复后自动继续播放"
                push()
                updateNotif()
            } else {
                /* 403/404（直链过期、防盗链）、解码失败：重试无意义，交前端换源 */
                errorText = "播放失败（$what/$extra）"
                wantPlay = false
                push()
            }
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
    fun setPrefetch(items: org.json.JSONArray, base: Int = -1) {
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
        /*
         * 这张表从哪首算起。老版本前端不带 base（-1）时按「当前这首」算——
         * 它本来就是从当前下标往后算的，这样才不至于整表作废。
         */
        prefetchBase = if (base >= 0) base else Int.MIN_VALUE
        /* 前端既然能发预告，就说明它活着并且已经知道现在放的是哪首了 */
        autoAdvanced = -1
        /* 一行日志：排查「播完一首就停」时先看这张表到底有没有递过来、递了几首 */
        LockScreen.trace("setPrefetch n=${items.length()} base=$base")
    }

    /**
     * 曲终从预告表取下一首：**起点对不上就整表作废**。
     *
     * 对不上 = 用户动过队列（连点下一首 / 点了别的歌），队头已经不是「下一首」了，
     * 宁可交回前端（`endedFlag`），也不能唱一首前面的歌。
     */
    private fun takePrefetch(): Prefetch? {
        synchronized(prefetch) {
            /* MIN_VALUE = 前端没给起点（老版本 / 服务没起来时的补收）：照旧信任这张表 */
            if (prefetchBase != Int.MIN_VALUE && prefetchBase != index) {
                val dropped = prefetch.size
                prefetch.clear()
                if (dropped > 0) {
                    LockScreen.trace("prefetch 作废 base=$prefetchBase cur=$index drop=$dropped")
                }
                return null
            }
            val p = prefetch.pollFirst() ?: return null
            /* 吃掉一项：起点跟着往前挪一首 */
            prefetchBase = p.index
            return p
        }
    }

    /**
     * 原生自己接上下一首（不走 intent，也不等 JS）。
     *
     * 元信息、封面、通知、媒体会话都要一起换——否则会出现「声音已经是下一首、
     * 通知栏还挂着上一首」。`autoAdvanced` 是给前端的对账标记。
     */
    private fun playPrefetched(p: Prefetch) {
        if (mp == null && p.title.isBlank()) { shutdownIdle(); return }
        LockScreen.trace("prefetch→ idx=${p.index} \"${p.title}\" left=${synchronized(prefetch) { prefetch.size }}")
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
        open(0.0, true, p.duration, "prefetch")
        startForegroundSafe()
        requestFocus()
        updateNotif()
        push()
    }

    /** 把命令里带的代号记成「当前意图」；不带（0）就什么都不做 */
    private fun claimEpoch(intent: Intent) {
        val e = intent.getLongExtra("epoch", 0L)
        if (e > intentEpoch) intentEpoch = e
    }

    /**
     * 判断这条加载命令是不是「迟到」的。
     *
     * 返回 (是否自动起播, 是否迟到)。**迟到的照常准备音源、只是不出声**——
     * 直接丢弃会让「暂停时正好在加载的那首」永远没准备好，用户下次点播放
     * 又要干等一轮取链。
     */
    private fun gateAutoplay(intent: Intent): Pair<Boolean, Boolean> {
        val want = intent.getBooleanExtra("autoplay", true)
        val e = intent.getLongExtra("epoch", 0L)
        val stale = e > 0L && intentEpoch > 0L && e < intentEpoch
        if (e > intentEpoch) intentEpoch = e
        /* 只在「确实判成迟到」时留痕：这是排查「暂停后又响」唯一有用的那一行 */
        if (stale) LockScreen.trace("  判为迟到 e=$e cur=$intentEpoch want=$want")
        return (want && !stale) to stale
    }

    private fun doSeek(sec: Double) {
        val p = mp ?: return
        seekingFlag = true
        safe { p.seekTo((sec.coerceAtLeast(0.0) * 1000).toInt()) }
        push()
    }

    /* ---------------- 熄屏别把网掐了 ---------------- */

    private var wifiLock: android.net.wifi.WifiManager.WifiLock? = null
    private var cpuLock: android.os.PowerManager.WakeLock? = null

    /**
     * 在线播放会话期间持有 WiFi + CPU 锁。
     *
     * **为什么必须有这一把锁**（2026-11-18 真机实证）：本机 `wifi_sleep_policy=1`，
     * 熄屏 75 秒后从 shell `ping music.163.com` 已经 100% 丢包、`dumpsys wifi`
     * 显示 `Wi-Fi is disabling`。而在线歌最容易出事的位置恰恰是**换歌那几秒**：
     * 上一首已经播完或被 pause，ExoPlayer 的 `WAKE_MODE_NETWORK` 此时不持锁，
     * 前端去取下一首的直链，于是日志里成片 `Unable to resolve host`（酷狗/酷我/
     * 网易云一起失败），表填不上，播完就停 —— 用户说的「播着播着就停止」。
     * 播本地缓存不受影响，正因为那不需要网（用户的观察完全对得上）。
     *
     * 所以按「当前曲是不是远程源」持锁，**跟 playing 无关**：切歌间隙 playing
     * 本来就是 false，而那正是最需要网的时候。`stopPlayback()`（队列清空 / 用户
     * 主动停）才放。
     */
    private fun keepNetAlive(on: Boolean) {
        if (on) {
            try {
                val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as android.net.wifi.WifiManager
                val l = wifiLock ?: wm.createWifiLock(
                    android.net.wifi.WifiManager.WIFI_MODE_FULL_HIGH_PERF, "shuyin:online",
                ).apply { setReferenceCounted(false) }.also { wifiLock = it }
                if (!l.isHeld) {
                    l.acquire()
                    LockScreen.trace("wifiLock 持有（在线会话，熄屏不断网）")
                }
            } catch (e: Throwable) {
                LockScreen.trace("wifiLock 失败: ${e.message}")
            }
            try {
                val pm = getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
                val l = cpuLock ?: pm.newWakeLock(
                    android.os.PowerManager.PARTIAL_WAKE_LOCK, "shuyin:online",
                ).apply { setReferenceCounted(false) }.also { cpuLock = it }
                if (!l.isHeld) l.acquire()
            } catch (_: Throwable) { /* 拿不到就退化：只剩 WifiLock 也能撑住 DNS */ }
        } else {
            try { wifiLock?.takeIf { it.isHeld }?.release() } catch (_: Throwable) {}
            try { cpuLock?.takeIf { it.isHeld }?.release() } catch (_: Throwable) {}
        }
    }

    private fun stopPlayback() {
        wantPlay = false
        endedFlag = false
        /* 用户把播放停掉了：耳机再回来也不该自己开始放 */
        resumeOnDeviceBack = false
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
        /* 会话结束了：把「熄屏别断网」那把锁放掉，别替一个不播的播放器耗电 */
        keepNetAlive(false)
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

    /*
     * 熄屏这件事要**两份**监听，各管一半：
     *
     *   · 主窗口在前台（用户就在应用里按电源键）→ `MainActivity.screenRx` 直接铺面板，
     *     窗口本来就在，挂个 `showWhenLocked` 就够；
     *   · 主窗口在后台（用户在桌面/微信里熄屏）→ 启动独立的 `LockActivity` 铺页。
     *     它有自己的任务栈，浮在 keyguard 和原应用之上，退场 `finish()` 后原应用
     *     亮回来——主任务从头到尾不被挪动，不会再出现「解锁落到桌面」。
     *     （老做法把主任务 moveTaskToFront 拉上来，退场只能 moveTaskToBack = 按 Home，
     *     已废弃；见 LockActivity 顶部注释。）
     *
     * 为什么不用悬浮窗：Android 在锁屏上隐藏所有非系统 overlay 窗口，实测
     * `isVisible=false`，亮屏后看到的还是系统锁屏。见 LockScreen 的注释。
     */
    /** 上一次跨应用锁屏拉起的时间（elapsedRealtime）：华为 SCREEN_OFF 来两趟，用来去重 */
    private var lockLaunchAt = 0L
    private val screenRx = object : BroadcastReceiver() {
        override fun onReceive(c: Context?, intent: Intent?) {
            if (intent?.action != Intent.ACTION_SCREEN_OFF) return
            LockScreen.trace("SCREEN_OFF in service playing=${NowPlaying.playing}")
            if (!LockScreen.enabled(this@PlaybackService)) { LockScreen.trace("  skip: disabled"); return }
            if (!NowPlaying.playing) { LockScreen.trace("  skip: not playing"); return }
            /*
             * 前台那半交给窗口自己处理，别两边一起拉。
             *
             * 用**严格**判定（resumed），不带 1.2 秒宽限：用户刚切到微信就熄屏时，
             * 宽限会把「已经不可见的窗口」算成前台 → 这一趟被 skip，而窗口那边
             * 也铺不出（它在后台）→ 锁屏页彻底不出现。
             */
            if (MainActivity.visibleNow()) { LockScreen.trace("  skip: foreground"); return }
            /*
             * **窗口那边已经铺好了面板，这一趟是重复广播。**
             *
             * 华为的 SCREEN_OFF 会来两趟（系统广播一趟、onPause 发现屏幕已黑再兜一趟），
             * 第二趟到服务时窗口已经 onPause，`foregroundNow()` 过了 1.2 秒宽限就变成
             * false —— 服务以为窗口在后台，于是 `startActivity` + `moveTaskToFront` +
             * 一颗 700ms 后的闹钟 PendingIntent 把任务栈重排一遍。
             * 真机日志（19:09:12 铺面板 / 19:09:14 服务又拉一次）就是这个时序，
             * 用户看到的是「解锁后回到桌面」「点图标进来却弹着锁屏页」。
             */
            if (MainActivity.screenOffHandled()) { LockScreen.trace("  skip: handled by window"); return }
            /*
             * **窗口在后台（用户在别的应用里熄屏）→ 交给独立的 LockActivity 铺页。**
             *
             * 以前这里会 `bringMainUp`：把主任务顶到前台、挂上 `showWhenLocked`。
             * 代价在 2026-11-18 上午实测过（ALN-AL00 / EMUI 14.2）：我们一 Resume
             * 就把用户当前的应用顶掉；退场只有 `moveTaskToBack`，实测语义 = 按 Home
             * （退完后桌面 visible=true，微信 task 活着却在下面）→「解锁落到桌面」。
             *
             * 现在**主任务一个像素都不动**：`LockActivity` 是独立任务
             * （自有 taskAffinity + excludeFromRecents），浮在 keyguard 和原应用之上；
             * 退场 `finish()` = 任务消失、原应用亮回来。见 LockActivity 顶部注释。
             */
            if (LockActivity.alive) { LockScreen.trace("  skip: LockActivity alive"); return }
            val nowMs = android.os.SystemClock.elapsedRealtime()
            if (nowMs - lockLaunchAt < 1500) { LockScreen.trace("  skip: just launched"); return }
            lockLaunchAt = nowMs
            val intent = LockActivity.launchIntent(this@PlaybackService)
            LockScreen.addMiuiFlags(intent)
            val ok = try { startActivity(intent); true } catch (_: Throwable) {
                LockScreen.trace("  cross-app: startActivity 抛异常")
                false
            }
            LockScreen.trace("  cross-app: startActivity ok=$ok")
            if (ok) {
                /*
                 * 1.2 秒后对一次账：没收到回执（`markAck`）也没看到活动活着，
                 * 说明这一趟被 ROM 静默拦了。先**直接再试一次**——BAL 拦截有
                 * 「首帧被丢、紧接着放行」的窗口（华为实测常见），再不行才记一笔
                 * 给设置页，并用系统闹钟代发一颗 PendingIntent
                 * （系统替我们发，不算应用自己在后台拉 Activity；
                 *  锁屏期间可能被压到解锁之后才送，那颗会因 TTL 被丢弃）。
                 */
                val sentAt = System.currentTimeMillis()
                main.postDelayed({
                    if (LockActivity.alive || LockScreen.ackedSince(sentAt)) return@postDelayed
                    LockScreen.trace("  cross-app: 未收到回执 → 立刻重试一次")
                    try {
                        val again = LockActivity.launchIntent(this@PlaybackService)
                        LockScreen.addMiuiFlags(again)
                        startActivity(again)
                    } catch (_: Throwable) { /* 这次抛了就交给下面的闹钟 */ }
                    main.postDelayed({
                        if (LockActivity.alive || LockScreen.ackedSince(sentAt)) return@postDelayed
                        LockScreen.markBgBlocked(this@PlaybackService)
                        LockScreen.trace("  cross-app: 重试也拦住了 → 闹钟代发兜底")
                        try {
                            val am = getSystemService(Context.ALARM_SERVICE) as android.app.AlarmManager
                            val pi = LockActivity.alarmPending(this@PlaybackService)
                            val trig = android.os.SystemClock.elapsedRealtime() + 700
                            val canExact = Build.VERSION.SDK_INT >= 31 && am.canScheduleExactAlarms()
                            if (canExact) {
                                am.setExactAndAllowWhileIdle(
                                    android.app.AlarmManager.ELAPSED_REALTIME_WAKEUP, trig, pi,
                                )
                            } else {
                                am.setAndAllowWhileIdle(
                                    android.app.AlarmManager.ELAPSED_REALTIME_WAKEUP, trig, pi,
                                )
                            }
                        } catch (_: Throwable) { /* 兜底失败就算了：锁屏上没有这一页而已 */ }
                    }, 700)
                }, 1200)
            }
        }
    }

    /**
     * 「因为耳机断开才停的」——耳机回来就自动接着放。
     *
     * 安卓系统自己不做这件事（它只会发 ACTION_AUDIO_BECOMING_NOISY 让你暂停，
     * 重连时**不发任何东西**）。酷狗 / QQ 音乐那种「蓝牙断一下再连上，歌自己继续」
     * 是 App 自己记的意图，这里补上。
     *
     * 判据必须是「断开那一刻真的在播」：用户自己按了暂停再插拔耳机，
     * 不能被我们擅自开始放。
     */
    @Volatile
    private var resumeOnDeviceBack = false

    /** 拔耳机 / 蓝牙断开：按「用户暂停」处理，通知与状态一起收 */
    private val noisyRx = object : BroadcastReceiver() {
        override fun onReceive(c: Context?, intent: Intent?) {
            if (intent?.action != AudioManager.ACTION_AUDIO_BECOMING_NOISY) return
            /*
             * 先读播放态再暂停：反过来读到的永远是 false，标志就永远记不上，
             * 用户听到的仍然是「重连了不自己放」（这一行顺序是整段的关键）。
             */
            resumeOnDeviceBack = playingNow()
            LockScreen.trace("BECOMING_NOISY → pause (resume=${resumeOnDeviceBack})")
            setPlayingInService(false)
        }
    }

    /**
     * 耳机 / 蓝牙回来 → 把断连时那一首接着放。
     *
     * 只认「输出类」设备（A2DP / SCO / 有线耳机 / USB 声卡）：
     * 插充电线、连手柄也会走 onAudioDevicesAdded，那些不该让音乐突然响起来。
     */
    private val deviceCb = object : android.media.AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) {
            val out = addedDevices.any { d ->
                when (d.type) {
                    AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
                    AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
                    AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
                    AudioDeviceInfo.TYPE_WIRED_HEADSET,
                    AudioDeviceInfo.TYPE_USB_HEADSET,
                    AudioDeviceInfo.TYPE_HEARING_AID,
                    -> true
                    else -> false
                }
            }
            if (!out || !resumeOnDeviceBack) return
            resumeOnDeviceBack = false
            LockScreen.trace("device back → resume")
            setPlayingInService(true)
        }
    }

    /**
     * 立刻刷一帧（不改变 tick 节奏）。
     *
     * 熄屏时 tick 降到 800ms 省电，用户按电源键亮屏这一刻，锁屏页手里的位置/歌词
     * 可能最多差一拍——他第一眼看到的就是「歌词慢半句」。亮屏那一下补一帧，
     * 画面一出来就是准的。
     */
    fun pushNow() {
        try { push() } catch (_: Exception) { /* 播放器刚好在换源：下一拍自己会补 */ }
    }

    /** 把「当前播放面」同步给悬浮歌词 / 锁屏页（它们只读这份镜像） */
    private fun syncNowPlaying() {        NowPlaying.title = metaTitle
        NowPlaying.artist = metaArtist
        NowPlaying.album = metaAlbum
        NowPlaying.fav = metaFav
        NowPlaying.cover = art
        NowPlaying.playing = try { mp?.active == true } catch (_: Exception) { false }
        /*
         * 歌词时间轴在原生这边推进：位置是从播放器刚读出来的（毫秒级），
         * 一拍之内算出的当前句就是耳朵听到的那一句。没时间轴时这是个空操作，
         * 锁屏页退回前端 `float_lyric` 推过来的那份。
         */
        NowPlaying.syncLyrics(NowPlaying.pos)
    }

    /* ---------------- 状态 ---------------- */

    private fun push() {
        val p = mp
        val playing = try { p?.active == true } catch (_: Exception) { false }
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
            /*
             * `want`：原生记着的「准备好了就播」。
             *
             * 这是前端判定「用户点这一下到底是想播还是想停」的唯一可靠依据：
             * 取链完成、`play_url` 已经下发、prepare 还在跑的时候**没有任何声音**，
             * 但原生手里 `wantPlay == true`——几秒后就会出声。此时界面显示的是
             * 「播放」图标（因为还没出声），用户点它十有八九是「别放了」；
             * 前端看到这一位为 true 就把这点翻译成取消，而不是再 resume 一次。
             */
            put("want", wantPlay)
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
            /*
             * 预告表还剩几首。
             *
             * 前端补表原来只靠一个 1200ms 的 setTimeout，而**熄屏后 WebView 会把
             * 定时器节流到分钟级**——表用完之后要等好几分钟才补，中间那几首就靠
             * `ended` 一帧交给 JS，而 JS 这会儿正好最不愿意干活。于是「在线歌单
             * 播几首就停、缓存的能一直播」（缓存项不需要取链，`setPrefetch` 一次就够）。
             *
             * 现在把余量摊在每帧状态里（这帧是原生用 evaluateJavascript 推的，
             * 不受定时器节流影响），前端看到 0 就立刻补一次。
             */
            put("pf", synchronized(prefetch) { prefetch.size })
            /*
             * 定时关闭：`sleep` 是剩余秒数（0 = 没开），`sleep_track` = 「等这首放完」。
             * 前端只做显示（播放页那颗小钟 / 设置页那一行），倒计时的真值在原生
             * （理由见 SleepTimer）。每秒都在变，跟着 250ms 的 tick 一起推不额外花钱。
             */
            put("sleep", if (SleepTimer.endAt > 0L) ((SleepTimer.remainMs() + 999) / 1000).toInt() else 0)
            put("sleep_track", SleepTimer.endOfTrack)
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
                /*
                 * 定时关闭的对表放在 tick 里，不放前端：熄屏之后 WebView 的定时器
                 * 会被系统摁住，而「定时关掉」的主场景恰恰是熄屏躺着听（见 SleepTimer）。
                 */
                try { checkSleep() } catch (_: Exception) {}
                /* 被别的播放器永久抢走焦点之后，等它播完再自己接回来（见 probeFocusRecovery） */
                try { probeFocusRecovery() } catch (_: Exception) {}
                main.postDelayed(this, tickInterval())
            }
        }
        ticker = r
        main.postDelayed(r, 250)
    }

    /**
     * 定时关闭到点了：**先记意图、再淡出**。
     *
     * `wantPlay = false` 必须先写：淡出要 1.8 秒，这段时间播放器还在出声，
     * 前端/通知上仍然显示「在播」。要是等 exo 真停了再改，中间那一拍
     * `playing=true / want=false` 会让用户点播放时被自己判成「取消」。
     */
    private fun checkSleep() {
        if (!SleepTimer.due()) return
        SleepTimer.clear()
        val p = mp
        if (p == null || !(try { p.active } catch (_: Exception) { false })) {
            /* 已经停了：定时器过期就完事，别提示，也别去动队列 */
            push()
            return
        }
        wantPlay = false
        p.fadeOutAndPause(1800)
        toastOut("定时关闭：已暂停播放")
        LockScreen.trace("sleep fired → fadeOutAndPause")
        push()
        updateNotif()
    }

    /** 屏幕是不是亮着（有人正看着）。查询本身很便宜，跟着 tick 走没问题。 */
    private fun screenOn(): Boolean = try {
        (getSystemService(Context.POWER_SERVICE) as PowerManager).isInteractive
    } catch (_: Exception) {
        true
    }

    /**
     * 当前声音从哪儿出去（外放 / 蓝牙 / 有线 / USB）。
     *
     * 只为了排查「点了暂停声音还在响几秒」这类主观描述：外放是毫秒级切断，
     * 蓝牙耳机（尤其 LDAC / aptX 那类）自己手里还攥着一两秒的缓冲，
     * 手机这边 AudioTrack 已经 paused，耳朵里还能听见尾巴。日志里带上这个
     * 设备类型，一眼就能把「代码没停」和「耳机还在放」分开。
     */
    private fun outRoute(): String = try {
        val am = getSystemService(Context.AUDIO_SERVICE) as android.media.AudioManager
        am.getDevices(android.media.AudioManager.GET_DEVICES_OUTPUTS)
            .filter { it.isSink }
            .joinToString(",") { "${it.type}" }
            .ifBlank { "?" }
    } catch (_: Exception) {
        "?"
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
        val playing = try { mp?.active == true } catch (_: Exception) { false }
        return if (playing) 800L else 2500L
    }

    private fun stopTick() {
        ticker?.let { main.removeCallbacks(it) }
        ticker = null
    }

    /* ---------------- 通知 / 媒体会话 ---------------- */

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            /*
             * **必须 IMPORTANCE_DEFAULT，不能 LOW。**
             *
             * 2026-11-18 真机 A/B（EMUI 14.2 / Android 12），四个组合各测一遍：
             *
             *   LOW + 自绘卡        → 锁屏上**整条不出现**（静默通知被系统藏掉）
             *   LOW + 系统模板      → 锁屏只有一行「歌名 / 歌手」，没有封面/按钮
             *   DEFAULT + 系统模板  → 锁屏一行，通知栏一行
             *   DEFAULT + 自绘卡    → **锁屏是完整卡片**：封面 + 歌名 + 进度 + 五个按钮
             *
             * 也就是说：自定义 RemoteViews 不背这个锅（曾经误判成它），
             * 真正的开关是渠道重要性 —— 静默通知在锁屏一律降级。
             *
             * 渠道重要性**建成之后应用改不了**（系统只允许改名字/描述），
             * 所以老的 "playback"(LOW) 必须换成新 ID，并把老的删掉，
             * 免得用户在系统「通知管理」里看到两个「播放控制」。
             *
             * 不加声音、不加震动：换歌不该叮一下。DEFAULT 只是让系统愿意把它
             * 画在锁屏上，不代表要吵用户。
             */
            nm.deleteNotificationChannel("playback")
            nm.createNotificationChannel(
                NotificationChannel("playback_sys", "播放控制", NotificationManager.IMPORTANCE_DEFAULT).apply {
                    setShowBadge(false)
                    setSound(null, null)
                    enableVibration(false)
                    setDescription("锁屏与通知栏的播放卡片")
                    lockscreenVisibility = Notification.VISIBILITY_PUBLIC
                },
            )
        }
    }

    /** 播放通知的渠道：见 `createChannel`（必须 DEFAULT，否则锁屏不显示） */
    private fun chId(): String = "playback_sys"

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
        val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, chId())
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
         * 2026-11-18 又核了一次「华为锁屏不显示我们的卡」，结论同上：跟自定义视图无关。
         * 四个组合（渠道 LOW/DEFAULT × 自绘/系统模板）各测一遍，唯一决定锁屏形态的是
         * 渠道重要性 —— 见 `createChannel`。DEFAULT + 这张自绘卡就是锁屏上的完整卡片。
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
            rv.setImageViewBitmap(R.id.n_cover, appTile(night, 48))
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

        rv.setImageViewBitmap(R.id.n_fav, tintedIcon(if (metaFav) R.drawable.notif_fav_on else R.drawable.notif_fav, iconInk, 22))
        rv.setImageViewBitmap(R.id.n_prev, tintedIcon(R.drawable.notif_prev, iconInk, 22))
        rv.setImageViewBitmap(R.id.n_toggle, accentDisc(if (playing) R.drawable.notif_pause else R.drawable.notif_play))
        rv.setImageViewBitmap(R.id.n_next, tintedIcon(R.drawable.notif_next, iconInk, 22))
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
            glyphIcon("词", if (FloatingLyrics.shown) lyricAccent() else iconInk, 22),
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
    private fun roundCover(src: Bitmap, dp: Int = 10): Bitmap {
        /* 和 notif_media.xml 里 n_cover 的 48dp 对齐：卡片整体压矮之后封面也得跟着缩 */
        val px = (48 * resources.displayMetrics.density).toInt().coerceAtLeast(48)
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
    private fun accentDisc(resId: Int, dp: Int = 32): Bitmap {
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
        LockScreen.trace(
            "setPlaying want=$want focus=$fromFocus mp=${p != null} prepared=$prepared " +
                "playing=${try { p?.isPlaying } catch (e: Exception) { null }} " +
                "active=${try { p?.active } catch (e: Exception) { null }} out=${outRoute()}",
        )
        /*
         * **用户按下的意图先落账，再谈有没有播放器能动。**
         *
         * 这两行以前在下面的正常分支里，而「正在准备中」和「没有播放器」两条
         * 早退路径都到不了它们 —— 于是出现用户报了很久的那个形状：
         *   1. 点了播放 → `wantPlay = true` 记在服务里，接着取链/缓冲；
         *   2. 用户改主意点暂停 → 走早退分支，`wantPlay` 还是 true；
         *   3. 缓冲完成 `onPrepared` 一看 `wantPlay` 是 true → **自己开始放**。
         * 用户看到的就是「我明明暂停了，它过一会儿又自己响起来」。
         * 焦点补偿同理：`focusPaused` 没清，焦点一还回来又替他续播一次。
         *
         * 所以放在最前面：用户自己按的一下（`fromFocus == false`）永远优先，
         * 暂停同时撤掉「等准备好就播」和「等焦点回来就播」两种待办。
         */
        if (!fromFocus) {
            focusPaused = false
            /*
             * 用户自己动手了，就别再替他「等网续播」——他可能是想换歌，也可能就是不想听了。
             * 焦点回调（fromFocus）不清：那条路上没人在操作手机。
             */
            netStall = false
            if (!want) {
                wantPlay = false
                /*
                 * **用户自己按的暂停要放弃焦点。**
                 *
                 * 攥着 AUDIOFOCUS_GAIN 却不发声，是「和其他应用抢音频输出」最典型
                 * 的来源：别家申请焦点时系统照样先让我们 LOSS 再给对方，我们这边
                 * 还要走一遍状态机；而「暂停状态下占着焦点」本身对用户毫无收益。
                 * 被抢占而暂停的那条路（fromFocus）**不放弃**——那正是恢复栈的入口。
                 */
                abandonFocus()
            }
        }
        if (p == null || !prepared) {
            /*
             * **「停」这件事不认 `prepared`，只认有没有播放器。**
             *
             * `prepared` 是我们自己记的标记（`open()` 里清掉、第一次 READY 置回）。
             * 换歌 / 恢复会话那一小段它是 false，可播放器实例已经在了——正好覆盖
             * 「声音已经在出、标记还没跟上」的窗口。以前这里对暂停一律走到函数末尾
             * 只 `push()` 一帧，等于把用户按的那一下丢了；下一次 `onPrepared`
             * 再看 `wantPlay`（同样是 false，没事）也就不会再响，但用户听到的是
             * 「我按了暂停，声音还在」——那种「按了没停」的观感就是这么来的。
             * 有播放器就停，不看标记。
             */
            if (!want && p != null) {
                wantPlay = false
                safe { p.pause() }
                LockScreen.trace("  准备中：照样执行 pause playing=${try { p.isPlaying } catch (e: Exception) { null }}")
                push()
                updateNotif()
                return
            }
            /*
             * **播放器正在准备中**（有实例、有源，只是还没 READY）：把意图记下来就走。
             *
             * 这在真机上是个高频路径：冷启动恢复会话、在线曲目取链完刚下发 `play_url`，
             * 用户这时点播放，本来只该「等它准备好就播」。以前的写法会掉进下面的兜底，
             * 用同一个 `trackPath` 再 `open()` 一次 —— 正在进行的加载被推倒重来，
             * 进度归零、还要再等一轮；用户看到的就是「点了播放，进度条跳回 0」。
             * `onPrepared` 里已经有 `if (wantPlay) player.start()`，这里只需要把话递到。
             */
            if (want && p != null && (trackPath != null || trackUrl != null)) {
                wantPlay = true
                LockScreen.trace("  准备中：记下 wantPlay，等 onPrepared 起播")
                push()
                updateNotif()
                return
            }
            /*
             * **焦点回调里没有播放器可动**：绝不能退化成 `playpause`（那是反着切），
             * 也不能为空着手去「重开一首」——焦点还回来不代表用户想听别的。
             *
             * 注意这一条必须放在上面两个分支**之后**：
             * 有播放器只是还没 READY 时（来电时正在缓冲），焦点还回来要能把
             * `wantPlay` 递进 `onPrepared`，否则挂断电话后这首歌就永远停在那儿。
             */
            if (fromFocus) {
                push()
                updateNotif()
                return
            }
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
                /*
                 * 先试「把当前这首重新拉起来」。
                 *
                 * 用户按播放键的语义是「继续听这首」，不是「跳到下一首」。原来这里
                 * 无条件拿预告表第一项开播，听到的永远是**下一首**，而锁屏页/通知上
                 * 显示的还是刚才那首的标题封面 —— 用户的原话「响是响了，但播的不是
                 * 锁屏上这首歌」。当前曲的 path/url 还在就重启同一首（播放器已经没了，
                 * 只能从头开始）。
                 */
                if (trackPath != null || trackUrl != null) {
                    open(0.0, true, snapshot.optDouble("duration", 0.0), "fallback")
                    startForegroundSafe()
                    requestFocus()
                    return
                }
                val next = takePrefetch()
                if (next != null) {
                    playPrefetched(next)
                    return
                }
            }
            /*
             * 既没有播放器、也没有当前曲目的路径（服务刚被系统重建）：**什么都不发**。
             *
             * 以前这里往前端递一条 `playpause`，指望它把播放器建起来。但前端那份
             * `playing` 也很可能是过时的：它把这条命令翻译成 resume，原生照样建不起来，
             * 于是两边来回弹 —— 用户看到的是「点了暂停，一会儿又自己播上」；
             * 而真点播放时又因为前端记着「已加载」不发加载命令，表现成「点了没反应」。
             *
             * 只推一帧真实状态，让界面自己回到「暂停」。前端已经会拿 `track_path`
             * 校正它的 `loadedRef`，下一次点播放就会走完整的加载链路。
             */
            push()
            updateNotif()
            return
        }
        /* 用户自己按的这一下：焦点补偿作废，别再替他续播 */
        if (!fromFocus) focusPaused = false
        val playing = try { p.active } catch (_: Exception) { false }
        if (playing == want) {
            if (want) requestFocus()
            push()
            return
        }
        wantPlay = want
        if (want) requestFocus()
        safe { if (want) p.start() else p.pause() }
        LockScreen.trace("  after ${if (want) "start" else "pause"} playing=${try { p.isPlaying } catch (e: Exception) { null }}")
        push()
        updateNotif()
    }

    /**
     * 自绘界面（锁屏播放页 / 悬浮歌词）上的播放暂停。
     *
     * 与通知栏那颗键走同一条路：**就地切**，然后 `push()` 一帧让前端界面跟上。
     * 不经过 WebView —— 那是上一版锁屏页「点了没反应」的根因（Activity 被回收后
     * Bridge 是空的，命令发出去没人接；接上了也会因为前端那份 playing 已经过时而
     * 反向切一次，表现成「点了暂停一下又开始播」）。
     */
    fun toggleFromUi() {
        LockScreen.trace("src=ui toggle（锁屏页/悬浮歌词） wantPlay=$wantPlay prepared=$prepared")
        toggleInService()
        updateNotif()
    }

    private fun toggleInService() {
        /*
         * 用户自己按了播放/暂停：之前「因为耳机断开才停」的那份意图作废。
         * 不作废的话，「断开 → 手动暂停 → 重连接上」会自己响起来。
         */
        resumeOnDeviceBack = false
        val p = mp
        if (p == null || !prepared) {
            /*
             * 准备中的「切一下」要**反着切当前意图**，不能一律当「想开始放」。
             *
             * 以前这里无条件 `setPlayingInService(true)`：用户点了暂停、播放器还在
             * 缓冲（`prepared == false`），锁屏页/悬浮歌词上这一下反而把 `wantPlay`
             * 又置回 true —— 缓冲一完成就自己出声。语义上「切」本来就是「取反」，
             * `wantPlay` 就是这一刻的意图真值。
             */
            setPlayingInService(!wantPlay)
            return
        }
        setPlayingInService(try { !p.active } catch (_: Exception) { true })
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
        val playing = try { mp?.active == true } catch (_: Exception) { false }
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
            val playing = try { mp?.active == true } catch (_: Exception) { false }
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
        val playing = try { mp?.active == true } catch (_: Exception) { false }
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
        val result = if (Build.VERSION.SDK_INT >= 26) {
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
            focus?.let { am.requestAudioFocus(it) } ?: AudioManager.AUDIOFOCUS_REQUEST_FAILED
        } else {
            @Suppress("DEPRECATION")
            am.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN)
        }
        /*
         * **拿到了就当作「焦点在我这儿」。**
         *
         * `focusLost` / `lostPermanently` 是「丢过焦点」的记账，只在真的拿回来时才能清。
         * 用户被别家抢走之后再手动点播放，走的就是这条路：请求成功 → 清账 →
         * 之后 `onPrepared` 才敢起播（那一句 `if (focusLost)` 会一直挡着）。
         * 拿不到（FAILED）就留着，让探测那条路继续等。
         */
        if (result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
            focusLost = false
            lostPermanently = false
        }
    }

    private fun onFocusChange(change: Int) {
        /*
         * 焦点这首状态机在真机上只能靠「另一台应用抢一下」来观察，
         * 留一行日志：产品反馈「又和别的应用一起响了」时，先看这行有没有来过。
         */
        Log.i(
            "SyFocus",
            "change=$change focusPaused=$focusPaused focusLost=$focusLost ducked=$duckedFrom " +
                "prepared=$prepared want=$wantPlay active=${try { mp?.active } catch (e: Exception) { null }}",
        )
        when (change) {
            AudioManager.AUDIOFOCUS_GAIN -> {
                focusLost = false
                lostPermanently = false
                /* 被系统压低之后的回升要慢：20% → 100% 是 5 倍增益，硬跳就是「突然变大」 */
                if (duckedFrom >= 0f) {
                    duckedFrom = -1f
                    applyVolume(AudioEngine.UNDUCK_MS)
                }
                /*
                 * 焦点还回来了：只有「因为被抢才停的」才续播。
                 * 用户自己在别处点过暂停时 `focusPaused` 已经被清掉，这里不会硬拉起。
                 */
                if (focusPaused) {
                    focusPaused = false
                    LockScreen.trace("focus gain → 续播")
                    /* 播放器已经没了（服务被回收 / 队列空）就别为了焦点去重开一首 */
                    if (mp != null) setPlayingInService(true, fromFocus = true) else push()
                }
            }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
                val p = mp ?: return
                if (duckedFrom < 0f) duckedFrom = volume
                safe { p.setVolume(volume * 0.2f, 140) }
            }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT, AudioManager.AUDIOFOCUS_LOSS -> {
                if (duckedFrom >= 0f) {
                    duckedFrom = -1f
                    applyVolume(AudioEngine.UNDUCK_MS)
                }
                /*
                 * **这里不看 `prepared`。** 换歌 / 首包之前它是 false，可播放器实例
                 * 可能已经在了，而且 `onPrepared` 一到就会自己 start —— 那正是
                 * 「来电话了，歌还在放」的形状。只要有实例就停，是不是 READY 无关紧要。
                 */
                focusLost = true
                lostPermanently = change == AudioManager.AUDIOFOCUS_LOSS
                val p = mp
                val playing = try { p?.active == true } catch (_: Exception) { false }
                if (!playing && !wantPlay) return
                focusPaused = true
                /* 意图先落账：`onPrepared` 里那句 `if (wantPlay)` 才不会把歌又拉起来 */
                wantPlay = false
                LockScreen.trace("focus loss → pause focusPaused=true")
                safe { p?.pause() }
                push()
                updateNotif()
                /*
                 * 被永久抢走（另一个播放器）时**不放弃焦点请求**：
                 * 放弃就等于退出恢复栈，对方结束后再也轮不到我们。
                 * 真正的收尾在 stopPlayback / 服务销毁时做。
                 */
            }
        }
    }

    /** 音量统一从这里下发：被压低时仍然按 20% 算，别让一次「调音量」把压低态冲掉 */
    private fun applyVolume(ms: Int = AudioEngine.RAMP_MS) {
        val v = if (duckedFrom >= 0f) volume * 0.2f else volume
        safe { mp?.setVolume(v, ms) }
    }

    private fun abandonFocus() {
        val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        focusPaused = false
        focusLost = false
        lostPermanently = false
        duckedFrom = -1f
        if (Build.VERSION.SDK_INT >= 26) focus?.let { am.abandonAudioFocusRequest(it) }
        else @Suppress("DEPRECATION") am.abandonAudioFocus(focusListener)
    }

    /**
     * 被动丢焦点之后的「接回来」探测（见 [lostPermanently]）。
     *
     * 只在「因为我们被抢而暂停」时探，用户自己按的暂停不会走到这里
     * （那条路会把 `focusPaused` 清掉）。判据两条：
     *
     *   · `AudioManager.mode` 不是通话中 —— 通话时也不能放，语音通路的焦点语义
     *     和媒体不是一套，光看「有没有音乐在响」会误判成「没人放，可以接着放」；
     *   · `isMusicActive()` 为 false —— 别家真的没在出声了（播完了 / 被用户关了）。
     *
     * 拿到焦点就续播，界面/通知一起跟上；拿不到就等下一轮，什么都不写。
     */
    private fun probeFocusRecovery() {
        if (!lostPermanently || !focusPaused) return
        val now = android.os.SystemClock.elapsedRealtime()
        if (now - focusProbeAt < 2000) return
        focusProbeAt = now
        val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        if (am.mode == AudioManager.MODE_IN_CALL || am.mode == AudioManager.MODE_IN_COMMUNICATION) return
        if (am.isMusicActive) return
        lostPermanently = false
        focusPaused = false
        LockScreen.trace("focus probe → 别家播完，接回焦点续播")
        requestFocus()
        if (mp != null) setPlayingInService(true, fromFocus = true) else push()
    }

    override fun onDestroy() {
        stopTick()
        try { unregisterReceiver(screenRx) } catch (_: Exception) { /* 没注册成功 */ }
        try { unregisterReceiver(noisyRx) } catch (_: Exception) { /* 没注册成功 */ }
        try {
            (getSystemService(Context.AUDIO_SERVICE) as AudioManager).unregisterAudioDeviceCallback(deviceCb)
        } catch (_: Exception) { /* 没注册成功 */ }
        netCb?.let { cb -> try { (getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).unregisterNetworkCallback(cb) } catch (_: Exception) { /* 已经注销 */ } }
        netCb = null
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
        /*
         * 用户把应用从「最近任务」里划掉了 —— 这是一次明确的「我不听了」。
         *
         * 以前这里写的是「正在播则继续（音乐播放器的常识）」，实际留下的却是一个
         * **没有界面的幽灵服务**：前台服务照跑，用户点通知栏回来时界面已经没了。
         * 用户 2026-11-17 的原话：「我把应用的后台退了，歌都没停止」。
         *
         * 停止 + 收摊才符合「划掉」这个动作的含义：通知一起收，服务一起走。
         */
        LockScreen.trace("onTaskRemoved：用户划掉了任务 → 停止播放并收摊")
        stopPlayback()
        super.onTaskRemoved(rootIntent)
    }

    private inline fun safe(block: () -> Unit) {
        try { block() } catch (_: Exception) {}
    }
}
