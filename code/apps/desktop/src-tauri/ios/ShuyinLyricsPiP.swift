import AVFoundation
import AVKit
import CoreGraphics
import Darwin
import UIKit

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
    /// 已经画进 buffer 的那一帧的「内容指纹」，一样就不重画（省电）
    private var painted = "\u{0}"
    /// 上次真正 enqueue 的时刻：内容没变也要定期补一帧，否则系统会把
    /// 「长时间没有新 sample」当成播放结束，自己把画中画收掉。
    private var lastEnqueue = Date.distantPast
    /// 后台通知只挂一次
    private var observing = false

    /// 开关真值（持久化：用户开过一次，下次启动仍按开的来）
    private(set) var wanted: Bool = UserDefaults.standard.bool(forKey: "shuyin.pip.lyrics")

    private let W = 640
    private let H = 190

    // MARK: - 对外（C 入口调这些）

    func set(line: String, prog: Double, playing: Bool) {
        DispatchQueue.main.async {
            self.line = line
            self.prog = max(0, min(1, prog))
            self.playing = playing
            /*
             * 句内进度按 2% 量化：640px 宽的条上差 2% 是 13px，肉眼刚好察觉不到，
             * 但每秒重画的次数从 5 次降到 1~2 次——画中画本身是要耗电的窗口。
             * 内容没变也照样调 `paint()`，由它内部的 0.9s 节流补一帧保活。
             */
            let q = Int(self.prog * 50)
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
            guard attachLayer() else {
                /*
                 * 拿不到前台 keyWindow（App 还没完成启动）：这一下没法起 PiP。
                 * 开关状态留着，等 didBecomeActiveNotification 再补一次。
                 */
                NSLog("[shuyin] pip on: no foreground window, retry on active")
                return wanted
            }
            setupIfNeeded()
            /* 前台先渲染一帧——layer 空的时候系统拒绝启动 */
            paint(force: true)
            /*
             * 必须**在前台**启动。延迟 0.2s 是等第一帧真正被 layer 接收
             * （enqueue 是异步的，紧接着 start 会拿到 isPictureInPicturePossible=false）。
             */
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
                self?.startIfPossible(reason: "toggle")
            }
        } else {
            ctrl?.stopPictureInPicture()
            ctrl = nil
            host?.removeFromSuperview()
            host = nil
            painted = "\u{0}"
            lastEnqueue = .distantPast
        }
        NSLog("[shuyin] pip toggle -> %@", wanted ? "on" : "off")
        return wanted
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

        let source = AVPictureInPictureController.ContentSource(
            sampleBufferDisplayLayer: layer,
            playbackDelegate: self,
        )
        let c = AVPictureInPictureController(contentSource: source)
        c.delegate = self
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
            /* 开关点得太早（没有前台 window）时，回到前台补一次 */
            NotificationCenter.default.addObserver(
                forName: UIApplication.didBecomeActiveNotification,
                object: nil, queue: .main,
            ) { [weak self] _ in
                guard let self, self.wanted else { return }
                if self.attachLayer() {
                    self.startIfPossible(reason: "active")
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

        ctx.clear(CGRect(x: 0, y: 0, width: CGFloat(W), height: CGFloat(H)))

        /* 底板：深棕黑圆角条（跟专辑主色那层暖调接近，压得住亮壁纸） */
        let box = CGRect(x: 0, y: 0, width: CGFloat(W), height: CGFloat(H))
        let path = CGPath(roundedRect: box, cornerWidth: 30, cornerHeight: 30, transform: nil)
        ctx.addPath(path)
        ctx.setFillColor(UIColor(red: 0.10, green: 0.08, blue: 0.07, alpha: 0.94).cgColor)
        ctx.fillPath()

        /*
         * UIKit 的文字绘制是「上到下」的坐标系，CGContext 是「下到上」。
         * 先把画布翻过来再 push，字号/换行这些交给 UIKit，省得手写 CoreText 排版。
         */
        ctx.saveGState()
        ctx.translateBy(x: 0, y: CGFloat(H))
        ctx.scaleBy(x: 1, y: -1)
        UIGraphicsPushContext(ctx)

        let text = line.isEmpty ? "疏音" : line
        let font = UIFont.systemFont(ofSize: 54, weight: .semibold)
        let para = NSMutableParagraphStyle()
        para.alignment = .left
        para.lineBreakMode = .byTruncatingTail
        let white: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: UIColor(white: 0.96, alpha: 1),
            .paragraphStyle: para,
        ]
        let gold: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: UIColor(red: 1.0, green: 0.79, blue: 0.30, alpha: 1),
            .paragraphStyle: para,
        ]

        let padX: CGFloat = 30
        let rect = CGRect(
            x: padX, y: (CGFloat(H) - 66) / 2,
            width: CGFloat(W) - padX * 2, height: 66,
        )
        (text as NSString).draw(in: rect, withAttributes: white)
        /*
         * 已唱部分：按整句宽度切一条竖线，把同一句再画一遍金色。
         * 整行画两遍再裁，比按字切便宜，边界还能落在字中间。
         */
        if prog > 0.001 {
            let full = (text as NSString).size(withAttributes: white).width
            let cut = padX + full * CGFloat(prog)
            ctx.saveGState()
            ctx.clip(to: CGRect(x: 0, y: 0, width: min(cut, CGFloat(W)), height: CGFloat(H)))
            (text as NSString).draw(in: rect, withAttributes: gold)
            ctx.restoreGState()
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

    /// 点画中画上的「回到 App」：必须回调 completionHandler，否则窗口不关。
    func pictureInPictureController(
        _ pictureInPictureController: AVPictureInPictureController,
        restoreUserInterfaceForPictureInPictureStopWithCompletionHandler
            completionHandler: @escaping (Bool) -> Void,
    ) {
        NSLog("[shuyin] pip restore request")
        completionHandler(true)
    }

    func pictureInPictureController(
        _ controller: AVPictureInPictureController, setPlaying playing: Bool,
    ) {
        self.playing = playing
        send("playpause")
    }

    func pictureInPictureControllerTimeRangeForPlayback(
        _ controller: AVPictureInPictureController,
    ) -> CMTimeRange {
        /* 一条字幕没有「片长」：给一个够长的区间，别让系统画进度条 */
        CMTimeRange(start: .zero, duration: CMTime(seconds: 3600, preferredTimescale: 600))
    }

    func pictureInPictureControllerIsPlaybackPaused(
        _ controller: AVPictureInPictureController,
    ) -> Bool {
        !playing
    }

    func pictureInPictureController(
        _ controller: AVPictureInPictureController,
        didTransitionToRenderSize newRenderSize: CMVideoDimensions,
    ) {
        /* 窗口被用户缩放：按新尺寸重画一帧，字才不会糊 */
        painted = "\u{0}"
        paint(force: true)
    }

    func pictureInPictureController(
        _ controller: AVPictureInPictureController,
        skipByInterval skipInterval: CMTime,
        completion completionHandler: @escaping () -> Void,
    ) {
        /* 上一首 / 下一首那颗键也会落到这里（系统把「快进」映射成 skip） */
        send(skipInterval.seconds >= 0 ? "next" : "prev")
        completionHandler()
    }

    func pictureInPictureControllerDidStopPictureInPicture(
        _ controller: AVPictureInPictureController,
    ) {
        NSLog("[shuyin] pip stopped")
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
/// object 可达、连同类一起保留。和灵动岛的 `shuyin_live_adopt` 同款机制。
/// 函数体刻意引用 `ShuyinPiP.shared`，确保优化器不会把类本身也剥掉。
@_cdecl("shuyin_pip_adopt")
public func shuyinPiPAdopt() {
    NSLog("[shuyin] pip adopt (symbol alive)")
    guard #available(iOS 15.0, *) else { return }
    _ = ShuyinPiP.shared
}

@_cdecl("shuyin_pip_set")
public func shuyinPiPSet(_ line: UnsafePointer<CChar>?, _ prog: Double, _ playing: Bool) {
    guard #available(iOS 15.0, *) else { return }
    let text = line.map { String(cString: $0) } ?? ""
    ShuyinPiP.shared.set(line: text, prog: prog, playing: playing)
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
