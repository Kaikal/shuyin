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

/// 播放 / 暂停。
@available(iOS 17.0, *)
struct ShuyinPlayPauseIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "播放/暂停"
    /// 不上「快捷指令」列表：这是纯 UI 内部动作，没有参数，暴露出去没意义
    static var isDiscoverable: Bool = false
    /// 绝不能把 App 拉到前台——点一下岛就跳出一整个播放页是很讨厌的
    static var openAppWhenRun: Bool = false

    func perform() async throws -> some IntentResult {
        shuyinForward("playpause")
        return .result()
    }
}

/// 上一首。
@available(iOS 17.0, *)
struct ShuyinPrevIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "上一首"
    static var isDiscoverable: Bool = false
    static var openAppWhenRun: Bool = false

    func perform() async throws -> some IntentResult {
        shuyinForward("prev")
        return .result()
    }
}

/// 下一首。
@available(iOS 17.0, *)
struct ShuyinNextIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "下一首"
    static var isDiscoverable: Bool = false
    static var openAppWhenRun: Bool = false

    func perform() async throws -> some IntentResult {
        shuyinForward("next")
        return .result()
    }
}
