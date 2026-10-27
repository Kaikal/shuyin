# 疏音 · 桌面端（Tauri 2 + React 19 + Vite）

## 开发

```bash
cd code
pnpm install
pnpm dev:desktop        # Vite + Tauri dev 窗口（加载 http://localhost:1420）
```

## 构建（重要）

```bash
pnpm -F shuyin-desktop build:app        # 生产 exe（内嵌前端资源）
pnpm -F shuyin-desktop build:installer  # NSIS 安装包（需能访问 NSIS 下载源）
pnpm -F shuyin-desktop build:web        # 便携单文件 Web 版 → dist/web
```

> ⚠️ **不要用裸 `cargo build --release` 出包。**
> Tauri 2 的生产资源内嵌由 `custom-protocol` feature 控制（`tauri/build.rs` 用它推导
> `cargo:dev`）。缺少该 feature 时，即使是 release 编译，应用仍按 dev 模式加载
> `devUrl`（`http://localhost:1420`），双击会看到
> `ERR_CONNECTION_REFUSED / localhost 拒绝连接`。
> `tauri build` 会自动带上该 feature；`cargo build --release` 不会。
>
> 自检：`grep -c "index-.*\.js" shuyin-desktop.exe`，能看到 `dist/assets` 里的
> 哈希文件名才说明资源已内嵌。

## 架构要点

- **播放不经 WebView `<audio>`**：Rust 侧 `rodio`（内部 symphonia）解码输出；`OutputStream`
  非 Send，故音频对象跑在专用线程，外部只持 `Player` 句柄（mpsc 命令 + 共享原子量读状态），
  曲终由 `sink.empty()` 150ms 轮询判定，`player://state` 250ms 广播。
- **扫描**：`walkdir`（`SKIP_DIRS` 黑名单）+ `lofty` 元数据 + `rayon` 并行 → SQLite
  （`%LOCALAPPDATA%\cn.shuyin.player\library.db`），封面/同目录专辑图缓存到 `covers/`。
  `scan(scope)`：`fast` 音乐文件夹 / `full` 全盘 / `custom` 指定目录；增量按 mtime+size 跳过。
- **歌词**：`get_lyrics(id)` 返回原文（同目录同名 `.lrc` > 内嵌 `ItemKey::Lyrics`），
  前端 `parseLrc` 解析；无本地歌词时请求 lrclib.net（CORS 开放，6s 超时）兜底。
- **主题**：Token → CSS 自定义属性，6 套内置主题 + 自定义面板（实时预览）+ JSON 导入导出。
- **命令清单**（`src-tauri/src/lib.rs`）：`scan_music` / `get_tracks` / `get_lyrics` /
  `remove_track` / `pick_music_folder` / `play_file` / `pause` / `resume` / `stop` / `seek` /
  `set_volume` / `player_state` / `cover_abs_path`。

## 本机工具链

```
RUSTUP_HOME = E:\tools\rust\.rustup
CARGO_HOME  = E:\tools\rust\.cargo
cargo       = E:\tools\rust\.rustup\toolchains\stable-x86_64-pc-windows-msvc\bin\cargo.exe
MSVC        = E:\tools\vs2022bt（VC Tools 14.44）
crates 源   = sparse+https://rsproxy.cn/index/（清华索引的 dl 指向 static.crates.io 会卡死）
```

构建时需把工具链 `bin` 加入 PATH，否则 `autocfg` 等 build script 报 `program not found`。
