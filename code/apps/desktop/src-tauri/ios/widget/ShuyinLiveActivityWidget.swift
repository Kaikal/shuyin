import ActivityKit
import Foundation
import SwiftUI
import UIKit
import WidgetKit

/* ------------------------------------------------------------------ */
/* 配色：与 App 的 global.css 对齐                                       */
/*   --sy-text-1   #EAEBF1                                             */
/*   --sy-text-2   #9B9EAE                                             */
/*   --sy-accent   #6E8BFF                                             */
/* 锁屏卡不设背景色（吃系统壁纸材质），所以这里不再需要背景色常量。        */
/* 扩展进程里拿不到 CSS 变量，只能各抄一份；改主题时两边一起改。          */
/* ------------------------------------------------------------------ */

private let syText1 = Color(red: 234 / 255, green: 235 / 255, blue: 241 / 255)
private let syText2 = Color(red: 155 / 255, green: 158 / 255, blue: 174 / 255)
private let syAccent = Color(red: 110 / 255, green: 139 / 255, blue: 255 / 255)

/// 点卡片 / 点岛回 App 用的 scheme（主 App 的 Info.plist 里注册了 `shuyin`）。
///
/// 不写成 `URL(string:)!` 散落各处：字面量拼错就是「点了没反应」，
/// 而且 Apple 明确说**同一个视图层级里超过一个 `widgetURL` 行为未定义**，
/// 所以这里只留一个常量，锁屏卡用它做 `widgetURL`，岛内一律用 `Link`。
private let syLiveURL = URL(string: "shuyin://live")!

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
/* 进度条 / 时间                                                        */
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

/// 已播时间（进度条左边那格）。系统媒体卡是「已播 —条— 剩余」的三段式。
private struct ElapsedLabel: View {
    let state: ShuyinActivityAttributes.ContentState

    var body: some View {
        Group {
            if Progress.canTick(state) {
                // countsDown: false = 从 0 往上走，正好是「已播」
                Text(timerInterval: Progress.start(state)...Progress.end(state), countsDown: false)
            } else {
                Text(TimeLabel.clock(max(0, state.position)))
            }
        }
        .monospacedDigit()
        .font(.system(size: 11, weight: .medium))
        .foregroundStyle(syText2)
    }
}

/* ------------------------------------------------------------------ */
/* 声波条                                                               */
/* ------------------------------------------------------------------ */

/// 紧凑态左侧的「正在播放」声波。
///
/// 系统媒体胶囊的左侧就是一组高低错落的声波条（播放中）/ 暂停图标（停了），
/// 这里照着画。Live Activity 的扩展进程里跑不了逐帧动画（WidgetKit 的时间线
/// 不支持连续动画），所以条高是固定的错落排布——静态的，但一眼就是那个意思。
private struct WaveformBars: View {
    let playing: Bool

    /// 播放中每根条的高度（pt）。数量别多：紧凑态左侧宽度有限。
    private static let bars: [CGFloat] = [7, 12, 9, 14, 8, 11]

    var body: some View {
        Group {
            if playing {
                HStack(spacing: 2.5) {
                    ForEach(0..<Self.bars.count, id: \.self) { i in
                        Capsule()
                            .fill(syAccent)
                            .frame(width: 2.5, height: Self.bars[i])
                    }
                }
            } else {
                Image(systemName: "pause.fill")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(syText2)
            }
        }
        .frame(width: 24, height: 16, alignment: .center)
    }
}

/* ------------------------------------------------------------------ */
/* 可点区域                                                             */
/* ------------------------------------------------------------------ */

/// 可点的封面（**只给锁屏卡用**）。
///
/// 点一下在「大封面」和「普通卡」之间切换（用户参考的是酷狗那张卡：
/// 点封面换成整块封面，再点换回来）。切换本身不在这里做——发个 intent 出去，
/// 由主 App 进程里的 Rust 记真值并重推 ContentState，前端 JS 冻着也不影响。
/// iOS 16 没有 `Button(intent:)`，那边退化成纯图。
private struct ArtTap: View {
    let state: ShuyinActivityAttributes.ContentState
    let size: CGFloat

    var body: some View {
        Group {
            if #available(iOS 17.0, *) {
                Button(intent: ShuyinToggleArtIntent()) {
                    Artwork(art: state.art, size: size)
                }
                .buttonStyle(.plain)
            } else {
                Artwork(art: state.art, size: size)
            }
        }
        /* 外层 OpenBackground 关掉了整块 hit testing，这里单独开回来，
         * 保证「点封面放大」仍优先于「点卡片回 App」。 */
        .allowsHitTesting(true)
    }
}

/// 灵动岛里的封面：**点一下打开 App**，不是切大图。
///
/// 为什么不能复用 `ArtTap`（这个是 2026-11-23 用户报「灵动岛打不开 APP」的真凶之一）：
///   · `big` 只影响**锁屏卡**的形态，岛里没有「大封面」这个展示位——
///     在岛上点封面，`big` 翻了也看不出任何变化，等于「点了没反应」；
///   · 更糟的是它是个 `Button`，**Button 会吃掉这次点击**，于是本该
///     「点一下回 App」的落点被一个没有可见效果的动作占住，App 自然打不开。
private struct ArtLink: View {
    let state: ShuyinActivityAttributes.ContentState
    let size: CGFloat

    var body: some View {
        OpenTap {
            Artwork(art: state.art, size: size)
        }
    }
}

/// 「点一下回 App」的通用包装。
///
/// 2026-11-25 第四次修这个问题后的最终形态：**用 `Button(intent: ShuyinOpenIntent)`，
/// 不用 `Link` / `widgetURL`**。
///
/// 为什么 Link 不行：用户实测得很清楚——收藏/上下曲/播放暂停/封面放大全都有效
/// （说明 intent 通道完全正常），唯独点卡片空白处打不开 App（Link/widgetURL 那条
/// 自定义 scheme 在 iOS 18 锁屏上被系统吞了，尽管 Safari 里同一个 scheme 能打开）。
///
/// 为什么这次 intent 可以：`ShuyinOpenIntent` 设了 `openAppWhenRun = true`。
/// Apple 官方文档明确 `LiveActivityIntent` 会按前台模式在主 App 进程执行；
/// 之前注释说「openAppWhenRun 也不生效」是把 DTS 关于「intent 内部不能调 URL」
/// 的话误读了。Apple 自己的 AlarmKit 示例就是这么回 App 的。
///
/// 紧凑 / 最小态不适用这里：那两态没有 region 之分、放不进 Button，
/// 仍走下面 `DynamicIsland` 上的 `.widgetURL`。
private struct OpenTap<Content: View>: View {
    private let content: () -> Content

    init(@ViewBuilder content: @escaping () -> Content) {
        self.content = content
    }

    var body: some View {
        if #available(iOS 17.0, *) {
            Button(intent: ShuyinOpenIntent()) {
                content()
            }
            .buttonStyle(.plain)
        } else {
            // iOS 16.2~16.x 没有 Button(intent:)，退化成 Link（部分场景可用）
            Link(destination: syLiveURL) { content() }
        }
    }
}

/// 让一整块区域可点回 App，但**不吞掉内部已有的按钮**（封面放大 / 播放控制）。
///
/// 做法：把可点视图铺成背景层（`Button`），真正的内容叠在上面并让内容本身
/// 不接收点击（`allowsHitTesting(false)`），再在需要保留交互的子视图上
/// 单独打开 hit testing。SwiftUI 里 Button 套 Button 行为未定义，
/// 所以用「背景按钮 + 前景内容」而不是嵌套。
private struct OpenBackground<Content: View>: View {
    private let content: () -> Content

    init(@ViewBuilder content: @escaping () -> Content) {
        self.content = content
    }

    var body: some View {
        ZStack {
            if #available(iOS 17.0, *) {
                Button(intent: ShuyinOpenIntent()) {
                    Color.clear
                }
                .buttonStyle(.plain)
            } else {
                Link(destination: syLiveURL) { Color.clear }
            }
            content()
                /* 文字/进度/留白都透传给底下的回 App 按钮；
                 * 内部真正要点的 Button（封面放大、播放控制）在各自视图上
                 * 重新打开 hit testing，所以仍优先响应它们自己的 intent。 */
                .allowsHitTesting(false)
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
    /// 锁屏卡 = `true`：文字用 `.primary` 适配壁纸材质；岛展开态恒黑用白。
    var onCard = false

    var body: some View {
        HStack(spacing: 26) {
            Button(intent: ShuyinFavIntent()) {
                Image(systemName: state.fav ? "star.fill" : "star")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(state.fav ? syAccent : (onCard ? Color.primary : .white))
            }
            Button(intent: ShuyinPrevIntent()) {
                Image(systemName: "backward.fill")
                    .font(.system(size: 17, weight: .semibold))
            }
            Button(intent: ShuyinPlayPauseIntent()) {
                Image(systemName: state.playing ? "pause.fill" : "play.fill")
                    .font(.system(size: 23, weight: .semibold))
            }
            Button(intent: ShuyinNextIntent()) {
                Image(systemName: "forward.fill")
                    .font(.system(size: 17, weight: .semibold))
            }
        }
        .foregroundStyle(onCard ? Color.primary : .white)
        // plain 是必须的：默认 Button 样式会套一层系统蓝，在岛里很脏
        .buttonStyle(.plain)
        .tint(onCard ? .primary : .white)
        /* 岛展开态的 Controls 不在 OpenBackground 内，这句只为锁屏卡
         * 那张卡（整卡被 OpenBackground 关了 hit testing）把按钮点回来。 */
        .allowsHitTesting(true)
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
///
/// `adaptive`：锁屏卡不设背景色、吃系统壁纸材质，文字得用 `.primary` 让系统按
/// 材质明暗自动选黑/白（岛展开态背景恒黑，用固定白色就够了）。
private struct LyricLine: View {
    let text: String
    var centered = false
    var adaptive = false

    var body: some View {
        if !text.isEmpty {
            Text(text)
                .font(.system(size: 12.5, weight: .medium))
                .foregroundStyle(adaptive ? Color.primary.opacity(0.85) : syText1.opacity(0.9))
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

    /*
     * 锁屏卡 = **整张媒体卡**，对齐 QQ 音乐 2026-11-26 的真机截图：
     *   [封面] [歌名 — 歌手]                    [声波]
     *          [歌词]
     *   [已播 —— 进度条 —— 剩余]
     *   [收藏   上一首   播放   下一首]
     *
     * 之前压成一行歌词条是为了避开「和系统媒体卡重复」，实测用户要的就是
     * QQ 音乐这种整卡——别再往回退。
     *
     * 颜色策略：**不设** `activityBackgroundTint`，吃系统默认的壁纸模糊材质；
     * 文字一律 `.primary`，系统按材质明暗自动选黑/白（QQ音乐那张卡片上的
     * 深色字就是这么来的）。岛展开态背景恒黑，那边继续用固定白色。
     */
    var body: some View {
        OpenBackground {
            VStack(spacing: 12) {
                HStack(spacing: 10) {
                    ArtTap(state: state, size: 46)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(state.artist.isEmpty ? state.title : "\(state.title) — \(state.artist)")
                            .font(.system(size: 14.5, weight: .semibold))
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                        LyricLine(text: state.line, adaptive: true)
                    }
                    Spacer(minLength: 4)
                    Image(systemName: state.playing ? "waveform" : "pause.fill")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(.primary.opacity(0.55))
                        .padding(.trailing, 2)
                }
                HStack(spacing: 6) {
                    ElapsedLabel(state: state)
                    ProgressBar(state: state)
                    TimeLabel(state: state, compact: true)
                }
                if #available(iOS 17.0, *) {
                    Controls(state: state, onCard: true)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
        }
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
                /*
                 * 展开态照着**系统媒体展开卡**的样子排：
                 *   [大封面] [歌名/歌手] …… [圆形播放键]
                 *   [歌词 / 进度条 + 已播·剩余]
                 *   [收藏 上一首 播放 下一首]
                 * 酷狗那张岛就是这个骨架——它也是实时活动（ActivityKit），
                 * 「点一下进 App / 长按展开」都是 Live Activity 的标准行为。
                 */
                DynamicIslandExpandedRegion(.leading) {
                    /* 岛内封面 = 回 App（见 ArtLink 的注释），不是切大图 */
                    ArtLink(state: context.state, size: 52)
                        .padding(.leading, 2)
                }
                DynamicIslandExpandedRegion(.center) {
                    /* 歌名/歌手整块也是回 App 的落点（用 `OpenTap`） */
                    OpenTap {
                        VStack(alignment: .leading, spacing: 2) {
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
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    /* 右上角 = 声波（QQ 音乐同款：播放/暂停在下方控制排正中） */
                    OpenTap {
                        WaveformBars(playing: context.state.playing)
                    }
                    .padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(spacing: 10) {
                        /*
                         * 歌词 + 进度条这一块也包一层「回 App」：用户的手指
                         * 最容易落在这两行上，而它们原本什么都不会发生。
                         */
                        OpenTap {
                            VStack(spacing: 8) {
                                LyricLine(text: context.state.line, centered: true)
                                HStack(spacing: 6) {
                                    ElapsedLabel(state: context.state)
                                    ProgressBar(state: context.state)
                                    TimeLabel(state: context.state, compact: true)
                                }
                            }
                        }
                        if #available(iOS 17.0, *) {
                            Controls(state: context.state)
                        }
                    }
                    .padding(.top, 8)
                }
            } compactLeading: {
                /*
                 * 紧凑态**左侧 = 声波**（系统媒体胶囊的招牌布局：
                 * 左边一组声波条、右边一张封面）。
                 *
                 * 点击回 App 用的还是那条被验证过的通道：
                 * `Button(intent: ShuyinOpenIntent)` + `openAppWhenRun=true`
                 * （`Link` 在紧凑态不生效，`.widgetURL` 的自定义 scheme 实测被吞）。
                 */
                OpenTap {
                    WaveformBars(playing: context.state.playing)
                }
            } compactTrailing: {
                /*
                 * 紧凑态**右侧 = 封面**，和系统媒体胶囊同款。
                 */
                ArtLink(state: context.state, size: 22)
            } minimal: {
                // 同时挂着两三条岛时只剩这么点地方，只放封面
                Artwork(art: context.state.art, size: 17)
            }
            /*
             * 岛内整块的默认落点 = 回 App。
             *
             * 这是 Apple 给 `DynamicIsland` 自己的 `widgetURL(_:)`（文档原话：
             * 「通过此函数设置的 URL 会成为每个实时活动视图用于深度链接的默认
             * URL；如果包含 Link，Link 的优先级高于它」）。
             *
             * 紧凑 / 最小态里这块是**唯一**的点击目标——那两态没有 region 之分，
             * `Link` 只有在展开态才生效（Apple DTS 原话：「Link ... does work in
             * Dynamic Island expanded view」），所以小胶囊全靠这条 widgetURL。
             * 展开态则相反：`DynamicIsland` 这条 + 各 region 内的 `Link` 共存时
             * `Link` 优先，不会互相抢。
             *
             * 注意不能给每个 region 各挂一个 widgetURL：同一层级多个 widgetURL
             * 是未定义行为，系统只认其中一个，反而可能全都不生效。
             */
            .widgetURL(syLiveURL)
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
