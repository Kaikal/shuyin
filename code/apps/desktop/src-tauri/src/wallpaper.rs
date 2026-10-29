//! 把窗口嵌进桌面层——图标层（`SHELLDLL_DefView`）下面、壁纸（`WorkerW`）上面。
//!
//! **两种系统结构**（2026-10 在本机 Win11 24H2 实测）：
//! ```text
//! Win10 / 24H2 之前的 Win11          Win11 24H2 及以后
//! WorkerW ← 图标                     Progman
//!  └ SHELLDLL_DefView                 ├ SHELLDLL_DefView ← 图标（几乎全透明）
//! WorkerW ← 壁纸                      └ WorkerW          ← 壁纸
//! Progman
//! ```
//! 槽位不同，但一句话能统一：**24H2 = 挂在 Progman 下、插到 DefView 之后**；
//! **老结构 = 挂到「图标层后面那个 WorkerW」**。
//!
//! 踩过的坑（都花过时间，别再试）：
//!   · `0x052C` 的 **wParam 必须是 0xD**。写 (0,0) 时 shell 静默无操作，
//!     只会在 Progman 里留一堆 135×37 的隐藏 WorkerW 残骸，壁纸层根本不出现。
//!   · 挂在 Progman 但压到**最底**（HWND_BOTTOM）会被壁纸盖住，什么都看不见；
//!     放在 **DefView 之上**又盖住图标。只有「DefView 之下、WorkerW 之上」这一条缝。
//!   · 挂在壁纸 WorkerW **里面**同样看不见（它自己的壁纸会盖住子窗口）。

use windows::core::{w, BOOL, PCWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, RECT, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, FindWindowExW, FindWindowW, GetClassNameW, GetClientRect, GetParent,
    GetSystemMetrics, GetWindowLongPtrW, SendMessageTimeoutW, SetParent, SetWindowLongPtrW,
    SetWindowPos, HWND_TOP, SMTO_NORMAL, SM_CXSCREEN, SM_CYSCREEN, SWP_NOACTIVATE, SWP_SHOWWINDOW,
    WINDOW_LONG_PTR_INDEX,
};

const GWL_STYLE: WINDOW_LONG_PTR_INDEX = WINDOW_LONG_PTR_INDEX(-16);
const WS_CHILD: isize = 0x4000_0000;
const WS_POPUP: isize = 0x8000_0000;

/// 嵌入结果：ok 决定是否退回 always_on_bottom，detail 用来落日志（类名/句柄/尺寸）。
pub struct Attach {
    pub ok: bool,
    pub detail: String,
}

impl Attach {
    fn fail(why: impl Into<String>) -> Self {
        Self { ok: false, detail: why.into() }
    }
}

fn class_of(h: HWND) -> String {
    let mut buf = [0u16; 64];
    let n = unsafe { GetClassNameW(h, &mut buf) } as usize;
    String::from_utf16_lossy(&buf[..n])
}

fn cls(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn child_of(parent: HWND, class: &[u16]) -> Option<HWND> {
    let h = unsafe { FindWindowExW(Some(parent), None, PCWSTR(class.as_ptr()), PCWSTR::null()) }.ok()?;
    if h.is_invalid() {
        None
    } else {
        Some(h)
    }
}

fn is_fullscreen(h: HWND) -> bool {
    let mut rc = RECT::default();
    if unsafe { GetClientRect(h, &mut rc) }.is_err() {
        return false;
    }
    rc.right - rc.left > 800 && rc.bottom - rc.top > 600
}

struct TopScan {
    /// 老结构里「含 SHELLDLL_DefView 的顶层 WorkerW」
    holder: HWND,
    /// 它之后（Z 序更下面）的第一个顶层 WorkerW = 壁纸宿主
    next_worker: HWND,
}

/// 老结构（24H2 之前）：图标层在某个顶层 WorkerW 里，壁纸宿主是它后面那个 WorkerW。
unsafe extern "system" fn enum_proc(top: HWND, lparam: LPARAM) -> BOOL {
    let s = &mut *(lparam.0 as *mut TopScan);
    let is_worker = class_of(top) == "WorkerW";
    if s.holder.is_invalid() && is_worker && child_of(top, &cls("SHELLDLL_DefView")).is_some() {
        s.holder = top;
    } else if !s.holder.is_invalid() && s.next_worker.is_invalid() && is_worker {
        s.next_worker = top;
        return BOOL(0);
    }
    BOOL(1)
}

/// 让 shell 生成壁纸层 WorkerW。**wParam 必须是 0xD**，否则无动作。
unsafe fn raise_desktop(progman: HWND) {
    for lp in [0, 1] {
        let _ = SendMessageTimeoutW(
            progman,
            0x052C,
            WPARAM(0xD),
            LPARAM(lp),
            SMTO_NORMAL,
            1000,
            None,
        );
    }
}

/// 嵌进桌面层。返回 ok=false 时调用方退回 always_on_bottom。
pub fn attach(hwnd: HWND) -> Attach {
    unsafe {
        let progman = match FindWindowW(w!("Progman"), PCWSTR::null()) {
            Ok(h) if !h.is_invalid() => h,
            _ => return Attach::fail("no-progman"),
        };
        let defview_cls = cls("SHELLDLL_DefView");
        let worker_cls = cls("WorkerW");

        // Win11 24H2：DefView 和 WorkerW 都是 Progman 的子窗口
        let mut defview = child_of(progman, &defview_cls);
        let mut worker = child_of(progman, &worker_cls).filter(|h| is_fullscreen(*h));

        // 首次运行时壁纸 WorkerW 还不存在 → 让 shell 播一层（幂等）
        if defview.is_some() && worker.is_none() {
            raise_desktop(progman);
            std::thread::sleep(std::time::Duration::from_millis(150));
            worker = child_of(progman, &worker_cls).filter(|h| is_fullscreen(*h));
            defview = child_of(progman, &defview_cls);
        }

        // 两条路径：24H2 = Progman + 插到 DefView 之后；老结构 = 图标层后面那个 WorkerW
        let (host, insert_after) = if let Some(dv) = defview {
            if worker.is_none() {
                return Attach::fail("no-wallpaper-worker-after-raise");
            }
            (progman, Some(dv))
        } else {
            let mut scan = TopScan { holder: HWND::default(), next_worker: HWND::default() };
            let _ = EnumWindows(Some(enum_proc), LPARAM(&mut scan as *mut TopScan as isize));
            if scan.holder.is_invalid() {
                return Attach::fail("no-defview");
            }
            let host = if scan.next_worker.is_invalid() { scan.holder } else { scan.next_worker };
            (host, None)
        };

        let mut rc = RECT::default();
        if GetClientRect(host, &mut rc).is_err() {
            return Attach::fail("GetClientRect fail");
        }
        let (wpx, hpx) = (rc.right - rc.left, rc.bottom - rc.top);

        // 关键：24H2 要插到 DefView **之后**（= DefView 之下、壁纸 WorkerW 之上）
        let after = insert_after.unwrap_or(HWND_TOP);

        /*
         * 做两遍，并且**每遍都把样式写回去**。
         *
         * tao 的 `WebviewWindow::show()` 会把窗口 flags 整体重刷（顶层窗口按 WS_POPUP + WS_VISIBLE
         * 重写样式），而它是在挂载**之后**调的（见 musicdesk_open）。只挂一次的结果就是：
         * SetParent 仍在（窗口列进了 Progman 的子窗口表），但 WS_CHILD 被抹掉 →
         * 它按弹窗自己画，Z 序跑到 SHELLDLL_DefView **前面**，把桌面图标整块盖住，
         * 双击图标当然没反应。日志里表现为 `child=false` 且排在第 [0] 位。
         *
         * 现在：写样式 → SetParent → **再写一次样式**（覆盖 show 的副作用）→ 定 Z 序，
         * 然后按「父窗口 == host 且 WS_CHILD 在」验收，不合格重来一遍。
         */
        let mut last = String::new();
        for attempt in 0..2 {
            let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
            SetWindowLongPtrW(hwnd, GWL_STYLE, (style & !WS_POPUP) | WS_CHILD);
            // 每一遍都重设父窗口：show() 有可能把窗口摘回顶层（父窗口变 NULL）
            if let Err(e) = SetParent(hwnd, Some(host)) {
                if attempt == 1 {
                    return Attach::fail(format!("SetParent fail {e}"));
                }
            }
            // show() 刷过样式的话，这一步把 WS_CHILD 抢回来
            let style2 = GetWindowLongPtrW(hwnd, GWL_STYLE);
            SetWindowLongPtrW(hwnd, GWL_STYLE, (style2 & !WS_POPUP) | WS_CHILD);
            let _ = SetWindowPos(hwnd, Some(after), 0, 0, wpx, hpx, SWP_NOACTIVATE | SWP_SHOWWINDOW);

            let parent = GetParent(hwnd).unwrap_or_default();
            let now = GetWindowLongPtrW(hwnd, GWL_STYLE);
            let parent_ok = !parent.is_invalid() && parent == host;
            let child_ok = (now & WS_CHILD) != 0;
            last = format!(
                "host={}({}) {}x{} parent={} child={} attempt={}",
                class_of(host),
                host.0 as isize,
                wpx,
                hpx,
                class_of(parent),
                if child_ok { 1 } else { 0 },
                attempt + 1,
            );
            if parent_ok && child_ok {
                return Attach { ok: true, detail: last };
            }
        }
        Attach { ok: false, detail: last }
    }
}

/// 从桌面层拔出来（音乐锁屏 / 全屏展示前调用）。
pub fn detach(hwnd: HWND) {
    unsafe {
        let parent = GetParent(hwnd).unwrap_or_default();
        if parent.is_invalid() {
            return; // 本来就是顶层窗口
        }
        let _ = SetParent(hwnd, None);
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        SetWindowLongPtrW(hwnd, GWL_STYLE, (style & !WS_CHILD) | WS_POPUP);
        let (sw, sh) = (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN));
        let _ = SetWindowPos(hwnd, Some(HWND_TOP), 0, 0, sw, sh, SWP_NOACTIVATE | SWP_SHOWWINDOW);
    }
}

pub fn is_attached(hwnd: HWND) -> bool {
    unsafe { !GetParent(hwnd).unwrap_or_default().is_invalid() }
}
