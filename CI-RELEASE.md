# 自动化发布 APK（GitHub Actions）

定稿入库后，**打一个 `v*` tag 或手动点一下按钮**，CI 自动完成：
烘焙 PWA → Capacitor 生成 Android 工程 → Gradle 构建 → 签名 → 发布到 GitHub Release。
用户在 Release 页下载 APK 直接安装，**不上架商店**。

> 为什么可行：GitHub 的 `ubuntu-latest` runner 预装 Android SDK 与 JDK，配 `android-actions/setup-android` 即可补齐 platform/build-tools；签名密钥通过 Secrets 注入，绝不入仓。

## 一次性准备（本地 + GitHub 各一次）

### 1. 生成签名密钥（你本地跑一次）

```bash
./scripts/gen-keystore.sh          # 默认输出到 ./secrets/（已被 gitignore 忽略）
```

脚本会生成 `secrets/novel-release.jks` 和 `secrets/keystore.base64`，并打印密码。
**密钥丢失后无法对同一 App 覆盖升级，务必离线备份。**

### 2. 在 GitHub 仓库配置 4 个 Secrets

`仓库 → Settings → Secrets and variables → Actions → New repository secret`

| Secret | 值来源 |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `secrets/keystore.base64` 的整段内容 |
| `ANDROID_STORE_PASSWORD` | 脚本打印的密码 |
| `ANDROID_KEY_ALIAS` | `novel` |
| `ANDROID_KEY_PASSWORD` | 同上密码 |

`GITHUB_TOKEN` 由 Actions 自动提供（工作流已声明 `contents: write`），无需手动配。

## 日常发布流程

### 方式 A：打 tag（正式发布）

```bash
# 1. 把最新定稿放到仓库约定路径
cp .factory-run/draft/draft.json draft/draft.json

# 2. 提交并打 tag（推送需要你本人确认执行）
git add draft/draft.json
git commit -m "release: 更新定稿"
git tag v1.0.0
git push origin main --tags
```

push tag 后自动触发 `.github/workflows/release-apk.yml`，几分钟后在 Release 页出现签名的 APK。

### 方式 B：手动触发（测试构建）

`仓库 → Actions → Release APK → Run workflow`，可指定：
- `draft`：定稿 JSON 路径（默认 `draft/draft.json`）
- `tag`：自定义 Release 标签（留空则生成 `run-时间戳`，不会污染正式版本）

## 定稿数据契约

CI 里的定稿就是 `pnpm start export` 产出的 `draft.json`，结构：

```json
{
  "title": "书名",
  "spec": { "projectId": "...", "书名": "...", "平台": "...", "...": "..." },
  "chapters": [
    { "no": 1, "title": "第一章", "text": "正文", "verdict": "通过", "attempts": 1, "review": {} }
  ]
}
```

`publish <draft.json> <输出目录>` 命令从它直接烘焙 PWA，**不连大禹/獬豸、不需要 LLM key**，纯文件操作，CI 可独立运行。

## 固定版本与可维护性

- Capacitor 版本在工作流 `env.CAP_VERSION` 固定（当前 `7.4.2`），避免 CI 漂移。**实测结论：Capacitor 7.4.2 的 `capacitor-android` 库以 Java 21 源码编译，JDK 17 会报 `invalid source release: 21`，必须用 JDK 21**（工作流已改为 21）。compileSdk/targetSdk 35，工作流从生成的 `variables.gradle` 动态读 compileSdk 装 SDK，升级版本不易失效。
- `scripts/sign-apk.sh` 自动探测 apksigner 用 `--ks-key-alias`（build-tools 34+）还是 `--key-alias`（旧版），单密钥也可省略。
- `android/` 工程首次由 `cap add` 生成，之后 `cap sync` 增量同步；如需定制原生配置（应用名、权限、图标），把 `android/` 提交进仓库即可。
- 想换签名/包体配置，改 `capacitor.config.ts`（`appId`、`appName`）。

## 安装到设备

```bash
# 有数据线时
adb install -r novel-reader-v1.0.0.apk

# 或：把 APK 传到手机，点开，允许「安装未知来源应用」
```

## 与本地打包的关系

| 场景 | 命令 | 产物 |
|---|---|---|
| 本地快速验证 PWA | `pnpm run serve` | 浏览器离线可装 |
| 本地打 APK（需 Android SDK） | `./scripts/build-apk.sh` | 本机 debug APK |
| **云端自动签名发布** | push tag / Run workflow | Release 里的 release 签名 APK |

## 检查清单

- [ ] 4 个 Secrets 配齐（尤其 `ANDROID_KEYSTORE_BASE64` 是完整 base64 单行）
- [ ] `draft/draft.json` 是最新定稿、JSON 可解析
- [ ] 首次 `Run workflow` 用测试 tag 验证签名与安装
- [ ] 真机安装成功、正文与编审报告离线可见
- [ ] 正式发布打 `v*` tag，确认 Release 资产可下载
