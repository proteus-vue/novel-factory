/**
 * Publisher：把定稿 + 编审状态烘焙成一个自包含、可离线、可安装的 PWA 阅读器。
 * 纯文件操作，零运行时依赖；产物目录可直接静态托管，或交给 Capacitor 打成本地 APK。
 *
 * 两个入口：
 *  - publish(state)        本地流水线跑完，从 RunState 发布
 *  - publishFromDraft(obj) CI 里从定稿 draft.json 发布（无需跑流水线/连 MCP）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunState } from "./pipeline.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 模板目录候选：开发态 src/web、编译态 dist/../src/web、包内 web */
function findTemplateDir(): string {
  const candidates = [
    path.join(__dirname, "web"),
    path.join(__dirname, "..", "src", "web"),
    path.resolve(process.cwd(), "src", "web"),
    path.resolve(process.cwd(), "web"),
  ];
  for (const c of candidates) if (fs.existsSync(path.join(c, "index.html"))) return c;
  throw new Error("找不到 PWA 模板目录（web/index.html）");
}

export interface PublishResult {
  outDir: string;
  title: string;
  chapters: number;
  files: string[];
}

/** 定稿数据结构（与 exportDraft 产出的 draft.json 对齐，供 CI 直接消费） */
export interface DraftBook {
  title: string;
  spec: Record<string, unknown>;
  exportedAt?: string;
  chapters: Array<{
    no: number;
    title: string;
    text: string;
    verdict: string;
    attempts: number;
    review?: unknown;
    xiezhi?: unknown;
  }>;
}

function escapeForScript(json: string): string {
  // 防止正文里出现 </script> 提前闭合注入点
  return json.replace(/<\//g, "<\\/");
}

/** 核心烘焙：把任意 DraftBook 写成 PWA 目录 */
export function renderBook(book: DraftBook, outDir: string): PublishResult {
  if (!book.chapters?.length) throw new Error("无定稿章节，先跑流水线");

  const templateDir = findTemplateDir();
  const dest = path.resolve(outDir);
  fs.mkdirSync(dest, { recursive: true });

  const title = book.title || "未命名之书";
  const payload: DraftBook = {
    title,
    spec: book.spec || {},
    exportedAt: book.exportedAt || new Date().toISOString(),
    chapters: [...book.chapters]
      .sort((a, b) => a.no - b.no)
      .map((c) => ({
        no: c.no, title: c.title, text: c.text,
        verdict: c.verdict, attempts: c.attempts,
        review: c.review, xiezhi: c.xiezhi,
      })),
  };
  const bookJson = escapeForScript(JSON.stringify(payload));

  // 文本模板做占位符替换，二进制（图标）直接拷贝
  let indexHtml = fs.readFileSync(path.join(templateDir, "index.html"), "utf8");
  indexHtml = indexHtml.replace("{{TITLE}}", escapeHtmlText(title))
                       .replace("{{BOOK_DATA}}", bookJson);
  fs.writeFileSync(path.join(dest, "index.html"), indexHtml, "utf8");

  let manifest = fs.readFileSync(path.join(templateDir, "manifest.webmanifest"), "utf8");
  manifest = manifest.replace(/\{\{TITLE\}\}/g, escapeJsonString(title));
  fs.writeFileSync(path.join(dest, "manifest.webmanifest"), manifest, "utf8");

  for (const file of ["app.css", "app.js", "sw.js", "icon-192.png", "icon-512.png"]) {
    fs.copyFileSync(path.join(templateDir, file), path.join(dest, file));
  }

  return { outDir: dest, title, chapters: book.chapters.length, files: fs.readdirSync(dest).sort() };
}

/** 本地：从流水线运行态发布 */
export function publish(state: RunState, outDir?: string): PublishResult {
  return renderBook({
    title: state.spec.书名,
    spec: state.spec as unknown as Record<string, unknown>,
    chapters: state.chapters,
  }, outDir || path.join(state.dataDir, "app"));
}

/** CI：从定稿 draft.json 发布（不经流水线、不连 MCP） */
export function publishFromDraft(draft: DraftBook, outDir: string): PublishResult {
  return renderBook(draft, outDir);
}

function escapeHtmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeJsonString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
