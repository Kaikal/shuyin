//! iOS 冷启动 URL（「用疏音打开」）的补救层。
//!
//! 为什么需要这一层（读 tao 0.37.1 源码确认，不是猜）：
//!
//! | 场景 | URL 从哪来 | tao 处理 |
//! |---|---|---|
//! | 热启动（App 已在后台） | `scene:openURLContexts:` / `application:openURL:options:` | ✅ 转成 `RunEvent::Opened` |
//! | 冷启动 · scene 模式 | `UISceneConnectionOptions.urlContexts`（在 `scene:willConnectToSession:` 参数里） | ❌ `connect_scene` 只取 scene 和 window，不读 URLContexts |
//! | 冷启动 · 老模式 | `launchOptions[UIApplicationLaunchOptionsURLKey]` | ❌ `did_finish_launching` 连参数都不看 |
//!
//! 所以冷启动打开文件的表现是「App 起来了，什么也没发生」——URL 从来没人读。
//!
//! 修法：在 `UIApplicationMain` 之前（`app.run()` 之前）挂两个通知观察者。
//! UIKit 发这两个通知时把同一份 options 塞进 `userInfo`，我们就在那里把
//! `file://` URL 收进全局队列，之后由 `lib.rs` 的 `stage_opened_file` 统一落盘。
//!
//! 为什么不在观察者里直接落盘：`app_cache_dir()` 要 AppHandle，而观察者注册时
//! 刻意早于任何 UI 初始化，手里没有 handle。收 URL 的成本是一次字符串拷贝，
//! 推迟到 `setup` / `take_open_file`（都在 UI 就绪后）没有副作用。

use std::sync::Mutex;

/// 冷启动时系统送进来的 `file://` URL。
static PENDING: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// NSString：与 smtc.rs 同一套裸 msg_send 写法（不开 objc2-foundation，
/// 那套强类型 API 的泛型在版本间反复变过）。
///
/// # Safety
/// 只能在主线程调用（UIKit 对象都归主线程）。
unsafe fn ns(s: &str) -> objc2::rc::Retained<objc2::runtime::AnyObject> {
    let c = std::ffi::CString::new(s).unwrap_or_default();
    objc2::msg_send![objc2::class!(NSString), stringWithUTF8String: c.as_ptr()]
}

/// 把 NSURL 的绝对地址收进待处理队列。
///
/// 只收 `file:`：「用疏音打开」，`stage_opened_file` 会把文件摆到 inbox。
/// 其他 scheme（http 等）交给 `stage_opened_file` 忽略即可。
///
/// # Safety
/// `url` 必须是 NSURL 或 null。
unsafe fn push_url(url: *mut objc2::runtime::AnyObject) {
    if url.is_null() {
        return;
    }
    let abs: *mut objc2::runtime::AnyObject = objc2::msg_send![url, absoluteString];
    if abs.is_null() {
        return;
    }
    let c: *const std::os::raw::c_char = objc2::msg_send![abs, UTF8String];
    if c.is_null() {
        return;
    }
    let Ok(s) = std::ffi::CStr::from_ptr(c).to_str() else {
        return;
    };
    if !s.starts_with("file:") {
        return;
    }
    if let Ok(mut q) = PENDING.lock() {
        /* 同一个 URL 可能被两个通知各送一次（scene 模式会先 willConnect 再 openURLContexts） */
        if !q.iter().any(|x| x == s) {
            q.push(s.to_string());
        }
    }
}

/// 取走全部待处理 URL（取走即清空）。
pub fn drain() -> Vec<String> {
    PENDING
        .lock()
        .map(|mut q| std::mem::take(&mut *q))
        .unwrap_or_default()
}

/// 注册冷启动 URL 的观察者。
///
/// **必须在 `app.run()` 之前调用**：`UIApplicationMain` 是在 run 内部才被调起的，
/// 而 `didFinishLaunching` / `willConnect` 都在它之后立刻发生；注册晚一步就收不到。
pub fn install() {
    use objc2::runtime::AnyObject;
    use std::ptr::NonNull;

    unsafe {
        let center: *mut AnyObject = objc2::msg_send![objc2::class!(NSNotificationCenter), defaultCenter];
        if center.is_null() {
            return;
        }

        /* ---- 老生命周期（Info.plist 没有 UIApplicationSceneManifest） ---- */
        {
            let name = ns("UIApplicationDidFinishLaunchingNotification");
            let block = block2::StackBlock::new(move |note: NonNull<AnyObject>| {
                unsafe {
                    let info: *mut AnyObject = objc2::msg_send![note.as_ptr(), userInfo];
                    if info.is_null() {
                        return;
                    }
                    let k = ns("UIApplicationLaunchOptionsURLKey");
                    let url: *mut AnyObject = objc2::msg_send![info, objectForKey: &*k];
                    push_url(url);
                }
            });
            let _: objc2::rc::Retained<AnyObject> = objc2::msg_send![
                center,
                addObserverForName: &*name,
                object: std::ptr::null_mut::<AnyObject>(),
                queue: std::ptr::null_mut::<AnyObject>(),
                usingBlock: &block
            ];
        }

        /* ---- scene 生命周期（iOS 13+ 的默认形态） ---- */
        {
            let name = ns("UISceneWillConnectNotification");
            let block = block2::StackBlock::new(move |note: NonNull<AnyObject>| {
                unsafe {
                    let info: *mut AnyObject = objc2::msg_send![note.as_ptr(), userInfo];
                    if info.is_null() {
                        return;
                    }
                    let k = ns("UISceneConnectionOptionsKey");
                    let opts: *mut AnyObject = objc2::msg_send![info, objectForKey: &*k];
                    if opts.is_null() {
                        return;
                    }
                    /*
                     * UISceneConnectionOptions.urlContexts 是 NSSet<UIOpenURLContext>。
                     * 这个 key 只会出现在 scene 的连接选项里，对象类型是确定的，
                     * 所以不做 respondsToSelector 探测（BOOL 经 msg_send 回来的
                     * 类型在 objc2 各版本间不统一，白白多一个编译坑）。
                     */
                    let set: *mut AnyObject = objc2::msg_send![opts, URLContexts];
                    if set.is_null() {
                        return;
                    }
                    let iter: *mut AnyObject = objc2::msg_send![set, objectEnumerator];
                    if iter.is_null() {
                        return;
                    }
                    loop {
                        let ctx: *mut AnyObject = objc2::msg_send![iter, nextObject];
                        if ctx.is_null() {
                            break;
                        }
                        let url: *mut AnyObject = objc2::msg_send![ctx, URL];
                        push_url(url);
                    }
                }
            });
            let _: objc2::rc::Retained<AnyObject> = objc2::msg_send![
                center,
                addObserverForName: &*name,
                object: std::ptr::null_mut::<AnyObject>(),
                queue: std::ptr::null_mut::<AnyObject>(),
                usingBlock: &block
            ];
        }
    }
}
