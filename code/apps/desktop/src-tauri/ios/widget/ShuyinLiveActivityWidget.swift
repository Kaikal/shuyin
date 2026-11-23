import ActivityKit
import Foundation
import SwiftUI
import UIKit
import WidgetKit

/* ------------------------------------------------------------------ */
/* 配色：与 App 的 global.css 对齐                                       */
/*   --sy-bg-base  #0A0B0F                                             */
/*   --sy-text-1   #EAEBF1                                             */
/*   --sy-text-2   #9B9EAE                                             */
/*   --sy-accent   #6E8BFF                                             */
/* 扩展进程里拿不到 CSS 变量，只能各抄一份；改主题时两边一起改。          */
/* ------------------------------------------------------------------ */

private let syBg = Color(red: 10 / 255, green: 11 / 255, blue: 15 / 255)
private let syText1 = Color(red: 234 / 255, green: 235 / 255, blue: 241 / 255)
private let syText2 = Color(red: 155 / 255, green: 158 / 255, blue: 174 / 255)
private let syAccent = Color(red: 110 / 255, green: 139 / 255, blue: 255 / 255)

/* ------------------------------------------------------------------ */
/* 进度换算                                                             */
/* ------------------------------------------------------------------ */

private enum Progress {
    /// 「这首歌的第 0 秒」对应的墙钟时间。
    static func start(_ s: ShuyinActivityAttributes.ContentState) -> Date {
        Date(timeIntervalSince1970: s.anchor - max(0, s.position))
    }

    /// 「这首歌播完」对应的墙钟时间。
    static func end(_ s: ShuyinActivityAttributes.ContentState) -> Date {
        Date(timeIntervalSince1970: s.anchor - max(0, s.position) + max(0, s.duration))
    }

    /// 能不能用系统自走的计时条。
    ///
    /// 条件：正在播 + 知道总长 + 还没播过尾。
    /// 三个都满足才交给 `ProgressView(timerInterval:)` 自己走秒——
    /// 这样主进程不用每秒推送，后台 JS 被节流也不影响显示。
    static func canTick(_ s: ShuyinActivityAttributes.ContentState) -> Bool {
        s.playing && s.duration > 0 && s.position >= 0 && s.position < s.duration
    }

    /// 当前进度（0…1），只用在不走秒的静态场合。
    static func ratio(_ s: ShuyinActivityAttributes.ContentState) -> Double {
        guard s.duration > 0 else { return 0 }
        return min(max(s.position / s.duration, 0), 1)
    }
}

/* ------------------------------------------------------------------ */
/* 封面                                                                 */
/* ------------------------------------------------------------------ */

/// 封面缩略图。`art` 是 base64 JPEG（最多 4KB 的预算，前端压到 72×72）。
///
/// Live Activity 里不能用 `AsyncImage` 拉网络图——扩展进程没有网络预算，
/// 锁屏刷新时会空一片。所以宁可让主进程把图压小塞进 ContentState。
private struct Artwork: View {
    let art: String
    let size: CGFloat

    var body: some View {
        let radius = size * 0.22
        Group {
            if let data = Data(base64Encoded: art), let image = UIImage(data: data) {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
            } else {
                // 占位：暗底 + 音符。取不到封面时不能让那块变成黑窟窿
                LinearGradient(
                    colors: [syAccent.opacity(0.34), syAccent.opacity(0.12)],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
                .overlay(
                    Image(systemName: "music.note")
                        .font(.system(size: size * 0.42, weight: .medium))
                        .foregroundStyle(.white.opacity(0.62))
                )
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: radius, style: .continuous)
                .strokeBorder(Color.white.opacity(0.12), lineWidth: 0.5)
        )
    }
}

/* ------------------------------------------------------------------ */
/* 进度条                                                               */
/* ------------------------------------------------------------------ */

private struct ProgressBar: View {
    let state: ShuyinActivityAttributes.ContentState

    var body: some View {
        Group {
            if Progress.canTick(state) {
                ProgressView(
                    timerInterval: Progress.start(state)...Progress.end(state),
                    countsDown: false,
                    label: { EmptyView() },
                    currentValueLabel: { EmptyView() }
                )
                .progressViewStyle(.linear)
                .tint(syAccent)
            } else if state.duration > 0 {
                ProgressView(value: Progress.ratio(state))
                    .progressViewStyle(.linear)
                    .tint(syAccent)
            } else {
                // 在线流经常拿不到总长：画一条静态灰线，别显得像卡住
                Capsule()
                    .fill(Color.white.opacity(0.14))
                    .frame(height: 3)
            }
        }
        .scaleEffect(x: 1, y: 0.72, anchor: .center)
    }
}

/// 剩余时间 / 暂停。播放中用 `Text(timerInterval:)` 自走，暂停时显示静态位置。
private struct TimeLabel: View {
    let state: ShuyinActivityAttributes.ContentState
    var compact = false

    var body: some View {
        Group {
            if Progress.canTick(state) {
                Text(timerInterval: Progress.start(state)...Progress.end(state), countsDown: true)
                    .monospacedDigit()
                    .foregroundStyle(syText2)
            } else if state.duration > 0 {
                Text(Self.clock(max(0, state.duration - state.position)))
                    .monospacedDigit()
                    .foregroundStyle(state.playing ? syText2 : .white.opacity(0.55))
            } else {
                Image(systemName: state.playing ? "waveform" : "pause.fill")
                    .foregroundStyle(syText2)
            }
        }
        .font(.system(size: compact ? 11 : 12, weight: .medium))
    }

    static func clock(_ secs: Double) -> String {
        let t = Int(secs.rounded())
        return String(format: "%d:%02d", t / 60, t % 60)
    }
}

/// 可点的封面。
///
/// 点一下在「大封面」和「普通卡」之间切换（用户参考的是酷狗那张卡：
/// 点封面换成整块封面，再点换回来）。切换本身不在这里做——发个 intent 出去，
/// 由主 App 进程里的 Rust 记真值并重推 ContentState，前端 JS 冻着也不影响。
/// iOS 16 没有 `Button(intent:)`，那边退化成纯图。
private struct ArtTap: View {
    let state: ShuyinActivityAttributes.ContentState
    let size: CGFloat

    var body: some View {
        if #available(iOS 17.0, *) {
            Button(intent: ShuyinToggleArtIntent()) {
                Artwork(art: state.art, size: size)
            }
            .buttonStyle(.plain)
        } else {
            Artwork(art: state.art, size: size)
        }
    }
}

/* ------------------------------------------------------------------ */
/* 控制按钮（iOS 17+）                                                  */
/* ------------------------------------------------------------------ */

/// 四个按钮：收藏 / 上一首 / 播放暂停 / 下一首。
///
/// 只在 iOS 17 及以上可用：`Button(intent:)` 与 `LiveActivityIntent` 都是
/// 17 才有的。16.2~16.x 的机器退化成纯展示（锁屏那条仍然会显示）。
///
/// 「收藏」是 2026-11-23 用户点名要的（「别的 App 都有收藏按钮」）。
/// 系统锁屏卡那颗 ♥ 由 `MPRemoteCommandCenter.likeCommand` 画，但**没法染成实心**；
/// 这里这颗星是自己的，能如实反映收藏状态。
@available(iOS 17.0, *)
private struct Controls: View {
    let state: ShuyinActivityAttributes.ContentState

    var body: some View {
        HStack(spacing: 26) {
            Button(intent: ShuyinFavIntent()) {
                Image(systemName: state.fav ? "star.fill" : "star")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(state.fav ? syAccent : .white)
            }
            Button(intent: ShuyinPrevIntent()) {
                Image(systemName: "backward.fill")
                    .font(.system(size: 16, weight: .semibold))
            }
            Button(intent: ShuyinPlayPauseIntent()) {
                Image(systemName: state.playing ? "pause.fill" : "play.fill")
                    .font(.system(size: 22, weight: .semibold))
            }
            Button(intent: ShuyinNextIntent()) {
                Image(systemName: "forward.fill")
                    .font(.system(size: 16, weight: .semibold))
            }
        }
        .foregroundStyle(.white)
        // plain 是必须的：默认 Button 样式会套一层系统蓝，在岛里很脏
        .buttonStyle(.plain)
        .tint(.white)
    }
}

/* ------------------------------------------------------------------ */
/* 歌词行                                                               */
/* ------------------------------------------------------------------ */

/// 当前正在唱的那一句。
///
/// 两个刻意的决定：
///   · 空串时**什么都不画**（`if` 包住，别塞一个空 `Text`——VStack 会为它留一整行空白，
///     没歌词的纯音乐就会凭空多出一条空隙）。
///   · 长句用 `minimumScaleFactor` 压字号，不截成省略号：歌词被截掉后半句，
///     比小一号字难看得多。
private struct LyricLine: View {
    let text: String
    var centered = false

    var body: some View {
        if !text.isEmpty {
            Text(text)
                .font(.system(size: 12.5, weight: .medium))
                .foregroundStyle(syText1.opacity(0.9))
                .lineLimit(1)
                .minimumScaleFactor(0.78)
                .frame(maxWidth: .infinity, alignment: centered ? .center : .leading)
        }
    }
}

/* ------------------------------------------------------------------ */
/* 锁屏卡片                                                             */
/* ------------------------------------------------------------------ */

private struct LockScreenView: View {
    let state: ShuyinActivityAttributes.ContentState

    var body: some View {
        Group {
            if state.big { bigBody } else { compactBody }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .activityBackgroundTint(syBg)
        .activitySystemActionForegroundColor(syText1)
        /*
         * 点卡片（按钮以外的任何地方）打开疏音。
         *
         * 这一条是用户 2026-11-23 报的「灵动岛打不开应用，点击了没反应」：
         * 卡片上原本没有任何 `widgetURL` / `Link`，而封面又变成了
         * 「点一下切大图」的 Button —— 手指最容易落在封面和整排控制键上，
         * 剩下的空白区域没有明确的行为，点下去就是什么都不发生。
         * 显式给整卡挂上 scheme，至少「点卡片 = 回到 App」这条一定会成立。
         *
         * scheme 必须在主 App 的 Info.plist 里注册（CI 的 plist 补丁里有），
         * 否则系统的 url 打不开，点下去依旧没反应。
         */
        .widgetURL(URL(string: "shuyin://live"))
    }

    /// 普通形态：封面 + 歌名/歌手 + 进度 + 一句词 + 整排控制
    private var compactBody: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 11) {
                ArtTap(state: state, size: 52)

                VStack(alignment: .leading, spacing: 2) {
                    Text(state.title)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(syText1)
                        .lineLimit(1)
                    Text(state.artist.isEmpty ? "疏音" : state.artist)
                        .font(.system(size: 12))
                        .foregroundStyle(syText2)
                        .lineLimit(1)
                }

                Spacer(minLength: 6)

                /*
                 * 这里不另放播放按钮：iOS 17 下面已经有整排控制键，
                 * 再放一个就是两个播放键并排。iOS 16 没有按钮能力，
                 * 那张卡片就纯展示——比给个点不动的假按钮诚实。
                 */
                Image(systemName: state.playing ? "waveform" : "pause.fill")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(syAccent)
                    .frame(width: 22)
            }

            HStack(spacing: 8) {
                ProgressBar(state: state)
                TimeLabel(state: state, compact: true)
            }

            /*
             * 歌词放在进度条**下面**：
             * 上面那块是「封面 + 歌名 + 歌手」，一眼是「在放什么」；
             * 下面这块是「唱到哪」，跟着进度条走更顺。
             */
            LyricLine(text: state.line)

            if #available(iOS 17.0, *) {
                HStack {
                    Spacer()
                    Controls(state: state)
                    Spacer()
                }
                .padding(.top, 1)
            }
        }
    }

    /// 大封面形态（点封面切过来）：整块封面 + 歌名歌手 + 进度 + 控制。
    ///
    /// 尺寸卡在 132：锁屏上的实时活动卡片高度是系统给的，再高会被裁掉，
    /// 裁掉的是下半截控制键——那比封面小一点糟得多。
    /// 歌词行在这一形态里**不画**：封面已经占了视觉主体，再挤一行词就满了。
    private var bigBody: some View {
        VStack(spacing: 9) {
            ArtTap(state: state, size: 132)

            VStack(spacing: 2) {
                Text(state.title)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(syText1)
                    .lineLimit(1)
                Text(state.artist.isEmpty ? "疏音" : state.artist)
                    .font(.system(size: 12))
                    .foregroundStyle(syText2)
                    .lineLimit(1)
            }

            HStack(spacing: 8) {
                ProgressBar(state: state)
                TimeLabel(state: state, compact: true)
            }

            if #available(iOS 17.0, *) {
                Controls(state: state)
                    .padding(.top, 1)
            }
        }
        .frame(maxWidth: .infinity)
        .multilineTextAlignment(.center)
    }
}

/* ------------------------------------------------------------------ */
/* 灵动岛                                                               */
/* ------------------------------------------------------------------ */

@available(iOS 16.2, *)
struct ShuyinLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ShuyinActivityAttributes.self) { context in
            LockScreenView(state: context.state)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    ArtTap(state: context.state, size: 46)
                        .padding(.leading, 2)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(context.state.title)
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(.white)
                            .lineLimit(1)
                        Text(context.state.artist.isEmpty ? "疏音" : context.state.artist)
                            .font(.system(size: 12))
                            .foregroundStyle(.white.opacity(0.6))
                            .lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    /* 展开态点歌名/歌手也回 App：按钮占掉的地方之外要有明确的落点 */
                    .widgetURL(URL(string: "shuyin://live"))
                }
                DynamicIslandExpandedRegion(.trailing) {
                    TimeLabel(state: context.state)
                        .padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(spacing: 10) {
                        /* 展开态整块居中排，歌词居中比左对齐更像「字幕」 */
                        LyricLine(text: context.state.line, centered: true)
                        ProgressBar(state: context.state)
                        if #available(iOS 17.0, *) {
                            Controls(state: context.state)
                        }
                    }
                    .padding(.top, 8)
                }
            } compactLeading: {
                Artwork(art: context.state.art, size: 19)
            } compactTrailing: {
                /*
                 * 紧凑态右侧：**播放状态**，不是倒计时。
                 *
                 * 原来这里是 `TimeLabel`（`Text(timerInterval:)` 塞进 34pt）。
                 * 两个毛病（2026-11-23 用户截图里那块是空的）：
                 *   · 岛的这一格是系统给的，`timerInterval` 那种自走秒文本在
                 *     这个宽度里经常直接画不出来（宽度不够就整块被裁掉）；
                 *   · 就算画出来，倒计时也说明不了「在放还是在停」——
                 *     用户要的恰恰是后者（「状态和歌曲信息不匹配」）。
                 * 换成图标：在放 = waveform（强调色），暂停 = pause.fill（灰）。
                 */
                Image(systemName: context.state.playing ? "waveform" : "pause.fill")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(context.state.playing ? syAccent : syText2)
                    .frame(width: 24)
            } minimal: {
                // 同时挂着两三条岛时只剩这么点地方，只放封面
                Artwork(art: context.state.art, size: 17)
            }
            .keylineTint(syAccent)
        }
    }
}

@main
struct ShuyinWidgets: WidgetBundle {
    var body: some Widget {
        ShuyinLiveActivityWidget()
    }
}
