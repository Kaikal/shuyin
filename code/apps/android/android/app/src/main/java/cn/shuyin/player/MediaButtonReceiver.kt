package cn.shuyin.player

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * 媒体键（耳机线控 / 蓝牙方控 / 车机）的落点。
 *
 * 为什么需要它：只要 [PlaybackService] 还活着，按键由系统的「媒体键会话」直接
 * 送进 `MediaSession.Callback`，这个广播根本不会发出来；但会话失活（队列播空、
 * 服务刚被拉起、系统刚重启）时，系统没地方送，就会去找会话登记的
 * `mediaButtonReceiver` —— 没有登记这一条，那颗键就被系统丢掉。
 *
 * 顺带一个副作用是华为控制中心：它认一个应用是不是「正在放音乐」，看的正是
 * flags / sessionActivity / mediaButtonReceiver 这三样齐不齐（同一台机器上
 * 酷狗三样都有，我们原来三样都是空的，于是卡片一直显示「未在播放」）。
 *
 * 这里**不自己起播放**：队列、循环模式、在线取链都只在前端有一份，原生擅自
 * `start()` 一定和界面不一致。服务在就转给它（走和系统按键同一条路径），
 * 服务不在就丢掉这颗键——宁可按键没反应，也不要放出一首先前没在放的歌。
 */
class MediaButtonReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_MEDIA_BUTTON) return
        val svc = PlaybackService.instance ?: run {
            Log.i("Shuyin", "media button 到达但播放服务不在，忽略")
            return
        }
        svc.dispatchMediaButton(intent)
    }
}
