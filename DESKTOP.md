# 小说工厂 · 桌面工作站

桌面版是「完整创作工作站」：把 C/S 平台的编排层（Node）+ 大禹 MCP 一起装进桌面应用，装好即用，无需另配服务器。写稿 → 大禹过程评审 → 獬豸终审 → 打回重写 → 定稿，全自动后台跑，支持长时间挂机。

## 能力

- **真·编排层**：Electron 以 `ELECTRON_RUN_AS_NODE` 拉起本地 `dist/index.js serve`，绑定 `127.0.0.1` 随机端口，走与 Web 平台完全相同的 REST API 和多作品仓库。
- **大禹内置**：Node 版大禹 MCP 随包捆绑（含 rules.yaml / prompts.md / platforms.yaml），配置用 `CDA_CONFIG_DIR` 指向包内目录，无需用户安装。
- **獬豸智能降级**：若系统有 Python 3.9+，用真·獬豸终审；否则编排层自动降级为「只用大禹」，功能不中断（与 Web/CI 同策略）。
- **桌面增强**：系统托盘常驻（关窗口最小化到托盘，创作继续）、原生菜单、全局快捷键（`Ctrl/Cmd+Shift+N` 新建、`Ctrl/Cmd+Shift+R` 开始、`Ctrl/Cmd+Q` 退出）、创作进度/完本系统通知、打开数据目录、系统对话框导入/导出备份、拖入托盘导入。
- **数据自主**：作品与设置存在 `app.getPath('userData')/works`，不写入安装目录；导入/导出/清空/恢复出厂与移动版一致。

## 构建

需 Node 20+、pnpm、Electron 二进制（首次安装会下载，可用国内镜像）：

```bash
# 若下载 Electron 二进制受阻，设置镜像
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
pnpm install

pnpm electron:build:win      # Windows → release-desktop/小说工厂-Setup-<版本>-x64.exe
pnpm electron:build:linux    # Linux   → AppImage + deb
pnpm electron:build:mac      # macOS   → dmg + zip
pnpm electron:build:all      # 三平台一次构建
```

产物在 `release-desktop/`。构建脚本会先 `pnpm build`（tsc 编译编排层）再打包。

## 安装说明

- **Windows**：`小说工厂-*-win-x64-portable.exe` 是**免安装绿色版**，双击即运行（无需 wine/安装）。若在 Mac 上构建，可用 `pnpm electron:build:win` 产出 NSIS 安装包（带安装向导/快捷方式）。
- **Linux**：AppImage 赋予可执行权限后直接运行（`chmod +x *.AppImage && ./novel-factory-*.AppImage`）；deb 用 `sudo dpkg -i novel-factory-*-amd64.deb` 安装。
- **macOS**：交付 **zip**（解压得 `小说工厂.app`，拖入「应用程序」即可）。⚠️ 未做 Apple 签名与公证（需在 Mac + 付费开发者账号下完成）。首次打开若被 Gatekeeper 拦截，用右键「打开」，或执行 `xattr -cr "/Applications/小说工厂.app"` 后打开；也可临时 `sudo spctl --master-disable`。在 Mac 上跑 `pnpm electron:build:mac` 可产出正式 dmg 并签名公证。

> 关于在 Linux 沙箱内交叉构建：NSIS 安装包需 `wine`、dmg 需 macOS 的 `sips/hdiutil`，均无法在纯 Linux 环境完成，故 Windows 采用 portable 绿色版、macOS 采用 zip——两者都是可直接运行的有效桌面产物。原生平台构建可获得完整安装包体验。

### 构建网络提示

国内网络下载 Electron/辅助工具可能受阻，构建前可设置镜像：

```bash
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
pnpm install    # electron 二进制走镜像
# electron-builder 的 nsis/winCodeSign/dmg 等工具如需代理，用：
# export ELECTRON_BUILDER_BINARIES_DOWNLOAD_OVERRIDE_URL="http://127.0.0.1:<本地代理端口>"
```

## 快捷键与托盘

| 操作 | 快捷键 |
|---|---|
| 新建作品 | `Ctrl/Cmd + Shift + N` |
| 开始创作（跳最近作品） | `Ctrl/Cmd + Shift + R` |
| 退出 | `Ctrl/Cmd + Q` |

托盘右键：打开主窗口 / 新建 / 开始创作 / 打开数据目录 / 导入备份 / 最小化到托盘开关 / 重启编排服务 / 关于 / 退出。

## 架构

```
Electron 主进程 (desktop/main.cjs, CommonJS)
 ├─ 单实例锁 / BrowserWindow / 托盘 / 原生菜单 / 全局快捷键 / 系统通知
 ├─ spawn(process.execPath, [dist/index.js, serve], ELECTRON_RUN_AS_NODE=1)
 │    └─ 内嵌编排服务：127.0.0.1:<随机端口>
 │         ├─ createServer()  REST API + 静态控制台(src/console)
 │         ├─ TaskRunner / Pipeline  多作品串行队列
 │         ├─ 大禹 MCP (desktop/mcp/dayu, node, 随包)  ← 过程评审/打回判据
 │         └─ 獬豸 MCP (系统 python, 可选)              ← 终审，缺失自动降级
 └─ preload.cjs  contextIsolation 下的受控桌面 API
```

## 数据目录与隐私

- 作品正文、设置、成就、灵动岛进度全部本地存储，不联网上传（仅创作时调用你填写的 LLM 端点）。
- 数据根目录：`app.getPath('userData')/works`；Windows 通常为 `%APPDATA%/小说工厂/works`，macOS 为 `~/Library/Application Support/小说工厂/works`，Linux 为 `~/.config/小说工厂/works`。
- 备份导出为 JSON，含作品/设置/成就；导入会二次确认并覆盖当前数据。

## 已知限制

- macOS 未签名/公证（见安装说明）。
- 獬豸需系统 Python；无 Python 时只有大禹过程评审，无独立终审打分（功能仍可用）。
- 编排层单进程串行执行，一次只跑一部作品（与 Web 平台一致，避免多个 MCP 子进程抢资源）。
