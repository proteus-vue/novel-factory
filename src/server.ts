/**
 * 创作者平台 HTTP 服务：原生 node http，零框架依赖。
 * - REST API：作品 CRUD / 创作任务 / 章节与评审 / 定稿导出 / 发布阅读器 / 设置
 * - 静态托管：创作者控制台 /console、发布的阅读器 /read/<id>
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkRepo, type NewWorkInput } from "./repo.js";
import { TaskRunner } from "./runner.js";
import { exportDraft } from "./export.js";
import { renderBook } from "./publisher.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 静态模板目录候选（源码态/编译态/包内） */
function findConsoleDir(): string {
  const candidates = [
    path.join(__dirname, "console"),
    path.join(__dirname, "..", "src", "console"),
    path.resolve(process.cwd(), "src", "console"),
  ];
  for (const c of candidates) if (fs.existsSync(path.join(c, "index.html"))) return c;
  throw new Error("找不到控制台目录 src/console");
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".md": "text/markdown; charset=utf-8",
};

export interface ServerOptions {
  port?: number;
  host?: string;
  repo?: WorkRepo;
  runner?: TaskRunner;
  quiet?: boolean;
}

export function createServer(opts: ServerOptions = {}): http.Server {
  const repo = opts.repo || new WorkRepo();
  const runner = opts.runner || new TaskRunner(repo);
  const consoleDir = findConsoleDir();
  const log = (m: string) => { if (!opts.quiet) console.log("[server]", m); };

  const send = (res: http.ServerResponse, code: number, body: unknown, type = "application/json; charset=utf-8") => {
    res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
    if (Buffer.isBuffer(body)) return res.end(body);
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  const ok = (res: http.ServerResponse, data: unknown) => send(res, 200, { ok: true, data });
  const fail = (res: http.ServerResponse, code: number, msg: string) => send(res, code, { ok: false, error: msg });

  const readBody = (req: http.IncomingMessage): Promise<string> => new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 5_000_000) reject(new Error("请求体过大")); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
  const jsonBody = async (req: http.IncomingMessage): Promise<Record<string, unknown>> => {
    const raw = await readBody(req);
    return raw ? JSON.parse(raw) : {};
  };

  /** 安全地提供静态文件：阻止路径穿越 */
  const serveStatic = (res: http.ServerResponse, baseDir: string, rel: string): boolean => {
    let relPath: string;
    try { relPath = decodeURIComponent(rel); } catch { relPath = rel; }
    relPath = relPath.replace(/^\/+/, "");
    if (!relPath) relPath = "index.html";
    const full = path.resolve(baseDir, relPath);
    if (!full.startsWith(path.resolve(baseDir) + path.sep) && full !== path.resolve(baseDir)) {
      fail(res, 403, "路径越界"); return true;
    }
    if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      const index = path.join(full, "index.html");
      if (fs.existsSync(index)) {
        send(res, 200, fs.readFileSync(index), MIME[".html"]); return true;
      }
      fail(res, 404, "文件不存在"); return true;
    }
    const ext = path.extname(full).toLowerCase();
    send(res, 200, fs.readFileSync(full), MIME[ext] || "application/octet-stream");
    return true;
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      const p = url.pathname;

      // ---------- 健康检查 ----------
      if (p === "/api/health" && req.method === "GET") {
        return ok(res, { status: "ok", time: new Date().toISOString() });
      }

      // ---------- 设置 ----------
      if (p === "/api/settings" && req.method === "GET") {
        const s = repo.getSettings();
        // apiKey 打码返回，避免明文回传；保存时用占位保留
        return ok(res, { ...s, llm: { ...s.llm, apiKey: s.llm.apiKey ? "••••••" + s.llm.apiKey.slice(-4) : "" } });
      }
      if (p === "/api/settings" && req.method === "POST") {
        const body = await jsonBody(req);
        const current = repo.getSettings();
        const llm = (body.llm || {}) as Record<string, unknown>;
        const saved = repo.saveSettings({
          llm: {
            baseURL: String(llm.baseURL ?? current.llm.baseURL),
            apiKey: String(llm.apiKey ?? ""),
            model: String(llm.model ?? current.llm.model),
            temperature: Number(llm.temperature ?? current.llm.temperature),
          },
          useXiezhi: body.useXiezhi === undefined ? current.useXiezhi : Boolean(body.useXiezhi),
          maxRetries: body.maxRetries === undefined ? current.maxRetries : Number(body.maxRetries),
        });
        return ok(res, saved);
      }

      // ---------- 作品列表 / 新建 ----------
      if (p === "/api/works" && req.method === "GET") {
        const list = repo.list().map((w) => {
          const job = runner.getJob(w.id);
          return { ...w, job: job ? { status: job.status, progress: job.progress, error: job.error } : null };
        });
        return ok(res, list);
      }
      if (p === "/api/works" && req.method === "POST") {
        const input = await jsonBody(req) as unknown as NewWorkInput;
        if (!input.书名 || !String(input.书名).trim()) return fail(res, 400, "书名不能为空");
        const spec = repo.create(input);
        return ok(res, { id: spec.projectId, spec });
      }

      // ---------- 单作品 ----------
      const workMatch = p.match(/^\/api\/works\/([^/]+)$/);
      if (workMatch) {
        const id = workMatch[1];
        if (req.method === "GET") {
          const spec = repo.getSpec(id);
          const run = repo.getRun(id);
          const job = runner.getJob(id);
          return ok(res, {
            spec,
            run: run ? {
              status: run.status, currentChapter: run.currentChapter,
              chapters: run.chapters.map((c) => ({
                no: c.no, title: c.title, textLen: c.text?.length || 0,
                verdict: c.verdict, attempts: c.attempts,
                hasReview: !!c.review, hasXiezhi: !!c.xiezhi,
              })),
            } : null,
            job: job ? { status: job.status, progress: job.progress, logs: job.logs, error: job.error } : null,
            hasDraft: !!repo.getDraft(id),
          });
        }
        if (req.method === "DELETE") {
          runner.cancel(id);
          repo.remove(id);
          log(`删除作品 ${id}`);
          return ok(res, { deleted: id });
        }
      }

      // ---------- 创作任务 ----------
      const runMatch = p.match(/^\/api\/works\/([^/]+)\/run$/);
      if (runMatch && req.method === "POST") {
        const id = runMatch[1];
        repo.getSpec(id); // 校验存在
        const started = runner.enqueue(id);
        log(`创作任务 ${id}: ${started ? "已入队" : "已在运行"}`);
        return ok(res, { started, job: runner.getJob(id) });
      }
      const cancelMatch = p.match(/^\/api\/works\/([^/]+)\/cancel$/);
      if (cancelMatch && req.method === "POST") {
        return ok(res, { canceled: runner.cancel(cancelMatch[1]) });
      }
      const statusMatch = p.match(/^\/api\/works\/([^/]+)\/status$/);
      if (statusMatch && req.method === "GET") {
        const job = runner.getJob(statusMatch[1]);
        return ok(res, job ? { status: job.status, progress: job.progress, logs: job.logs, error: job.error }
                           : { status: "idle", progress: { current: 0, total: 0, chapterLabel: "未开始" }, logs: [] });
      }

      // ---------- 章节正文 / 评审 ----------
      const chMatch = p.match(/^\/api\/works\/([^/]+)\/chapter\/(\d+)$/);
      if (chMatch && req.method === "GET") {
        const run = repo.getRun(chMatch[1]);
        const no = Number(chMatch[2]);
        const ch = run?.chapters.find((c) => c.no === no);
        if (!ch) return fail(res, 404, "章节不存在（可能尚未写完）");
        return ok(res, ch);
      }

      // ---------- 定稿导出 ----------
      const exportMatch = p.match(/^\/api\/works\/([^/]+)\/export$/);
      if (exportMatch && req.method === "POST") {
        const run = repo.getRun(exportMatch[1]);
        if (!run || !run.chapters.length) return fail(res, 400, "还没有可导出的定稿");
        const r = exportDraft(run);
        return ok(res, {
          markdown: fs.readFileSync(r.markdownPath, "utf8"),
          jsonPath: path.relative(repo.root, r.jsonPath),
          chapters: r.chapters,
        });
      }
      const draftMatch = p.match(/^\/api\/works\/([^/]+)\/draft$/);
      if (draftMatch && req.method === "GET") {
        const draft = repo.getDraft(draftMatch[1]);
        if (!draft) return fail(res, 404, "尚无定稿");
        return ok(res, draft);
      }

      // ---------- 发布阅读器 ----------
      const pubMatch = p.match(/^\/api\/works\/([^/]+)\/publish$/);
      if (pubMatch && req.method === "POST") {
        const draft = repo.getDraft(pubMatch[1]) as { title?: string; spec?: Record<string, unknown>; chapters?: unknown[] } | null;
        if (!draft || !draft.chapters?.length) return fail(res, 400, "请先完成创作并导出定稿");
        const outDir = path.join(repo.dirOf(pubMatch[1]), "app");
        const r = renderBook({
          title: draft.title || "未命名之书",
          spec: draft.spec || {},
          chapters: draft.chapters as never,
        }, outDir);
        log(`发布阅读器 ${pubMatch[1]}: ${r.chapters} 章`);
        return ok(res, { readUrl: `/read/${pubMatch[1]}/`, chapters: r.chapters, files: r.files });
      }

      // ---------- 静态资源 ----------
      if (p === "/" || p === "/console" || p.startsWith("/console/")) {
        const rel = p.replace(/^\/console\/?/, "");
        return serveStatic(res, consoleDir, rel);
      }
      const readMatch = p.match(/^\/read\/([^/]+)\/?(.*)$/);
      if (readMatch) {
        const appDir = path.join(repo.dirOf(readMatch[1]), "app");
        if (!fs.existsSync(appDir)) return fail(res, 404, "该作品尚未发布阅读器");
        // 校验 id 合法（dirOf 已做），再提供静态文件
        return serveStatic(res, appDir, readMatch[2]);
      }

      return fail(res, 404, "未找到接口");
    } catch (e) {
      log(`请求错误: ${(e as Error).message}`);
      return fail(res, 500, (e as Error).message);
    }
  });

  return server;
}

/** 独立启动入口 */
export function startServer(opts: ServerOptions = {}): void {
  const port = opts.port ?? Number(process.env.PORT || 8787);
  const host = opts.host || "0.0.0.0";
  const server = createServer(opts);
  server.listen(port, host, () => {
    console.log(`\n  小说工厂创作者平台已启动`);
    console.log(`  控制台:  http://localhost:${port}/`);
    console.log(`  健康检查: http://localhost:${port}/api/health\n`);
  });
}
