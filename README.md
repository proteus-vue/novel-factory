# novel-factory · 小说工厂（全自动创作平台）

一个完整的**小说工业化创作平台**：把两个 MCP（[大禹](https://github.com/proteus-vue/novel-cda-mcp)司约束、[獬豸](https://github.com/proteus-vue/novel-review-mcp)司评审）+ 写稿 Agent 串成全自动流水线，提供 Web 创作者控制台与**可安装的纯前端自包含 App**，做到「给个方向 → 自动写完全书 → 自动编审 → 定稿 → 一键发布阅读器」。

```
立项建笼子 → 章纲先行 → 逐章写稿(LLM) → 大禹过程评审 → 打回则回流重写 → 獬豸终审 → 定稿 → 发布阅读器
```

核心闭环已验证：油腻词/裸数字触发打回 → `next_chapter_brief` 回流 → 重写通过（见 `test/regression.test.ts`）。

> 不上架应用商店。产物为可下载安装的 APK / PWA，或自托管的 C/S 平台。

## 亮点

- **全自动流水线**：写稿 → 大禹过程评审 → 獬豸终审 → 打回重写 → 定稿，全程无人值守。
- **纯前端自包含 App**：评审引擎内嵌，只需填 LLM Key，离线可跑，零服务器。
- **原生后台创作**：Foreground Service + 常驻通知 + WakeLock，锁屏后仍长时间自动跑。
- **六智能体 + 灵动岛**：多角色编排，App 内常驻进度胶囊展示章节进度与流水线阶段。
- **运营与荣誉**：运营代理「麒麟」、成就墙、庆祝动效，提升创作氛围感。
- **数据自主**：作品存本机，支持备份导出/导入、清空、恢复出厂。

## 三种交付形态

| 形态 | 产物 | 需要 | 能力 |
|---|---|---|---|
| **① 纯前端自包含 App**（推荐） | APK / `dist-platform/` PWA | 手机 + 一个 LLM Key | 内嵌评审引擎，全自动写→编审→定稿，离线可用，**零服务器** |
| ② C/S 平台 | Docker 镜像 | 一台云主机 | 完整 MCP、多作品、可长期量产 |
| ③ 读者端 | 阅读器 APK / PWA | 手机 | 只看定稿 |

能力边界与部署步骤详见 [DEPLOY.md](./DEPLOY.md)。

## 快速开始

### 纯前端 App（拿 APK 装到手机即可）

到 [Releases](../../releases) 下载最新 APK，安装后在「创作设置」填 OpenAI 兼容的 API 地址/Key/模型即可开始。留空 Key 会用**内置演示引擎**体验完整流程（内容固定，仅用于演示）。

从源码自行构建：

```bash
pnpm install
pnpm run build:standalone   # 烘焙自包含 PWA → dist-platform/
# APK 构建需 Java 21 + Android SDK，见下方「构建 APK」
```

### C/S 平台（源码运行）

需要 Node.js 20+，并把大禹、獬豸两个 MCP 克隆到本地（或用环境变量指向其入口）。

```bash
pnpm install
pnpm build
export DAYU_ENTRY=/path/to/novel-cda-mcp/dist/index.js
export XIEZHI_ENTRY=/path/to/novel-review-mcp/src/server.py
pnpm platform          # = node dist/index.js serve，默认 http://localhost:8787
```

浏览器打开 `http://localhost:8787/` 进入创作者控制台：

1. **创作设置**：填 OpenAI 兼容的 API 地址/Key/模型（留空用演示引擎）。
2. **新建作品**：填书名/平台/题材，选爽点/反派类型、章节数 → 自动规划章节。
3. **开始创作**：工作台实时看逐章写稿/大禹评审/獬豸终审日志与进度；打回自动重写。
4. **编审报告**：点任一章节看正文、L1/L2 评审、终审详情。
5. **导出/发布**：导出 Markdown 定稿；一键发布阅读器。

监听地址：`PORT=9000 HOST=0.0.0.0 pnpm platform`。Docker 部署见 [DEPLOY.md](./DEPLOY.md)。

## 构建 APK

需要 Java 21、Android SDK，以及签名密钥（本地生成，见 `scripts/gen-keystore.sh`）。签名凭证只从环境变量读取，**绝不入库**：

```bash
export ANDROID_STORE_PASSWORD="..."     # 签名库密码
export ANDROID_KEY_ALIAS="novel"        # 别名
export ANDROID_KEY_PASSWORD="..."       # 密钥密码
bash scripts/build-release.sh ./小说工厂.apk
```

CI 自动构建并签名发布到 Release 的配置见 [CI-RELEASE.md](./CI-RELEASE.md)；定稿发布流程见 [PUBLISH.md](./PUBLISH.md)。

## 底层 CLI（无 Web 时可用）

```bash
pnpm start run              # 跑单作品流水线（读 .factory-run/spec.json，断点续跑）
pnpm start status           # 查看进度
pnpm start export           # 导出定稿
pnpm run publish:app        # 定稿 → PWA（.factory-run/app/）
pnpm start publish <draft.json> <dir>   # CI：从定稿直接烘焙，不连 MCP
pnpm test                   # 单测 + 回归
```

## 环境变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `PORT` | 平台 HTTP 端口 | `8787` |
| `HOST` | 监听地址 | `0.0.0.0` |
| `NOVEL_FACTORY_DATA` | 数据根目录 | `./.factory-data`（CLI `run` 用 `./.factory-run`） |
| `NOVEL_LLM_BASE_URL` | OpenAI 兼容端点 | 空 → 演示引擎 |
| `NOVEL_LLM_API_KEY` | API key | 空 → 演示引擎 |
| `NOVEL_LLM_MODEL` | 模型名 | `gpt-4o-mini` |
| `NOVEL_FACTORY_NO_XIEZHI` | 设 `1` 禁用獬豸终审 | 空（启用） |
| `DAYU_ENTRY` / `XIEZHI_ENTRY` | 两个 MCP 的入口路径 | 相对路径占位 |
| `DAYU_CMD` / `XIEZHI_CMD` | MCP 启动命令 | `node` / `python3` |
| `ANDROID_STORE_PASSWORD` / `ANDROID_KEY_ALIAS` / `ANDROID_KEY_PASSWORD` | APK 签名凭证 | 空（构建 APK 必填） |

## 数据契约

作品设定由 `repo.ts` 在新建时自动规划（`wordType` 决定字数区间）。定位枚举由大禹 `rules.yaml` 定义，自由输入会归一化到合法值：

- 爽点类型：打脸碾压 / 解谜智性 / 无声反杀 / 清醒退出 / 情感共鸣
- 反派类型：敌人 / 规则 / 结构
- 情感契约：爽 / 解谜 / 共鸣 / 治愈 / 陪伴
- wordType：静场 / 常规 / 反击 / 高潮 / 极短

作品目录：`.factory-data/works/<id>/`，各作品互不干扰；该目录含正文，**不入库**。

## 路线图

- [x] 流水线核心（写稿 + 大禹 + 獬豸 + 回流 + 定稿）
- [x] Web 阅读器 + 编审面板（PWA）
- [x] 创作者平台：多作品仓库 + 后台任务队列 + Web 控制台
- [x] 纯前端自包含 App：评审引擎内嵌 + 本地存储 + 离线 PWA/APK
- [x] 原生 Foreground Service 后台创作 + 六智能体 + 灵动岛
- [x] Docker 一键部署 C/S 平台
- [x] 数据管理 / 界面偏好 / 荣誉体系 / 原生阅读器
- [ ] 用户账号与多租户

## 致谢与许可

编排层与 App 采用 [MIT](./LICENSE) 许可。评审能力来自两个独立 MCP：[大禹](https://github.com/proteus-vue/novel-cda-mcp)、[獬豸](https://github.com/proteus-vue/novel-review-mcp)。
