package cn.shuyin.player

import android.os.Bundle
import android.service.media.MediaBrowserService
import android.service.media.MediaBrowserService.BrowserRoot
import android.service.media.MediaBrowserService.Result
import android.media.browse.MediaBrowser
import android.util.Log

/**
 * 「我是个媒体应用」的标准声明。
 *
 * 系统（华为控制中心、车机 / HiCar、Android Auto、手表）判断一个应用能不能被接管，
 * 除了看 MediaSession，还要看它有没有实现 `android.media.browse.MediaBrowserService`
 * —— 这是安卓官方给媒体应用的接口，作用是「让外部浏览你的曲库」。真机上对过：
 * 酷狗 / 酷我 / 网易云 / QQ 音乐**四家全都实现了它**，我们原来没有，
 * 于是会话字段补齐到和酷狗一字不差，华为控制中心照样画成「未在播放」。
 *
 * 我们不需要真的对外暴露曲库（队列只在前端有一份，原生侧也不该自己切歌），
 * 所以这里只做两件事：
 *   1. 把 [PlaybackService] 里那个 MediaSession 的 token 交出去（`setSessionToken`），
 *      系统拿到它就能把控制中心那张卡片、车机方控接到正在播放的会话上；
 *   2. 曲库返回空列表——浏览端本来就该从会话的 metadata 读当前曲目，
 *      我们不给它一份会和界面打架的假数据。
 *
 * 用平台自带的 `MediaBrowserService` 而不是 media3 的 `MediaLibraryService`：
 * 播放器本身不是 media3 的 Player 实例（走的是 [AudioEngine] 那层封装），
 * 换 session 体系等于把整条播放链路重写；而这个服务的职责只有「交出 token」一件事。
 */
@Suppress("DEPRECATION")
class MediaBrowserBridge : MediaBrowserService() {

    /**
     * 系统对 service 的绑定可能比播放服务早起（车机冷启、控制中心先被拉开都会）。
     * 那时还拿不到会话，`onGetRoot` 里再补一次——但 `setSessionToken` **只能调一次**
     * （第二次抛 `IllegalStateException: The session token has already been set`，
     * 真机上就是这么崩的），所以自己记着有没有交过。
     */
    private var tokenSet = false

    override fun onCreate() {
        super.onCreate()
        adoptToken()
    }

    private fun adoptToken() {
        if (tokenSet) return
        val token = PlaybackService.instance?.sessionToken() ?: return
        setSessionToken(token)
        tokenSet = true
    }

    override fun onGetRoot(clientPackageName: String, clientUid: Int, rootHints: Bundle?): BrowserRoot? {
        adoptToken()
        /* 会话还没起来（播放服务未启动）：返回空 root，等下次绑定 */
        if (!tokenSet) return null
        return BrowserRoot(ROOT_ID, null)
    }

    override fun onLoadChildren(parentId: String, result: Result<List<MediaBrowser.MediaItem>>) {
        /* 空曲库：控制中心 / 车机只读会话里的当前曲目，不需要我们这份列表 */
        result.sendResult(emptyList())
        Log.i("Shuyin", "MediaBrowser 浏览请求 $parentId：返回空列表")
    }

    private companion object {
        const val ROOT_ID = "shuyin"
    }
}
