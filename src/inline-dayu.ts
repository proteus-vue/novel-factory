/**
 * 内嵌大禹降级适配器：实现与 McpClient 相同的方法签名（connect/listTools/getPrompt/callTool/close），
 * 在大禹 MCP 不可用时顶上，保证演示/离线模式也能走完 章纲→写稿→评审→打回 闭环。
 * 评审规则与前端 console/engine.js 同源：形态判据优先、fat al 短路、弱信号不否决。
 */
// 注意：不 implements McpClient（它是带私有成员的类，无法结构化实现）；
// 只需提供 Pipeline 实际调用到的同名方法，赋值处用 as unknown as McpClient 转接。

const RED = ["仿佛", "似乎", "宛如", "五味杂陈", "值得一提的是", "某种意义上", "不由得", "莫名"];
const GREASY = ["狂妄一笑", "嘴角勾起", "勾起一抹", "全场震惊", "气势如虹", "扬长而去"];
const FATAL = [
  { id: "reproducible_command", re: /(?:sudo|rm\s+-rf|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+TABLE)/ },
  { id: "internal_marker_leak", re: /【本章标注】|【新埋伏笔|【回收伏笔/ },
];

export class InlineDayu {
  readonly name = "内嵌大禹";
  async connect(): Promise<void> {}
  async listTools(): Promise<any[]> { return [{ name: "review_chapter" }, { name: "next_chapter_brief" }]; }
  async getPrompt(name: string): Promise<string | null> {
    if (name === "build_system_prompt") return [
      "你是网文写稿 Agent。遵守：",
      "1. 红牌词（仿佛/似乎/五味杂陈/莫名…）一章 ≤1 次",
      "2. 油腻词（狂妄一笑/嘴角勾起/全场震惊…）禁用",
      "3. 环境描写 ≤300 字，凑字数即注水",
      "4. 每章必须有暗爽点与信息增量；对话一人一段，引号闭合",
    ].join("\n");
    return null;
  }
  async callTool(name: string, args: Record<string, any> = {}): Promise<any> {
    switch (name) {
      case "init_project":
      case "plan_chapter":
      case "save_outline":
        return { ok: true, inline: true };
      case "review_chapter": {
        const text = String(args.text || "");
        const problems: any[] = [];
        for (const f of FATAL) if (f.re.test(text)) problems.push({ level: "fatal", id: f.id, detail: "命中形态红线" });
        const redHit = RED.filter((w) => text.includes(w));
        if (redHit.length > 1) problems.push({ level: "blocking", id: "ai_flavor", detail: `红牌词超标：${redHit.join("/")}` });
        const greasyHit = GREASY.filter((w) => text.includes(w));
        if (greasyHit.length) problems.push({ level: "blocking", id: "greasy", detail: `油腻词：${greasyHit.join("/")}` });
        const bare = (text.match(/[^\d一二三四五六七八九十]\d{2,}/g) || []);
        if (bare.length) problems.push({ level: "blocking", id: "bare_number", detail: "裸阿拉伯数字串" });
        const verdict = problems.some((p) => p.level === "fatal" || p.level === "blocking" || p.level === "serious") ? "打回重写" : "通过";
        return { verdict, problems, hint: problems.map((p) => `避免${p.id}：${p.detail}`).join("；").slice(0, 400), inline: true };
      }
      case "next_chapter_brief":
        return { prompt: "写作约束块：遵守人设禁止项与金手指边界；红牌词/油腻词禁用；每章一个信息增量；对话一人一段；只输出正文。" };
      case "extract_facts":
        return { anchors: [] };
      default:
        return { ok: true, inline: true };
    }
  }
  close(): void {}
  stderr(): string { return ""; }
}
