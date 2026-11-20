/**
 * 判据层（对齐 novel-review-mcp 的 layers.py）：
 *   L1 形态/结构红线 —— 毫秒级，fatal 直接短路，不调任何 LLM
 *   L2 关键词/结构打分 —— 百毫秒级
 *   机器层弱信号 —— 单章自洽 / 节奏 / 伏笔抽取 / 事实契约，只报 suspect + 原文证据，不判 fatal
 * 设计铁律：形态判据优先于枚举黑名单；弱信号绝不单独构成否决。
 */
import { HARD_REJECT, CLASSIFIER, SELF_CONSISTENCY, PACING, RED_WORDS, GREASY_WORDS, RED_WORD_LIMIT, } from "./rules.js";
function safeRegex(pattern) {
    try {
        return new RegExp(pattern, "m");
    }
    catch {
        return null;
    }
}
/** L1：形态红线（毫秒级）。fatal 命中即短路。 */
export function l1_check(text) {
    const hits = [];
    const lines = text.split(/\r?\n/);
    for (const rule of HARD_REJECT) {
        const re = safeRegex(String(rule.pattern || ""));
        if (!re)
            continue;
        lines.forEach((ln, i) => {
            const m = ln.match(re);
            if (m)
                hits.push({
                    id: rule.id, type: rule.id, level: rule.level,
                    evidence: `行${i + 1}: ${ln.trim().slice(0, 80)}`,
                    hint: rule.hint, action: rule.action,
                });
        });
    }
    return hits;
}
export function hasHardReject(hits) {
    return hits.some(h => h.level === "fatal" && h.action === "reject");
}
/** L2：关键词/结构打分（百毫秒级；返回命中分类与计数，供聚合与自检） */
export function l2_check(text) {
    const out = [];
    for (const rule of CLASSIFIER) {
        const counts = {};
        let hits = 0;
        for (const w of (rule.red_words || [])) {
            const n = text.split(w).length - 1;
            if (n) {
                counts[w] = n;
                hits += n;
            }
        }
        for (const w of (rule.greasy_words || [])) {
            const n = text.split(w).length - 1;
            if (n) {
                counts[w] = n;
                hits += n;
            }
        }
        for (const w of (rule.keywords || [])) {
            const n = text.split(w).length - 1;
            if (n) {
                counts[w] = n;
                hits += n;
            }
        }
        for (const p of (rule.patterns || [])) {
            const re = safeRegex(String(p.pattern));
            const n = re ? (text.match(new RegExp(re.source, "gm")) || []).length : 0;
            if (n) {
                counts[p.id] = n;
                hits += n;
            }
        }
        if (hits)
            out.push({ id: rule.id, desc: rule.desc, level: rule.level, hits, counts,
                overLimit: (rule.red_word_limit_per_chapter && hits > rule.red_word_limit_per_chapter) ||
                    (rule.patterns || []).some((p) => counts[p.id] > (p.limit ?? Infinity)) });
    }
    return out;
}
/** 单章内部自洽弱信号：时序倒退 / 数字互斥 / 称谓变体。只报 suspect + 证据。 */
export function self_consistency_check(text) {
    const cfg = SELF_CONSISTENCY;
    if (!cfg.enabled)
        return [];
    const suspects = [];
    // 时序倒退：按出现顺序取锚点数值，检测单调倒退（排除倒叙提示词邻近）
    const anchors = [];
    for (const pat of (cfg.time_anchor?.patterns || [])) {
        const re = safeRegex(String(pat));
        if (!re)
            continue;
        for (const m of text.matchAll(new RegExp(re.source, "g"))) {
            const n = cnToInt(m[0].replace(/第|天|章|周|月|日|号|[:：]/g, "").trim());
            if (n !== null)
                anchors.push({ idx: m.index, value: n, raw: m[0] });
        }
    }
    anchors.sort((a, b) => a.idx - b.idx);
    let backward = 0;
    const unordered = cfg.time_anchor?.unordered_words || [];
    for (let i = 1; i < anchors.length; i++) {
        if (anchors[i].value < anchors[i - 1].value) {
            const gap = text.slice(anchors[i - 1].idx, anchors[i].idx + anchors[i].raw.length);
            if (unordered.some((w) => gap.includes(w)))
                continue;
            backward++;
            suspects.push({ type: "time_backward", level: "suspect",
                evidence: `${anchors[i - 1].raw} → ${anchors[i].raw}`,
                note: "时序锚点倒退；若有倒叙/回忆语境请人工排除" });
        }
    }
    if (backward > (cfg.time_anchor?.max_backward_jumps ?? 1)) {
        suspects.push({ type: "too_many_backward", level: "suspect", count: backward,
            evidence: `${backward} 次时序倒退`, note: `倒退 ${backward} 次 > 允许 ${cfg.time_anchor?.max_backward_jumps ?? 1}` });
    }
    // 数字互斥：同句/邻近窗口内同一量词给出两个不同值 + 转折词
    const unitRe = safeRegex(String(cfg.numeric_conflict?.unit_pattern || ""));
    if (unitRe) {
        const nums = [...text.matchAll(new RegExp(unitRe.source, "g"))]
            .map(m => ({ idx: m.index, value: cnToInt(m[1]), unit: m[2], raw: m[0] }))
            .filter(x => x.value !== null);
        const win = Number(cfg.numeric_conflict?.window_chars || 60);
        const contra = cfg.numeric_conflict?.contradiction_words || [];
        for (let i = 0; i < nums.length; i++) {
            for (let j = i + 1; j < nums.length; j++) {
                if (nums[j].idx - nums[i].idx > win)
                    break;
                if (nums[i].unit === nums[j].unit && nums[i].value !== nums[j].value) {
                    const between = text.slice(nums[i].idx, nums[j].idx);
                    if (contra.some((w) => between.includes(w))) {
                        suspects.push({ type: "numeric_conflict", level: "suspect",
                            evidence: `${nums[i].raw} … ${nums[j].raw}`,
                            note: "同量词邻近出现互斥数值；可能是不同时间口径，需人工/L3 复核" });
                    }
                }
            }
        }
    }
    // 称谓变体：老X/小X 高频出现（弱信号，仅提示是否混用同一人）
    for (const pat of (cfg.entity_alias?.patterns || [])) {
        const re = safeRegex(String(pat));
        if (!re)
            continue;
        const found = [...text.matchAll(new RegExp(re.source, "g"))].map(m => m[0]);
        const min = Number(cfg.entity_alias?.min_occurrences || 2);
        if (found.length >= min) {
            suspects.push({ type: "entity_alias", level: "suspect",
                evidence: [...new Set(found)].join(" / "),
                note: "称谓变体高频；是否混用同一人交给 L3/人工，不单独构成漂移结论" });
        }
    }
    return suspects;
}
/** 节奏信号：爽点/冲突/钩子密度（机器层，去 LLM 桩） */
export function pacing_signals(text) {
    const cfg = PACING;
    if (!cfg.enabled)
        return { enabled: false };
    const count = (words) => words.reduce((s, w) => s + (text.split(w).length - 1), 0);
    const chars = Math.max(text.replace(/\s/g, "").length, 1);
    const payoff = count(cfg.payoff_words || []);
    const conflict = count(cfg.conflict_words || []);
    const hook = count(cfg.hook_words || []) + (text.match(/[？?！!]\s*$/m) || []).length;
    return {
        enabled: true,
        payoff: { count: payoff, per_2000: +(payoff / chars * 2000).toFixed(2), warn_below: cfg.payoff_per_2000_warn },
        conflict: { count: conflict, per_1000: +(conflict / chars * 1000).toFixed(2), warn_below: cfg.conflict_per_1000_warn },
        hook: { count: hook, per_1000: +(hook / chars * 1000).toFixed(2), warn_below: cfg.hook_per_1000_warn },
    };
}
/** 伏笔通用抽取：无 F# 编号也能识别悬念（方法论 03/09 号） */
export function extract_foreshadow(text) {
    const re = safeRegex("(没想到|却不知|谁料|殊不知|伏笔|埋下|后来才知道|直到|原来|之谜|秘密|悬|迟迟未|尚未|还没|终究会|总有一天){0,20}[^。！？\n]{0,40}");
    if (!re)
        return [];
    const items = [];
    for (const m of text.matchAll(new RegExp(re.source, "g"))) {
        const s = m[0].trim();
        if (s.length > 4 && items.length < 8)
            items.push(s.slice(0, 60));
    }
    return [...new Set(items)];
}
/** 事实契约硬校验：facts={rules:[{name,must_not:[正则],must:[正则?]}]}，确定性正则，不调 LLM */
export function fact_check(text, facts) {
    const rules = facts?.rules || [];
    const conflicts = [];
    for (const r of rules) {
        for (const p of (r.must_not || [])) {
            const re = safeRegex(String(p));
            if (re && re.test(text))
                conflicts.push({ rule: r.name, type: "must_not", pattern: p, note: r.note || "" });
        }
        for (const p of (r.must || [])) {
            const re = safeRegex(String(p));
            if (re && !re.test(text))
                conflicts.push({ rule: r.name, type: "must_missing", pattern: p, note: r.note || "" });
        }
    }
    return conflicts;
}
/** 中文/阿拉伯数字 → 数值（复用简单口径，避免引入依赖） */
export function cnToInt(s) {
    s = String(s).trim();
    if (!s)
        return null;
    const n = Number(s);
    if (!Number.isNaN(n))
        return n;
    const digit = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    if (s in digit)
        return digit[s];
    if (s === "十")
        return 10;
    for (const [unit, mul] of [["万", 10000], ["千", 1000], ["百", 100]]) {
        if (s.includes(unit)) {
            const [a, b] = s.split(unit);
            const head = cnToInt(a);
            return head === null ? null : head * mul + (cnToInt(b || "零") || 0);
        }
    }
    if (s.startsWith("十"))
        return 10 + (cnToInt(s.slice(1)) || 0);
    if (s.includes("十")) {
        const [a, b] = s.split("十");
        return (cnToInt(a || "一") || 0) * 10 + (cnToInt(b || "零") || 0);
    }
    return null;
}
/** 自检用的最小判据样例（供 selfcheck 调用） */
export function selfcheckSignals() {
    const bad = "他执行了 rm -rf /var/log/archive 并用 UPDATE users SET 修改数据库";
    const leak = "正文里写着【本章标注】新埋伏笔：F17";
    const seq = "第7天他签下订单。第3天他又来到这里。他笑了。他解释道，这一切都是因为……";
    const pacing = pacing_signals("他成交了。对手反击。谁料还有后手？");
    return {
        l1_catches_reproducible_command: l1_check(bad).some(h => h.id === "reproducible_command"),
        l1_short_circuit: hasHardReject(l1_check(bad)),
        l1_catches_internal_marker_leak: l1_check(leak).some(h => h.id === "internal_marker_leak"),
        self_consistency_catches_time_backward: self_consistency_check(seq).some(s => s.type === "time_backward"),
        pacing_not_stub: (pacing.payoff?.count ?? 0) > 0 && (pacing.conflict?.count ?? 0) > 0,
        foreshadow_extract_not_stub: extract_foreshadow("他不知道的是，箱子还没打开。").length > 0,
        red_words_loaded_from_yaml: RED_WORDS.length > 0,
        greasy_words_loaded_from_yaml: GREASY_WORDS.length > 0,
        red_word_limit: RED_WORD_LIMIT > 0,
    };
}
