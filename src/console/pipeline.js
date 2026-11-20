/**
 * 浏览器端全自动创作流水线（零服务端）。
 * 立项 → 自动规划章节 → 逐章：写稿(LLM/演示) → 内嵌评审 → 打回重写 → 定稿。
 * 进度实时回调，数据存 localStorage，支持取消与断点续跑。
 */
import { RULES, normalizeEnum, reviewChapter, rewriteHint } from "./engine.js";

const LS_KEY = "novelfactory.works.v1";
const SETTINGS_KEY = "novelfactory.settings.v1";

// ---------- 本地存储 ----------
export function loadWorks() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || "[]"); } catch { return []; }
}
function saveWorks(works) { localStorage.setItem(LS_KEY, JSON.stringify(works)); }
export function getWork(id) { return loadWorks().find((w) => w.id === id) || null; }
export function deleteWork(id) { saveWorks(loadWorks().filter((w) => w.id !== id)); }

export function loadSettings() {
  const fallback = { baseURL: "", apiKey: "", model: "gpt-4o-mini", temperature: 0.85,
    useXiezhi: true, maxRetries: 2, maxCalls: 0, maxCallsPerChapter: 0, priceIn: 1, priceOut: 4 };
  try { return { ...fallback, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") }; } catch { return fallback; }
}
export function saveSettings(s) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }

// ---------- 数据管理：备份 / 恢复 / 清空 / 统计 ----------
export const DATA_KEYS = {
  works: LS_KEY,
  settings: SETTINGS_KEY,
  profile: "novelfactory.profile.v1",
};
export const BACKUP_FORMAT = 1;

// 收集全部本机数据，组装成带版本与校验信息的备份对象
export function buildBackup() {
  const safeGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } };
  return {
    app: "novel-factory",
    format: BACKUP_FORMAT,
    exportedAt: new Date().toISOString(),
    data: {
      works: safeGet(DATA_KEYS.works) || [],
      settings: safeGet(DATA_KEYS.settings) || {},
      profile: safeGet(DATA_KEYS.profile) || {},
    },
  };
}

// 校验备份对象结构；通过返回 {ok:true,summary}，否则 {ok:false,error}
export function validateBackup(obj) {
  if (!obj || typeof obj !== "object") return { ok: false, error: "文件不是有效的 JSON 对象" };
  if (obj.app !== "novel-factory") return { ok: false, error: "这不是小说工厂的备份文件" };
  if (obj.format !== BACKUP_FORMAT) return { ok: false, error: `备份格式版本不兼容（需要 v${BACKUP_FORMAT}）` };
  const d = obj.data;
  if (!d || !Array.isArray(d.works)) return { ok: false, error: "备份缺少作品数据" };
  if (!d.settings || typeof d.settings !== "object" || Array.isArray(d.settings)) return { ok: false, error: "备份缺少设置数据" };
  if (!d.profile || typeof d.profile !== "object" || Array.isArray(d.profile)) return { ok: false, error: "备份缺少成长档案数据" };
  const chapters = d.works.reduce((s, w) => s + (Array.isArray(w?.chapters) ? w.chapters.length : 0), 0);
  return { ok: true, summary: { works: d.works.length, chapters } };
}

// 用备份覆盖本机数据（调用前应已通过 validateBackup）
export function restoreBackup(obj) {
  localStorage.setItem(DATA_KEYS.works, JSON.stringify(obj.data.works));
  localStorage.setItem(DATA_KEYS.settings, JSON.stringify(obj.data.settings));
  localStorage.setItem(DATA_KEYS.profile, JSON.stringify(obj.data.profile));
}

// 仅清空作品，保留设置与成长档案
export function clearWorks() { localStorage.setItem(DATA_KEYS.works, "[]"); }

// 恢复出厂：清除本 App 全部数据键（含一次性引导标记）
export function resetAllData() {
  const flags = ["novelfactory.onboarded.v1", "novelfactory.demoGuideSeen.v1", "novelfactory.batteryAsked.v1", "novelfactory.reader"];
  Object.values(DATA_KEYS).concat(flags).forEach((k) => { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch {} });
}

// 统计本机数据占用与规模
export function storageStats() {
  let bytes = 0;
  Object.values(DATA_KEYS).forEach((k) => {
    const v = localStorage.getItem(k) || "";
    bytes += k.length + v.length; // UTF-16 近似，量级足够
  });
  const works = loadWorks();
  const chapters = works.reduce((s, w) => s + (w.chapters?.length || 0), 0);
  const size = bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return { works: works.length, chapters, bytes, size };
}

// ---------- 自动规划（与 repo.ts 一致） ----------
const CHAPTER_NAMES = ["开局", "试探", "反转", "立威", "伏笔", "暗涌", "对决", "清算", "余波", "新局"];
const DARK_POINTS = ["被低估者的第一次亮牌", "用对方制定的规则反制对方", "沉默比争辩更有力量的清醒", "关键情报在最后一刻揭示", "胜利背后埋下更大的悬念"];
const WORD_TYPES = ["常规", "反击", "静场", "高潮", "极短"];

// 新建作品：只登记用户的方向输入，不生成任何章纲。
// 作品包 / 卷纲 / 章纲 由 AI 在 runPlan() 里按规范流程逐阶段生成——杜绝"创建即秒成纲"。
export function createWork(input) {
  const id = "w" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const 书名 = String(input.书名 || "未命名之书").trim();
  const 题材 = String(input.题材 || "都市异能").trim();
  const n = Math.max(1, Math.min(60, Number(input.章节数) || 5));
  const 梗概 = Array.isArray(input.章节梗概) ? input.章节梗概.map((s) => String(s).trim()).filter(Boolean) : [];
  const spec = {
    projectId: id, 项目名: `${书名}·创作项目`, 书名,
    平台: input.平台 || "番茄",  platform: input.平台 || "番茄",
    受众: input.受众 || "泛读者", 性别向: input.性别向 || "男频",
    情感契约: normalizeEnum("爽", RULES.positioning_enums.情感契约, "爽"),
    改编形态: input.改编形态 || "短剧",
    爽点类型: normalizeEnum(input.爽点类型, RULES.positioning_enums.爽点类型, "解谜智性"),
    反派类型: normalizeEnum(input.反派类型, RULES.positioning_enums.反派类型, "规则"),
    差异化: `每章围绕「${题材}」提供一个可验证的信息增量`,
    tone: input.调性 || "通用", 题材,
    章节数目标: n,
    梗概输入: 梗概,
    chapters: [],   // 规划前为空：由 AI 章纲填充，不再套模板
  };
  const work = {
    id, spec, status: "new", chapters: [],
    plan: { status: "pending", engine: "", blueprint: null, volumes: [], error: "", updatedAt: new Date().toISOString() },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const works = loadWorks(); works.unshift(work); saveWorks(works);
  return work;
}

// ==================== AI 规划三阶段：作品包 → 卷纲 → 章纲 ====================
// 大禹 CDA 方法论：先建笼子（定位/锁定/结构），再逐章跳舞。
// 有 Key → 真实 LLM 产出严格 JSON；无 Key → 演示引擎按规范结构生成有差异的内容。
// 每阶段都落盘 work.plan，支持断点续跑与中断。

/** 从 LLM 文本里稳健抽取 JSON（容忍 ```json 围栏、前后解释文字） */
export function extractJson(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try { return JSON.parse(s); } catch { /* 继续尝试截取 */ }
  const start = s.search(/[\[{]/);
  if (start < 0) return null;
  // 从第一个 { 或 [ 起，逐个尝试到结尾，取能解析的最长片段
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

/** 阶段1 · 作品包：定位决策 + 锁定层（人设禁止项/金手指边界/调性对立面/世界规则/主线） */
function blueprintPrompt(spec) {
  return `为下面这部小说生成「创作作品包」（定位层 + 锁定层），作为后续卷纲、章纲、正文必须遵守的硬约束。

书名：《${spec.书名}》　平台：${spec.平台}　题材：${spec.题材}
受众：${spec.受众}　性别向：${spec.性别向}　情感契约：${spec.情感契约}
爽点类型：${spec.爽点类型}　反派类型：${spec.反派类型}　调性：${spec.tone}

只输出一个 JSON 对象，字段如下（值用中文，数组每项一句话）：
{
  "一句话定位": "这本书和同类最关键的不同（差异化卖点）",
  "世界规则": ["这个世界 3-5 条不可违背的运行规则"],
  "主角": "主角身份 + 核心欲望 + 致命缺陷（各一句）",
  "人设禁止项": ["主角绝对不会做的 5 件事（否定式定义）"],
  "金手指": "主角的核心能力/优势是什么",
  "金手指边界": ["能力的 3 条限制或代价，禁止无敌"],
  "调性对立面": "本书明确不是什么（反义词定义，如：不是苦情、不是说教）",
  "主线冲突": "贯穿全书的核心矛盾一句话",
  "爽点节奏": "读者每隔多少章得到什么回报的节奏设计",
  "结局契约": "结尾必须兑现的承诺（如明确 HE / 真相揭晓）"
}`;
}

/** 阶段2 · 卷纲：把目标章数切成若干卷，每卷起止章 + 主题 + 高潮 + 伏笔 */
function volumesPrompt(spec, blueprint, targetChapters) {
  return `基于下面这部小说的「作品包」，规划分卷大纲。全书共 ${targetChapters} 章，切成 3-6 卷，每卷连续覆盖章节、不重不漏。

作品包（硬约束）：
${JSON.stringify(blueprint, null, 2)}

只输出一个 JSON 数组，每个元素是一卷：
[
  {"卷":1,"标题":"四到六字卷名","起章":1,"止章":8,
   "卷主题":"本卷要解决的核心命题",
   "主线":"本卷推进了什么",
   "高潮":"本卷末尾的翻转或决战",
   "伏笔":"本卷埋下/回收的悬念"}
]
要求：止章连续、最后一卷止章=${targetChapters}；各卷主题层层递进，不重复。`;
}

/** 阶段3 · 章纲：为每卷生成逐章细纲（title/summary/darkPoint/wordType） */
function chaptersPrompt(spec, blueprint, volumes) {
  return `基于「作品包」和「卷纲」，为每一章生成可用于写稿的细纲。严格遵守作品包的禁止项、金手指边界、调性对立面。

作品包：
${JSON.stringify(blueprint, null, 2)}
卷纲：
${JSON.stringify(volumes, null, 2)}

只输出一个 JSON 数组，每个元素一章，按章号升序：
[
  {"no":1,"title":"章名（可见字数≥5，无感叹号）","wordType":"静场|常规|反击|高潮|极短",
   "summary":"本章具体发生什么（含推进主线的动作，50-90字，不要套话）",
   "darkPoint":"本章的暗爽点或信息增量"}
]
要求：每章 summary 必须不同、彼此有因果推进；禁止「主角在第N章遭遇关键事件」这类占位套话；wordType 随卷内节奏起伏分布。`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 调 LLM 并解析 JSON，失败重试一次 */
async function planLlmJson(settings, system, user, validator, hooks, label) {
  if (!settings.baseURL || !settings.apiKey) return null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      hooks.onLog?.(`AI 生成${label}（第 ${attempt} 次）…`);
      const raw = await callLlm(settings, system, user);
      const obj = extractJson(raw);
      if (obj && (!validator || validator(obj))) return obj;
      hooks.onLog?.(`${label}返回格式不符，重试中…`);
    } catch (e) {
      hooks.onLog?.(`${label}调用失败：${(e.message || e).toString().slice(0, 80)}`);
    }
  }
  return null;
}

/** 演示引擎 · 作品包（有结构、非套话） */
function demoBlueprint(spec) {
  const 题材 = spec.题材 || "这个行当";
  return {
    "一句话定位": `一部以${spec.爽点类型}驱动、靠证据与选择推进的${题材}故事`,
    "世界规则": [`${题材}里的位置由可验证的实力决定`, "任何优势都要付出可见代价", "规则本身可能被更高层的规则反制", "信息就是筹码，谁先亮牌谁先受限"],
    "主角": `被低估的局内人；渴望拿回主动权；缺陷是过度相信自己的判断`,
    "人设禁止项": ["不靠嘴炮翻盘", "不接受天降好运", "不对弱者使用优势", "不在情绪里做决定", "不背叛自己的底线"],
    "金手指": `对${spec.反派类型}的运行规律有超出常人的洞察`,
    "金手指边界": ["洞察只对已掌握信息有效", "每次深度推演都要消耗心力", "判断错了要承担后果"],
    "调性对立面": `不是苦情、不是说教、不是无脑爽、不是靠巧合推进`,
    "主线冲突": `主角要用被规则承认的方式，反制利用规则的人`,
    "爽点节奏": "每章一个信息增量，每 3 章一次反制，每卷末一次翻盘",
    "结局契约": spec.情感契约 === "共鸣" ? "主角与世道和解，代价真实" : "核心矛盾得到解决且伏笔回收",
  };
}
/** 演示引擎 · 卷纲（章节连续、层层递进） */
function demoVolumes(target) {
  const templates = [
    ["入局", "被低估者看清局面", "第一次亮牌", "谁在暗中推动一切"],
    ["试探", "规则内的第一次交锋", "用对方规则反制", "留下一个未被解释的破绽"],
    ["暗涌", "旧账浮出，阵线重组", "关键情报揭示", "情报来源本身可疑"],
    ["对决", "正面对峙，代价升级", "局面翻转", "翻盘埋下更大隐患"],
    ["清算", "真相与责任的归属", "最终摊牌", "长线伏笔收束"],
    ["新局", "余波与新的开始", "旧秩序落幕", "新的悬念开启"],
  ];
  const cnt = Math.max(3, Math.min(6, Math.ceil(target / 8)));
  const vols = [];
  for (let v = 1; v <= cnt; v++) {
    const t = templates[Math.min(v - 1, templates.length - 1)];
    const start = Math.floor((v - 1) * target / cnt) + 1;
    const end = v === cnt ? target : Math.floor(v * target / cnt);
    vols.push({ "卷": v, "标题": t[0], "起章": start, "止章": end, "卷主题": t[1], "主线": `${t[1]}，主角向核心矛盾逼近`, "高潮": t[2], "伏笔": t[3] });
  }
  return vols;
}
/** 演示引擎 · 章纲（每章不同、有因果推进，非占位套话） */
function demoChapters(spec, blueprint, volumes) {
  const beats = [
    "一个被忽略的细节被主角记住，成为后续唯一能核查的线索",
    "对方抛出条件，主角没有立刻答应，而是先确认规则边界",
    "所有人都以为胜负已定，主角却把注意力放在无人留意的环节",
    "一次看似平常的接触，暴露出此前说法里的漏洞",
    "主角主动让出表面优势，换取对手放松警惕后的真实动作",
    "被压住的旧事重新被提起，局势从暗处转到明面",
    "主角用对方曾定下的规则，逼出一个无法回避的选择",
    "关键证据在最后一刻出现，但来源比证据本身更值得追问",
    "短暂休整里，主角把零散线索串成一条完整的链",
    "局面翻向主角一边，代价是暴露了自己的真正底牌",
  ];
  const opens = ["清晨的线索", "一通没有署名的消息", "被退回的旧档", "会场角落的对话", "临行前的停顿", "雨夜的来访", "桌面上多出的文件", "一句说漏的话"];
  const chapters = [];
  let no = 1;
  for (const vol of volumes) {
    const count = Math.max(1, (vol.止章 || no) - no + 1);
    for (let k = 0; k < count && no <= (vol.止章 || no); k++, no++) {
      const wt = k === count - 1 ? "高潮" : k === 1 ? "反击" : k === count - 2 ? "静场" : "常规";
      chapters.push({
        no,
        title: `${opens[(no - 1) % opens.length]}·${String(vol.标题 || "卷").slice(0, 4)}`,
        wordType: wt,
        summary: `在「${vol.卷主题 || vol.标题}」的推进中，${beats[(no - 1) % beats.length]}；主角据此调整下一步，让局面朝有利方向偏移。`,
        darkPoint: `${blueprint.金手指边界?.[no % (blueprint.金手指边界?.length || 1)] || "边界"}之下的一次精准判断得到回报`,
      });
    }
  }
  // 兜底：卷纲覆盖不全时按目标数补齐
  const target = spec.章节数目标 || spec.chapters?.length || chapters.length;
  while (chapters.length < target) {
    const no2 = chapters.length + 1;
    chapters.push({
      no: no2,
      title: `${opens[(no2 - 1) % opens.length]}·续`,
      wordType: "常规",
      summary: `${beats[(no2 - 1) % beats.length]}；这一章把前面积的势转化成可见的进展。`,
      darkPoint: "沉默中的一次有效反制得到兑现",
    });
  }
  return chapters;
}

/** 校验器 */
const validBlueprint = (o) => o && typeof o === "object" && (o["主角"] || o["主线冲突"]);
const validVolumes = (o) => Array.isArray(o) && o.length > 0 && o.every((v) => v && v["起章"] != null && v["止章"] != null);
const validChapters = (o) => Array.isArray(o) && o.length > 0 && o.every((c) => c && c.no && c.summary);

/**
 * 规划三阶段：作品包 → 卷纲 → 章纲。结果落盘 work.plan + spec.chapters。
 * 支持中断：每阶段完成即保存；下次调用从已完成阶段继续。
 */
export async function runPlan(id, hooks = {}) {
  const emit = (m) => hooks.onLog?.(m);
  const settings = loadSettings();
  const works = loadWorks();
  const work = works.find((w) => w.id === id);
  if (!work) throw new Error("作品不存在");
  const isDemo = !(settings.baseURL && settings.apiKey);
  emit(`规划引擎：${isDemo ? "内置演示引擎（未配置模型）" : `模型 ${settings.model}`}`);
  if (!work.plan) work.plan = { status: "planning", engine: isDemo ? "demo" : "ai", blueprint: null, volumes: [], error: "", updatedAt: "" };
  work.plan.status = "planning";
  work.plan.engine = isDemo ? "demo" : "ai";
  work.status = "planning";
  const persist = () => { work.plan.updatedAt = work.updatedAt = new Date().toISOString(); saveWorks(works); };
  persist();

  const target = work.spec.章节数目标 || 8;

  // 阶段 1 · 作品包
  let blueprint = work.plan.blueprint;
  if (!blueprint || !validBlueprint(blueprint)) {
    emit("阶段 1/3 · AI 正在生成作品包（定位 + 锁定层）…");
    blueprint = isDemo ? demoBlueprint(work.spec)
      : await planLlmJson(settings, PLAN_SYSTEM, blueprintPrompt(work.spec), validBlueprint, hooks, "作品包");
    if (!blueprint) { blueprint = demoBlueprint(work.spec); emit("作品包降级为演示内容"); }
    work.plan.blueprint = blueprint;
    persist();
    emit(`作品包已生成：主线「${blueprint["主线冲突"] || "—"}」`);
    await sleep(isDemo ? 500 : 120);
  } else emit("阶段 1/3 · 作品包已存在，跳过");

  // 阶段 2 · 卷纲
  let volumes = work.plan.volumes;
  if (!Array.isArray(volumes) || !volumes.length || !validVolumes(volumes)) {
    emit(`阶段 2/3 · AI 正在生成卷纲（共 ${target} 章分卷）…`);
    volumes = isDemo ? demoVolumes(target)
      : await planLlmJson(settings, PLAN_SYSTEM, volumesPrompt(work.spec, blueprint, target), validVolumes, hooks, "卷纲");
    if (!volumes) { volumes = demoVolumes(target); emit("卷纲降级为演示内容"); }
    work.plan.volumes = volumes;
    persist();
    emit(`卷纲已生成：${volumes.length} 卷`);
    await sleep(isDemo ? 500 : 120);
  } else emit(`阶段 2/3 · 卷纲已存在（${volumes.length} 卷），跳过`);

  // 阶段 3 · 章纲
  let chapters = work.spec.chapters || [];
  if (!Array.isArray(chapters) || !chapters.length) {
    emit(`阶段 3/3 · AI 正在生成 ${target} 章细纲…`);
    const 梗概 = work.spec.梗概输入 || [];
    chapters = isDemo ? demoChapters(work.spec, blueprint, volumes)
      : await planLlmJson(settings, PLAN_SYSTEM, chaptersPrompt(work.spec, blueprint, volumes), validChapters, hooks, "章纲");
    if (!chapters) { chapters = demoChapters(work.spec, blueprint, volumes); emit("章纲降级为演示内容"); }
    // 用户手填梗概优先覆盖 summary
    if (梗概.length) chapters = chapters.map((c, i) => (梗概[i] ? { ...c, summary: 梗概[i] } : c));
    // 规整字段：缺 no 的补齐、title 去章号前缀交由写稿层处理
    chapters = chapters.map((c, i) => {
      const no = Number(c.no) || i + 1;
      const cleanTitle = String(c.title || "").replace(/^第\d+章\s*/, "").trim();
      return {
      no,
      title: cleanTitle || `第${no}章 ${["暗流初现之时", "局内试探深浅", "旧账重新提起", "关键抉择时刻"][i % 4]}`,
      wordType: ["静场", "常规", "反击", "高潮", "极短"].includes(c.wordType) ? c.wordType : "常规",
      summary: String(c.summary || ""),
      darkPoint: String(c.darkPoint || ""),
      };
    }).filter((c) => c.summary);
    work.spec.chapters = chapters;
    persist();
    emit(`章纲已生成：${chapters.length} 章，每章细纲各异`);
    await sleep(isDemo ? 500 : 120); // 留出章纲阶段的可感知停留，避免三阶段一帧闪过
  } else emit(`阶段 3/3 · 章纲已存在（${chapters.length} 章），跳过`);

  work.plan.status = "planned";
  work.status = "planned";
  work.plan.error = "";
  persist();
  emit(`规划完成：作品包 + ${volumes.length} 卷 + ${chapters.length} 章细纲`);
  hooks.onProgress?.({ current: 0, total: chapters.length, label: "规划完成，可开始创作", stage: "规划" });
  return work;
}

// ---------- 写稿 ----------
const SYSTEM_RULES = [
  "你是网文写稿 Agent，遵守以下铁律：",
  "1. 不写大段括号注释或内部标注（TTS 会逐字读出）",
  "2. 禁用油腻词：仿佛/似乎/嘴角勾起/狂妄一笑/全场震惊 等",
  "3. 禁用 Markdown 符号与感叹号堆砌；对话一人一段，引号闭合",
  "4. 不写可复现的命令/SQL/文件路径，技术描写停留在流程层",
  "5. 每章必须有暗爽点与信息增量，章末留钩子但不用套语",
  "6. 数字用中文或中性表述，避免裸数字；只输出正文，不要标题/解释/代码块",
].join("\n");

async function callLlm(settings, system, user) {
  if (!settings.baseURL || !settings.apiKey) return null; // 用演示引擎
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  try {
    const resp = await fetch(settings.baseURL.replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify({ model: settings.model, messages: [{ role: "system", content: system }, { role: "user", content: user }], temperature: settings.temperature, max_tokens: 4096 }),
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`模型 HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const data = await resp.json();
    return (data?.choices?.[0]?.message?.content || "").trim() || null;
  } finally { clearTimeout(timer); }
}

const CN = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
const cnNum = (n) => n < 10 ? CN[n] : n < 20 ? "十" + (n % 10 ? CN[n % 10] : "") : n < 100 ? CN[Math.floor(n/10)] + "十" + (n % 10 ? CN[n % 10] : "") : String(n);

// 演示引擎语料池：按章号轮转，保证每章开场/推进/钩子各不相同
const DEMO_SCENES = [
  "天色未亮，城里的灯还亮着，他已站在那扇门前。", "消息传开的时候，他正低头整理袖口，没有抬头。",
  "会场里坐满了人，空气里有一层压着的躁动。", "那通电话挂断后，房间里只剩下钟摆的声音。",
  "雨停在凌晨，街面反着光，像铺了一层冷硬的镜。", "他把那份东西推到桌子中央，手指在上面停了一瞬。",
  "走廊尽头传来脚步声，节奏比平时急了半拍。", "所有人都以为事情已经结束，只有他知道还差一步。",
  "窗外的喧嚣隔了一层玻璃，落不到这张桌上。", "再见面时，双方的立场已经和上次完全不同。",
];
const DEMO_BEATS = [
  "他没有急着开口，先把对方的话在心里过了一遍。", "真正要紧的不是谁嗓门大，而是谁手里有能被验证的东西。",
  "这一步他等的不是时机，而是一个不会被人抢走的证据。", "他没有反驳那句断言，只是把事实一条条摆了出来。",
  "旁人看的是热闹，他看的是这条规则到底替谁服务。", "沉默里，他把最关键的那一环补上了。",
  "他没有争那口气，因为结果本身会替他说话。", "局面在那一刻翻了个方向，慢，却稳。",
  "他留了余地，不是心软，是为了让对方自己走到台前。", "所有铺垫都指向同一个答案，而这一次没人能替他改写。",
];
const DEMO_HOOKS = [
  "门合上的一瞬，他听见里面有人叫出了那个不该被知道的名字。", "而真正的麻烦，是从这份平静之后才开始的。",
  "他收好东西，心思已经落到了下一场。", "名单的最后一栏空着，像是特意留给谁的。",
  "他回头看了一眼，那盏灯还亮着。", "这一次，轮到别人来问他要一个解释。",
  "纸页翻到背面，字迹和正面出自同一只手。", "他没有解释，因为解释的时机还没到。",
  "远处的信号闪了两下，像是某种回应。", "他把这一页折好，故事才刚翻开真正的一章。",
];

/** 演示引擎：第一稿故意带油腻词+裸数字触发打回；第二稿按章节信息生成差异化长正文 */
function demoWrite(spec, chapter, attempt, hint) {
  const no = chapter.no || 1;
  if (attempt === 1) {
    return `第${no}章开始了。\n\n他嘴角勾起一抹狂妄的笑，仿佛一切尽在掌握，嚣张地走向检测台。\n\n全场震惊，所有人都愣在原地。\n\n数字123出现在屏幕上。`;
  }
  const book = spec?.书名 || "这本书";
  const genre = spec?.题材 || "这个行当";
  let title = (chapter.title || "新的局面").replace(/^第\d+章\s*/, "") || "新的局面";
  const summary = chapter.summary || "";
  const dark = chapter.darkPoint || "";
  const wt = chapter.wordType || "常规";
  const scene = DEMO_SCENES[no % DEMO_SCENES.length];
  const beat = DEMO_BEATS[(no + 2) % DEMO_BEATS.length];
  const beat2 = DEMO_BEATS[(no + 5) % DEMO_BEATS.length];
  const hook = DEMO_HOOKS[no % DEMO_HOOKS.length];
  const tone = wt === "静场" ? "这一章没有争吵，只有几个人各自的心思在桌面下暗暗较劲。"
    : wt === "高潮" || wt === "反击" ? "该亮的东西终于亮了出来，局面在一瞬间失去了原来的平衡。"
    : wt === "极短" ? "一句多余的话都没有，该说的都落在了动作里。"
    : "节奏没有加快，每一步却都比上一步更接近核心。";
  return [
    `第${cnNum(no)}章 ${title}`,
    scene,
    summary,
    `在《${book}》的这条线上，${genre}里的每个人都按自己的位置站着，谁也没有多说一句。`,
    beat,
    dark ? `这正是${dark}。` : "",
    "他把自己能掌控的部分做到极致，剩下的交给时间。",
    beat2,
    tone,
    "等众人回过神，他已经把最要紧的那件事做完。",
    hook,
  ].filter(Boolean).join("\n\n");
}

async function writeOnce(settings, spec, chapter, attempt, hint) {
  const user = [
    `请写${chapter.title}正文。字数类型：${chapter.wordType}。`,
    `本章摘要：${chapter.summary}`,
    `暗爽点：${chapter.darkPoint}`,
    `人设：${spec.性别向} / 调性${spec.tone} / 爽点${spec.爽点类型} / 反派${spec.反派类型}。`,
    hint ? `\n【上一版被打回，务必修正】\n${hint}` : "",
    "\n直接输出正文，不要标题、解释或代码块。",
  ].filter(Boolean).join("\n");
  const fromLlm = await callLlm(settings, SYSTEM_RULES, user);
  return fromLlm || demoWrite(spec, chapter, attempt, hint);
}

// ---------- 主流水线 ----------
export async function runWork(id, hooks = {}) {
  const emit = (msg) => hooks.onLog?.(msg);
  const settings = loadSettings();
  let work = getWork(id);
  if (!work) throw new Error("作品不存在");
  if (work.status === "running") throw new Error("该作品正在创作中");
  let stopped = false;
  const shouldStop = () => { if (hooks.shouldStop?.()) stopped = true; return stopped; };

  // ===== 阶段 0：若尚未规划，先按规范流程生成作品包→卷纲→章纲 =====
  // 这是"AI 按规范流程生成"的核心：建作品不秒成纲，创作时才真正规划。
  const needPlan = !work.plan || work.plan.status !== "planned" ||
    !Array.isArray(work.spec.chapters) || work.spec.chapters.length === 0;
  if (needPlan) {
    await runPlan(id, hooks);
    if (shouldStop()) return getWork(id);
    work = getWork(id); // runPlan 更新了 localStorage，重新取
  } else {
    emit(`复用已规划：作品包 + ${work.plan.volumes?.length || 0} 卷 + ${work.spec.chapters.length} 章细纲`);
  }

  work.status = "running"; work.chapters = []; work.updatedAt = new Date().toISOString();
  const works = loadWorks();
  const wi = works.findIndex((w) => w.id === id);
  if (wi >= 0) works[wi] = work; else works.unshift(work);
  saveWorks(works);

  const usingDemo = !(settings.baseURL && settings.apiKey);
  emit(`写稿引擎：${usingDemo ? "内置演示引擎" : `模型 ${settings.model}`}`);
  emit(`项目《${work.spec.书名}》开始逐章创作，共 ${work.spec.chapters.length} 章（细纲由${work.plan.engine === "ai" ? "AI" : "演示引擎"}生成）`);

  for (const chapter of work.spec.chapters) {
    if (shouldStop()) { emit("已停止"); break; }
    let record = null, hint = "";
    for (let attempt = 1; attempt <= (settings.maxRetries ?? 2) + 1; attempt++) {
      if (shouldStop()) break;
      emit(`第${chapter.no}章《${chapter.title}》第 ${attempt} 次写稿`);
      const text = await writeOnce(settings, work.spec, chapter, attempt, hint);
      const review = reviewChapter(text, chapter.title);
      record = { no: chapter.no, title: chapter.title, text, verdict: review.verdict, attempts: attempt, review };
      if (review.verdict === "通过") {
        emit(`第${chapter.no}章通过（${attempt} 稿）`);
        break;
      }
      hint = rewriteHint(review);
      emit(`第${chapter.no}章被打回：${hint.slice(0, 60)}`);
    }
    if (shouldStop()) break;
    if (record) {
      const idx = work.chapters.findIndex((c) => c.no === chapter.no);
      if (idx >= 0) work.chapters[idx] = record; else work.chapters.push(record);
      work.updatedAt = new Date().toISOString();
      saveWorks(works);
      hooks.onProgress?.({ current: work.chapters.length, total: work.spec.chapters.length, label: `已完成第${chapter.no}章` });
      // 演示引擎：每章间短暂延时，让进度与日志真实走动，而非秒完本
      if (usingDemo && work.chapters.length < work.spec.chapters.length) await sleep(420);
    }
  }

  if (!stopped) {
    work.status = "done";
    emit(`全部完成：${work.chapters.length} 章定稿`);
  } else {
    work.status = "canceled";
  }
  work.updatedAt = new Date().toISOString();
  saveWorks(works);
  hooks.onProgress?.({ current: work.chapters.length, total: work.spec.chapters.length, label: work.status === "done" ? "已完成" : "已停止" });
  return work;
}

/** 导出定稿 Markdown */
export function exportMarkdown(id) {
  const w = getWork(id); if (!w) return "";
  const ordered = [...w.chapters].sort((a, b) => a.no - b.no);
  const md = [`# ${w.spec.书名}`, "", `> 平台：${w.spec.平台} ｜ 调性：${w.spec.tone} ｜ 爽点：${w.spec.爽点类型}`, "", "---", ""];
  for (const c of ordered) md.push(`## ${c.title}`, "", c.text, "", "---", "");
  return md.join("\n");
}

/** 供 PWA 阅读器消费的定稿数据 */
export function buildDraft(id) {
  const w = getWork(id); if (!w) return null;
  return { title: w.spec.书名, spec: w.spec, exportedAt: new Date().toISOString(),
    chapters: [...w.chapters].sort((a, b) => a.no - b.no).map((c) => ({ no: c.no, title: c.title, text: c.text, verdict: c.verdict, attempts: c.attempts, review: c.review })) };
}
