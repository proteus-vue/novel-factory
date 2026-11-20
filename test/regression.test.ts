import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pipeline, type ProjectSpec, type RunState } from "../src/pipeline.js";
import { exportDraft } from "../src/export.js";
import { publish, publishFromDraft } from "../src/publisher.js";
import type { LlmClient, ChatMessage } from "../src/llm.js";
import { WorkRepo } from "../src/repo.js";
import { runPlanning } from "../src/planner.js";
import { createServer } from "../src/server.js";
import http from "node:http";

// 流水线闭环用例需要真实的大禹 MCP。用环境变量指向克隆的 MCP 入口；
// 未配置时这些用例自动跳过，保证 clone 后无 MCP 也能 pnpm test（其余用例照跑）。
const DAYU_ARGS = process.env.DAYU_ENTRY ? [process.env.DAYU_ENTRY] : undefined;
const pipelineIt = DAYU_ARGS ? it : it.skip;

const spec: ProjectSpec = {
  projectId: "test_book", 项目名: "测试", 书名: "测试之书", 平台: "番茄",
  受众: "泛", 性别向: "男频", 情感契约: "爽", 改编形态: "短剧",
  爽点类型: "解谜智性", 反派类型: "规则", 差异化: "测试", tone: "通用",
  chapters: [
    { no: 1, title: "第一章 测试开始", wordType: "常规", summary: "测试", darkPoint: "反转" },
  ],
};

/** 第一版故意油腻（嘴角勾起）+ 裸数字 + 括号段，触发打回；重写后干净 */
class FlakyLlm implements LlmClient {
  readonly mock = true;
  public calls = 0;
  async chat(_msgs: ChatMessage[]): Promise<string> {
    this.calls++;
    if (this.calls === 1) {
      return "第一章开始了。\n\n他嘴角勾起一抹狂妄的笑，嚣张地走向检测台。\n\n（这里有一大段不该出现在正文里的括号注释说明，它超过了四十个字因此会被TTS逐字读出来非常糟糕。）\n\n数字123出现了。";
    }
    return "第一章鉴定开始了。\n\n他盯着泛着冷光的检测台，指节微微收紧。\n\n周围的仪器低低嗡鸣，所有人都屏住了呼吸。\n\n他深吸一口气把手按了上去，屏幕亮起时全场愣住了。";
  }
}

describe("流水线闭环", () => {
  pipelineIt("打回后自动回流重写，最终通过（attempts ≥ 2）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nf-test-"));
    const llm = new FlakyLlm();
    const p = new Pipeline(spec, { dataDir: dir, useXiezhi: false, llm, dayuArgs: DAYU_ARGS });
    const state = await p.start();
    const ch = state.chapters[0];
    expect(ch).toBeDefined();
    expect(ch.attempts).toBeGreaterThanOrEqual(2);   // 至少重写一次
    expect(llm.calls).toBeGreaterThanOrEqual(2);
    expect(ch.verdict).not.toMatch(/打回|禁止/);     // 最终通过
    expect(state.status).toBe("done");
    fs.rmSync(dir, { recursive: true, force: true });
  }, 180_000);

  pipelineIt("断点续跑：resume 恢复已跑状态", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nf-resume-"));
    const p = new Pipeline(spec, { dataDir: dir, useXiezhi: false, dayuArgs: DAYU_ARGS });
    await p.start();
    const resumed = Pipeline.resume(dir);
    expect(resumed).not.toBeNull();
    expect(resumed!.getState().status).toBe("done");
    expect(resumed!.getState().chapters.length).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 180_000);

  pipelineIt("定稿导出：Markdown + JSON 齐全", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nf-export-"));
    const p = new Pipeline(spec, { dataDir: dir, useXiezhi: false, dayuArgs: DAYU_ARGS });
    const state = await p.start();
    const r = exportDraft(state);
    expect(fs.existsSync(r.markdownPath)).toBe(true);
    expect(fs.existsSync(r.jsonPath)).toBe(true);
    expect(r.chapters).toBe(1);
    const json = JSON.parse(fs.readFileSync(r.jsonPath, "utf8"));
    expect(json.chapters[0].verdict).toBeTruthy();
    fs.rmSync(dir, { recursive: true, force: true });
  }, 180_000);
});

describe("Publisher 定稿发布", () => {
  const state: RunState = {
    spec, status: "done", currentChapter: 1, dataDir: "/tmp/unused",
    startedAt: "", updatedAt: "",
    chapters: [{
      no: 1, title: "第一章 测试开始", text: "正文第一行。\n\n正文第二行。</script>注入测试",
      verdict: "通过", attempts: 2, review: { verdict: "通过", problems: [] },
    }],
  };

  it("发布 PWA：产物齐全、书名注入、无占位符残留", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nf-publish-"));
    const r = publish(state, path.join(dir, "app"));
    expect(r.chapters).toBe(1);
    expect(r.title).toBe("测试之书");
    for (const f of ["index.html", "app.css", "app.js", "sw.js", "manifest.webmanifest", "icon-192.png", "icon-512.png"]) {
      expect(fs.existsSync(path.join(r.outDir, f))).toBe(true);
    }
    const html = fs.readFileSync(path.join(r.outDir, "index.html"), "utf8");
    expect(html).not.toMatch(/\{\{/);          // 占位符全部替换
    expect(html).toMatch(/<title>测试之书<\/title>/);
    expect(html).toMatch(/第一章 测试开始/);
    const mf = fs.readFileSync(path.join(r.outDir, "manifest.webmanifest"), "utf8");
    expect(JSON.parse(mf).name).toBe("测试之书");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("正文中的 </script> 被转义，注入 JSON 仍可完整解析", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nf-inject-"));
    const r = publish(state, path.join(dir, "app"));
    const html = fs.readFileSync(path.join(r.outDir, "index.html"), "utf8");
    const m = html.match(/<script id="book-data" type="application\/json">([\s\S]*?)<\/script>/);
    expect(m).not.toBeNull();
    const data = JSON.parse(m![1].replace(/<\\\//g, "</"));
    expect(data.chapters[0].text).toContain("注入测试");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("空定稿拒绝发布", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nf-empty-"));
    expect(() => publish({ ...state, chapters: [] }, path.join(dir, "app"))).toThrow(/无定稿章节/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("CI 路径：从 draft.json 结构直接烘焙（不经 RunState）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nf-draft-"));
    const draft = {
      title: "CI 之书",
      spec: { projectId: "ci_book", 书名: "CI 之书", 平台: "番茄" },
      chapters: [{ no: 2, title: "第二章", text: "正文。", verdict: "通过", attempts: 1 }],
    };
    const r = publishFromDraft(draft, path.join(dir, "app"));
    expect(r.title).toBe("CI 之书");
    const html = fs.readFileSync(path.join(r.outDir, "index.html"), "utf8");
    expect(html).toMatch(/<title>CI 之书<\/title>/);
    expect(html).not.toMatch(/\{\{/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("创作者平台 · 作品仓库", () => {
  it("新建作品只登记方向：不生成章纲、plan=pending，定位枚举归一化到合法值", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nf-repo-"));
    const repo = new WorkRepo(dir);
    const s = repo.create({ 书名: "测试书", 爽点类型: "扮猪吃虎", 反派类型: "规则压制", 章节数: 4 });
    // 自由输入被映射到合法枚举（大禹只认五选一/三选一）
    expect(["打脸碾压", "解谜智性", "无声反杀", "清醒退出", "情感共鸣"]).toContain(s.爽点类型);
    expect(["敌人", "规则", "结构"]).toContain(s.反派类型);
    expect(["爽", "解谜", "共鸣", "治愈", "陪伴"]).toContain(s.情感契约);
    // 关键修复：创建时不秒生成章纲，留空交给规划阶段
    expect(s.chapters.length).toBe(0);
    expect(s.章节数目标).toBe(4);
    expect(repo.getPlan(s.projectId)?.status).toBe("pending");
    expect(repo.list().length).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("规划三阶段：作品包 + 卷纲 + 章纲，章纲非模板且各异", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nf-plan-"));
    const repo = new WorkRepo(dir);
    const s = repo.create({ 书名: "规划之书", 题材: "都市重生", 章节数: 6 });
    const llm = new FlakyLlm(); // mock 演示引擎
    const logs: string[] = [];
    const result = await runPlanning(repo, s.projectId, llm, (m) => logs.push(m), () => false);
    // 作品包含定位/锁定层
    expect(result.plan.status).toBe("planned");
    expect(result.plan.blueprint).toBeTruthy();
    expect(Array.isArray((result.plan.blueprint as any)["人设禁止项"])).toBe(true);
    // 卷纲连续覆盖、末卷止章=6
    expect(result.plan.volumes.length).toBeGreaterThan(0);
    expect((result.plan.volumes[result.plan.volumes.length - 1] as any)["止章"]).toBe(6);
    // 章纲 = 目标章数，且每章 summary 不同、不含占位套话
    expect(result.spec.chapters.length).toBe(6);
    const summaries = result.spec.chapters.map((c) => c.summary);
    expect(new Set(summaries).size).toBe(6);
    expect(summaries.some((t) => /第\d+幕遭遇关键事件/.test(t))).toBe(false);
    // 三阶段日志齐全
    expect(logs.some((l) => /作品包/.test(l))).toBe(true);
    expect(logs.some((l) => /卷纲/.test(l))).toBe(true);
    expect(logs.some((l) => /细纲/.test(l))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("多作品目录隔离，删除一个不影响其他", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nf-multi-"));
    const repo = new WorkRepo(dir);
    const a = repo.create({ 书名: "A书", 章节数: 2 });
    const b = repo.create({ 书名: "B书", 章节数: 3 });
    expect(repo.list().length).toBe(2);
    expect(repo.getSpec(a.projectId).书名).toBe("A书");
    repo.remove(a.projectId);
    expect(repo.list().length).toBe(1);
    expect(repo.getSpec(b.projectId).书名).toBe("B书");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("创作者平台 · HTTP API", () => {
  it("作品 CRUD + 静态首页返回真实 HTML（非 Buffer JSON）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nf-api-"));
    const repo = new WorkRepo(dir);
    const server = createServer({ repo, quiet: true, port: 0 });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as { port: number };
    const base = `http://127.0.0.1:${addr.port}`;
    const req = (p: string, method = "GET", body?: unknown) =>
      new Promise<{ code: number; text: string }>((resolve, reject) => {
        const data = body ? JSON.stringify(body) : "";
        const r = http.request(base + p, { method, headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {} }, (res) => {
          let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => resolve({ code: res.statusCode!, text: t }));
        });
        r.on("error", reject); if (data) r.write(data); r.end();
      });

    const health = JSON.parse((await req("/api/health")).text);
    expect(health.data.status).toBe("ok");

    const created = JSON.parse((await req("/api/works", "POST", { 书名: "API书", 章节数: 2 })).text);
    expect(created.ok).toBe(true);
    const id = created.data.id;
    const listed = JSON.parse((await req("/api/works")).text);
    expect(listed.data.length).toBe(1);

    const home = await req("/");
    expect(home.code).toBe(200);
    expect(home.text).toMatch(/^<!DOCTYPE html>/);          // 必须是原始 HTML
    expect(home.text).toMatch(/<script type="module" src="\/console\/app\.js">/);
    expect(home.text).not.toMatch(/\{"type":"Buffer"/);      // 不能是被 JSON 化的 Buffer

    const appJs = await req("/console/app.js");
    expect(appJs.text).toMatch(/创作者平台前端/);

    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
