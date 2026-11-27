import ActivityKit
import Darwin
import Foundation

/// iOS「灵动岛」：ActivityKit Live Activity 的主 App 侧管理器。
///
/// ## 形态（用户 2026-11-27 按酷狗定稿，iPhone 是主目标）
///
/// 系统灵动岛长在摄像头挖孔周围，Live Activity 的 compact 视图画在挖孔两侧：
///   · **点一下胶囊 = 打开疏音**——这是 Live Activity 的系统默认行为，
///     不写一行代码（整块胶囊本来就是可点的）；
///   · **长按 = 系统自动展开**——展开态由 Widget 扩展渲染
///     （`ios/IslandWidget.swift`：歌名 + 播控）。
///
/// ## 生命周期
///
///     Rust 心跳（ios_media::spawn_island_ticker，500ms）
///       → shuyin_island_set(title, artist, pos, playing, dur)（本文件）
///         → 播放中：起 activity（懒起）+ 节流 update
///         → 暂停 8s：end 掉 activity；恢复播放重新 request
///
/// update 有系统配额（活跃 activity 每小时有上限），所以**不做逐帧推**：
/// 进度条用 `ProgressView(timerInterval:)` 让系统按墙钟自走，只在
/// 换歌 / 暂停恢复 / 拖进度（|Δpos|>4s）/ 时长变化时才真 update。
///
/// ## 展开态播控怎么回来
///
/// 扩展进程里的 `Button(intent:)` 够不到主 App 二进制（dlsym 是进程内的），
/// 走 Darwin 通知跨进程转发：扩展 post `cn.shuyin.island.cmd.*`，
/// 本文件的观察者收到后 dlsym 调 Rust 的 `shuyin_remote_command`
/// ——后台播歌时主 App 活着（audio 后台模式），这条路通。
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

    /// 开关真值（持久化；对齐画中画的 `shuyin.pip.lyrics`）。
    private(set) var wanted: Bool = UserDefaults.standard.bool(forKey: "shuyin.island")

    /// 当前挂着的 activity。 adopts 孤儿：上次启动没来得及 end 就被杀，
    /// 重启后第一次 set 要接管回来，不然灵动岛上永远挂着一条死掉的疏音。
    private var activity: Activity<IslandAttributes>?

    /* 最近一帧内容（节流与 ContentState 构建都用它） */
    private var title = ""
    private var artist = ""
    private var pos: Double = 0
    private var playing = false
    private var dur: Double = 0

    /// 上次真 update 的内容指纹，一样就不推（省系统配额）。
    private var lastKey = "\u{0}"
    /// 上次推送时的位置：播放中但 |Δpos|>4s = 用户拖了进度条，必须真推。
    private var lastPos: Double = 0

    /// 暂停后的撤场任务（恢复播放要 cancel）。
    private var endWork: DispatchWorkItem?

    /** 暂停多久后把 activity 收掉（酷狗同款：暂停一会儿灵动岛就消失）。 */
    private static let pauseGraceSecs: TimeInterval = 8

    // MARK: - 对外（C 入口调这些）

    func set(title: String, artist: String, pos: Double, playing: Bool, dur: Double) {
        DispatchQueue.main.async {
            self.performSet(
                title: title, artist: artist,
                pos: pos, playing: playing, dur: dur,
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

    // MARK: - 内部

    private func performSet(title: String, artist: String, pos: Double, playing: Bool, dur: Double) {
        self.title = title.isEmpty ? "疏音" : title
        self.artist = artist
        self.pos = max(0, pos)
        self.playing = playing
        if dur > 0 { self.dur = dur }

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

    private func performToggle() -> Bool {
        wanted.toggle()
        UserDefaults.standard.set(wanted, forKey: "shuyin.island")
        if wanted {
            /* 有歌在放 / 刚暂停（宽限期内）就直接起；没歌等心跳带着数据来再起 */
            if playing || dur > 0 {
                startIfNeeded()
                pushIfNeeded()
            }
            NSLog("[shuyin] island on")
        } else {
            endActivity(reason: "toggle off")
            NSLog("[shuyin] island off")
        }
        return wanted
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
        let act = Activity<IslandAttributes>.request(
            attributes: attrs,
            contentState: contentState(),
            pushType: nil,
        )
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
        )
    }

    /// 节流推一帧。指纹：歌名|歌手|播放态|时长|（暂停时的位置 / 播放中的 seek 检测）。
    private func pushIfNeeded() {
        guard let act = activity, wanted else { return }
        let seeked = playing && abs(pos - lastPos) > 4
        let key = "\(title)|\(artist)|\(playing ? 1 : 0)|\(Int(dur))|"
            + (playing ? (seeked ? "seek\(Int(pos))" : "playing") : "paused@\(Int(pos))")
        guard key != lastKey else { return }
        lastKey = key
        lastPos = pos
        let state = contentState()
        Task { @MainActor in
            try? await act.update(state)
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
                try? await a.end(contentState(), dismissalPolicy: .immediate)
            }
            NSLog("[shuyin] island ended (%d) %@", acts.count, reason)
        }
    }

    // MARK: - Darwin 通知（扩展 → 主 App）

    /// 在主 run loop 上挂观察者（Darwin 通知投递到注册它的那个 run loop，
    /// 主线程才保证活着）。回调是 C 函数指针，不能捕获上下文——按通知名分发。
    private var observing = false

    func registerObserverIfPossible() {
        guard !observing else { return }
        observing = true
        let center = CFNotificationCenterGetDarwinNotificationCenter()
        let names: [CFString] = [
            ShuyinIsland.cmdPlayPause as CFString,
            ShuyinIsland.cmdPrev as CFString,
            ShuyinIsland.cmdNext as CFString,
        ]
        let cb: CFNotificationCallback = { _, _, name, _, _ in
            guard let name else { return }
            let raw = name.pointee.rawValue as String
            guard raw.hasPrefix("cn.shuyin.island.cmd.") else { return }
            let cmd = String(raw.dropFirst("cn.shuyin.island.cmd.".count))
            ShuyinIsland.forward(cmd: cmd)
        }
        for n in names {
            CFNotificationCenterAddObserver(center, nil, cb, n, nil, .deliverImmediately)
        }
        NSLog("[shuyin] island observers registered (%d)", names.count)
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
    }
}

@_cdecl("shuyin_island_set")
public func shuyinIslandSet(
    _ title: UnsafePointer<CChar>?,
    _ artist: UnsafePointer<CChar>?,
    _ pos: Double,
    _ playing: Bool,
    _ dur: Double,
) {
    guard #available(iOS 16.2, *) else { return }
    ShuyinIsland.shared.set(
        title: title.map { String(cString: $0) } ?? "",
        artist: artist.map { String(cString: $0) } ?? "",
        pos: pos, playing: playing, dur: dur,
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
