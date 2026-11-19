#!/usr/bin/env bash
# 全自动发布：建仓(已存在则跳过) → 推代码 → 写 4 个 Secrets → 触发 workflow。
# 前提：GITHUB_TOKEN 具备 repo 创建 + Actions secrets 写权限（详见 CI-RELEASE.md）。
# 用法：GITHUB_TOKEN=ghp_xxx ORG=proteus-vue bash scripts/auto-release.sh
set -euo pipefail
cd "$(dirname "$0")/.."

TOKEN="${GITHUB_TOKEN:-}"
ORG="${ORG:-proteus-vue}"
REPO="novel-factory"
API="https://api.github.com"
AUTH="Authorization: Bearer $TOKEN"
ACCEPT="Accept: application/vnd.github+json"

[ -n "$TOKEN" ] || { echo "缺少 GITHUB_TOKEN" >&2; exit 1; }
[ -f secrets/keystore.base64 ] || { echo "缺少 secrets/keystore.base64，先跑 gen-keystore.sh" >&2; exit 1; }
KS_B64=$(cat secrets/keystore.base64)
# 签名凭证只从环境变量读取（见 CI-RELEASE.md），禁止写入仓库
STORE_PASS="${ANDROID_STORE_PASSWORD:-}"
KEY_ALIAS="${ANDROID_KEY_ALIAS:-novel}"
KEY_PASS="${ANDROID_KEY_PASSWORD:-$STORE_PASS}"
[ -n "$STORE_PASS" ] || { echo "缺少 ANDROID_STORE_PASSWORD 环境变量" >&2; exit 1; }

api() { curl -sS --max-time 60 -H "$AUTH" -H "$ACCEPT" "$@"; }

echo "[1/5] 确保仓库存在"
if api "$API/repos/$ORG/$REPO" | grep -q '"full_name"'; then
  echo "  仓库已存在"
else
  echo "  创建仓库..."
  api -X POST "$API/orgs/$ORG/repos" \
    -d "{\"name\":\"$REPO\",\"description\":\"小说工业化流水线 + 自动签名发布APK\",\"private\":false,\"auto_init\":false}" \
    | grep -q '"full_name"' || { echo "建仓失败：token 需要组织建仓权限" >&2; exit 1; }
fi

echo "[2/5] 生成 libsodium 加密所需 public key"
api "$API/repos/$ORG/$REPO/actions/secrets/public-key" > /tmp/gh-pk.json
grep -q 'key_id' /tmp/gh-pk.json || { echo "无法读取 secrets public key：token 需要 Actions secrets 写权限" >&2; exit 1; }
KEY_ID=$(python3 -c "import json;print(json.load(open('/tmp/gh-pk.json'))['key_id'])")
PK_B64=$(python3 -c "import json;print(json.load(open('/tmp/gh-pk.json'))['key'])")

python3 -c "import nacl" 2>/dev/null || pip3 install --quiet pynacl

echo "[3/5] 写入 4 个 Secrets（加密后上传）"
put_secret() {
  local name="$1" value="$2"
  local enc
  enc=$(python3 - "$PK_B64" "$value" <<'PY'
import sys, base64
from nacl.public import SealedBox
from nacl.utils import random
pk = base64.b64decode(sys.argv[1])
val = sys.argv[2].encode()
print(base64.b64encode(SealedBox(pk).encrypt(val)).decode())
PY
)
  api -X PUT "$API/repos/$ORG/$REPO/actions/secrets/$name" \
    -d "{\"encrypted_value\":\"$enc\",\"key_id\":\"$KEY_ID\"}" >/dev/null
  echo "  ✓ $name"
}
put_secret ANDROID_KEYSTORE_BASE64 "$KS_B64"
put_secret ANDROID_STORE_PASSWORD "$STORE_PASS"
put_secret ANDROID_KEY_ALIAS "$KEY_ALIAS"
put_secret ANDROID_KEY_PASSWORD "$KEY_PASS"

echo "[4/5] 推送代码（contents API 逐文件，git 443 常超时）"
bash scripts/push-files.sh "$ORG" "$REPO"

echo "[5/5] 触发 workflow_dispatch"
api -X POST "$API/repos/$ORG/$REPO/actions/workflows/release-apk.yml/dispatches" \
  -d '{"ref":"main","inputs":{"draft":"draft/draft.json","tag":"v1.0.0"}}' >/dev/null \
  && echo "  已触发，前往 https://github.com/$ORG/$REPO/actions 查看进度" \
  || echo "  触发失败，可手动到 Actions 页 Run workflow"
