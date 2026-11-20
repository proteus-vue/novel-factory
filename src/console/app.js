/* 小说工厂 · 创作者平台前端（纯前端自包含模式：引擎与数据全部在浏览器本地） */
import {
  loadWorks, getWork, deleteWork, createWork, runWork, runPlan,
  loadSettings, saveSettings, exportMarkdown, buildDraft,
  buildBackup, validateBackup, restoreBackup, clearWorks, resetAllData, storageStats,
} from "./pipeline.js";
import {
  ACHIEVEMENTS, RANKS, rankOf, nextRankOf, rankProgress,
  syncAchievements, localCheer, operationsReview, loadProfile,
} from "./operations.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const icon = (name, cls = "") => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
const APP_VERSION = "2.9.0";

// 界面偏好：减少动效（启动时与保存后应用）
function applyMotionPreference() {
  let reduce = false;
  try { reduce = !!loadSettings().reduceMotion; } catch {}
  document.body.classList.toggle("reduce-motion", reduce);
}

const state = { currentWork: null, currentChapter: 0, pollTimer: null, runningInPage: false, nativeRunning: false };

// ---------- 运行时环境检测 ----------
// Android 原生桥接（前台服务）
const NATIVE = typeof window !== "undefined" && window.Native && typeof window.Native.available === "function" && window.Native.available();
// Electron 桌面工作站（preload 注入 window.Desktop）
const DESKTOP = typeof window !== "undefined" && window.Desktop && window.Desktop.isElectron === true;
const nativeLogs = [];
function nativeEmitSync(id) {
  // 原生服务把章节写入其本地存储，完成后拉回前端 localStorage
  if (!NATIVE || !id) return;
  try {
    const raw = window.Native.getWork(id);
    if (!raw) return;
    const nw = JSON.parse(raw);
    if (!nw || !nw.chapters) return;
    const works = loadWorks();
    const idx = works.findIndex((w) => w.id === id);
    if (idx < 0) return;
    works[idx].chapters = nw.chapters;
    works[idx].bible = nw.bible || works[idx].bible;
    works[idx].status = nw.status || works[idx].status;
    if (nw.error) works[idx].error = nw.error;
    localStorage.setItem("novelfactory.works.v1", JSON.stringify(works));
    invalidateViews();
    if (state.currentWork === id) {
      renderChapters(works[idx]);
      $("wk-publish").disabled = works[idx].chapters.length === 0;
    }
  } catch (e) { /* 忽略同步异常，不阻断 UI */ }
}
// 接收原生事件：log / progress / chapter / finished / started / canceled
window.__nfOnEvent = async function (type, payload) {
  if (type === "log") {
    nativeLogs.push(payload); if (state.currentWork) renderLogs(nativeLogs.slice(-200));
    // 从日志推断当前流水线阶段并同步灵动岛
    const stage = stageFromLog(payload);
    if (stage) Island.update({ stage });
  }
  else if (type === "progress") {
    const [c, t] = payload.split("/");
    renderProgress({ current: +c, total: +t, label: "后台创作中" });
    Island.update({ current: +c, total: +t, stage: "写稿" });
  }
  else if (type === "budget") {
    const b = $("wk-budget");
    if (b) { b.hidden = false; b.textContent = payload.includes("/") ? `模型调用 ${payload}` : `模型调用 ${payload} 次`; }
    Island.update({ budget: payload.includes("/") ? `调用 ${payload}` : `调用 ${payload} 次` });
  }
  else if (type === "started") {
    state.nativeRunning = true; showCheer(localCheer("start", 0));
    const w = state.currentWork ? getWork(state.currentWork) : null;
    Island.update({ title: w?.spec?.书名 || "后台创作", current: 0, total: w?.spec?.chapters?.length || 0, planPhase: "", stage: "规划", budget: "" });
  }
  else if (type === "cheer") { showCheer(payload); cheerPop(payload); }
  else if (type === "chapter") {
    const id = (window.Native?.currentWorkId?.()) || state.currentWork;
    nativeEmitSync(id);
    cheerPop(localCheer("chapterPass", Math.random() * 1000 | 0));
    settleAchievements();
    Island.update({ stage: "定稿" });
  }
  else if (type === "finished") {
    const id = (window.Native?.currentWorkId?.()) || state.currentWork;
    nativeEmitSync(id);
  }
  if (type === "finished") {
    state.nativeRunning = false;
    clearPolling();
    const id = state.currentWork;
    const w = id ? getWork(id) : null;
    const st = w ? w.status : payload;
    $("wk-status-badge").className = `badge ${st}`;
    $("wk-status-badge").textContent = STATUS_LABEL[st] || st;
    $("wk-run").hidden = false; $("wk-cancel").hidden = true;
    if (st === "done") Island.finish({ stage: "定稿" });
    else Island.stop();
    if (st === "done" && w) {
      settleAchievements();
      const settings = loadSettings();
      const p = loadProfile();
      const ctx = { book: w.spec.书名, genre: w.spec.题材, chapters: w.chapters.length,
        words: p.context?.words || 0, rank: rankOf(p.xp).name };
      // 原生侧可能已推来运营点评（payload 为 JSON），否则前端兜底
      let review = null;
      try { const j = JSON.parse(payload); if (j && j.cheer) review = j.cheer; } catch {}
      if (!review && settings.baseURL && settings.apiKey) review = await operationsReview(settings, ctx);
      celebrateFinish(w, review || localCheer("done", w.chapters.length));
      toast("后台创作完成，已生成定稿（可锁屏离开）");
    } else toast("创作已结束：" + (STATUS_LABEL[st] || st));
  }
};
function startPolling(id) {
  clearPolling();
  state.pollTimer = setInterval(() => nativeEmitSync(id), 1500);
  // 首次立即拉一次
  nativeEmitSync(id);
}
function clearPolling() { if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; } }

const STATUS_LABEL = { new: "未开始", queued: "排队中", running: "创作中", done: "已完成", failed: "失败", canceled: "已停止", idle: "未开始" };
const badge = (s) => `<span class="badge ${esc(s || "new")}">${STATUS_LABEL[s] || esc(s) || "未开始"}</span>`;

// ---------- 统一低优先级反馈通道：toast / 飘字互斥，且不与高阶弹层叠加 ----------
let feedbackQueue = [], feedbackActive = null, feedbackTimer;
// 高阶弹层活跃时，低优先级反馈延后显示，避免图2那种三层叠加
function overlayActive() {
  return ["confirm-modal", "demo-guide-modal", "celebrate", "ach-unlock", "chapter-modal", "privacy-modal"]
    .some((id) => { const el = $(id); return el && !el.hidden && (el.classList.contains("show") || el.classList.contains("celebrate") || id === "confirm-modal" || id === "demo-guide-modal" || id === "chapter-modal" || id === "privacy-modal"); });
}
function flushFeedback() {
  if (feedbackActive || overlayActive()) return;
  const next = feedbackQueue.shift();
  if (!next) return;
  feedbackActive = next;
  const el = next.kind === "cheer" ? $("cheer-pop") : $("toast");
  const other = next.kind === "cheer" ? $("toast") : $("cheer-pop");
  other.classList.remove("show"); // toast 与飘字互斥
  if (next.kind === "cheer") { el.textContent = next.msg; el.hidden = false; }
  else el.textContent = next.msg;
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("show")));
  clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => {
    el.classList.remove("show");
    if (next.kind === "cheer") setTimeout(() => { el.hidden = true; }, 350);
    feedbackActive = null;
    setTimeout(flushFeedback, 120);
  }, next.kind === "cheer" ? 1700 : 2400);
}
function enqueueFeedback(kind, msg) {
  feedbackQueue.push({ kind, msg });
  if (feedbackQueue.length > 3) feedbackQueue.shift(); // 防止堆积
  flushFeedback();
}
function toast(msg) { enqueueFeedback("toast", msg); }
// ---------- 灵动岛：全局常驻任务进度（跨页面） ----------
// 流水线阶段：规划三子阶段独立点亮 + 写作与评审四阶段，供收起/展开态统一展示
const ISLE_STAGES = ["作品包", "卷纲", "章纲", "写稿", "大禹评审", "獬豸终审", "打回重写", "定稿"];
// 日志/阶段名 → 阶段序号映射（取最大命中，避免"规划完成"误命中"完成"→定稿）
const STAGE_MAP = {
  "作品包": 0, "定位": 0,
  "卷纲": 1, "结构": 1,
  "章纲": 2, "细纲": 2, "立项": 2, "规划": 2,
  "写稿": 3, "写作": 3, "正文": 3, "入稿": 3,
  "大禹": 4, "评审": 4, "审核": 4, "约束": 4,
  "獬豸": 5, "终审": 5, "合规": 5,
  "打回": 6, "重写": 6, "返工": 6,
  "定稿": 7, "导出": 7,
};
// 从创作日志推断当前所处的流水线阶段
function stageFromLog(msg) {
  const s = String(msg || "");
  if (/作品包|定位/.test(s)) return "作品包";
  if (/卷纲|分卷/.test(s)) return "卷纲";
  if (/章纲|细纲/.test(s)) return "章纲";
  if (/打回|重写|返工/.test(s)) return "打回重写";
  if (/獬豸|终审|合规/.test(s)) return "獬豸终审";
  if (/大禹|评审|审核|约束/.test(s)) return "大禹评审";
  if (/写稿|写作|正文|入稿/.test(s)) return "写稿";
  if (/定稿|完成|导出/.test(s)) return "定稿";
  if (/立项|规划|大纲/.test(s)) return "章纲";
  return "";
}
const Island = (() => {
  const el = $("island");
  const st = { active: false, open: false, title: "", current: 0, total: 0, totalUnit: "章", stage: "", planPhase: "", doneTimer: null };

  function paint() {
    if (!el) return;
    const pct = st.total ? Math.round((st.current / st.total) * 100) : 0;
    const ring = $("island-ring");
    if (ring) ring.style.setProperty("--pct", pct + "%");
    setText("island-pct", pct + "%");
    setText("island-title", st.title || "后台创作中");
    const inPlan = !!st.planPhase;
    const unit = inPlan ? "阶段" : "章";
    setText("island-sub", st.total ? `第 ${st.current} / ${st.total} ${unit}` : (st.stage || "准备中"));
    setText("island-live-label", st.done ? "已完成" : "进行中");
    setText("isle-title", st.title || "—");
    setText("isle-stage", inPlan ? `规划 · ${st.planPhase === "done" ? "已完成" : st.planPhase}` : (st.stage || "准备中"));
    setText("isle-chapters", `${st.current} / ${st.total} ${unit}`);
    setText("isle-budget", st.budget || "—");
    const fill = $("isle-fill"); if (fill) fill.style.width = pct + "%";
    el.classList.toggle("done", !!st.done);
    // 阶段点亮：规划期用 planPhase 精确控制三子阶段，写作/评审期从 stage 关键字推断
    const planDone = st.planPhase === "done";
    let activeIdx = -1;
    if (inPlan) {
      activeIdx = planDone ? 2 : ({ "作品包": 0, "卷纲": 1, "章纲": 2 }[st.planPhase] ?? 0);
    } else {
      for (const k in STAGE_MAP) { if ((st.stage || "").includes(k)) { activeIdx = Math.max(activeIdx, STAGE_MAP[k]); } }
    }
    if (st.done) activeIdx = ISLE_STAGES.length - 1;
    const pipe = $("isle-pipeline");
    if (pipe) {
      pipe.innerHTML = ISLE_STAGES.map((name, i) => {
        // 规划完成后，三个规划子阶段一并标记为 done
        const cls = (planDone && i <= 2) ? "done" : (i < activeIdx ? "done" : i === activeIdx ? "active" : "");
        return `<div class="isle-step ${cls}"><span>${name}</span></div>`;
      }).join("");
    }
  }
  function setText(id, v) { const n = $(id); if (n) n.textContent = v; }

  function show() {
    clearTimeout(st.doneTimer);
    st.active = true;
    if (el) el.hidden = false;
    paint();
  }
  function update(patch) {
    Object.assign(st, patch || {});
    if (patch && "done" in patch) st.done = !!patch.done;
    show();
  }
  // 创作结束：短暂展示完成态后自动收起（用户可随时点开）
  function finish(patch) {
    update({ ...(patch || {}), done: true, stage: (patch && patch.stage) || "定稿" });
    clearTimeout(st.doneTimer);
    st.doneTimer = setTimeout(() => { st.active = false; if (el) el.hidden = true; setOpen(false); }, 6000);
  }
  function stop() {
    clearTimeout(st.doneTimer);
    st.active = false;
    setOpen(false);
    if (el) el.hidden = true;
  }
  function setOpen(v) {
    st.open = !!v;
    const box = $("island-expanded");
    if (box) box.hidden = !st.open;
    el?.classList.toggle("open", st.open);
  }
  function toggle() { if (!st.active) return; setOpen(!st.open); }

  // 事件绑定（只绑一次）
  $("island-pill")?.addEventListener("click", toggle);
  $("isle-collapse")?.addEventListener("click", (e) => { e.stopPropagation(); setOpen(false); });
  $("isle-goto")?.addEventListener("click", () => {
    if (state.currentWork) location.hash = "#/work/" + state.currentWork;
    setOpen(false);
  });

  return { show, update, finish, stop, toggle, setOpen, state: st };
})();

// ---------- 情感化反馈：成就解锁 / 飘字 / 完本庆祝 ----------
let achQueue = [], achBusy = false;
function flushAchievements(newly) {
  if (!newly || !newly.length) return;
  achQueue.push(...newly);
  if (!achBusy) nextAchievement();
}
function nextAchievement() {
  const box = $("ach-unlock");
  const a = achQueue.shift();
  if (!a) { achBusy = false; box.classList.remove("show"); setTimeout(() => { box.hidden = true; flushFeedback(); }, 400); return; }
  achBusy = true;
  $("au-name").textContent = a.name;
  $("au-desc").textContent = a.desc;
  $("au-xp").textContent = `+${a.xp} XP`;
  $("au-icon").setAttribute("href", "#i-" + a.icon);
  box.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => box.classList.add("show")));
  setTimeout(nextAchievement, 2600);
}

function cheerPop(msg) { enqueueFeedback("cheer", msg); }

// 展示运营官评语卡（工作台内）
function showCheer(text) {
  if (!text) return;
  const c = $("cheer-card");
  $("cheer-text").textContent = text;
  c.hidden = false;
}

// 完本庆祝：撒花 + 运营贺词 + 段位结算
function celebrateFinish(work, cheerText) {
  const p = loadProfile();
  const ctx = p.context || { chapters: work.chapters?.length || 0, words: 0 };
  const rank = rankOf(p.xp);
  $("cele-title").textContent = `《${work.spec.书名}》完本`;
  $("cele-quote").textContent = cheerText || localCheer("done", work.chapters?.length || 0);
  $("cele-stats").innerHTML =
    `<div><b>${work.chapters?.length || 0}</b>章定稿</div>` +
    `<div><b>${ctx.chapters}</b>累计章节</div>` +
    `<div><b>${(ctx.words / 1000).toFixed(1)}k</b>累计字数</div>`;
  $("cele-rank").innerHTML = `${icon("crown")} 当前段位 · ${rank.name}（${p.xp} XP）`;
  // 生成彩带
  const conf = $("confetti"); conf.innerHTML = "";
  const colors = ["#e7b45b", "#f3d79a", "#1a6e6b", "#8fd4c6", "#1c8a5b", "#c4382b"];
  for (let i = 0; i < 60; i++) {
    const s = document.createElement("i");
    s.style.left = Math.random() * 100 + "%";
    s.style.background = colors[i % colors.length];
    s.style.animationDuration = (2.4 + Math.random() * 2) + "s";
    s.style.animationDelay = (Math.random() * 1.2) + "s";
    s.style.borderRadius = i % 3 === 0 ? "50%" : "2px";
    conf.appendChild(s);
  }
  $("celebrate").hidden = false;
}
$("cele-close").addEventListener("click", () => { $("celebrate").hidden = true; setTimeout(flushFeedback, 60); });

// 结算创作成就（章节/完本后调用），返回新解锁用于播报
function settleAchievements() {
  const { newly } = syncAchievements();
  if (newly && newly.length) invalidateViews();
  flushAchievements(newly);
  return newly;
}

// ---------- 荣誉页 ----------
function renderHonorView() {
  const { profile: p } = syncAchievements();
  const ctx = p.context || { works: 0, doneWorks: 0, chapters: 0, words: 0 };
  const rank = rankOf(p.xp), next = nextRankOf(p.xp);
  $("hh-emblem").querySelector("use").setAttribute("href", "#i-" + rank.icon);
  $("hh-rank").textContent = rank.name;
  $("hh-bar-fill").style.width = rankProgress(p.xp) + "%";
  $("hh-xp").textContent = `${p.xp} XP`;
  $("hh-next").textContent = next ? `距下一阶 ${next.min - p.xp} XP` : "已达最高段位";
  $("hh-title").textContent = titleOf(p);
  $("honor-stats").innerHTML = [
    ["book", "作品", ctx.works], ["check", "已完本", ctx.doneWorks],
    ["doc", "成稿章节", ctx.chapters], ["pen", "创作字数", (ctx.words / 1000).toFixed(1) + "k"],
  ].map(([ic, l, n]) => `<div class="hs"><div class="hs-ic">${icon(ic)}</div><b>${n}</b><span>${l}</span></div>`).join("");
  $("honor-progress").textContent = `${(p.achievements || []).length} / ${ACHIEVEMENTS.length} 已解锁`;
  $("ach-grid").innerHTML = ACHIEVEMENTS.map((a) => {
    const got = (p.achievements || []).includes(a.id);
    return `<div class="ach ${got ? "" : "locked"}">
      <div class="ach-ic">${icon(a.icon)}</div>
      <div class="ach-name">${esc(a.name)}</div>
      <div class="ach-desc">${esc(a.desc)}</div>
      <div class="ach-xp">${got ? "已解锁" : "未解锁"} · ${a.xp} XP</div>
    </div>`;
  }).join("");
  // stagger 入场
  document.querySelectorAll("#ach-grid .ach").forEach((el, i) => (el.style.animationDelay = (i * 0.04) + "s"));
}
function titleOf(p) {
  const n = (p.achievements || []).length;
  if (n >= 8) return "荣耀满贯";
  if (n >= 5) return "驰骋书海";
  if (n >= 2) return "崭露头角";
  return "初出茅庐";
}

function setEngine(mode) {
  const b = $("engine-badge");
  if (mode === "local") { b.className = "engine-badge ready"; b.innerHTML = `${icon("check")}<span>本地引擎就绪</span>`; }
  else { b.className = "engine-badge ready"; b.innerHTML = `${icon("spark")}<span>已接入模型</span>`; }
  const chip = $("conn-dot");
  chip.className = "engine-chip " + (mode === "local" ? "local" : "model");
  chip.querySelector("span").textContent = mode === "local" ? "本地引擎" : "已接入模型";
  chip.title = mode === "local" ? "内置演示引擎，离线可用" : "已接入外部模型，创作时内容将发送给服务商";
}

// ---------- 路由 + 原生式页面栈 ----------
const VIEWS = {
  works: "我的作品", new: "新建作品", honor: "创作荣誉",
  settings: "创作设置", work: "作品工作台", reader: "阅读器",
};
const ROOT_HASH = "#/works";
let navStack = [ROOT_HASH];      // 页面栈：栈尾为当前页
let _navigating = false;         // 防止转场中重复触发
let _popNav = false;             // 标记本次 hashchange 是回退

function viewOf(hash) { return (hash || ROOT_HASH).replace(/^#\//, "").split("/")[0] || "works"; }
function viewEl(hash) { return $("view-" + viewOf(hash)); }

// 数据变更后让 Tab 页缓存失效，下次进入重新渲染
function invalidateViews() {
  ["work-grid", "view-honor", "view-settings"].forEach((id) => { const el = $(id); if (el) delete el.dataset.painted; });
}

// 纯渲染：把某页显示出来并初始化数据。soft=true 时跳过已渲染 Tab 页的数据重建，避免切换掉帧
function renderRoute(hash, soft) {
  const parts = (hash || ROOT_HASH).replace(/^#\//, "").split("/");
  const view = parts[0] || "works";
  document.querySelectorAll(".view").forEach((v) => (v.hidden = true));
  document.querySelectorAll(".nav-item,.tab-item").forEach((n) => n.classList.toggle("active", n.dataset.nav === view));
  $("topbar-title").textContent = VIEWS[view] || "小说工厂";
  // 页面层级：一级 Tab 页显示 tabbar；二级详情页（工作台/阅读器）切换到独立全屏容器
  const isRoot = view === "works" || view === "new" || view === "honor" || view === "settings";
  document.body.classList.toggle("detail-mode", !isRoot);
  $("back-btn").hidden = isRoot;
  closeSidebar();
  const el = viewEl(hash);
  if (el) el.hidden = false;
  if (view === "works") {
    if (!soft || !$("work-grid").dataset.painted) { loadWorksView(); $("work-grid").dataset.painted = "1"; }
    const s = loadSettings(); setEngine(s.baseURL && s.apiKey ? "model" : "local");
  }
  else if (view === "honor") { if (!soft || !el.dataset.painted) { renderHonorView(); el.dataset.painted = "1"; } }
  else if (view === "settings") {
    if (!soft || !el.dataset.painted) { loadSettingsView(); el.dataset.painted = "1"; }
    else renderDataStats(); // 缓存复用时也刷新占用统计，避免展示过期数据
  }
  else if (view === "work" && parts[1]) openWork(parts[1]);
  else if (view === "reader") renderLocalReader();
}

// 带转场切换。dir: 'push'(新页右滑入) / 'pop'(返回) / 'none'(首屏)
function switchView(nextHash, prevHash, dir) {
  const views = document.querySelector(".views");
  const nextEl = viewEl(nextHash), prevEl = prevHash ? viewEl(prevHash) : null;
  if (dir === "none" || !nextEl || !prevEl || nextEl === prevEl) { renderRoute(nextHash, dir === "none"); return; }
  _navigating = true;
  views.classList.add("transitioning");
  // 先渲染两页：prev 保持可见，next 显示但叠在其上
  renderRoute(nextHash);
  if (dir === "push") {
    prevEl.hidden = false; nextEl.hidden = false;
    nextEl.className = "view stack-active push-in";
    prevEl.className = "view stack-other push-out";
  } else {
    prevEl.hidden = false; nextEl.hidden = false;
    prevEl.className = "view stack-active pop-out";
    nextEl.className = "view stack-other pop-in";
  }
  const cleanup = () => {
    views.classList.remove("transitioning");
    [nextEl, prevEl].forEach((el) => { if (el) el.className = "view"; });
    // 隐藏非当前页
    document.querySelectorAll(".view").forEach((v) => { if (v !== nextEl) v.hidden = true; });
    _navigating = false;
  };
  nextEl.addEventListener("animationend", cleanup, { once: true });
  setTimeout(cleanup, 400); // 兜底：动画被省略时也要清理
}

// 主动返回（带转场）—— 供返回按钮/手势/原生返回键调用
function navigateBack() {
  if (_navigating || navStack.length <= 1) return false;
  const prev = navStack.pop();
  const target = navStack[navStack.length - 1];
  _popNav = true;
  switchView(target, prev, "pop");
  history.replaceState(null, "", target);
  return true;
}

// hashchange：根据栈判断 push 还是 pop
function route() {
  const hash = location.hash || ROOT_HASH;
  if (_popNav) { _popNav = false; return; } // navigateBack 已处理
  if (_navigating) return;
  // 首屏：location.hash 常为空且与栈尾相同，必须强制渲染一次，否则首页停在"加载中"
  if (navStack[navStack.length - 1] === hash) {
    if (!$("work-grid").dataset.painted) {
      renderRoute(hash);
      // 首屏淡入只播一次；用一次性 class 隔离，避免后续切页 hidden 显隐时重播 keyframe
      const firstEl = viewEl(hash);
      if (firstEl) {
        firstEl.classList.add("view-enter");
        const off = () => { firstEl.classList.remove("view-enter"); firstEl.removeEventListener("animationend", off); };
        firstEl.addEventListener("animationend", off, { once: true });
        setTimeout(off, 400);
      }
    }
    return;
  }
  const prev = navStack[navStack.length - 1];
  // 若目标已在栈中（例如点击 tab 回退），截断到该项 = pop
  const existing = navStack.indexOf(hash);
  let dir = "push";
  if (existing >= 0) { navStack = navStack.slice(0, existing + 1); dir = "pop"; }
  else navStack.push(hash);
  // 一级 Tab 页之间切换不做横向推入转场（那会掉帧且不符合原生 Tab 行为），仅淡入
  const isTab = (h) => ["works", "new", "honor", "settings"].includes(viewOf(h));
  if (isTab(hash) && isTab(prev)) dir = "none";
  switchView(hash, prev, dir);
}

// 原生硬件返回键入口
window.__nfBack = () => {
  if (!$("confirm-modal").hidden) { $("confirm-cancel").click(); return true; }
  if (!$("demo-guide-modal").hidden) { $("demo-guide-modal").hidden = true; return true; }
  return navigateBack();
};
window.__nfCanBack = () => navStack.length > 1;

$("back-btn").addEventListener("click", navigateBack);

// ---------- 手势返回：左边缘右滑 + 全屏右滑 ----------
(function initSwipeBack() {
  const views = document.querySelector(".views");
  let startX = 0, startY = 0, tracking = false, dragging = false, dx = 0;
  const threshold = () => Math.min(120, window.innerWidth * 0.32);
  views.addEventListener("touchstart", (e) => {
    if (navStack.length <= 1 || _navigating) return;
    if (e.touches.length !== 1) return;
    startX = e.touches[0].clientX; startY = e.touches[0].clientY;
    // 左边缘 24px 起手 或 全屏（非横向滚动元素内）
    tracking = startX <= 28 || true;
    dragging = false; dx = 0;
  }, { passive: true });
  views.addEventListener("touchmove", (e) => {
    if (!tracking) return;
    dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    if (!dragging) {
      if (dx > 12 && Math.abs(dx) > Math.abs(dy)) { // 确认是右滑手势
        dragging = true; views.classList.add("dragging");
        const prev = navStack[navStack.length - 2];
        const prevEl = prev ? viewEl(prev) : null;
        const curEl = viewEl(location.hash);
        if (prevEl) { prevEl.hidden = false; prevEl.className = "view stack-other"; prevEl.style.transform = `translateX(${-24 + 24 * Math.min(1, dx / window.innerWidth)}%)`; prevEl.style.opacity = String(0.55 + 0.45 * Math.min(1, dx / window.innerWidth)); }
        if (curEl) { curEl.className = "view stack-active"; curEl.style.transform = `translateX(${Math.max(0, dx)}px)`; }
      } else if (dy !== 0 && Math.abs(dy) > Math.abs(dx)) tracking = false; // 纵向滚动，放弃
    } else {
      e.preventDefault();
      const p = Math.min(1, dx / window.innerWidth);
      const prev = navStack[navStack.length - 2];
      const prevEl = prev ? viewEl(prev) : null;
      const curEl = viewEl(location.hash);
      if (prevEl) { prevEl.style.transform = `translateX(${-24 + 24 * p}%)`; prevEl.style.opacity = String(0.55 + 0.45 * p); }
      if (curEl) curEl.style.transform = `translateX(${Math.max(0, dx)}px)`;
    }
  }, { passive: false });
  views.addEventListener("touchend", () => {
    if (!tracking) return;
    tracking = false;
    if (!dragging) return;
    dragging = false;
    views.classList.remove("dragging");
    document.querySelectorAll(".view").forEach((v) => { v.style.transform = ""; v.style.opacity = ""; v.className = "view"; });
    if (dx > threshold()) navigateBack();
  }, { passive: true });
})();

// ---------- 创作者名片 ----------
function renderCreatorCard() {
  const p = loadProfile();
  const rank = rankOf(p.xp), next = nextRankOf(p.xp);
  const iconUse = $("cc-rank").querySelector("use");
  iconUse.setAttribute("href", "#i-" + rank.icon);
  $("cc-rankname").textContent = rank.name;
  $("cc-xp").textContent = `${p.xp} XP`;
  $("cc-bar-fill").style.width = rankProgress(p.xp) + "%";
  $("cc-next").textContent = next ? `距「${next.name}」还差 ${next.min - p.xp} XP` : "已达最高段位";
  $("cc-ach-count").textContent = (p.achievements || []).length;
}

// ---------- 作品列表 ----------
function loadWorksView() {
  const grid = $("work-grid");
  const list = loadWorks();
  const done = list.filter((w) => w.status === "done").length;
  const running = list.filter((w) => w.status === "running").length;
  const chapters = list.reduce((s, w) => s + (w.chapters?.length || 0), 0);
  renderCreatorCard();
  // 新用户尚无作品时隐藏统计卡，把首屏黄金位让给引导与行动入口
  $("stat-row").hidden = list.length === 0;
  $("stat-row").innerHTML = [
    ["book", "作品总数", list.length], ["check", "已完成", done],
    ["play", "创作中", running], ["doc", "累计成稿章节", chapters],
  ].map(([ic, l, n]) => `<div class="stat"><div class="stat-ic">${icon(ic)}</div><div class="n">${n}</div><div class="l">${l}</div></div>`).join("");

  if (!list.length) {
    grid.innerHTML = `<div class="empty">
      <div class="empty-illus">${icon("book")}</div>
      <h3>还没有作品</h3>
      <p>从一句想法开始，系统会自动规划章节、逐章创作、编审并定稿</p>
      <a class="btn primary" href="#/new">${icon("plus")}新建第一部作品</a>
    </div>`;
    return;
  }
  grid.innerHTML = list.map((w) => {
    const total = w.spec.chapters.length;
    const doneN = w.chapters?.length || 0;
    const pct = total ? Math.round((doneN / total) * 100) : 0;
    return `<div class="work-card" onclick="location.hash='#/work/${esc(w.id)}'">
      <div class="top"><div class="cover">${icon("book")}</div>${badge(w.status)}</div>
      <h3>${esc(w.spec.书名)}</h3>
      <div class="plat">${esc(w.spec.平台)} · ${total} 章规划</div>
      <div class="progress-mini">
        <div class="bar"><i style="width:${pct}%"></i></div>
        <div class="bar-meta"><span>成稿 ${doneN}/${total}</span><span>${pct}%</span></div>
      </div>
    </div>`;
  }).join("");
}

// ---------- 新建作品 ----------
$("new-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const obj = Object.fromEntries(fd.entries());
  const payload = {
    书名: obj["书名"], 平台: obj["平台"], 题材: obj["题材"], 受众: obj["受众"],
    性别向: obj["性别向"], 爽点类型: obj["爽点类型"], 反派类型: obj["反派类型"],
    调性: obj["调性"], 改编形态: obj["改编形态"], 章节数: Number(obj["章节数"]) || 5,
    章节梗概: obj["章节梗概"] ? obj["章节梗概"].split("\n").map((s) => s.trim()).filter(Boolean) : [],
  };
  const w = createWork(payload);
  invalidateViews();
  toast(`已创建《${w.spec.书名}》，正在按规范流程生成作品包与大纲…`);
  e.target.reset();
  location.hash = `#/work/${w.id}`;
  // 创建后立即在后台按 CDA 规范生成：作品包 → 卷纲 → 章纲（真正调 AI，非模板秒成）
  void autoPlan(w.id, w.spec.书名);
});

// 后台规划：灵动岛展示三阶段进度，落盘后作品页刷新
let planningIds = new Set();
async function autoPlan(id, title) {
  if (planningIds.has(id)) return;
  planningIds.add(id);
  const logs = [];
  let step = 0;
  Island.update({ title: title || "创作规划", current: 0, total: 3, planPhase: "作品包", stage: "规划", budget: "" });
  // 停留在作品页时，每阶段落盘后增量刷新蓝图面板
  const refreshPlanPanel = () => {
    if (location.hash.includes(`/work/${id}`) && typeof renderWorkPlan === "function") {
      const cur = getWork(id);
      if (cur) renderWorkPlan(cur, true);
    }
  };
  try {
    await runPlan(id, {
      onLog: (m) => {
        logs.push(m);
        if (document.getElementById("wk-logs")) renderLogs(logs);
        // 阶段切换只在明确信号时推进，避免日志用词相互污染
        let hit = "";
        if (/阶段\s*1\s*\/\s*3|正在生成作品包|作品包已生成/.test(m)) hit = "作品包";
        else if (/阶段\s*2\s*\/\s*3|正在生成卷纲|卷纲已生成/.test(m)) hit = "卷纲";
        else if (/阶段\s*3\s*\/\s*3|正在生成.{0,8}章细纲|章纲已生成/.test(m)) hit = "章纲";
        if (hit) {
          step = Math.max(step, hit === "作品包" ? 1 : hit === "卷纲" ? 2 : 3);
          Island.update({ planPhase: hit, current: step });
        }
        // 每阶段产物已落盘，增量刷新面板
        if (/作品包已生成|卷纲已生成|章纲已生成/.test(m)) refreshPlanPanel();
      },
      onProgress: () => {},
      shouldStop: () => false,
    });
    const fresh = getWork(id);
    Island.update({ current: 3, total: 3, planPhase: "done", stage: "规划完成" });
    refreshPlanPanel();
    toast(`《${fresh?.spec?.书名 || title}》大纲就绪：${fresh?.plan?.volumes?.length || 0} 卷 / ${fresh?.spec?.chapters?.length || 0} 章`);
    invalidateViews();
    setTimeout(() => Island.stop(), 3200);
  } catch (err) {
    toast(`规划失败：${(err?.message || err).toString().slice(0, 60)}`);
    Island.stop();
  } finally {
    planningIds.delete(id);
  }
}

// ---------- 统一选择器（底部抽屉 / PC 居中，替代原生 select）----------
const pickerSheet = $("picker-sheet");
const pickerPanel = pickerSheet.querySelector(".picker-panel");
const pickerMask = pickerSheet.querySelector(".picker-mask");
const pickerTitle = $("picker-title");
const pickerOptions = $("picker-options");
let pickerTrigger = null;   // 当前触发的按钮
let pickerCloseTimer = null;

// 读取按钮关联字段当前的 value
function selectValue(trigger) {
  const input = trigger.parentElement.querySelector('input[type="hidden"]');
  return input ? input.value : trigger.querySelector(".select-value").textContent;
}
function openPicker(trigger) {
  clearTimeout(pickerCloseTimer);
  pickerTrigger = trigger;
  const label = trigger.parentElement.querySelector("span").textContent.trim();
  pickerTitle.textContent = label;
  const options = JSON.parse(trigger.dataset.options || "[]");
  const current = selectValue(trigger);
  pickerOptions.innerHTML = options.map((opt) =>
    `<button type="button" class="picker-opt" role="option" aria-selected="${opt === current}" data-value="${esc(opt)}"><span>${esc(opt)}</span><svg class="pk-check"><use href="#i-check"/></svg></button>`
  ).join("");
  pickerPanel.classList.remove("closing");
  pickerMask.classList.remove("closing");
  pickerSheet.hidden = false;
  trigger.classList.add("is-open");
  trigger.setAttribute("aria-expanded", "true");
  // 焦点落在选中项，键盘可达
  const sel = pickerOptions.querySelector('[aria-selected="true"]') || pickerOptions.firstElementChild;
  if (sel) sel.focus({ preventScroll: true });
}
function closePicker() {
  if (pickerSheet.hidden) return;
  if (pickerTrigger) { pickerTrigger.classList.remove("is-open"); pickerTrigger.setAttribute("aria-expanded", "false"); }
  pickerPanel.classList.add("closing");
  pickerMask.classList.add("closing");
  pickerCloseTimer = setTimeout(() => {
    pickerSheet.hidden = true;
    pickerPanel.classList.remove("closing");
    pickerMask.classList.remove("closing");
    if (pickerTrigger) pickerTrigger.focus({ preventScroll: true });
    pickerTrigger = null;
  }, 200);
}
document.querySelectorAll("[data-select]").forEach((trigger) => {
  trigger.setAttribute("aria-expanded", "false");
  trigger.addEventListener("click", () => openPicker(trigger));
});
pickerOptions.addEventListener("click", (e) => {
  const opt = e.target.closest(".picker-opt");
  if (!opt || !pickerTrigger) return;
  const val = opt.dataset.value;
  const input = pickerTrigger.parentElement.querySelector('input[type="hidden"]');
  if (input) input.value = val;
  pickerTrigger.querySelector(".select-value").textContent = val;
  pickerOptions.querySelectorAll(".picker-opt").forEach((o) => o.setAttribute("aria-selected", String(o === opt)));
  closePicker();
});
pickerSheet.querySelectorAll("[data-picker-close]").forEach((el) => el.addEventListener("click", closePicker));
document.addEventListener("keydown", (e) => {
  if (!pickerSheet.hidden && e.key === "Escape") { e.preventDefault(); closePicker(); }
});

// ---------- 工作台 ----------
function openWork(id) {
  state.currentWork = id;
  const w = getWork(id);
  if (!w) { toast("作品不存在"); location.hash = "#/works"; return; }
  $("wk-title").textContent = w.spec.书名;
  $("wk-meta").textContent = `${w.spec.平台} · ${w.spec.题材 || "未设题材"} · ${w.spec.chapters.length} 章规划 · ${w.spec.性别向}`;
  const st = w.status;
  $("wk-status-badge").outerHTML = `<span class="badge ${st}" id="wk-status-badge">${STATUS_LABEL[st] || st}</span>`;
  $("wk-run").hidden = st === "running";
  $("wk-cancel").hidden = !(state.runningInPage === id || state.nativeRunning);
  $("wk-publish").disabled = w.chapters.length === 0;
  // 原生后台任务若正在跑，恢复日志与轮询
  if (NATIVE) {
    try {
      const cur = window.Native.currentWorkId?.() || "";
      if (cur === id) {
        const logsRaw = window.Native.getLogs(id);
        const arr = logsRaw ? JSON.parse(logsRaw) : [];
        nativeLogs.length = 0; arr.forEach((l) => nativeLogs.push(String(l)));
        if (nativeLogs.length) renderLogs(nativeLogs.slice(-200));
        $("wk-run").hidden = true; $("wk-cancel").hidden = false;
        state.nativeRunning = true;
        startPolling(id);
      }
    } catch {}
  }
  renderChapters(w);
  renderWorkPlan(w);
  if (w.chapters.length) {
    $("wk-logs").innerHTML = w.chapters.map((c) =>
      `<div class="log-line">[${c.verdict}] 第${c.no}章《${c.title}》· 共${c.attempts}稿</div>`).join("");
  } else {
    $("wk-logs").innerHTML = `<div class="log-empty">点击「开始创作」，实时日志显示在这里</div>`;
  }
  renderProgress({ current: w.chapters.length, total: w.spec.chapters.length, label: st === "done" ? "已完成" : "准备就绪" });
}

function renderChapters(w) {
  const doneMap = new Map((w.chapters || []).map((c) => [c.no, c]));
  const activeNo = state.currentChapter && !doneMap.has(state.currentChapter) ? state.currentChapter : -1;
  $("wk-chapters").innerHTML = w.spec.chapters.map((cs) => {
    const rec = doneMap.get(cs.no);
    const pass = rec && !/打回|失败|reject/i.test(rec.verdict || "");
    const isActive = cs.no === activeNo;
    const cls = rec ? (pass ? "done" : "fail") : isActive ? "active" : "lock";
    const vCls = !rec ? (isActive ? "writing" : "wait") : pass ? "pass" : "fail";
    const vText = !rec ? (isActive ? "创作中" : "待写") : pass ? "通过" : "打回";
    return `<div class="ch-item ${cls}" ${rec ? `onclick="window.__openChapter(${cs.no})"` : ""}>
      <div class="no">${cs.no}</div>
      <div class="info"><b>${esc(cs.title)}</b><span>${rec ? `已写 ${rec.attempts} 稿` : esc(cs.wordType)} · ${esc(cs.summary).slice(0, 32)}</span></div>
      <span class="v ${vCls}">${vText}</span>
    </div>`;
  }).join("");
  // 当前章滚动到可见区域（只在创作中且用户在工作台时）
  if (activeNo > 0 && viewOf(location.hash) === "work") {
    const activeEl = $("wk-chapters").querySelector(".ch-item.active");
    if (activeEl) activeEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

// 创作蓝图：作品包（定位/锁定层）+ 卷纲，由 AI 规划阶段生成
function renderWorkPlan(w, streaming = false) {
  const panel = $("wk-blueprint"), body = $("bp-body"), eng = $("bp-engine");
  if (!panel || !body) return;
  const plan = w?.plan;
  const bp = plan?.blueprint;
  const volumes = plan?.volumes || [];
  const chapters = w?.spec?.chapters || [];
  const pending = !plan || plan.status === "pending" || plan.status === "planning";
  const kv = (label, val) => val ? `<div class="bp-kv"><span>${esc(label)}</span><p>${esc(val)}</p></div>` : "";
  const list = (arr) => Array.isArray(arr) && arr.length
    ? `<ul>${arr.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "—";
  const bpHtml = bp ? `
    <div class="bp-section">
      <h3>定位层 · 作品包</h3>
      ${kv("一句话定位", bp["一句话定位"])}
      ${kv("主线冲突", bp["主线冲突"])}
      ${kv("主角", bp["主角"])}
      ${kv("调性对立面", bp["调性对立面"])}
      ${kv("金手指", bp["金手指"])}
    </div>
    <div class="bp-section bp-grid">
      <div><h4>人设禁止项</h4>${list(bp["人设禁止项"])}</div>
      <div><h4>金手指边界</h4>${list(bp["金手指边界"])}</div>
      <div><h4>世界规则</h4>${list(bp["世界规则"])}</div>
      <div><h4>爽点节奏</h4>${kv("", bp["爽点节奏"])}</div>
    </div>` : "";
  const volHtml = volumes.length ? `
    <div class="bp-section">
      <h3>结构层 · 卷纲（${volumes.length} 卷）</h3>
      <div class="bp-vols">${volumes.map((v) => `
        <div class="bp-vol">
          <div class="bp-vol-h"><b>第${esc(v["卷"])}卷 · ${esc(v["标题"])}</b><span>第 ${esc(v["起章"])}–${esc(v["止章"])} 章</span></div>
          <p>${esc(v["卷主题"] || "")}</p>
          <div class="bp-vol-meta"><span>高潮：${esc(v["高潮"] || "—")}</span><span>伏笔：${esc(v["伏笔"] || "—")}</span></div>
        </div>`).join("")}</div>
    </div>` : "";

  // 规划进行中：三阶段状态卡增量展示（已完成出内容、进行中转圈、等待中置灰）
  if (pending) {
    panel.hidden = false;
    eng.textContent = streaming ? "逐阶段生成" : "生成中…";
    const hasBp = !!bp, hasVol = volumes.length > 0, hasCh = chapters.length > 0;
    const stage = (no, name, done, active, inner) => `
      <div class="bp-stage ${done ? "done" : active ? "active" : "wait"}">
        <div class="bp-stage-h"><span class="bp-stage-tag">阶段 ${no}/3</span>
          <b>${name}</b><span class="bp-stage-flag">${done ? "✓ 完成" : active ? "生成中…" : "待生成"}</span></div>
        ${done ? `<div class="bp-stage-body">${inner}</div>` : active ? `<div class="bp-loading"><span class="bp-spin"></span>AI 正在按规范生成${name}…</div>` : ""}
      </div>`;
    // 当前活跃阶段 = 第一个未完成的阶段
    const activeNo = !hasBp ? 1 : !hasVol ? 2 : !hasCh ? 3 : 0;
    body.innerHTML =
      stage(1, "作品包", hasBp, activeNo === 1, bpHtml) +
      stage(2, "卷纲", hasVol, activeNo === 2, volHtml) +
      stage(3, "章纲", hasCh, activeNo === 3,
        `<div class="bp-section"><h3>细纲层 · 章纲（${chapters.length} 章）</h3>${chapters.map((c) =>
          `<div class="bp-ch-line"><b>第${esc(c.no)}章 ${esc(c.title)}</b><p>${esc(c.summary || "")}</p></div>`).join("")}</div>`);
    return;
  }
  if (!bp && !volumes.length && !chapters.length) { panel.hidden = true; return; }
  panel.hidden = false;
  eng.textContent = plan.engine === "ai" ? "AI 生成" : "演示引擎";
  const chHtml = chapters.length ? `
    <div class="bp-section">
      <h3>细纲层 · 章纲（${chapters.length} 章）</h3>
      ${chapters.map((c) => `<div class="bp-ch-line"><b>第${esc(c.no)}章 ${esc(c.title)}</b><p>${esc(c.summary || "")}</p></div>`).join("")}
    </div>` : "";
  body.innerHTML = bpHtml + volHtml + chHtml;
}
$("bp-toggle")?.addEventListener("click", () => {
  const body = $("bp-body"), btn = $("bp-toggle");
  if (!body) return;
  const hidden = body.style.display === "none";
  body.style.display = hidden ? "" : "none";
  if (btn) btn.textContent = hidden ? "收起" : "展开";
});

function renderProgress(p) {
  if (!p || !p.total) return;
  $("wk-progress").hidden = false;
  $("wk-prog-label").textContent = p.label || "创作中";
  $("wk-prog-count").textContent = `${p.current} / ${p.total}`;
  $("wk-prog-fill").style.width = `${Math.round((p.current / p.total) * 100)}%`;
  // 同步"创作中"章节高亮（仅当章号变化且当前作品已加载）
  if (state.currentWork && p.current !== state.currentChapter) {
    state.currentChapter = p.current;
    const w = getWork(state.currentWork);
    if (w) renderChapters(w);
  }
}

function logKind(s) {
  s = String(s || "");
  if (/打回|重写|失败|返工/.test(s)) return "reject";
  if (/大禹|獬豸|评审|终审|审核|约束|合规/.test(s)) return "review";
  if (/定稿|完成|通过|导出|生成/.test(s)) return "done";
  if (/写稿|写作|正文|正文|入稿/.test(s)) return "write";
  if (/立项|规划|章纲|大纲|开始|引擎|启动/.test(s)) return "system";
  return "info";
}
const LOG_ICONS = { reject: "refresh", review: "filter", done: "check", write: "pen", system: "spark", info: "doc" };
function renderLogs(logs) {
  const el = $("wk-logs");
  if (!logs.length) return;
  el.innerHTML = logs.map((l) => {
    const k = logKind(l);
    return `<div class="log-line k-${k}"><svg class="log-ic"><use href="#i-${LOG_ICONS[k]}"/></svg><span>${esc(l)}</span></div>`;
  }).join("");
  el.scrollTop = el.scrollHeight;
}

// 统一确认弹层（替代系统 confirm）：返回 Promise<boolean>
function appConfirm(msg, title = "确认", okText = "确定", cancelText = "取消") {
  return new Promise((resolve) => {
    const modal = $("confirm-modal");
    $("confirm-title").textContent = title;
    $("confirm-msg").textContent = msg;
    $("confirm-ok").textContent = okText;
    $("confirm-cancel").textContent = cancelText;
    const done = (v) => { modal.hidden = true; modal.onclick = null; setTimeout(flushFeedback, 60); resolve(v); };
    $("confirm-ok").onclick = () => done(true);
    $("confirm-cancel").onclick = () => done(false);
    $("confirm-x").onclick = () => done(false);
    modal.onclick = (e) => { if (e.target === modal) done(false); };
    modal.hidden = false;
  });
}

// 无 Key 首次创作引导：返回 true 表示继续演示，false 表示放弃/去配置
const DEMO_GUIDE_KEY = "novelfactory.demoGuideSeen.v1";
function guideDemoMode() {
  if (localStorage.getItem(DEMO_GUIDE_KEY) === "1") return Promise.resolve(true);
  return new Promise((resolve) => {
    const modal = $("demo-guide-modal");
    const done = (goOn) => {
      modal.hidden = true;
      modal.onclick = null;
      localStorage.setItem(DEMO_GUIDE_KEY, "1");
      setTimeout(flushFeedback, 60);
      resolve(goOn);
    };
    $("dg-continue").onclick = () => done(true);
    $("dg-goto-settings").onclick = () => { done(false); location.hash = "#/settings"; };
    // 点遮罩 = 放弃本次创作
    modal.onclick = (e) => { if (e.target === modal) done(false); };
    modal.hidden = false;
  });
}

$("wk-run").addEventListener("click", async () => {
  const id = state.currentWork; if (!id) return;
  const w = getWork(id); if (!w) return;
  if (w.status === "done") {
    if (!(await appConfirm("该书已完成，重新开始将覆盖现有章节。继续？", "重新开始", "继续", "取消"))) return;
  }

  // 演示模式（无 Key）首次创作先引导：配模型 or 继续体验
  const s0 = loadSettings();
  if (!(s0.baseURL && s0.apiKey)) {
    const goOn = await guideDemoMode();
    if (!goOn) return;
  }

  // ===== 原生运行时：后台前台服务，多智能体 + 锁屏持续 =====
  if (NATIVE) {
    state.currentChapter = 1;
    const settings = loadSettings();
    // 同步设置给原生服务（含 API Key）
    try { window.Native.saveSettings(JSON.stringify(settings)); } catch {}
    // 先把作品完整对象交给原生（原生据此驱动编排；章节/bible 由原生维护）
    try {
      const nativeWork = JSON.parse(JSON.stringify(w));
      nativeWork.status = "running";
      nativeWork.bible = w.bible || {};
      window.Native.startWork(id, JSON.stringify(nativeWork));
    } catch (e) { toast("启动后台创作失败：" + e.message); return; }
    nativeLogs.length = 0;
    $("wk-logs").innerHTML = "";
    $("wk-run").hidden = true; $("wk-cancel").hidden = false;
    $("wk-status-badge").className = "badge running";
    $("wk-status-badge").textContent = "后台创作中";
    state.nativeRunning = true;
    toast("已在后台启动：可锁屏或切到其它页面，写完会通知你");
    startPolling(id);
    // 电池白名单引导（国产 ROM 保活关键）：只提示一次，统一 App 弹层风格
    const WM_KEY = "novelfactory.batteryAsked.v1";
    try {
      if (window.Native.needBatteryWhitelist && window.Native.needBatteryWhitelist()
          && localStorage.getItem(WM_KEY) !== "1") {
        localStorage.setItem(WM_KEY, "1");
        if (await appConfirm("为保证锁屏后持续创作，请将小说工厂加入电池优化白名单。现在去设置？", "后台创作保活", "去设置", "以后再说")) {
          window.Native.requestBatteryWhitelist();
        }
      }
    } catch {}
    return;
  }

  // ===== 浏览器本地运行时（PWA / WebView 降级）=====
  state.currentChapter = 1;
  state.runningInPage = id;
  $("wk-run").hidden = true; $("wk-cancel").hidden = false;
  $("wk-logs").innerHTML = "";
  Island.update({ title: w.spec.书名 || "本地创作", current: 0, total: w.spec.chapters.length, planPhase: "", stage: "规划", budget: "" });
  const logs = [];
  let stopFlag = { v: false };
  state.stopFlag = stopFlag;
  try {
    let lastGood = 0;
    const result = await runWork(id, {
      shouldStop: () => stopFlag.v,
      onLog: (m) => {
        logs.push(m); renderLogs(logs);
        const stage = stageFromLog(m);
        if (stage) Island.update({ stage });
        // 运营官：章节通过飘字 + 评语
        if (/章通过/.test(m)) {
          lastGood++;
          cheerPop(localCheer("chapterPass", lastGood));
          showCheer(localCheer("chapterPass", lastGood));
        }
      },
      onProgress: (p) => {
        renderProgress(p);
        lastGood = p.current || lastGood;
        settleAchievements();
        Island.update({ current: p.current, total: p.total, stage: "写稿" });
      },
    });
    renderChapters(result);
    $("wk-publish").disabled = result.chapters.length === 0;
    $("wk-status-badge").className = `badge ${result.status}`;
    $("wk-status-badge").textContent = STATUS_LABEL[result.status];
    if (result.status === "done") {
      const newly = settleAchievements();
      const settings = loadSettings();
      const p = loadProfile();
      // 运营子代理：有模型且预算允许时点评一次，否则本地文案兜底
      const ctx = { book: result.spec.书名, genre: result.spec.题材, chapters: result.chapters.length,
        words: p.context?.words || 0, rank: rankOf(p.xp).name };
      const review = (settings.baseURL && settings.apiKey)
        ? await operationsReview(settings, ctx) : null;
      celebrateFinish(result, review || localCheer("done", result.chapters.length));
      if (!review) showCheer(localCheer("done", result.chapters.length));
      Island.finish({ current: result.chapters.length, total: result.spec.chapters.length, stage: "定稿" });
      toast("创作完成，已生成定稿");
    } else { Island.stop(); toast("创作已停止"); }
  } catch (e) { Island.stop(); toast("创作失败：" + e.message); }
  finally { state.runningInPage = null; $("wk-run").hidden = false; $("wk-cancel").hidden = true; }
});

$("wk-cancel").addEventListener("click", () => {
  if (NATIVE) {
    try { window.Native.cancelWork(); } catch {}
    Island.stop();
    toast("已取消后台创作");
    return;
  }
  if (state.stopFlag) state.stopFlag.v = true;
  toast("已请求停止，将在当前章后停下");
});

$("wk-export").addEventListener("click", () => {
  const id = state.currentWork; if (!id) return;
  const w = getWork(id);
  if (!w || !w.chapters.length) { toast("还没有可导出的定稿"); return; }
  const blob = new Blob([exportMarkdown(id)], { type: "text/markdown;charset=utf-8" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
  a.download = `${w.spec.书名}-定稿.md`; a.click();
  URL.revokeObjectURL(a.href);
  toast(`已导出 ${w.chapters.length} 章定稿`);
});

$("wk-publish").addEventListener("click", () => {
  const id = state.currentWork; if (!id) return;
  const draft = buildDraft(id);
  if (!draft || !draft.chapters.length) { toast("请先完成创作"); return; }
  const json = JSON.stringify(draft);
  sessionStorage.setItem("novelfactory.reader", json);
  // 原生环境：拉起原生阅读器 Activity（正规排版/目录/主题/字号/进度记忆）
  if (NATIVE && typeof window.Native.openReader === "function") {
    try { if (window.Native.openReader(json)) { toast("已在原生阅读器中打开"); return; } } catch {}
  }
  // 浏览器降级：WebView 阅读器
  toast("阅读器已生成");
  location.hash = "#/reader";
});

$("wk-clearlog").addEventListener("click", () => { $("wk-logs").innerHTML = `<div class="log-empty">日志已清空</div>`; });

// ---------- 章节详情弹层 ----------
window.__openChapter = (no) => {
  const w = getWork(state.currentWork);
  const ch = w?.chapters.find((c) => c.no === no);
  if (!ch) return;
  $("cm-title").textContent = `第${ch.no}章 ${ch.title}`;
  const pass = !/打回|失败|reject/i.test(ch.verdict || "");
  $("cm-verdict").className = `verdict ${pass ? "pass" : "fail"}`;
  $("cm-verdict").textContent = `${ch.verdict || "未知"} · 第${ch.attempts}稿`;
  const rv = ch.review || {};
  $("chapter-modal").dataset.text = ch.text || "";
  $("chapter-modal").dataset.dayu = JSON.stringify({
    verdict: rv.verdict, l1_hits: rv.l1_hits, l2_hits: rv.l2_hits,
    suspects: rv.suspects, pacing: rv.pacing, problems: rv.problems,
  }, null, 2);
  $("chapter-modal").dataset.xiezhi = JSON.stringify(rv.xiezhi || { 提示: "内嵌精简合规扫描" }, null, 2);
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === "text"));
  renderTab("text");
  $("chapter-modal").hidden = false;
};
function renderTab(tab) {
  const d = $("chapter-modal").dataset;
  const raw = tab === "text"
    ? (d.text || "").split(/\n+/).map((p) => `<p class="para">${esc(p)}</p>`).join("")
    : `<pre>${esc(tab === "dayu" ? d.dayu : d.xiezhi)}</pre>`;
  $("cm-body").innerHTML = raw || "<p>无内容</p>";
  $("cm-body").scrollTop = 0;
}
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
  t.classList.add("active"); renderTab(t.dataset.tab);
}));
$("cm-close").addEventListener("click", () => ($("chapter-modal").hidden = true));
$("chapter-modal").addEventListener("click", (e) => { if (e.target === $("chapter-modal")) $("chapter-modal").hidden = true; });

// ---------- 隐私说明弹层 ----------
$("privacy-policy-btn").addEventListener("click", () => ($("privacy-modal").hidden = false));
$("pm-close").addEventListener("click", () => ($("privacy-modal").hidden = true));
$("privacy-modal").addEventListener("click", (e) => { if (e.target === $("privacy-modal")) $("privacy-modal").hidden = true; });

// ---------- 本地阅读器 ----------
function renderLocalReader() {
  const raw = sessionStorage.getItem("novelfactory.reader");
  if (!raw) { toast("请先从作品工作台发布阅读器"); location.hash = "#/works"; return; }
  const draft = JSON.parse(raw);
  const frame = $("reader-frame");
  const doc = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<style>
*{box-sizing:border-box}
body{margin:0;background:#faf8f2;color:#23201b;font-family:"PingFang SC","Noto Serif SC",serif;-webkit-font-smoothing:antialiased}
main{max-width:680px;margin:0 auto;padding:32px 24px 48px}
h1{font-size:15px;font-weight:500;color:#8a8478;text-align:center;margin:0 0 30px;letter-spacing:2px}
h2{font-size:22px;margin:0 0 26px;color:#23201b;line-height:1.5;font-weight:700}
p{line-height:2.05;font-size:18px;margin:0 0 1.1em;text-indent:2em;letter-spacing:.3px;text-align:justify}
.nav{display:flex;gap:14px;justify-content:space-between;align-items:center;padding:32px 0 8px;margin-top:24px;border-top:1px solid #e8e3d8}
.nav button{flex:1;background:#f0ede4;color:#0d5a56;border:0;border-radius:12px;padding:14px;cursor:pointer;font-size:15px;font-weight:600}
.nav button:disabled{opacity:.35}
.nav .pg{color:#8a8478;font-size:13px;min-width:56px;text-align:center}
.fbar{position:fixed;left:0;right:0;bottom:0;background:rgba(250,248,242,.96);backdrop-filter:blur(10px);border-top:1px solid #e8e3d8;display:flex;justify-content:space-around;padding:10px 16px calc(10px + env(safe-area-inset-bottom))}
.fbar button{background:none;border:0;color:#0d5a56;font-size:14px;padding:8px 14px;cursor:pointer}
body.spacious p{line-height:2.3;font-size:19px}
body.compact p{line-height:1.85;font-size:16px}
body.eye{background:#e8eedc;color:#2e3527}
body.eye .nav,body.eye .fbar{border-color:#d3dcc4;background:rgba(232,238,220,.96)}
body.night{background:#14181b;color:#c9cfd2}
body.night h1,body.night .nav .pg{color:#6e777c}
body.night h2{color:#c9cfd2}
body.night .nav,body.night .fbar{border-color:#2c3439;background:rgba(20,24,27,.96)}
body.night .nav button{background:#242c30;color:#4fb3a6}
</style></head><body>
<main><h1>${esc(draft.title)}</h1><div id="m"></div></main>
<div class="fbar"><button onclick="theme('day')">日间</button><button onclick="theme('eye')">护眼</button><button onclick="theme('night')">夜间</button><button onclick="spacing()">行距</button></div>
<script>
const chapters=${JSON.stringify(draft.chapters)};let i=0;
const m=document.getElementById('m');
function esc(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
function render(){m.innerHTML='<h2>'+esc(chapters[i].title)+'</h2>'+chapters[i].text.split(/\\n+/).filter(x=>x.trim()).map(p=>'<p>'+esc(p.trim())+'</p>').join('')+'<div class="nav"><button onclick="go(-1)" '+(i<=0?'disabled':'')+'>上一章</button><span class="pg">'+(i+1)+' / '+chapters.length+'</span><button onclick="go(1)" '+(i>=chapters.length-1?'disabled':'')+'>下一章</button></div>';window.scrollTo(0,0)}
function go(d){i=Math.max(0,Math.min(chapters.length-1,i+d));render()}
function theme(t){document.body.className=t==='day'?'':t}
function spacing(){document.body.classList.toggle('spacious')?document.body.classList.remove('compact'):document.body.classList.add('compact')}
render();
<\/script></body></html>`;
  frame.srcdoc = doc;
}

// ---------- 设置 ----------
function loadSettingsView() {
  const s = loadSettings();
  const f = $("settings-form");
  f.baseURL.value = s.baseURL || "";
  f.apiKey.value = "";
  f.apiKey.placeholder = s.apiKey ? `已保存（••••${s.apiKey.slice(-4)}）` : "留空表示不修改";
  f.model.value = s.model || "";
  f.temperature.value = s.temperature;
  f.useXiezhi.checked = !!s.useXiezhi;
  f.maxRetries.value = s.maxRetries;
  f.maxCalls.value = s.maxCalls ?? 0;
  f.maxCallsPerChapter.value = s.maxCallsPerChapter ?? 0;
  f.priceIn.value = s.priceIn ?? 1;
  f.priceOut.value = s.priceOut ?? 4;
  if (f.reduceMotion) f.reduceMotion.checked = !!s.reduceMotion;
  setEngine(s.baseURL && s.apiKey ? "model" : "local");
  renderCostEstimate();
  renderDataStats();
  const av = $("about-version");
  if (av) av.textContent = APP_VERSION;
}

// 数据占用统计（作品数 / 成稿章节 / 占用空间）
function renderDataStats() {
  const el = $("data-stats"); if (!el) return;
  const s = storageStats();
  el.innerHTML = `<div class="data-stat"><b>${s.works}</b><span>作品</span></div>` +
    `<div class="data-stat"><b>${s.chapters}</b><span>成稿章节</span></div>` +
    `<div class="data-stat"><b>${s.size}</b><span>占用空间</span></div>`;
}

// 按章节数/单价估算调用量与费用（输入/输出按百万字计价）
function renderCostEstimate() {
  const el = $("cost-estimate"); if (!el) return;
  const f = $("settings-form");
  const chapters = 20;                    // 典型基准
  const inChars = 3000, outChars = 2000;  // 每章输入/输出字数基准
  const retries = Math.max(0, Math.min(6, Number(f.maxRetries?.value) || 0));
  const perChapterRaw = 6 + retries;      // 规划1+写稿1+评审4，重写每轮约+5
  const perCap = Math.max(0, Number(f.maxCallsPerChapter?.value) || 0);
  const perChapter = perCap > 0 ? Math.min(perChapterRaw, perCap) : perChapterRaw;
  const estCalls = chapters * perChapter;
  const cap = Math.max(0, Number(f.maxCalls?.value) || 0);
  const effective = cap > 0 ? Math.min(estCalls, cap) : estCalls;
  // token 粗估：中文 1 字≈1 token；每次调用都带输入，写稿类单次输出 ~outChars
  const inPerCall = inChars, outPerCall = Math.round(outChars / Math.max(1, perChapter) * 2.2);
  const priceIn = Math.max(0, Number(f.priceIn?.value) || 0);
  const priceOut = Math.max(0, Number(f.priceOut?.value) || 0);
  const costIn = effective * inPerCall * priceIn / 1e6;
  const costOut = effective * outPerCall * priceOut / 1e6;
  const cost = (costIn + costOut).toFixed(2);
  el.innerHTML = `<div class="cost-row"><span>预计全书调用</span><b>约 ${estCalls} 次</b></div>` +
    `<div class="cost-row"><span>${cap > 0 ? "受上限约束后" : "按当前设置估算"}</span><b>${effective} 次 ≈ ¥${cost}</b></div>` +
    `<div class="cost-tip">按输入 ¥${priceIn}/百万字、输出 ¥${priceOut}/百万字估算，仅供量级参考。</div>`;
  if (cap > 0 && estCalls > cap) {
    el.innerHTML += `<div class="cost-warn">预计调用（${estCalls}）超过全书上限（${cap}），超出后自动收尾。</div>`;
  }
  if (perCap > 0 && perCap < perChapterRaw) {
    el.innerHTML += `<div class="cost-warn">每章上限（${perCap}）低于常规用量（${perChapterRaw}），该章评审可能降级。</div>`;
  }
}
["maxRetries","maxCalls","maxCallsPerChapter","priceIn","priceOut"].forEach((n) => {
  const el = document.querySelector(`#settings-form [name="${n}"]`);
  if (el) el.addEventListener("input", renderCostEstimate);
});
$("settings-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.target;
  const old = loadSettings();
  saveSettings({
    baseURL: f.baseURL.value.trim(),
    apiKey: f.apiKey.value || old.apiKey,
    model: f.model.value.trim() || old.model,
    temperature: Number(f.temperature.value),
    useXiezhi: f.useXiezhi.checked, maxRetries: Number(f.maxRetries.value),
    maxCalls: Math.max(0, Number(f.maxCalls.value) || 0),
    maxCallsPerChapter: Math.max(0, Number(f.maxCallsPerChapter.value) || 0),
    priceIn: Math.max(0, Number(f.priceIn.value) || 0),
    priceOut: Math.max(0, Number(f.priceOut.value) || 0),
    reduceMotion: !!f.reduceMotion?.checked,
  });
  applyMotionPreference();
  if (NATIVE) { try { window.Native.saveSettings(JSON.stringify(loadSettings())); } catch {} }
  const n = $("settings-notice"); n.hidden = false;
  n.textContent = "设置已保存到本机（不会上传）。新建的创作任务立即生效。";
  setEngine(f.baseURL.value.trim() && (f.apiKey.value || old.apiKey) ? "model" : "local");
  setTimeout(() => (n.hidden = true), 3400);
  toast("设置已保存到本机");
});

// ---------- 存储数据管理 ----------
// 导出全量备份：Blob + a.download（浏览器与 Android WebView 均支持下载到 Download 目录）
$("data-export").addEventListener("click", async () => {
  try {
    const backup = buildBackup();
    const content = JSON.stringify(backup, null, 2);
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
    const name = `小说工厂-备份-${stamp}.json`;
    if (DESKTOP) {
      // 桌面工作站：走系统保存对话框，用户自选位置
      const saved = await window.Desktop.saveExport(name, content);
      if (saved) toast(`已导出 ${backup.data.works.length} 部作品到 ${saved}`);
      return;
    }
    const blob = new Blob([content], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
    toast(`已导出 ${backup.data.works.length} 部作品的备份文件`);
  } catch (e) {
    appConfirm("导出失败：" + (e?.message || "未知错误") + "。请检查存储权限后重试。", "导出失败", "知道了", "关闭");
  }
});

// 导入恢复：选择文件 → 校验 → 二次确认 → 覆盖 → 刷新全站
async function applyImportedBackup(parsed) {
  const v = validateBackup(parsed);
  if (!v.ok) { appConfirm(v.error, "备份不可用", "知道了", "关闭"); return; }
  const ok = await appConfirm(
    `将用备份覆盖当前全部数据：${v.summary.works} 部作品、${v.summary.chapters} 个成稿章节。当前数据会被替换且无法撤销，确定继续吗？`,
    "确认导入", "覆盖恢复", "取消");
  if (!ok) return;
  try {
    restoreBackup(parsed);
    if (NATIVE) { try { window.Native.saveSettings(JSON.stringify(loadSettings())); } catch {} }
    applyMotionPreference();
    invalidateViews();
    loadSettingsView();
    renderDataStats();
    toast(`已恢复 ${v.summary.works} 部作品`);
  } catch (err) {
    appConfirm("恢复失败：" + (err?.message || "未知错误"), "导入失败", "知道了", "关闭");
  }
}

$("data-import").addEventListener("click", async () => {
  if (state.runningInPage || state.nativeRunning) {
    appConfirm("有作品正在创作，请先停止后再导入备份，避免数据冲突。", "无法导入", "知道了", "关闭"); return;
  }
  if (DESKTOP) {
    // 桌面工作站：系统文件对话框直接返回解析好的对象
    const parsed = await window.Desktop.chooseImport();
    if (!parsed) return;
    applyImportedBackup(parsed);
    return;
  }
  $("data-import-file").click();
});
$("data-import-file").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  let parsed;
  try { parsed = JSON.parse(await file.text()); }
  catch { appConfirm("文件解析失败，请确认选择的是本 App 导出的 JSON 备份文件。", "导入失败", "知道了", "关闭"); e.target.value = ""; return; }
  e.target.value = "";
  applyImportedBackup(parsed);
});

// 清空全部作品（保留设置与成就）
$("data-clear-works").addEventListener("click", async () => {
  if (state.runningInPage || state.nativeRunning) {
    appConfirm("当前有作品正在创作，请先停止后再清空。", "无法清空", "知道了", "关闭"); return;
  }
  const ok = await appConfirm("将删除本机全部作品及其章节，设置与成长成就会保留。此操作不可撤销，建议先导出备份。确定清空吗？", "清空全部作品", "确认清空", "取消");
  if (!ok) return;
  clearWorks();
  invalidateViews();
  state.currentWork = null;
  renderDataStats();
  toast("已清空全部作品");
});

// 恢复出厂：清除本 App 全部数据
$("data-reset").addEventListener("click", async () => {
  if (state.runningInPage || state.nativeRunning) {
    appConfirm("当前有作品正在创作，请先停止后再恢复出厂。", "无法重置", "知道了", "关闭"); return;
  }
  const ok1 = await appConfirm("将清除本机全部作品、设置、成长成就与引导记录，恢复到首次安装状态。此操作不可撤销。", "恢复出厂设置", "继续", "取消");
  if (!ok1) return;
  const ok2 = await appConfirm("请再次确认：你已导出需要的备份，并真的要清除所有数据吗？", "二次确认", "确认清除", "取消");
  if (!ok2) return;
  resetAllData();
  state.currentWork = null;
  state.nativeRunning = false;
  invalidateViews();
  navStack = [ROOT_HASH];
  // 回到首页并强制重绘；若已在首页，hashchange 不会触发，需手动渲染
  if ((location.hash || ROOT_HASH) === ROOT_HASH) renderRoute(ROOT_HASH);
  else location.hash = ROOT_HASH;
  loadSettingsView();
  toast("已恢复出厂设置");
});

// ---------- 首次使用引导 ----------
const OB_KEY = "novelfactory.onboarded.v1";
function initOnboarding() {
  const box = $("onboard"), track = $("ob-track"), next = $("ob-next"), skip = $("ob-skip");
  const dots = [...$("ob-dots").children];
  const total = track.children.length;
  let i = 0;
  box.hidden = false; // 显示引导层（HTML 默认 hidden，避免脚本未就绪时闪现）
  const slides = [...track.children];
  const paint = () => {
    // 用 display 切换单屏，避免 transform 合成层在 overflow 裁剪下的渲染问题
    slides.forEach((s, k) => (s.hidden = k !== i));
    dots.forEach((d, k) => d.classList.toggle("on", k === i));
    next.textContent = i === total - 1 ? "开始使用" : "下一步";
  };
  const finish = () => {
    try { localStorage.setItem(OB_KEY, "1"); } catch {}
    box.hidden = true;
  };
  next.addEventListener("click", () => {
    if (i === total - 1) finish();
    else { i++; paint(); }
  });
  skip.addEventListener("click", finish);
  // 左右滑动手势
  let sx = null;
  track.addEventListener("touchstart", (e) => (sx = e.touches[0].clientX), { passive: true });
  track.addEventListener("touchend", (e) => {
    if (sx === null) return;
    const dx = e.changedTouches[0].clientX - sx; sx = null;
    if (dx < -50 && i < total - 1) { i++; paint(); }
    else if (dx > 50 && i > 0) { i--; paint(); }
  }, { passive: true });
  paint();
}
let needOnboard = false;
try { needOnboard = localStorage.getItem(OB_KEY) !== "1"; } catch { needOnboard = true; }
if (needOnboard) initOnboarding(); else $("onboard").hidden = true;

// ---------- 侧边栏（移动） ----------
function closeSidebar() { $("sidebar").classList.remove("open"); $("scrim").classList.remove("show"); }
$("menu-btn").addEventListener("click", () => { $("sidebar").classList.add("open"); $("scrim").classList.add("show"); });
$("scrim").addEventListener("click", closeSidebar);
document.querySelectorAll(".sidebar .nav-item").forEach((a) => a.addEventListener("click", closeSidebar));

window.addEventListener("hashchange", route);
applyMotionPreference();
route();

// ---------- 桌面工作站：托盘菜单 / 系统导入 接入 ----------
if (DESKTOP) {
  // 托盘菜单：新建作品
  window.Desktop.onAction?.((action) => {
    if (action === "new") location.hash = "#/new";
    else if (action === "run") {
      const works = loadWorks();
      if (works.length) location.hash = "#/work/" + works[0].id;
      else location.hash = "#/new";
    }
  });
  // 托盘菜单导入（主进程解析好的对象）
  window.Desktop.onImportBackup?.((parsed) => {
    if (state.runningInPage || state.nativeRunning) {
      appConfirm("有作品正在创作，请先停止后再导入备份。", "无法导入", "知道了", "关闭"); return;
    }
    applyImportedBackup(parsed);
  });
  // 关于卡片补充桌面信息
  const av = $("about-version");
  if (av) {
    window.Desktop.info?.().then((info) => {
      av.textContent = `v${APP_VERSION} · 桌面工作站`;
      const box = $("about-extra");
      if (box) {
        box.hidden = false;
        box.innerHTML = `<div>数据目录：<code>${esc(info.dataDir || "—")}</code></div>
          <div>评审引擎：大禹${info.dayuBundled ? "（内置）" : "（未内置）"} · 獬豸（系统 Python，缺失自动降级）</div>
          <div>编排服务：本机 127.0.0.1:${info.port || "—"}</div>`;
      }
    }).catch(() => {});
  }
}

// 若原生后台仍有进行中的创作，恢复灵动岛常驻显示
(function restoreIsland() {
  if (!NATIVE || !window.Native.currentWorkId) return;
  try {
    const id = window.Native.currentWorkId();
    if (!id) return;
    const raw = window.Native.getWork?.(id);
    if (!raw) return;
    const nw = JSON.parse(raw);
    if (nw.status === "running") {
      state.currentWork = id;
      state.nativeRunning = true;
      Island.update({ title: nw.spec?.书名 || "后台创作", current: nw.chapters?.length || 0,
        total: nw.spec?.chapters?.length || 0, stage: "写稿", budget: "" });
      startPolling(id);
    }
  } catch {}
})();

// 调试/自动化钩子：阶段反馈探针（只读，不影响正常交互）
window.__nfStageProbe = {
  stageFromLog,
  // 按与 paint() 相同的算法算出当前点亮的阶段下标与单位，供自动化断言
  snapshot: () => {
    const s = Island.state;
    const inPlan = !!s.planPhase;
    const planDone = s.planPhase === "done";
    let activeIdx = -1;
    if (inPlan) activeIdx = planDone ? 2 : ({ "作品包": 0, "卷纲": 1, "章纲": 2 }[s.planPhase] ?? 0);
    else for (const k in STAGE_MAP) { if ((s.stage || "").includes(k)) activeIdx = Math.max(activeIdx, STAGE_MAP[k]); }
    if (s.done) activeIdx = ISLE_STAGES.length - 1;
    return { stages: ISLE_STAGES.slice(), activeIdx, unit: inPlan ? "阶段" : "章",
      planPhase: s.planPhase, stage: s.stage, current: s.current, total: s.total, done: s.done,
      isleStageText: $("isle-stage")?.textContent, subText: $("island-sub")?.textContent,
      stepClasses: Array.from(document.querySelectorAll("#isle-pipeline .isle-step")).map((n) => n.className) };
  },
};

// 调试/自动化钩子：低优先级反馈通道（不影响正常交互）
window.__nfFeedback = {
  toast, cheerPop, appConfirm,
  state: () => ({ queue: feedbackQueue.length, active: feedbackActive?.kind || null,
    toastShow: $("toast").classList.contains("show"), cheerShow: $("cheer-pop").classList.contains("show") }),
  clear: () => { feedbackQueue.length = 0; feedbackActive = null; $("toast").classList.remove("show"); $("cheer-pop").classList.remove("show"); },
};
