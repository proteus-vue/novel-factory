import { describe, it, expect, beforeEach } from "vitest";

// 内存版 localStorage / sessionStorage，供浏览器端 pipeline 使用
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  get length() { return this.m.size; }
}
const ls = new MemStorage();
const ss = new MemStorage();
(globalThis as any).localStorage = ls;
(globalThis as any).sessionStorage = ss;

const P = await import("../src/console/pipeline.js");

function seed() {
  ls.clear(); ss.clear();
  P.saveSettings({ baseURL: "", apiKey: "k", model: "m", reduceMotion: true });
  const w = P.createWork({ 书名: "测试书", 章节数: 3 });
  w.chapters = [{ no: 1, text: "正文" }, { no: 2, text: "正文" }];
  ls.setItem("novelfactory.works.v1", JSON.stringify([w]));
  ls.setItem("novelfactory.profile.v1", JSON.stringify({ xp: 60, achievements: ["a1"] }));
  ls.setItem("novelfactory.onboarded.v1", "1");
}

describe("浏览器端数据管理", () => {
  beforeEach(seed);

  it("备份组装包含作品/设置/档案与版本标记", () => {
    const b = P.buildBackup();
    expect(b.app).toBe("novel-factory");
    expect(b.format).toBe(P.BACKUP_FORMAT);
    expect(b.data.works.length).toBe(1);
    expect(b.data.settings.reduceMotion).toBe(true);
    expect(b.data.profile.xp).toBe(60);
    expect(b.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  it("校验：合法备份通过并给出规模摘要", () => {
    const v = P.validateBackup(P.buildBackup());
    expect(v.ok).toBe(true);
    expect(v.summary?.works).toBe(1);
    expect(v.summary?.chapters).toBe(2);
  });

  it("校验：拒绝非本 App / 格式不符 / 结构缺失的文件", () => {
    expect(P.validateBackup(null).ok).toBe(false);
    expect(P.validateBackup({ app: "other", format: 1, data: {} }).ok).toBe(false);
    expect(P.validateBackup({ app: "novel-factory", format: 99, data: {} }).ok).toBe(false);
    expect(P.validateBackup({ app: "novel-factory", format: 1, data: {} }).ok).toBe(false);
  });

  it("备份→清空→恢复 往返数据一致", () => {
    const backup = P.buildBackup();
    P.clearWorks();
    expect(P.loadWorks().length).toBe(0);
    expect(P.loadSettings().reduceMotion).toBe(true); // 设置保留
    P.restoreBackup(backup);
    expect(P.loadWorks().length).toBe(1);
    expect(P.loadWorks()[0].chapters.length).toBe(2);
  });

  it("恢复出厂清除全部数据键与一次性标记", () => {
    P.resetAllData();
    expect(P.loadWorks().length).toBe(0);
    expect(ls.getItem("novelfactory.onboarded.v1")).toBeNull();
    expect(ls.getItem("novelfactory.profile.v1")).toBeNull();
  });

  it("占用统计给出作品数、章节数与空间字符串", () => {
    const s = P.storageStats();
    expect(s.works).toBe(1);
    expect(s.chapters).toBe(2);
    expect(s.bytes).toBeGreaterThan(0);
    expect(s.size).toMatch(/(B|KB|MB)$/);
  });
});
