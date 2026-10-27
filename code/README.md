# 疏音 ShuYin

> 疏影横斜，澄澈之音。

本地音乐播放器 · 第一阶段交付。

## 目录

```
code/
  packages/
    core/           # 纯 TS：LocalTrack / ScanResult / PlaybackQueue 状态机
    theme-engine/   # ThemeTokens / 三个内置主题 / 校验 / 导入导出 / 启动页共享参数
  apps/
    desktop/        # Tauri 2 + React 19 + Vite（本机可构建）
    mobile/         # React Native 0.76（源码 + 构建说明，需 Android SDK/Xcode）
dist/               # 打包成品（见 dist/交付说明.md）
template/           # 设计规范与原型（Lumen Music 设计稿导出）
```

## 快速开始（桌面）

```bash
cd code
pnpm install
pnpm dev:desktop
```

## 第一阶段范围

- 本地音乐扫描与播放（MP3/AAC/M4A/FLAC/WAV/OGG/Opus）
- 播放器主界面（播放/暂停/上下首/进度拖拽/音量/循环模式/队列）
- 主题系统：浅色/深色/跟随系统 + 疏影、清浅、月黄昏三内置主题
- 自定义主题：参数面板实时预览、保存、JSON 导入导出与校验
- 液态玻璃：三层规范、同屏 ≤3、低端设备自动降级
- 启动页：疏影横斜仪式（首次 2.4s / 后续 1.2s / 可跳过 / 减弱动效 900ms）

不在本阶段：洛雪音源、在线搜索、歌词滚动、评论（见第二/三阶段）。
