#!/usr/bin/env node
/**
 * 大禹（CDA 约束驱动创作法，口号「笼中跳舞」）· MCP Server —— 定位/锁定/结构/执行/质检五层 + P1 评审回流。
 * 形象取自「大禹治水」——堵不如疏：建笼子立规矩，让 AI 在规矩里跳舞（对比 novel-review-mcp 的「獬豸」司评审）。
 * 对齐 novel-review-mcp 的 server.py 风格：本文件只做注册 + selfcheck + main，规则全在 yaml/prompts.md。
 *
 * 运行:  node dist/index.js            (stdio，供写稿 Agent 挂载)
 * 自检:  node dist/index.js --selfcheck
 * 诊断:  node dist/index.js --doctor [--json]
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAllTools } from "./tools.js";
import { registerPrompts, registerResources } from "./prompts.js";
import { selfcheckSignals } from "./layers.js";
import { listProfiles, RULE_VERSION, PROMPTS, ruleConsistency } from "./config.js";
import { doctor, formatDoctor } from "./doctor.js";
/** 本地自检：规则/红线/短路/弱信号/闭环，全 true 才算成功（对齐 novel-review-mcp --selfcheck） */
export function selfcheck() {
    const sig = selfcheckSignals();
    const profiles = listProfiles();
    const consistency = ruleConsistency();
    if (consistency.length)
        console.error(`[selfcheck] 规则一致性问题: ${consistency.join(" | ")}`);
    return {
        ...sig,
        rules_consistency_ok: consistency.length === 0,
        rules_version_loaded: RULE_VERSION !== "0.0.0",
        platforms_loaded: profiles.platforms.length >= 4,
        prompts_loaded: profiles.prompt_keys.length >= 4,
        has_build_system_prompt: "build_system_prompt" in PROMPTS,
        has_next_chapter_brief_prompt: "next_chapter_brief_prompt" in PROMPTS,
    };
}
function buildServer() {
    const server = new McpServer({ name: "novel-cda-mcp", version: RULE_VERSION });
    registerResources(server);
    registerPrompts(server);
    registerAllTools(server);
    return server;
}
export { buildServer };
function main() {
    if (process.argv.includes("--doctor")) {
        const report = doctor();
        if (process.argv.includes("--json"))
            console.log(JSON.stringify(report, null, 2));
        else
            console.log(formatDoctor(report));
        if (!report.summary.healthy)
            process.exitCode = 1;
        return;
    }
    if (process.argv.includes("--selfcheck")) {
        const checks = selfcheck();
        console.log(JSON.stringify(checks, null, 2));
        const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
        if (failed.length) {
            console.error(`[selfcheck] FAILED: ${failed.join(", ")}`);
            process.exitCode = 1;
        }
        else {
            console.error(`[selfcheck] ALL ${Object.keys(checks).length} CHECKS PASSED`);
        }
        return;
    }
    const server = buildServer();
    server.connect(new StdioServerTransport())
        .then(() => console.error("[novel-cda-mcp] started (stdio)"))
        .catch((e) => { console.error("[novel-cda-mcp] failed to start:", e); process.exitCode = 1; });
}
main();
