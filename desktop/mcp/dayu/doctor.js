/**
 * doctor 诊断 CLI（对标 novel-review-mcp 的 --selfcheck 与 proteus doctor 思路）。
 * 与 --selfcheck 的区别：selfcheck 是"判据信号自检"（布尔），doctor 是"全栈健康诊断"——
 * 分环境/配置/规则/判据/数据五层，逐项给 pass|warn|fail + 可操作建议，支持 --json。
 *
 * 退出码：全 pass → 0；含 fail → 1（warn 不影响退出码，但会提示）。
 */
import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR, DATA_DIR, RULES, PROMPTS, PLATFORMS, ruleConsistency, RULE_VERSION } from "./config.js";
import { selfcheckSignals } from "./layers.js";
const LEVEL_RANK = { pass: 0, warn: 1, fail: 2 };
/** 项目 JSON 完整性检查：能 parse + 必需字段齐全 */
function checkProjects() {
    const dir = path.join(DATA_DIR, "projects");
    const items = [];
    if (!fs.existsSync(dir)) {
        items.push({ group: "数据", name: "项目目录", level: "pass", detail: `${dir} 尚不存在（首次 init_project 时创建）` });
        return items;
    }
    let files = [];
    try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    }
    catch (e) {
        items.push({ group: "数据", name: "项目目录可读", level: "fail", detail: String(e) });
        return items;
    }
    items.push({ group: "数据", name: "项目目录可读", level: "pass", detail: `${dir}（${files.length} 个项目）` });
    const required = ["id", "createdAt", "positioning", "cards", "foreshadowing", "outlines", "sop"];
    let broken = 0;
    for (const f of files) {
        try {
            const obj = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
            const missing = required.filter((k) => !(k in obj));
            if (missing.length) {
                broken++;
                items.push({ group: "数据", name: `项目 ${f}`, level: "fail", detail: `缺字段: ${missing.join(", ")}`, hint: "该文件可能由旧版本写入，建议从备份恢复或重新 init_project" });
            }
        }
        catch (e) {
            broken++;
            items.push({ group: "数据", name: `项目 ${f}`, level: "fail", detail: `JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`, hint: "文件已损坏；若启用了原子写，不应出现——请检查是否被外部工具改写" });
        }
    }
    if (!broken)
        items.push({ group: "数据", name: "项目文件完整性", level: "pass", detail: `${files.length} 个 JSON 全部可解析且字段齐全` });
    // 残留 tmp 提醒
    try {
        const tmps = fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
        if (tmps.length)
            items.push({ group: "数据", name: "临时文件残留", level: "warn", detail: `${tmps.length} 个 .tmp（疑似上次中断遗留）`, hint: "确认对应项目完好后可手动删除" });
    }
    catch { /* 目录已判可读 */ }
    return items;
}
/** 执行全部诊断，返回结构化报告（不打印、不退出，便于测试与复用） */
export function doctor() {
    const items = [];
    // ---- 环境 ----
    const major = parseInt(process.versions.node.split(".")[0], 10);
    items.push(major >= 18
        ? { group: "环境", name: "Node.js 版本", level: "pass", detail: process.versions.node }
        : { group: "环境", name: "Node.js 版本", level: "fail", detail: process.versions.node, hint: "需 Node.js ≥ 18" });
    if (fs.existsSync(DATA_DIR)) {
        try {
            fs.accessSync(DATA_DIR, fs.constants.R_OK | fs.constants.W_OK);
            items.push({ group: "环境", name: "数据目录可读写", level: "pass", detail: DATA_DIR });
        }
        catch (e) {
            items.push({ group: "环境", name: "数据目录可读写", level: "fail", detail: `${DATA_DIR}: ${e instanceof Error ? e.message : String(e)}`, hint: "设置 CDA_MCP_DATA 指向可写目录" });
        }
    }
    else {
        // 目录不存在是正常的（首次 init_project 才创建）——检查父目录可写即可
        const parent = path.dirname(DATA_DIR);
        const writable = (() => { try {
            fs.accessSync(parent, fs.constants.W_OK);
            return true;
        }
        catch {
            return false;
        } })();
        items.push(writable
            ? { group: "环境", name: "数据目录可创建", level: "pass", detail: `${DATA_DIR}（父目录可写，首次使用时创建）` }
            : { group: "环境", name: "数据目录可创建", level: "fail", detail: `${DATA_DIR} 父目录不可写: ${parent}`, hint: "设置 CDA_MCP_DATA 指向可写目录" });
    }
    // ---- 配置 ----
    for (const f of ["rules.yaml", "platforms.yaml", "prompts.md"]) {
        const exists = fs.existsSync(path.join(CONFIG_DIR, f));
        items.push({ group: "配置", name: f, level: exists ? "pass" : "fail", detail: exists ? path.join(CONFIG_DIR, f) : "缺失", hint: exists ? undefined : "检查 CDA_CONFIG_DIR 或恢复源码 src/*.yaml" });
    }
    items.push({ group: "配置", name: "规则版本", level: RULE_VERSION !== "0.0.0" ? "pass" : "warn", detail: RULE_VERSION });
    items.push({ group: "配置", name: "平台档案", level: Object.keys(PLATFORMS.platforms || {}).length >= 4 ? "pass" : "warn", detail: `${Object.keys(PLATFORMS.platforms || {}).length} 个` });
    items.push({ group: "配置", name: "提示词模板", level: Object.keys(PROMPTS).length >= 4 ? "pass" : "fail", detail: `${Object.keys(PROMPTS).length} 个: ${Object.keys(PROMPTS).sort().join(", ")}` });
    // ---- 规则一致性 ----
    const issues = ruleConsistency();
    items.push(issues.length === 0
        ? { group: "规则", name: "内在一致性", level: "pass", detail: "评分锚点/字数区间/枚举/红牌词上限全部合法" }
        : { group: "规则", name: "内在一致性", level: "fail", detail: issues.join(" | "), hint: "修正 rules.yaml 后重跑 doctor" });
    // ---- 判据信号（复用 selfcheck 的真实判据，而非仅布尔存在性）----
    for (const [name, ok] of Object.entries(selfcheckSignals())) {
        items.push({ group: "判据", name, level: ok ? "pass" : "fail", detail: ok ? "OK" : "判据失效", hint: ok ? undefined : "检查 rules.yaml 对应词表/红线配置" });
    }
    // ---- 数据 ----
    items.push(...checkProjects());
    const pass = items.filter((i) => i.level === "pass").length;
    const warn = items.filter((i) => i.level === "warn").length;
    const fail = items.filter((i) => i.level === "fail").length;
    return {
        display_name: String(RULES.meta?.display_name || "大禹"),
        slogan: String(RULES.meta?.slogan || "笼中跳舞"),
        rule_version: RULE_VERSION,
        node: process.versions.node,
        config_dir: CONFIG_DIR,
        data_dir: DATA_DIR,
        items,
        summary: { pass, warn, fail, healthy: fail === 0 },
    };
}
/** 人类可读输出（分组 + 图标化标记，无 emoji，对齐用户 UI 规范） */
export function formatDoctor(report) {
    const mark = { pass: "[OK]", warn: "[!]", fail: "[X]" };
    const lines = [];
    lines.push(`${report.display_name} 健康检查  ·  规则版本 ${report.rule_version}  ·  Node ${report.node}`);
    lines.push(`配置目录: ${report.config_dir}`);
    lines.push(`数据目录: ${report.data_dir}`);
    lines.push("");
    let last = "";
    for (const it of report.items) {
        if (it.group !== last) {
            lines.push(`── ${it.group} ──`);
            last = it.group;
        }
        lines.push(`  ${mark[it.level]} ${it.name}: ${it.detail}`);
        if (it.hint)
            lines.push(`      → ${it.hint}`);
    }
    lines.push("");
    lines.push(`汇总: ${report.summary.pass} 通过 / ${report.summary.warn} 提醒 / ${report.summary.fail} 失败  →  ${report.summary.healthy ? "健康" : "异常"}`);
    return lines.join("\n");
}
