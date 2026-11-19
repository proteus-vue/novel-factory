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

export function createWork(input) {
  const id = "w" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const 书名 = String(input.书名 || "未命名之书").trim();
  const 题材 = String(input.题材 || "都市异能").trim();
  const n = Math.max(1, Math.min(60, Number(input.章节数) || 5));
  const 梗概 = Array.isArray(input.章节梗概) ? input.章节梗概.map((s) => String(s).trim()).filter(Boolean) : [];
  const chapters = [];
  for (let i = 1; i <= n; i++) {
    const wt = 梗概.length ? "常规" : WORD_TYPES[(i - 1) % WORD_TYPES.length];
    chapters.push({
      no: i,
      title: `第${i}章 ${CHAPTER_NAMES[(i - 1) % CHAPTER_NAMES.length]}${i === 1 ? "" : "·" + 题材.slice(0, 4)}`,
      wordType: wt,
      summary: 梗概[i - 1] || `围绕「${题材}」推进主线：主角在第${i}幕遭遇关键事件，做出影响后续的选择。`,
      darkPoint: DARK_POINTS[(i - 1) % DARK_POINTS.length],
    });
  }
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
    chapters,
  };
  const work = { id, spec, status: "new", chapters: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const works = loadWorks(); works.unshift(work); saveWorks(works);
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
  const works = loadWorks();
  const work = works.find((w) => w.id === id);
  if (!work) throw new Error("作品不存在");
  if (work.status === "running") throw new Error("该作品正在创作中");
  work.status = "running"; work.chapters = []; work.updatedAt = new Date().toISOString();
  saveWorks(works);
  let stopped = false;
  const shouldStop = () => { if (hooks.shouldStop?.()) stopped = true; return stopped; };

  const usingDemo = !(settings.baseURL && settings.apiKey);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  emit(`写稿引擎：${usingDemo ? "内置演示引擎" : `模型 ${settings.model}`}`);
  emit(`项目《${work.spec.书名}》开始创作，共 ${work.spec.chapters.length} 章`);

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
