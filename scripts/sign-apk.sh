#!/usr/bin/env bash
# 用 release 密钥给 unsigned APK 签名并对齐（CI 调用，也可本地用）。
# 用法：KS_B64/密码走环境变量，或传参：
#   ./scripts/sign-apk.sh <unsigned.apk> <out.apk> <keystore.jks> <storePass> <alias> <keyPass>
set -euo pipefail

UNSIGNED="${1:?缺少 unsigned APK}"
OUT="${2:?缺少输出路径}"
KS="${3:-${ANDROID_KEYSTORE:-}}"
STORE_PASS="${4:-${ANDROID_STORE_PASSWORD:-}}"
ALIAS="${5:-${ANDROID_KEY_ALIAS:-}}"
KEY_PASS="${6:-${ANDROID_KEY_PASSWORD:-}}"

for v in "$KS" "$STORE_PASS" "$ALIAS" "$KEY_PASS"; do
  [ -n "$v" ] || { echo "签名参数不全（keystore/密码/别名）" >&2; exit 1; }
done
[ -f "$KS" ] || { echo "keystore 不存在：$KS" >&2; exit 1; }

# 定位 apksigner（CI 预装 Android SDK；本地用 ANDROID_HOME/ANDROID_SDK_ROOT）
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
APKSIGNER=""
if [ -n "$SDK" ]; then
  APKSIGNER="$(find "$SDK/build-tools" -name apksigner -type f 2>/dev/null | sort -V | tail -1 || true)"
fi
APKSIGNER="${APKSIGNER:-$(command -v apksigner || true)}"
[ -n "$APKSIGNER" ] || { echo "找不到 apksigner：请设 ANDROID_HOME 指向 Android SDK" >&2; exit 1; }

# zipalign 优先（若可用），再签名
ZIPALIGN=""
if [ -n "$SDK" ]; then
  ZIPALIGN="$(find "$SDK/build-tools" -name zipalign -type f 2>/dev/null | sort -V | tail -1 || true)"
fi
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
if [ -n "$ZIPALIGN" ]; then
  "$ZIPALIGN" -p -f 4 "$UNSIGNED" "$WORK/aligned.apk"
  TO_SIGN="$WORK/aligned.apk"
else
  TO_SIGN="$UNSIGNED"
fi

# 新版 apksigner（build-tools 34+）用 --ks-key-alias，旧版用 --key-alias；
# 检测支持哪种参数名（alias 必须跟在 sign 子命令之后）。
HELP="$("$APKSIGNER" sign --help 2>&1)"
if echo "$HELP" | grep -q -- '--ks-key-alias'; then
  ALIAS_FLAG="--ks-key-alias"
elif echo "$HELP" | grep -q -- '--key-alias'; then
  ALIAS_FLAG="--key-alias"
else
  ALIAS_FLAG=""   # 单密钥 keystore 可省略，工具自动选择
fi

SIGN_ARGS=(sign --ks "$KS" --ks-pass "pass:$STORE_PASS" --key-pass "pass:$KEY_PASS")
[ -n "$ALIAS_FLAG" ] && SIGN_ARGS+=("$ALIAS_FLAG" "$ALIAS")
SIGN_ARGS+=(--v1-signing-enabled true --v2-signing-enabled true --out "$OUT" "$TO_SIGN")

"$APKSIGNER" "${SIGN_ARGS[@]}"

"$APKSIGNER" verify --print-certs "$OUT"
echo "已签名：$OUT"
