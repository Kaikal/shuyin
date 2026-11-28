import ActivityKit
import Darwin
import Foundation
import UIKit

/// iOS「灵动岛」：ActivityKit Live Activity 的主 App 侧管理器。
///
/// ## 2026-11-28 起：**不再自绘**，岛上完全交给系统
///
/// 用户定案：「用系统那个，不要自绘」，并且明确把设置里「用疏音胶囊替代系统
/// 『正在播放』」那一项也去掉。所以现在 iOS 上：
///
///   · 岛 = iOS 自带的「正在播放」——系统按 `MPNowPlayingInfoCenter` 自己画
///     胶囊、自己展开播控，点一下打开疏音。零权限、零配额、零扩展依赖。
///   · 本文件这套 Live Activity 只在**历史遗留**时收尾：老版本把开关写过 true，
///     启动时 `disableOwn()` 把存档改回关、把还挂着的 activity end 掉，
///     然后把 `setNowPlayingInfo` 让回给系统（`smtc::apply` 里的互斥看 `live()`，
///     这时恒为 false）。
///
/// 为什么彻底关掉而不是留着当选项：2026-11-27 为了让岛上只留我们的胶囊，
/// 把系统卡 `setNowPlayingInfo: nil` 压掉了。结果一旦我们的 activity 起不来
/// （系统「实时活动」被关 / 扩展没嵌上 / 免费证书重装后授权重置），
/// **岛上和锁屏一起变空**——用户看到的就是「灵动岛没了 / 状态和歌对不上」。
///
/// 下面这套 request/update/end 的实现保留着（`shuyin_island_set` 仍会被
/// Rust 心跳调到），但 `wanted` 恒为 false，全部路径都是空转；留着是为了
/// 万一以后要恢复，逻辑与注释都还在。
///
/// ## 符号存活（同 ShuyinLyricsPiP 的坑）
///
/// 本类在 Swift 侧没有静态引用链，Release `-dead_strip` 会把整个 object
/// （含 @_cdecl 符号）剥掉。Rust 启动时 dlsym 调一次 `shuyin_island_adopt`
/// 点亮整个 object；Darwin 观察者也在这里挂（顺便解决 run loop 归属）。
@available(iOS 16.2, *)
final class ShuyinIsland {

    static let shared = ShuyinIsland()
    private init() {}

    /// 扩展 post 的三条命令名。**与 IslandWidget.swift 里的字符串逐字一致**。
    private static let cmdPlayPause = "cn.shuyin.island.cmd.playpause"
    private static let cmdPrev = "cn.shuyin.island.cmd.prev"
    private static let cmdNext = "cn.shuyin.island.cmd.next"

    /// Rust → Swift 的远端命令入口（Darwin 通知最终落到这里）。
    private typealias RemoteFn = @convention(c) (UnsafePointer<CChar>?) -> Void

    /// 存档键。2026-11-28 起**永远写 false**：设置里已经没有这颗开关了。
    ///
    /// 换过键（旧键 `shuyin.island` 是昨天调胶囊时写过的）是为了让老用户
    /// 复位成「系统的岛」，别再被上一次的 true 拖着走。
    private static let ownKey = "shuyin.island.own"

    /// 开关真值。现在恒为 false（见 `disableOwn`），保留字段只为让上面那套
    /// request/update 逻辑原样编译。
    private(set) var wanted: Bool = UserDefaults.standard.bool(forKey: ShuyinIsland.ownKey)

    /// 当前挂着的 activity。 adopts 孤儿：上次启动没来得及 end 就被杀，
    /// 重启后第一次 set 要接管回来，不然灵动岛上永远挂着一条死掉的疏音。
    private var activity: Activity<IslandAttributes>?

    /* 最近一帧内容（节流与 ContentState 构建都用它） */
    private var title = ""
    private var artist = ""
    private var pos: Double = 0
    private var playing = false
    private var dur: Double = 0
    /// 专辑封面（已压成 ≤256px JPEG）。换歌时由 Rust 传一次原图字节，压好存这里。
    private var art: Data?

    /// 上次真 update 的内容指纹，一样就不推（省系统配额）。
    private var lastKey = "\u{0}"
    /// 上次推送时的位置：播放中但 |Δpos|>4s = 用户拖了进度条，必须真推。
    private var lastPos: Double = 0
    /// 上次 update 的墙钟。播放中每 KEEPALIVE_SECS 强推一帧：Live Activity 的
    /// 「岛上常驻权」靠持续活跃撑着——酷狗逐句推歌词就是这个效果。推得少，
    /// 系统就把岛轮换给系统「正在播放」卡，用户看到两个胶囊来回切（2026-11-27）。
    private var lastPushAt: TimeInterval = 0
    /// 强推周期。5s 一次 = 720 次/小时，ProgressView(timerInterval:) 的起点
    /// 重算即进度纠偏，不会跳条；配额实测量级可承受（酷狗更密）。
    private static let keepaliveSecs: TimeInterval = 5

    /// 暂停后的撤场任务（恢复播放要 cancel）。
    private var endWork: DispatchWorkItem?

    /** 暂停多久后把 activity 收掉（酷狗同款：暂停一会儿灵动岛就消失）。 */
    private static let pauseGraceSecs: TimeInterval = 8

    // MARK: - 对外（C 入口调这些）

    func set(title: String, artist: String, pos: Double, playing: Bool, dur: Double, art: Data?) {
        DispatchQueue.main.async {
            self.performSet(
                title: title, artist: artist,
                pos: pos, playing: playing, dur: dur,
                art: art,
            )
        }
    }

    /// 返回开/关之后的真值（对齐画中画的 toggle）。
    func toggle() -> Bool {
        if Thread.isMainThread {
            return performToggle()
        }
        var out = false
        DispatchQueue.main.sync { out = self.performToggle() }
        return out
    }

    /// 此刻岛上真的挂着我们的 activity 没有。
    ///
    /// 给 Rust 决定「能不能压掉系统『正在播放』卡」用：activity 没挂上还压卡，
    /// 就是岛上、锁屏一起变空（2026-11-27 装上车后「灵动岛没了」的那次）。
    /// 暂停超过宽限期 activity 会被收掉，这里也会如实返回 false，
    /// 系统卡于是重新出现——宁可两颗都少，也不要一颗都没有。
    var running: Bool {
        if Thread.isMainThread { return activity != nil }
        var out = false
        DispatchQueue.main.sync { out = self.activity != nil }
        return out
    }

    // MARK: - 内部

    private func performSet(title: String, artist: String, pos: Double, playing: Bool, dur: Double, art: Data?) {
        self.title = title.isEmpty ? "疏音" : title
        self.artist = artist
        self.pos = max(0, pos)
        self.playing = playing
        if dur > 0 { self.dur = dur }
        /* 空字节 = 沿用上一张；新封面先压小（ContentState 塞大图吃 update 配额） */
        if let d = art, !d.isEmpty, let img = UIImage(data: d) {
            self.art = Self.shrunkJpeg(img)
        }

        if playing {
            cancelEnd()
            startIfNeeded()
            pushIfNeeded()
        } else {
            /* 暂停：先推一帧（▶ 图标），8s 没恢复就把 activity 收掉 */
            startIfNeeded()
            pushIfNeeded()
            scheduleEnd()
        }
    }

    /// 封面压到 ≤256px JPEG（~30KB）。锁屏卡上画得出来就够了。
    private static func shrunkJpeg(_ img: UIImage) -> Data? {
        let side: CGFloat = 256
        let w = img.size.width, h = img.size.height
        guard w > 0, h > 0 else { return img.jpegData(compressionQuality: 0.7) }
        let scale = min(side / w, side / h, 1)
        let size = CGSize(width: w * scale, height: h * scale)
        let renderer = UIGraphicsImageRenderer(size: size)
        let small = renderer.image { _ in img.draw(in: CGRect(origin: .zero, size: size)) }
        return small.jpegData(compressionQuality: 0.7)
    }

    /// 收掉历史遗留的自绘胶囊（启动时调一次）。
    ///
    /// 老版本把开关调成过 true，`Activity` 可能还挂在灵动岛上。设置里的开关
    /// 已经删了，没人会去关它——不在这里收，用户就会一直看到一颗「疏音的胶囊」
    /// 和系统卡打架（而且它的播放态来自另一条心跳，容易出现「状态和歌对不上」）。
    func disableOwn() {
        let was = wanted
        wanted = false
        UserDefaults.standard.set(false, forKey: ShuyinIsland.ownKey)
        /* 旧键也顺手清掉，免得以后有人又去读它 */
        UserDefaults.standard.removeObject(forKey: "shuyin.island")
        if was || !Activity<IslandAttributes>.activities.isEmpty {
            endActivity(reason: "own island removed")
        }
    }

    private func performToggle() -> Bool {
        /*
         * 设置里这颗开关已经删了（2026-11-28）。万一还有老前端调进来，
         * 一律当「关」处理：宁可什么都不做，也不能又打开一套自绘胶囊
         * 把系统卡压掉。
         */
        disableOwn()
        NSLog("[shuyin] island toggle ignored (own island removed)")
        return false
    }

    private func startIfNeeded() {
        guard wanted else { return }
        if activity != nil { return }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            NSLog("[shuyin] island disabled (system setting)")
            return
        }
        /* 先接管孤儿：上次没 end 掉的 activity 还挂在灵动岛上 */
        if activity == nil, let orphan = Activity<IslandAttributes>.activities.first {
            activity = orphan
            NSLog("[shuyin] island adopted orphan activity")
            return
        }
        let attrs = IslandAttributes(theme: "#FFC94D")
        /*
         * 用 16.1 的 `contentState:` 版 request（同步、不抛、永不移除，17 起只是
         * 弃用警告）：iOS 17 的 `content:` 版签名有变动，跨 SDK 编译求稳取旧 API。
         */
        /*
         * 新 SDK 里 request 是 throws 的（旧 contentState: 版也被标了 throws），
         * 用 try? 兜成 nil；request 失败多半是系统限制，NSLog 留痕。
         */
        guard let act = try? Activity<IslandAttributes>.request(
            attributes: attrs,
            contentState: contentState(),
            pushType: nil,
        ) else {
            NSLog("[shuyin] island request FAILED")
            return
        }
        activity = act
        NSLog("[shuyin] island requested: %@", act.id)
    }

    private func contentState() -> IslandAttributes.ContentState {
        IslandAttributes.ContentState(
            title: title.isEmpty ? "疏音" : title,
            artist: artist,
            playing: playing,
            pos: max(0, pos),
            dur: dur,
            art: art,
        )
    }

    /// 节流推一帧。指纹：歌名|歌手|播放态|时长|封面|（暂停时的位置 / 播放中的 seek 检测）。
    /// 播放中另有 keepalive 强推：内容没变也推，撑住「岛上常驻权」（见 lastPushAt）。
    private func pushIfNeeded() {
        guard let act = activity, wanted else { return }
        let now = Date().timeIntervalSince1970
        let keepalive = playing && now - lastPushAt >= ShuyinIsland.keepaliveSecs
        let seeked = playing && abs(pos - lastPos) > 4
        let key = "\(title)|\(artist)|\(playing ? 1 : 0)|\(Int(dur))|\(art?.count ?? 0)|"
            + (playing ? (seeked ? "seek\(Int(pos))" : "playing") : "paused@\(Int(pos))")
        guard key != lastKey || keepalive else { return }
        lastKey = key
        lastPos = pos
        lastPushAt = now
        let state = contentState()
        Task { @MainActor in
            try? await act.update(using: state)
            NSLog("[shuyin] island update (%@)", key)
        }
    }

    private func scheduleEnd() {
        cancelEnd()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            if !self.playing {
                self.endActivity(reason: "pause grace elapsed")
            }
        }
        endWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + ShuyinIsland.pauseGraceSecs, execute: work)
    }

    private func cancelEnd() {
        endWork?.cancel()
        endWork = nil
    }

    private func endActivity(reason: String) {
        cancelEnd()
        activity = nil
        lastKey = "\u{0}"
        let acts = Activity<IslandAttributes>.activities
        guard !acts.isEmpty else {
            NSLog("[shuyin] island end skip (none) %@", reason)
            return
        }
        Task { @MainActor in
            for a in acts {
                try? await a.end(
                    ActivityContent(state: contentState(), staleDate: nil),
                    dismissalPolicy: .immediate,
                )
            }
            NSLog("[shuyin] island ended \(acts.count) \(reason)")
        }
    }

    // MARK: - Darwin 通知（扩展 → 主 App）

    /// 在主 run loop 上挂观察者（Darwin 通知投递到注册它的那个 run loop，
    /// 主线程才保证活着）。回调是 C 函数指针，不能捕获上下文——按通知名分发。
    private var observing = false

    func registerObserverIfPossible() {
        guard !observing else { return }
        observing = true
        let center = CFNotificationCenterGetDarwinNotifyCenter()
        let names: [CFString] = [
            ShuyinIsland.cmdPlayPause as CFString,
            ShuyinIsland.cmdPrev as CFString,
            ShuyinIsland.cmdNext as CFString,
        ]
        let cb: CFNotificationCallback = { _, _, name, _, _ in
            guard let name else { return }
            /* 回调拿到的是 CFNotificationName 结构体，rawValue 才是 CFString */
            let raw = name.rawValue as String
            guard raw.hasPrefix("cn.shuyin.island.cmd.") else { return }
            let cmd = String(raw.dropFirst("cn.shuyin.island.cmd.".count))
            ShuyinIsland.forward(cmd: cmd)
        }
        for n in names {
            CFNotificationCenterAddObserver(center, nil, cb, n, nil, .deliverImmediately)
        }
        NSLog("[shuyin] island observers registered \(names.count)")
    }

    /// 转发给 Rust（与画中画同一入口：playpause 直接切，prev/next 发事件给前端）。
    private static func forward(cmd: String) {
        NSLog("[shuyin] island cmd %@", cmd)
        guard let h = dlopen(nil, RTLD_NOW),
              let sym = dlsym(h, "shuyin_remote_command") else {
            NSLog("[shuyin] island cmd dlsym NULL")
            return
        }
        let fn = unsafeBitCast(sym, to: RemoteFn.self)
        cmd.withCString { fn($0) }
    }
}

/* ------------------------------------------------------------------ */
/* 给 Rust 调的 C 入口                                                  */
/* ------------------------------------------------------------------ */

/// 符号锚点 + 观察者注册。Rust 启动时 dlsym 调一次（防 -dead_strip，见文件头）。
@_cdecl("shuyin_island_adopt")
public func shuyinIslandAdopt() {
    NSLog("[shuyin] island adopt (symbol alive)")
    /*
     * #available 必须写在异步闭包**里面**：闭包本身不继承外层的可用性，
     * 在外面 guard 了再进闭包，编译器照样报「ShuyinIsland 只在 iOS 16.2+ 可用」。
     */
    DispatchQueue.main.async {
        guard #available(iOS 16.2, *) else {
            NSLog("[shuyin] island unsupported (<16.2)")
            return
        }
        _ = ShuyinIsland.shared
        ShuyinIsland.shared.registerObserverIfPossible()
        /* 老版本留下的自绘胶囊：启动就收掉，让系统「正在播放」接管灵动岛 */
        ShuyinIsland.shared.disableOwn()
    }
}

@_cdecl("shuyin_island_set")
public func shuyinIslandSet(
    _ title: UnsafePointer<CChar>?,
    _ artist: UnsafePointer<CChar>?,
    _ pos: Double,
    _ playing: Bool,
    _ dur: Double,
    _ artPtr: UnsafePointer<UInt8>?,
    _ artLen: Int,
) {
    guard #available(iOS 16.2, *) else { return }
    let art: Data? = {
        guard let p = artPtr, artLen > 0 else { return nil }
        return Data(bytes: p, count: artLen)
    }()
    ShuyinIsland.shared.set(
        title: title.map { String(cString: $0) } ?? "",
        artist: artist.map { String(cString: $0) } ?? "",
        pos: pos, playing: playing, dur: dur,
        art: art,
    )
}

@_cdecl("shuyin_island_toggle")
public func shuyinIslandToggle() -> Bool {
    guard #available(iOS 16.2, *) else { return false }
    let r = ShuyinIsland.shared.toggle()
    NSLog("[shuyin] island C toggle -> %@", r ? "true" : "false")
    return r
}

@_cdecl("shuyin_island_on")
public func shuyinIslandOn() -> Bool {
    guard #available(iOS 16.2, *) else { return false }
    if Thread.isMainThread { return ShuyinIsland.shared.wanted }
    var out = false
    DispatchQueue.main.sync { out = ShuyinIsland.shared.wanted }
    return out
}

/// 岛上此刻真的挂着我们的 activity 没有（开关开 ≠ 挂上了）。
/// Rust 侧用它决定要不要压系统「正在播放」卡——没挂上还压就是全空。
@_cdecl("shuyin_island_running")
public func shuyinIslandRunning() -> Bool {
    guard #available(iOS 16.2, *) else { return false }
    return ShuyinIsland.shared.running
}

/// 系统有没有允许实时活动（设置 → 疏音 → 实时活动）。
/// 关了的话 Activity.request 起不来，灵动岛永远不出现——设置页把这个状态
/// 透出去，别让用户对着系统「正在播放」卡以为是我们的灵动岛坏了。
@_cdecl("shuyin_island_enabled")
public func shuyinIslandEnabled() -> Bool {
    guard #available(iOS 16.2, *) else { return false }
    if Thread.isMainThread { return ActivityAuthorizationInfo().areActivitiesEnabled }
    var out = false
    DispatchQueue.main.sync { out = ActivityAuthorizationInfo().areActivitiesEnabled }
    return out
}
