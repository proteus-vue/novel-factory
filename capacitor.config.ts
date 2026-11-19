import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Capacitor 配置：把自包含创作平台 PWA 打成本地可安装 APK。
 * webDir = dist-platform（由 `pnpm run build:standalone` 生成的零服务端依赖 App）。
 * App 内嵌大禹/獬豸评审引擎，装后即可全自动创作，无需服务器。
 */
const config: CapacitorConfig = {
  appId: "cn.kags.novelfactory",
  appName: "小说工厂",
  webDir: "dist-platform",
  android: {
    // 允许 http 静态资源加载（本地 file 加载，无远程内容）
    allowMixedContent: false,
  },
  // 不上架商店：不需要 iOS 目标，仅 Android
  plugins: {},
};

export default config;
