/**
 * 后台任务运行器：把耗时的 Pipeline 放到后台跑，HTTP 层可实时查询进度/日志，支持取消。
 * 单进程内串行执行（一次只跑一个作品），避免多个 MCP 子进程并发抢资源。
 */
import path from "node:path";
import { Pipeline, type RunState } from "./pipeline.js";
import { createLlmClient, type LlmClient } from "./llm.js";
import { exportDraft } from "./export.js";
import { WorkRepo, type Settings } from "./repo.js";

export type JobStatus = "queued" | "running" | "done" | "failed" | "canceled";

export interface Job {
  id: string;                 // = 作品 id
  status: JobStatus;
  logs: string[];
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  cancelRequested: boolean;
  progress: {
    current: number;
    total: number;
    chapterLabel: string;
  };
}

export class TaskRunner {
  private jobs = new Map<string, Job>();
  private queue: string[] = [];
  private running = false;
  private repo: WorkRepo;

  constructor(repo: WorkRepo) {
    this.repo = repo;
    // 启动时把「running」状态的遗留任务标记为 failed（进程重启后无法续跑子进程）
    for (const w of repo.list()) {
      if (w.status === "running") {
        const run = repo.getRun(w.id);
        if (run) run.status = "failed";
      }
    }
  }

  /** 入队一个作品；若已在队列/运行中返回 false */
  enqueue(id: string): boolean {
    const existing = this.jobs.get(id);
    if (existing && (existing.status === "queued" || existing.status === "running")) return false;
    const spec = this.repo.getSpec(id);
    const run = this.repo.getRun(id);
    // 规划前 chapters 为空，用章节数目标作为进度分母，避免灵动岛 0/0
    const total = spec.chapters?.length || (spec as any).章节数目标 || 0;
    const done = run?.chapters?.length || 0;
    this.jobs.set(id, {
      id, status: "queued", logs: [], cancelRequested: false,
      progress: { current: done, total, chapterLabel: done >= total ? "已完成" : `待写第${done + 1}章` },
    });
    this.queue.push(id);
    this.log(id, `已加入创作队列（共 ${total} 章）`);
    void this.drain();
    return true;
  }

  getJob(id: string): Job | undefined { return this.jobs.get(id); }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || (job.status !== "queued" && job.status !== "running")) return false;
    job.cancelRequested = true;
    this.log(id, "收到取消请求，将在当前步骤后停止");
    // 若在队列中，直接标记取消并移除
    if (job.status === "queued") {
      job.status = "canceled";
      job.finishedAt = new Date().toISOString();
      this.queue = this.queue.filter((x) => x !== id);
    }
    return true;
  }

  private log(id: string, msg: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    job.logs.push(`[${ts}] ${msg}`);
    if (job.logs.length > 500) job.logs = job.logs.slice(-500);
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const id = this.queue.shift()!;
        const job = this.jobs.get(id);
        if (!job || job.cancelRequested || job.status === "canceled") continue;
        await this.runJob(id, job).catch((e) => {
          job.status = "failed";
          job.error = (e as Error).message;
          job.finishedAt = new Date().toISOString();
          this.log(id, `任务失败：${job.error}`);
          // 把失败状态写回 run.json，供作品列表反映
          const run = this.repo.getRun(id);
          if (run) { run.status = "failed"; }
        });
      }
    } finally {
      this.running = false;
    }
  }

  private async runJob(id: string, job: Job): Promise<void> {
    job.status = "running";
    job.startedAt = new Date().toISOString();
    const spec = this.repo.getSpec(id);
    const settings = this.repo.getSettings();
    const llm: LlmClient = createLlmClient({
      baseURL: settings.llm.baseURL.replace(/\/$/, ""),
      apiKey: settings.llm.apiKey,
      model: settings.llm.model,
      temperature: settings.llm.temperature,
      maxTokens: 4096,
      timeoutMs: 120000,
    });
    this.log(id, `写稿引擎：${llm.mock ? "内置演示引擎（未配置模型）" : `模型 ${settings.llm.model}`}`);

    // MCP 路径可用环境变量覆盖（Docker 部署时指向容器内路径）
    // 默认相对路径占位；实际路径用环境变量指向克隆的 MCP 仓库（见 README）。
    const dayuEntry = process.env.DAYU_ENTRY || "novel-cda-mcp/dist/index.js";
    const xiezhiEntry = process.env.XIEZHI_ENTRY || "novel-review-mcp/src/server.py";
    const pipeline = new Pipeline(spec, {
      dataDir: this.repo.dirOf(id),
      repo: this.repo,
      useXiezhi: settings.useXiezhi,
      maxRetries: settings.maxRetries,
      llm,
      dayuCmd: process.env.DAYU_CMD || "node",
      dayuArgs: [dayuEntry],
      xiezhiCmd: process.env.XIEZHI_CMD || "python3",
      xiezhiArgs: [xiezhiEntry],
      xiezhiCwd: process.env.XIEZHI_CWD || path.dirname(xiezhiEntry),
      hooks: {
        onProgress: (m) => {
          this.log(id, m);
          this.syncProgress(id, job);
        },
        shouldStop: () => job.cancelRequested,
      },
    });

    const state = await pipeline.start();
    if (job.cancelRequested) {
      job.status = "canceled";
      job.finishedAt = new Date().toISOString();
      this.log(id, "任务已取消");
      return;
    }
    exportDraft(state);
    job.status = "done";
    job.finishedAt = new Date().toISOString();
    this.syncProgress(id, job);
    this.log(id, `全部完成：${state.chapters.length} 章定稿，已生成定稿文件`);
  }

  private syncProgress(id: string, job: Job): void {
    const run = this.repo.getRun(id);
    if (!run) return;
    job.progress.current = run.chapters.length;
    job.progress.total = run.spec.chapters?.length || (run.spec as any).章节数目标 || 0;
    const cur = run.spec.chapters[job.progress.current];
    job.progress.chapterLabel = run.status === "done" ? "已完成"
      : cur ? `正在写第${cur.no}章《${cur.title}》` : `待写第${job.progress.current + 1}章`;
  }

  /** 供 API 读取：当前运行态（章节+评审），无则 null */
  getRun(id: string): RunState | null { return this.repo.getRun(id); }
}
