/**
 * 作品仓库：多作品持久化，每个作品一个独立目录 data/works/<id>/。
 * - 新建作品时根据题材/平台/篇幅自动生成章节规划（确定性，无需 LLM）。
 * - 平台级配置（LLM 端点、是否启用獬豸）存 data/settings.json。
 */
import fs from "node:fs";
import path from "node:path";
import type { ProjectSpec, ChapterSpec, RunState } from "./pipeline.js";

const SAFE_ID = /^[A-Za-z0-9_\-]{1,48}$/;

/** 大禹定位层枚举（与 novel-cda-mcp/rules.yaml 的 positioning_enums 对齐）——自由输入归一化到合法值 */
const COOL_TYPES = ["打脸碾压", "解谜智性", "无声反杀", "清醒退出", "情感共鸣"];
const VILLAIN_TYPES = ["敌人", "规则", "结构"];
const CONTRACTS = ["爽", "解谜", "共鸣", "治愈", "陪伴"];

function normalizeEnum(input: string | undefined, allowed: string[], fallback: string): string {
  const s = (input || "").trim();
  if (allowed.includes(s)) return s;
  // 包含匹配：如「规则压制」→「规则」，「情感向」→「情感共鸣」
  const hit = allowed.find((a) => s.includes(a));
  return hit || fallback;
}

export interface WorkSummary {
  id: string;
  书名: string;
  项目名: string;
  平台: string;
  status: RunState["status"] | "new";
  chapterCount: number;
  doneCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface NewWorkInput {
  书名: string;
  平台?: string;
  题材?: string;
  受众?: string;
  性别向?: "男频" | "女频" | "通用";
  爽点类型?: string;
  反派类型?: string;
  调性?: "冷感" | "炸裂" | "通用";
  改编形态?: string;
  章节数?: number;
  /** 逐章梗概（一行一章，可选）；给定则优先用它生成章节，否则按题材套模板 */
  章节梗概?: string[];
}

export interface Settings {
  llm: {
    baseURL: string;
    apiKey: string;
    model: string;
    temperature: number;
  };
  useXiezhi: boolean;
  maxRetries: number;
}

export class WorkRepo {
  readonly root: string;
  readonly worksDir: string;
  readonly settingsFile: string;

  constructor(root?: string) {
    this.root = path.resolve(root || process.env.NOVEL_FACTORY_DATA || "./.factory-data");
    this.worksDir = path.join(this.root, "works");
    this.settingsFile = path.join(this.root, "settings.json");
    fs.mkdirSync(this.worksDir, { recursive: true });
  }

  private workDir(id: string): string {
    if (!SAFE_ID.test(id)) throw new Error("非法作品 ID");
    const d = path.join(this.worksDir, id);
    if (!d.startsWith(this.worksDir + path.sep)) throw new Error("路径越界");
    return d;
  }

  private atomicWrite(file: string, data: string): void {
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, data, "utf8");
    fs.renameSync(tmp, file);
  }

  // ---------- 设置 ----------
  getSettings(): Settings {
    const fallback: Settings = {
      llm: { baseURL: "", apiKey: "", model: "gpt-4o-mini", temperature: 0.85 },
      useXiezhi: true,
      maxRetries: 2,
    };
    if (!fs.existsSync(this.settingsFile)) return fallback;
    try {
      const s = JSON.parse(fs.readFileSync(this.settingsFile, "utf8"));
      return {
        llm: { ...fallback.llm, ...(s.llm || {}) },
        useXiezhi: s.useXiezhi ?? true,
        maxRetries: s.maxRetries ?? 2,
      };
    } catch { return fallback; }
  }

  saveSettings(s: Settings): Settings {
    // 兼容从 env 继承的默认：前端传空 apiKey 时保留旧值，避免误清
    const old = this.getSettings();
    const merged: Settings = {
      llm: {
        baseURL: s.llm.baseURL ?? old.llm.baseURL,
        apiKey: s.llm.apiKey || old.llm.apiKey,
        model: s.llm.model || old.llm.model,
        temperature: Number.isFinite(s.llm.temperature) ? s.llm.temperature : old.llm.temperature,
      },
      useXiezhi: s.useXiezhi ?? old.useXiezhi,
      maxRetries: s.maxRetries ?? old.maxRetries,
    };
    this.atomicWrite(this.settingsFile, JSON.stringify(merged, null, 2));
    return merged;
  }

  // ---------- 作品 CRUD ----------
  list(): WorkSummary[] {
    const out: WorkSummary[] = [];
    for (const name of fs.readdirSync(this.worksDir)) {
      const dir = path.join(this.worksDir, name);
      if (!fs.statSync(dir).isDirectory()) continue;
      const specFile = path.join(dir, "spec.json");
      if (!fs.existsSync(specFile)) continue;
      try {
        const spec: ProjectSpec = JSON.parse(fs.readFileSync(specFile, "utf8"));
        const runFile = path.join(dir, "run.json");
        let status: WorkSummary["status"] = "new";
        let doneCount = 0;
        if (fs.existsSync(runFile)) {
          const run: RunState = JSON.parse(fs.readFileSync(runFile, "utf8"));
          status = run.status;
          doneCount = run.chapters.filter((c) => c.verdict && !/打回|失败|reject/i.test(c.verdict)).length;
        }
        const st = fs.statSync(specFile);
        out.push({
          id: name, 书名: spec.书名, 项目名: spec.项目名, 平台: spec.平台,
          status, chapterCount: spec.chapters?.length || 0, doneCount,
          createdAt: st.birthtime.toISOString(), updatedAt: st.mtime.toISOString(),
        });
      } catch { /* 跳过损坏目录 */ }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  create(input: NewWorkInput): ProjectSpec {
    const id = `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const dir = this.workDir(id);
    fs.mkdirSync(dir, { recursive: true });
    const spec = this.buildSpec(id, input);
    this.atomicWrite(path.join(dir, "spec.json"), JSON.stringify(spec, null, 2));
    return spec;
  }

  getSpec(id: string): ProjectSpec {
    const f = path.join(this.workDir(id), "spec.json");
    if (!fs.existsSync(f)) throw new Error("作品不存在");
    return JSON.parse(fs.readFileSync(f, "utf8"));
  }

  getRun(id: string): RunState | null {
    const f = path.join(this.workDir(id), "run.json");
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, "utf8"));
  }

  /** 草稿预览：定稿稿（draft.json）——若有 */
  getDraft(id: string): unknown | null {
    const f = path.join(this.workDir(id), "draft", "draft.json");
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, "utf8"));
  }

  remove(id: string): void {
    fs.rmSync(this.workDir(id), { recursive: true, force: true });
  }

  dirOf(id: string): string { return this.workDir(id); }

  /** 根据输入自动规划章节 —— 全自动的核心：用户只给方向，系统生成可执行的章纲 */
  private buildSpec(id: string, input: NewWorkInput): ProjectSpec {
    const 书名 = (input.书名 || "未命名之书").trim();
    const 平台 = (input.平台 || "番茄").trim();
    const 题材 = (input.题材 || "都市异能").trim();
    const 受众 = (input.受众 || "泛读者").trim();
    const 性别向 = input.性别向 || "男频";
    const tone = input.调性 || "通用";
    const n = Math.max(1, Math.min(60, input.章节数 || 5));
    const 章节梗概 = input.章节梗概?.map((s) => s.trim()).filter(Boolean) || [];

    const chapterSpecs: ChapterSpec[] = [];
    const wordTypes: ChapterSpec["wordType"][] = ["常规", "反击", "静场", "高潮", "极短"];
    for (let i = 1; i <= n; i++) {
      const wt = 章节梗概.length ? "常规" : wordTypes[(i - 1) % wordTypes.length];
      const summary = 章节梗概[i - 1] || `围绕「${题材}」推进主线：主角在第${i}幕遭遇关键事件，做出影响后续的选择。`;
      chapterSpecs.push({
        no: i,
        title: `第${i}章 ${this.chapterName(i, 题材)}`,
        wordType: wt,
        summary,
        darkPoint: this.darkPoint(i, 题材),
      });
    }

    return {
      projectId: id,
      项目名: `${书名}·创作项目`,
      书名,
      平台,
      platform: 平台,
      受众,
      性别向,
      情感契约: normalizeEnum("爽", CONTRACTS, "爽"),
      改编形态: input.改编形态 || "短剧",
      爽点类型: normalizeEnum(input.爽点类型, COOL_TYPES, "解谜智性"),
      反派类型: normalizeEnum(input.反派类型, VILLAIN_TYPES, "规则"),
      差异化: `每章围绕「${题材}」提供一个可验证的信息增量`,
      tone,
      chapters: chapterSpecs,
    };
  }

  private chapterName(i: number, 题材: string): string {
    const names = ["开局", "试探", "反转", "立威", "伏笔", "暗涌", "对决", "清算", "余波", "新局"];
    const stage = names[(i - 1) % names.length];
    return i === 1 ? `${stage}` : `${stage}·${题材.slice(0, 4)}`;
  }

  private darkPoint(i: number, 题材: string): string {
    const points = [
      "被低估者的第一次亮牌",
      "用对方制定的规则反制对方",
      "沉默比争辩更有力量的清醒",
      "关键情报在最后一刻揭示",
      "胜利背后埋下更大的悬念",
    ];
    return points[(i - 1) % points.length];
  }
}
