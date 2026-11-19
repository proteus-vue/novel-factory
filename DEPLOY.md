# 小说工厂 · 三种交付形态与部署指南

小说工厂有**三种形态**，按你的设备条件选一种即可：

| 形态 | 产物 | 需要什么 | 能力 | 适合 |
|---|---|---|---|---|
| **① 纯前端自包含 App** | APK / PWA 静态目录 | 只需手机；填 LLM 密钥 | 内嵌大禹+獬豸精简评审，全自动写→编审→定稿→发布，离线可用 | **没电脑、要装上就能用**（推荐你用这个） |
| ② C/S 平台 | Docker 镜像 | 一台常驻云主机 | 完整 MCP（大禹 27 工具 + 獬豸完整评审）、多用户、可长期跑 | 接真模型大批量量产 |
| ③ 阅读器 APK | 读者端 APK | 手机 | 只看定稿（无创作能力） | 分发给读者 |

---

## ① 纯前端自包含 App（推荐）

评审引擎已用 TypeScript 重写内嵌进 App，数据存手机本地，**不依赖任何服务器**。生成的 APK 装上即可全自动创作；只需在「创作设置」填一个 OpenAI 兼容的 LLM 端点（留空则用内置演示引擎体验流程）。

### 重新构建
```bash
pnpm install
pnpm run build:standalone   # 生成 dist-platform/（零服务端依赖 PWA）
# 打 APK：
npx cap sync android
cd android && ./gradlew assembleRelease
# 签名后用 release/ 下的 APK 安装
```

### 直接当 PWA 用
把 `dist-platform/` 目录用任意静态托管（GitHub Pages / Vercel / `python3 -m http.server`）发布，手机浏览器打开 → 添加到主屏，即可离线使用。

### 能力边界（诚实说明）
- 内嵌评审是**大禹规则内核的完整移植 + 獬豸合规精简扫描**，与服务端完整 MCP 的差别：獬豸的「三审+红队+对标+盲评」语义级能力未移植（那些本来就要调 LLM），内嵌版用合规词表扫描近似。
- 打回重写、L1 形态红线、L2 词表打分、自洽/节奏弱信号、伏笔抽取——这些确定性判据**全部内嵌、与服务端一致**。

---

## ② C/S 平台（Docker 一键部署）

适合要接真模型、长期量产、多人协作的场景。镜像内含 novel-factory + 大禹 + 獬豸 + 控制台，一条命令起服务。

### 前置
- 一台有 Docker 的云主机（2C4G 起；装 Docker 和 docker compose 插件）
- 三个项目源码在同一目录：构建上下文需包含 `novel-factory/`、`novel-cda-mcp/`、`novel-review-mcp/`

### 部署
```bash
cd <三项目父目录>            # 例如 /workspace
cp novel-factory/.env.example novel-factory/.env
# 编辑 .env 填 NOVEL_LLM_API_KEY 等（不填用演示引擎）

./novel-factory/scripts/deploy.sh up       # 构建并启动
./novel-factory/scripts/deploy.sh status   # 看健康状态
./novel-factory/scripts/deploy.sh logs     # 看日志
```
浏览器打开 `http://<服务器IP>:8787/` 即创作者控制台。

数据持久化在 `novel-factory/data/`，重启不丢。停止用 `deploy.sh down`。

### 也可用原生 compose 命令
```bash
docker compose -f novel-factory/docker-compose.yml up -d --build
```

### 环境变量（.env）
| 变量 | 作用 | 默认 |
|---|---|---|
| `PORT` | 宿主机映射端口 | 8787 |
| `NOVEL_LLM_BASE_URL` | OpenAI 兼容端点 | 空→演示引擎 |
| `NOVEL_LLM_API_KEY` | 模型密钥 | 空 |
| `NOVEL_LLM_MODEL` | 模型名 | gpt-4o-mini |

> LLM 密钥也可在控制台「创作设置」页直接填（存服务端 settings.json），不必用 .env。

---

## ③ 读者端 APK（分发定稿）

定稿一键烘焙成 PWA 阅读器，再打 APK 分发给读者。见 [PUBLISH.md](./PUBLISH.md) / [CI-RELEASE.md](./CI-RELEASE.md)。

---

## 该选哪个？

- **你现在没电脑** → 用 ① 的 APK，装到手机上，填个 LLM 密钥就能全自动写书。
- 以后有云主机、要 7×24 量产 → 上 ② 的 Docker 平台，能力最完整。
- 要把写好的书给读者看 → ③。

三种形态共用同一套规则内核与数据格式，作品可在它们之间迁移（定稿均为标准 draft.json）。
