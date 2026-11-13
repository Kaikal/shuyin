# 疏音 · ShuYin

> 疏影横斜，澄澈之音。

一个只管放歌的本地音乐播放器。Windows 桌面与 Android 共用同一套前端，界面与操作在两端保持一致。

| | 版本 | 形态 |
|---|---|---|
| Windows | `0.5.25` | Tauri 2 + Rust 后端，安装包约 5.6 MB |
| Android 手机 | `0.6.107` | Kotlin + WebView 壳，约 3.5 MB |
| Android 车机 | `0.6.107` | 同壳横向版（`cn.shuyin.player.car`） |

## 功能

**本地播放**

- 扫描本机音乐目录，支持 MP3 / AAC / M4A / FLAC / WAV / OGG / Opus，读取内嵌标签与封面
- 本地歌单、收藏、上次播放位置与播放队列，退出再进能接上
- 歌词：优先同目录 `.lrc`，其次内嵌歌词；都没有时走在线歌词源兜底
- 桌面歌词（置顶浮窗）与安卓悬浮歌词

**在线**

- 支持网易云、QQ 音乐、酷我、酷狗四个平台，扫码或短信登录**你自己的账号**
- 在线搜索、歌单广场、平台歌单同步、「为你推荐」每日混排
- 取链带三级兜底：上次可用平台 → 本平台多档音质 → 跨平台重搜；30 秒试听片段会被识别并跳过

**播放体验**

- 沉浸播放页：黑胶转盘、逐行滚动歌词、封面色取调
- 音效：五段图形均衡器（60 / 230 / 910 / 3.6k / 14k Hz）+ 声道平衡 + 前置增益，另有 3D 旋转、宽广环绕、耳机增强、现场四种空间音效，可与均衡器叠加
- 频谱可视化
- 下载与离线缓存：音频存 `Music/疏音`，歌词存 `Download/疏音`（安卓），桌面存应用数据目录

**同步**

- 云同步：账号、歌单、收藏、设置、音源脚本打包成一个 `sync.json` 上传，换设备「从云端恢复」
- 不登录也完全可用，同步只是可选能力

**多端**

- 平板按大屏重新排版：内容列居中、列表与字号放大、横屏播放页左右两栏
- 车机版为横向大尺寸按钮布局，适配车载触屏

## 下载

安装包不进仓库（单个 3~6 MB，进仓库会让 clone 变重），统一放在发行版页，文件名规则：

| 文件 | 说明 |
|---|---|
| `shuyin-android-<版本>.apk` | Android 手机 / 平板 |
| `shuyin-car-<版本>.apk` | Android 车机（横向布局，包名 `cn.shuyin.player.car`，可与手机版共存） |
| `shuyin-windows-<版本>.exe` | Windows 安装包 |

发行版入口见仓库页面右侧的 **Releases**。

## 目录结构

```
code/
  packages/
    core/            # 纯 TS：曲目模型、扫描结果、播放队列状态机
    lx-provider/     # 各平台接口适配（搜索 / 歌单 / 取链 / 登录）
    theme-engine/    # 主题 Token、内置主题、校验与导入导出
  apps/
    desktop/         # Tauri 2 + React 19 + Vite，Windows 与安卓共用的前端
    android/         # Kotlin 壳：WebView + media3 播放服务 + 悬浮歌词窗
    site/            # 官网静态页（与 App 无依赖，单独部署）
docs/                # 设计与实施文档
template/            # 设计规范与原型
```

## 本地开发

```bash
cd code
pnpm install
pnpm dev:desktop        # 只跑前端（浏览器预览）
pnpm tauri dev          # 带 Rust 后端的完整窗口
```

## 构建

### Windows

```bash
cd code/apps/desktop
pnpm build:installer    # NSIS 安装包 → src-tauri/target/release/bundle/nsis
pnpm build:app          # 仅 exe，不打安装包
```

> 不要用裸 `cargo build --release` 出包。Tauri 2 的生产资源内嵌由 `custom-protocol` feature 控制，缺它时会去加载 `devUrl`，双击直接 `ERR_CONNECTION_REFUSED`。

### Android

前端先打进壳的 assets，再交给 Gradle：

```bash
cd code/apps/android
./build-web.sh                                  # 前端 → android/app/src/main/assets/www
cd android
./gradlew assemblePhoneRelease assembleCarRelease
```

产物在 `android/app/build/outputs/apk/{phone,car}/release/`。

## 版本号

发版时四处要一起改，漏一处会出现「安装包版本和界面里显示的不一致」：

1. `code/apps/desktop/package.json`
2. `code/apps/desktop/src-tauri/tauri.conf.json`
3. `code/apps/desktop/src-tauri/Cargo.toml`
4. `code/apps/desktop/src/pages/SettingsPage.tsx`

安卓另需 `code/apps/android/android/app/build.gradle` 的 `versionName` 同步，`versionCode` 每次 +1。

## 技术要点

- **音频不经 `<audio>` 标签**：桌面走 Rust（`rodio` + `symphonia`），安卓走 media3 `ExoPlayer`；前端只发命令、读状态，两端命令集保持一致。
- **音效三端同构**：五段 RBJ biquad + 声道平衡 + 前置增益 + 空间音效，Kotlin 与 Rust 用同一套系数公式，避免两端听感不一致。
- **一套前端两种壳**：差异收敛在 `lib/bridge.ts` 的 `invoke` 之后，业务代码不判平台。
- **云端只做同步**：登录与文件存储走腾讯云开发，不上传音频文件。

## 说明与边界

本项目是**播放器**，不是音乐来源：

- 不提供、不存储、不分发任何音乐内容与音源；
- 在线功能需登录**你自己在各平台的账号**，能听什么取决于该账号的权限，以各平台服务条款为准；
- 在线接口来自各平台公开服务，若接口调整可能导致功能不可用，请以本地播放能力为准；
- 请在有合法权限的前提下使用，因使用方式产生的后果由使用者自行承担。

## 反馈

Issue 请附上：

1. 系统与版本号（`设置 → 关于` 里的 `v*`）；
2. 复现步骤，以及是本地曲目还是在线曲目；
3. 与同步相关的，说明登录邮箱与最近一次操作（时间点），便于对照服务端日志。

## 开源协议

代码以 [Apache License 2.0](LICENSE) 发布。

协议只覆盖**本项目的代码**：不含任何音频内容，也不含各平台的音乐数据。
上一条「说明与边界」同样适用于协议授权范围。

