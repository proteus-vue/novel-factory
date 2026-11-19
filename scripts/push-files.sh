#!/usr/bin/env bash
# 用 GitHub contents API 逐文件推送（git 到 443 常超时）。
# 用法：GITHUB_TOKEN=xxx bash scripts/push-files.sh <org> <repo>
set -euo pipefail
cd "$(dirname "$0")/.."
ORG="${1:?缺少 org}"; REPO="${2:?缺少 repo}"
TOKEN="${GITHUB_TOKEN:-${GITHUB_PAT:-}}"; [ -n "$TOKEN" ] || { echo "缺少 GITHUB_TOKEN" >&2; exit 1; }
API="https://api.github.com/repos/$ORG/$REPO/contents"
AUTH="Authorization: Bearer $TOKEN"; ACCEPT="Accept: application/vnd.github+json"

# 忽略：依赖、构建物、运行数据、密钥、git
EXCLUDE='./node_modules/*|./dist/*|./.factory-run/*|./secrets/*|./.git/*|./draft/draft.json.tmp'

push_one() {
  local f="$1" remote="${1#./}" b64
  b64=$(base64 -w0 "$f")
  # 若文件已存在需带 sha 才能更新
  local sha=""
  sha=$(curl -sS --max-time 30 -H "$AUTH" -H "$ACCEPT" "$API/$remote?ref=main" \
        | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('sha',''))" 2>/dev/null || true)
  local payload
  if [ -n "$sha" ]; then
    payload=$(python3 -c "import json,sys;print(json.dumps({'message':'chore: sync $remote','content':'$b64','sha':'$sha','branch':'main'}))")
  else
    payload=$(python3 -c "import json,sys;print(json.dumps({'message':'chore: add $remote','content':'$b64','branch':'main'}))")
  fi
  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' -X PUT --max-time 30 -H "$AUTH" -H "$ACCEPT" "$API/$remote" -d "$payload")
  echo "  [$code] $remote"
}

count=0
while IFS= read -r f; do
  case "$f" in
    ./node_modules/*|./dist/*|./.factory-run/*|./secrets/*|./.git/*) continue ;;
  esac
  push_one "$f"; count=$((count+1))
done < <(find . -type f | sort)
echo "已推送 $count 个文件"
