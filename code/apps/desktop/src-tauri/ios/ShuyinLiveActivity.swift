import ActivityKit
import Foundation
import UIKit

/// Live Activity（灵动岛 / 锁屏实时活动）的进程内管家。
///
/// 这里是**唯一**能创建、更新、结束 Live Activity 的地方。原因很硬：
/// `Activity` 句柄只能由发起它的进程持有，Rust 侧拿不到，前端更拿不到。
/// 所以链路是：
///
///     前端（有歌名/歌手/封面/进度真值）
///       → invoke('live_activity_sync')
///         → Rust（校验平台、序列化）
///           → 本文件（@_cdecl 导出的 C 函数）
///             → ActivityKit
///
/// 反向的控制指令走另一条路（见 ShuyinIntents.swift）。
@available(iOS 16.2, *)
enum ShuyinLive {
    /// 当前活跃的 Live Activity。
    ///
    /// 必须是静态的：`Activity.request` 返回的句柄一丢，就再也更新不了那一条，
    /// 只能等系统超时收走（表现是「灵动岛卡在上一首歌」）。
    static var activity: Activity<ShuyinActivityAttributes>?

    /// Rust 传过来的 JSON 载荷，字段名与 TS 侧一一对应。
    struct Payload: Decodable {
        let title: String
        let artist: String
        let album: String
        let art: String
        let playing: Bool
        /// 当前那句歌词。**可选**是有意的：旧前端/Rust 没带这个字段时，
        /// 只是锁屏少一行词，不该让整条 activity 解码失败（那会连封面歌名都没了）。
        let line: String?
        let position: Double
        let duration: Double
        let anchor: Double

        var state: ShuyinActivityAttributes.ContentState {
            .init(
                title: title,
                artist: artist,
                album: album,
                art: art,
                playing: playing,
                line: line ?? "",
                position: position,
                duration: duration,
                anchor: anchor
            )
        }
    }

    /// 接管上次残留的 activity。
    ///
    /// App 被系统回收后重启（从灵动岛点按钮、或者用户重新打开），内存里的句柄
    /// 已经没了，但锁屏上那条还在。不接管的话它会一直显示旧内容直到过期，
    /// 这期间新的 `request` 会再造一条——两条并排，很难看。
    static func adopt() {
        guard activity == nil else { return }
        activity = Activity<ShuyinActivityAttributes>.activities.first
    }

    static func apply(_ s: ShuyinActivityAttributes.ContentState) async {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }

        // 空标题 = 队列空了/播完了。没有可展示的东西就不要占着锁屏。
        if s.title.isEmpty {
            await end()
            return
        }

        adopt()

        // 已有活着的：原地更新（这是绝大多数情况——切歌、暂停、拖动进度）
        if let cur = activity {
            switch cur.activityState {
            case .active, .stale:
                await cur.update(ActivityContent(state: s, staleDate: nil))
                return
            default:
                // 已结束/已驳回的句柄不能复用，清掉重建
                activity = nil
            }
        }

        do {
            activity = try Activity.request(
                attributes: ShuyinActivityAttributes(),
                content: ActivityContent(state: s, staleDate: nil),
                pushType: nil
            )
        } catch {
            /*
             * 两种失败，处理方式不同：
             *
             * 1. 在后台调用 `request` —— iOS 要求发起点在前台。这时重试也没用，
             *    安静放弃，下一次状态变化（用户回到前台操作）会自然补上。
             * 2. ContentState 超过 4KB —— 几乎必然是封面图太大。降级成不带封面
             *    再发一次，宁可没有图也别整条挂不出来。
             */
            NSLog("[shuyin] live activity request failed: \(error)")
            if !s.art.isEmpty {
                var slim = s
                slim.art = ""
                activity = try? Activity.request(
                    attributes: ShuyinActivityAttributes(),
                    content: ActivityContent(state: slim, staleDate: nil),
                    pushType: nil
                )
            }
        }
    }

    static func end() async {
        adopt()
        guard let cur = activity else { return }
        activity = nil
        await cur.end(nil, dismissalPolicy: .immediate)
    }
}

/* ------------------------------------------------------------------ */
/* 给 Rust 调的 C 入口                                                  */
/*                                                                      */
/* 用 `@_cdecl` 导出成 C 符号，Rust 侧 `dlsym` 运行时查找：这样即使某次 */
/* 构建没把本文件编进主 App，也只是功能静默缺失，而不是链接期报         */
/* undefined symbol 把整个包打死。                                      */
/* ------------------------------------------------------------------ */

/// 推送一次播放状态。`json` 是 UTF-8 的 JSON（字段见 `Payload`）。
@_cdecl("shuyin_live_sync")
public func shuyinLiveSync(_ json: UnsafePointer<CChar>?) {
    guard #available(iOS 16.2, *), let json else { return }
    let text = String(cString: json)
    guard let data = text.data(using: .utf8),
          let payload = try? JSONDecoder().decode(ShuyinLive.Payload.self, from: data)
    else {
        NSLog("[shuyin] live activity payload decode failed")
        return
    }
    Task { await ShuyinLive.apply(payload.state) }
}

/// 收摊（退出播放页、清空队列、用户关掉开关）。
@_cdecl("shuyin_live_end")
public func shuyinLiveEnd() {
    guard #available(iOS 16.2, *) else { return }
    Task { await ShuyinLive.end() }
}

/// App 启动后调一次，接管上次残留的那条。
@_cdecl("shuyin_live_adopt")
public func shuyinLiveAdopt() {
    guard #available(iOS 16.2, *) else { return }
    ShuyinLive.adopt()
}
