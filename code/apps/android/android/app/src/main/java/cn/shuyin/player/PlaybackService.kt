package cn.shuyin.player

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaMetadata
import android.media.MediaPlayer
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import org.json.JSONObject

/**
 * 播放服务：界面上所有「出声」的事都归它。
 *
 * 为什么必须是前台服务：安卓在应用退到后台后随时会回收进程，
 * 音乐播放器一旦被回收就是「切出去两分钟歌就停了」。前台服务 + MediaSession
 * 还顺带把锁屏 / 通知栏 / 蓝牙耳机 / 车机方控的按键都接了进来。
 *
 * 播放器本身用系统自带的 MediaPlayer（不引 ExoPlayer）：
 * 曲目来自本地媒体库和平台直链，MediaPlayer 覆盖得足够，也让整个 APK 只依赖框架。
 */
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

    private var mp: MediaPlayer? = null

    /**
     * prepare 之前读 duration / currentPosition 会让 MediaPlayerNative 打一行
     * 「Attempt to call getDuration in wrong state / error (-38,0)」。
     * 每 250ms 的 tick 都读一次 = 每秒四条错误日志，把真正的错误埋掉。
     */
    private var prepared = false
    private var session: MediaSession? = null
    private var focus: AudioFocusRequest? = null

    private var trackPath: String? = null
    private var trackUrl: String? = null
    private var index: Int = -1
    private var volume: Float = 1f
    private var pendingSeekSec: Double = 0.0
    private var endedFlag = false
    private var seekingFlag = false
    private var errorText: String? = null
    private var wantPlay = false

    private val main = Handler(Looper.getMainLooper())
    private var ticker: Runnable? = null
    private var lastNotifPlaying: Boolean? = null
    private var metaTitle = ""
    private var metaArtist = ""
    private var metaAlbum = ""

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Sy.init(this)
        createChannel()
        session = MediaSession(this, "shuyin").apply {
            setCallback(object : MediaSession.Callback() {
                override fun onPlay() = action("playpause")
                override fun onPause() = action("playpause")
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
                open(intent.getDoubleExtra("startAt", 0.0), intent.getBooleanExtra("autoplay", true), 0.0)
            }
            ACT_PLAY_URL -> {
                trackUrl = intent.getStringExtra("url")
                trackPath = null
                index = intent.getIntExtra("index", -1)
                open(intent.getDoubleExtra("startAt", 0.0), intent.getBooleanExtra("autoplay", true), intent.getDoubleExtra("durationHint", 0.0))
            }
            ACT_PAUSE -> { wantPlay = false; safe { mp?.pause() }; push(); updateNotif() }
            ACT_RESUME -> { wantPlay = true; startForegroundSafe(); safe { mp?.start() }; push(); updateNotif() }
            ACT_TOGGLE -> action("playpause")
            ACT_STOP -> stopPlayback()
            ACT_SEEK -> doSeek(intent.getDoubleExtra("secs", 0.0))
            ACT_VOLUME -> {
                volume = intent.getFloatExtra("volume", 1f).coerceIn(0f, 1f)
                safe { mp?.setVolume(volume, volume) }
                push()
            }
            ACT_META -> {
                metaTitle = intent.getStringExtra("title") ?: ""
                metaArtist = intent.getStringExtra("artist") ?: ""
                metaAlbum = intent.getStringExtra("album") ?: ""
                syncSessionMeta()
                updateNotif()
            }
            // 通知栏的上一首 / 下一首：交给前端决定放哪一首
            "key:prev" -> action("prev")
            "key:next" -> action("next")
        }
        return START_NOT_STICKY
    }

    /* ---------------- 打开一条音源 ---------------- */

    private fun open(startAt: Double, autoplay: Boolean, durationHint: Double) {
        wantPlay = autoplay
        errorText = null
        endedFlag = false
        pendingSeekSec = startAt
        safe { mp?.release() }
        mp = null

        val player = MediaPlayer()
        mp = player
        prepared = false
        player.setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                .build()
        )
        player.setVolume(volume, volume)
        player.setOnPreparedListener {
            prepared = true
            val dur = it.duration / 1000.0
            if (pendingSeekSec > 0 && dur > 0) {
                seekingFlag = true
                it.seekTo((pendingSeekSec * 1000).toInt())
                pendingSeekSec = 0.0
            }
            if (wantPlay) {
                it.start()
                startForegroundSafe()
                requestFocus()
            }
            syncSessionMeta()
            updateNotif()
            push()
        }
        player.setOnCompletionListener {
            endedFlag = true
            wantPlay = false
            push()
            // 立刻收掉前台态：下一首会在前端被拉起（见 PlayerProvider 的 ended 分支）
            updateNotif()
        }
        player.setOnErrorListener { _, what, extra ->
            errorText = "播放失败（$what/$extra）"
            wantPlay = false
            push()
            true
        }
        player.setOnSeekCompleteListener {
            seekingFlag = false
            push()
        }

        try {
            if (trackUrl != null) {
                val headers = HashMap<String, String>()
                // 部分 CDN 会按 UA/来源拦，和探测时保持一致最容易复现「能播」的结果。
                // 注意：MediaPlayer 没有 setDataSource(String, Map)，headers 只有
                // (Context, Uri, Map) 这个重载收，且对 content:// 才真正生效；
                // http 链接会先试 ContentResolver 失败、再回退成裸 URL（日志里那行
                // FileNotFoundException 是正常的回退路径，不是错误）。
                headers["User-Agent"] = "Mozilla/5.0 (Linux; Android ${Build.VERSION.RELEASE}) Shuyin"
                player.setDataSource(this, Uri.parse(trackUrl), headers)
            } else {
                val p = trackPath ?: throw IllegalStateException("没有曲目路径")
                if (p.startsWith("content://")) player.setDataSource(this, Uri.parse(p))
                else player.setDataSource(p)
            }
            player.prepareAsync()
        } catch (e: Exception) {
            errorText = "无法打开音频：${e.message}"
            push()
        }

        // 时长提示：MediaPlayer 在 prepare 前 duration 是 0，前端界面先用平台的时长顶着
        if (durationHint > 0) {
            snapshot.put("duration", durationHint)
        }
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
        safe { mp?.stop() }
        safe { mp?.release() }
        mp = null
        prepared = false
        trackPath = null
        trackUrl = null
        index = -1
        push()
        abandonFocus()
        safe { session?.setPlaybackState(PlaybackState.Builder().setState(PlaybackState.STATE_STOPPED, 0, 1f).build()) }
        if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE) else @Suppress("DEPRECATION") stopForeground(true)
        stopSelf()
    }

    /* ---------------- 状态 ---------------- */

    private fun push() {
        val p = mp
        val playing = try { p?.isPlaying == true } catch (_: Exception) { false }
        val dur = if (prepared) (try { (p?.duration ?: 0) / 1000.0 } catch (_: Exception) { 0.0 }) else 0.0
        val pos = if (prepared) (try { (p?.currentPosition ?: 0) / 1000.0 } catch (_: Exception) { 0.0 }) else 0.0
        // MediaPlayer 不暴露「已缓冲到哪儿」，这里恒为 0：
        // 前端把 0 当作「没有第二层进度」，界面不会因此错位（见 ProgressControl）
        val buffered = 0.0

        val snap = JSONObject().apply {
            put("playing", playing)
            put("position", if (dur > 0) pos.coerceAtMost(dur) else pos)
            put("duration", if (dur > 0) dur else snapshot.optDouble("duration", 0.0))
            put("volume", volume.toDouble())
            put("track_path", trackPath ?: JSONObject.NULL)
            put("track_url", trackUrl ?: JSONObject.NULL)
            put("index", index)
            put("ended", endedFlag)
            put("seeking", seekingFlag)
            put("error", errorText ?: JSONObject.NULL)
            put("buffered", buffered)
        }
        snapshot = snap
        // ended / error 是一次性的：推一次之后清掉，否则前端会反复「跳下一首」
        endedFlag = false
        errorText = null
        emit?.invoke("player://state", snap.toString())

        if (playing != lastNotifPlaying) {
            lastNotifPlaying = playing
            updateNotif()
            requestFocus()
        }
    }

    private fun startTick() {
        stopTick()
        val r = object : Runnable {
            override fun run() {
                try { push() } catch (_: Exception) {}
                main.postDelayed(this, 250)
            }
        }
        ticker = r
        main.postDelayed(r, 250)
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

    private fun buildNotification(playing: Boolean): Notification {
        val open = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val openPi = PendingIntent.getActivity(
            this, 0, open,
            if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE else PendingIntent.FLAG_UPDATE_CURRENT
        )
        val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, "playback")
        else @Suppress("DEPRECATION") Notification.Builder(this)

        b.setContentTitle(metaTitle.ifBlank { "疏音" })
            .setContentText(listOf(metaArtist, metaAlbum).filter { it.isNotBlank() }.joinToString(" · "))
            .setSmallIcon(R.mipmap.ic_notif)
            .setContentIntent(openPi)
            .setOngoing(playing)
            .setOnlyAlertOnce(true)
            .setVisibility(Notification.VISIBILITY_PUBLIC)

        // 三条动作全部回到前端去执行：队列逻辑只有前端有一份，服务端不该自己猜下一首是谁
        b.addAction(Notification.Action.Builder(android.R.drawable.ic_media_previous, "上一首", pendingFor("prev")).build())
        b.addAction(
            Notification.Action.Builder(
                if (playing) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play,
                if (playing) "暂停" else "播放",
                intentFor(ACT_TOGGLE),
            ).build()
        )
        b.addAction(Notification.Action.Builder(android.R.drawable.ic_media_next, "下一首", pendingFor("next")).build())

        if (Build.VERSION.SDK_INT >= 21) {
            b.setStyle(Notification.MediaStyle().setMediaSession(session?.sessionToken).setShowActionsInCompactView(0, 1, 2))
        }
        return b.build()
    }

    /** 通知栏按键不直接操作播放器，而是回到前端：队列逻辑（下一首是谁）只在前端有一份 */
    private fun pendingFor(id: String): PendingIntent {
        val i = Intent(this, PlaybackService::class.java).setAction("key:$id")
        val flags = if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        else PendingIntent.FLAG_UPDATE_CURRENT
        return PendingIntent.getService(this, id.hashCode(), i, flags)
    }

    private fun updateNotif() {
        if (mp == null) return
        val playing = try { mp?.isPlaying == true } catch (_: Exception) { false }
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
        s.setMetadata(
            MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, metaTitle)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, metaArtist)
                .putString(MediaMetadata.METADATA_KEY_ALBUM, metaAlbum)
                .build()
        )
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

    /* ---------------- 音频焦点 ---------------- */

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
                    .setOnAudioFocusChangeListener { }
                    .build()
            }
            focus?.let { am.requestAudioFocus(it) }
        } else {
            @Suppress("DEPRECATION")
            am.requestAudioFocus(null, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN)
        }
    }

    private fun abandonFocus() {
        val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        if (Build.VERSION.SDK_INT >= 26) focus?.let { am.abandonAudioFocusRequest(it) }
        else @Suppress("DEPRECATION") am.abandonAudioFocus(null)
    }

    override fun onDestroy() {
        stopTick()
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
