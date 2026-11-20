/**
 * 配置加载：规则/平台/提示词，路径全部相对本文件，避免 cwd 坑。
 * 对齐 novel-review-mcp 的 config.py 风格：
 *   - 配置目录优先级：外部语言包 > 源码/可编辑安装 > 安装后的 dist 同级 src
 *   - prompts.md 按 `## key` 拆分，key 与工具调用严格一致，缺 key 明确报错（禁止空跑）
 *   - 未知平台回退通用档案但不静默（标 _fallback + note）
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { load as yamlLoad } from "js-yaml";
const BASE_DIR = path.dirname(fileURLToPath(import.meta.url)); // src/ 或 dist/
const ROOT_DIR = path.resolve(BASE_DIR, "..");
const _envCfg = (process.env.CDA_CONFIG_DIR || "").trim();
const EXTERNAL_CONFIG_DIR = _envCfg ? path.resolve(_envCfg) : null;
function pickConfigDir() {
    if (EXTERNAL_CONFIG_DIR && fs.existsSync(path.join(EXTERNAL_CONFIG_DIR, "rules.yaml"))) {
        return EXTERNAL_CONFIG_DIR;
    }
    if (fs.existsSync(path.join(BASE_DIR, "rules.yaml")))
        return BASE_DIR;
    const sourceDir = path.join(ROOT_DIR, "src");
    if (fs.existsSync(path.join(sourceDir, "rules.yaml")))
        return sourceDir;
    throw new Error(`缺少配置文件目录（已尝试 ${EXTERNAL_CONFIG_DIR || "(未设 CDA_CONFIG_DIR)"} / ${BASE_DIR} / ${sourceDir}）。` +
        "源码运行请保留 src/*.yaml；外部语言包请设置 CDA_CONFIG_DIR。");
}
export const CONFIG_DIR = pickConfigDir();
/** 数据/缓存落点：CDA_MCP_DATA > CDA_CACHE_DIR > ~/.cda-mcp（对齐 XIEZHI_CACHE_* 的可覆盖风格） */
export const DATA_DIR = process.env.CDA_MCP_DATA || process.env.CDA_CACHE_DIR || path.join(os.homedir(), ".cda-mcp");
function loadYaml(name) {
    const p = path.join(CONFIG_DIR, name);
    if (!fs.existsSync(p))
        throw new Error(`缺少配置文件: ${p}`);
    return yamlLoad(fs.readFileSync(p, "utf8")) || {};
}
export const RULES = loadYaml("rules.yaml");
export const PLATFORMS = loadYaml("platforms.yaml");
export const RULE_VERSION = String(RULES.version || "0.0.0");
/** prompts.md 按 `## key` 拆分，key 与工具调用严格一致 */
function loadPrompts() {
    const p = path.join(CONFIG_DIR, "prompts.md");
    if (!fs.existsSync(p))
        throw new Error(`缺少提示词文件: ${p}`);
    const parts = fs.readFileSync(p, "utf8").split(new RegExp("^##\\s+([A-Za-z0-9_]+)\\s*$", "gm"));
    const out = {};
    for (let i = 1; i < parts.length - 1; i += 2)
        out[parts[i]] = parts[i + 1].trim();
    return out;
}
export const PROMPTS = loadPrompts();
export function renderPrompt(key, kwargs = {}) {
    if (!(key in PROMPTS))
        throw new Error(`prompts.md 缺少维度 [${key}]；禁止空跑，请补齐模板`);
    let tpl = PROMPTS[key];
    for (const [k, v] of Object.entries(kwargs)) {
        tpl = tpl.replaceAll("{" + k + "}", v === undefined || v === null ? "" : String(v));
    }
    return tpl;
}
export function getPlatform(name) {
    const key = (name || "").trim().toLowerCase();
    const plats = PLATFORMS.platforms || {};
    if (key in plats)
        return { key, ...plats[key] };
    return {
        key: key || "custom", name: `自定义平台(${name || "未指定"})`,
        unsigned_traffic: "未提供公开标准，按通用网文标准评审", exclusive: "签约前需自行确认",
        genres: [], patience: "未知", title_min_chars: 5, daily_words: [4000, 8000],
        golden_window: { conflict: 500, golden_finger: 1500, payoff: 3000 },
        note: "未匹配到预设平台，使用通用档案；请补充 platforms.yaml", _fallback: true,
    };
}
/** 规则内在一致性校验：配置能加载 ≠ 配置正确。返回问题清单，空数组代表一致。 */
export function ruleConsistency() {
    const issues = [];
    const rubric = RULES.rubric || {};
    const scoreMap = rubric.score_map || {};
    const dims = rubric.dimensions || [];
    const grades = ["A", "B", "C", "D"];
    for (const d of dims) {
        const row = scoreMap[d.id];
        if (!row) {
            issues.push(`score_map 缺维度 ${d.id}`);
            continue;
        }
        for (const g of grades) {
            if (typeof row[g] !== "number")
                issues.push(`score_map.${d.id} 缺档位 ${g}`);
        }
        if (typeof row.A === "number" && row.A !== d.max) {
            issues.push(`score_map.${d.id}.A=${row.A} 与 dimensions.max=${d.max} 不一致`);
        }
    }
    const sumMax = dims.reduce((s, d) => s + (Number(d.max) || 0), 0);
    if (sumMax !== 100)
        issues.push(`评分维度 max 合计 ${sumMax} ≠ 100`);
    const bands = RULES.word_bands || {};
    for (const [tone, types] of Object.entries(bands)) {
        for (const [type, range] of Object.entries(types)) {
            if (!Array.isArray(range) || range.length !== 2 || !(range[0] > 0) || !(range[1] > range[0])) {
                issues.push(`word_bands.${tone}.${type} 区间非法: ${JSON.stringify(range)}`);
            }
        }
    }
    const ai = (RULES.classifier || []).find((c) => c.id === "ai_flavor") || { id: "ai_flavor" };
    if (!(Number(ai.red_word_limit_per_chapter) > 0))
        issues.push("red_word_limit_per_chapter 必须 > 0");
    if (!Array.isArray(ai.red_words) || !ai.red_words.length)
        issues.push("ai_flavor.red_words 为空");
    for (const key of ["爽点类型", "反派类型", "情感契约"]) {
        const vals = RULES.positioning_enums?.[key];
        if (!Array.isArray(vals) || !vals.length)
            issues.push(`positioning_enums.${key} 为空或缺失`);
    }
    return issues;
}
/** 配置快照（供 list_profiles / selfcheck 使用） */
export function listProfiles() {
    return {
        rule_version: RULE_VERSION,
        display_name: RULES.meta?.display_name || "大禹",
        slogan: RULES.meta?.slogan || "笼中跳舞",
        config_dir: CONFIG_DIR,
        platforms: Object.keys(PLATFORMS.platforms || {}),
        prompt_keys: Object.keys(PROMPTS).sort(),
        stages: RULES.meta?.stages || [],
    };
}
