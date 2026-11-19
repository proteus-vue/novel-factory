#!/usr/bin/env bash
# 把定稿 PWA 打成本地可安装 APK（不上架商店，直接adb/传文件安装）。
# 前置：JDK 21（实测 Capacitor 7.4.2 的库以 Java 21 源码编译，JDK 17 会报 invalid source release: 21）、Android SDK（ANDROID_HOME）、Gradle（用 wrapper）。
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[1/4] 确认定稿与 PWA 产物"
if [ ! -f .factory-run/run.json ]; then
  echo "缺少运行记录，请先跑：pnpm build && pnpm run run" >&2
  exit 1
fi
pnpm run publish:app

echo "[2/4] 安装 Capacitor 依赖（若缺）"
node -e "require.resolve('@capacitor/cli')" 2>/dev/null || pnpm add -D @capacitor/cli @capacitor/core @capacitor/android

echo "[3/4] 初始化 / 同步 Android 工程"
if [ ! -d android ]; then
  npx cap add android
else
  npx cap sync android
fi

echo "[4/4] 构建 debug APK"
cd android
./gradlew assembleDebug --no-daemon 2>/dev/null || gradle assembleDebug --no-daemon
cd ..
APK=$(find android/app/build/outputs/apk -name '*.apk' | head -1)
echo "APK 已生成：$APK"
echo "安装到设备：adb install -r $APK"
