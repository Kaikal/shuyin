import AVFoundation
import AVKit
import CoreGraphics
import Darwin
import UIKit
import UserNotifications

/// iOS「桌面歌词」：画中画（Picture in Picture）里跑一条自绘的字幕。
///
/// ## 为什么是画中画
///
/// iOS 沙箱**不允许**第三方 App 往别人的界面上开悬浮窗（那是安卓的
/// `SYSTEM_ALERT_WINDOW`）。系统里唯一能合法浮在主屏/其他 App 之上的通道
/// 是画中画：它本来是给视频用的，但 `AVSampleBufferDisplayLayer` 这个内容源
/// 允许 App **自己喂帧**——把歌词画成一张位图喂进去，画中画窗口里显示的就是
/// 歌词，而不是视频。酷狗那条桌面歌词走的就是这条路（窗口上那颗方框箭头
/// 是系统给的「回到 App / 全屏」按钮）。
///
/// ## 链路
///
///     Rust 的歌词心跳（每 200ms 取当前句 + 句内进度）
///       → `shuyin_pip_set(line, prog, playing)`（本文件）
///         → 渲染成 CVPixelBuffer → CMSampleBuffer → enqueue 到 layer
///           → 画中画窗口自己显示
///
/// ## 上一版「打不开」的根因（2026-11-25）
///
/// `AVPictureInPictureController` 的 `sampleBufferDisplayLayer` 内容源有个
/// 不说就会踩的前提：**那个 layer 必须真的挂在一棵视图树上**。系统靠 source
/// view 判断「这是屏幕上的内联内容，切后台时要把它变成画中画」。上一版只是
/// `let layer = AVSampleBufferDisplayLayer()` 然后往里喂帧，从没 `addSublayer`：
///   · `isPictureInPicturePossible` 永远是 false；
///   · 开关打开时没在前台 `startPictureInPicture()`；
///   · 唯一的启动尝试放在 `didEnterBackground` 里——Apple 明确说后台调会被拒
///     （`AVKitErrorDomain Code=-1001`，activation state 不是 foregroundActive）。
/// 三条路全断，用户看到的就是「开关点了没反应 / 切后台也不浮」。
///
/// 现在：开关打开就把 layer 挂到 keyWindow（一个 2% 透明的宿主 view）、
/// 前台先喂一帧再主动 start；`canStart...AutomaticallyFromInline` 与
/// `didEnterBackground` 兜底只作为「已经成功启动过一次」之后的保险。
@available(iOS 15.0, *)
final class ShuyinPiP: NSObject, AVPictureInPictureControllerDelegate,
                       AVPictureInPictureSampleBufferPlaybackDelegate {

    static let shared = ShuyinPiP()

    /// Rust → Swift 的远端命令入口（播放/暂停、回到 App 都走它）。
    /// 用 dlsym 而不是 `@_silgen_name`：符号缺了只是按钮不灵，不会链接失败。
    private typealias RemoteFn = @convention(c) (UnsafePointer<CChar>?) -> Void

    private var ctrl: AVPictureInPictureController?
    private let layer = AVSampleBufferDisplayLayer()
    private var timebase: CMTimebase?
    /// 把 layer 挂到视图树上的宿主 view（PiP 启动的硬性前提，见文件头）
    private var host: UIView?

    /// 当前要画的句子与进度（只由 `shuyin_pip_set` 改）
    private var line = ""
    private var prog: Double = 0
    private var playing = false
    /**
     * 当前曲时长（秒，0=未知）。Rust 心跳每帧都带。
     *
     * 画中画窗口上那颗键是「播放/暂停」还是「停止」，系统看的是
     * `timeRangeForPlayback` 给的时长：正无穷（直播语义）= 停止键。
     * 以前为了去掉 ±10 秒跳转键返回了正无穷，副作用就是暂停键变成了
     * 停止键（2026-11-26 用户实报）。现在传真实时长换回播放/暂停；
     * 跳转键另外用 `requiresLinearPlayback = true` 关掉了（2026-11-28）。
     */
    private var duration: Double = 0
    /// 已经画进 buffer 的那一帧的「内容指纹」，一样就不重画（省电）
    private var painted = "\u{0}"
    /// 上次真正 enqueue 的时刻：内容没变也要定期补一帧，否则系统会把
    /// 「长时间没有新 sample」当成播放结束，自己把画中画收掉。
    private var lastEnqueue = Date.distantPast
    /// 后台通知只挂一次
    private var observing = false
    /// 这次「画中画停止」是不是我们自己因为「回到 App」收的（见 didStop）
    private var stoppingForForeground = false
    /**
     * 画中画正在收尾（按 × / 回 App / 系统收起都会经过 willStop）。
     *
     * Apple 文档原话：「By default, this action **terminates playback** when
     * control returns to the app」——用户按 × 关掉画中画时，AVKit 会调一次
     * `setPlaying(false)` 把「画中画里的播放」终止掉。对 sample-buffer 内容源
     * 来说这句到达 delegate 时就变成了字面意思：我们的处理把它翻译成
     * `playpause` 发给 Rust，正在放的音乐跟着被暂停（2026-11-26 用户报的
     * 「关闭桌面歌词时，歌曲也会停止」的根因）。
     *
     * 这一旗在 willStop 立起、didStop 放下：收尾途中来的 setPlaying 一律
     * 只记账不转发。用户的播放/暂停按钮只在窗口活着时出现，二者不会撞。
     */
    private var stopping = false

    /**
     * 收尾闸的**有效期**（截止时刻）。
     *
     * 光靠 willStop→didStop 之间的 `stopping` 旗挡不住：AVKit 补发的那次
     * `setPlaying(false)` 常在 didStop **之后**才到（顺序不保证），那时旗已经放了，
     * 转发出去 = 音乐被暂停。2026-11-28 用户第三次报「关闭桌面歌词，音乐就停掉」
     * 就是这条漏网。所以改成时间窗口：我们自己要收窗时立一个 2 秒的闸，
     * 窗口内来的 setPlaying 一律只记账。
     */
    private var swallowUntil = Date.distantPast

    /// 这一次收窗是**我们自己**发起的（关开关），不是用户按了 ×。
    /// 两者都要在 didStop 收尾，但只有后者要回传 `pipclosed` 把开关拨回去。
    private var selfClosing = false

    /**
     * 用户按了画中画上的「回到 App」，系统正在把窗口放大回应用。
     *
     * 这一段要拦两件事：
     *   · `didBecomeActive` 里那条「回到 App 就收起浮窗」的兜底——系统自己已经在
     *     做收尾动画了，我们再调一次 `stopPictureInPicture()` 就是两个动画打架，
     *     用户看到的就是「黑一下、窗口又滑一下」（2026-11-28 反馈）；
     *   · `didStop` 里「用户按 ×」的那条分支——收尾原因是回 App，不是关窗，
     *     不能把开关拨回关、更不能回传 `pipclosed`。
     *
     * 3 秒兜底复位：万一某个系统版本不回调 didStop，旗不能一直立着。
     */
    private var restoring = false

    /// 等前端「播放页画好了」的回执再回调的那颗 completionHandler。
    /// 只存一次；`finishRestore` 取走并置 nil，所以超时与回执谁先到都只生效一次。
    private var pendingRestore: ((Bool) -> Void)?

    /// 立闸：`stopping` 立即生效，另给一个 `secs` 秒的时间窗口兜住迟到的 setPlaying。
    private func markStopping(_ secs: TimeInterval) {
        stopping = true
        swallowUntil = Date().addingTimeInterval(secs)
    }

    /// 开关真值（持久化：用户开过一次，下次启动仍按开的来）
    private(set) var wanted: Bool = UserDefaults.standard.bool(forKey: "shuyin.pip.lyrics")

    /// 画布尺寸（像素）。
    ///
    /// 一条 1280×180 的扁条（≈7:1），对齐酷狗桌面歌词：窗口矮、字不大、
    /// 悬浮在屏幕上只占一条缝。画中画窗口的**高度占比由内容宽高比决定**
    /// ——画布越扁，系统给的窗口越矮，「占用空间」就小；字号也跟着按宽度
    /// 比例调小（见 render 里 fontPt 的取值）。
    ///
    /// 2026-11-28 从 160 抬到 180（8:1 → 7:1）：用户要「按钮稍微大一点点，
    /// 不要大太多」。画中画那排播控是系统画的，缩放跟着窗口走——窗口高一点，
    /// 播放/暂停键就跟着大一点，但又不至于变成一条胖卡片。
    ///
    /// 但**不能写死**：画中画窗口的宽高比是系统给的（用户还能捏合缩放），
    /// 固定画布 + `resizeAspect` 会在窗口里上下留黑边，字看上去忽大忽小——
    /// 2026-11-25 用户报的「文字太大、不适配」就是这条。
    /// `didTransitionToRenderSize` 会按窗口真实比例改写 H。
    private var W = 1280
    private var H = 180

    // MARK: - 对外（C 入口调这些）

    func set(line: String, prog: Double, playing: Bool, duration: Double) {
        DispatchQueue.main.async {
            self.line = line
            self.prog = max(0, min(1, prog))
            self.playing = playing
            if duration > 0 { self.duration = duration }
            /*
             * 句内进度按 1% 量化。
             *
             * 上一版是 2%（640px 宽时约 13px 一跳），配上 200ms 心跳，长句
             * 跑马灯看起来是一顿一顿的。现在画布 1280 宽 + 1% + 120ms 心跳，
             * 滚动时约 8~10 帧/秒，读起来连续。内容没变的那一次仍然走
             * `paint()` 内部的 0.9s 节流补帧保活，不会多耗电。
             */
            let q = Int(self.prog * 100)
            let key = "\(line)|\(q)|\(playing ? 1 : 0)"
            let changed = key != self.painted
            if changed { self.painted = key }
            self.paint(force: changed)
        }
    }

    /// 返回开/关之后的真值。
    func toggle() -> Bool {
        if Thread.isMainThread {
            return performToggle()
        }
        var out = wanted
        DispatchQueue.main.sync { out = self.performToggle() }
        return out
    }

    private func performToggle() -> Bool {
        wanted.toggle()
        UserDefaults.standard.set(wanted, forKey: "shuyin.pip.lyrics")
        if wanted {
            stopping = false
            swallowUntil = .distantPast
            selfClosing = false
            guard attachLayer() else {
                /*
                 * 拿不到前台 keyWindow（App 还没完成启动）：这一下没法起 PiP。
                 * 开关状态留着，等 didBecomeActiveNotification 再补一次。
                 */
                NSLog("[shuyin] pip on: no foreground window, retry on active")
                return wanted
            }
            setupIfNeeded()
            /* 前台先渲染一帧——layer 空的时候系统不让它浮起来 */
            paint(force: true)
            /*
             * **不在这里 start**。
             *
             * 用户 2026-11-25 的要求是「回到本应用就不显示」：前台一按开关就弹一个
             * 浮窗盖在播放页上，正是他不想要的。这里只把「内联内容」备好
             * （layer 挂在窗口里、帧在往里喂），App 一进后台由系统按
             * `canStartPictureInPictureAutomaticallyFromInline` 自己浮起来；
             * `didEnterBackground` 里再补一次尝试兜底。
             */
            NSLog("[shuyin] pip armed (will show on background)")
        } else {
            /*
             * 关开关 = 我们自己要收窗。**先立闸**再收：AVKit 收尾时会按
             * Apple 文档那句「stop PiP terminates playback」调一次
             * setPlaying(false)，转发出去就是把正在放的音乐暂停掉
             * （2026-11-26 / 2026-11-28 两次实报的根因）。
             *
             * 控制器**不能当场置 nil**：置了就收不到 willStop/didStop，
             * 闸立不起来、宿主 view 也清不掉。留给 didStop 收尾（selfClosing）。
             */
            markStopping(2)
            if ctrl?.isPictureInPictureActive == true {
                selfClosing = true
                ctrl?.stopPictureInPicture()
                NSLog("[shuyin] pip stop (toggle off)")
            } else {
                teardown()
                /* 没在浮窗上就没有收尾回调，闸自己放掉，别让它一直吞 setPlaying */
                stopping = false
                swallowUntil = .distantPast
            }
            painted = "\u{0}"
            lastEnqueue = .distantPast
        }
        NSLog("[shuyin] pip toggle -> %@", wanted ? "on" : "off")
        return wanted
    }

    /// 拆掉控制器与宿主 view（关开关、按 × 之后共用；「回 App」那条要留着，见 didStop）。
    private func teardown() {
        ctrl = nil
        host?.removeFromSuperview()
        host = nil
    }

    // MARK: - 建窗口

    /// 把 display layer 挂到当前前台 window。
    ///
    /// 宿主 view 做成 2% 透明而不是 `isHidden`/`alpha=0`：系统判断「是否有
    /// 内联内容」时会把完全不可见的 view 当作没有，PiP 照样起不来。
    /// 尺寸用 point（不是 640×190 像素），只需要给系统一个动画起点。
    private func attachLayer() -> Bool {
        if host != nil { return true }
        guard let scene = UIApplication.shared.connectedScenes
                .compactMap({ $0 as? UIWindowScene })
                .first(where: { $0.activationState == .foregroundActive }),
              let win = scene.windows.first(where: { $0.isKeyWindow }) else {
            return false
        }
        let v = UIView(frame: CGRect(x: 0, y: 0, width: 48, height: 14))
        v.backgroundColor = .clear
        v.alpha = 0.02
        v.isUserInteractionEnabled = false
        win.addSubview(v)
        v.layer.addSublayer(layer)
        host = v
        return true
    }

    private func setupIfNeeded() {
        guard AVPictureInPictureController.isPictureInPictureSupported() else {
            NSLog("[shuyin] pip not supported on this device")
            return
        }
        if ctrl != nil { return }

        layer.frame = CGRect(x: 0, y: 0, width: W, height: H)
        layer.videoGravity = .resizeAspect
        /*
         * timebase 必须给：没有它画中画窗口是纯黑（不报错）。
         * 用宿主时钟当源、速率 1.0，时间轴自己往前走。
         */
        if timebase == nil {
            var tb: CMTimebase?
            /*
             * CoreMedia 这几个 C 函数在 Swift 里是**有参数标签**的
             * （allocator: / sourceClock: / timebaseOut: ...）。上一版按「没有
             * CF_SWIFT_NAME 就无标签」推断，CI 直接报 missing argument labels。
             * 同批的 CMTimebaseSetTime / SetRate 第一个参数才是无标签的。
             */
            _ = CMTimebaseCreateWithSourceClock(
                allocator: kCFAllocatorDefault,
                sourceClock: CMClockGetHostTimeClock(),
                timebaseOut: &tb,
            )
            if let tb {
                timebase = tb
                layer.controlTimebase = tb
                _ = CMTimebaseSetTime(tb, time: .zero)
                _ = CMTimebaseSetRate(tb, rate: 1.0)
            }
        }

        /*
         * playbackDelegate 必须传：iOS 26 SDK 里 `ContentSource` 只提供
         * `init(sampleBufferDisplayLayer:playbackDelegate:)` 这一个初始化器，
         * 不带 delegate 的重载根本不存在（2026-11-26 构建失败：
         * "missing argument for parameter 'playbackDelegate'"）。
         *
         * 所以「靠不传 delegate 去掉播放控件」这条路在 iOS 26 上走不通。控件
         * 的收敛改由下面两条做：`requiresLinearPlayback = true` 去掉 ±10 秒
         * 跳转键，`timeRangeForPlayback` 给有限时长把播放/暂停键画出来。
         */
        let source = AVPictureInPictureController.ContentSource(
            sampleBufferDisplayLayer: layer,
            playbackDelegate: self,
        )
        let c = AVPictureInPictureController(contentSource: source)
        c.delegate = self
        /*
         * **只要播放/暂停一颗键，不要 ±10 秒那两颗跳转键**（用户 2026-11-28）。
         *
         * 系统画不画跳转键看的是「内容能不能跳」：`requiresLinearPlayback = true`
         * 把这条内容声明成线性播放，系统就不给跳转键（也不给拖动），剩下的
         * 播放/暂停键要靠 `timeRangeForPlayback` 给**有限时长**才画得出来。
         *
         * 上一版走的是「时长返回正无穷（直播语义）→ 没有跳转键」，副作用是
         * 暂停键变成了停止键（2026-11-26 实报）。两条约束的正确组合就是
         * 「有限时长 + requiresLinearPlayback」。
         */
        c.requiresLinearPlayback = true
        /*
         * 已经成功启动过一次之后，切后台让系统自动浮起来。
         * 它要求 App 声明 audio 后台模式（Info.plist 已配）且此刻在出声。
         */
        c.canStartPictureInPictureAutomaticallyFromInline = true
        ctrl = c

        if !observing {
            observing = true
            NotificationCenter.default.addObserver(
                forName: UIApplication.didEnterBackgroundNotification,
                object: nil, queue: .main,
            ) { [weak self] _ in
                guard let self, self.wanted else { return }
                /* 后台不能再 start；只在已经起来过时由系统接管 */
                self.startIfPossible(reason: "background")
            }
            /*
             * 回到 App：把浮窗收掉（用户要的是「在应用里别挡着」）。
             * 控制器和宿主 view 都留着，下次切后台系统会自己再浮起来。
             * `attachLayer()` 失败过（开关点得太早，窗口还没建好）才在这里补建。
             */
            NotificationCenter.default.addObserver(
                forName: UIApplication.didBecomeActiveNotification,
                object: nil, queue: .main,
            ) { [weak self] _ in
                guard let self, self.wanted else { return }
                /*
                 * **晚 250ms 再决定收不收窗。**
                 *
                 * 这里是「回到 App 就把浮窗收掉」的兜底。但点画中画上的
                 * 「回到 App」时，系统的 `didBecomeActive` 往往**先于**
                 * `restoreUserInterfaceForPictureInPictureStop` 到达——
                 * 那一刻 `restoring` 还是 false，于是我们抢先
                 * `stopPictureInPicture()`，系统随后开始的放大动画就撞上了
                 * 我们自己发起的收窗：用户看到的还是「黑一下、页面再滑上来」。
                 * （2026-11-28 第三次反馈。上一版只加了 `restoring` 判断，
                 * 败在时序上。）
                 *
                 * 让这一拍先过去：restore 回调会在这段时间里把 `restoring`
                 * 立起来，我们就不再插手；真要是普通切回 App（PiP 还在飘、
                 * 没人点放大），250ms 后再收也完全感知不到。
                 */
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
                    guard let self, self.wanted else { return }
                    if self.ctrl?.isPictureInPictureActive == true {
                        /*
                         * 正在「回 App」的系统收尾（restore）就别再插一脚：
                         * 系统已经在把窗口放大回去了，我们再 stopPictureInPicture()
                         * 会变成两个动画抢同一个窗口——黑屏 + 多滑一下就是这么来的。
                         */
                        if self.restoring {
                            NSLog("[shuyin] pip active-stop skipped (restoring)")
                            return
                        }
                        self.stoppingForForeground = true
                        self.ctrl?.stopPictureInPicture()
                        NSLog("[shuyin] pip stop (back to app)")
                        return
                    }
                    /* 开关点得太早（窗口还没建好）时在这里补建内联内容 */
                    if self.host == nil, self.attachLayer() {
                        self.setupIfNeeded()
                        self.paint(force: true)
                        NSLog("[shuyin] pip re-attach (active)")
                    }
                }
            }
        }
        NSLog("[shuyin] pip ready (possible=%d auto=%d)",
              c.isPictureInPicturePossible ? 1 : 0,
              c.canStartPictureInPictureAutomaticallyFromInline ? 1 : 0)
    }

    /// 前台启动画中画；不满足条件时把原因写进日志，便于回传定位。
    private func startIfPossible(reason: String) {
        guard let c = ctrl else {
            NSLog("[shuyin] pip start skip: no controller (%@)", reason)
            return
        }
        if c.isPictureInPictureActive { return }
        guard c.isPictureInPicturePossible else {
            NSLog("[shuyin] pip start skip: not possible (%@)", reason)
            return
        }
        c.startPictureInPicture()
        NSLog("[shuyin] pip start (%@)", reason)
    }

    // MARK: - 画一帧

    /// `force` = 内容真的变了（立即画）；否则只按 0.9s 节流补一帧保活。
    private func paint(force: Bool = false) {
        guard wanted, ctrl != nil else { return }
        let now = Date()
        if !force && now.timeIntervalSince(lastEnqueue) < 0.9 { return }
        guard let sb = render(line: line, prog: prog) else {
            NSLog("[shuyin] pip render failed")
            return
        }
        if layer.status == .failed {
            layer.flush()
        }
        layer.enqueue(sb)
        lastEnqueue = now
    }

    /// 把「一句词 + 唱到哪儿」画成一张 BGRA 位图，再包成 CMSampleBuffer。
    private func render(line: String, prog: Double) -> CMSampleBuffer? {
        var pb: CVPixelBuffer?
        let attrs: [CFString: Any] = [
            kCVPixelBufferCGImageCompatibilityKey: true,
            kCVPixelBufferCGBitmapContextCompatibilityKey: true,
            /*
             * **必须带 IOSurface**。
             *
             * `AVSampleBufferDisplayLayer` 只显示 IOSurface 支撑的缓冲区；
             * 普通 malloc 出来的 BGRA 缓冲区 `enqueue` 不报错、layer 也不进
             * `.failed`，就是**什么都不显示**——画中画窗口在、里面永远是空的。
             * 2026-11-25 用户报的「只有一个边框，没有歌词」就是这条：
             * 上一版只给了 CGImage/CGBitmapContext 兼容位，漏了表面。
             *
             * Metal 兼容位一起给上：layer 内部是 Metal 合成的，缺它时
             * 部分机型能显示但会掉帧。
             */
            kCVPixelBufferIOSurfacePropertiesKey: [String: Any]() as CFDictionary,
            kCVPixelBufferMetalCompatibilityKey: true,
        ]
        guard CVPixelBufferCreate(
            kCFAllocatorDefault, W, H, kCVPixelFormatType_32BGRA,
            attrs as CFDictionary, &pb,
        ) == kCVReturnSuccess, let buf = pb else { return nil }

        CVPixelBufferLockBaseAddress(buf, [])
        defer { CVPixelBufferUnlockBaseAddress(buf, []) }
        guard let base = CVPixelBufferGetBaseAddress(buf),
              let ctx = CGContext(
                data: base, width: W, height: H, bitsPerComponent: 8,
                bytesPerRow: CVPixelBufferGetBytesPerRow(buf),
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue
                    | CGBitmapInfo.byteOrder32Little.rawValue,
              )
        else { return nil }

        let w = CGFloat(W), h = CGFloat(H)
        ctx.clear(CGRect(x: 0, y: 0, width: w, height: h))

        /*
         * 底板：一条接近纯黑的半透明圆角条，对齐酷狗那种桌面歌词。
         *
         * 上一版叠了暖调渐变 + 高光描边 + 文字阴影，一行歌词上全是花活，
         * 反而显脏。这里只留一层干净的深色底，靠系统窗口自己的圆角收边。
         */
        let corner = min(h * 0.22, 40)
        let box = CGRect(x: 0, y: 0, width: w, height: h)
        ctx.saveGState()
        ctx.addPath(CGPath(roundedRect: box, cornerWidth: corner, cornerHeight: corner, transform: nil))
        ctx.clip()
        ctx.setFillColor(UIColor(white: 0.07, alpha: 0.95).cgColor)
        ctx.fill(box)
        ctx.restoreGState()

        /*
         * UIKit 的文字绘制是「上到下」的坐标系，CGContext 是「下到上」。
         * 先把画布翻过来再 push，字号/换行这些交给 UIKit，省得手写 CoreText 排版。
         */
        ctx.saveGState()
        ctx.translateBy(x: 0, y: h)
        ctx.scaleBy(x: 1, y: -1)
        UIGraphicsPushContext(ctx)

        let text = line.isEmpty ? "疏音" : line
        let padX = min(h * 0.34, w * 0.05)
        let avail = w - padX * 2

        /*
         * 字号取「高度比例」与「宽度比例」的较小值。
         *
         * 只按高度算会翻车：画中画窗口被系统摆成 16:9 时，`didTransitionToRenderSize`
         * 会把画布高度补高，`h*0.44` 那种系数直接放出 200px 的大字。
         * 2026-11-26 用户对照酷狗再报「字体还是太大、图标也很大」：
         * 系数从 (h*0.30, w*0.058) 压到 (h*0.26, w*0.042)——按窗口宽度算，
         * 一屏能放约 24 个字，字高只占画布高度 26%，配合 8:1 的扁画布，
         * 整条窗口在屏上就是一条细缝。
         */
        var fontPt = max(14, min(h * 0.26, w * 0.042))
        var font = UIFont.systemFont(ofSize: fontPt, weight: .medium)
        var textW = (text as NSString).size(withAttributes: [.font: font]).width

        /*
         * 放不下时先缩字号（最多缩到 72%，再小就糊了）。
         * 缩完还放不下 → 走跑马灯，由句内进度驱动横向位移（见下）。
         */
        if textW > avail {
            let scaled = max(fontPt * 0.72, fontPt * (avail / textW))
            if scaled < fontPt {
                fontPt = scaled
                font = UIFont.systemFont(ofSize: fontPt, weight: .medium)
                textW = (text as NSString).size(withAttributes: [.font: font]).width
            }
        }
        let overflow = max(0, textW - avail)
        /*
         * 超宽位移 = 溢出量 × 句内进度：唱到句末刚好把最后几个字推出来。
         * 高亮边界因此恒在可视区里线性推进，读起来就是卡拉OK 的扫光。
         * 上版用 `.byTruncatingTail` 直接截断，长句后半句永远看不到——
         * 用户要的「跑马灯」就是这条。
         */
        let drawX = padX - overflow * CGFloat(max(0, min(1, prog)))

        let para = NSMutableParagraphStyle()
        para.alignment = .left
        para.lineBreakMode = .byClipping

        let shadow = NSShadow()
        shadow.shadowColor = UIColor(white: 0, alpha: 0.62)
        shadow.shadowBlurRadius = max(2, h * 0.014)
        shadow.shadowOffset = CGSize(width: 0, height: max(1, h * 0.005))

        let lineH = font.lineHeight
        /* 宽度给足：宽度不够 UIKit 会按 word wrap 折行，长句就变成两行了 */
        let rect = CGRect(
            x: drawX, y: (h - lineH) / 2,
            width: textW + fontPt, height: lineH,
        )
        let textAttrs: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: UIColor(white: 1, alpha: line.isEmpty ? 0.34 : 0.62),
            .paragraphStyle: para,
            .kern: fontPt * 0.012,
            .shadow: shadow,
        ]
        (text as NSString).draw(in: rect, withAttributes: textAttrs)

        /*
         * 已唱部分：按整句宽度切一条竖线，把同一句再画一遍暖金。
         * 整行画两遍再裁，比按字切便宜，边界还能落在字中间。
         */
        if prog > 0.0005, !line.isEmpty {
            let cut = drawX + textW * CGFloat(min(1, max(0, prog)))
            if cut > 0 {
                let gold: [NSAttributedString.Key: Any] = [
                    .font: font,
                    .foregroundColor: UIColor(red: 1.0, green: 0.83, blue: 0.44, alpha: 1),
                    .paragraphStyle: para,
                    .kern: fontPt * 0.012,
                    .shadow: shadow,
                ]
                ctx.saveGState()
                ctx.clip(to: CGRect(x: 0, y: 0, width: min(cut, w), height: h))
                (text as NSString).draw(in: rect, withAttributes: gold)
                ctx.restoreGState()
            }
        }

        UIGraphicsPopContext()
        ctx.restoreGState()

        /* 位图 → CMSampleBuffer（画中画的喂帧格式） */
        var fmt: CMVideoFormatDescription?
        guard CMVideoFormatDescriptionCreateForImageBuffer(
            allocator: kCFAllocatorDefault,
            imageBuffer: buf,
            formatDescriptionOut: &fmt,
        ) == noErr, let fmt else { return nil }

        /*
         * 时间戳对齐 timebase 的当下：喂进去的帧永远是「新的」，不会被系统
         * 当过期帧丢掉（那样窗口会停在第 N 帧再也不动，且不报错）。
         */
        let pts = CMClockGetTime(CMClockGetHostTimeClock())
        if let tb = timebase {
            _ = CMTimebaseSetTime(tb, time: pts)
        }
        var timing = CMSampleTimingInfo(
            duration: CMTime(value: 1, timescale: 10),
            presentationTimeStamp: pts,
            decodeTimeStamp: .invalid,
        )
        var sb: CMSampleBuffer?
        guard CMSampleBufferCreateReadyWithImageBuffer(
            allocator: kCFAllocatorDefault,
            imageBuffer: buf,
            formatDescription: fmt,
            sampleTiming: &timing,
            sampleBufferOut: &sb,
        ) == noErr else { return nil }
        return sb
    }

    // MARK: - 生命周期（全部留痕，回传 app.log / 控制台可定位）

    func pictureInPictureControllerWillStartPictureInPicture(
        _ pictureInPictureController: AVPictureInPictureController,
    ) {
        NSLog("[shuyin] pip will start")
    }

    func pictureInPictureControllerDidStartPictureInPicture(
        _ pictureInPictureController: AVPictureInPictureController,
    ) {
        NSLog("[shuyin] pip did start")
    }

    /// 启动失败在这里如实报出来——上一版没有这个回调，失败是完全静默的。
    func pictureInPictureController(
        _ pictureInPictureController: AVPictureInPictureController,
        failedToStartPictureInPictureWithError error: Error,
    ) {
        NSLog("[shuyin] pip FAILED: %@", error.localizedDescription)
    }

    /// 停止流程的入口（按 ×、回 App、in-app 关开关都会先到这里）：
    /// 立起收尾旗，让收尾途中 AVKit 补发的那次 `setPlaying(false)`
    /// （「终止画中画播放」）不会把正在放的音乐暂停掉。
    func pictureInPictureControllerWillStopPictureInPicture(
        _ pictureInPictureController: AVPictureInPictureController,
    ) {
        markStopping(2)
        NSLog("[shuyin] pip will stop")
    }

    /// 点画中画上的「回到 App」：必须回调 completionHandler，否则窗口不关。
    ///
    /// 2026-11-28 用户要求「直接放大到应用播放界面」，而以前这里只是立刻回 true：
    /// App 从后台被拉起来时还停在原来那一页（甚至是曲库顶部），画中画窗口放大
    /// 回去对上的是一张还没画出来的界面——就是那一下黑屏 + 跳一下。
    ///
    /// 现在的顺序：
    ///   1. 先给前端发 `restore`，让它把播放页打开（`pip://restore` → 播放页）；
    ///   2. 立起 `restoring`，拦住 didBecomeActive 里那条「回 App 就收窗」，
    ///      别再和系统的收尾动画抢；
    ///   3. 让出一帧（120ms）再回 true，等 WebView 把播放页画出来，
    ///      放大动画落点就是播放页本身。
    func pictureInPictureController(
        _ pictureInPictureController: AVPictureInPictureController,
        restoreUserInterfaceForPictureInPictureStopWithCompletionHandler
            completionHandler: @escaping (Bool) -> Void,
    ) {
        NSLog("[shuyin] pip restore request")
        restoring = true
        /* 收尾期间 AVKit 补发的 setPlaying(false) 一律只记账（别把歌暂停了） */
        markStopping(2)
        /* 目的页：播放界面。前端收到就切过去（App 在后台时 JS 冻着，
           这条会在回到前台的第一时间执行，正好赶在放大动画之前）。 */
        send("restore")
        /*
         * **等前端的回执再放行动画**。
         *
         * 上一版固定等 150ms 就 `completionHandler(true)`：那会儿 WKWebView
         * 往往还没画出播放页，系统按我们的话开始放大，落点是一张还没上色的
         * 界面——用户看到的就是「黑一下、然后页面滑上来」（2026-11-28 第二次实报）。
         * 现在把回调存起来，前端画完播放页那一帧回一条 `pip_restore_ready`
         * （Rust `pip_restore_ready` → dlsym 到本文件），我们才让系统动。
         * 900ms 是兜底：回执丢了也绝不能让画中画窗口僵在原地。
         */
        pendingRestore = completionHandler
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) { [weak self] in
            self?.finishRestore("timeout")
        }
        /* 兜底：万一系统没回调 didStop，旗子不能一直立着 */
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
            self?.restoring = false
        }
    }

    /// 放行系统那条「放大回 App」的动画（只生效一次）。
    func finishRestore(_ why: String) {
        guard let cb = pendingRestore else { return }
        pendingRestore = nil
        NSLog("[shuyin] pip restore -> animate (%@)", why)
        cb(true)
    }

    // MARK: - SampleBufferPlaybackDelegate（iOS 26 SDK 里这 4 个都是 required）

    func pictureInPictureController(
        _ pictureInPictureController: AVPictureInPictureController, setPlaying playing: Bool,
    ) {
        /*
         * 收尾途中的 setPlaying 是 AVKit 在「终止画中画里的播放」（见 stopping
         * 的注释），说的是窗口里那条视频，不是正在放的音乐——只记账，不转发。
         * 没有这道闸，按 × 关窗口 = 音乐跟着暂停，2026-11-26 实报。
         */
        if stopping || Date() < swallowUntil {
            self.playing = playing
            NSLog("[shuyin] pip setPlaying(%d) swallowed (closing)", playing ? 1 : 0)
            return
        }
        /*
         * 回声挡板：系统偶尔会把当前状态原样再报一遍。跟播放器真值一致就
         * 什么都不做——以前无条件转发 playpause（toggle 语义），系统回声和
         * 200ms 心跳真值之间一来一回，会出现「点了暂停又自己播起来」。
         */
        let wasPlaying = self.playing
        self.playing = playing
        if playing == wasPlaying { return }
        send("playpause")
    }

    /// 时长有限（VOD 语义）系统才画「播放/暂停」键；正无穷=直播=停止键。
    /// 时长未知（0）时兜底 1 小时，保证按键形态不漂移；画布本身不显示进度条，
    /// 这个值只影响系统按键的形态与 ±10 秒键（已映射成上一首/下一首）。
    func pictureInPictureControllerTimeRangeForPlayback(
        _ controller: AVPictureInPictureController,
    ) -> CMTimeRange {
        let dur = duration > 0 ? duration : 3_600
        return CMTimeRange(start: .zero, duration: CMTime(seconds: dur, preferredTimescale: 1))
    }

    func pictureInPictureControllerIsPlaybackPaused(
        _ controller: AVPictureInPictureController,
    ) -> Bool {
        !playing
    }

    /// iOS 26 SDK 把这个方法标成 required，删掉直接 conformance 编译失败。
    /// `requiresLinearPlayback = true` 之后系统不会再画跳转键；万一某个版本
    /// 还是画了出来，点下去映射上一首/下一首，至少不是「跳 10 秒」这种胡说。
    func pictureInPictureController(
        _ controller: AVPictureInPictureController,
        skipByInterval skipInterval: CMTime,
        completion completionHandler: @escaping () -> Void,
    ) {
        send(skipInterval.seconds >= 0 ? "next" : "prev")
        completionHandler()
    }

    func pictureInPictureController(
        _ controller: AVPictureInPictureController,
        didTransitionToRenderSize newRenderSize: CMVideoDimensions,
    ) {
        /*
         * 窗口比例变了（用户捏合缩放、系统重排）。
         *
         * 画布必须跟着换比例：固定 960×300 丢进一个 16:9 的窗口，
         * `resizeAspect` 会上下留黑边，字看起来忽大忽小——用户说的
         * 「文字太大、不适配」就是这条。6% 容差是防抖：改 `layer.frame`
         * 本身可能再触发一次本回调，没有容差会来回弹。
         */
        let rw = Double(newRenderSize.width), rh = Double(newRenderSize.height)
        if rw > 0, rh > 0 {
            let target = Int((Double(W) * (rh / rw)).rounded())
            if abs(target - H) > Int(Double(H) * 0.06), target >= 160 {
                H = target
                layer.frame = CGRect(x: 0, y: 0, width: W, height: H)
                NSLog("[shuyin] pip canvas -> %@", "\(W)×\(H)")
            }
        }
        /* 尺寸变了必须重画：字和圆角都是按 H 算的 */
        painted = "\u{0}"
        paint(force: true)
    }

    func pictureInPictureControllerDidStopPictureInPicture(
        _ controller: AVPictureInPictureController,
    ) {
        stopping = false
        NSLog("[shuyin] pip stopped (fg=%d self=%d restore=%d)",
              stoppingForForeground ? 1 : 0, selfClosing ? 1 : 0, restoring ? 1 : 0)
        /*
         * 「回 App」有两条路：用户点了窗口上的方框箭头（restore 回调），
         * 或 App 自己回到前台（didBecomeActive 兜底）。两条都是收窗、
         * **不是关开关**，所以控制器和宿主 view 都留着——销毁了下次切后台
         * 就再也浮不起来（后台不允许 start），留着才能靠
         * `canStartPictureInPictureAutomaticallyFromInline` 自动重开。
         */
        if stoppingForForeground || restoring {
            stoppingForForeground = false
            restoring = false
            return
        }
        if selfClosing {
            /* 我们自己关的开关：拆干净，不回传 pipclosed（开关本来就是关的）。 */
            selfClosing = false
            teardown()
            painted = "\u{0}"
            return
        }
        /*
         * 用户按了窗口上那颗 ×。
         *
         * 这就是「开关和实际显示不一致」的来源：原生单方面把窗关了，前端那份
         * state 还是「开」。这里把真值改成关，并回传一条 `pipclosed`，
         * 让前端把开关拨回去。
         */
        wanted = false
        UserDefaults.standard.set(false, forKey: "shuyin.pip.lyrics")
        teardown()
        painted = "\u{0}"
        send("pipclosed")
    }

    // MARK: - 反向：告诉 Rust

    private func send(_ cmd: String) {
        guard let h = dlopen(nil, RTLD_NOW),
              let sym = dlsym(h, "shuyin_remote_command") else { return }
        let fn = unsafeBitCast(sym, to: RemoteFn.self)
        cmd.withCString { fn($0) }
    }
}

/* ------------------------------------------------------------------ */
/* 给 Rust 调的 C 入口                                                  */
/* ------------------------------------------------------------------ */

/// 符号锚点：App 启动时 Rust 会 dlsym 调一次这个入口。
///
/// `ShuyinPiP` 类在 Swift 侧没有任何静态引用链，Release 的 `-dead_strip`
/// 会把整个 object（含下面三个 `@_cdecl` 符号）剥掉，dlsym 于是恒 NULL、
/// 开关永远返回 false。Rust 启动时 dlsym 命中本函数 → 链接器认定这个
/// object 可达、连同类一起保留。
/// 函数体刻意引用 `ShuyinPiP.shared`，确保优化器不会把类本身也剥掉。
@_cdecl("shuyin_pip_adopt")
public func shuyinPiPAdopt() {
    NSLog("[shuyin] pip adopt (symbol alive)")
    guard #available(iOS 15.0, *) else { return }
    _ = ShuyinPiP.shared
}

@_cdecl("shuyin_pip_set")
public func shuyinPiPSet(
    _ line: UnsafePointer<CChar>?, _ prog: Double, _ playing: Bool, _ duration: Double,
) {
    guard #available(iOS 15.0, *) else { return }
    let text = line.map { String(cString: $0) } ?? ""
    ShuyinPiP.shared.set(line: text, prog: prog, playing: playing, duration: duration)
}

@_cdecl("shuyin_pip_toggle")
public func shuyinPiPToggle() -> Bool {
    NSLog("[shuyin] pip C toggle called")
    guard #available(iOS 15.0, *) else { return false }
    let r = ShuyinPiP.shared.toggle()
    NSLog("[shuyin] pip C toggle -> %@", r ? "true" : "false")
    return r
}

@_cdecl("shuyin_pip_on")
public func shuyinPiPOn() -> Bool {
    guard #available(iOS 15.0, *) else { return false }
    if Thread.isMainThread { return ShuyinPiP.shared.wanted }
    var out = false
    DispatchQueue.main.sync { out = ShuyinPiP.shared.wanted }
    return out
}

/// 前端「播放页已经画好了」的回执：放行系统那条放大动画。
///
/// 由 Rust 的 `pip_restore_ready` 命令 dlsym 过来（`App.tsx` 在打开播放页
/// 之后、两帧之后调）。回调必须在主线程，所以这里统一跳一次 main。
@_cdecl("shuyin_pip_restore_ready")
public func shuyinPiPRestoreReady() {
    guard #available(iOS 15.0, *) else { return }
    if Thread.isMainThread {
        ShuyinPiP.shared.finishRestore("ui ready")
    } else {
        DispatchQueue.main.async { ShuyinPiP.shared.finishRestore("ui ready") }
    }
}

/// App 启动时申请通知授权。系统「正在播放」卡与画中画都属通知体系，
/// 首次「允许通知」是正常的一步，之后不再弹。Rust 侧 `ios_media::init` dlsym 调它。
@_cdecl("shuyin_notif_bootstrap")
public func shuyinNotifBootstrap() {
    DispatchQueue.main.async {
        UNUserNotificationCenter.current().requestAuthorization(
            options: [.alert, .sound, .badge]
        ) { granted, error in
            NSLog("[shuyin] notif auth granted=%d err=%@",
                  granted ? 1 : 0, error?.localizedDescription ?? "-")
        }
    }
}
