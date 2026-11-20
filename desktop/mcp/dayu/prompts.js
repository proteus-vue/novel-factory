import { z } from "zod";
import { PROMPTS, RULES, renderPrompt } from "./config.js";
import { loadProject } from "./store.js";
import { listDocs } from "./tools.js";
const textMsg = (text) => ({ messages: [{ role: "user", content: { type: "text", text } }] });
export function registerPrompts(server) {
    /** 执行层：按项目锁定层卡片组装写作铁律 system prompt（模板来自 prompts.md#build_system_prompt） */
    server.registerPrompt("build_system_prompt", {
        description: "【执行层】按项目卡片组装 LLM 写作 system prompt（禁止项/金手指边界/调性对照/字数区间/硬数据/听书格式）",
        argsSchema: { project_id: z.string() },
    }, ({ project_id }) => {
        const p = loadProject(project_id);
        const chars = p.cards.characters.map((c) => `- ${c.name || "未命名角色"}：肯定项 ${JSON.stringify(c.traits || [])}；禁止项 ${JSON.stringify(c.forbidden)}；漂移信号 ${JSON.stringify(c.drift_signals)}`).join("\n") || "（未建人设卡——先跑 save_card(character)）";
        const gfs = p.cards.goldfingers.map((g) => `- 能力: ${g.ability || JSON.stringify(g)}\n  边界: ${JSON.stringify(g.boundaries)}\n  三条腿: ${JSON.stringify(g.legs || [])}`).join("\n") || "（未建金手指卡——先跑 save_card(goldfinger)）";
        const tone = p.cards.toneTable
            ? `${p.cards.toneTable.is}\n本项目不是：${p.cards.toneTable.isNot}\n对照表：${JSON.stringify(p.cards.toneTable.dimensions, null, 1)}${p.exclaimForbidden ? "\n\n硬性：本项目（冷感调性）全文禁止感叹号。" : ""}`
            : "（未建调性卡——先跑 save_card(tone) 的对立面定义）";
        const hard = Object.entries(p.cards.hardData).map(([k, v]) => `  ${k} = ${v}`).join("\n") || "（未建硬数据表）";
        const bands = Object.entries(p.wordBands).map(([k, v]) => `${k} ${v[0]}-${v[1]}`).join("；");
        const cool = (RULES.cool_points || []).join("\n- ");
        return textMsg(renderPrompt("build_system_prompt", {
            characters: chars, goldfingers: gfs, tone, harddata: hard, bands,
            cool_points: "- " + cool,
        }));
    });
    /** 质检层：每章 AI 味审计（模板来自 prompts.md#chapter_review_prompt） */
    server.registerPrompt("chapter_review_prompt", { description: "【质检层·第一层】每章 AI 味审计 Prompt（模板外置；输出严格 JSON，禁止和稀泥结论）" }, () => textMsg(PROMPTS["chapter_review_prompt"]));
    /** 质检层：周期全检（模板来自 prompts.md#periodic_audit_prompt，含补丁4防冷漠） */
    server.registerPrompt("periodic_audit_prompt", { description: "【质检层】周期全检 Prompt（每 10 章跑；对比第 1 章防漂移；含女频防冷漠检测项）" }, () => textMsg(PROMPTS["periodic_audit_prompt"]));
    /** 下一章约束块 prompt（模板来自 prompts.md#next_chapter_brief_prompt） */
    server.registerPrompt("next_chapter_brief_prompt", { description: "【P1 闭环】把评审结论 + 未收伏笔 + 人设锚转成下一章写作约束块（模板外置）" }, () => textMsg(PROMPTS["next_chapter_brief_prompt"]));
}
/** 11 篇方法论文档注册为 MCP resources */
export function registerResources(server) {
    for (const d of listDocs()) {
        const slug = d.name.replace(/[^\w\d]+/g, "-").replace(/^-+|-+$/g, "");
        server.registerResource(slug, `cda://docs/${d.name}`, { title: d.name, description: `CDA 方法论 · ${d.name}` }, async () => ({ contents: [{ uri: `cda://docs/${d.name}`, text: d.text, mimeType: "text/markdown" }] }));
    }
}
