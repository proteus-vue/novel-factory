# Contributing

欢迎贡献流水线规则、评审判据、平台档案、UI 组件、测试用例与文档。

## 开发环境

```bash
pnpm install
pnpm build          # tsc → dist/
pnpm test           # vitest 单测 + 回归
pnpm run build:standalone   # 烘焙自包含 PWA → dist-platform/
```

构建可安装 APK 需要 Java 21 + Android SDK，且签名凭证只从环境变量读取：

```bash
export ANDROID_STORE_PASSWORD="..."      # 签名库密码
export ANDROID_KEY_ALIAS="novel"         # 别名
export ANDROID_KEY_PASSWORD="..."        # 密钥密码（可与库密码相同）
bash scripts/build-release.sh out.apk
```

切勿把密码、keystore、token 写进仓库。详见 [SECURITY.md](./SECURITY.md)。

## 项目结构

- `src/`：编排层（pipeline 流水线、runner 任务队列、repo 作品仓库、server HTTP 服务、llm 写稿客户端）。
- `src/console/`：创作者控制台（原生 JS SPA，无框架）。`app.js` 路由/交互、`pipeline.js` 数据层、`engine.js`/`operations.js` 演示与运营代理。
- `android/`：Capacitor Android 工程；`cn.kags.novelfactory` 原生层含前台服务、六智能体引擎、JSBridge、原生阅读器。
- `scripts/`：构建/签名/部署/发布脚本。
- `test/`：回归与数据管理单测。

## 修改约定

1. **评审判据**在大禹/獬豸两个 MCP 仓库维护，本仓只做编排调用，不在引擎里硬编码阈值。
2. **新增设置项**同步改 `src/console/index.html`（表单）、`app.js`（读写）、`pipeline.js`（默认值与持久化），保持单一数据流。
3. **原生与浏览器双端**能力要对齐：原生走 `NativeBridge`，浏览器走内置演示引擎；新增功能两端都要能跑通。
4. **规范图标**：UI 一律用 SVG symbol（`<use href="#i-xxx"/>`），禁止 emoji 图标。
5. **凭证零入库**：任何密钥、密码、token 只走环境变量或 GitHub Actions Secrets。

## 提交前检查

```bash
pnpm build && pnpm test
git status                 # 确认无 secrets/、*.jks、*.apk、作品数据被纳入
```
