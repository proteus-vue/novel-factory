#!/usr/bin/env bash
# 一次性生成 release 签名密钥（在你本地跑一次即可，产物绝不入库）。
# 用法：./scripts/gen-keystore.sh [输出目录]
# 跑完把打印出的 4 个值填进 GitHub Secrets：
#   ANDROID_KEYSTORE_BASE64 / ANDROID_STORE_PASSWORD / ANDROID_KEY_ALIAS / ANDROID_KEY_PASSWORD
set -euo pipefail
OUT="${1:-./secrets}"
mkdir -p "$OUT"

KS="$OUT/novel-release.jks"
ALIAS="novel"
PASS="$(openssl rand -base64 24 | tr -d '/+=')"

# 用 JKS 格式，storepass 与 keypass 一致，避免 PKCS12 忽略 keypass 造成 CI 签名 pass 不一致
keytool -genkeypair -v \
  -keystore "$KS" -storetype JKS -alias "$ALIAS" \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass "$PASS" -keypass "$PASS" \
  -dname "CN=Novel Factory, OU=Kags, O=Kags, L=Beijing, ST=Beijing, C=CN"

base64 -w0 "$KS" > "$OUT/keystore.base64"

echo
echo "========== 请填入 GitHub Secrets =========="
echo "ANDROID_KEYSTORE_BASE64 = （内容见 $OUT/keystore.base64，整段复制）"
echo "ANDROID_STORE_PASSWORD  = $PASS"
echo "ANDROID_KEY_ALIAS       = $ALIAS"
echo "ANDROID_KEY_PASSWORD    = $PASS"
echo "=========================================="
echo "密钥文件：$KS"
echo "base64 文件：$OUT/keystore.base64"
echo "请妥善保管，丢失后无法对同一 App 覆盖升级；切勿提交到仓库。"
