/**
 * novel-factory CLI：小说工业化流水线编排层入口。
 *   run    — 跑完整流水线（或断点续跑）
 *   status — 查看当前进度
 *   export — 导出定稿
 */
import fs from "node:fs";
import path from "node:path";
import { Pipeline, type ProjectSpec } from "./pipeline.js";
import { exportDraft } from "./export.js";
import { publish, publishFromDraft } from "./publisher.js";
import { startServer } from "./server.js";

const WORK_DIR = path.resolve(process.env.NOVEL_FACTORY_DATA || "./.factory-run");

function defaultSpec(): ProjectSpec {
  return {
    projectId: "demo_book",
    项目名: "演示作品",
    书名: "未命名之书",
    平台: "番茄",
    受众: "泛读者",
    性别向: "男频",
    情感契约: "爽",
    改编形态: "短剧",
    爽点类型: "解谜智性",
    反派类型: "规则",
    差异化: "每章一个可验证的信息增量",
    tone: "通用",
    chapters: [
      { no: 1, title: "第一章 检测开始", wordType: "常规", summary: "主角参加天赋检测，被所有人轻视。", darkPoint: "检测结果出乎意料" },
      { no: 2, title: "第二章 反转的读数", wordType: "反击", summary: "仪器显示异常读数，全场哗然。", darkPoint: "用规则反制嘲讽者" },
      { no: 3, title: "第三章 无声的离场", wordType: "静场", summary: "主角冷静离开，埋下更大伏笔。", darkPoint: "不争而胜的清醒" },
    ],
  };
}

function loadSpec(): ProjectSpec {
  const f = path.join(WORK_DIR, "spec.json");
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  const spec = defaultSpec();
  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.writeFileSync(f, JSON.stringify(spec, null, 2), "utf8");
  return spec;
}

async function main() {
  const cmd = process.argv[2] || "run";

  // 创作者平台 Web 服务
  if (cmd === "serve") {
    startServer({
      port: Number(process.env.PORT || 8787),
      host: process.env.HOST || "0.0.0.0",
    });
    return;
  }

  if (cmd === "status") {
    const p = Pipeline.resume(WORK_DIR);
    if (!p) { console.log("无运行记录（先跑 run）"); return; }
    const s = p.getState();
    console.log(JSON.stringify({
      status: s.status, currentChapter: s.currentChapter,
      chapters: s.chapters.map((c) => ({ no: c.no, verdict: c.verdict, attempts: c.attempts })),
      updatedAt: s.updatedAt,
    }, null, 2));
    return;
  }

  if (cmd === "export") {
    const p = Pipeline.resume(WORK_DIR);
    if (!p) { console.log("无运行记录（先跑 run）"); return; }
    const r = exportDraft(p.getState());
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  if (cmd === "publish") {
    // CI 用法：publish <draft.json> <输出目录>  —— 从定稿直接烘焙，不连 MCP
    const draftFile = process.argv[3];
    if (draftFile) {
      const outDir = process.argv[4] || path.join(WORK_DIR, "app");
      const draft = JSON.parse(fs.readFileSync(path.resolve(draftFile), "utf8"));
      const r = publishFromDraft(draft, outDir);
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    // 本地用法：publish —— 从当前 run.json 发布
    const p = Pipeline.resume(WORK_DIR);
    if (!p) { console.log("无运行记录（先跑 run）"); return; }
    const r = publish(p.getState());
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  // run：优先断点续跑，否则新跑
  const p = Pipeline.resume(WORK_DIR) || new Pipeline(loadSpec(), {
    dataDir: WORK_DIR,
    useXiezhi: process.env.NOVEL_FACTORY_NO_XIEZHI !== "1",
    hooks: { onProgress: (m) => console.log(m) },
  });
  const state = await p.start();
  if (state.status === "done") {
    const r = exportDraft(state);
    console.log("定稿导出:", JSON.stringify(r));
  }
}

main().catch((e) => { console.error("流水线失败:", e); process.exit(1); });
