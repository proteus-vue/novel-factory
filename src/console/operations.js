/**
 * 运营子代理 · 麒麟（瑞兽，主祥瑞与荣誉）
 * 职责：创作者的荣誉感 / 成就感 / 氛围感 / 创作感。
 * - 成长档案：经验值、段位、称号、成就墙（localStorage 持久化）
 * - 成就判定：基于作品数据派生，幂等可重算
 * - 运营文案：本地文案库（离线/演示） + 可选 LLM 点评（完本时一次，计入成本由上层控制）
 * 纯前端模块，零服务端，与 native 无关。
 */

const PROFILE_KEY = "novelfactory.profile.v1";

// ---------- 段位（经验值驱动）----------
export const RANKS = [
  { min: 0,    name: "见习作者", icon: "doc",    color: "#8a9b95" },
  { min: 60,   name: "码字新秀", icon: "pen",    color: "#1a6e6b" },
  { min: 200,  name: "签约作家", icon: "spark",  color: "#1c8a5b" },
  { min: 600,  name: "金牌作者", icon: "medal",  color: "#a9740a" },
  { min: 1500, name: "殿堂作家", icon: "trophy", color: "#c4382b" },
];

// ---------- 成就定义 ----------
// check(ctx) -> boolean；ctx 见 buildContext
export const ACHIEVEMENTS = [
  { id: "first_work",   name: "第一步",     icon: "plus",    desc: "创建第一部作品",         xp: 10,  check: c => c.works >= 1 },
  { id: "first_chapter",name: "开卷有益",   icon: "book",    desc: "完成第一章定稿",         xp: 15,  check: c => c.chapters >= 1 },
  { id: "five_chapters",name: "小有成就",   icon: "doc",     desc: "累计成稿 5 章",          xp: 25,  check: c => c.chapters >= 5 },
  { id: "flawless",     name: "一气呵成",   icon: "spark",   desc: "某章一遍通过，无需打回", xp: 30,  check: c => c.oneShotChapters >= 1 },
  { id: "persistent",   name: "百炼成钢",   icon: "refresh", desc: "某章重写 3 稿以上才通过", xp: 30,  check: c => c.maxAttempts >= 3 },
  { id: "first_done",   name: "处女作杀青", icon: "check",   desc: "完成第一部作品",         xp: 80,  check: c => c.doneWorks >= 1 },
  { id: "fifteen",      name: "渐入佳境",   icon: "chart",   desc: "累计成稿 15 章",         xp: 60,  check: c => c.chapters >= 15 },
  { id: "words10k",     name: "万字俱乐部", icon: "pen",     desc: "累计创作 1 万字",        xp: 70,  check: c => c.words >= 10000 },
  { id: "three_done",   name: "量产作家",   icon: "publish", desc: "完成 3 部作品",          xp: 120, check: c => c.doneWorks >= 3 },
  { id: "words50k",     name: "著作等身",   icon: "trophy",  desc: "累计创作 5 万字",        xp: 180, check: c => c.words >= 50000 },
];

// ---------- 运营文案库（离线/演示降级）----------
const CHEERS = {
  start: [
    "新的故事开始了，愿这一章下笔有神。",
    "书页翻开了第一角，主角正在等你落笔。",
    "从这一刻起，这个世界由你来掌舵。",
  ],
  chapterPass: [
    "稳稳落地，这一章过关了。",
    "节奏拿捏得漂亮，读者会想翻下一页。",
    "伏笔已经埋下，后劲值得期待。",
    "干净利落，这就是你要的画面感。",
    "又一块拼图归位，故事渐渐成形。",
  ],
  chapterReject: [
    "这一稿还差口气，系统会把它打回重炼。",
    "被打了回来，别急——好稿都是磨出来的。",
    "问题已定位，下一稿会更准。",
  ],
  done: [
    "全书杀青。从一个念头到完整世界，你走完了整条路。",
    "最后一行落下，这部作品正式属于你了。",
    "完稿不是终点，是你下一次落笔的底气。",
  ],
  milestone: [
    "里程碑达成，创作轨迹正在被看见。",
    "又一个纪录被你改写，继续保持。",
  ],
};
const pick = (arr, seed) => arr[Math.abs(seed | 0) % arr.length];

// ---------- 成长档案 ----------
function defaultProfile() {
  return { xp: 0, achievements: [], seenCheers: {}, wordsAtLast: 0, updatedAt: "" };
}
export function loadProfile() {
  try { return { ...defaultProfile(), ...JSON.parse(localStorage.getItem(PROFILE_KEY) || "{}") }; }
  catch { return defaultProfile(); }
}
export function saveProfile(p) {
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch {}
}

// ---------- 上下文派生 ----------
export function buildContext(works) {
  const list = Array.isArray(works) ? works : [];
  let chapters = 0, words = 0, oneShot = 0, maxAttempts = 0;
  const doneWorks = list.filter(w => w.status === "done").length;
  for (const w of list) {
    for (const c of (w.chapters || [])) {
      chapters++;
      words += String(c.text || "").replace(/\s/g, "").length;
      const attempts = Number(c.attempts) || 1;
      if (attempts > maxAttempts) maxAttempts = attempts;
      const passed = !/打回|失败|reject/i.test(c.verdict || "");
      if (passed && attempts === 1) oneShot++;
    }
  }
  return { works: list.length, doneWorks, chapters, words, oneShotChapters: oneShot, maxAttempts };
}

export function rankOf(xp) {
  let r = RANKS[0];
  for (const rank of RANKS) if (xp >= rank.min) r = rank;
  return r;
}
export function nextRankOf(xp) {
  for (const rank of RANKS) if (xp < rank.min) return rank;
  return null;
}
export function rankProgress(xp) {
  const cur = rankOf(xp), next = nextRankOf(xp);
  if (!next) return 100;
  return Math.max(0, Math.min(100, Math.round(((xp - cur.min) / (next.min - cur.min)) * 100)));
}

/**
 * 依据当前作品数据重算经验与成就，返回本次新解锁的成就列表。
 * 幂等：xp 由成就 xp 之和 + 创作量派生，可反复调用不叠加。
 */
export function syncAchievements() {
  let works = [];
  try { works = JSON.parse(localStorage.getItem("novelfactory.works.v1") || "[]"); } catch {}
  const ctx = buildContext(works);
  const profile = loadProfile();
  const earned = ACHIEVEMENTS.filter(a => a.check(ctx)).map(a => a.id);
  const newly = ACHIEVEMENTS.filter(a => earned.includes(a.id) && !profile.achievements.includes(a.id));

  // xp = 成就分 + 创作量分（章节 2 分 + 每千字 3 分），保证幂等
  const xp = earned.reduce((s, id) => s + (ACHIEVEMENTS.find(a => a.id === id)?.xp || 0), 0)
    + ctx.chapters * 2 + Math.floor(ctx.words / 1000) * 3;

  profile.achievements = earned;
  profile.xp = xp;
  profile.context = ctx;
  profile.updatedAt = new Date().toISOString();
  saveProfile(profile);
  return { profile, newly, ctx };
}

// ---------- 运营文案 ----------
export function localCheer(type, seed) {
  const arr = CHEERS[type] || [];
  return arr.length ? pick(arr, seed) : "";
}

/** 运营子代理 system prompt（完本时点评，中文、克制、有荣誉感、不用表情符号） */
export const OPERATIONS_PROMPT = [
  "你是「麒麟」，小说工厂的荣誉官，负责在作者完成一部作品时送上真诚、有分量的祝贺。",
  "要求：中文；60~110 字；温暖克制，不夸张不油腻；不使用表情符号、感叹号堆砌、网络口水话。",
  "内容需结合作品题材与完成章节数，点出创作者坚持的价值，并给一句面向下一部作品的鼓励。",
  "直接输出祝贺正文，不要标题、引号或 JSON。",
].join("\n");

/**
 * 完本运营点评：有模型且预算允许时调用一次；失败/无模型返回 null，由上层用本地文案兜底。
 * 注意：本函数不自行扣预算，调用与否由上层（受 maxCalls 约束）决定。
 */
export async function operationsReview(settings, ctx) {
  if (!settings.baseURL || !settings.apiKey) return null;
  const user = [
    `作品：《${ctx.book || "未命名"}》`,
    `题材：${ctx.genre || "未注明"}`,
    `完成章节：${ctx.chapters} 章`,
    `累计字数：约 ${ctx.words} 字`,
    `创作者段位：${ctx.rank || "见习作者"}`,
    "请送上完本祝贺。",
  ].join("\n");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const resp = await fetch(settings.baseURL.replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify({
        model: settings.model || "gpt-4o-mini",
        messages: [{ role: "system", content: OPERATIONS_PROMPT }, { role: "user", content: user }],
        temperature: 0.9, max_tokens: 256,
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return (data?.choices?.[0]?.message?.content || "").trim() || null;
  } catch { return null; }
  finally { clearTimeout(timer); }
}
