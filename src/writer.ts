/**
 * 写稿 Agent：把大禹的约束转成 prompt，调 LLM 出正文。
 * 依赖两个输入：
 *   - 大禹 prompt build_system_prompt（按项目卡片拼的写作铁律）
 *   - 大禹工具 next_chapter_brief（上章评审回流 + 伏笔 + 人设锚）
 */
import type { McpClient } from "./mcp-client.js";
import type { LlmClient } from "./llm.js";

export interface WriteContext {
  projectId: string;
  chapterNo: number;
  title: string;
  wordType: "静场" | "常规" | "反击" | "高潮" | "极短";
  summary: string;
  darkPoint: string;
  lastReview?: unknown;   // 上一章 review 报告，用于回流
  rewriteHint?: string;   // 本章被打回后的具体意见
}

export interface WrittenChapter {
  chapterNo: number;
  title: string;
  text: string;
  promptPreview: string;
}

/** 从大禹 prompt 资源取系统铁律（通过 MCP prompts/get） */
async function systemIronRules(dayu: McpClient, projectId: string): Promise<string> {
  try {
    const text = await dayu.getPrompt("build_system_prompt", { project_id: projectId });
    if (text) return text;
  } catch { /* 取不到 prompt 时用内嵌兜底，不让流水线断 */ }
  return [
    "你是网文写稿 Agent。遵守：",
    "1. 不写大段括号注释（TTS 会逐字读出）",
    "2. 红牌词/油腻词禁止（仿佛、嘴角勾起、狂妄一笑等）",
    "3. 环境描写 ≤300 字，为凑字数即注水",
    "4. 每章必须有暗爽点与信息增量",
    "5. 对话一人一段，引号闭合",
  ].join("\n");
}

export async function writeChapter(
  dayu: McpClient,
  llm: LlmClient,
  ctx: WriteContext,
): Promise<WrittenChapter> {
  // 1. 评审回流约束块（确定性，零 LLM）
  let brief = "";
  if (ctx.lastReview || ctx.chapterNo > 1) {
    try {
      const b: any = await dayu.callTool("next_chapter_brief", {
        review: ctx.lastReview || { verdict: "通过", chapter: ctx.chapterNo - 1 },
        project_id: ctx.projectId,
        chapter_index: ctx.chapterNo,
      });
      brief = b?.prompt || b?.约束块 || b?.text || JSON.stringify(b);
    } catch { brief = "（无上章评审，首章）"; }
  }

  const system = await systemIronRules(dayu, ctx.projectId);
  const user = [
    `请写第${ctx.chapterNo}章《${ctx.title}》正文。`,
    `字数类型：${ctx.wordType}；本章摘要：${ctx.summary}`,
    `本章暗爽点：${ctx.darkPoint}`,
    ctx.rewriteHint ? `\n【上一版被打回，务必修正】\n${ctx.rewriteHint}` : "",
    brief ? `\n【写作约束块（来自大禹评审回流）】\n${brief}` : "",
    "\n直接输出正文，不要解释、不要标题、不要 Markdown 代码块。",
  ].filter(Boolean).join("\n");

  const text = (await llm.chat([
    { role: "system", content: system },
    { role: "user", content: user },
  ])).trim();

  return {
    chapterNo: ctx.chapterNo,
    title: ctx.title,
    text,
    promptPreview: user.slice(0, 200),
  };
}
