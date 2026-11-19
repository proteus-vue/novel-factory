# 定稿发布：从流水线到可安装 App

Publisher 把大禹 + 獬豸编审后的定稿，烘焙成**自包含、可离线、可安装**的阅读 App。
数据随构建期注入 `index.html`，运行时零网络请求；书架、字号、主题、阅读进度存在本机。

## 三种形态，按成熟度递进

| 形态 | 安装方式 | 前置条件 | 适用 |
|---|---|---|---|
| **PWA（默认产出）** | 浏览器打开 → 「添加到主屏幕」 | 任意静态托管 / 本地 `pnpm serve` | 最快，无需 SDK，iOS/Android 均可 |
| **TWA / 壳 App** | 应用宝或自分发 APK | Capacitor + Android SDK | 想要独立桌面图标与启动页 |
| **离线分发包** | 传 APK 直接安装 | 同上 | 内网 / 无商店场景 |

> 不上架官方商城：跳过应用审核，用 `adb install` 或把 APK 发到设备直接安装即可。
> 未使用 uni-app —— 前端是零框架原生 HTML/CSS/JS，Capacitor 只负责套壳，最稳、依赖最少。

## 生成 PWA（秒级，零外部依赖）

```bash
pnpm build
pnpm run run           # 或已有 run.json 时跳过
pnpm run publish:app   # 产出 .factory-run/app/（可离线安装）

pnpm run serve         # http://localhost:4173 本地预览
```

产物结构：

```
.factory-run/app/
├── index.html            # 注入了书名 + 全部章节正文 + 真实编审记录
├── app.css / app.js      # 阅读器 + 编审报告，规范 SVG 图标，无 emoji
├── manifest.webmanifest  # PWA 安装清单（书名动态注入）
├── sw.js                 # 离线缓存 App Shell
└── icon-192.png / icon-512.png
```

安装：用手机浏览器打开托管地址 → 菜单 → 「添加到主屏幕 / 安装应用」。

## 打 Android APK（可选）

前置：**JDK 21**（实测 Capacitor 7.4.2 需 Java 21 源码编译）、**Android SDK**（设 `ANDROID_HOME`，含 platform 35 + build-tools）、网络（首次拉 Gradle/依赖；国内可用阿里云 Maven + Gradle 镜像加速）。

```bash
./scripts/build-apk.sh
# 产出 android/app/build/outputs/apk/debug/app-debug.apk
adb install -r <apk路径>    # 或把 APK 传到手机直接点开安装
```

脚本做了四件事：确保定稿已发布 → 装 Capacitor 依赖 → 生成/同步 `android/` 工程 → `gradlew assembleDebug`。
首次构建较慢（下载 Gradle 与 Android 依赖），之后增量很快。

`capacitor.config.ts` 里 `webDir` 指向 `.factory-run/app`，`appId` 为 `cn.kags.novelfactory`，可按需要改。

## 发布前检查清单

- [ ] `pnpm test` 全绿（含打回重写闭环）
- [ ] 定稿章节数、verdict 符合预期（`pnpm run status`）
- [ ] `pnpm run publish:app` 后 `index.html` 无 `{{` 残留、JSON 可解析
- [ ] 手机浏览器实测：目录、翻章、字号/主题、离线打开、编审报告
- [ ] 若打 APK：签名（`jarsigner`/`apksigner`）后再对外分发；debug 包仅自测
