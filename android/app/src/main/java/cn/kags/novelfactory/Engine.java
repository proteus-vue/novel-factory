package cn.kags.novelfactory;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 多智能体编排核心：逐章执行 规划→写稿→4评审并行→打回重写→定稿→bible 更新。
 * -running on WriterService 的后台线程-
 */
final class Engine {
    interface Hooks {
        void log(String msg);
        void progress(int current, int total, String label);
        boolean shouldStop();
        void onChapterDone(JSONObject record);
        void onBudget(int used, int cap);
        void onCheer(String msg);   // 运营子代理的鼓励/祝贺，推送给前端
    }

    private final LlmClient llm;
    private final ExecutorService pool = Executors.newFixedThreadPool(4);
    private final AtomicBoolean stopped = new AtomicBoolean(false);
    private final Hooks hooks;
    private final int maxRetries;
    private final int maxCalls;           // 整本书的 LLM 调用预算，0 表示不限制
    private final int maxCallsPerChapter; // 每章调用上限，0 表示不限制
    private int callsUsed = 0;            // 已用调用数
    private int chapterCalls = 0;         // 本章已用调用数

    Engine(LlmClient llm, JSONObject settings, Hooks hooks) {
        this.llm = llm;
        this.hooks = hooks;
        int mr = settings.optInt("maxRetries", 2);
        this.maxRetries = Math.max(0, Math.min(6, mr));
        int cap = settings.optInt("maxCalls", 0); // 0=不限
        this.maxCalls = Math.max(0, cap);
        int perCap = settings.optInt("maxCallsPerChapter", 0); // 0=不限
        this.maxCallsPerChapter = Math.max(0, perCap);
    }

    void stop() { stopped.set(true); llm.cancel(); pool.shutdownNow(); }

    /** 全书预算是否耗尽（maxCalls==0 视为不限） */
    private boolean budgetOut() { return maxCalls > 0 && callsUsed >= maxCalls; }
    /** 本章预算是否耗尽（maxCallsPerChapter==0 视为不限） */
    private boolean chapterBudgetOut() { return maxCallsPerChapter > 0 && chapterCalls >= maxCallsPerChapter; }
    private synchronized void incCall() {
        callsUsed++; chapterCalls++;
        hooks.onBudget(callsUsed, maxCalls);
    }

    /** 跑完整本书；work 为 TaskStore 中的作品对象，原地更新 chapters/status */
    void run(JSONObject work) throws Exception {
        JSONObject spec = work.optJSONObject("spec");
        if (spec == null) throw new IllegalStateException("作品规格缺失");
        JSONArray chapters = spec.optJSONArray("chapters");
        if (chapters == null || chapters.length() == 0) throw new IllegalStateException("章节规划为空");

        JSONObject bible = work.optJSONObject("bible");
        if (bible == null) bible = defaultBible();

        JSONArray done = work.optJSONArray("chapters");
        if (done == null) { done = new JSONArray(); work.put("chapters", done); }

        hooks.log("写稿引擎：" + (llm.isMock() ? "内置演示引擎（多角色）" : "外部模型 " + llm));
        hooks.log("《" + spec.optString("书名") + "》开始创作，共 " + chapters.length() + " 章 · 重试上限 " + maxRetries + (maxCalls > 0 ? " · 调用预算 " + maxCalls : " · 预算不限"));
        hooks.onBudget(callsUsed, maxCalls);

        for (int ci = 0; ci < chapters.length(); ci++) {
            if (stopped.get() || hooks.shouldStop()) break;
            if (budgetOut()) { hooks.log("已达到调用预算上限（" + maxCalls + "），本任务提前收尾，已定稿章节已保留"); break; }
            JSONObject chapter = chapters.getJSONObject(ci);
            chapterCalls = 0; // 每章重置调用计数

            // STEP 1 规划师：更新 bible 并产出本章 brief
            String brief = plannerTurn(spec, bible, chapter);
            JSONObject parsedBible = parseBible(brief);
            if (parsedBible != null) bible = parsedBible;
            work.put("bible", bible);

            // STEP 2-4 写稿 → 评审 → 打回
            JSONObject record = null;
            String hint = "";
            for (int attempt = 1; attempt <= maxRetries + 1; attempt++) {
                if (stopped.get()) break;
                hooks.log("第" + chapter.optInt("no") + "章《" + chapter.optString("title") + "》第 " + attempt + " 稿");
                String text = writerTurn(spec, chapter, bible, hint, attempt);
                ReviewBundle bundle = reviewAll(text);
                record = new JSONObject();
                record.put("no", chapter.optInt("no"));
                record.put("title", chapter.optString("title"));
                record.put("text", text);
                record.put("verdict", bundle.pass ? "通过" : "打回");
                record.put("attempts", attempt);
                record.put("review", bundle.detail);

                if (bundle.pass) {
                    hooks.log("第" + chapter.optInt("no") + "章通过（" + attempt + " 稿）");
                    break;
                }
                hint = buildHint(bundle);
                hooks.log("第" + chapter.optInt("no") + "章被打回：" + Agents.clip(hint, 60));
            }

            if (record == null) continue;
            int idx = indexOfNo(done, record.optInt("no"));
            if (idx >= 0) done.put(idx, record); else done.put(record);
            hooks.progress(done.length(), chapters.length(), "已完成第" + record.optInt("no") + "章");
            hooks.onChapterDone(record);
            // 演示引擎：每章间短暂可中断延时，让进度条与日志真实走动，而非秒完本
            if (llm.isMock() && ci < chapters.length() - 1) {
                try { TimeUnit.MILLISECONDS.sleep(420); }
                catch (InterruptedException ie) { Thread.currentThread().interrupt(); break; }
            }
        }

        // ===== 运营子代理（麒麟）：全书完成后生成一次祝贺，计入全书预算 =====
        if (!stopped.get() && !hooks.shouldStop() && done.length() > 0) {
            String cheer;
            if (llm.isMock() || budgetOut()) {
                cheer = "全书杀青。从一个念头到完整世界，你把这条路走完了。";
            } else {
                try {
                    int totalChars = 0;
                    for (int i = 0; i < done.length(); i++)
                        totalChars += done.getJSONObject(i).optString("text", "").length();
                    JSONObject ctx = new JSONObject();
                    ctx.put("book", spec.optString("书名"));
                    ctx.put("genre", spec.optString("题材", ""));
                    ctx.put("chapters", done.length());
                    ctx.put("words", totalChars);
                    incCall();
                    String out = llm.chat(Agents.OPERATIONS, ctx.toString(), 256);
                    cheer = (out == null || out.trim().isEmpty())
                        ? "全书杀青，这部作品正式属于你了。" : out.trim();
                } catch (Exception e) {
                    cheer = "全书杀青，恭喜完成这部作品。";
                }
            }
            hooks.onCheer(cheer);
        }
    }

    /** 规划师：mock 返回 bible JSON，真实调 PLANNER；预算耗尽则沿用旧 bible */
    private String plannerTurn(JSONObject spec, JSONObject bible, JSONObject chapter) throws Exception {
        if (llm.isMock()) return mockBible(spec, bible, chapter).toString();
        if (budgetOut()) return bible.toString();
        String user = "故事名：" + spec.optString("书名") + "\n题材：" + spec.optString("题材", "") +
            "\n当前 bible：" + bible.toString() + "\n本章摘要：" + chapter.optString("summary", "") +
            "\n本章暗爽点：" + chapter.optString("darkPoint", "") + "\n请输出更新后的 bible JSON。";
        incCall();
        String out = llm.chat(Agents.PLANNER, user, 1024);
        return out == null ? bible.toString() : out;
    }

    /** 写手：mock 第一稿故意带油腻词+裸数字触发打回，第二稿按章节信息生成差异化正文 */
    private String writerTurn(JSONObject spec, JSONObject chapter, JSONObject bible, String hint, int attempt) throws Exception {
        if (llm.isMock()) return mockWrite(spec, chapter, attempt, hint);
        String user = "请写" + chapter.optString("title") + "正文。字数类型：" + chapter.optString("wordType", "") +
            "。\n本章摘要：" + chapter.optString("summary", "") +
            "\n暗爽点：" + chapter.optString("darkPoint", "") +
            "\n连续性圣经（人物/伏笔/世界观）：" + bible.toString() +
            (hint == null || hint.isEmpty() ? "" : "\n【上一版被打回，务必修正】\n" + hint) +
            "\n只输出正文。";
        incCall();
        String out = llm.chat(Agents.WRITER, user, 4096);
        return out == null ? mockWrite(spec, chapter, attempt, hint) : out;
    }

    /** 4 个评审 agent 并行执行（对应前端 Promise.all）；预算耗尽时用免费内嵌规则兜底 */
    private ReviewBundle reviewAll(String text) throws Exception {
        if (llm.isMock()) return mockReview(text);
        if (budgetOut()) {
            hooks.log("全书预算已用尽，评审改用本地规则（不消耗 token）");
            return mockReview(text);
        }
        if (chapterBudgetOut()) {
            hooks.log("本章调用已达每章上限（" + maxCallsPerChapter + "），评审改用本地规则");
            return mockReview(text);
        }
        List<Callable<String>> tasks = new ArrayList<>();
        for (String prompt : Agents.REVIEWER_PROMPTS) {
            tasks.add(() -> { incCall(); return llm.chat(prompt, "审查以下正文：\n\n" + text, 512); });
        }
        List<Agents.ReviewResult> results = new ArrayList<>();
        List<String> raws = new ArrayList<>();
        for (int i = 0; i < tasks.size(); i++) raws.add("");
        try {
            List<Future<String>> futures = pool.invokeAll(tasks, 150, TimeUnit.SECONDS);
            for (int i = 0; i < futures.size(); i++) {
                String raw = null;
                try { raw = futures.get(i).get(); } catch (Exception e) { raw = ""; }
                raws.set(i, raw);
                results.add(Agents.parseReview(raw));
            }
        } catch (InterruptedException ie) {
            throw ie;
        }
        ReviewBundle b = new ReviewBundle();
        b.detail = new JSONArray();
        boolean allPass = true;
        for (int i = 0; i < results.size(); i++) {
            Agents.ReviewResult r = results.get(i);
            JSONObject one = new JSONObject();
            one.put("source", Agents.REVIEWER_NAMES[i]);
            one.put("pass", r.pass);
            if (r.score >= 0) one.put("score", r.score);
            one.put("issues", new JSONArray(r.issues));
            b.detail.put(one);
            if (!r.pass) { allPass = false; b.allIssues.addAll(r.issues); }
        }
        b.pass = allPass;
        return b;
    }

    private static String buildHint(ReviewBundle b) {
        StringBuilder sb = new StringBuilder("请修正以下问题：");
        for (String s : b.allIssues) sb.append("\n- ").append(s);
        return sb.toString();
    }

    // ---------- Mock 引擎（确定性，验证多角色流水线 + 离线体验完整创作） ----------
    /** 第一稿故意带油腻词+裸数字触发打回；第二稿按章节信息生成差异化长正文 */
    private static String mockWrite(JSONObject spec, JSONObject chapter, int attempt, String hint) {
        int no = chapter.optInt("no", 1);
        if (attempt == 1) {
            return "第" + no + "章开始了。\n\n他嘴角勾起一抹狂妄的笑，仿佛一切尽在掌握，嚣张地走向检测台。\n\n" +
                "全场震惊，所有人都愣在原地。\n\n数字123出现在屏幕上。";
        }
        String book = spec != null ? spec.optString("书名", "这本书") : "这本书";
        String genre = spec != null ? spec.optString("题材", "") : "";
        if (genre == null || genre.isEmpty()) genre = "这个行当";
        String title = chapter.optString("title", "").replaceAll("^第\\d+章\\s*", "");
        if (title == null || title.isEmpty()) title = "新的局面";
        String summary = chapter.optString("summary", "");
        String dark = chapter.optString("darkPoint", "");
        String wt = chapter.optString("wordType", "常规");
        String cn = cnNum(no);

        // 场景句按章号轮转，保证每章开场不同
        String[] scenes = {
            "天色未亮，城里的灯还亮着，他已站在那扇门前。",
            "消息传开的时候，他正低头整理袖口，没有抬头。",
            "会场里坐满了人，空气里有一层压着的躁动。",
            "那通电话挂断后，房间里只剩下钟摆的声音。",
            "雨停在凌晨，街面反着光，像铺了一层冷硬的镜。",
            "他把那份东西推到桌子中央，手指在上面停了一瞬。",
            "走廊尽头传来脚步声，节奏比平时急了半拍。",
            "所有人都以为事情已经结束，只有他知道还差一步。",
            "窗外的喧嚣隔了一层玻璃，落不到这张桌上。",
            "再见面时，双方的立场已经和上次完全不同。"
        };
        String[] beats = {
            "他没有急着开口，先把对方的话在心里过了一遍。",
            "真正要紧的不是谁嗓门大，而是谁手里有能被验证的东西。",
            "这一步他等的不是时机，而是一个不会被人抢走的证据。",
            "他没有反驳那句断言，只是把事实一条条摆了出来。",
            "旁人看的是热闹，他看的是这条规则到底替谁服务。",
            "沉默里，他把最关键的那一环补上了。",
            "他没有争那口气，因为结果本身会替他说话。",
            "局面在那一刻翻了个方向，慢，却稳。",
            "他留了余地，不是心软，是为了让对方自己走到台前。",
            "所有铺垫都指向同一个答案，而这一次没人能替他改写。"
        };
        String[] hooks = {
            "门合上的一瞬，他听见里面有人叫出了那个不该被知道的名字。",
            "而真正的麻烦，是从这份平静之后才开始的。",
            "他收好东西，心思已经落到了下一场。",
            "名单的最后一栏空着，像是特意留给谁的。",
            "他回头看了一眼，那盏灯还亮着。",
            "这一次，轮到别人来问他要一个解释。",
            "纸页翻到背面，字迹和正面出自同一只手。",
            "他没有解释，因为解释的时机还没到。",
            "远处的信号闪了两下，像是某种回应。",
            "他把这一页折好，故事才刚翻开真正的一章。"
        };
        String scene = scenes[no % scenes.length];
        String beat = beats[(no + 2) % beats.length];
        String beat2 = beats[(no + 5) % beats.length];
        String hook = hooks[no % hooks.length];

        StringBuilder sb = new StringBuilder();
        sb.append("第").append(cn).append("章 ").append(title).append("\n\n");
        sb.append(scene).append("\n\n");
        if (summary != null && !summary.isEmpty()) sb.append(summary).append("\n\n");
        sb.append("在《").append(book).append("》的这条线上，").append(genre)
          .append("里的每个人都按自己的位置站着，谁也没有多说一句。\n\n");
        sb.append(beat).append("\n\n");
        if (dark != null && !dark.isEmpty()) sb.append("这正是").append(dark).append("。\n\n");
        sb.append("他把自己能掌控的部分做到极致，剩下的交给时间。\n\n");
        sb.append(beat2).append("\n\n");
        if ("静场".equals(wt)) {
            sb.append("这一章没有争吵，只有几个人各自的心思在桌面下暗暗较劲。\n\n");
        } else if ("高潮".equals(wt) || "反击".equals(wt)) {
            sb.append("该亮的东西终于亮了出来，局面在一瞬间失去了原来的平衡。\n\n");
        } else if ("极短".equals(wt)) {
            sb.append("一句多余的话都没有，该说的都落在了动作里。\n\n");
        } else {
            sb.append("节奏没有加快，每一步却都比上一步更接近核心。\n\n");
        }
        sb.append("等众人回过神，他已经把最要紧的那件事做完。\n\n");
        sb.append(hook);
        return sb.toString();
    }

    /** 数字转中文（演示正文避免裸数字） */
    private static String cnNum(int n) {
        if (n < 1) return "一";
        String[] d = {"零", "一", "二", "三", "四", "五", "六", "七", "八", "九"};
        if (n < 10) return d[n];
        if (n < 20) return "十" + (n % 10 == 0 ? "" : d[n % 10]);
        if (n < 100) return d[n / 10] + "十" + (n % 10 == 0 ? "" : d[n % 10]);
        return String.valueOf(n);
    }

    private static ReviewBundle mockReview(String text) throws org.json.JSONException {
        ReviewBundle b = new ReviewBundle();
        b.detail = new JSONArray();
        String[] dirty = {"嘴角勾起", "狂妄", "仿佛", "全场震惊", "123"};
        List<String> issues = new ArrayList<>();
        for (String d : dirty) if (text.contains(d)) issues.add("出现油腻/裸数字：" + d);
        boolean pass = issues.isEmpty();
        for (int i = 0; i < Agents.REVIEWER_NAMES.length; i++) {
            JSONObject one = new JSONObject();
            one.put("source", Agents.REVIEWER_NAMES[i]);
            one.put("pass", pass);
            if (i == 3) one.put("score", pass ? 8 : 4);
            one.put("issues", new JSONArray(issues));
            b.detail.put(one);
        }
        b.pass = pass;
        b.allIssues.addAll(issues);
        return b;
    }

    private static JSONObject mockBible(JSONObject spec, JSONObject bible, JSONObject chapter) throws org.json.JSONException {
        JSONObject nb = new JSONObject();
        nb.put("世界观", bible.optString("世界观", spec.optString("题材", "都市") + "世界，规则严密，能力有代价。"));
        JSONArray persons = bible.optJSONArray("人物");
        if (persons == null) {
            persons = new JSONArray();
            JSONObject p = new JSONObject();
            p.put("名", "主角");
            p.put("状态", "被低估，准备亮牌");
            persons.put(p);
        }
        nb.put("人物", persons);
        JSONArray foreshadow = bible.optJSONArray("伏笔");
        if (foreshadow == null) foreshadow = new JSONArray();
        String summary = chapter.optString("summary", "");
        if (summary.length() > 0 && foreshadow.length() < 8) foreshadow.put("第" + chapter.optInt("no") + "章：" + Agents.clip(summary, 30));
        nb.put("伏笔", foreshadow);
        nb.put("本章目标", chapter.optString("summary", ""));
        return nb;
    }

    private static JSONObject parseBible(String raw) {
        try { return new JSONObject(Agents.stripFence(raw)); } catch (Exception e) { return null; }
    }

    private static JSONObject defaultBible() throws org.json.JSONException {
        JSONObject b = new JSONObject();
        b.put("世界观", "");
        b.put("人物", new JSONArray());
        b.put("伏笔", new JSONArray());
        return b;
    }

    private static int indexOfNo(JSONArray arr, int no) {
        for (int i = 0; i < arr.length(); i++) if (arr.optJSONObject(i).optInt("no") == no) return i;
        return -1;
    }

    private static final class ReviewBundle {
        boolean pass;
        JSONArray detail;
        final List<String> allIssues = new ArrayList<>();
    }
}
