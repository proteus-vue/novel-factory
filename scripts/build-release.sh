#!/usr/bin/env bash
# 一键构建可安装 release APK（防呆版）。
# 关键：web 资源必须经过 build:standalone → cap sync 的标准链路，
# 严禁把 src/console 源码直接 cp 到 assets（源码用 /console/ 绝对路径，WebView 会 404 白屏）。
set -euo pipefail
cd "$(dirname "$0")/.."

# 本 App 的 Capacitor 7 依赖以 Java 21 源码编译，必须用 JDK21（JDK17/20 会报 invalid source release: 21）
export JAVA_HOME="/opt/jdk/jdk-21.0.2"
export PATH="$JAVA_HOME/bin:$PATH"
export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"

OUT="${1:-./小说工厂-最新版.apk}"
KS="${ANDROID_KEYSTORE:-secrets/novel-release.jks}"
ALIAS="${ANDROID_KEY_ALIAS:-novel}"
# 签名凭证只从环境变量读取，禁止写入仓库（本地可放 secrets/ 或 shell profile）
STORE_PASS="${ANDROID_STORE_PASSWORD:-}"
KEY_PASS="${ANDROID_KEY_PASSWORD:-$STORE_PASS}"
[ -n "$STORE_PASS" ] || { echo "缺少 ANDROID_STORE_PASSWORD 环境变量" >&2; exit 1; }

echo "[1/5] 构建自包含 PWA（相对路径 + SW + manifest）"
node scripts/build-standalone.mjs

echo "[2/5] cap sync：dist-platform → android assets（唯一正确的同步入口）"
npx cap sync android

echo "[3/5] 防呆校验：assets/index.html 不得含 /console/ 绝对路径"
if grep -q '/console/' android/app/src/main/assets/public/index.html; then
  echo "错误：assets/index.html 含 /console/ 绝对路径，WebView 会白屏！" >&2
  exit 1
fi
for f in app.css app.js engine.js pipeline.js operations.js sw.js manifest.webmanifest; do
  [ -f "android/app/src/main/assets/public/$f" ] || { echo "缺少资源：$f" >&2; exit 1; }
done
echo "  校验通过"

echo "[4/5] gradle assembleRelease"
(cd android && ./gradlew assembleRelease --no-daemon)

echo "[5/5] 签名 + 验签"
bash scripts/sign-apk.sh \
  android/app/build/outputs/apk/release/app-release-unsigned.apk \
  "$OUT" "$KS" "$STORE_PASS" "$ALIAS" "$KEY_PASS"

echo "完成：$OUT"
