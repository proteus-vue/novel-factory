# Security Policy

## 支持的版本

当前仓库持续维护最新主线版本。安全修复发布在 GitHub Releases。

## 凭证处理（重要）

本项目**不在源码仓库存放任何密钥**：

- **LLM API Key**：只在 App 内「创作设置」页填写，或服务端用 `NOVEL_LLM_API_KEY` 环境变量注入，存本机不上传。
- **Android 签名密钥**：`.jks`/`.base64` 放在被忽略的 `secrets/` 目录，签名密码只从 `ANDROID_STORE_PASSWORD` / `ANDROID_KEY_PASSWORD` 环境变量读取。CI 构建用 GitHub Actions Secrets。
- **GitHub Token**：发布脚本用 `GITHUB_TOKEN` 环境变量，仓库内只有占位示例。

如果你在提交历史或代码中发现疑似泄露的凭证，请立即通过下方渠道报告，不要公开 issue。

## 报告漏洞

请通过 GitHub Security 的「Report a vulnerability」（私有报告）提交，包含：

- 受影响版本与组件
- 复现步骤或最小 PoC
- 潜在影响与建议修复

我们会在 72 小时内确认，修复后发布版本并致谢（如你愿意）。

## 数据隐私

- 纯前端自包含 App：作品正文、设置、成就全部存设备本机（localStorage），不联网上传；灵动岛、原生阅读器仅本地运行。
- C/S 平台：作品数据存服务端 `.factory-data/`，由部署方自行负责访问控制与备份；该目录已被 `.gitignore` 排除，不会随源码分发。
