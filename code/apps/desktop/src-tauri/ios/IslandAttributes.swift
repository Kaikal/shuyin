import ActivityKit
import Foundation

/// 灵动岛 Live Activity 的属性表。
///
/// **主 App 与 Widget 扩展各编一份这份源码，两边必须逐字一致**：
/// `Activity.request` 用主 App 里的定义，`ActivityConfiguration` 用扩展里的，
/// ContentState 走 Codable 序列化跨进程传，字段名对不上就是解码失败。
@available(iOS 16.2, *)
struct IslandAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        /// 歌名。空串时 UI 兜底画「疏音」。
        var title: String
        /// 歌手。空串时 UI 不画这一行。
        var artist: String
        /// 是否在播（决定 ⏸ / ▶ 与进度条走不走）。
        var playing: Bool
        /// 推送那一刻的播放位置（秒）。进度条由系统按墙钟自走，
        /// 播放中不用每秒推一帧（省 Live Activity 的 update 配额）。
        var pos: Double
        /// 当前曲时长（秒，0=未知）。
        var dur: Double
        /// 专辑封面（JPEG 字节，已由主 App 压到 ≤256px）。nil=没有/沿用旧的。
        /// Codable 跨进程直传，几百 KB 换一次歌可以接受。
        var art: Data?
    }
    /// 主题色（hex，系统画胶囊装饰用）。activity 的固定属性，起来后不能改。
    var theme: String
}
