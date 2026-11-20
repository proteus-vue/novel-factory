/**
 * 项目状态存储：每个项目一个 JSON 文件（项目间隔离 = CDA 原则11 防串味）。
 * 数据目录：env CDA_MCP_DATA，默认 ~/.cda-mcp
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, RULES } from "./config.js";
const PROJECTS_DIR = path.join(DATA_DIR, "projects");
/** 安全项目 ID：仅中英文/数字/下划线/连字符，杜绝 ../ 路径穿越与绝对路径注入 */
export const SAFE_ID_RE = /^[\w\u4e00-\u9fa5-]{1,64}$/;
export function assertSafeId(id) {
    if (!SAFE_ID_RE.test(id)) {
        throw new Error(`非法项目 ID「${id}」：仅允许中英文、数字、下划线、连字符（1-64 字），禁止路径分隔符。`);
    }
}
function ensureDirs() {
    fs.mkdirSync(PROJECTS_DIR, { recursive: true });
}
function fileOf(id) {
    assertSafeId(id);
    const file = path.join(PROJECTS_DIR, id + ".json");
    // 纵深防御：即便 id 校验被绕过，也确保解析后的绝对路径仍在 PROJECTS_DIR 内
    if (path.dirname(path.resolve(file)) !== path.resolve(PROJECTS_DIR)) {
        throw new Error(`项目 ID 越界，拒绝访问: ${id}`);
    }
    return file;
}
export function listProjectIds() {
    ensureDirs();
    return fs.readdirSync(PROJECTS_DIR).filter(f => f.endsWith(".json")).map(f => f.replace(/\.json$/, ""));
}
export function projectExists(id) {
    return fs.existsSync(fileOf(id));
}
export function loadProject(id) {
    ensureDirs();
    const f = fileOf(id);
    if (!fs.existsSync(f))
        throw new Error(`项目不存在: ${id}（已有项目: ${listProjectIds().join(", ") || "无"}）`);
    return JSON.parse(fs.readFileSync(f, "utf8"));
}
export function saveProject(p) {
    ensureDirs();
    const target = fileOf(p.id);
    // 原子写：先写同目录临时文件再 rename，避免中断/并发留下半个 JSON 损坏项目记忆
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    try {
        fs.writeFileSync(tmp, JSON.stringify(p, null, 2), "utf8");
        fs.renameSync(tmp, target);
    }
    catch (e) {
        try {
            if (fs.existsSync(tmp))
                fs.unlinkSync(tmp);
        }
        catch { /* 清理失败不影响主错误 */ }
        throw e;
    }
}
export function createProject(id, positioning, opts) {
    ensureDirs();
    if (projectExists(id))
        throw new Error(`项目已存在: ${id}（CDA 原则11：项目间必须隔离，禁止共用项目空间）`);
    const bands = RULES.word_bands || {};
    const tone = opts.tone && bands[opts.tone] ? opts.tone : "通用";
    const p = {
        id,
        createdAt: new Date().toISOString(),
        positioning,
        tone,
        foreshadowPrefix: opts.prefix || "F",
        exclaimForbidden: tone === "冷感", // 冷感禁感叹号（04 号）
        wordBands: JSON.parse(JSON.stringify(bands[tone])),
        cards: { characters: [], goldfingers: [], toneTable: null, hardData: {} },
        foreshadowing: [],
        outlines: [],
        sop: { completedSteps: [1] },
        issues: [],
    };
    saveProject(p);
    return p;
}
