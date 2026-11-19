/**
 * 流水线状态机：init → 逐章(plan→write→review→[打回回流重写]→落章) → 定稿。
 * 状态持久化到 run.json，支持断点续跑；獬豸终审为可选（失败则降级只用大禹）。
 */
import fs from "node:fs";
import path from "node:path";
import { McpClient } from "./mcp-client.js";
import { createLlmClient, loadLlmConfig, type LlmClient } from "./llm.js";
import { writeChapter, type WriteContext } from "./writer.js";

export interface ProjectSpec {
  projectId: string;
  项目名: string;
  书名: string;
  平台: string;
  platform?: string;  // 獬豸评审用的平台标识，缺省用"平台"
  受众: string;
  性别向: string;
  情感契约: string;
  改编形态: string;
  爽点类型: string;
  反派类型: string;
  差异化: string;
  tone?: "冷感" | "炸裂" | "通用";
  chapters: ChapterSpec[];
}

export interface ChapterSpec {
  no: number;
  title: string;
  wordType: "静场" | "常规" | "反击" | "高潮" | "极短";
  summary: string;
  darkPoint: string;
}

export interface ChapterRecord {
  no: number;
  title: string;
  text: string;
  verdict: string;
  attempts: number;
  review: unknown;
  xiezhi?: unknown;
}

export interface RunState {
  spec: ProjectSpec;
  status: "init" | "running" | "done" | "failed";
  currentChapter: number;
  chapters: ChapterRecord[];
  startedAt: string;
  updatedAt: string;
  dataDir: string;
}

export interface PipelineOptions {
  dataDir?: string;        // 大禹 CDA_MCP_DATA
  dayuCmd?: string;
  dayuArgs?: string[];
  xiezhiCmd?: string;
  xiezhiArgs?: string[];
  xiezhiCwd?: string;
  useXiezhi?: boolean;
  maxRetries?: number;
  llm?: LlmClient;
  hooks?: {
    onProgress?: (msg: string) => void;
    /** 返回 true 时流水线在下一个安全点停止（用于取消任务） */
    shouldStop?: () => boolean;
  };
}

// 默认用相对路径占位；实际路径通过环境变量配置（见 README「环境变量」）。
// 大禹 MCP: https://github.com/proteus-vue/novel-cda-mcp
// 獬豸 MCP: https://github.com/proteus-vue/novel-review-mcp
const DEFAULT_DAYU = {
  cmd: process.env.DAYU_CMD || "node",
  args: [process.env.DAYU_ENTRY || "novel-cda-mcp/dist/index.js"],
};
const DEFAULT_XIEZHI = {
  cmd: process.env.XIEZHI_CMD || "python3",
  args: [process.env.XIEZHI_ENTRY || "novel-review-mcp/src/server.py"],
  cwd: process.env.XIEZHI_CWD || "novel-review-mcp/src",
};

export class Pipeline {
  private dayu!: McpClient;
  private xiezhi?: McpClient;
  private llm: LlmClient;
  private stateFile: string;
  private opts: Required<Pick<PipelineOptions, "maxRetries" | "useXiezhi">> & PipelineOptions;
  private log = (m: string) => {
    if (this.opts.hooks?.onProgress) this.opts.hooks.onProgress(m);
    else console.log("[pipeline]", m);
  };

  constructor(spec: ProjectSpec, opts: PipelineOptions = {}) {
    this.opts = { maxRetries: 2, useXiezhi: true, ...opts };
    this.llm = opts.llm || createLlmClient(loadLlmConfig());
    const workDir = path.resolve(opts.dataDir || "./.factory-run");
    fs.mkdirSync(workDir, { recursive: true });
    this.stateFile = path.join(workDir, "run.json");
    this.state = {
      spec,
      status: "init",
      currentChapter: 0,
      chapters: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      dataDir: workDir,
    };
  }

  private state!: RunState;

  private save() {
    this.state.updatedAt = new Date().toISOString();
    const tmp = this.stateFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf8");
    fs.renameSync(tmp, this.stateFile);
  }

  getState(): RunState { return JSON.parse(JSON.stringify(this.state)); }

  /** 从 run.json 恢复（断点续跑） */
  static resume(workDir: string): Pipeline | null {
    const f = path.join(path.resolve(workDir), "run.json");
    if (!fs.existsSync(f)) return null;
    const s: RunState = JSON.parse(fs.readFileSync(f, "utf8"));
    const p = new Pipeline(s.spec, { dataDir: workDir });
    p.state = s;
    return p;
  }

  async start(): Promise<RunState> {
    // 1. 启动两个 MCP
    const dayuData = path.join(this.state.dataDir, "dayu-data");
    fs.mkdirSync(dayuData, { recursive: true });
    this.dayu = new McpClient("大禹", this.opts.dayuCmd || DEFAULT_DAYU.cmd,
      this.opts.dayuArgs || DEFAULT_DAYU.args, { env: { CDA_MCP_DATA: dayuData } });
    await this.dayu.connect();
    this.log(`大禹已连接（${(await this.dayu.listTools()).length} 工具）`);

    if (this.opts.useXiezhi) {
      try {
        this.xiezhi = new McpClient("獬豸", this.opts.xiezhiCmd || DEFAULT_XIEZHI.cmd,
          this.opts.xiezhiArgs || DEFAULT_XIEZHI.args, { cwd: this.opts.xiezhiCwd || DEFAULT_XIEZHI.cwd });
        await this.xiezhi.connect();
        this.log(`獬豸已连接（${(await this.xiezhi.listTools()).length} 工具）`);
      } catch (e) {
        this.log(`獬豸连接失败，降级只用大禹：${(e as Error).message}`);
        this.xiezhi?.close();
        this.xiezhi = undefined;
      }
    }

    // 2. 立项（幂等：已建过则跳过）
    if (this.state.status === "init") {
      const s = this.state.spec;
      await this.dayu.callTool("init_project", {
        project_id: s.projectId, 项目名: s.项目名, 书名: s.书名, 平台: s.平台,
        受众: s.受众, 性别向: s.性别向, 情感契约: s.情感契约, 改编形态: s.改编形态,
        爽点类型: s.爽点类型, 反派类型: s.反派类型, 差异化: s.差异化, tone: s.tone || "通用",
      });
      this.log(`项目「${s.项目名}」已立项`);
      this.state.status = "running";
      this.save();
    }

    // 3. 逐章流水线
    for (const spec of this.state.spec.chapters) {
      if (this.opts.hooks?.shouldStop?.()) {
        this.log("收到停止信号，流水线中断（已完成的章节已保存）");
        this.close();
        return this.getState();
      }
      if (this.state.chapters.some((c) => c.no === spec.no && c.verdict !== "打回重写")) continue;
      await this.processChapter(spec);
    }

    this.state.status = "done";
    this.save();
    this.log(`流水线完成：${this.state.chapters.length} 章定稿`);
    this.close();
    return this.getState();
  }

  private async processChapter(spec: ChapterSpec): Promise<void> {
    // 结构层先行：大禹强制"章纲先行 → 批量生成 → 人工抽检"，无章纲必打回。
    // 幂等：重跑时若已存过则跳过（save_outline 重复会冲突告警）。
    if (!this.state.chapters.some((c) => c.no === spec.no)) {
      await this.dayu.callTool("plan_chapter", {
        project_id: this.state.spec.projectId,
        chapter_no: spec.no,
        word_type: spec.wordType,
      });
      await this.dayu.callTool("save_outline", {
        project_id: this.state.spec.projectId,
        chapter_no: spec.no,
        title: spec.title,
        summary: spec.summary,
        dark_point: spec.darkPoint,
        emotion: spec.wordType === "反击" ? "释放" : spec.wordType === "静场" ? "沉淀" : "转折",
        word_type: spec.wordType,
      });
      this.log(`第${spec.no}章章纲已入库`);
    }

    let lastReview: unknown = undefined;
    let hint: string | undefined;
    let record: ChapterRecord | undefined;

    for (let attempt = 1; attempt <= this.opts.maxRetries + 1; attempt++) {
      this.log(`第${spec.no}章「${spec.title}」第 ${attempt} 次写稿`);

      // 写
      const written = await writeChapter(this.dayu, this.llm, {
        projectId: this.state.spec.projectId,
        chapterNo: spec.no,
        title: spec.title,
        wordType: spec.wordType,
        summary: spec.summary,
        darkPoint: spec.darkPoint,
        lastReview,
        rewriteHint: hint,
      });

      // 审（大禹）
      const review: any = await this.dayu.callTool("review_chapter", {
        project_id: this.state.spec.projectId,
        chapter_no: spec.no,
        text: written.text,
        title: spec.title,
      });

      record = {
        no: spec.no, title: spec.title, text: written.text,
        verdict: review?.verdict || "未知", attempts: attempt, review,
      };

      // 獬豸终审（可选）：把大禹评审包成 review_batch 风格再送，失败不影响主流程
      if (this.xiezhi) {
        try {
          const t = await this.xiezhi.listTools();
          const reviewTool = t.find((x) => /review/i.test(x.name));
          if (reviewTool) {
            record.xiezhi = await this.xiezhi.callTool(reviewTool.name, {
              title: spec.title, text: written.text, platform: this.state.spec.platform || this.state.spec.平台,
            });
          }
        } catch (e) {
          record.xiezhi = { skipped: true, reason: (e as Error).message };
        }
      }

      const passed = !/打回|禁止|失败|reject/i.test(record.verdict);
      if (passed) {
        this.log(`第${spec.no}章通过（${attempt} 次）`);
        break;
      }

      // 打回 → 构造回流提示，准备重写
      lastReview = review;
      const problems = review?.problems || review?.issues || [];
      hint = Array.isArray(problems)
        ? problems.map((p: any) => (typeof p === "string" ? p : p.detail || p.suggestion || JSON.stringify(p))).join("；")
        : JSON.stringify(problems);
      this.log(`第${spec.no}章被打回：${hint.slice(0, 80)}`);
    }

    if (record) {
      const idx = this.state.chapters.findIndex((c) => c.no === spec.no);
      if (idx >= 0) this.state.chapters[idx] = record;
      else this.state.chapters.push(record);
      this.state.currentChapter = spec.no;
      this.save();
    }
  }

  close() {
    this.dayu?.close();
    this.xiezhi?.close();
  }
}
