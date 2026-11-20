import { z } from "zod";
import { loadProject, saveProject, createProject, SAFE_ID_RE, } from "./store.js";
import { checkAiFlavor, checkFormat, checkTitle } from "./checks.js";
import { DRIFT_TYPES, SCORE_ANCHORS, GRADE_LABELS, COMPLIANCE_ITEMS, SOP_STEPS, COOL_POINT_RULES, EVENT_ROTATION, WORD_BANDS, POSITIONING_ENUMS, } from "./rules.js";
import { l1_check, hasHardReject, l2_check, self_consistency_check, pacing_signals, fact_check, extract_foreshadow, } from "./layers.js";
import { extract_facts, next_chapter_brief, foreshadow_overdue } from "./facts.js";
import { listProfiles, getPlatform, RULE_VERSION } from "./config.js";
const out = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
function tool(server, name, description, schema, fn) {
    server.registerTool(name, { description, inputSchema: schema }, async (args) => {
        try {
            return out(await fn(args));
        }
        catch (e) {
            return { content: [{ type: "text", text: "错误: " + (e instanceof Error ? e.message : String(e)) }], isError: true };
        }
    });
}
const SafeId = z.string().regex(SAFE_ID_RE, "项目 ID 仅允许中英文、数字、下划线、连字符（1-64 字），禁止路径分隔符");
const P = { project_id: SafeId.describe("项目 ID（内部代号，如“默者”）") };
const proj = (id) => loadProject(id);
export function registerAllTools(server) {
    // ================= 定位层 =================
    tool(server, "init_project", `【定位层】开新书第 1 步：填定位决策卡并创建项目。
必填：项目id/项目名/书名/平台/受众/性别向/情感契约/改编形态/爽点类型/反派类型/差异化（缺任一即报错，补丁1-3）。
爽点类型五选一：打脸碾压 | 解谜智性 | 无声反杀 | 清醒退出 | 情感共鸣。
反派类型三选一：敌人(可打倒) | 规则(可理解) | 结构(不可打倒只能离开)。
调性 tone：冷感 | 炸裂 | 通用（决定感叹号禁用与字数区间预设）。`, {
        project_id: SafeId, 项目名: z.string(), 书名: z.string(), 平台: z.string(),
        受众: z.string(), 性别向: z.string(), 情感契约: z.string(), 改编形态: z.string(),
        爽点类型: z.string(), 反派类型: z.string(), 差异化: z.string(),
        代入门槛: z.string().optional(), 对标作品: z.string().optional(), 核心情绪: z.string().optional(),
        目标体量: z.string().optional(), 日更计划: z.string().optional(),
        tone: z.enum(["冷感", "炸裂", "通用"]).optional().describe("调性预设"),
        prefix: z.string().optional().describe("伏笔编号前缀，默认 F；项目间必须独立（防串味）"),
    }, (a) => {
        const required = {
            项目名: a.项目名, 书名: a.书名, 平台: a.平台, 受众: a.受众, 性别向: a.性别向,
            情感契约: a.情感契约, 改编形态: a.改编形态, 爽点类型: a.爽点类型, 反派类型: a.反派类型, 差异化: a.差异化,
        };
        const missing = Object.entries(required).filter(([, v]) => !v || !String(v).trim()).map(([k]) => k);
        if (missing.length) {
            throw new Error(`定位决策卡缺字段（补丁1-3）：${missing.join("、")}。定位层是生死层——这层偷懒，后面四层都在给错误方向加速。`);
        }
        const coolTypes = POSITIONING_ENUMS["爽点类型"] || [];
        if (!coolTypes.length)
            throw new Error("rules.yaml 缺 positioning_enums.爽点类型（配置单一来源，禁止空跑）");
        if (!coolTypes.includes(a.爽点类型))
            throw new Error(`爽点类型必须五选一：${coolTypes.join(" / ")}（补丁2：禁止沿用上一本的默认爽点库）`);
        const villainTypes = POSITIONING_ENUMS["反派类型"] || [];
        if (!villainTypes.length)
            throw new Error("rules.yaml 缺 positioning_enums.反派类型（配置单一来源，禁止空跑）");
        if (!villainTypes.includes(a.反派类型))
            throw new Error(`反派类型必须三选一：${villainTypes.join(" / ")}（补丁3：反派可能不是"人"）`);
        const contracts = POSITIONING_ENUMS["情感契约"] || [];
        if (!contracts.length)
            throw new Error("rules.yaml 缺 positioning_enums.情感契约（配置单一来源，禁止空跑）");
        if (!contracts.includes(a.情感契约))
            throw new Error(`情感契约应为：${contracts.join(" / ")}（补丁1：读者为什么追？）`);
        const p = createProject(a.project_id, { ...a }, { tone: a.tone, prefix: a.prefix });
        return {
            created: true, project: p.id, tone: p.tone, exclaimForbidden: p.exclaimForbidden,
            wordBands: p.wordBands, foreshadowPrefix: p.foreshadowPrefix,
            positioning: p.positioning,
            next: `定位层完成（SOP 第1步）。下一步 = SOP 第2步【找对立面】：调用 save_card(card_type="tone") 填调性对照表——每本书必须能说出"我不是什么"。用 sop_status 查看完整 7 步。`,
        };
    });
    // ================= SOP =================
    tool(server, "sop_status", `查看开新书 7 步 SOP 进度与各步检查清单（07 号）。`, P, (a) => {
        const p = proj(a.project_id);
        const done = p.sop.completedSteps;
        const current = SOP_STEPS.find(s => !done.includes(s.step));
        return {
            projectId: p.id,
            completedSteps: done,
            currentStep: current ?? null,
            steps: SOP_STEPS.map(s => ({ ...s, done: done.includes(s.step) })),
            note: "试产阶段（第7步）发现的问题要【回调规则】而不是只改正文——用 log_issue 记录到规则层。",
        };
    });
    tool(server, "advance_sop", `标记某一步 SOP 完成（须按 1→7 顺序）。`, { ...P, step: z.number().int().min(1).max(7) }, (a) => {
        const p = proj(a.project_id);
        const expected = p.sop.completedSteps.length ? Math.max(...p.sop.completedSteps) + 1 : 1;
        if (a.step !== expected)
            throw new Error(`须按顺序完成：当前应完成第 ${expected} 步，不是第 ${a.step} 步`);
        p.sop.completedSteps.push(a.step);
        saveProject(p);
        const next = SOP_STEPS.find(s => s.step === expected + 1);
        return { done: a.step, next: next ? `下一步：${next.step}. ${next.name}（用 ${next.tool}）` : "全部 7 步完成 → 进入量产。方法论的回报从第 3 本书开始兑现。" };
    });
    tool(server, "log_issue", `【规则回调】试产/评审发现的问题记录到项目规则层（07 号提醒3：改规则 = 后面 390 章都受益）。`, { ...P, text: z.string().describe("问题描述（要具体：不是『改好点』而是『安排纯技术章』）") }, (a) => {
        const p = proj(a.project_id);
        p.issues.push({ time: new Date().toISOString(), text: a.text });
        saveProject(p);
        return { logged: true, hint: "该问题应同步回调到对应规则（词表/字数区间/评审 prompt），再重跑确认稳定。" };
    });
    // ================= 锁定层 =================
    tool(server, "save_card", `【锁定层】保存人设卡/金手指卡/调性对照卡/硬数据。
- character：必须给 forbidden 禁止项数组（≥5 条，否定式定义法）与 drift_signals 漂移预警信号；肯定项 traits 控制在 3-5 个。
- goldfinger：必须给 boundaries 边界数组（边界 > 能力）；建议 legs 三条腿（各含 name/limit）。
- tone：is（本项目是什么）+ isNot（对立面）+ dimensions 对照表 [{dimension, self, opposite}]（对立面定义法）。
- harddata：entries [{key, value}] 硬数据校验表（年龄/姓名/关键数字/时间线）。`, {
        ...P,
        card_type: z.enum(["character", "goldfinger", "tone", "harddata"]),
        payload: z.record(z.any()).describe("卡内容，结构见工具描述"),
    }, (a) => {
        const p = proj(a.project_id);
        const pl = a.payload || {};
        if (a.card_type === "character") {
            const forbidden = pl.forbidden || [];
            const traits = pl.traits || [];
            const drift = pl.drift_signals || [];
            if (forbidden.length < 5)
                throw new Error(`禁止项只有 ${forbidden.length} 条，要求 ≥5（否定式定义法：不告诉 AI"要怎样"，要告诉它"不许怎样"）。示例：不怒吼/不解释/不炫耀/不主动挑衅/不变嘴炮王`);
            if (traits.length > 5)
                throw new Error(`性格肯定项 ${traits.length} 个 > 5，会稀释（控制在 3-5 个）`);
            if (drift.length < 1)
                throw new Error("缺 drift_signals 漂移预警信号（命中任一 → 该章打回重写）");
            p.cards.characters.push(pl);
        }
        else if (a.card_type === "goldfinger") {
            const boundaries = pl.boundaries || [];
            const legs = pl.legs || [];
            if (boundaries.length < 2)
                throw new Error(`金手指边界只有 ${boundaries.length} 条，要求 ≥2（边界 > 能力：先写边界再写能力，否则无敌→无冲突→崩）`);
            if (legs.length && legs.length !== 3)
                throw new Error(`三条腿法则：给主角 3 个能力支柱，每根都有明确短板；当前 ${legs.length} 条`);
            p.cards.goldfingers.push(pl);
        }
        else if (a.card_type === "tone") {
            if (!pl.is || !pl.isNot)
                throw new Error("调性卡必须给 is（本项目是什么）与 isNot（对立面）——极致形态：本项目 = 不是对立项目");
            const dims = pl.dimensions || [];
            if (dims.length < 5)
                throw new Error(`对照表只有 ${dims.length} 个维度，要求 ≥5（需覆盖爽点/反击方式/章末钩子/情绪/禁用词等）`);
            p.cards.toneTable = pl;
            if (!p.sop.completedSteps.includes(2))
                p.sop.completedSteps.push(2);
        }
        else {
            for (const e of pl.entries || [])
                p.cards.hardData[e.key] = String(e.value);
        }
        saveProject(p);
        return { saved: a.card_type, counts: { characters: p.cards.characters.length, goldfingers: p.cards.goldfingers.length } };
    });
    // ================= 结构层：伏笔编号系统 =================
    tool(server, "add_foreshadow", `【结构层】新埋伏笔。id：单级用 ${"F1/G1"}，两级（300万字+）用 L1 或 C3-1（第3卷群第1条）。
同名 id 已存在 → 报错；同内容重复埋设 → 冗余警告。`, {
        ...P, id: z.string().describe("伏笔编号"), content: z.string(),
        level: z.enum(["L", "C", "F"]).describe("L=跨卷群长线 C=卷群内 F=单级编号"),
        planted_at: z.number().int().describe("埋设章号"), note: z.string().optional(),
    }, (a) => {
        const p = proj(a.project_id);
        if (p.foreshadowing.some(f => f.id === a.id))
            throw new Error(`伏笔 ${a.id} 已存在（重复埋设 = 冗余）`);
        if (p.foreshadowing.some(f => f.content === a.content))
            return { warning: "同一伏笔内容已埋过一次（重复埋设检测）", added: false };
        p.foreshadowing.push({ id: a.id, level: a.level, content: a.content, plantedAt: a.planted_at, resolvedAt: null, lastMentioned: null, note: a.note });
        saveProject(p);
        return { added: a.id, hint: a.level === "L" ? "L 级长线：每 100 章至少提及一次（用 touch_foreshadow 记录），跨 2-5 个卷群收。" : "卷群内埋、卷群内收，不跨群拖欠。" };
    });
    tool(server, "resolve_foreshadow", `【结构层】回收伏笔。编号不存在 → 判定【凭空回收】（一票否决）；已回收 → 报错。`, { ...P, id: z.string(), resolved_at: z.number().int().describe("回收章号") }, (a) => {
        const p = proj(a.project_id);
        const f = p.foreshadowing.find(x => x.id === a.id);
        if (!f)
            throw new Error(`凭空回收：伏笔 ${a.id} 从未埋设——回收了但前文没埋 = 一票否决项。请先 add_foreshadow。`);
        if (f.resolvedAt)
            throw new Error(`伏笔 ${a.id} 已在第 ${f.resolvedAt} 章回收过`);
        f.resolvedAt = a.resolved_at;
        saveProject(p);
        return { resolved: a.id, span: a.resolved_at - f.plantedAt };
    });
    tool(server, "touch_foreshadow", `【结构层】记录长线伏笔"呼吸"（提及章号），用于健康度检查。`, { ...P, id: z.string(), chapter: z.number().int() }, (a) => {
        const p = proj(a.project_id);
        const f = p.foreshadowing.find(x => x.id === a.id);
        if (!f)
            throw new Error(`伏笔 ${a.id} 不存在（凭空提及）`);
        f.lastMentioned = a.chapter;
        saveProject(p);
        return { touched: a.id, lastMentioned: a.chapter };
    });
    tool(server, "foreshadow_health", `【结构层】伏笔健康度检查（每 10 章一次 / 每卷群结束必查）：回收率、待回收清单、长线呼吸、凭空回收统计。`, { ...P, current_chapter: z.number().int().describe("当前写到第几章") }, (a) => {
        const p = proj(a.project_id);
        const fs = p.foreshadowing;
        const planted = fs.length;
        const resolved = fs.filter(f => f.resolvedAt).length;
        const rate = planted ? Math.round((resolved / planted) * 100) : 0;
        const unresolved = fs.filter(f => !f.resolvedAt).map(f => ({ id: f.id, content: f.content, plantedAt: f.plantedAt, level: f.level }));
        const breathing = [];
        for (const f of fs.filter(x => x.level === "L")) {
            const ref = f.lastMentioned ?? f.plantedAt;
            const gap = a.current_chapter - ref;
            if (gap > 100)
                breathing.push(`L 级 ${f.id}「${f.content}」已 ${gap} 章未提及（要求每 100 章呼吸一次）`);
        }
        return {
            回收率: `${resolved}/${planted} = ${rate}%`, 应随进度上升: true,
            待回收: unresolved,
            长线呼吸预警: breathing,
            规则: ["凭空回收 = 0（一票否决）", "重复埋设 = 0", "本群 C 级伏笔回收率应 100%（不跨群拖欠）"],
        };
    });
    // ================= 结构层：章纲 / 章名 / 计划 =================
    tool(server, "plan_chapter", `【结构层】生成某章的章纲模板：按字数类型给浮动区间（非死数）+ 爽点密度规则 + 事件库轮换提醒。`, {
        ...P, chapter_no: z.number().int(),
        word_type: z.enum(["静场", "常规", "反击", "高潮", "极短"]).describe("字数类型：静场/常规/反击/高潮/极短"),
    }, (a) => {
        const p = proj(a.project_id);
        const band = p.wordBands[a.word_type];
        if (!band)
            throw new Error(`未知字数类型 ${a.word_type}，可选：${Object.keys(p.wordBands).join("/")}`);
        return {
            章节编号: `章${a.chapter_no}`,
            字数区间: `${band[0]}-${band[1]}（浮动；铁律：宁可短，不可注水；高潮未写完允许超上限）`,
            结束条件: "情绪走到『卡点』，不是字数达标",
            章纲模板: ["章名（≥5字 ≤15字）", "摘要（100字：本章发生什么）", "暗爽点（本章爽点在哪，无则打回）", "伏笔：新埋 F# / 回收 F#", "情绪功能（压抑/释放/转折/沉淀）", "字数类型"],
            爽点密度: COOL_POINT_RULES,
            事件库轮换: EVENT_ROTATION,
            防注水: ["环境描写 ≤300 字", "对话要有信息增量", "每章必须有信息增量（新伏笔/新反转/新数据）"],
        };
    });
    tool(server, "save_outline", `【结构层】保存逐章章纲（施工图）。自动校验章名合规 + 伏笔引用（回收的必须已埋且未回收；新埋的编号冲突告警）。`, {
        ...P, chapter_no: z.number().int(), title: z.string(),
        summary: z.string().optional(), dark_point: z.string().describe("暗爽点（本章爽点在哪）"),
        foreshadow_new: z.array(z.string()).optional(), foreshadow_resolve: z.array(z.string()).optional(),
        emotion: z.string().optional(), word_type: z.string().optional(),
    }, (a) => {
        const p = proj(a.project_id);
        const t = checkTitle(a.title, p.exclaimForbidden, a.chapter_no);
        if (!t.ok)
            throw new Error("章名不合规: " + t.problems.join("；"));
        const problems = [];
        for (const id of a.foreshadow_resolve || []) {
            const f = p.foreshadowing.find(x => x.id === id);
            if (!f)
                problems.push(`章纲计划回收 ${id}，但该伏笔从未埋设（届时会凭空回收）`);
            else if (f.resolvedAt)
                problems.push(`章纲计划回收 ${id}，但它已在第 ${f.resolvedAt} 章回收过`);
        }
        for (const id of a.foreshadow_new || []) {
            if (p.foreshadowing.some(x => x.id === id))
                problems.push(`章纲计划新埋 ${id}，但该编号已存在`);
        }
        const idx = p.outlines.findIndex(o => o.chapterNo === a.chapter_no);
        const rec = { chapterNo: a.chapter_no, title: a.title, summary: a.summary, darkPoint: a.dark_point, foreshadowNew: a.foreshadow_new || [], foreshadowResolve: a.foreshadow_resolve || [], emotion: a.emotion, wordType: a.word_type };
        if (idx >= 0)
            p.outlines[idx] = rec;
        else
            p.outlines.push(rec);
        saveProject(p);
        return { saved: `章${a.chapter_no}`, title: a.title, visibleLen: t.visibleLen, crossCheckProblems: problems };
    });
    tool(server, "check_title", `章名合规检查：可见字数 ≥5（平台硬约束）、总长 ≤15、感叹号规则、钩子分层提醒。`, {
        title: z.string(), project_id: SafeId.optional(), chapter_no: z.number().int().optional(),
    }, (a) => {
        const p = a.project_id ? proj(a.project_id) : null;
        const r = checkTitle(a.title, p?.exclaimForbidden ?? false, a.chapter_no);
        return { ...r, 口诀: "这一章是『最有名的场面』？→ 是，用短名；不是，用钩子。前 30 章？→ 一律钩子。" };
    });
    // ================= 执行层 / 质检层：文本检查 =================
    tool(server, "check_ai_flavor", `【执行层/质检层】AI 味审计：红牌词（≤1/章）、油腻词（一票否决）、句式（不是A而是B ≤2、这，就是 ≤1）、段末升华检测。输出问题清单+具体位置。`, {
        text: z.string().describe("章节正文"), project_id: SafeId.optional(),
    }, (a) => {
        return checkAiFlavor(a.text);
    });
    tool(server, "check_format", `【执行层】听书(TTS)格式检查：数字可读化、引号闭合、破折号 ≤3、一人一段、括号大段、颜文字、无标点长段、感叹号（冷感调性禁用）。`, {
        text: z.string(), project_id: SafeId.optional(),
    }, (a) => {
        const p = a.project_id ? proj(a.project_id) : null;
        return checkFormat(a.text, p?.exclaimForbidden ?? false);
    });
    tool(server, "review_chapter", `【质检层·第一层】每章过程评审（100% 每章必过）：L1 形态红线（fatal 毫秒级短路）→ L2 打分 → AI 味 + TTS 格式 + 章名 + 暗爽点 + 单章自洽弱信号 + 节奏信号。输出 通过/打回 + 具体问题清单 + 真实耗时。`, {
        ...P, chapter_no: z.number().int(), text: z.string().describe("章节正文"), title: z.string().optional().describe("章名（若已有章纲可省略）"),
        facts: z.record(z.any()).optional().describe("事实契约 {rules:[{name,must_not:[正则],must:[正则?]}]}，确定性校验"),
    }, (a) => {
        const p = proj(a.project_id);
        const t0 = Date.now();
        // ---- L1：形态红线（毫秒级，fatal 直接短路，不进入后续检查）----
        const l1 = l1_check(a.text);
        if (hasHardReject(l1)) {
            return {
                chapter: a.chapter_no, verdict: "禁止发布", hard_reject_short_circuit: true,
                note: "L1 致命红线命中，短路：不进入 L2/L3 审计",
                l1_hits: l1, timing: { wall_ms: Date.now() - t0 },
            };
        }
        // ---- L2：关键词/结构打分 ----
        const l2 = l2_check(a.text);
        const flavor = checkAiFlavor(a.text);
        const format = checkFormat(a.text, p.exclaimForbidden);
        const outline = p.outlines.find(o => o.chapterNo === a.chapter_no);
        const title = a.title ?? outline?.title;
        const titleRep = title ? checkTitle(title, p.exclaimForbidden, a.chapter_no) : null;
        const problems = [...flavor.problems, ...format.problems];
        if (!titleRep)
            problems.push("缺章名（章纲或 title 参数至少提供一个）");
        else if (!titleRep.ok)
            problems.push(...titleRep.problems);
        if (outline && !outline.darkPoint)
            problems.push(`章${a.chapter_no} 章纲缺暗爽点（每章必须有暗爽点，无则打回）`);
        if (!outline)
            problems.push(`章${a.chapter_no} 无章纲记录（章纲先行 → 批量生成 → 人工抽检）`);
        // 环境描写粗检：连续 2 段以上无对白且含"天/风/雨/光/影/树/屋" 高频
        const paras = a.text.split(/\r?\n+/).filter((s) => s.trim());
        const envish = paras.filter((s) => !/“/.test(s) && /(天|风|雨|雪|光|影|树|山|水|云|雾)/.test(s) && s.length > 200);
        if (envish.length >= 2)
            problems.push(`疑似环境描写超长（${envish.length} 段 >200 字且无对白；环境描写 ≤300 字，为凑字数 = 注水信号）`);
        const verdict = problems.length ? "打回重写" : "通过";
        return {
            chapter: a.chapter_no, verdict, hard_reject_short_circuit: false,
            l1_hits: l1.filter(h => h.level !== "minor"), l2_hits: l2,
            aiFlavor: flavor.verdict, format: format.verdict, title: titleRep, problems,
            machine_signals: {
                self_consistency: self_consistency_check(a.text),
                pacing: pacing_signals(a.text),
                fact_conflicts: a.facts ? fact_check(a.text, a.facts) : [],
            },
            timing: { wall_ms: Date.now() - t0 },
            提示: "机器层弱信号只报 suspect + 原文证据，不单独构成否决；L3 语义判断请用 prompt: chapter_review_prompt。连续同类问题 → 用 log_issue 回调规则层。",
        };
    });
    tool(server, "release_gate", `【质检层·第二层】发布闸门（每 30 章一批 + 首发）：合规一票否决（不计分）+ 锚点制百分制评分（只报命中档，不报感觉分）。≥80 且无致命 → 放行；70-79 → 修改后发布；<70 或致命 → 禁止发布。
四档评分：A 满分 / B 轻微扣 / C 明显扣 / D 严重扣；命中多档取最低档。`, {
        ...P,
        compliance_passed: z.boolean().describe("合规终审（COMPLIANCE_ITEMS 全项通过）"),
        fatal_issues: z.array(z.string()).optional().describe("致命项清单（合规/崩人设等）"),
        scores: z.object({
            character: z.enum(["A", "B", "C", "D"]).describe("人设/调性（30分）"),
            structure: z.enum(["A", "B", "C", "D"]).describe("结构与爽点（25分）"),
            continuity: z.enum(["A", "B", "C", "D"]).describe("连续与伏笔（20分）"),
            writing: z.enum(["A", "B", "C", "D"]).describe("文字与格式（25分）"),
        }),
        存稿章数: z.number().int().optional(),
    }, (a) => {
        const fatal = a.fatal_issues || [];
        let total = 0;
        const detail = [];
        for (const [key, g] of Object.entries(a.scores)) {
            const anchor = SCORE_ANCHORS[key] || {};
            // 兼容旧结构 {grades:{...}} 与新结构 {A,B,C,D} 直接映射
            const scoreMap = anchor.grades
                ? anchor.grades
                : anchor;
            const score = scoreMap[g] ?? 0;
            total += score;
            const max = Math.max(...Object.values(scoreMap));
            detail.push({ 维度: key, 满分: max, 命中档: `${g}（${GRADE_LABELS[g] || ""}）`, 得分: score });
        }
        let verdict;
        if (!a.compliance_passed || fatal.length)
            verdict = "禁止发布（合规一票否决，不计分）";
        else if (total >= 80)
            verdict = "放行";
        else if (total >= 70)
            verdict = "修改后发布";
        else
            verdict = "禁止发布";
        const extra = [];
        if (a.存稿章数 !== undefined && a.存稿章数 < 30)
            extra.push(`存稿 ${a.存稿章数} 章 < 30 章（防断更）`);
        return { verdict, total, detail, extraWarnings: extra, complianceItems: a.compliance_passed ? "已通过" : COMPLIANCE_ITEMS, 提示: "评分只报『命中哪一档』，不报『感觉多少分』；命中多档取最低档（2026-09-15 实测修正：无锚点评分卡分数不可复现）。" };
    });
    tool(server, "drift_callback", `【质检层·第三层】漂移回调：输入漂移症状关键词，匹配 6 类回调方案（05 号）。`, {
        symptom: z.string().describe("症状描述，如：主角开始长篇解释计划 / 反派一碰就倒 / 连续出现抽象情绪"),
        project_id: SafeId.optional(),
    }, (a) => {
        const s = a.symptom.toLowerCase();
        const matched = DRIFT_TYPES.filter((t) => (t.keywords || []).some((k) => s.includes(k.toLowerCase())));
        if (!matched.length)
            return { matched: false, allTypes: DRIFT_TYPES.map((t) => `${t.type}｜症状: ${t.symptom}｜回调: ${t.callback}`), hint: "未命中具体类型，可对照全表人工判断。" };
        return { matched: true, plans: matched.map((t) => ({ type: t.type, symptom: t.symptom, callback: t.callback })) };
    });
    tool(server, "query_method", `检索方法论文档（00-10 号 11 篇）：按关键词返回最相关片段。例如查"卷群"、"否定式"、"黄金三章"、"爽点密度"、"听书"。`, {
        query: z.string().describe("关键词，支持多个（空格分隔）"),
    }, (a) => {
        const docs = listDocs();
        const kws = String(a.query).split(/\s+/).filter(Boolean);
        const scored = docs.map(d => {
            const body = d.text;
            const score = kws.reduce((s, k) => s + (body.split(k).length - 1), 0);
            return { file: d.name, score, text: body };
        }).filter(x => x.score > 0).sort((x, y) => y.score - x.score).slice(0, 3);
        if (!scored.length)
            return { result: "未命中", files: docs.map(d => d.name) };
        return scored.map(s => {
            const i = s.text.indexOf(kws.find(k => s.text.includes(k)));
            const start = Math.max(0, i - 150);
            return { file: s.file, score: s.score, excerpt: s.text.slice(start, start + 500) };
        });
    });
    // ============ 判据层薄工具（对齐 novel-review-mcp 风格）============
    tool(server, "check_redline", `【L1】形态红线毫秒级检查：可复现命令/路径、内部标注泄漏、Markdown 残留、真实企业名、章名感叹号。致命项直接判禁止发布（不调任何 LLM）。`, {
        text: z.string(), chapter_id: z.string().optional(), platform: z.string().optional(),
    }, (a) => {
        const t0 = Date.now();
        const hits = l1_check(a.text);
        return {
            chapter_id: a.chapter_id || "", platform: getPlatform(a.platform || "custom").name,
            fatal: hasHardReject(hits), hits,
            verdict: hasHardReject(hits) ? "禁止发布（L1 硬拒）" : (hits.length ? "有非致命形态问题" : "通过"),
            timing_ms: Date.now() - t0,
            note: "形态判据优先于枚举黑名单；可复现技术细节用结构识别，换路径名也绕不过。",
        };
    });
    tool(server, "check_self_consistency", `【弱信号·零成本】单章内部自洽：时序倒退 / 数字互斥 / 称谓变体。只报 suspect + 原文证据，绝不判 fatal/reject，最终需 L3 或人工复核。`, {
        text: z.string(),
    }, (a) => ({
        suspects: self_consistency_check(a.text),
        note: "确定性弱信号，需 L3 或人工复核；不单独构成否决。",
    }));
    tool(server, "check_pacing", `【机器层】节奏检查：爽点/冲突/钩子密度 + 荒漠预警（去 LLM 桩）。`, {
        text: z.string(),
    }, (a) => ({ signals: pacing_signals(a.text) }));
    tool(server, "extract_facts", `【P1 闭环·零 LLM】从正文抽硬数据，生成候选事实契约（fact_check 兼容），含跨章同单位多值 suspect。候选 ≠ 确认：必须人工/LLM 复核后才能当正式契约。`, {
        chapters: z.array(z.object({ id: z.string().optional(), text: z.string() })).describe("[{id,text}]"),
    }, (a) => extract_facts(a.chapters));
    tool(server, "next_chapter_brief", `【P1 闭环·零 LLM】评审回流：把上轮评审结论 + 未收伏笔 + 人设锚 + 平台档案转成下一章写作约束块，含可直接喂写稿 Agent 的 prompt（确定性转写，不新增判断；桩模式会明确标注）。`, {
        review: z.record(z.any()).describe("上轮 review_chapter / review_batch 报告"),
        project_id: SafeId.optional(), persona: z.string().optional(), platform: z.string().optional(),
        chapter_index: z.number().int().optional(),
    }, (a) => {
        const p = a.project_id ? proj(a.project_id) : null;
        const unresolved = (p?.foreshadowing || []).filter((f) => !f.resolvedAt).map((f) => `${f.id}: ${f.content}（埋于第${f.plantedAt}章）`);
        const overdue = p ? foreshadow_overdue(p.foreshadowing, a.chapter_index ?? null) : [];
        return {
            ...next_chapter_brief(a.review, {
                persona: a.persona || (p ? JSON.stringify(p.cards.characters.map((c) => c.name + ":" + (c.forbidden || []).slice(0, 3).join("/"))) : ""),
                profile: getPlatform(a.platform || p?.positioning?.平台 || "custom").name,
                foreshadow: [...overdue.map((o) => `${o.id}【超期${o.age}章】${o.content}`), ...unresolved.filter((u) => !overdue.some((o) => u.startsWith(o.id + ":")))],
            }),
            overdueWarning: overdue,
        };
    });
    tool(server, "foreshadow_list", `查看项目伏笔台账（对齐 novel-review-mcp 的工具名）。`, {
        ...P, status: z.enum(["open", "closed", "all"]).optional(),
    }, (a) => {
        const p = proj(a.project_id);
        const st = a.status || "open";
        const items = p.foreshadowing.filter((f) => st === "all" || (st === "open" ? !f.resolvedAt : !!f.resolvedAt));
        return { project: p.id, status: st, items, rule_version: RULE_VERSION };
    });
    tool(server, "foreshadow_overdue", `超期未收伏笔提醒；无章序信息时不臆断，返回空（对齐 novel-review-mcp）。`, {
        ...P, current_chapter_index: z.number().int().optional(), max_age: z.number().int().optional(),
    }, (a) => {
        const p = proj(a.project_id);
        return { overdue: foreshadow_overdue(p.foreshadowing, a.current_chapter_index ?? null, a.max_age ?? null) };
    });
    tool(server, "list_profiles", `列出可用平台档案、规则版本、提示词维度与伏笔编号前缀（对齐 novel-review-mcp 的 list_profiles）。`, {}, () => listProfiles());
    tool(server, "extract_foreshadow", `【零 LLM】从正文通用抽取伏笔候选（无 F# 编号也能识别悬念/未完成事件），供登记台账前参考。`, {
        text: z.string(),
    }, (a) => ({ candidates: extract_foreshadow(a.text), note: "通用抽取只报候选；正式台账请用 add_foreshadow 编号登记。" }));
}
// ---------- docs helpers（供 query_method / resources 共用） ----------
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const DOCS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs");
export function listDocs() {
    if (!fs.existsSync(DOCS_DIR))
        return [];
    return fs.readdirSync(DOCS_DIR).filter(f => f.endsWith(".md")).sort()
        .map(f => ({ name: f, text: fs.readFileSync(path.join(DOCS_DIR, f), "utf8") }));
}
export { WORD_BANDS };
