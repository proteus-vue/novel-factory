/**
 * 后端规划阶段：作品包 → 卷纲 → 章纲（大禹 CDA 定位/锁定/结构层）。
 * 与前端 console/pipeline.js 的规划逻辑对齐——有 Key 调 OpenAI-compatible 端点产严格 JSON，
 * 无 Key 用演示引擎按规范结构生成有差异内容。产物落盘 plan.json + spec.json。
 */
import type { LlmClient } from "./llm.js";
import type { ProjectSpec, PlanState, ChapterSpec } from "./pipeline.js";
import type { WorkRepo } from "./repo.js";

/** 从 LLM 文本稳健抽取 JSON（容忍 ```json 围栏、前后解释） */
export function extractJson(raw: string | null): any | null {
  if (raw == null) return null;
  let s = String(raw).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try { return JSON.parse(s); } catch { /* continue */ }
  const start = s.search(/[\[{]/);
  if (start < 0) return null;
  const open = s[start], close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end > start) { try { return JSON.parse(s.slice(start, end + 1)); } catch { /* ignore */ } }
  return null;
}

const PLAN_SYSTEM = [
  "你是网文工业化创作引擎，严格执行大禹 CDA 方法论：先建笼子（定位/锁定/结构），再逐章跳舞。",
  "输出必须是严格 JSON——不要 markdown 代码块、不要解释文字，直接以 { 或 [ 开头。",
  "遵循否定式定义：多写「不许怎样、对立面是什么」，少写空泛形容词；金手指必须有边界与代价。",
].join("\n");

function blueprintPrompt(s: ProjectSpec): string {
  return `为下面这部小说生成「创作作品包」（定位层 + 锁定层），作为后续卷纲、章纲、正文必须遵守的硬约束。
书名：《${s.书名}》　平台：${s.平台}　题材：${s.题材 || "未定"}
受众：${s.受众}　性别向：${s.性别向}　情感契约：${s.情感契约}
爽点类型：${s.爽点类型}　反派类型：${s.反派类型}　调性：${s.tone || "通用"}
只输出一个 JSON 对象（值用中文，数组每项一句话）：
{"一句话定位":"差异化卖点","世界规则":["3-5 条规则"],"主角":"身份+欲望+缺陷","人设禁止项":["绝对不会做的5件事"],"金手指":"核心能力","金手指边界":["3条限制或代价"],"调性对立面":"本书明确不是什么","主线冲突":"贯穿全书的核心矛盾","爽点节奏":"回报节奏设计","结局契约":"结尾必须兑现的承诺"}`;
}
function volumesPrompt(s: ProjectSpec, bp: Record<string, any>, target: number): string {
  return `基于作品包规划分卷大纲，全书 ${target} 章切成 3-6 卷，连续覆盖不重不漏。
作品包：${JSON.stringify(bp)}
只输出 JSON 数组：[{"卷":1,"标题":"四到六字","起章":1,"止章":8,"卷主题":"核心命题","主线":"推进什么","高潮":"卷末翻转","伏笔":"埋下/回收的悬念"}]
最后一卷止章=${target}，各卷主题层层递进。`;
}
function chaptersPrompt(s: ProjectSpec, bp: Record<string, any>, vols: any[]): string {
  return `基于作品包与卷纲生成逐章细纲，严格遵守禁止项与金手指边界。
作品包：${JSON.stringify(bp)}
卷纲：${JSON.stringify(vols)}
只输出 JSON 数组：[{"no":1,"title":"章名≥5字无感叹号","wordType":"静场|常规|反击|高潮|极短","summary":"本章具体发生什么，50-90字，不要套话","darkPoint":"暗爽点或信息增量"}]
每章 summary 必须不同、有因果推进，禁止「主角在第N章遭遇关键事件」占位套话。`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const validBp = (o: any): boolean => !!(o && typeof o === "object" && (o["主角"] || o["主线冲突"]));
const validVols = (o: any): boolean => !!(Array.isArray(o) && o.length && o.every((v: any) => v && v["起章"] != null && v["止章"] != null));
const validChs = (o: any): boolean => !!(Array.isArray(o) && o.length && o.every((c: any) => c && c.no && c.summary));

async function llmJson(llm: LlmClient, system: string, user: string, validator: (o: any) => boolean, log: (m: string) => void, label: string): Promise<any | null> {
  if (llm.mock) return null;
  for (let i = 1; i <= 2; i++) {
    try {
      log(`AI 生成${label}（第 ${i} 次）…`);
      const raw = await llm.chat([{ role: "system", content: system }, { role: "user", content: user }]);
      const obj = extractJson(raw);
      if (obj && validator(obj)) return obj;
      log(`${label}返回格式不符，重试中…`);
    } catch (e) { log(`${label}失败：${(e as Error).message.slice(0, 80)}`); }
  }
  return null;
}

// ---- 演示兜底（有结构、非占位套话）----
function demoBp(s: ProjectSpec): Record<string, any> {
  const 题材 = s.题材 || "这个行当";
  return {
    "一句话定位": `一部以${s.爽点类型}驱动、靠证据与选择推进的${题材}故事`,
    "世界规则": [`${题材}里的位置由可验证的实力决定`, "任何优势都要付出可见代价", "规则本身可能被更高层规则反制", "信息就是筹码"],
    "主角": "被低估的局内人；渴望拿回主动权；缺陷是过度相信自己的判断",
    "人设禁止项": ["不靠嘴炮翻盘", "不接受天降好运", "不对弱者使用优势", "不在情绪里做决定", "不背叛自己的底线"],
    "金手指": `对${s.反派类型}的运行规律有超出常人的洞察`,
    "金手指边界": ["只对已掌握信息有效", "深度推演消耗心力", "判断错了要承担后果"],
    "调性对立面": "不是苦情、不是说教、不是无脑爽、不是靠巧合推进",
    "主线冲突": "主角要用被规则承认的方式，反制利用规则的人",
    "爽点节奏": "每章一个信息增量，每 3 章一次反制，每卷末一次翻盘",
    "结局契约": "核心矛盾得到解决且伏笔回收",
  };
}
function demoVols(target: number): any[] {
  const tpl = [
    ["入局", "被低估者看清局面", "第一次亮牌", "谁在暗中推动一切"],
    ["试探", "规则内的第一次交锋", "用规则反制", "留下未解释的破绽"],
    ["暗涌", "旧账浮出阵线重组", "关键情报揭示", "情报来源可疑"],
    ["对决", "正面对峙代价升级", "局面翻转", "翻盘埋下隐患"],
    ["清算", "真相与责任归属", "最终摊牌", "长线伏笔收束"],
    ["新局", "余波与新的开始", "旧秩序落幕", "新悬念开启"],
  ];
  const cnt = Math.max(3, Math.min(6, Math.ceil(target / 8)));
  return Array.from({ length: cnt }, (_, i) => {
    const t = tpl[Math.min(i, tpl.length - 1)];
    const start = Math.floor(i * target / cnt) + 1;
    const end = i === cnt - 1 ? target : Math.floor((i + 1) * target / cnt);
    return { "卷": i + 1, "标题": t[0], "起章": start, "止章": end, "卷主题": t[1], "主线": `${t[1]}，主角逼近核心矛盾`, "高潮": t[2], "伏笔": t[3] };
  });
}
function demoChs(s: ProjectSpec, bp: Record<string, any>, vols: any[]): ChapterSpec[] {
  const beats = [
    "一个被忽略的细节被主角记住，成为后续唯一能核查的线索",
    "对方抛出条件，主角没有立刻答应，而是先确认规则边界",
    "所有人都以为胜负已定，主角却把注意力放在无人留意的环节",
    "一次看似平常的接触，暴露出此前说法里的漏洞",
    "主角主动让出表面优势，换取对手放松警惕后的真实动作",
    "被压住的旧事重新被提起，局势从暗处转到明面",
    "主角用对方曾定下的规则，逼出一个无法回避的选择",
    "关键证据最后一刻出现，但来源比证据本身更值得追问",
    "短暂休整里，主角把零散线索串成一条完整的链",
    "局面翻向主角一边，代价是暴露了自己的真正底牌",
  ];
  const chs: ChapterSpec[] = [];
  for (const v of vols) {
    const start = Number(v["起章"]) || chs.length + 1;
    const end = Number(v["止章"]) || start;
    const namePool = ["暗流初现之时", "局内试探深浅", "旧账重新提起", "证据终于浮现", "阵线悄然重组", "以规则反制", "真相碎片拼接", "临门最后一脚", "关键抉择时刻", "余波仍未平息"];
    for (let no = start; no <= end; no++) {
      const idx = chs.length;
      chs.push({
        no,
        title: namePool[idx % namePool.length],
        wordType: "常规",
        summary: `在「${v["卷主题"] || v["标题"]}」的推进中，${beats[idx % beats.length]}；主角据此调整下一步。`,
        darkPoint: "边界之下的一次精准判断得到回报",
      });
    }
  }
  return chs;
}

/** 执行规划三阶段，结果写入 repo 的 plan.json 与 spec.json */
export async function runPlanning(
  repo: WorkRepo,
  id: string,
  llm: LlmClient,
  log: (m: string) => void,
  shouldStop: () => boolean,
): Promise<{ plan: PlanState; spec: ProjectSpec }> {
  const spec = repo.getSpec(id);
  let plan: PlanState = (repo.getPlan(id) as PlanState) || {
    status: "pending", engine: llm.mock ? "demo" : "ai", blueprint: null, volumes: [], error: "", updatedAt: "",
  };
  if (plan.status === "planned" && spec.chapters?.length) return { plan, spec };
  plan.status = "planning";
  plan.engine = llm.mock ? "demo" : "ai";
  plan.updatedAt = new Date().toISOString();
  repo.savePlan(id, plan as any);
  log(`规划引擎：${llm.mock ? "内置演示引擎" : "LLM"}`);
  const target = spec.章节数目标 || 8;

  // 阶段1 作品包
  if (!validBp(plan.blueprint)) {
    log("阶段 1/3 · 生成作品包（定位 + 锁定层）…");
    const bp = llm.mock ? demoBp(spec)
      : await llmJson(llm, PLAN_SYSTEM, blueprintPrompt(spec), validBp, log, "作品包") || demoBp(spec);
    plan.blueprint = bp;
    repo.savePlan(id, plan as any);
    log(`作品包已生成：主线「${bp["主线冲突"] || "—"}」`);
    await sleep(llm.mock ? 400 : 100);
  } else log("阶段 1/3 · 作品包已存在，跳过");
  if (shouldStop()) { plan.status = "failed"; repo.savePlan(id, plan as any); return { plan, spec }; }

  // 阶段2 卷纲
  if (!validVols(plan.volumes)) {
    log(`阶段 2/3 · 生成卷纲（${target} 章分卷）…`);
    const vols = llm.mock ? demoVols(target)
      : await llmJson(llm, PLAN_SYSTEM, volumesPrompt(spec, plan.blueprint!, target), validVols, log, "卷纲") || demoVols(target);
    plan.volumes = vols;
    repo.savePlan(id, plan as any);
    log(`卷纲已生成：${vols.length} 卷`);
    await sleep(llm.mock ? 400 : 100);
  } else log(`阶段 2/3 · 卷纲已存在（${plan.volumes.length} 卷），跳过`);
  if (shouldStop()) { plan.status = "failed"; repo.savePlan(id, plan as any); return { plan, spec }; }

  // 阶段3 章纲
  if (!spec.chapters?.length) {
    log(`阶段 3/3 · 生成 ${target} 章细纲…`);
    const 梗概 = spec.梗概输入 || [];
    let chs: ChapterSpec[] = llm.mock ? demoChs(spec, plan.blueprint!, plan.volumes)
      : (await llmJson(llm, PLAN_SYSTEM, chaptersPrompt(spec, plan.blueprint!, plan.volumes), validChs, log, "章纲") || demoChs(spec, plan.blueprint!, plan.volumes)) as ChapterSpec[];
    chs = chs.map((c: ChapterSpec, i: number) => {
      const no = Number((c as any).no) || i + 1;
      const title = (String((c as any).title || "").replace(/^第\d+章\s*/, "").trim() || `第${no}章 ${["暗流初现之时", "局内试探深浅", "旧账重新提起", "关键抉择时刻"][i % 4]}`);
      return {
      no,
      title,
      wordType: (["静场", "常规", "反击", "高潮", "极短"].includes((c as any).wordType) ? (c as any).wordType : "常规") as ChapterSpec["wordType"],
      summary: 梗概[i] || String((c as any).summary || ""),
      darkPoint: String((c as any).darkPoint || ""),
      };
    }).filter((c) => c.summary);
    spec.chapters = chs;
    repo.savePlan(id, plan as any);
    // 直接改 spec.json（repo 无 saveSpec，用原子写等价实现）
    const specFile = (repo as any).workDir(id);
    const fs = await import("node:fs");
    const path = await import("node:path");
    const f = path.join(specFile, "spec.json");
    fs.writeFileSync(f + ".tmp", JSON.stringify(spec, null, 2), "utf8");
    fs.renameSync(f + ".tmp", f);
    log(`章纲已生成：${chs.length} 章，每章细纲各异`);
    await sleep(llm.mock ? 400 : 100); // 留出章纲阶段可感知停留，避免三阶段一帧闪过
  } else log(`阶段 3/3 · 章纲已存在（${spec.chapters.length} 章），跳过`);

  plan.status = "planned";
  plan.error = "";
  plan.updatedAt = new Date().toISOString();
  repo.savePlan(id, plan as any);
  log(`规划完成：作品包 + ${plan.volumes.length} 卷 + ${spec.chapters.length} 章细纲`);
  return { plan, spec };
}
