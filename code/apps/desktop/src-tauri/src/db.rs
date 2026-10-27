//! 曲库数据库：SQLite（rusqlite bundled）。
//! 负责：目录解析（快速/全盘）、扫描入库、封面与歌词读取、曲目移除。

use lofty::prelude::*;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::AppHandle;
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTrack {
    pub id: String,
    pub path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration: f64,
    pub format: String,
    pub bitrate: Option<i64>,
    #[serde(rename = "sampleRate")]
    pub sample_rate: Option<i64>,
    pub cover: Option<String>,
    pub mtime: i64,
    pub size: i64,
    pub year: Option<i64>,
    pub track_no: Option<i64>,
    pub genre: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub total: i64,
    pub added: i64,
    pub updated: i64,
    pub removed: i64,
    pub duration_ms: u64,
    pub incremental: bool,
    /// 本次扫描覆盖的根目录（UI 展示用）
    pub roots: Vec<String>,
    /// 被判定为无效而跳过的文件数（非音频 / 过短 / 录音等）
    pub skipped: i64,
    /// 是否因保护上限提前结束（此时不做缺失清理）
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricsRaw {
    /// lrc | embedded | none
    pub source: String,
    pub text: String,
}

pub struct Db(pub Mutex<Connection>);

impl Db {
    pub fn count(&self) -> Result<i64, String> {
        let conn = self.0.lock().unwrap_or_else(|e| e.into_inner());
        conn.query_row("SELECT COUNT(*) FROM tracks", [], |r| r.get::<_, i64>(0))
            .map_err(|e| e.to_string())
    }

    pub fn duration_of(&self, path: &str) -> Result<f64, String> {
        let conn = self.0.lock().unwrap_or_else(|e| e.into_inner());
        conn.query_row(
            "SELECT duration FROM tracks WHERE path = ?1",
            rusqlite::params![path],
            |r| r.get::<_, f64>(0),
        )
        .map_err(|e| e.to_string())
    }

    pub fn path_of(&self, id: &str) -> Result<String, String> {
        let conn = self.0.lock().unwrap_or_else(|e| e.into_inner());
        conn.query_row("SELECT path FROM tracks WHERE id = ?1", params![id], |r| {
            r.get::<_, String>(0)
        })
        .map_err(|e| e.to_string())
    }
}

pub fn init_db(app: &AppHandle) -> Result<Db, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(dir.join("covers")).map_err(|e| e.to_string())?;

    let conn = Connection::open(dir.join("library.db")).map_err(|e| e.to_string())?;
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS tracks (
            id TEXT PRIMARY KEY,
            path TEXT UNIQUE NOT NULL,
            title TEXT NOT NULL,
            artist TEXT NOT NULL,
            album TEXT NOT NULL,
            duration REAL NOT NULL DEFAULT 0,
            format TEXT NOT NULL,
            bitrate INTEGER,
            sample_rate INTEGER,
            cover TEXT,
            mtime INTEGER NOT NULL,
            size INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tracks_title ON tracks(title);
        CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);
        "#,
    )
    .map_err(|e| e.to_string())?;

    // 增量迁移：老库补列（失败说明已存在，忽略）
    for ddl in [
        "ALTER TABLE tracks ADD COLUMN year INTEGER",
        "ALTER TABLE tracks ADD COLUMN track_no INTEGER",
        "ALTER TABLE tracks ADD COLUMN genre TEXT",
    ] {
        let _ = conn.execute(ddl, []);
    }
    Ok(Db(Mutex::new(conn)))
}

pub fn covers_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_local_data_dir()
        .map(|d| d.join("covers"))
        .unwrap_or_else(|_| PathBuf::from("covers"))
}

fn track_id(path: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(path.as_bytes());
    format!("t{}", hex::encode(&h.finalize()[..8]))
}

/* ------------------------------------------------------------------ */
/* 扫描范围                                                            */
/* ------------------------------------------------------------------ */

/// 全盘扫描时跳过的目录名（小写比较）
const SKIP_DIRS: &[&str] = &[
    "windows", "program files", "program files (x86)", "programdata",
    "$recycle.bin", "system volume information", "recovery", "perflogs",
    "appdata", "node_modules", ".git", ".svn", ".hg", "target", "obj",
    "temp", "tmp", "cache", "caches", ".cache", "__pycache__",
    ".cargo", ".rustup", ".gradle", ".m2", ".nuget", ".pnpm-store",
    ".workbuddy", ".vscode", ".idea", "windowsapps",
];

fn is_skipped(dir_name: &str) -> bool {
    let low = dir_name.to_lowercase();
    if low.starts_with('.') {
        return true;
    }
    SKIP_DIRS.iter().any(|s| *s == low)
}

/// 快速扫描：用户音乐/下载/桌面 + 公共音乐 + 各盘符根下的常见音乐目录
fn fast_roots() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    if let Ok(home) = std::env::var("USERPROFILE") {
        let h = PathBuf::from(&home);
        for sub in ["Music", "音乐", "Downloads", "Desktop"] {
            let p = h.join(sub);
            if p.is_dir() && !out.contains(&p) {
                out.push(p);
            }
        }
    }
    if let Ok(pubdir) = std::env::var("PUBLIC") {
        let p = PathBuf::from(pubdir).join("Music");
        if p.is_dir() {
            out.push(p);
        }
    }
    for drive in b'C'..=b'Z' {
        let root = PathBuf::from(format!("{}:\\", drive as char));
        if !root.is_dir() {
            continue;
        }
        for name in ["Music", "音乐", "Music Library", "Songs"] {
            let p = root.join(name);
            if p.is_dir() && !out.contains(&p) {
                out.push(p);
            }
        }
    }
    out
}

/// 全盘扫描：所有存在盘符的根
fn full_roots() -> Vec<PathBuf> {
    (b'C'..=b'Z')
        .map(|d| PathBuf::from(format!("{}:\\", d as char)))
        .filter(|p| p.is_dir())
        .collect()
}

pub fn resolve_roots(scope: &str, custom: &[String]) -> Vec<PathBuf> {
    if !custom.is_empty() {
        return custom
            .iter()
            .map(PathBuf::from)
            .filter(|p| p.is_dir())
            .collect();
    }
    match scope {
        "full" => full_roots(),
        _ => fast_roots(),
    }
}

/* ------------------------------------------------------------------ */
/* 扫描                                                                */
/* ------------------------------------------------------------------ */

pub fn scan(
    app: &AppHandle,
    db: &Db,
    scope: &str,
    custom_dirs: &[String],
    incremental: bool,
    progress: &(dyn Fn(u64, u64, String) + Send + Sync),
) -> Result<ScanResult, String> {
    let start = std::time::Instant::now();
    let roots = resolve_roots(scope, custom_dirs);
    let root_strs: Vec<String> = roots.iter().map(|p| p.to_string_lossy().to_string()).collect();
    if roots.is_empty() {
        return Err("没有可扫描的目录".into());
    }

    // 1. 收集文件（遍历阶段即上报进度）
    let mut files: Vec<(PathBuf, i64, i64)> = Vec::new();
    // 扫描是否被保护上限截断（截断时不能做「文件缺失」清理，否则会误删没扫到的歌）
    let mut truncated = false;
    for root in &roots {
        let max_depth = if scope == "full" { 14 } else { 10 };
        let root_start = std::time::Instant::now();
        let walker = walkdir::WalkDir::new(root)
            .follow_links(false)
            .max_depth(max_depth)
            .into_iter()
            .filter_entry(|e| {
                if e.depth() == 0 {
                    return true;
                }
                if e.file_type().is_dir() {
                    let name = e.file_name().to_string_lossy().to_string();
                    return !is_skipped(&name);
                }
                true
            });

        for entry in walker.filter_map(|e| e.ok()) {
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            let ok = matches!(
                path.extension()
                    .and_then(|e| e.to_str())
                    .map(|e| e.to_lowercase())
                    .as_deref(),
                Some("mp3" | "aac" | "m4a" | "flac" | "wav" | "ogg" | "opus")
            );
            if !ok {
                continue;
            }
            if let Ok(md) = entry.metadata() {
                let mtime = md
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                files.push((path.to_path_buf(), mtime, md.len() as i64));
            }
            if files.len() % 200 == 0 && !files.is_empty() {
                progress(
                    files.len() as u64,
                    0,
                    format!(
                        "正在查找音频文件…（{}）",
                        path.parent()
                            .map(|p| p.to_string_lossy().to_string())
                            .unwrap_or_default()
                    ),
                );
            }
            // 单盘限制：避免全盘扫描卡在超大目录（每块盘 4 分钟 / 全局 20000 首上限）
            if root_start.elapsed().as_secs() > 240 || files.len() >= 20_000 {
                truncated = true;
                break;
            }
        }
        progress(files.len() as u64, 0, format!("已发现 {} 个音频文件", files.len()));
        if files.len() >= 20_000 {
            truncated = true;
            break;
        }
    }

    let total_found = files.len() as u64;

    // 2. 读取已有库（增量判断）
    let existing: std::collections::HashMap<String, (i64, i64)> = {
        let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = conn
            .prepare("SELECT path, mtime, size FROM tracks")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?))
            })
            .map_err(|e| e.to_string())?;
        let mut map = std::collections::HashMap::new();
        for r in rows.flatten() {
            map.insert(r.0, (r.1, r.2));
        }
        map
    };

    // 3. 并行解析元数据
    //    Unchanged = 增量跳过（文件没变，保留库里记录）
    //    Valid     = 解析成功，写库
    //    Invalid   = 根本不是音频 / 过短 / 录音等噪音，不入库（并计 skipped）
    enum Outcome {
        Unchanged,
        Valid(LocalTrack),
        Invalid,
    }
    use rayon::prelude::*;
    let covers = covers_dir(app);
    let parsed_count = AtomicU64::new(0);
    let outcomes: Vec<Outcome> = files
        .into_par_iter()
        .map(|(path, mtime, size)| {
            let key = path.to_string_lossy().to_string();
            if incremental {
                if let Some((em, es)) = existing.get(&key) {
                    if *em == mtime && *es == size {
                        return Outcome::Unchanged;
                    }
                }
            }
            let t = parse_track(&path, mtime, size, &covers);
            let n = parsed_count.fetch_add(1, Ordering::Relaxed) + 1;
            if n % 30 == 0 {
                progress(total_found, n, format!("正在解析元数据 {} / {}", n, total_found));
            }
            match t {
                Some(track) => Outcome::Valid(track),
                None => Outcome::Invalid,
            }
        })
        .collect();

    let mut parsed: Vec<LocalTrack> = Vec::new();
    let mut skipped = 0i64;
    for o in outcomes {
        match o {
            Outcome::Unchanged => {}
            Outcome::Valid(t) => parsed.push(t),
            Outcome::Invalid => skipped += 1,
        }
    }

    // 4. 写库（事务）
    let (added, updated) = {
        let mut conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let mut a = 0i64;
        let mut u = 0i64;
        for t in &parsed {
            let existed = existing.contains_key(&t.path);
            let n = tx
                .execute(
                    "INSERT INTO tracks (id,path,title,artist,album,duration,format,bitrate,sample_rate,cover,mtime,size,year,track_no,genre)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
                     ON CONFLICT(path) DO UPDATE SET
                       id=excluded.id, title=excluded.title, artist=excluded.artist, album=excluded.album,
                       duration=excluded.duration, format=excluded.format, bitrate=excluded.bitrate,
                       sample_rate=excluded.sample_rate, cover=excluded.cover, mtime=excluded.mtime,
                       size=excluded.size, year=excluded.year, track_no=excluded.track_no, genre=excluded.genre",
                    params![
                        t.id, t.path, t.title, t.artist, t.album, t.duration, t.format,
                        t.bitrate, t.sample_rate, t.cover, t.mtime, t.size,
                        t.year, t.track_no, t.genre
                    ],
                )
                .map_err(|e| e.to_string())?;
            if existed {
                u += n as i64
            } else {
                a += n as i64
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        (a, u)
    };

    // 5. 清理已失效记录
    //    关键：只删「文件真的不在了」的记录，而不是「本次没扫到」的记录。
    //    否则快速扫描（只覆盖音乐目录）会把之前全盘扫描的其他盘曲目全部误删；
    //    增量扫描（只解析变更文件）更会把整个曲库清空。
    let removed = if truncated { 0 } else { prune_missing(db)? };

    let total = db.count()?;

    Ok(ScanResult {
        total,
        added,
        updated,
        removed,
        duration_ms: start.elapsed().as_millis() as u64,
        incremental,
        roots: root_strs,
        skipped,
        truncated,
    })
}

/// 解析单个音频文件；无标签时回落为文件名。
fn parse_track(path: &Path, mtime: i64, size: i64, covers: &Path) -> Option<LocalTrack> {
    let path_str = path.to_string_lossy().to_string();
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();

    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("未知标题");
    let mut title = stem.to_string();
    let mut artist = "未知艺术家".to_string();
    let mut album = "未知专辑".to_string();
    let mut duration = 0f64;
    let mut bitrate: Option<i64> = None;
    let mut sample_rate: Option<i64> = None;
    let mut year: Option<i64> = None;
    let mut track_no: Option<i64> = None;
    let mut genre: Option<String> = None;
    let mut cover: Option<String> = None;

    // 只有能真正解析出音频流、属性合理、且不像录音的文件才入库。
    // 这一步同时挡掉「改了扩展名的图片/文档」和「微信语音、通话录音、提示音」。
    let mut decoded_ok = false;

    if let Ok(probe) = lofty::probe::Probe::open(path) {
        if let Ok(file) = probe.read() {
            decoded_ok = true;
            duration = file.properties().duration().as_secs_f64();
            bitrate = if duration > 0.0 {
                Some(((size as f64 * 8.0) / duration / 1000.0) as i64)
            } else {
                None
            };
            sample_rate = file.properties().sample_rate().map(|s| s as i64);

            let tag = file.primary_tag().or_else(|| file.first_tag());
            if let Some(tag) = tag {
                if let Some(v) = tag.title() {
                    let s = v.to_string();
                    if !s.trim().is_empty() {
                        title = s;
                    }
                }
                if let Some(v) = tag.artist() {
                    let s = v.to_string();
                    if !s.trim().is_empty() {
                        artist = s;
                    }
                }
                if let Some(v) = tag.album() {
                    let s = v.to_string();
                    if !s.trim().is_empty() {
                        album = s;
                    }
                }
                year = tag.year().map(|y| y as i64);
                track_no = tag.track().map(|t| t as i64);
                genre = tag.genre().map(|g| g.to_string());

                // 封面：优先内嵌
                if let Some(pic) = tag
                    .pictures()
                    .iter()
                    .find(|p| p.pic_type() == lofty::picture::PictureType::CoverFront)
                    .or_else(|| tag.pictures().first())
                {
                    let ext2 = match pic.mime_type() {
                        Some(lofty::picture::MimeType::Png) => "png",
                        _ => "jpg",
                    };
                    let fp = covers.join(format!("{}.{}", track_id(&path_str), ext2));
                    if fp.exists() || std::fs::write(&fp, pic.data()).is_ok() {
                        cover = Some(fp.to_string_lossy().to_string());
                    }
                }
            }
        }
    }

    // 封面兜底：同目录常见专辑图文件名
    if cover.is_none() {
        cover = sibling_cover(path, covers).map(|p| p.to_string_lossy().to_string());
    }

    /* ---------- 质量闸门 ---------- */
    // 1) 解析不出音频流：不是音频（改了扩展名的图片/文档/损坏文件）
    if !decoded_ok {
        return None;
    }
    // 2) 时长过短或采样率异常：提示音、碎裂文件
    if duration < 5.0 || sample_rate.unwrap_or(0) <= 0 {
        return None;
    }
    // 3) 噪音命名（录音 / 语音 / 提示音等）且不是正常歌曲长度
    let hay = format!("{} {} {}", title, stem, album).to_lowercase();
    const JUNK: &[&str] = &[
        "录音", "录像", "微信", "wechat", "voice", "record", "通话", "电话",
        "铃声", "rington", "提示音", "notification", "alert", "语音", "语音消息",
    ];
    if duration < 300.0 && JUNK.iter().any(|h| hay.contains(h)) {
        return None;
    }
    // 4) 无任何标签的极短音频（< 60s）多半是录音片段
    if duration < 60.0 && artist == "未知艺术家" && album == "未知专辑" {
        return None;
    }

    Some(LocalTrack {
        id: track_id(&path_str),
        path: path_str,
        title,
        artist,
        album,
        duration,
        format: ext,
        bitrate,
        sample_rate,
        cover,
        mtime,
        size,
        year,
        track_no,
        genre,
    })
}

/// 同目录 cover/folder/front/album 图（找不到返回 None）
fn sibling_cover(track: &Path, covers: &Path) -> Option<PathBuf> {
    let dir = track.parent()?;
    let stem = track
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_string();
    let names = ["cover", "folder", "front", "album", "albumart", "AlbumArtSmall", stem.as_str()];
    let exts = ["jpg", "jpeg", "png", "webp"];
    for name in names {
        for ext in exts {
            let cand = dir.join(format!("{name}.{ext}"));
            if cand.is_file() {
                // 复制进缓存目录，asset 协议 scope 只需覆盖缓存
                let target = covers.join(format!("{}-local.{ext}", track_id(&track.to_string_lossy())));
                if target.exists() || std::fs::copy(&cand, &target).is_ok() {
                    return Some(target);
                }
                return Some(cand);
            }
        }
    }
    None
}

/* ------------------------------------------------------------------ */
/* 歌词 / 移除                                                         */
/* ------------------------------------------------------------------ */

/// 歌词：同目录同名 .lrc > 内嵌歌词标签。返回原文，前端统一解析 LRC。
pub fn lyrics_for(db: &Db, id: &str) -> Result<LyricsRaw, String> {
    let path = db.path_of(id)?;
    let p = Path::new(&path);

    if let Some(dir) = p.parent() {
        let stem = p
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_lowercase();
        if let Ok(entries) = std::fs::read_dir(dir) {
            for e in entries.flatten() {
                let ep = e.path();
                if !ep.is_file() {
                    continue;
                }
                let is_lrc = ep
                    .extension()
                    .and_then(|x| x.to_str())
                    .map(|x| x.eq_ignore_ascii_case("lrc"))
                    .unwrap_or(false);
                if !is_lrc {
                    continue;
                }
                let est = ep
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or_default()
                    .to_lowercase();
                if est == stem {
                    if let Ok(text) = std::fs::read_to_string(&ep) {
                        return Ok(LyricsRaw { source: "lrc".into(), text });
                    }
                }
            }
        }
    }

    if let Ok(probe) = lofty::probe::Probe::open(p) {
        if let Ok(file) = probe.read() {
            let tag = file.primary_tag().or_else(|| file.first_tag());
            if let Some(tag) = tag {
                if let Some(item) = tag.get_string(&ItemKey::Lyrics) {
                    if !item.trim().is_empty() {
                        return Ok(LyricsRaw {
                            source: "embedded".into(),
                            text: item.to_string(),
                        });
                    }
                }
            }
        }
    }

    Ok(LyricsRaw { source: "none".into(), text: String::new() })
}

pub fn remove_track(db: &Db, id: &str) -> Result<(), String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    conn.execute("DELETE FROM tracks WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 删除「磁盘上已不存在」的记录。只依据文件存在性，绝不依据本次扫描是否覆盖，
/// 避免小范围/增量扫描误删曲库。返回删除条数。
pub fn prune_missing(db: &Db) -> Result<i64, String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    let all: Vec<String> = {
        let mut stmt = conn.prepare("SELECT path FROM tracks").map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let mut v = Vec::new();
        for r in rows.flatten() {
            v.push(r);
        }
        v
    };
    let gone: Vec<String> = all.into_iter().filter(|p| !Path::new(p).is_file()).collect();
    for p in &gone {
        conn.execute("DELETE FROM tracks WHERE path = ?1", params![p])
            .map_err(|e| e.to_string())?;
    }
    Ok(gone.len() as i64)
}

pub fn get_all_tracks(db: &Db) -> Result<Vec<LocalTrack>, String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    let mut stmt = conn
        .prepare(
            "SELECT id,path,title,artist,album,duration,format,bitrate,sample_rate,cover,mtime,size,year,track_no,genre
             FROM tracks ORDER BY title COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(LocalTrack {
                id: row.get(0)?,
                path: row.get(1)?,
                title: row.get(2)?,
                artist: row.get(3)?,
                album: row.get(4)?,
                duration: row.get(5)?,
                format: row.get(6)?,
                bitrate: row.get(7)?,
                sample_rate: row.get(8)?,
                cover: row.get(9)?,
                mtime: row.get(10)?,
                size: row.get(11)?,
                year: row.get(12).ok().flatten(),
                track_no: row.get(13).ok().flatten(),
                genre: row.get(14).ok().flatten(),
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.flatten().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_test_wav(path: &Path, rate: u32, seconds: u32) {
        let data_len = rate * seconds * 2;
        let mut buf = Vec::new();
        buf.extend_from_slice(b"RIFF");
        buf.extend_from_slice(&(36 + data_len).to_le_bytes());
        buf.extend_from_slice(b"WAVEfmt ");
        buf.extend_from_slice(&16u32.to_le_bytes());
        buf.extend_from_slice(&1u16.to_le_bytes());
        buf.extend_from_slice(&1u16.to_le_bytes());
        buf.extend_from_slice(&rate.to_le_bytes());
        buf.extend_from_slice(&(rate * 2).to_le_bytes());
        buf.extend_from_slice(&2u16.to_le_bytes());
        buf.extend_from_slice(&16u16.to_le_bytes());
        buf.extend_from_slice(b"data");
        buf.extend_from_slice(&data_len.to_le_bytes());
        buf.resize(44 + data_len as usize, 0);
        std::fs::write(path, buf).unwrap();
    }

    fn mem_db() -> Db {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE tracks (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
             artist TEXT NOT NULL, album TEXT NOT NULL, duration REAL, format TEXT, bitrate INTEGER,
             sample_rate INTEGER, cover TEXT, mtime INTEGER, size INTEGER, year INTEGER, track_no INTEGER, genre TEXT);",
        ).unwrap();
        Db(Mutex::new(conn))
    }

    fn insert_row(db: &Db, id: &str, path: &str) {
        let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute(
            "INSERT INTO tracks (id,path,title,artist,album,duration,format,mtime,size)
             VALUES (?1,?2,'S','A','B',100,'mp3',1,2)",
            params![id, path],
        ).unwrap();
    }

    #[test]
    fn parse_wav_metadata() {
        let dir = std::env::temp_dir().join("shuyin-scan-t3");
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("测试曲目 - 测试歌手.wav");
        write_test_wav(&wav, 8_000, 90);
        let covers = dir.join("covers");
        std::fs::create_dir_all(&covers).unwrap();

        let t = parse_track(&wav, 1, std::fs::metadata(&wav).unwrap().len() as i64, &covers)
            .expect("有效音频应入库");
        assert_eq!(t.format, "wav");
        assert!(t.title.contains("测试曲目"));
        assert!(t.duration > 85.0 && t.duration < 95.0, "duration={}", t.duration);
    }

    #[test]
    fn fake_mp3_rejected() {
        let dir = std::env::temp_dir().join("shuyin-fake-test");
        std::fs::create_dir_all(dir.join("covers")).unwrap();
        let fake = dir.join("伪装.mp3");
        std::fs::write(&fake, b"this is not audio at all").unwrap();
        let got = parse_track(&fake, 1, 24, &dir.join("covers"));
        assert!(got.is_none(), "改了扩展名的非音频文件必须被过滤");
    }

    #[test]
    fn short_audio_rejected() {
        let dir = std::env::temp_dir().join("shuyin-short-test");
        std::fs::create_dir_all(dir.join("covers")).unwrap();
        let short = dir.join("提示音.wav");
        write_test_wav(&short, 8_000, 2);
        let got = parse_track(&short, 1, std::fs::metadata(&short).unwrap().len() as i64, &dir.join("covers"));
        assert!(got.is_none(), "短于 5 秒的提示音必须被过滤");
    }

    #[test]
    fn sibling_cover_picked_up() {
        let dir = std::env::temp_dir().join("shuyin-cover-test");
        std::fs::create_dir_all(dir.join("covers")).unwrap();
        let wav = dir.join("a.wav");
        write_test_wav(&wav, 8_000, 90);
        std::fs::write(dir.join("cover.jpg"), b"fake-jpg").unwrap();
        assert!(sibling_cover(&wav, &dir.join("covers")).is_some());
    }

    #[test]
    fn skip_rules() {
        assert!(is_skipped("Windows"));
        assert!(is_skipped("node_modules"));
        assert!(is_skipped(".git"));
        assert!(!is_skipped("Music"));
        assert!(!is_skipped("我的音乐"));
    }

    #[test]
    fn roots_resolve() {
        let tmp = std::env::temp_dir();
        assert_eq!(resolve_roots("fast", &[tmp.to_string_lossy().to_string()]).len(), 1);
        assert!(!resolve_roots("fast", &[]).is_empty());
        assert!(!resolve_roots("full", &[]).is_empty());
    }

    /// 回归：清理只依据文件是否存在，绝不因为「本次没扫到」而删库
    #[test]
    fn prune_only_removes_missing_files() {
        let dir = std::env::temp_dir().join("shuyin-prune-test");
        std::fs::create_dir_all(&dir).unwrap();
        let real = dir.join("存在.mp3");
        std::fs::write(&real, b"x").unwrap();
        let ghost = dir.join("已删除.mp3");
        let _ = std::fs::remove_file(&ghost);

        let db = mem_db();
        insert_row(&db, "t1", &real.to_string_lossy().to_string());
        insert_row(&db, "t2", &ghost.to_string_lossy().to_string());
        assert_eq!(db.count().unwrap(), 2);

        let removed = prune_missing(&db).unwrap();
        assert_eq!(removed, 1, "只应删除磁盘上不存在的记录");
        assert_eq!(db.count().unwrap(), 1, "未变更的曲目必须保留");
    }

    #[test]
    fn lyrics_from_sibling_lrc() {
        let dir = std::env::temp_dir().join("shuyin-lyrics-test");
        std::fs::create_dir_all(&dir).unwrap();
        let audio = dir.join("Song.mp3");
        std::fs::write(&audio, b"fake").unwrap();
        std::fs::write(dir.join("Song.lrc"), "[00:01.00]第一行\n[00:05.50]第二行\n").unwrap();

        let db = mem_db();
        insert_row(&db, "t1", &audio.to_string_lossy().to_string());
        let got = lyrics_for(&db, "t1").unwrap();
        assert_eq!(got.source, "lrc");
        assert!(got.text.contains("第二行"));
    }
}
