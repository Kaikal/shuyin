//! 封面小图：给「系统媒体卡（锁屏 / 控制中心）」和「灵动岛」用。
//!
//! 为什么需要这一层：原生自己接下一首（后台 JS 已经冻住）时，手里只有封面
//! **网址**，而两个消费方要的东西各不相同——
//!   · `MPMediaItemArtwork` 只吃内存里的图 / 本地文件，**不认 http**；
//!   · Live Activity 的 ContentState 只放得下 4KB，必须是一张 72×72 的小 JPEG
//!     （扩展进程没有网络预算，锁屏刷新时现拉一定是空一块）。
//!
//! 以前这两条路都拿不到图：`smtc::artwork()` 见到 `://` 直接放弃，灵动岛那边
//! 只有前端压好的 base64（前端一冻就没人给了）——用户看到的就是
//! 「切歌后专辑图不出现，得等打开 App」。
//!
//! 所以这里做三件事：下载（或直接读本地缓存文件）→ 存一份到临时目录给
//! `MPMediaItemArtwork` → 缩成 72×72 的 JPEG base64 给灵动岛。
//!
//! 缓存按封面地址记，一首歌只下载一次（同一张封面在列表里被反复问到）。

use std::collections::HashMap;
use std::io::Read;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// 72×72 JPEG 的 base64 上限（ContentState 只有 4KB，留 1KB 给歌名/歌词）
const B64_MAX: usize = 3000;
/// 封面不能超过这么大，否则不像是封面（也防着被塞一个音频文件）
const MAX_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone)]
pub struct Art {
    /// 原图落在磁盘上的路径（`MPMediaItemArtwork` 吃这个）
    pub path: String,
    /// 72×72 JPEG 的 base64，不含 `data:` 前缀（灵动岛 ContentState 用）。
    /// 解码失败时是空串，调用方按「没有封面」处理。
    pub b64: String,
}

static MEMO: OnceLock<Mutex<HashMap<String, Option<Art>>>> = OnceLock::new();

fn memo() -> &'static Mutex<HashMap<String, Option<Art>>> {
    MEMO.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 把封面地址（本地路径或 http(s) 网址）变成可用的图。
///
/// 失败返回 None——调用方该继续往下走，不能因为一张封面卡住播放。
pub fn resolve(cover: &str) -> Option<Art> {
    let cover = cover.trim();
    if cover.is_empty() {
        return None;
    }
    if let Ok(g) = memo().lock() {
        if let Some(hit) = g.get(cover) {
            return hit.clone();
        }
    }
    let art = build(cover);
    if let Ok(mut g) = memo().lock() {
        /* 只记成功的和「明确的本地文件缺失」；网络失败不记，下次还能重试 */
        if art.is_some() || !is_remote(cover) {
            g.insert(cover.to_string(), art.clone());
        }
        /* 别让这张表无限长（一张封面 ≈ 一个路径 + 3KB 字符串） */
        if g.len() > 256 {
            g.clear();
        }
    }
    art
}

fn is_remote(s: &str) -> bool {
    s.starts_with("http://") || s.starts_with("https://")
}

/// 只看**已经在本地**的那一份，绝不下载。
///
/// 给 `MPMediaItemArtwork` 那条同步路径用：系统卡片的 meta 是在命令线程上
/// 直接应用的，那里不能等一次网络。命中（我们之前接过这首、图已经落盘）
/// 就有封面，没命中就维持现状——不丢图，也不卡界面。
pub fn lookup(cover: &str) -> Option<Art> {
    let cover = cover.trim();
    if cover.is_empty() {
        return None;
    }
    if let Ok(g) = memo().lock() {
        if let Some(hit) = g.get(cover) {
            return hit.clone();
        }
    }
    if !is_remote(cover) {
        return resolve(cover);
    }
    let path = disk_path(cover);
    if !path.is_file() {
        return None;
    }
    let bytes = std::fs::read(&path).ok()?;
    let art = Art {
        path: path.to_string_lossy().to_string(),
        b64: thumb_b64(&bytes).unwrap_or_default(),
    };
    if let Ok(mut g) = memo().lock() {
        g.insert(cover.to_string(), Some(art.clone()));
    }
    Some(art)
}

fn build(cover: &str) -> Option<Art> {
    let bytes = if is_remote(cover) {
        fetch(cover)?
    } else {
        let b = std::fs::read(cover).ok()?;
        if b.is_empty() || b.len() > MAX_BYTES {
            return None;
        }
        b
    };
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return None;
    }
    let path = if is_remote(cover) {
        cache_to_disk(cover, &bytes)?
    } else {
        cover.to_string()
    };
    /* 缩图失败（罕见格式）也不亏：系统卡片仍能显示原图，灵动岛画音符占位 */
    let b64 = thumb_b64(&bytes).unwrap_or_default();
    Some(Art { path, b64 })
}

fn fetch(url: &str) -> Option<Vec<u8>> {
    let resp = crate::net::agent()
        .get(url)
        .timeout(Duration::from_secs(6))
        .call()
        .ok()?;
    let mut out = Vec::new();
    resp.into_reader()
        .take(MAX_BYTES as u64)
        .read_to_end(&mut out)
        .ok()?;
    Some(out)
}

/// 原图落盘（`MPMediaItemArtwork` 只吃本地文件）。
fn cache_to_disk(url: &str, bytes: &[u8]) -> Option<String> {
    let dir = std::env::temp_dir().join("shuyin-art");
    std::fs::create_dir_all(&dir).ok()?;
    let path = disk_path(url);
    /* 已经写过就不重复写（同一张封面会被问很多次） */
    if !path.is_file() {
        std::fs::write(&path, bytes).ok()?;
    }
    Some(path.to_string_lossy().to_string())
}

/// 某张封面在临时目录里的落点（按地址哈希，同一张图永远是同一个文件名）。
fn disk_path(url: &str) -> std::path::PathBuf {
    std::env::temp_dir()
        .join("shuyin-art")
        .join(format!("{:016x}.img", fnv1a(url.as_bytes())))
}

/// 居中裁成正方形 → 72×72 JPEG → base64。
///
/// 压不下 [`B64_MAX`] 就降质量重来（极少数噪点封面）。四档都不行就当没封面——
/// 宁可画音符占位，也不能让 `Activity.update` 因为超长抛错（那会把整条卡住）。
fn thumb_b64(bytes: &[u8]) -> Option<String> {
    use base64::Engine;
    let img = image::load_from_memory(bytes).ok()?;
    let side = img.width().min(img.height()).max(1);
    let full = img.crop_imm(0, 0, side, side);
    let small = full.resize_exact(72, 72, image::imageops::FilterType::Triangle);
    let rgb = small.to_rgb8();
    for q in [66u8, 52, 42, 32] {
        let mut buf: Vec<u8> = Vec::new();
        let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, q);
        /* 走 `write_with_encoder` 而不是 `encode_*`：后者在 0.24→0.25 改过名，
           这个入口两版都在，编译期不用跟着 crate 升级改代码 */
        if image::DynamicImage::ImageRgb8(rgb.clone())
            .write_with_encoder(enc)
            .is_err()
        {
            continue;
        }
        let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
        if b64.len() <= B64_MAX {
            return Some(b64);
        }
    }
    None
}

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn empty_cover_is_none() {
        assert!(resolve("").is_none());
        assert!(resolve("   ").is_none());
    }

    #[test]
    fn missing_local_file_is_none() {
        assert!(resolve("/tmp/definitely-not-here-shuyin.jpg").is_none());
    }

    /// 自己造一张 240×120 的 PNG（非方图），确认裁成正方形、缩到 72×72、
    /// 压出来的 base64 塞得进 ContentState 的预算。
    #[test]
    fn square_thumb_fits_budget() {
        use base64::Engine;
        let img = image::RgbImage::from_fn(240, 120, |x, y| {
            image::Rgb([(x % 256) as u8, (y * 2 % 256) as u8, ((x + y) % 256) as u8])
        });
        let mut png: Vec<u8> = Vec::new();
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let b64 = thumb_b64(&png).expect("应该能压出来");
        assert!(b64.len() <= B64_MAX, "base64 超了预算：{}", b64.len());
        let raw = base64::engine::general_purpose::STANDARD.decode(&b64).unwrap();
        let decoded = image::load_from_memory(&raw).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (72, 72));
    }

    #[test]
    fn local_file_feeds_both_channels() {
        let dir = std::env::temp_dir().join("shuyin-cover-test");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("c.png");
        let img = image::RgbImage::from_fn(96, 96, |x, y| image::Rgb([x as u8, y as u8, 90]));
        let mut f = std::fs::File::create(&p).unwrap();
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut f, image::ImageFormat::Png)
            .unwrap();
        drop(f);
        let art = resolve(&p.to_string_lossy()).expect("本地封面应该读得到");
        assert_eq!(art.path, p.to_string_lossy());
        assert!(!art.b64.is_empty());
        /* 第二遍走缓存，结果一致 */
        let again = resolve(&p.to_string_lossy()).unwrap();
        assert_eq!(again.b64, art.b64);
    }
}
