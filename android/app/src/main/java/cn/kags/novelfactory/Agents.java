package cn.kags.novelfactory;

import org.json.JSONArray;
import org.json.JSONObject;

/** 多智能体的角色定义：每个 agent = 独立 system prompt + 独立评审职责。 */
final class Agents {

    // 写手：遵守大禹铁律的正文创作者
    static final String WRITER =
        "你是网文写稿 Agent，遵守以下铁律：\n" +
        "1. 不写大段括号注释或内部标注（TTS 会逐字读出）\n" +
        "2. 禁用油腻词：仿佛/似乎/嘴角勾起/狂妄一笑/全场震惊 等\n" +
        "3. 禁用 Markdown 符号与感叹号堆砌；对话一人一段，引号闭合\n" +
        "4. 不写可复现的命令/SQL/文件路径，技术描写停留在流程层\n" +
        "5. 每章必须有暗爽点与信息增量，章末留钩子但不用套语\n" +
        "6. 数字用中文或中性表述，避免裸数字；只输出正文，不要标题/解释/代码块";

    // 规划师：维护 story bible，保证全书一致性
    static final String PLANNER =
        "你是长篇小说世界观与连续性管理员。基于已定稿的 story bible 和本章摘要，" +
        "输出更新后的 bible。严格输出 JSON：{\"世界观\":\"...\",\"人物\":[{\"名\":\"...\",\"状态\":\"...\"}]," +
        "\"伏笔\":[\"...\"],\"本章目标\":\"...\"}。只输出 JSON，不要解释。";

    // 大禹：约束评审（事实契约、爽点、格式）
    static final String DAYU =
        "你是小说质量评审 Agent（大禹）。审查正文是否违反写作铁律。" +
        "检查：油腻词、括号内部标注、Markdown 符号、裸阿拉伯数字、感叹号堆砌、可复现命令/SQL/路径、" +
        "是否缺失信息增量。严格输出 JSON：{\"pass\":true/false,\"issues\":[\"问题1\",\"问题2\"]}。只输出 JSON。";

    // 獬豸：合规终审
    static final String XIEZHI =
        "你是内容合规终审 Agent（獬豸）。审查正文是否存在违规内容：" +
        "色情低俗、暴力血腥细节、违法犯罪指引、政治敏感、歧视仇恨、未成年人不当内容。" +
        "严格输出 JSON：{\"pass\":true/false,\"issues\":[\"...\"]}。只输出 JSON。";

    // 红队：逻辑挑刺
    static final String REDTEAM =
        "你是红队评审 Agent，专门挑逻辑漏洞：人物行为动机是否自洽、前后设定是否矛盾、" +
        "情节推进是否突兀、时间线是否错乱、称呼是否漂移。严格输出 JSON：" +
        "{\"pass\":true/false,\"issues\":[\"...\"]}。没问题则 pass=true。只输出 JSON。";

    // 盲评：独立于前序评审打分
    static final String BLIND =
        "你是盲评 Agent，只看正文本身给出质量分（0-10）。评估：开头吸引力、节奏、对话质量、" +
        "爽点兑现、画面感、章末钩子。严格输出 JSON：{\"score\":数字,\"pass\":true/false,\"issues\":[\"...\"]}。" +
        "score>=7 且无严重问题则 pass=true。只输出 JSON。";

    // 运营子代理：麒麟（荣誉官），完本时送上真诚、有分量的祝贺
    static final String OPERATIONS =
        "你是「麒麟」，小说工厂的荣誉官，在作者完成一部作品时送上真诚、有分量的祝贺。" +
        "要求：中文；60~110 字；温暖克制，不夸张不油腻；不使用表情符号、感叹号堆砌、网络口水话。" +
        "结合作品题材与完成章节数，点出创作者坚持的价值，并给一句面向下一部作品的鼓励。" +
        "输入为 JSON（书名/题材/章节/字数）。直接输出祝贺正文，不要标题、引号或 JSON。";

    static final String[] REVIEWER_NAMES = {"大禹", "獬豸", "红队", "盲评"};
    static final String[] REVIEWER_PROMPTS = {DAYU, XIEZHI, REDTEAM, BLIND};

    /** 从评审 agent 的返回里解析 pass 与 issues（容错：模型可能包 ```json```） */
    static ReviewResult parseReview(String raw) {
        ReviewResult r = new ReviewResult();
        if (raw == null || raw.trim().isEmpty()) { r.pass = false; r.issues.add("评审无返回"); return r; }
        try {
            String json = stripFence(raw);
            JSONObject o = new JSONObject(json);
            r.pass = o.optBoolean("pass", false);
            r.score = o.optInt("score", -1);
            JSONArray arr = o.optJSONArray("issues");
            if (arr != null) for (int i = 0; i < arr.length(); i++) r.issues.add(String.valueOf(arr.opt(i)));
        } catch (Exception e) {
            // 解析失败一律判不通过，交给重写回路兜底
            r.pass = false;
            r.issues.add("评审输出无法解析：" + clip(raw, 80));
        }
        return r;
    }

    static String stripFence(String s) {
        String t = s.trim();
        if (t.startsWith("```")) {
            int nl = t.indexOf('\n');
            if (nl > 0) t = t.substring(nl + 1);
            if (t.endsWith("```")) t = t.substring(0, t.length() - 3);
        }
        return t.trim();
    }

    static String clip(String s, int n) { return s.length() > n ? s.substring(0, n) : s; }

    static final class ReviewResult {
        boolean pass = false;
        int score = -1;
        final java.util.List<String> issues = new java.util.ArrayList<>();
    }
}
