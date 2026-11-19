/**
 * 浏览器端内嵌创作引擎（零服务端、零 Node 依赖）。
 * 移植自 novel-cda-mcp（大禹）的判定规则 + layers 逻辑，并对獬豸终审做精简合规扫描近似。
 * 设计铁律保持一致：形态判据优先于词表；fatal 短路；弱信号只报 suspect 不否决。
 * 数据本地存储（localStorage），LLM 浏览器直连（OpenAI 兼容）。
 */

// ==================== 规则数据（源自 novel-cda-mcp/src/rules.yaml，配置单一来源） ====================
export const RULES = {
  hard_reject: [
    { id: "reproducible_command", pattern: "(?:\\b(?:sudo|rm\\s+-rf|chmod|chown|curl|wget|ssh|mysql|psql|UPDATE\\s+\\w+\\s+SET|DELETE\\s+FROM|DROP\\s+TABLE|/etc/|/var/log/|/home/)\\b)|(?:SELECT\\s+.+\\s+FROM\\s+\\w+)|(?:ALTER\\s+TABLE)", action: "reject", level: "fatal", hint: "技术描写停在流程/结果层，不写具体命令/SQL/路径" },
    { id: "internal_marker_leak", pattern: "【本章标注】|【新埋伏笔|【回收伏笔|新埋 [LCF]\\d|回收 [LCF]\\d", action: "reject", level: "fatal", hint: "正文严禁内部标注块/伏笔编号泄漏" },
    { id: "markdown_residue", pattern: "^\\s*#{1,6}\\s|\\*\\*[^*]+\\*\\*|^\\s*```|^\\s*>\\s", action: "flag", level: "serious", hint: "发布版为纯文本，去 Markdown 残留" },
    { id: "real_name_in_work", pattern: "《[^》]*(?:华为|小米|腾讯|阿里|京东|百度|字节|Oracle|Windows)[^》]*》", action: "flag", level: "serious", hint: "书名号内用虚构名称" },
    { id: "exclamation_in_title", pattern: "^.{0,20}[!！]", action: "flag", level: "minor", hint: "章名禁用感叹号" },
  ],
  classifier: [
    {
      id: "ai_flavor", desc: "AI 味红黄牌", level: "minor",
      red_words: ["仿佛", "似乎", "宛如", "在这一刻", "五味杂陈", "值得一提的是", "让我们", "某种意义上", "悄然", "不由得", "下意识地", "沉默了片刻", "意味深长", "百感交集", "莫名"],
      red_word_limit_per_chapter: 1,
      greasy_words: ["狂妄一笑", "嘴角勾起", "勾起一抹", "嘴角扬起", "区区也配", "全场震惊", "气势如虹", "眼中杀意", "杀意凛然"],
      patterns: [
        { id: "not_a_but_b", pattern: "不是.{1,24}而是", limit: 2 },
        { id: "this_is_x", pattern: "这[，,]就是", limit: 1 },
        { id: "dash_overuse", pattern: "——", limit: 3 },
        { id: "sublimation_end", pattern: "(?:或许|这)，?就是.{0,12}(?:代价|命运|成长)[^。！？」]*[。！？」]", limit: 1 },
      ],
    },
    { id: "compliance_soft", desc: "合规软信号", level: "serious", keywords: ["法律拿他没办法", "逍遥法外", "出轨也没什么", "努力无用", "底层永无出头之日"] },
    { id: "weak_hook", desc: "章末套语", level: "minor", keywords: ["他知道", "这一切才刚刚开始", "故事还在继续", "未完待续", "仿佛一切都"] },
  ],
  self_consistency: {
    enabled: true,
    time_anchor: {
      patterns: ["第[0-9一二三四五六七八九十百]+天", "第[0-9一二三四五六七八九十百]+章", "[0-9一二三四五六七八九十]{1,2}月[0-9一二三四五六七八九十]{1,3}[日号]", "周[一二三四五六日天]", "[0-9一二三四五六七八九十]{1,2}[:：][0-9]{2}"],
      unordered_words: ["突然想起", "回到", "回忆", "倒叙", "与此同时", "前一天", "三天前", "上个月"],
      max_backward_jumps: 1,
    },
    numeric_conflict: {
      unit_pattern: "([0-9一二三四五六七八九十百千万]+)\\s*(块|元|单|个|斤|米|公里|万|天|人|岁|月|年)",
      contradiction_words: ["但", "却", "然而", "反而", "其实", "结果"],
      window_chars: 60,
    },
    entity_alias: { patterns: ["(?:老|小)[一-龥]{1,2}"], min_occurrences: 2 },
  },
  pacing_signals: {
    enabled: true,
    payoff_words: ["成交", "拿下", "签下", "赚", "到手", "反杀", "打脸", "突破", "升级", "通过", "批准", "翻身", "回本", "兑现", "赢", "胜", "成功", "暗爽"],
    conflict_words: ["冲突", "争吵", "对峙", "威胁", "逼迫", "拒绝", "反击", "竞争", "质疑", "挑衅", "危机", "危险", "失败", "损失", "亏"],
    hook_words: ["没想到", "却不知", "谁料", "殊不知", "竟然", "居然", "突然", "究竟", "原来", "直到", "才发现", "这时", "下一步", "等着", "果然"],
    payoff_per_2000_warn: 0.5, conflict_per_1000_warn: 1.5, hook_per_1000_warn: 0.8,
  },
  positioning_enums: {
    爽点类型: ["打脸碾压", "解谜智性", "无声反杀", "清醒退出", "情感共鸣"],
    反派类型: ["敌人", "规则", "结构"],
    情感契约: ["爽", "解谜", "共鸣", "治愈", "陪伴"],
  },
  // 獬豸终审精简版：平台合规词（源自 novel-review-mcp 合规项 + 一般网文红线）
  xiezhi_compliance: {
    forbidden: ["涉政", "反党", "台独", "港独", "疆独", "法轮", "淫秽", "露骨描写", "具体犯罪手法", "制毒", "自制武器"],
    sensitive_note: "检出疑似合规风险词，建议人工复核（内嵌精简扫描，非完整獬豸）",
  },
};

export const normalizeEnum = (input, allowed, fallback) => {
  const s = String(input || "").trim();
  if (allowed.includes(s)) return s;
  return allowed.find((a) => s.includes(a)) || fallback;
};

// ==================== 评审内核（移植自 layers.ts） ====================
function safeRegex(pattern, flags = "m") { try { return new RegExp(pattern, flags); } catch { return null; } }
const countOf = (text, w) => text.split(w).length - 1;

export function cnToInt(s) {
  s = String(s).trim(); if (!s) return null;
  const n = Number(s); if (!Number.isNaN(n)) return n;
  const d = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (s in d) return d[s];
  if (s === "十") return 10;
  for (const [u, m] of [["万", 10000], ["千", 1000], ["百", 100]]) {
    if (s.includes(u)) { const [a, b] = s.split(u); const h = cnToInt(a); return h === null ? null : h * m + (cnToInt(b || "零") || 0); }
  }
  if (s.startsWith("十")) return 10 + (cnToInt(s.slice(1)) || 0);
  if (s.includes("十")) { const [a, b] = s.split("十"); return (cnToInt(a || "一") || 0) * 10 + (cnToInt(b || "零") || 0); }
  return null;
}

export function l1Check(text) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (const rule of RULES.hard_reject) {
    const re = safeRegex(rule.pattern); if (!re) continue;
    lines.forEach((ln, i) => {
      if (ln.match(re)) hits.push({ id: rule.id, type: rule.id, level: rule.level,
        evidence: `行${i + 1}: ${ln.trim().slice(0, 80)}`, hint: rule.hint, action: rule.action });
    });
  }
  return hits;
}
export const hasHardReject = (hits) => hits.some((h) => h.level === "fatal" && h.action === "reject");

export function l2Check(text) {
  const out = [];
  for (const rule of RULES.classifier) {
    const counts = {}; let hits = 0;
    for (const key of ["red_words", "greasy_words", "keywords"]) {
      for (const w of (rule[key] || [])) { const n = countOf(text, w); if (n) { counts[w] = n; hits += n; } }
    }
    for (const p of (rule.patterns || [])) {
      const re = safeRegex(p.pattern, "gm"); const n = re ? (text.match(re) || []).length : 0;
      if (n) { counts[p.id] = n; hits += n; }
    }
    if (hits) out.push({ id: rule.id, desc: rule.desc, level: rule.level, hits, counts,
      overLimit: (rule.red_word_limit_per_chapter && hits > rule.red_word_limit_per_chapter) ||
        (rule.patterns || []).some((p) => counts[p.id] > (p.limit ?? Infinity)) });
  }
  return out;
}

export function selfConsistencyCheck(text) {
  const cfg = RULES.self_consistency; if (!cfg.enabled) return [];
  const suspects = [];
  const anchors = [];
  for (const pat of (cfg.time_anchor.patterns || [])) {
    const re = safeRegex(pat, "g"); if (!re) continue;
    for (const m of text.matchAll(re)) {
      const n = cnToInt(m[0].replace(/第|天|章|周|月|日|号|[:：]/g, "").trim());
      if (n !== null) anchors.push({ idx: m.index, value: n, raw: m[0] });
    }
  }
  anchors.sort((a, b) => a.idx - b.idx);
  let backward = 0;
  for (let i = 1; i < anchors.length; i++) {
    if (anchors[i].value < anchors[i - 1].value) {
      const gap = text.slice(anchors[i - 1].idx, anchors[i].idx + anchors[i].raw.length);
      if (cfg.time_anchor.unordered_words.some((w) => gap.includes(w))) continue;
      backward++;
      suspects.push({ type: "time_backward", level: "suspect", evidence: `${anchors[i - 1].raw} → ${anchors[i].raw}`, note: "时序锚点倒退；若有倒叙语境请人工排除" });
    }
  }
  if (backward > cfg.time_anchor.max_backward_jumps) suspects.push({ type: "too_many_backward", level: "suspect", count: backward, evidence: `${backward} 次时序倒退`, note: "倒退次数超上限" });
  const unitRe = safeRegex(cfg.numeric_conflict.unit_pattern, "g");
  if (unitRe) {
    const nums = [...text.matchAll(unitRe)].map((m) => ({ idx: m.index, value: cnToInt(m[1]), unit: m[2], raw: m[0] })).filter((x) => x.value !== null);
    for (let i = 0; i < nums.length; i++) for (let j = i + 1; j < nums.length; j++) {
      if (nums[j].idx - nums[i].idx > cfg.numeric_conflict.window_chars) break;
      if (nums[i].unit === nums[j].unit && nums[i].value !== nums[j].value) {
        const between = text.slice(nums[i].idx, nums[j].idx);
        if (cfg.numeric_conflict.contradiction_words.some((w) => between.includes(w)))
          suspects.push({ type: "numeric_conflict", level: "suspect", evidence: `${nums[i].raw} … ${nums[j].raw}`, note: "同量词邻近互斥数值，需人工复核" });
      }
    }
  }
  for (const pat of (cfg.entity_alias.patterns || [])) {
    const re = safeRegex(pat, "g"); if (!re) continue;
    const found = [...text.matchAll(re)].map((m) => m[0]);
    if (found.length >= cfg.entity_alias.min_occurrences)
      suspects.push({ type: "entity_alias", level: "suspect", evidence: [...new Set(found)].join(" / "), note: "称谓变体高频，交人工判断是否混用同一人" });
  }
  return suspects;
}

export function pacingSignals(text) {
  const cfg = RULES.pacing_signals; if (!cfg.enabled) return { enabled: false };
  const count = (ws) => ws.reduce((s, w) => s + countOf(text, w), 0);
  const chars = Math.max(text.replace(/\s/g, "").length, 1);
  const payoff = count(cfg.payoff_words), conflict = count(cfg.conflict_words), hook = count(cfg.hook_words) + (text.match(/[？?！!]\s*$/m) || []).length;
  return { enabled: true,
    payoff: { count: payoff, per_2000: +(payoff / chars * 2000).toFixed(2), warn_below: cfg.payoff_per_2000_warn },
    conflict: { count: conflict, per_1000: +(conflict / chars * 1000).toFixed(2), warn_below: cfg.conflict_per_1000_warn },
    hook: { count: hook, per_1000: +(hook / chars * 1000).toFixed(2), warn_below: cfg.hook_per_1000_warn } };
}

export function extractForeshadow(text) {
  const re = safeRegex("(没想到|却不知|谁料|殊不知|伏笔|埋下|后来才知道|直到|原来|之谜|秘密|悬|迟迟未|尚未|还没|终究会|总有一天){0,20}[^。！？\n]{0,40}", "g");
  if (!re) return [];
  const items = [];
  for (const m of text.matchAll(re)) { const s = m[0].trim(); if (s.length > 4 && items.length < 8) items.push(s.slice(0, 60)); }
  return [...new Set(items)];
}

/** 主评审：返回 verdict + 分层报告；打回条件与大禹一致（fatal 短路 / AI 味超标 / 合规硬词） */
export function reviewChapter(text, title = "") {
  const l1 = l1Check(text);
  const fatal = hasHardReject(l1);
  const l2 = l2Check(text);
  const suspects = selfConsistencyCheck(text);
  const pacing = pacingSignals(text);
  const foreshadow = extractForeshadow(text);
  const compliance = RULES.xiezhi_compliance.forbidden.filter((w) => text.includes(w));

  const problems = [];
  // fatal 短路
  if (fatal) {
    for (const h of l1.filter((x) => x.level === "fatal"))
      problems.push({ level: "fatal", source: "大禹L1", id: h.id, detail: h.hint, evidence: h.evidence });
  }
  // L2 超标：与大禹一致——flavor/format problems 非空即打回（含 minor 级 ai_flavor 超标）
  for (const h of l2) {
    if (h.overLimit) {
      const detail = Object.entries(h.counts).map(([k, v]) => `${k}×${v}`).join("、");
      problems.push({ level: "blocking", source: "大禹L2", id: h.id, detail: `超标：${detail}`, evidence: h.desc });
    }
  }
  // 格式：裸阿拉伯数字串（TTS 不友好，≥2 位），避免 lookbehind 以兼容移动浏览器
  const bareNums = (text.match(/[^\d一二三四五六七八九十]\d{2,}/g) || []);
  if (bareNums.length)
    problems.push({ level: "blocking", source: "大禹格式", id: "bare_number", detail: "出现裸阿拉伯数字串（TTS 会逐字读），改用中文数字", evidence: bareNums.slice(0, 3).join(",").trim() });
  // 弱信号不否决，只提示
  for (const s of suspects) if (s.type === "numeric_conflict" || s.type === "too_many_backward")
    problems.push({ level: "suspect", source: "大禹自洽", id: s.type, detail: s.note, evidence: s.evidence });
  // 獬豸精简合规：命中硬词视为 serious
  for (const w of compliance)
    problems.push({ level: "serious", source: "獬豸终审", id: "compliance", detail: RULES.xiezhi_compliance.sensitive_note, evidence: w });

  const blocking = problems.filter((p) => p.level === "fatal" || p.level === "serious" || p.level === "blocking");
  const verdict = blocking.length ? "打回重写" : "通过";
  return {
    verdict, chapter: title, hard_reject_short_circuit: fatal,
    l1_hits: l1, l2_hits: l2, suspects, pacing, foreshadow,
    xiezhi: { engine: "内嵌精简合规扫描", hits: compliance },
    problems,
    hint: problems.map((p) => `[${p.source}/${p.level}] ${p.detail}`).join("；").slice(0, 500),
  };
}

/** 重写建议：从问题里提炼给 LLM 的修正提示 */
export function rewriteHint(review) {
  if (!review || !review.problems?.length) return "";
  return review.problems.map((p) => `避免${p.id}：${p.detail}`).join("；");
}
