/**
 * 文本检测引擎：AI 味 / 格式(TTS) / 章名 —— 方法论中"可计算化"的部分（00 号第四节）
 */
import { RED_WORDS, GREASY_WORDS, RED_WORD_LIMIT, SENTENCE_PATTERNS } from "./rules.js";
function collect(text, words) {
    const lines = text.split(/\r?\n/);
    const hits = [];
    for (const w of words) {
        const at = [];
        const samples = [];
        lines.forEach((ln, i) => {
            let idx = ln.indexOf(w);
            while (idx !== -1) {
                at.push(i + 1);
                if (samples.length < 2)
                    samples.push(ln.trim().slice(0, 60));
                idx = ln.indexOf(w, idx + w.length);
            }
        });
        if (at.length)
            hits.push({ word: w, count: at.length, lines: at, samples });
    }
    return hits;
}
/** AI 味审计（04 号：红牌词/油腻词/句式/段末升华） */
export function checkAiFlavor(text) {
    const problems = [];
    const redHits = collect(text, RED_WORDS);
    const greasyHits = collect(text, GREASY_WORDS);
    const totalRed = redHits.reduce((s, h) => s + h.count, 0);
    for (const h of redHits) {
        if (h.count >= 2)
            problems.push(`红牌词超标：「${h.word}」出现 ${h.count} 次（行 ${h.lines.join(",")}），同一种 ≥2 次即超标`);
    }
    if (totalRed > RED_WORD_LIMIT)
        problems.push(`红牌词总量 ${totalRed} 次 > ${RED_WORD_LIMIT}/章 上限（rules.yaml classifier.ai_flavor）`);
    for (const h of greasyHits) {
        problems.push(`油腻词命中（一票否决）：「${h.word}」出现 ${h.count} 次（行 ${h.lines.join(",")}）`);
    }
    // 句式
    const notBut = (text.match(/不是[^。，！？”\n]{1,24}[，,]?而是/g) || []).length;
    const thisIs = (text.match(/这[，,]就是/g) || []).length;
    const patterns = [
        { label: SENTENCE_PATTERNS.notButA.label, count: notBut, limit: SENTENCE_PATTERNS.notButA.limit,
            verdict: notBut > SENTENCE_PATTERNS.notButA.limit ? "超标（一章 ≤2 次）" : "通过" },
        { label: SENTENCE_PATTERNS.thisIsX.label, count: thisIs, limit: SENTENCE_PATTERNS.thisIsX.limit,
            verdict: thisIs > SENTENCE_PATTERNS.thisIsX.limit ? "超标（一章 ≤1 次，且只在名场面）" : "通过" },
    ];
    if (notBut > SENTENCE_PATTERNS.notButA.limit)
        problems.push(`句式超标：『不是A，而是B』${notBut} 次`);
    if (thisIs > SENTENCE_PATTERNS.thisIsX.limit)
        problems.push(`句式超标：『这，就是XX』${thisIs} 次`);
    // 段末升华（全书 ≤5 次；此处按单章检测）
    const sublimation = [];
    const lines = text.split(/\r?\n/);
    lines.forEach((ln, i) => {
        const t = ln.trim();
        if (t && /(了吧|这就是|这，就是|或许，这|这或许就是|命运|成长的代价)[^。！？”]*[。！？”]\s*$/.test(t)) {
            sublimation.push({ line: i + 1, text: t.slice(0, 60) });
        }
    });
    if (sublimation.length)
        problems.push(`检测到 ${sublimation.length} 处疑似总结升华式结尾（症状2）：${sublimation.map(s => `行${s.line}`).join("、")}`);
    const fatal = greasyHits.length > 0;
    const verdict = fatal ? "打回：油腻词一票否决" : (problems.length ? "打回：AI 味超标" : "通过");
    return { redHits, greasyHits, patterns, sublimationEndings: sublimation, verdict, problems };
}
/** 听书(TTS)格式检查（04 号第五节 + 06 号第三节） */
export function checkFormat(text, exclaimForbidden) {
    const problems = [];
    const checks = [];
    // 1. 裸数字（数字可读化）
    const digitLines = [];
    text.split(/\r?\n/).forEach((ln, i) => { if (/\d/.test(ln))
        digitLines.push(i + 1); });
    const digitOk = digitLines.length === 0;
    checks.push({ item: "数字可读化", ok: digitOk, detail: digitOk ? "无裸数字" : `行 ${digitLines.slice(0, 10).join(",")} 含裸数字（005→零零五 / 186→一百八十六 / 2/5→五分之二）；代码应泛化` });
    if (!digitOk)
        problems.push(`存在裸数字（TTS 断句杀手），行: ${digitLines.slice(0, 10).join(",")}`);
    // 2. 引号闭合
    const open = (text.match(/“/g) || []).length;
    const close = (text.match(/”/g) || []).length;
    const quoteOk = open === close;
    checks.push({ item: "引号闭合", ok: quoteOk, detail: `“ ${open} 个 / ” ${close} 个` });
    if (!quoteOk)
        problems.push(`引号不闭合：“${open} 个 vs ”${close} 个`);
    // 3. 破折号 ≤3
    const dashCount = (text.match(/——/g) || []).length;
    const dashOk = dashCount <= 3;
    checks.push({ item: "破折号 ≤3/章", ok: dashOk, detail: `共 ${dashCount} 处` });
    if (!dashOk)
        problems.push(`破折号连用 ${dashCount} 处 > 3`);
    // 4. 感叹号
    const excl = (text.match(/[！!]/g) || []).length;
    const exclOk = exclaimForbidden ? excl === 0 : true;
    checks.push({ item: exclaimForbidden ? "感叹号（本项目调性禁用）" : "感叹号连用", ok: exclOk, detail: `共 ${excl} 处${exclaimForbidden ? "（冷感调性：禁用）" : ""}` });
    if (!exclOk)
        problems.push(`本项目（冷感调性）禁止感叹号，检出 ${excl} 处`);
    if (!exclaimForbidden && /[！!]{2,}/.test(text))
        problems.push("感叹号连用（禁止）");
    // 5. 括号大段（>40 字）
    const longParen = [...text.matchAll(/（[^）]{40,}）|\([^)]{40,}\)/g)].length;
    const parenOk = longParen === 0;
    checks.push({ item: "无括号大段", ok: parenOk, detail: longParen === 0 ? "通过" : `检出 ${longParen} 处 >40 字括号段` });
    if (!parenOk)
        problems.push("括号内大段文字（TTS 会逐字读出，禁止）");
    // 6. 颜文字
    const emoFound = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text);
    checks.push({ item: "无颜文字", ok: !emoFound, detail: emoFound ? "检出 emoji/颜文字" : "通过" });
    if (emoFound)
        problems.push("检出 emoji/颜文字（禁止）");
    // 7. 两人对话挤同一段（一人一段）
    const crowded = [];
    text.split(/\r?\n/).forEach((ln, i) => {
        if (/“[^”]*”[^“”]+“/.test(ln))
            crowded.push(i + 1);
    });
    const crowdOk = crowded.length === 0;
    checks.push({ item: "一人一段（音色分配）", ok: crowdOk, detail: crowdOk ? "通过" : `行 ${crowded.slice(0, 8).join(",")} 疑似两人对话挤同一段` });
    if (!crowdOk)
        problems.push(`疑似两人对话挤同一段（TTS 一个音色读完，炸点全毁），行: ${crowded.slice(0, 8).join(",")}`);
    // 8. 无标点长段
    const longNoPunct = [];
    text.split(/\r?\n/).forEach((ln, i) => {
        const t = ln.trim();
        if (t.length > 120 && !/[。！？”…：]/.test(t))
            longNoPunct.push(i + 1);
    });
    checks.push({ item: "无无标点长段", ok: longNoPunct.length === 0, detail: longNoPunct.length ? `行 ${longNoPunct.join(",")}` : "通过" });
    if (longNoPunct.length)
        problems.push(`无标点长段，行: ${longNoPunct.join(",")}`);
    const verdict = problems.length ? "打回：格式不合规" : "通过";
    return { checks, problems, verdict };
}
/** 章名合规（平台硬约束：可见字数 ≥5，总长 ≤15，感叹号限制） */
export function checkTitle(title, exclaimForbidden, chapterNo) {
    const problems = [];
    const visibleLen = title.replace(/\s/g, "").length;
    if (visibleLen < 5)
        problems.push(`章名可见字数 ${visibleLen} < 5（番茄等平台 2-4 字短名提交失败）`);
    if (title.length > 15)
        problems.push(`章名总长 ${title.length} > 15`);
    const excl = (title.match(/[！!]/g) || []).length;
    if (exclaimForbidden && excl > 0)
        problems.push("冷感调性章名禁用感叹号");
    if (excl > 0 && chapterNo !== undefined && chapterNo > 30) {
        problems.push("前 30 章之外慎用感叹号章名（钩子分层：常规章 ~55% 钩子，名场面用短名）");
    }
    return { ok: problems.length === 0, visibleLen, problems };
}
