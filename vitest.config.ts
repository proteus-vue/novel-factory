import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,   // 多个测试都要启动 MCP 子进程，串行避免端口/资源竞争
  },
});
