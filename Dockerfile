# 小说工厂 · 全自动创作平台（C/S 服务端）一键部署镜像
# 内含：novel-factory 编排 + 大禹(node MCP) + 獬豸(python MCP) + 创作者控制台
# 构建上下文必须是三个项目的父目录（/workspace），见 docker-compose.yml
#   docker compose up -d --build

FROM node:22-bookworm-slim

# 运行环境：Python3 + pip（獬豸 MCP）、时区、CA
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip tzdata ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && ln -snf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && echo Asia/Shanghai > /etc/timezone

# 注意：不设 NODE_ENV=production，否则 npm 会跳过 devDependencies 导致 tsc 缺失、prepare 钩子失败
ENV TZ=Asia/Shanghai \
    NOVEL_FACTORY_DATA=/app/data \
    PORT=8787 \
    HOST=0.0.0.0 \
    DAYU_ENTRY=/app/novel-cda-mcp/dist/index.js \
    XIEZHI_ENTRY=/app/novel-review-mcp/src/server.py \
    XIEZHI_CWD=/app/novel-review-mcp/src

WORKDIR /app

# ---------- 大禹（Node MCP）：一次拷入全部源码，npm install 的 prepare 钩子自动 build ----------
COPY novel-cda-mcp/ /app/novel-cda-mcp/
WORKDIR /app/novel-cda-mcp
RUN npm install --no-audit --no-fund && npm run build

# ---------- 獬豸（Python MCP）----------
WORKDIR /app
COPY novel-review-mcp/src/requirements.txt /app/novel-review-mcp/requirements.txt
RUN pip3 install --break-system-packages --no-cache-dir -r /app/novel-review-mcp/requirements.txt
COPY novel-review-mcp/ /app/novel-review-mcp/

# ---------- novel-factory 编排 + 控制台 ----------
COPY novel-factory/package.json /app/novel-factory/package.json
WORKDIR /app/novel-factory
RUN npm install --no-audit --no-fund
COPY novel-factory/ /app/novel-factory/
RUN npm run build

VOLUME ["/app/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+process.env.PORT+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/index.js", "serve"]
