/** 定稿导出：Markdown 阅读稿 + 结构化 JSON（含人设/伏笔/评审记录），供后续 Publisher 消费。 */
import fs from "node:fs";
import path from "node:path";
import type { RunState } from "./pipeline.js";

export interface ExportResult {
  markdownPath: string;
  jsonPath: string;
  chapters: number;
}

export function exportDraft(state: RunState, outDir?: string): ExportResult {
  const dir = path.resolve(outDir || path.join(state.dataDir, "draft"));
  fs.mkdirSync(dir, { recursive: true });

  const ordered = [...state.chapters].sort((a, b) => a.no - b.no);
  const md: string[] = [
    `# ${state.spec.书名}`,
    "",
    `> 项目：${state.spec.项目名} ｜ 平台：${state.spec.平台} ｜ 调性：${state.spec.tone || "通用"}`,
    `> 爽点：${state.spec.爽点类型} ｜ 反派：${state.spec.反派类型} ｜ 情感契约：${state.spec.情感契约}`,
    "",
    "---",
    "",
  ];
  for (const ch of ordered) {
    md.push(`## 第${ch.no}章 ${ch.title}`, "", ch.text, "", "---", "");
  }
  const markdownPath = path.join(dir, "draft.md");
  fs.writeFileSync(markdownPath, md.join("\n"), "utf8");

  const jsonPath = path.join(dir, "draft.json");
  fs.writeFileSync(jsonPath, JSON.stringify({
    title: state.spec.书名,
    spec: state.spec,
    chapters: ordered.map((c) => ({
      no: c.no, title: c.title, text: c.text,
      verdict: c.verdict, attempts: c.attempts,
      review: c.review, xiezhi: c.xiezhi,
    })),
    exportedAt: new Date().toISOString(),
  }, null, 2), "utf8");

  return { markdownPath, jsonPath, chapters: ordered.length };
}
