#!/usr/bin/env bash
# 把桌面那套前端打成安卓壳要用的静态资源。
#
# 一套源码两处产物：
#   桌面 → Tauri（Rust 后端）
#   安卓 → app/src/main/assets/www（Kotlin 后端）
# 前端本身不区分平台，差异全部收敛在 bridge.invoke 后面。
set -euo pipefail

cd "$(dirname "$0")/../desktop"
OUT="../android/android/app/src/main/assets/www"

./node_modules/.bin/tsc -p . --noEmit
./node_modules/.bin/vite build --base ./ --outDir "$OUT" --emptyOutDir

# 音源清单不进 APK（2026-11-20 拍板：我们只是个播放器，发行包不能自带音源）。
# 用户音源一律自己导入；assets 里没有 sources.json 时 Sources.kt 的 seed()
# 会自动写一份空清单（纯净版路径，本来就是设计好的）。
# 旧版曾把开发者本机 %APPDATA% 的清单带进包里——那是测试期的做法，已移除。

echo "web 产物 → $OUT"
