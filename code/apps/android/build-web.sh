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

# 音源清单：从桌面端的数据目录带一份进 APK，
# 这样装到手机上就是「已经导入过音源」的状态，不用再找一遍脚本。
SRC="${APPDATA:-$HOME/AppData/Roaming}/cn.shuyin.player/sources/sources.json"
if [ -f "$SRC" ]; then
  cp "$SRC" ../android/android/app/src/main/assets/sources.json
  echo "已带入音源清单：$(basename "$SRC")"
fi

echo "web 产物 → $OUT"
