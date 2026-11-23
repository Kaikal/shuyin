import ActivityKit
import Foundation

/// Live Activity（灵动岛 / 锁屏实时活动）的数据契约。
///
/// ⚠️ 这份文件在仓库里存了两份，**必须逐字一致**：
///   · 主 App：`src-tauri/ios/ShuyinActivityAttributes.swift`
///   · 扩展：  `src-tauri/ios/widget/ShuyinActivityAttributes.swift`
///
/// 两者分属不同的 module（主 App / Widget 扩展），Swift 无法互相 import
/// （扩展不允许链接宿主 App 的代码）。ActivityKit 的匹配不靠 module，
/// 而是靠 **类型名 + Codable 字段结构**：主进程 `Activity.request` 出来的
/// 内容被序列化交给扩展进程，扩展按同名同构的类型解回来。所以哪怕只是
/// 改一个字段名，两边也必须同时改，否则锁屏会显示上一次解析成功的内容、
/// 或者干脆空白。
/// 主 App 的部署目标比 16.1 低（老设备还要能装），所以这个类型必须自带
/// 可用性标注；真正用到它的地方（ShuyinLiveActivity.swift）都在 16.2 分支里。
@available(iOS 16.1, *)
struct ShuyinActivityAttributes: ActivityAttributes {
    /// 会随播放状态变化的部分。
    struct ContentState: Codable, Hashable {
        var title: String
        var artist: String
        var album: String
        /// 封面缩略图，base64 编码的 JPEG（**不带** `data:image/jpeg;base64,` 前缀）。
        ///
        /// 为什么要把图塞进 ContentState 而不是给个路径/URL：
        ///   · 沙箱路径扩展进程读不到（两个进程的容器不同）；
        ///   · 网络 URL 在扩展里异步加载有时间预算，锁屏刷新时会空一片。
        /// 代价是 ContentState 有 4KB 上限，所以前端必须压到 72×72 再传，
        /// 空串表示「这张图没取到」，扩展那边会画一个占位音符。
        var art: String
        var playing: Bool
        /// 这首歌是否已收藏：灵动岛/锁屏那颗星画实心还是空心。
        ///
        /// 收藏列表只有前端有一份，所以它跟着 `live_activity_sync` 一起推上来。
        var fav: Bool
        /// 锁屏卡是否放大封面（点封面在「大封面」和「普通卡」之间切换）。
        ///
        /// **不跟前端走**：这个值由灵动岛上的点击改，真值在 Rust 侧，
        /// 每次 sync 都由那边覆盖回来，前端 payload 里带的值不作数。
        var big: Bool
        /// 当前正在唱的那一句歌词（没有歌词时是空串）。
        ///
        /// 为什么不做成逐字染色：扩展进程里拿不到「当前行已经唱了多久」的精确起点
        /// （anchor 只管整首进度），自己推字会越走越偏。这里只展示整句，
        /// 由主进程在**换句那一刻**推一次——约 3~5 秒一次，不会顶到系统限流。
        ///
        /// 也因为这个值只在换句时变，主 App 进后台后 JS 被挂起，锁屏上会停在
        /// 进入后台那一刻的句子（iOS 的固有限制，不是这里的问题）。
        var line: String
        /// 锚点时刻的播放位置（秒）。
        var position: Double
        /// 整首时长（秒）。0 表示未知（在线流常见），此时不画进度条。
        var duration: Double
        /// 上面两个值对应的墙钟时间（Unix 秒）。
        ///
        /// 扩展靠它推算「现在播到哪儿」——`position + (now - anchor)`。
        /// 有了这个锚点，主进程就不必每秒推一次更新：灵动岛自己的
        /// `Text(timerInterval:)` / `ProgressView(timerInterval:)` 会走秒，
        /// 只有换歌、暂停、拖动进度这些真正的状态变化才需要开口。
        /// 这也顺带绕开了 iOS 后台对 JS 定时器的节流。
        var anchor: Double
    }
}
