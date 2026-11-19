#!/usr/bin/env bash
# 小说工厂 · 一键部署到任意云主机（有 Docker 即可）
# 用法：
#   cp .env.example .env    # 填 LLM 密钥（可选，不填用演示引擎）
#   ./scripts/deploy.sh up     # 构建并启动
#   ./scripts/deploy.sh logs   # 看日志
#   ./scripts/deploy.sh down   # 停止
#   ./scripts/deploy.sh status # 看状态
set -euo pipefail

# 脚本在 novel-factory/scripts/，父目录是项目根，再上一级是构建上下文（三项目父目录）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONTEXT_DIR="$(cd "$APP_DIR/.." && pwd)"
COMPOSE_FILE="$APP_DIR/docker-compose.yml"

cd "$CONTEXT_DIR"

# 加载 .env（若在项目根或上下文根）
if [ -f "$APP_DIR/.env" ]; then set -a; source "$APP_DIR/.env"; set +a; fi
if [ -f "$CONTEXT_DIR/.env" ]; then set -a; source "$CONTEXT_DIR/.env"; set +a; fi

case "${1:-up}" in
  up)
    echo "构建并启动小说工厂平台…"
    mkdir -p "$APP_DIR/data"
    docker compose -f "$COMPOSE_FILE" up -d --build
    echo "启动完成。控制台：http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo 服务器IP):${PORT:-8787}/"
    docker compose -f "$COMPOSE_FILE" ps
    ;;
  logs)
    docker compose -f "$COMPOSE_FILE" logs -f --tail=100
    ;;
  down)
    docker compose -f "$COMPOSE_FILE" down
    echo "已停止（数据保留在 data/ 目录）"
    ;;
  restart)
    docker compose -f "$COMPOSE_FILE" restart
    ;;
  status)
    docker compose -f "$COMPOSE_FILE" ps
    echo "--- 健康 ---"
    curl -s "http://127.0.0.1:${PORT:-8787}/api/health" || echo "服务未就绪"
    ;;
  *)
    echo "用法: $0 {up|logs|down|restart|status}"; exit 1
    ;;
esac
