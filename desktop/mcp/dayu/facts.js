/**
 * P1 闭环（对齐 novel-review-mcp 的 facts.py）：把评审从「事后体检」变成「写下一章前的护栏」。
 *   extract_facts        —— 从正文抽硬数据，生成候选事实契约（诚实：候选 ≠ 确认）
 *   next_chapter_brief   —— 评审结论 + 未收伏笔 + 人设锚 → 下一章写作约束块（含可直接喂写稿 Agent 的 prompt）
 * 三件都是零 LLM、确定性转写；原评审是桩模式时明确标注，不拿空判定当约束。
 */
import { RULES } from "./config.js";
import { cnToInt, extract_foreshadow } from "./layers.js";
import { renderPrompt } from "./config.js";
function extractCfg() {
    return { enabled: true, unit_pattern: "", label_chars: 8, min_occurrences: 2, max_anchors: 40, ...(RULES.fact_extract || {}) };
}
function briefCfg() {
    return { enabled: true, max_avoid: 8, max_foreshadow: 8, overdue_chapters: 8, ...(RULES.chapter_brief || {}) };
}
function cleanLabel(raw, n) {
    return raw.replace(/[0-9一二三四五六七八九十百千万两\.\s，。！？：；、（）()《》\[\]]/g, "").slice(-n);
}
/** 从正文抽硬数据锚点 → 候选契约（fact_check 兼容）。零 LLM，候选需复核。 */
export function extract_facts(chapters) {
    const cfg = extractCfg();
    const empty = { enabled: false, anchors: [], contract: { rules: [] }, conflicts: [] };
    if (!cfg.enabled)
        return { ...empty, note: "fact_extract.enabled=false" };
    let re;
    try {
        re = new RegExp(cfg.unit_pattern, "g");
    }
    catch {
        return { ...empty, note: "unit_pattern 非法，请检查 rules.yaml" };
    }
    const anchors = [];
    for (const ch of chapters || []) {
        const cid = String(ch?.id || ch?.chapter_id || "");
        const text = String(ch?.text || "");
        for (const m of text.matchAll(re)) {
            const rawNum = m[1], unit = m[2];
            const val = cnToInt(rawNum);
            if (val === null)
                continue;
            // 过滤泛指时间状语（一天/一年/一月），保留"第三天/2003年"等具体锚点
            if (val === 1 && ["天", "年", "月", "日"].includes(unit) && ["一", "1"].includes(rawNum))
                continue;
            const left = text.slice(Math.max(0, m.index - Number(cfg.label_chars)), m.index);
            anchors.push({
                chapter_id: cid, raw: m[0], value: val, unit,
                label: cleanLabel(left, Number(cfg.label_chars)),
                evidence: text.slice(Math.max(0, m.index - 20), m.index + m[0].length + 20).trim(),
            });
        }
    }
    // 同单位多值 → suspect 冲突（不同章节同一量词可能是时间推进，一律标候选不冒充结论）
    const byUnit = {};
    for (const a of anchors)
        (byUnit[a.unit] ||= []).push(a);
    const conflicts = [];
    for (const [unit, list] of Object.entries(byUnit)) {
        const values = [...new Set(list.map(a => a.value))].sort((a, b) => a - b);
        if (values.length >= 2 && list.length >= Number(cfg.min_occurrences)) {
            conflicts.push({ unit, value_set: values, level: "suspect",
                evidence: list.slice(0, 4).map(a => `${a.chapter_id}:${a.raw}`),
                note: "同单位出现多个值；可能是时间推进/不同对象，必须人工或 LLM 复核后才能固化为正式契约" });
        }
    }
    const contractRules = [...new Set(anchors.map(a => `${a.label || a.unit}/${a.unit}`))].slice(0, Number(cfg.max_anchors))
        .map(name => ({ name, must_not: [], must: [], note: "候选契约：must_not 需人工补充正则，禁止直接当确认设定" }));
    return {
        enabled: true,
        anchors: anchors.slice(0, Number(cfg.max_anchors)),
        contract: { rules: contractRules },
        conflicts,
        note: "候选契约 ≠ 确认事实；must_not 覆盖有限且可能误报，必须复核后使用。",
    };
}
/** 评审回流：把评审结论 + 未收伏笔 + 人设锚转成下一章写作约束块。零新增判断。 */
export function next_chapter_brief(review, opts = {}) {
    const cfg = briefCfg();
    if (!cfg.enabled)
        return { enabled: false, must_avoid: [], must_include: [], prompt: "" };
    let chapters = review?.chapters || {};
    // 兼容单章 review_chapter 报告（顶层 verdict/problems，非 chapters 结构）
    if (!Object.keys(chapters).length && (review?.verdict || review?.problems)) {
        const cid = String(review?.chapter ?? "本章");
        chapters = { [cid]: {
                overall: { verdict: review.verdict, vetoes: [], stub: review.stub },
                stages: { red_team: { attack_points: [] }, second_review: { issues: [] } },
                problems: review.problems || [],
                _single: true,
            } };
    }
    const must_avoid = [];
    const must_include = [];
    let stub = false;
    for (const [cid, ch] of Object.entries(chapters)) {
        const overall = ch?.overall || {};
        if (overall.verdict === "未定" || ch?.stub || overall.stub)
            stub = true;
        if (overall.verdict && overall.verdict !== "放行")
            must_avoid.push(`${cid}: ${overall.verdict}`);
        for (const veto of (overall.vetoes || []))
            must_avoid.push(`${cid}: ${typeof veto === "string" ? veto : (veto.reason || veto.type || "致命项")}`);
        for (const issue of (ch?.stages?.red_team?.attack_points || [])) {
            if (issue.level === "fatal" || issue.level === "high")
                must_avoid.push(`${cid}: ${issue.suggestion || issue.type || "红队高危项"}`);
        }
        for (const issue of (ch?.stages?.second_review?.issues || [])) {
            if (issue.level === "high")
                must_avoid.push(`${cid}: ${issue.suggestion || "二审问题"}`);
        }
        // 单章报告：把 problems 转成下一章的 must_avoid（不新增判断，只做结构化转写）
        if (ch._single) {
            for (const prob of (ch.problems || []).slice(0, Number(cfg.max_avoid))) {
                must_avoid.push(`${cid}: ${String(prob).slice(0, 80)}`);
            }
        }
    }
    const foes = (opts.foreshadow || []).slice(0, Number(cfg.max_foreshadow));
    const persona = String(opts.persona || "");
    const profile = String(opts.profile || "");
    const reviewSummary = JSON.stringify({
        verdicts: Object.fromEntries(Object.entries(chapters).map(([k, v]) => [k, v?.overall?.verdict])),
        vetoes: must_avoid.filter(s => s.includes("致命")),
    });
    const prompt = renderPrompt("next_chapter_brief_prompt", {
        review: reviewSummary,
        foreshadow: foes.join("；") || "（无未收伏笔）",
        persona: persona || "（未提供人设锚）",
        profile: profile || "（未指定平台）",
    });
    return {
        enabled: true,
        must_avoid: [...new Set(must_avoid)].slice(0, Number(cfg.max_avoid)),
        must_include: [...new Set(must_include)],
        foreshadow_to_touch: foes,
        stub_warning: stub ? "上轮评审含桩模式/未定判定，本约束仅含已知护栏，不拿空判定当约束。" : null,
        prompt,
    };
}
/** 伏笔超期提醒（无章序信息时不臆断，返回空） */
export function foreshadow_overdue(items, currentChapter, maxAge) {
    if (currentChapter === undefined || currentChapter === null)
        return [];
    const age = maxAge ?? Number(briefCfg().overdue_chapters);
    return (items || [])
        .filter(f => f.level !== "L" && !f.resolvedAt && currentChapter - f.plantedAt >= age)
        .map(f => ({ id: f.id, content: f.content, plantedAt: f.plantedAt,
        age: currentChapter - f.plantedAt, note: `超过 ${age} 章未收，请安排回收或确认转为长线 L 级` }));
}
export { extract_foreshadow };
