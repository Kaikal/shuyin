import ActivityKit
import CoreFoundation
import SwiftUI
import WidgetKit

/// 灵动岛 Live Activity 的 Widget 扩展侧。
///
/// iOS 规定 Live Activity 的 UI **必须**在 WidgetKit 扩展里（ActivityKit 的
/// `ActivityConfiguration` 在主 App 里编不过），主 App 只负责 request/update/end
/// （`ShuyinIsland.swift`）。扩展 target 由 CI 的 `install-swift.rb` 现场创建
/// （`tauri ios init` 每次从零生成工程），`IslandAttributes` 两边各编一份。
///
/// ## 系统默认行为即需求（酷狗同款）
///
///   · compact 胶囊长在摄像头挖孔两侧，**点一下 = 打开 App**（系统默认）；
///   · **长按 = 系统自动展开**（系统默认），展开态是下面这个布局；
///   · 最小化区（别的 App 也占灵动岛时）画一根波形。
///
/// ## 展开态的播控按钮
///
/// `Button(intent:)`（iOS 17+）跑在**扩展进程**里，够不到主 App 二进制。
/// 走 Darwin 通知跨进程转发：post `cn.shuyin.island.cmd.*`，主 App 的观察者
/// （`ShuyinIsland.registerObserverIfPossible`）收到后调 Rust 的
/// `shuyin_remote_command`。字符串与那边**逐字一致**，改一边必须改另一边。
let islandCmdPrefix = "cn.shuyin.island.cmd."

/// 主题色：流金（#FFC94D），与桌面歌词 / 安卓灵动岛的强调色一致。
private let islandAccent = Color(red: 1.0, green: 0.79, blue: 0.30)

/// 扩展进程里发 Darwin 通知（无负载，命令编码在通知名里）。
private func islandPost(_ cmd: String) {
    CFNotificationCenterPostNotification(
        CFNotificationCenterGetDarwinNotificationCenter(),
        CFNotificationName("\(islandCmdPrefix)\(cmd)" as CFString),
        nil, nil, true,
    )
}

@main
struct ShuyinIslandWidgets: WidgetBundle {
    var body: some Widget {
        ShuyinIslandLive()
    }
}

struct ShuyinIslandLive: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: IslandAttributes.self) { context in
            /* 锁屏上的卡片（Live Activity 同时出现在灵动岛和锁屏，共用一份 state） */
            IslandLockView(s: context.state)
        } dynamicIsland: { context in
            DynamicIsland { expanded in
                let s = context.state
                DynamicIslandExpandedRegion(.leading) {
                    Image(systemName: "music.note")
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundColor(islandAccent)
                        .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(s.title.isEmpty ? "疏音" : s.title)
                            .font(.system(size: 15, weight: .semibold))
                            .lineLimit(1)
                            .allowsTightening(true)
                        Text(s.artist.isEmpty ? " " : s.artist)
                            .font(.system(size: 11))
                            .foregroundColor(.secondary)
                            .lineLimit(1)
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    HStack(spacing: 14) {
                        islandCtlIcon("backward.end.fill")
                        islandCtlButton(s.playing ? "pause.fill" : "play.fill", cmd: "playpause")
                        islandCtlIcon("forward.end.fill")
                        Spacer()
                        IslandProgress(s: s)
                            .frame(maxWidth: .infinity)
                    }
                    .padding(.top, 2)
                }
            } compactLeading: {
                Image(systemName: "waveform")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(islandAccent)
            } compactTrailing: {
                Image(systemName: context.state.playing ? "pause.fill" : "play.fill")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(islandAccent)
            } minimal: {
                Image(systemName: "waveform")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(islandAccent)
            }
        }
    }
}

/* ------------------------------------------------------------------ */
/* 播控                                                                */
/* ------------------------------------------------------------------ */

/// 只画图标，不接意图（上一首/下一首在 iOS 16 的旧系统上没有可交互按钮，
/// 降级为装饰；iOS 17 起三颗都能点）。
private func islandCtlIcon(_ name: String) -> some View {
    Image(systemName: name)
        .font(.system(size: 14, weight: .semibold))
        .foregroundColor(.secondary)
}

@ViewBuilder
private func islandCtlButton(_ name: String, cmd: String) -> some View {
    if #available(iOS 17.0, *) {
        Button(intent: IslandCtlIntent(cmd: cmd)) {
            Image(systemName: name)
                .font(.system(size: 16, weight: .semibold))
                .foregroundColor(islandAccent)
        }
        .buttonStyle(.plain)
    } else {
        Image(systemName: name)
            .font(.system(size: 16, weight: .semibold))
            .foregroundColor(.secondary)
    }
}

/// 播控意图：跑在扩展进程，只能发 Darwin 通知回主 App（见文件头注释）。
@available(iOS 16.0, *)
struct IslandCtlIntent: AppIntent {
    static var title: LocalizedStringResource = "播放控制"
    /// 不要因为按一下按钮就把疏音拉到前台。
    static var openAppWhenRun: Bool = false

    var cmd: String = "playpause"

    func perform() async throws -> some IntentResult {
        islandPost(cmd)
        return .result()
    }
}

/* ------------------------------------------------------------------ */
/* 进度条                                                              */
/* ------------------------------------------------------------------ */

/// 播放中：`ProgressView(timerInterval:)` 由系统按墙钟自走（update 免推）；
/// 暂停 / 时长未知：按 pos 静态画，不然暂停时进度条还在爬。
private struct IslandProgress: View {
    let s: IslandAttributes.ContentState

    @ViewBuilder
    var body: some View {
        if s.playing, s.dur > 0 {
            let start = Date().addingTimeInterval(-s.pos)
            ProgressView(timerInterval: start...start.addingTimeInterval(s.dur), countsDown: false)
                .tint(islandAccent)
        } else if s.dur > 0 {
            ProgressView(value: min(max(s.pos / s.dur, 0), 1))
                .tint(islandAccent)
        } else {
            EmptyView()
        }
    }
}

/* ------------------------------------------------------------------ */
/* 锁屏卡片                                                            */
/* ------------------------------------------------------------------ */

private struct IslandLockView: View {
    let s: IslandAttributes.ContentState

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "music.note")
                .font(.system(size: 24, weight: .semibold))
                .foregroundColor(islandAccent)
            VStack(alignment: .leading, spacing: 2) {
                Text(s.title.isEmpty ? "疏音" : s.title)
                    .font(.system(size: 15, weight: .semibold))
                    .lineLimit(1)
                Text(s.artist.isEmpty ? " " : s.artist)
                    .font(.system(size: 12))
                    .foregroundColor(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            IslandProgress(s: s)
                .frame(maxWidth: 120)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }
}
