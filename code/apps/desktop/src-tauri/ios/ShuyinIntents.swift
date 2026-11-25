import AppIntents
import Darwin
import Foundation

/// 把灵动岛上的按钮点击转发给主 App 里的 Rust。
///
/// 为什么不直接声明 `@_silgen_name("shuyin_remote_command")`：
/// 这份文件同时编进主 App 和 Widget 扩展两个 target（AppIntents 要求「双
/// target 成员」，否则按钮在 App 存活时点了不响应）。而扩展进程里压根没有
/// Rust 导出的那个符号，直接引用会在链接 .appex 时炸 undefined symbol。
/// 改成运行时 `dlsym` 查找，扩展里查不到就安静返回。
///
/// 查不到也没关系：按 Apple 的调度规则（Adding interactivity to widgets and
/// Live Activities），`perform()` 因为 `LiveActivityIntent` 的语义是在**主 App
/// 进程**里跑的，那边一定有符号。
private func shuyinForward(_ cmd: String) {
    // RTLD_DEFAULT == (void *) -2，Swift 里没有现成常量
    guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "shuyin_remote_command") else {
        return
    }
    typealias Fn = @convention(c) (UnsafePointer<CChar>) -> Void
    let fn = unsafeBitCast(sym, to: Fn.self)
    cmd.withCString { fn($0) }
}

/*
 * ⚠️ 下面五个 intent **必须是 `public struct`，成员也必须是 `public`**。
 *
 * 这不是洁癖，是功能前提：iOS 记下按钮里的 intent 时用的是「模块名 + 类型名」
 * 的 mangled name，点击时要在主 App 进程里按名字把类型找回来。
 * **Release 构建**（`-O` + wholemodule，CI 出的就是这个）会把 `internal`
 * 类型的元数据当死代码摘掉，系统于是报
 *   Could not find an intent with identifier ShuyinFavIntent,
 *   mangledTypeName: Optional("13ShuyinWidget17ShuyinFavIntentV")
 * 然后**静默什么都不做**——按钮看着能按，按下去没反应，也不报错。
 * Debug 构建反而正常，所以这个坑在本地试不出来。
 *
 * 社区里两条独立确认（Apple 开发者论坛 746696 / 731852）：
 * 「intent struct must be marked public, else in release mode system cannot
 *   find your intent」。
 *
 * 2026-11-23 用户实测：收藏按钮按下去那颗星不动、点岛上的封面也打不开 App，
 * 就是这个原因（`perform()` 从来没被调过）。
 *
 * 改这些结构体时：加字段要 `public`，`init()` 要 `public`，
 * `title` / `isDiscoverable` / `openAppWhenRun` 也都要 `public`——
 * 公开类型的协议见证必须是公开的，少一个都编译不过（或者又变回静默失联）。
 */

/// 播放 / 暂停。
@available(iOS 17.0, *)
public struct ShuyinPlayPauseIntent: LiveActivityIntent {
    public static var title: LocalizedStringResource = "播放/暂停"
    /// 不上「快捷指令」列表：这是纯 UI 内部动作，没有参数，暴露出去没意义
    public static var isDiscoverable: Bool = false
    /// 绝不能把 App 拉到前台——点一下岛就跳出一整个播放页是很讨厌的
    public static var openAppWhenRun: Bool = false

    public init() {}

    public func perform() async throws -> some IntentResult {
        shuyinForward("playpause")
        return .result()
    }
}

/// 上一首。
@available(iOS 17.0, *)
public struct ShuyinPrevIntent: LiveActivityIntent {
    public static var title: LocalizedStringResource = "上一首"
    public static var isDiscoverable: Bool = false
    public static var openAppWhenRun: Bool = false

    public init() {}

    public func perform() async throws -> some IntentResult {
        shuyinForward("prev")
        return .result()
    }
}

/// 下一首。
@available(iOS 17.0, *)
public struct ShuyinNextIntent: LiveActivityIntent {
    public static var title: LocalizedStringResource = "下一首"
    public static var isDiscoverable: Bool = false
    public static var openAppWhenRun: Bool = false

    public init() {}

    public func perform() async throws -> some IntentResult {
        shuyinForward("next")
        return .result()
    }
}

/// 收藏 / 取消收藏。
///
/// 收藏列表只有前端有一份，所以这里只转发，由前端 `toggleFav` 落地；
/// 落地后它会带着新的 `fav` 再推一次 ContentState，那颗星才会变实心。
/// 前两步（Rust 记真值 + 重推）不依赖前端——JS 冻在后台时那颗星也会先翻过来。
@available(iOS 17.0, *)
public struct ShuyinFavIntent: LiveActivityIntent {
    public static var title: LocalizedStringResource = "收藏"
    public static var isDiscoverable: Bool = false
    public static var openAppWhenRun: Bool = false

    public init() {}

    public func perform() async throws -> some IntentResult {
        shuyinForward("fav")
        return .result()
    }
}

/*
 * 「点灵动岛回 App」**没有**对应的 intent，这是刻意的：
 *
 * Apple DTS（开发者论坛 thread/812949）明确说 LiveActivityIntent 只能后台
 * 执行，「It is not possible to open an app using a LiveActivity」——
 * `openAppWhenRun = true` 也不生效。而 `Button(intent:)` 会吞掉点击，于是
 * 用户看到的就是「点了完全没反应」（2026-11-25 实测）。
 *
 * 回 App 走 `Link(destination: shuyin://live)`（展开态）与
 * `DynamicIsland.widgetURL`（紧凑/最小态），见 widget 里的 `OpenTap`。
 */

/// 点封面：锁屏卡在「大封面」和「普通卡」之间切换。
///
/// 真值在 Rust 侧（`liveactivity::BIG_ART`），这里只发个信号——
/// 切换本身在那边重推一次 ContentState 完成，不依赖前端 JS 醒着。
/// 只给**锁屏卡**用。灵动岛里没有「大封面」这回事（那个形态是锁屏专属），
/// 岛上点封面 = 打开 App（见 widget 里的 `ArtLink`）。
@available(iOS 17.0, *)
public struct ShuyinToggleArtIntent: LiveActivityIntent {
    public static var title: LocalizedStringResource = "切换封面"
    public static var isDiscoverable: Bool = false
    public static var openAppWhenRun: Bool = false

    public init() {}

    public func perform() async throws -> some IntentResult {
        shuyinForward("art")
        return .result()
    }
}
