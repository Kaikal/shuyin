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
/// 开关由 `shuyin_pip_toggle()` 控制：打开时建 controller（必须在前台），
/// 之后 App 一进后台，系统就把这条字幕浮起来（`canStartPictureInPictureAutomaticallyFromInline`）。
///
/// ## 两个坑
///
/// 1. **必须给 layer 一个 timebase**：画中画按时间轴驱动显示，timebase 为 nil
///    时窗口是黑的（不报错，只是什么都没有）。
/// 2. **所有 AVKit 调用都回主线程**：Rust 那条心跳在音频线程旁边的普通线程上，
///    直接调会在后台线程建 UI 对象，轻则窗口不出现，重则崩。
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

    /// 当前要画的句子与进度（只由 `shuyin_pip_set` 改）
    private var line = ""
    private var prog: Double = 0
    private var playing = false
    /// 已经画进 buffer 的那一帧的「内容指纹」，一样就不重画（省电）
    private var painted = "\u{0}"
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
             * 只在**画面真的变了**的时候重画。
             *
             * 句内进度按 2% 量化：640px 宽的条上差 2% 是 13px，肉眼刚好察觉不到，
             * 但每秒重画的次数从 5 次降到 1~2 次——画中画本身是要耗电的窗口，
             * 不能拿 60fps 去喂一条字幕。
             */
            let q = Int(self.prog * 50)
            let key = "\(line)|\(q)|\(playing ? 1 : 0)"
            guard key != self.painted else { return }
            self.painted = key
            self.paint()
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
            setupIfNeeded()
            /* 前台先渲染一帧，画中画才有内容可显示 */
            paint()
        } else {
            ctrl?.stopPictureInPicture()
            ctrl = nil
            painted = "\u{0}"
        }
        NSLog("[shuyin] pip toggle -> %@", wanted ? "on" : "off")
        return wanted
    }

    // MARK: - 建窗口

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
             * 注意调用形式：这些 CoreMedia/CoreVideo 的 C 函数在 Swift 里是
             * **无参数标签**的（头文件没写 CF_SWIFT_NAME）。写成 allocator: 那种
             * 会直接编译不过——CI 上就是一条 unrelated 的报错。
             */
            _ = CMTimebaseCreateWithSourceClock(
                kCFAllocatorDefault, CMClockGetHostTimeClock(), &tb,
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
         * App 一进后台就自动浮起来——这条才是「切到别的应用还能看词」的关键。
         * 它要求 App 声明了 audio 后台模式（Info.plist 的 UIBackgroundModes，
         * 我们本来就有）且此刻在出声。
         */
        c.canStartPictureInPictureAutomaticallyFromInline = true
        ctrl = c
        /*
         * 第二条保险：`canStart...AutomaticallyFromInline` 是「请系统在切后台时
         * 自己起」。它在部分系统版本 / 部分机型上不灵（内容源不是 AVPlayer 时
         * 尤其容易静默失效）。这里再接一次「即将进后台」的通知，当场 start ——
         * 那一刻 App 还没被挂起，start 是合法的。
         */
        if !observing {
            observing = true
            NotificationCenter.default.addObserver(
                forName: UIApplication.didEnterBackgroundNotification,
                object: nil, queue: .main,
            ) { [weak self] _ in
                guard let self, self.wanted, let c = self.ctrl else { return }
                if c.isPictureInPictureActive { return }
                c.startPictureInPicture()
                NSLog("[shuyin] pip start on background")
            }
        }
        NSLog("[shuyin] pip ready (auto=%d)", c.canStartPictureInPictureAutomaticallyFromInline ? 1 : 0)
    }

    // MARK: - 画一帧

    private func paint() {
        guard wanted, ctrl != nil else { return }
        guard let sb = render(line: line, prog: prog) else { return }
        if layer.status == .failed {
            layer.flush()
        }
        layer.enqueue(sb)
    }

    /// 把「一句词 + 唱到哪儿」画成一张 BGRA 位图，再包成 CMSampleBuffer。
    private func render(line: String, prog: Double) -> CMSampleBuffer? {
        var pb: CVPixelBuffer?
        let attrs: [CFString: Any] = [
            kCVPixelBufferCGImageCompatibilityKey: true,
            kCVPixelBufferCGBitmapContextCompatibilityKey: true,
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

        ctx.clear(CGRect(x: 0, y: 0, width: W, height: H))

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
         *
         * 和安卓那边（`LyricBoard.drawKtv`）同一个思路：整行画两遍再裁，
         * 比按字切便宜得多，边界还能落在字中间（逐字换色会「一卡一卡地蹦」）。
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
            kCFAllocatorDefault, buf, &fmt,
        ) == noErr, let fmt else { return nil }

        /*
         * 时间戳必须**对齐 timebase 的当下**。
         *
         * 早先按「第几帧 × 0.1 秒」递增：timebase 是按真实时间走的，喂到几十帧
         * 之后那些帧全都成了「过期帧」，系统直接丢掉——画中画窗口停在第 N 帧
         * 再也不动（不报错，最难查的那种）。现在每帧都用宿主时钟的现在，
         * 同时把 timebase 拨到同一个点，帧永远是「新的」。
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
            kCFAllocatorDefault, buf, fmt, &timing, &sb,
        ) == noErr else { return nil }
        return sb
    }

    // MARK: - 系统按钮

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
        paint()
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
        NSLog("[shuyin] pip stopped by system")
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

@_cdecl("shuyin_pip_set")
public func shuyinPiPSet(_ line: UnsafePointer<CChar>?, _ prog: Double, _ playing: Bool) {
    guard #available(iOS 15.0, *) else { return }
    let text = line.map { String(cString: $0) } ?? ""
    ShuyinPiP.shared.set(line: text, prog: prog, playing: playing)
}

@_cdecl("shuyin_pip_toggle")
public func shuyinPiPToggle() -> Bool {
    guard #available(iOS 15.0, *) else { return false }
    return ShuyinPiP.shared.toggle()
}

@_cdecl("shuyin_pip_on")
public func shuyinPiPOn() -> Bool {
    guard #available(iOS 15.0, *) else { return false }
    if Thread.isMainThread { return ShuyinPiP.shared.wanted }
    var out = false
    DispatchQueue.main.sync { out = ShuyinPiP.shared.wanted }
    return out
}
