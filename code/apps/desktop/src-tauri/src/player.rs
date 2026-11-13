//! 原生播放引擎：rodio（内部 symphonia）解码输出。
//!
//! 设计要点：`rodio::OutputStream` 不是 Send，不能直接放进 Tauri 的 State。
//! 因此音频对象（OutputStream / Sink）活在一个专用线程里，外部只持有
//! `Player` 句柄（Send + Sync），通过 mpsc 发命令、通过共享原子量读状态。

use rodio::mixer::Mixer;
use rodio::{Decoder, OutputStreamBuilder, Sink, Source};
use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};
use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/* ------------------------------------------------------------------ */
/* 诊断日志                                                            */
/* ------------------------------------------------------------------ */

/// app.log 的绝对路径，由 lib.rs 启动时注入。
///
/// 打包版是 `windows_subsystem = "windows"`，没有控制台，`eprintln!` 写进虚空；
/// 而 seek 耗时、重拉流这类问题只能靠事后取证，所以这里统一落到同一个日志文件。
static LOG_PATH: OnceLock<std::path::PathBuf> = OnceLock::new();

pub fn set_log_path(p: std::path::PathBuf) {
    let _ = LOG_PATH.set(p);
}

fn log_line(line: &str) {
    use std::io::Write;
    let Some(p) = LOG_PATH.get() else {
        eprintln!("{line}");
        return;
    };
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(f, "[{ts}] {line}");
    }
}

/* ------------------------------------------------------------------ */
/* 音效：三段 EQ（低架 / 峰值 / 高架）+ 前置增益 + 软限幅               */
/* ------------------------------------------------------------------ */

use std::sync::atomic::AtomicU32;

/// f32 ↔ 原子量：参数要在音频线程（每个采样都在跑）和 UI 命令之间共享，
/// 用 Mutex 会在每个采样点锁一次，直接存 bit 模式完事。
fn f32_of(bits: u32) -> f32 {
    f32::from_bits(bits)
}
fn bits_of(v: f32) -> u32 {
    v.to_bits()
}

/// 音效参数。
/// 五段增益（dB）+ 前置增益 + 声道平衡 + 空间音效，和前端 `FX_BANDS_HZ` 一一对应。
/// 预设就是这几组数字，用户拖推子改的也是这些——自定义与预设天然是同一种东西。
pub struct FxParams {
    /// 五段增益（dB），频点见 `FX_BANDS_HZ`
    pub bands: [AtomicU32; 5],
    /// 前置增益（dB）：抬整体音量，配合软限幅用来「显得更响」
    pub pre: AtomicU32,
    /// 声道平衡：-1 全左 · 0 居中 · +1 全右
    pub balance: AtomicU32,
    /// 空间音效：0 关 · 1 3D 旋转 · 2 宽广 · 3 耳机增强 · 4 现场（与安卓一致）
    pub space: AtomicU32,
}

impl Default for FxParams {
    fn default() -> Self {
        Self {
            bands: std::array::from_fn(|_| AtomicU32::new(bits_of(0.0))),
            pre: AtomicU32::new(bits_of(0.0)),
            balance: AtomicU32::new(bits_of(0.0)),
            space: AtomicU32::new(0),
        }
    }
}

/// 五段的中心频率（Hz）。**必须与前端 `FX_BANDS_HZ` 一致**，否则同样的预设两端形状不同。
pub const FX_BANDS_HZ: [f32; 5] = [60.0, 230.0, 910.0, 3600.0, 14000.0];
/// 中间三段的 Q（首尾是架式滤波器，不用 Q）
const FX_MID_Q: f32 = 1.0;

/// 一个双二阶（Transposed Direct Form II）的单声道状态
#[derive(Clone, Copy, Default)]
struct BiquadState {
    z1: f32,
    z2: f32,
}

#[derive(Clone, Copy)]
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
}

impl Default for Biquad {
    fn default() -> Self {
        // 直通
        Self { b0: 1.0, b1: 0.0, b2: 0.0, a1: 0.0, a2: 0.0 }
    }
}

impl Biquad {
    /// RBJ cookbook 低架滤波器
    fn low_shelf(f0: f32, gain_db: f32, fs: f32) -> Self {
        if gain_db.abs() < 0.01 {
            return Self::default();
        }
        let a = 10f32.powf(gain_db / 40.0);
        let w0 = 2.0 * std::f32::consts::PI * (f0 / fs).clamp(1.0e-4, 0.49);
        let cw = w0.cos();
        let sw = w0.sin();
        let alpha = sw / 2.0 * (2.0_f32).sqrt(); // S = 1
        let sa = a.sqrt();
        let b0 = a * ((a + 1.0) - (a - 1.0) * cw + 2.0 * sa * alpha);
        let b1 = 2.0 * a * ((a - 1.0) - (a + 1.0) * cw);
        let b2 = a * ((a + 1.0) - (a - 1.0) * cw - 2.0 * sa * alpha);
        let a0 = (a + 1.0) + (a - 1.0) * cw + 2.0 * sa * alpha;
        let a1 = -2.0 * ((a - 1.0) + (a + 1.0) * cw);
        let a2 = (a + 1.0) + (a - 1.0) * cw - 2.0 * sa * alpha;
        Self { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
    }

    /// RBJ cookbook 高架滤波器
    fn high_shelf(f0: f32, gain_db: f32, fs: f32) -> Self {
        if gain_db.abs() < 0.01 {
            return Self::default();
        }
        let a = 10f32.powf(gain_db / 40.0);
        let w0 = 2.0 * std::f32::consts::PI * (f0 / fs).clamp(1.0e-4, 0.49);
        let cw = w0.cos();
        let sw = w0.sin();
        let alpha = sw / 2.0 * (2.0_f32).sqrt();
        let sa = a.sqrt();
        let b0 = a * ((a + 1.0) + (a - 1.0) * cw + 2.0 * sa * alpha);
        let b1 = -2.0 * a * ((a - 1.0) + (a + 1.0) * cw);
        let b2 = a * ((a + 1.0) + (a - 1.0) * cw - 2.0 * sa * alpha);
        let a0 = (a + 1.0) - (a - 1.0) * cw + 2.0 * sa * alpha;
        let a1 = 2.0 * ((a - 1.0) - (a + 1.0) * cw);
        let a2 = (a + 1.0) - (a - 1.0) * cw - 2.0 * sa * alpha;
        Self { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
    }

    /// RBJ cookbook 峰值滤波器
    fn peaking(f0: f32, gain_db: f32, q: f32, fs: f32) -> Self {
        if gain_db.abs() < 0.01 {
            return Self::default();
        }
        let a = 10f32.powf(gain_db / 40.0);
        let w0 = 2.0 * std::f32::consts::PI * (f0 / fs).clamp(1.0e-4, 0.49);
        let cw = w0.cos();
        let sw = w0.sin();
        let alpha = sw / (2.0 * q.max(0.1));
        let b0 = 1.0 + alpha * a;
        let b1 = -2.0 * cw;
        let b2 = 1.0 - alpha * a;
        let a0 = 1.0 + alpha / a;
        let a1 = -2.0 * cw;
        let a2 = 1.0 - alpha / a;
        Self { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
    }

    #[inline]
    fn tick(&self, x: f32, st: &mut BiquadState) -> f32 {
        let y = self.b0 * x + st.z1;
        st.z1 = self.b1 * x - self.a1 * y + st.z2;
        st.z2 = self.b2 * x - self.a2 * y;
        y
    }
}

/// 音效处理源：解码 → EQ → 空间音效 → 频谱取样 → 声卡。
/// 系数每 512 个采样刷一次（参数是原子的，不能每个采样都读）。
struct FxSource<S> {
    inner: S,
    params: Arc<FxParams>,
    sample_rate: u32,
    channels: u16,
    /// 每声道的五段滤波状态
    st: Vec<[BiquadState; 5]>,
    filters: [Biquad; 5],
    pre_gain: f32,
    /// 声道平衡：左右各一个增益（往哪边偏就把另一侧压下去）
    gain_l: f32,
    gain_r: f32,
    /// 增益平滑后的当前值（逐采样逼近目标，避免拖推子时的台阶声）
    pre_cur: f32,
    gl_cur: f32,
    gr_cur: f32,
    ramp_k: f32,
    /// 还没刷新系数的采样数
    countdown: u32,
    ch_idx: usize,
    flat: bool,
    /// 空间音效（0..4），以及它要用到的状态
    space: u8,
    prev_l: f32,
    prev_r: f32,
    ring_l: [f32; 192],
    ring_r: [f32; 192],
    ri: usize,
    lfo: f32,
    w_rot: f32,
    itd_max: i32,
    ear_d: i32,
    lp_l: f32,
    lp_r: f32,
    lp_a: f32,
    c_l: Vec<f32>,
    c_r: Vec<f32>,
    ci_l: usize,
    ci_r: usize,
    damp_l: f32,
    damp_r: f32,
    /// 每帧算一次的摆位（左右增益 + 双耳时差采样数）
    pan_gl: f32,
    pan_gr: f32,
    pan_d: i32,
}

impl<S: Source> FxSource<S> {
    fn new(inner: S, params: Arc<FxParams>) -> Self {
        let sample_rate = inner.sample_rate().max(8000);
        let channels = inner.channels().max(1);
        let fs = sample_rate as f32;
        Self {
            inner,
            params,
            sample_rate,
            channels,
            st: vec![[BiquadState::default(); 5]; channels as usize],
            filters: [Biquad::default(); 5],
            pre_gain: 1.0,
            gain_l: 1.0,
            gain_r: 1.0,
            pre_cur: 1.0,
            gl_cur: 1.0,
            gr_cur: 1.0,
            /* 12ms 到位：再快听得见「啪」，再慢推子拖尾 */
            ramp_k: 1.0 - (-1.0 / (0.012 * fs)).exp(),
            countdown: 0,
            ch_idx: 0,
            flat: true,
            space: 0,
            prev_l: 0.0,
            prev_r: 0.0,
            ring_l: [0.0; 192],
            ring_r: [0.0; 192],
            ri: 0,
            lfo: 0.0,
            /* 一圈约 12 秒，和安卓 `FxAudioProcessor` 同一个节奏 */
            w_rot: (std::f64::consts::PI * 2.0 * 0.085 / sample_rate as f64) as f32,
            itd_max: (fs * 0.0005).max(1.0) as i32,
            ear_d: (fs * 0.00032).max(1.0) as i32,
            lp_a: (1.0 - (-2.0 * std::f64::consts::PI * 700.0 / sample_rate as f64).exp()) as f32,
            lp_l: 0.0,
            lp_r: 0.0,
            c_l: vec![0.0; (fs * 0.023) as usize + 8],
            c_r: vec![0.0; (fs * 0.029) as usize + 8],
            ci_l: 0,
            ci_r: 0,
            damp_l: 0.0,
            damp_r: 0.0,
            pan_gl: 1.0,
            pan_gr: 1.0,
            pan_d: 0,
        }
    }

    fn refresh(&mut self) {
        let p = &self.params;
        let bands: [f32; 5] = std::array::from_fn(|i| f32_of(p.bands[i].load(Ordering::Relaxed)));
        let pre_db = f32_of(p.pre.load(Ordering::Relaxed));
        let bal = f32_of(p.balance.load(Ordering::Relaxed)).clamp(-1.0, 1.0);
        let sp = p.space.load(Ordering::Relaxed).min(4) as u8;

        self.flat = bands.iter().all(|b| b.abs() < 0.01)
            && pre_db.abs() < 0.01
            && bal.abs() < 0.001
            && sp == 0;

        let fs = self.sample_rate as f32;
        for i in 0..5 {
            self.filters[i] = match i {
                0 => Biquad::low_shelf(FX_BANDS_HZ[0], bands[i], fs),
                4 => Biquad::high_shelf(FX_BANDS_HZ[4], bands[i], fs),
                _ => Biquad::peaking(FX_BANDS_HZ[i], bands[i], FX_MID_Q, fs),
            };
        }
        self.pre_gain = 10f32.powf(pre_db / 20.0);
        /* 平衡：-1 全左（右声道归零）… +1 全右，居中时两侧都是 1 */
        self.gain_l = if bal <= 0.0 { 1.0 } else { 1.0 - bal };
        self.gain_r = if bal >= 0.0 { 1.0 } else { 1.0 + bal };

        /* 切换空间音效时清一次状态：不切的话每个 512 采样都清等于把滤波器
         * 瞬态重来一遍（每秒 86 次的「滋滋」声，老版本就踩过这个坑）。 */
        if sp != self.space {
            self.space = sp;
            self.ring_l.fill(0.0);
            self.ring_r.fill(0.0);
            self.c_l.fill(0.0);
            self.c_r.fill(0.0);
            self.ri = 0;
            self.ci_l = 0;
            self.ci_r = 0;
            self.damp_l = 0.0;
            self.damp_r = 0.0;
            self.lp_l = 0.0;
            self.lp_r = 0.0;
            self.lfo = 0.0;
        }
        self.countdown = 512;
    }

    /// 连续软限幅。
    ///
    /// 老版本写的是 `if x.abs() > 0.98 { x.tanh() }` —— tanh(0.98)≈0.753，
    /// 于是刚过 0.98 的采样会直接掉到 0.75，波形上是一道垂直台阶，
    /// 每次越过都多一批谐波，听感就是持续的「滋滋」电流声。
    /// 现在拐点 0.85，且值与一阶导都连续。
    #[inline]
    fn soft_clip(x: f32) -> f32 {
        const KNEE: f32 = 0.85;
        let a = x.abs();
        if a <= KNEE {
            return x;
        }
        let head = 1.0 - KNEE;
        let y = KNEE + head * ((a - KNEE) / head).tanh();
        if x < 0.0 {
            -y
        } else {
            y
        }
    }
}

impl<S: Source> Iterator for FxSource<S> {
    type Item = f32;
    fn next(&mut self) -> Option<f32> {
        let s = self.inner.next()?;
        if self.countdown == 0 {
            self.refresh();
        }
        self.countdown = self.countdown.saturating_sub(1);

        // rodio 0.21 起解码器输出就是 f32（-1..1），EQ 直通处理，不用再过 i16 量化
        // 声道指针必须无条件推进：放在 flat 提前返回之后，从「原声」切到某个预设的
        // 那个采样上左右声道会错位一格（听不出来，但没必要留着）
        let ch = self.ch_idx.min(self.st.len().saturating_sub(1));
        let last_ch = self.ch_idx + 1 >= self.channels.max(1) as usize;
        self.ch_idx = (self.ch_idx + 1) % self.channels.max(1) as usize;
        if self.flat {
            return Some(s);
        }

        /* 增益逐采样平滑：参数是每 512 采样刷一次的，直接乘上去就是一级一级的台阶，
         * 拖推子时是「咔哒」声。12ms 逼近目标，听不出延迟也听不出台阶。 */
        self.pre_cur += (self.pre_gain - self.pre_cur) * self.ramp_k;
        self.gl_cur += (self.gain_l - self.gl_cur) * self.ramp_k;
        self.gr_cur += (self.gain_r - self.gr_cur) * self.ramp_k;

        let mut x = s * self.pre_cur;
        /* 先拷出来：下面要可变借 self.st，同一轮里再去读 self.filters 会撞借用检查 */
        let filters = self.filters;
        let st = &mut self.st[ch];
        for i in 0..5 {
            x = filters[i].tick(x, &mut st[i]);
        }

        if self.space != 0 {
            x = self.space_sample(x, ch, last_ch);
        }

        x *= if ch % 2 == 0 { self.gl_cur } else { self.gr_cur };
        Some(Self::soft_clip(x))
    }
}

impl<S: Source> FxSource<S> {
    /// 空间音效：逐声道处理，但靠环缓冲拿到另一声道的历史。
    ///
    /// 迭代器一次只能交出一个采样（左、右、左、右…），拿不到「同一帧的两只耳朵」，
    /// 所以真正的双耳处理只能靠环缓冲：左声道写进去、右声道读它 1 个采样前的值。
    /// 22µs 的偏差在任何空间效果里都听不出来，换来的是不必把整条链路改成成帧处理。
    fn space_sample(&mut self, x: f32, ch: usize, last_ch: bool) -> f32 {
        let n = self.ring_l.len();
        let right = ch % 2 == 1;
        if right {
            self.ring_r[self.ri] = x;
        } else {
            self.ring_l[self.ri] = x;
        }

        let out = match self.space {
            /* 3D 旋转：等功率左右摆动 + 双耳时差 */
            1 => {
                if !right {
                    self.lfo += self.w_rot;
                    if self.lfo > std::f32::consts::TAU {
                        self.lfo -= std::f32::consts::TAU;
                    }
                    let s = self.lfo.sin();
                    let pan = 0.5 + 0.5 * s;
                    self.pan_gl = (pan * std::f32::consts::FRAC_PI_2).cos();
                    self.pan_gr = (pan * std::f32::consts::FRAC_PI_2).sin();
                    self.pan_d = ((0.5 - 0.5 * s) * self.itd_max as f32) as i32;
                    (0.45 + 0.55 * self.pan_gl) * x
                } else {
                    let d = (self.pan_d.max(1) as usize) % n;
                    let rd = self.ring_r[(self.ri + n - d) % n];
                    (0.45 + 0.55 * self.pan_gr) * rd
                }
            }
            /* 宽广环绕：Mid/Side 把侧信号拉大 */
            2 => {
                let other = if right { self.prev_l } else { self.prev_r };
                let m = (x + other) * 0.5;
                let sd = (x - other) * 0.5 * 1.75;
                if right {
                    m - sd
                } else {
                    m + sd
                }
            }
            /* 耳机增强：对侧串音 + 700Hz 低通 */
            3 => {
                let d = (self.ear_d.max(1) as usize) % n;
                if right {
                    let ld = self.ring_l[(self.ri + n - d) % n];
                    self.lp_r += (ld - self.lp_r) * self.lp_a;
                    0.92 * x + 0.30 * self.lp_r
                } else {
                    let rd = self.ring_r[(self.ri + n - d) % n];
                    self.lp_l += (rd - self.lp_l) * self.lp_a;
                    0.92 * x + 0.30 * self.lp_l
                }
            }
            /* 现场：左右两条不同长度的短梳状，做早期反射 */
            4 => {
                if right {
                    let y = self.c_r[self.ci_r];
                    self.damp_r = y * 0.55 + self.damp_r * 0.45;
                    self.c_r[self.ci_r] = x + self.damp_r * 0.52;
                    self.ci_r = (self.ci_r + 1) % self.c_r.len();
                    x + y * 0.32
                } else {
                    let y = self.c_l[self.ci_l];
                    self.damp_l = y * 0.55 + self.damp_l * 0.45;
                    self.c_l[self.ci_l] = x + self.damp_l * 0.52;
                    self.ci_l = (self.ci_l + 1) % self.c_l.len();
                    x + y * 0.32
                }
            }
            _ => x,
        };

        if right {
            self.prev_r = x;
        } else {
            self.prev_l = x;
        }
        if last_ch {
            self.ri = (self.ri + 1) % n;
        }
        out
    }
}

impl<S: Source> Source for FxSource<S> {
    fn current_span_len(&self) -> Option<usize> {
        self.inner.current_span_len()
    }
    fn channels(&self) -> u16 {
        self.inner.channels()
    }
    fn sample_rate(&self) -> u32 {
        self.inner.sample_rate()
    }
    fn total_duration(&self) -> Option<Duration> {
        self.inner.total_duration()
    }
    fn try_seek(&mut self, pos: Duration) -> Result<(), rodio::source::SeekError> {
        for s in self.st.iter_mut() {
            *s = [BiquadState::default(); 5];
        }
        self.ring_l.fill(0.0);
        self.ring_r.fill(0.0);
        self.c_l.fill(0.0);
        self.c_r.fill(0.0);
        self.ri = 0;
        self.ci_l = 0;
        self.ci_r = 0;
        self.damp_l = 0.0;
        self.damp_r = 0.0;
        self.lp_l = 0.0;
        self.lp_r = 0.0;
        self.prev_l = 0.0;
        self.prev_r = 0.0;
        self.ch_idx = 0;
        self.inner.try_seek(pos)
    }
}

/* ------------------------------------------------------------------ */
/* 频谱：在解码源上取样做 FFT                                          */
/* ------------------------------------------------------------------ */

/// 输出给前端的频段数量（对数分布，低频多、高频少，观感更接近常见播放器）
pub const SPECTRUM_BANDS: usize = 40;
const FFT_SIZE: usize = 2048;
const F_LO: f32 = 45.0;
const F_HI: f32 = 16000.0;

/// 频谱数据。
///
/// **不能用 Mutex**：写入方是 cpal 的实时音频回调，读取方是每帧都在跑的前端 IPC。
/// 一旦 UI 线程持锁时被调度出去（本机 `gpu-off=1` 走 WARP 软渲染，这种情况很频繁），
/// 音频回调就得在原地等锁——表现出来就是「放歌一顿一顿」。
/// 这里改成 40 个原子量：写和读都不阻塞对方，代价只是一次 Acquire/Release 都没有（Relaxed 足够，
/// 频谱本来就是「最近一次快照」，晚一帧无所谓）。
pub struct Spectrum {
    bands: [AtomicU32; SPECTRUM_BANDS],
}

impl Default for Spectrum {
    fn default() -> Self {
        Self { bands: std::array::from_fn(|_| AtomicU32::new(0)) }
    }
}

impl Spectrum {
    pub fn snapshot(&self) -> Vec<f32> {
        self.bands.iter().map(|b| f32::from_bits(b.load(Ordering::Relaxed))).collect()
    }
    fn store(&self, vals: &[f32]) {
        for (b, v) in self.bands.iter().zip(vals.iter()) {
            b.store(v.to_bits(), Ordering::Relaxed);
        }
    }
    fn clear(&self) {
        for b in self.bands.iter() {
            b.store(0.0f32.to_bits(), Ordering::Relaxed);
        }
    }
}

/// 透明包装解码源：原样转发采样，同时攒窗口算频谱
struct TapSource<S> {
    inner: S,
    spec: Arc<Spectrum>,
    fft: Arc<dyn Fft<f32>>,
    buf: Vec<f32>,
    scratch: Vec<Complex<f32>>,
    smooth: [f32; SPECTRUM_BANDS],
    sample_rate: u32,
    channels: u16,
    ch_idx: u16,
    acc: f32,
}

impl<S: Source> TapSource<S> {
    fn new(inner: S, spec: Arc<Spectrum>) -> Self {
        let mut planner = FftPlanner::<f32>::new();
        let sample_rate = inner.sample_rate();
        let channels = inner.channels().max(1);
        Self {
            inner,
            spec,
            fft: planner.plan_fft_forward(FFT_SIZE),
            buf: Vec::with_capacity(FFT_SIZE),
            scratch: vec![Complex::new(0.0, 0.0); FFT_SIZE],
            smooth: [0.0; SPECTRUM_BANDS],
            sample_rate: sample_rate.max(8000),
            channels,
            ch_idx: 0,
            acc: 0.0,
        }
    }

    fn analyze(&mut self) {
        let n = FFT_SIZE;
        for i in 0..n {
            // Hann 窗，减少频谱泄漏
            let w = 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / (n as f32 - 1.0)).cos();
            self.scratch[i] = Complex::new(self.buf[i] * w, 0.0);
        }
        self.fft.process(&mut self.scratch);

        let bin_hz = self.sample_rate as f32 / n as f32;
        let ratio = F_HI / F_LO;
        for b in 0..SPECTRUM_BANDS {
            let lo = F_LO * ratio.powf(b as f32 / SPECTRUM_BANDS as f32);
            let hi = F_LO * ratio.powf((b + 1) as f32 / SPECTRUM_BANDS as f32);
            let i0 = ((lo / bin_hz).floor() as usize).clamp(1, n / 2 - 1);
            let i1 = ((hi / bin_hz).ceil() as usize).clamp(i0 + 1, n / 2);

            let mut peak: f32 = 0.0;
            for i in i0..i1 {
                let m = self.scratch[i].norm() / (n / 2) as f32;
                if m > peak {
                    peak = m;
                }
            }
            // 转 dB 再映射到 0..1；高频略作补偿，避免整条只剩低频在动
            let db = 20.0 * (peak + 1e-7).log10();
            let tilt = 1.0 + (b as f32 / SPECTRUM_BANDS as f32) * 0.22;
            let v = (((db + 70.0) / 70.0) * tilt).clamp(0.0, 1.0);
            // 快起慢落，视觉上更像真实电平表
            self.smooth[b] = v.max(self.smooth[b] * 0.82);
        }

        let out = self.smooth;
        self.spec.store(&out);
    }
}

impl<S: Source> Iterator for TapSource<S> {
    type Item = f32;
    fn next(&mut self) -> Option<f32> {
        let s = self.inner.next()?;
        // rodio 0.21 起解码器输出 f32（-1..1），直接进 FFT
        self.acc += s;
        self.ch_idx += 1;
        if self.ch_idx >= self.channels {
            let mono = self.acc / self.channels as f32;
            self.acc = 0.0;
            self.ch_idx = 0;
            self.buf.push(mono);
            if self.buf.len() >= FFT_SIZE {
                self.analyze();
                self.buf.clear();
            }
        }
        Some(s)
    }
}

impl<S: Source> Source for TapSource<S> {
    fn current_span_len(&self) -> Option<usize> {
        self.inner.current_span_len()
    }
    fn channels(&self) -> u16 {
        self.inner.channels()
    }
    fn sample_rate(&self) -> u32 {
        self.inner.sample_rate()
    }
    fn total_duration(&self) -> Option<Duration> {
        self.inner.total_duration()
    }
    fn try_seek(&mut self, pos: Duration) -> Result<(), rodio::source::SeekError> {
        self.buf.clear();
        self.ch_idx = 0;
        self.acc = 0.0;
        self.inner.try_seek(pos)
    }
}

/* ------------------------------------------------------------------ */
/* 预取：把「解码 + 拉流」搬出音频回调                                  */
/* ------------------------------------------------------------------ */

/**
 * rodio 0.20 的解码发生在 **cpal 的输出回调里**（`mixer_rx.next()` 每个样本拉一次），
 * 也就是实时线程。在线曲目的 `HttpRangeReader` 每读到一个分片边界就同步发一次 HTTP 请求——
 * 于是每 512KB 就要在实时线程上等一次网络往返，听起来就是「一顿一顿」。
 *
 * 解法：中间插一层 `PrefetchSource`。它在**普通线程**里把样本解成块、塞进环形队列，
 * 实时线程只从内存里搬。这样网络抖动只会让缓冲变浅，不会把回调卡住。
 *
 * 几个数字：
 *   · 一块 4096 采样 ≈ 46ms（44.1k 立体声）
 *   · 最多 96 块 ≈ 4.4s 的抖动余量，约 780KB 内存
 *   · 起播先攒 8 块（≈370ms）或最多等 600ms，避免第一帧就欠载
 */
const PF_BLOCK: usize = 4096;
const PF_BLOCKS: usize = 96;
const PF_PRELOAD: usize = 8;
const PF_PRELOAD_MS: u64 = 600;
/**
 * 缓冲见底时，实时线程最多等这么久（一次）。
 * 以前这里等 500ms，还把超时累加判「流断了」——只要解码慢一点点，
 * 音频回调就被按住半秒，听感是「卡一下、顿一下」。实时线程宁可吐静音也不能等。
 */
const PF_WAIT_MS: u64 = 2;
/** 欠载后先用静音撑过这么多个采样，别让每个采样都去敲一次通道 */
const PF_HOLD: u32 = 192;
/** 连续欠载这么多轮（≈ 0.85s 静音）就认为流真断了，交给「曲终」逻辑 */
const PF_MAX_UNDERRUN: u32 = 300;
/** 欠载边界的淡出/淡入时长（秒）：太短仍有咔哒，太长会削掉正常起音 */
const PF_FADE_SECS: f32 = 0.006;

enum PfCmd {
    Seek(Duration),
}

struct PrefetchSource {
    rx: Receiver<(u64, Vec<f32>)>,
    cmd: Sender<PfCmd>,
    /// 当前轮次：seek 时 +1，worker 也用同一套编号，对不上的是 seek 前的残留块
    epoch: u64,
    queue: VecDeque<(u64, Vec<f32>)>,
    cur: Vec<f32>,
    idx: usize,
    sample_rate: u32,
    channels: u16,
    total: Option<Duration>,
    /// 连续欠载轮数（成功拿到一块就清零）
    starved: u32,
    /// >0 时直接吐静音，不去碰通道（欠载后的冷却采样数）
    hold: u32,
    /**
     * 增益斜坡 0..1 —— 欠载时淡出、恢复时淡入。
     *
     * 以前欠载直接从波形跳到 0.0：样本是「非零 → 0」的硬台阶，扬声器会「啪」一声；
     * 网络抖动频繁时就是一连串咔哒，听感被描述成「滋滋的电音」。
     * 斜坡只在欠载边界动手，正常播放时恒为 1，零额外开销。
     */
    ramp: f32,
    /// 斜坡每采样步进（约 6ms 走完）
    ramp_step: f32,
    /// 最后一个输出值：淡出期间按它衰减，而不是直接归零
    last: f32,
}

impl PrefetchSource {
    fn new<S>(mut inner: S) -> Self
    where
        S: Source + Send + 'static,
    {
        let sample_rate = inner.sample_rate().max(8000);
        let channels = inner.channels().max(1);
        let total = inner.total_duration();

        let (tx, rx) = mpsc::sync_channel::<(u64, Vec<f32>)>(PF_BLOCKS);
        let (cmd_tx, cmd_rx) = mpsc::channel::<PfCmd>();

        std::thread::Builder::new()
            .name("shuyin-decode".into())
            .spawn(move || {
                let mut epoch: u64 = 0;
                'outer: loop {
                    // 先收命令（非阻塞），seek 才不会被「队列已满」憋住
                    loop {
                        match cmd_rx.try_recv() {
                            Ok(PfCmd::Seek(pos)) => {
                                epoch += 1;
                                // 失败就继续从原位解，别把整首歌弄没了
                                let _ = inner.try_seek(pos);
                            }
                            Err(mpsc::TryRecvError::Empty) => break,
                            Err(mpsc::TryRecvError::Disconnected) => break 'outer,
                        }
                    }

                    let mut block: Vec<f32> = Vec::with_capacity(PF_BLOCK);
                    for _ in 0..PF_BLOCK {
                        match inner.next() {
                            Some(s) => block.push(s),
                            None => break,
                        }
                    }
                    if block.is_empty() {
                        break;
                    }
                    let ended = block.len() < PF_BLOCK;

                    // 逐块投递：队列满就小睡，顺便继续看命令通道
                    let mut item = Some((epoch, block));
                    loop {
                        match tx.try_send(item.take().expect("payload")) {
                            Ok(()) => break,
                            Err(mpsc::TrySendError::Full(v)) => {
                                item = Some(v);
                                std::thread::sleep(Duration::from_millis(4));
                                while let Ok(PfCmd::Seek(pos)) = cmd_rx.try_recv() {
                                    epoch += 1;
                                    let _ = inner.try_seek(pos);
                                }
                            }
                            Err(mpsc::TrySendError::Disconnected(_)) => break 'outer,
                        }
                    }
                    if ended {
                        break;
                    }
                }
            })
            .ok();

        let mut me = Self {
            rx,
            cmd: cmd_tx,
            epoch: 0,
            queue: VecDeque::new(),
            cur: Vec::new(),
            idx: 0,
            sample_rate,
            channels,
            total,
            starved: 0,
            hold: 0,
            ramp: 1.0,
            ramp_step: 1.0 / (sample_rate as f32 * PF_FADE_SECS).max(1.0),
            last: 0.0,
        };

        // 起播缓冲：攒够 8 块或到 600ms 就开始（本地文件基本立刻满）
        let deadline = Instant::now() + Duration::from_millis(PF_PRELOAD_MS);
        while me.queue.len() < PF_PRELOAD {
            let left = deadline.saturating_duration_since(Instant::now());
            match me.rx.recv_timeout(if left.is_zero() { Duration::from_millis(1) } else { left }) {
                Ok(v) => me.queue.push_back(v),
                Err(_) => break,
            }
        }
        me
    }
}

impl Iterator for PrefetchSource {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        // 欠载冷却期内不碰通道，只把上个样本按斜坡衰减掉——直接给 0 是硬台阶，会「啪」
        if self.hold > 0 {
            self.hold -= 1;
            self.ramp = (self.ramp - self.ramp_step).max(0.0);
            return Some(self.last * self.ramp);
        }
        loop {
            if self.idx < self.cur.len() {
                let s = self.cur[self.idx];
                self.idx += 1;
                // 从欠载恢复：几毫秒淡入，避免波形从 0 冷启动出爆音
                if self.ramp < 1.0 {
                    self.ramp = (self.ramp + self.ramp_step).min(1.0);
                    let v = s * self.ramp;
                    self.last = v;
                    return Some(v);
                }
                self.last = s;
                return Some(s);
            }
            self.cur.clear();
            self.idx = 0;

            let got = match self.queue.pop_front() {
                Some((ep, b)) => Some((ep, b)),
                None => match self.rx.try_recv() {
                    Ok(v) => Some(v),
                    Err(mpsc::TryRecvError::Disconnected) => return None,
                    Err(mpsc::TryRecvError::Empty) => {
                        // 只做一次极短的等待：网络抖动几毫秒时能接上，
                        // 真的没数据就吐静音，先把回调让出去
                        match self.rx.recv_timeout(Duration::from_millis(PF_WAIT_MS)) {
                            Ok(v) => Some(v),
                            Err(mpsc::RecvTimeoutError::Timeout) => None,
                            Err(mpsc::RecvTimeoutError::Disconnected) => return None,
                        }
                    }
                },
            };

            match got {
                Some((ep, b)) if ep == self.epoch => {
                    self.starved = 0;
                    self.cur = b;
                }
                // seek 之前的残留块：丢掉继续要下一块
                Some(_) => continue,
                None => {
                    self.starved += 1;
                    if self.starved > PF_MAX_UNDERRUN {
                        return None; // 真的断了
                    }
                    self.hold = PF_HOLD;
                    // 进入欠载：这一采样先按未衰减的斜坡吐出去，后面的 hold 分支持续降
                    return Some(self.last * self.ramp);
                }
            }
        }
    }
}

impl Source for PrefetchSource {
    fn current_span_len(&self) -> Option<usize> {
        None
    }
    fn channels(&self) -> u16 {
        self.channels
    }
    fn sample_rate(&self) -> u32 {
        self.sample_rate
    }
    fn total_duration(&self) -> Option<Duration> {
        self.total
    }
    fn try_seek(&mut self, pos: Duration) -> Result<(), rodio::source::SeekError> {
        // 丢掉已经缓冲的旧数据：worker 那边也会跟着换轮次，残留块会被序号挡掉
        self.queue.clear();
        self.cur.clear();
        self.idx = 0;
        self.starved = 0;
        self.hold = 0;
        // 跳到新位置后从静音淡入，避免接缝处的爆音
        self.ramp = 0.0;
        self.last = 0.0;
        self.epoch += 1;
        let _ = self.cmd.send(PfCmd::Seek(pos));
        Ok(())
    }
}

/// 播放源：本地文件，或在线曲目的直链（HTTP Range 流式读）
#[derive(Clone, Debug)]
pub enum TrackSrc {
    File(String),
    Url(String),
}
impl TrackSrc {
    fn as_str(&self) -> &str {
        match self {
            TrackSrc::File(s) | TrackSrc::Url(s) => s,
        }
    }
    fn is_remote(&self) -> bool {
        matches!(self, TrackSrc::Url(_))
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerSnapshot {
    pub playing: bool,
    pub position: f64,
    pub duration: f64,
    pub volume: f64,
    pub track_path: Option<String>,
    /// 在线曲目直链（本地播放时为 None）
    pub track_url: Option<String>,
    pub index: i64,
    /// 曲终（一次性，读取后复位）
    pub ended: bool,
    /// 正在执行 seek（见 `Shared::seeking`）。前端拿到 true 时不要用 position 回写进度条
    pub seeking: bool,
    /// 播放错误（一次性，读取后复位）：格式不支持 / 文件损坏 / 设备异常
    pub error: Option<String>,
    /// 在线曲目已缓冲到的秒数（本地曲目恒为 0）。进度条画淡色第二层用
    pub buffered: f64,
}

pub struct Shared {
    pub playing: AtomicBool,
    pub position_base: Mutex<f64>,
    pub started_at: Mutex<Option<Instant>>,
    /// **真正送进声卡的播放位置**（秒）+ 采样时刻。
    ///
    /// 为什么还要这一份：`started_at.elapsed()` 只说明「墙钟过了多久」，
    /// 而解码抖动、网络拉流、声卡缓冲都会让**听到的声音**落后于墙钟。
    /// 位置按墙钟走，歌词就会越走越慢（用户反馈「Windows 上正在唱的歌词总是慢一些」，
    /// 同一份前端代码在安卓上报的是播放器自己的渲染位置，所以没那么明显）。
    ///
    /// rodio 的 `Sink::get_pos()` 统计的是被输出回调**消费掉的样本数**，天然对齐声音。
    /// 音频线程每 150ms 采一次写进这里，两次之间按墙钟外推（播放是 1x 速度）。
    pub played: Mutex<(f64, Instant)>,
    pub duration: Mutex<f64>,
    pub volume: Mutex<f32>,
    pub track: Mutex<Option<String>>,
    /// 当前曲目是否在线直链（Seek 重载时要用不同的加载方式）
    pub remote: AtomicBool,
    pub index: AtomicUsize,
    pub ended: AtomicBool,
    /// seek 进行中。
    ///
    /// `Cmd::Seek` 要在音频线程里排队，处理前 `position_base` 还是旧值，
    /// 前端若把这个值回写到进度条，就会「先弹回原处、再跳到你点的地方」。
    /// 用这个标志让前端明确知道「现在的位置不可信」。
    pub seeking: AtomicBool,
    pub error: Mutex<Option<String>>,
    pub spectrum: Arc<Spectrum>,
    pub fx: Arc<FxParams>,
    /// 在线曲目：直链总字节数（0 = 本地或未知）
    pub buf_total: AtomicU64,
    /// 在线曲目：已取到的字节前沿（HttpRangeReader 的 Arc 把手）。
    /// load_remote 时会整体换把柄，用 Mutex 包一层（每 250ms 才读一次，锁开销可忽略）
    pub buf_fetched: Mutex<Arc<AtomicU64>>,
}

impl Default for Shared {
    fn default() -> Self {
        Self {
            playing: AtomicBool::new(false),
            position_base: Mutex::new(0.0),
            started_at: Mutex::new(None),
            played: Mutex::new((0.0, Instant::now())),
            duration: Mutex::new(0.0),
            volume: Mutex::new(0.8),
            track: Mutex::new(None),
            remote: AtomicBool::new(false),
            index: AtomicUsize::new(usize::MAX),
            ended: AtomicBool::new(false),
            seeking: AtomicBool::new(false),
            error: Mutex::new(None),
            spectrum: Arc::new(Spectrum::default()),
            fx: Arc::new(FxParams::default()),
            buf_total: AtomicU64::new(0),
            buf_fetched: Mutex::new(Arc::new(AtomicU64::new(0))),
        }
    }
}

enum Cmd {
    Play {
        src: TrackSrc,
        index: usize,
        duration_hint: f64,
        /// 从第几秒开始（恢复上次播放进度用）
        start_at: f64,
        /// 加载后是否立刻播放；false 时停在 start_at，等用户点播放
        autoplay: bool,
    },
    Pause,
    Resume,
    Stop,
    Seek(f64),
    SetVolume(f32),
}

pub struct Player {
    tx: Sender<Cmd>,
    pub shared: Arc<Shared>,
}

impl Player {
    pub fn new() -> Result<Player, String> {
        let shared = Arc::new(Shared::default());
        let (tx, rx) = mpsc::channel::<Cmd>();
        let sh = shared.clone();

        std::thread::spawn(move || {
            let mut stream = match OutputStreamBuilder::open_default_stream() {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("音频输出初始化失败：{e}");
                    return;
                }
            };
            // stream 必须活在线程内；drop 日志别往 stderr 刷（后台应用看着像出错）
            stream.log_on_drop(false);
            // 输出配置写日志：远程桌面/虚拟声卡下出现杂音时，先看这里的采样率/声道/缓冲
            {
                let c = stream.config();
                eprintln!(
                    "[audio] 输出 {}Hz {}ch {:?} buffer={:?}",
                    c.sample_rate(),
                    c.channel_count(),
                    c.sample_format(),
                    c.buffer_size()
                );
            }
            // Mixer 是 Arc 克隆体，可以随意传给 load/load_remote
            let mixer = stream.mixer().clone();
            let mut sink: Option<Sink> = None;
            let mut last_tick = Instant::now();
            /* 位置对齐诊断：SHUYIN_POS_LOG=1 时每 2s 记一行「声卡位置 vs 墙钟」，
               用来判断歌词慢是「声卡真的落后」还是「前端渲染慢」。平时不开。 */
            let pos_log = std::env::var("SHUYIN_POS_LOG").is_ok();
            let mut pos_log_at = Instant::now();

            loop {
                match rx.recv_timeout(Duration::from_millis(200)) {
                    Ok(Cmd::Play { src, index, duration_hint, start_at, autoplay }) => {
                        let path = src.as_str().to_string();
                        let remote = src.is_remote();
                        sh.seeking.store(false, Ordering::SeqCst);
                        if let Some(s) = sink.take() {
                            s.stop();
                        }
                        sh.playing.store(false, Ordering::SeqCst);
                        sh.ended.store(false, Ordering::SeqCst);
                        sh.spectrum.clear();
                        // 缓冲进度归零：在线曲目由 load_remote 重新填
                        sh.buf_total.store(0, Ordering::SeqCst);
                        sh.buf_fetched.lock().unwrap_or_else(|e| e.into_inner()).store(0, Ordering::SeqCst);
                        // 畸形/不支持的文件可能让解码器 panic：隔离，避免拖垮音频线程与进程
                        let loaded = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            match &src {
                                TrackSrc::File(p) => load(&mixer, p, &sh, duration_hint),
                                TrackSrc::Url(u) => load_remote(&mixer, u, &sh, duration_hint),
                            }
                        }));
                        let failed: Option<String> = match loaded {
                            Ok(Ok(s)) => {
                                sh.index.store(index, Ordering::SeqCst);
                                sh.remote.store(remote, Ordering::SeqCst);
                                *sh.track.lock().unwrap_or_else(|e| e.into_inner()) = Some(path.clone());

                                // 恢复上次进度：先 seek 再决定播/停。
                                // seek 失败（容器不支持随机定位）就老实从头开始，
                                // 避免界面显示 2:31 实际从 0:00 出声。
                                let dur = *sh.duration.lock().unwrap_or_else(|e| e.into_inner());
                                let mut start = start_at.max(0.0);
                                if dur > 0.0 {
                                    start = start.min((dur - 1.0).max(0.0));
                                }
                                // 先按住再 seek。
                                //
                                // 预取线程在 attach 的时候就已经把「第 0 秒」的前几块解出来了，
                                // sink 默认是播着的——不按一下，恢复进度时会先响一下开头再跳到目标位置。
                                // 暂停 → seek → 再按需播放，这一段就听不出来了。
                                s.pause();
                                if start > 0.5 {
                                    if s.try_seek(Duration::from_secs_f64(start)).is_err() {
                                        start = 0.0;
                                        let _ = s.try_seek(Duration::ZERO);
                                    }
                                }
                                *sh.position_base.lock().unwrap_or_else(|e| e.into_inner()) = start;
                                /* 换歌：把「声卡位置」也归到起点，否则新歌开头会先报上一首的位置 */
                                *sh.played.lock().unwrap_or_else(|e| e.into_inner()) = (start, Instant::now());
                                if autoplay {
                                    s.play();
                                    *sh.started_at.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
                                    sh.playing.store(true, Ordering::SeqCst);
                                } else {
                                    *sh.started_at.lock().unwrap_or_else(|e| e.into_inner()) = None;
                                    sh.playing.store(false, Ordering::SeqCst);
                                    sh.spectrum.clear();
                                }
                                sink = Some(s);
                                None
                            }
                            Ok(Err(e)) => Some(e),
                            Err(_) => Some("解码该文件时发生异常，文件可能已损坏".to_string()),
                        };
                        if let Some(msg) = failed {
                            eprintln!("播放失败 {path}: {msg}");
                            *sh.track.lock().unwrap_or_else(|e| e.into_inner()) = None;
                            sh.remote.store(false, Ordering::SeqCst);
                            sh.index.store(usize::MAX, Ordering::SeqCst);
                            // 通知前端：本地文件提示后自动跳下一首；在线曲目只提示、不跳（见 PlayerProvider）
                            let text = if remote {
                                // 这里**不能**说「暂无版权」：取链已经成功了，挂的是拉流/解码，
                                // 两者是完全不同的问题，提示混在一起会让用户跑去反复换源
                                format!("在线曲目加载失败：{msg}")
                            } else {
                                format!("无法播放「{}」：{msg}", short_name(&path))
                            };
                            *sh.error.lock().unwrap_or_else(|e| e.into_inner()) = Some(text);
                        }
                    }
                    Ok(Cmd::Pause) => {
                        if let Some(s) = sink.as_ref() {
                            s.pause();
                        }
                        let pos = current_position(&sh);
                        *sh.position_base.lock().unwrap_or_else(|e| e.into_inner()) = pos;
                        *sh.played.lock().unwrap_or_else(|e| e.into_inner()) = (pos, Instant::now());
                        *sh.started_at.lock().unwrap_or_else(|e| e.into_inner()) = None;
                        sh.playing.store(false, Ordering::SeqCst);
                        sh.spectrum.clear();
                    }
                    Ok(Cmd::Resume) => {
                        if let Some(s) = sink.as_ref() {
                            s.play();
                            *sh.started_at.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
                            sh.playing.store(true, Ordering::SeqCst);
                        }
                    }
                    Ok(Cmd::Stop) => {
                        if let Some(s) = sink.take() {
                            s.stop();
                        }
                        *sh.position_base.lock().unwrap_or_else(|e| e.into_inner()) = 0.0;
                        *sh.played.lock().unwrap_or_else(|e| e.into_inner()) = (0.0, Instant::now());
                        *sh.started_at.lock().unwrap_or_else(|e| e.into_inner()) = None;
                        *sh.duration.lock().unwrap_or_else(|e| e.into_inner()) = 0.0;
                        *sh.track.lock().unwrap_or_else(|e| e.into_inner()) = None;
                        sh.index.store(usize::MAX, Ordering::SeqCst);
                        sh.playing.store(false, Ordering::SeqCst);
                        sh.ended.store(false, Ordering::SeqCst);
                        sh.seeking.store(false, Ordering::SeqCst);
                        sh.spectrum.clear();
                    }
                    Ok(Cmd::Seek(secs)) => {
                        // 计时：拖动/点进度条到出声之间到底花了多久，日志里能直接看到
                        let seek_t0 = Instant::now();
                        let dur = *sh.duration.lock().unwrap_or_else(|e| e.into_inner());
                        let target = secs.clamp(0.0, if dur > 0.0 { dur } else { secs.max(0.0) });
                        sh.seeking.store(true, Ordering::SeqCst);
                        let mut done = false;
                        let mut reloaded = false;
                        if let Some(s) = sink.as_ref() {
                            if s.try_seek(Duration::from_secs_f64(target)).is_ok() {
                                done = true;
                            }
                        }
                        if !done {
                            reloaded = true;
                            // 兜底：按目标位置重开解码器（在线曲目就重新拉流）
                            if let Some(path) = sh.track.lock().unwrap_or_else(|e| e.into_inner()).clone() {
                                if let Some(old) = sink.take() {
                                    old.stop();
                                }
                                let remote = sh.remote.load(Ordering::SeqCst);
                                let reloaded = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                    if remote {
                                        load_remote(&mixer, &path, &sh, dur)
                                    } else {
                                        load(&mixer, &path, &sh, dur)
                                    }
                                }));
                                if let Ok(Ok(s)) = reloaded {
                                    let _ = s.try_seek(Duration::from_secs_f64(target));
                                    if !sh.playing.load(Ordering::SeqCst) {
                                        s.pause();
                                    }
                                    sink = Some(s);
                                }
                            }
                        }
                        *sh.position_base.lock().unwrap_or_else(|e| e.into_inner()) = target;
                        /* seek 之后 Sink 内部位置已经跳到 target，这里同步一份，
                           免得两次采样之间的快照还报旧值 */
                        *sh.played.lock().unwrap_or_else(|e| e.into_inner()) = (target, Instant::now());
                        if sh.playing.load(Ordering::SeqCst) {
                            *sh.started_at.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
                        }
                        sh.seeking.store(false, Ordering::SeqCst);
                        log_line(&format!(
                            "seek {target:.2}s ok={done} reload={reloaded} remote={} {}ms",
                            sh.remote.load(Ordering::SeqCst),
                            seek_t0.elapsed().as_millis()
                        ));
                    }
                    Ok(Cmd::SetVolume(v)) => {
                        let c = v.clamp(0.0, 1.0);
                        *sh.volume.lock().unwrap_or_else(|e| e.into_inner()) = c;
                        if let Some(s) = sink.as_ref() {
                            s.set_volume(c);
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }

                // 曲终检测（~150ms 粒度）：声明在播但 sink 已放空
                // 顺带采样「声卡位置」——歌词、进度条都以它为准（见 Shared::played）
                if last_tick.elapsed() >= Duration::from_millis(150) {
                    last_tick = Instant::now();
                    let playing = sh.playing.load(Ordering::SeqCst);
                    /* 墙钟位置：只在「声卡计数不可信」时兜底用 */
                    let wall = {
                        let b = *sh.position_base.lock().unwrap_or_else(|e| e.into_inner());
                        match *sh.started_at.lock().unwrap_or_else(|e| e.into_inner()) {
                            Some(t) => b + t.elapsed().as_secs_f64(),
                            None => b,
                        }
                    };
                    if playing {
                        if let Some(s) = sink.as_ref() {
                            let p = s.get_pos().as_secs_f64();
                            /* 两道闸：
                               · get_pos 在 stop/skip 后会归零；
                               · seek 走「重开解码器」兜底时，新 sink 的计数从 0 起，
                                 跟目标位置差着几秒甚至几分钟。
                               和墙钟差超过 5s 就认为这个计数没跟上，退回墙钟（=旧行为）。 */
                            let p = if p >= 0.0 && (p - wall).abs() <= 5.0 { p } else { wall };
                            *sh.played.lock().unwrap_or_else(|e| e.into_inner()) = (p, Instant::now());
                        }
                    }
                    if pos_log && pos_log_at.elapsed() >= Duration::from_millis(2000) {
                        pos_log_at = Instant::now();
                        let (p, _) = *sh.played.lock().unwrap_or_else(|e| e.into_inner());
                        log_line(&format!("pos played={p:.3} wall={wall:.3} diff={:.3}", p - wall));
                    }
                    let empty = sink.as_ref().map(|s| s.empty()).unwrap_or(true);
                    if playing && empty {
                        sh.playing.store(false, Ordering::SeqCst);
                        sh.spectrum.clear();
                        let dur = *sh.duration.lock().unwrap_or_else(|e| e.into_inner());
                        *sh.position_base.lock().unwrap_or_else(|e| e.into_inner()) = dur;
                        *sh.played.lock().unwrap_or_else(|e| e.into_inner()) = (dur, Instant::now());
                        *sh.started_at.lock().unwrap_or_else(|e| e.into_inner()) = None;
                        sh.ended.store(true, Ordering::SeqCst);
                    }
                }
            }
        });

        Ok(Player { tx, shared })
    }

    pub fn play(&self, path: &str, index: usize, duration_hint: f64) -> Result<(), String> {
        self.play_from(path, index, duration_hint, 0.0, true)
    }

    /// 从指定位置加载；autoplay=false 时停在 start_at（恢复上次播放状态用）
    pub fn play_from(
        &self,
        path: &str,
        index: usize,
        duration_hint: f64,
        start_at: f64,
        autoplay: bool,
    ) -> Result<(), String> {
        self.send_play(TrackSrc::File(path.to_string()), index, duration_hint, start_at, autoplay)
    }

    /// 在线曲目：直链流式播放（HTTP Range，可拖进度）
    pub fn play_url(
        &self,
        url: &str,
        index: usize,
        duration_hint: f64,
        start_at: f64,
        autoplay: bool,
    ) -> Result<(), String> {
        self.send_play(TrackSrc::Url(url.to_string()), index, duration_hint, start_at, autoplay)
    }

    fn send_play(
        &self,
        src: TrackSrc,
        index: usize,
        duration_hint: f64,
        start_at: f64,
        autoplay: bool,
    ) -> Result<(), String> {
        self.tx
            .send(Cmd::Play { src, index, duration_hint, start_at, autoplay })
            .map_err(|e| e.to_string())
    }
    pub fn pause(&self) {
        let _ = self.tx.send(Cmd::Pause);
    }
    pub fn resume(&self) {
        let _ = self.tx.send(Cmd::Resume);
    }
    pub fn stop(&self) {
        let _ = self.tx.send(Cmd::Stop);
    }
    pub fn seek(&self, secs: f64) {
        // 在**下发之前**置位：命令还在通道里排队的那段时间里，位置同样不可信
        self.shared.seeking.store(true, Ordering::SeqCst);
        let _ = self.tx.send(Cmd::Seek(secs));
    }
    /// 音效参数：直接写原子量，音频线程下一批采样就会用上（不用重载当前曲目）
    pub fn set_fx(&self, bands: [f32; 5], pre: f32, balance: f32, space: u32) {
        let p = &self.shared.fx;
        for i in 0..5 {
            p.bands[i].store(bands[i].clamp(-12.0, 12.0).to_bits(), Ordering::Relaxed);
        }
        p.pre.store(pre.clamp(-12.0, 12.0).to_bits(), Ordering::Relaxed);
        p.balance
            .store(balance.clamp(-1.0, 1.0).to_bits(), Ordering::Relaxed);
        p.space.store(space.min(4), Ordering::Relaxed);
    }

    pub fn set_volume(&self, v: f32) {
        let _ = self.tx.send(Cmd::SetVolume(v));
    }

    /// 当前频谱（40 个频段，0..1）
    pub fn spectrum(&self) -> Vec<f32> {
        self.shared.spectrum.snapshot()
    }

    pub fn snapshot(&self) -> PlayerSnapshot {
        let sh = &self.shared;
        let remote = sh.remote.load(Ordering::SeqCst);
        let track = sh.track.lock().unwrap_or_else(|e| e.into_inner()).clone();
        // 在线曲目的「已缓冲」秒数：字节前沿 / 总字节 × 时长。
        // total 未知或本地曲目时恒为 0，前端不画第二层。
        let total = sh.buf_total.load(Ordering::Relaxed);
        let fetched = sh.buf_fetched.lock().unwrap_or_else(|e| e.into_inner()).load(Ordering::Relaxed).min(total);
        let dur = *sh.duration.lock().unwrap_or_else(|e| e.into_inner());
        let buffered = if remote && total > 0 && dur > 0.0 {
            (fetched as f64 / total as f64 * dur).clamp(0.0, dur)
        } else {
            0.0
        };
        PlayerSnapshot {
            playing: sh.playing.load(Ordering::SeqCst),
            position: current_position(sh),
            duration: dur,
            volume: *sh.volume.lock().unwrap_or_else(|e| e.into_inner()) as f64,
            // 前端用 trackPath 反查本地曲目：在线曲目必须留空，否则会匹配不到、把队列当成空的
            track_path: if remote { None } else { track.clone() },
            track_url: if remote { track } else { None },
            index: sh.index.load(Ordering::SeqCst) as i64,
            ended: sh.ended.swap(false, Ordering::SeqCst),
            seeking: sh.seeking.load(Ordering::SeqCst),
            error: sh.error.lock().unwrap_or_else(|e| e.into_inner()).take(),
            buffered,
        }
    }
}

/// 取文件名（错误提示里不暴露完整路径）
fn short_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(path)
        .to_string()
}

fn current_position(sh: &Shared) -> f64 {
    let base = *sh.position_base.lock().unwrap_or_else(|e| e.into_inner());
    let started = *sh.started_at.lock().unwrap_or_else(|e| e.into_inner());
    let dur = *sh.duration.lock().unwrap_or_else(|e| e.into_inner());
    let (played, at) = *sh.played.lock().unwrap_or_else(|e| e.into_inner());
    let pos = match started {
        /*
         * 播放中：以「声卡消费到哪儿」为准，两次采样之间按墙钟外推。
         * 外推上限 0.4s 只是防呆——音频线程 150ms 就会重新采一次，
         * 真卡住（网络断流）时不该让歌词继续往前跑。
         */
        Some(_) if sh.playing.load(Ordering::SeqCst) => {
            played + at.elapsed().as_secs_f64().min(0.4)
        }
        _ => base,
    };
    if dur > 0.0 { pos.min(dur) } else { pos }
}

/// 把解码源接上音效 / 频谱并且定好起点。本地与在线共用这一段。
/// catch_unwind 捕到的 panic 载荷 → 可读文本
fn panic_detail(p: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = p.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = p.downcast_ref::<String>() {
        s.clone()
    } else {
        "未知 panic".to_string()
    }
}

fn attach<S>(mixer: &Mixer, decoder: S, sh: &Shared, duration: f64) -> Result<Sink, String>
where
    S: Source + Send + 'static,
{
    /*
     * 平台给的 hint 只能当兜底：没版权 / VIP 的歌，平台只回一段 30 秒试听，
     * hint 却照旧报 4:03 —— 界面按 4 分钟画进度条，播到 30 秒就「莫名其妙结束」。
     * 解码器自己报的长度才是这条音频的真身，明显短于 hint 时采信它，
     * 前端据此发现「只拿到试听」并换平台（2026-11-01 用户反馈）。
     *
     * 只在差得离谱时才覆盖：正常歌平台标 3:58、实际 4:01 这种小出入仍用 hint，
     * 免得进度条总长跟着解码器的估算跳。
     */
    let real = decoder.total_duration().map(|d| d.as_secs_f64()).filter(|d| *d > 1.0);
    let duration = match real {
        Some(d) if duration <= 0.0 || (d < duration * 0.7 && duration - d > 20.0) => d,
        _ => duration,
    };

    let sink = Sink::connect_new(mixer);
    sink.set_volume(*sh.volume.lock().unwrap_or_else(|e| e.into_inner()));
    // 链路：解码（后台线程预取）→ 音效 EQ → 频谱取样 → 声卡。
    // 频谱放在 EQ 之后，看到的才是「实际听到的声音」（调低音时低频条真的会动得更多）
    let fx = FxSource::new(PrefetchSource::new(decoder), sh.fx.clone());
    sink.append(TapSource::new(fx, sh.spectrum.clone()));

    *sh.duration.lock().unwrap_or_else(|e| e.into_inner()) = duration;
    *sh.position_base.lock().unwrap_or_else(|e| e.into_inner()) = 0.0;
    *sh.started_at.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
    Ok(sink)
}

/// 创建 sink 并挂上解码源；时长优先用 lofty 探测
fn load(
    mixer: &Mixer,
    path: &str,
    sh: &Shared,
    duration_hint: f64,
) -> Result<Sink, String> {
    use lofty::file::AudioFile;

    let p = Path::new(path);
    let file = std::fs::File::open(p).map_err(|e| format!("打开文件失败：{e}"))?;

    let duration = lofty::probe::Probe::open(p)
        .ok()
        .and_then(|probe| probe.read().ok())
        .map(|f: lofty::file::TaggedFile| f.properties().duration().as_secs_f64())
        .filter(|d| *d > 0.0)
        .unwrap_or(duration_hint);

    // rodio/symphonia 遇到畸形文件会直接 panic（unreachable!），
    // 不能让它把播放线程带走——这里兜住，按"文件损坏"提示用户
    let file_len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let decoder = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        // byte_len 必须透传：symphonia 的 isomp4 demuxer 在 try_new 里强制要求
        // MediaSourceStream 报告长度，缺了会报 SeekError(Unseekable) → rodio panic
        let mut b = Decoder::builder().with_data(file);
        if file_len > 0 {
            b = b.with_byte_len(file_len);
        }
        b.build()
    })) {
        Ok(Ok(d)) => d,
        Ok(Err(e)) => return Err(format!("解码器初始化失败：{e}")),
        Err(_) => return Err("这首歌的文件似乎已损坏，解码器无法初始化".to_string()),
    };
    attach(mixer, decoder, sh, duration)
}

/// 在线曲目：HTTP Range 流式解码。
///
/// 时长只能用前端从平台结果里带过来的 `duration_hint`（搜索/歌单接口都给秒数），
/// 远端文件不先下完是拿不到权威时长的；拿不到就让它是 0，进度条按未知处理。
fn load_remote(
    mixer: &Mixer,
    url: &str,
    sh: &Shared,
    duration_hint: f64,
) -> Result<Sink, String> {
    let reader = crate::net::HttpRangeReader::open(url)
        .map_err(|e| format!("拉流失败：{e}"))?;
    let duration = if duration_hint > 0.0 { duration_hint } else { 0.0 };

    // 缓冲进度条要用的两个数：总字节 + 已取字节前沿（reader 被 decoder 接管后仍持续更新）
    sh.buf_total
        .store(reader.byte_len(), std::sync::atomic::Ordering::Relaxed);
    *sh.buf_fetched.lock().unwrap_or_else(|e| e.into_inner()) = reader.fetched_handle();

    // 失败取证：解码器给的报错往往只有一句「unsupported」，用户没法判断是谁的锅。
    // 先把 Content-Type 和内容开头的字节记下来——是 HTML 错误页、JSON、还是真音频一眼可辨。
    let ct = reader.content_type().to_string();
    let mut sniff_note = String::new();
    {
        use std::io::{Read as _, Seek as _, SeekFrom};
        let mut r = reader;
        let mut head = [0u8; 16];
        if let Ok(n) = r.read(&mut head) {
            if n > 0 {
                let _ = r.seek(SeekFrom::Start(0)); // 拨回开头，解码器看到的仍是完整流
                let hex: Vec<String> = head[..n].iter().map(|b| format!("{b:02X}")).collect();
                sniff_note = format!("type={ct} head={}", hex.join(" "));
            }
        }
        load_remote_inner(mixer, r, sh, duration, &sniff_note)
    }
}

fn load_remote_inner(
    mixer: &Mixer,
    reader: crate::net::HttpRangeReader,
    sh: &Shared,
    duration: f64,
    sniff_note: &str,
) -> Result<Sink, String> {
    // byte_len 必须透传：symphonia 的 isomp4 demuxer 在 try_new 里强制要求
    // MediaSourceStream 报告长度，缺了会报 SeekError(Unseekable) → rodio panic
    //（kuwo 的稻香等 M4A 就是这么炸的，rodio 0.20 的 ReadSeekSource 不透传）
    let total = reader.byte_len();
    let ct = reader.content_type().to_string();
    let decoder =
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            let mut b = Decoder::builder().with_data(reader);
            if total > 0 {
                b = b.with_byte_len(total);
            }
            if !ct.is_empty() && ct.starts_with("audio/") {
                b = b.with_mime_type(&ct);
            }
            b.build()
        })) {
            Ok(Ok(d)) => d,
            Ok(Err(e)) => {
                return Err(format!("解码失败（可能不是音频文件）：{e} [{sniff_note}]"))
            }
            Err(x) => {
                let detail = panic_detail(x.as_ref());
                return Err(format!("解码器异常退出：{detail} [{sniff_note}]"));
            }
        };
    attach(mixer, decoder, sh, duration)
}
