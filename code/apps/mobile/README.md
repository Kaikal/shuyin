# 疏音 · 移动端（React Native）

Android 原生工程已生成（RN 0.76.5 官方模板合并进 `android/`），本机可出 APK。
iOS 仍需 macOS + Xcode。

## 技术栈

- React Native 0.76（New Architecture）
- `@nodefinity/react-native-music-library`：系统媒体库扫描（TurboModules，Android/iOS 原生）
- `react-native-track-player` **v4**（Apache-2.0）：本地播放、后台播放、锁屏控制
- `react-native-reanimated`：启动页逐字动画与主题过渡（UI 线程）
- `react-native-mmkv`：设置与曲库持久化
- `react-native-device-info`：低端设备判定（玻璃降级）

## 构建（Android）

```bash
cd apps/mobile
npm install                      # 用 npm，pnpm 与 RN gradle 插件的 node_modules 布局有冲突

cd android
export ANDROID_HOME=E:/tools/android-sdk
export ANDROID_SDK_ROOT=$ANDROID_HOME
export JAVA_HOME="D:/java_jdk/jdk-17.0.11"   # 必须 17，21 会报 Unsupported class file

./gradlew.bat assembleRelease
# 产物：app/build/outputs/apk/release/app-release.apk
```

环境要求（本机已装齐）：

| 项 | 版本 / 路径 |
|---|---|
| JDK | 17（`D:\java_jdk\jdk-17.0.11`） |
| Android SDK | `E:\tools\android-sdk`（platform 35 / build-tools 35.0.0 / platform-tools） |
| NDK | 26.1.10909125（RN 0.76 默认） |
| Gradle | 8.10.2（wrapper 走腾讯镜像） |
| Maven | 阿里云镜像（已写入根 `build.gradle`） |

> 首次构建要下 Gradle 发行包 + 全部 RN 依赖 + 编译 C++，约 10–15 分钟；增量构建 1–2 分钟。
> `local.properties` 里的 `sdk.dir` 已指向 `E:\\tools\\android-sdk`，换机器改这一行即可。

## 构建（iOS）

```bash
cd apps/mobile
npm install
cd ios && bundle exec pod install && cd ..
npx react-native run-ios --mode Release
```

## 权限配置（已写入 AndroidManifest.xml / Info.plist 占位，见 android/ ios/ 目录）

- Android 13+：`READ_MEDIA_AUDIO`
- Android ≤12：`READ_EXTERNAL_STORAGE`
- iOS：`NSAppleMusicUsageDescription`

## 与桌面端共享

- `@shuyin/core`：LocalTrack / ScanResult / PlaybackQueue 状态机（file: 引用 + metro watchFolders）
- `@shuyin/theme-engine`：ThemeTokens / 内置主题 / 校验 / 启动页共享参数
