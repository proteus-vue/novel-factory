/**
 * 通用 MCP stdio client：启动一个 MCP server 子进程，做 initialize 握手，
 * 之后用 JSON-RPC 调 tools/call。逐行读 stdout（换行分隔的 JSON），带 id 匹配与超时。
 * 大禹(node) 与獬豸(python) 都用它连，屏蔽语言差异。
 */
import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";

export interface ToolResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  [k: string]: unknown;
}

export interface ToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

const TIMEOUT_MS = 60_000;

export class McpClient {
  private proc: ChildProcess;
  private pending = new Map<number, (msg: any) => void>();
  private nextId = 1;
  private buffer = "";
  private toolsCache?: ToolDef[];
  readonly name: string;

  constructor(name: string, command: string, args: string[], opts: {
    cwd?: string;
    env?: Record<string, string>;
  } = {}) {
    this.name = name;
    this.proc = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env || {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    // stderr 收集用于排错，不混入协议
    let err = "";
    this.proc.stderr?.on("data", (d) => { err += d.toString(); if (err.length > 4000) err = err.slice(-4000); });
    (this.proc as any)._stderr = () => err;
    // 关键：spawn 失败（如命令不存在 ENOENT）会触发 error 事件；不监听会冒泡成未捕获异常，
    // 直接终止整个宿主进程。这里吞掉并记录，让上层 connect() 的 rpc 超时后走降级逻辑。
    this.proc.on("error", (e) => {
      err += `\n[spawn error] ${(e as Error).message}`;
      (this.proc as any)._spawnFailed = true;
    });

    const rl = readline.createInterface({ input: this.proc.stdout! });
    rl.on("line", (line) => {
      const s = line.trim();
      if (!s) return;
      let msg: any;
      try { msg = JSON.parse(s); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)!(msg);
        this.pending.delete(msg.id);
      }
    });
  }

  private rpc(method: string, params: unknown, timeoutMs = TIMEOUT_MS): Promise<any> {
    const id = this.nextId++;
    // spawn 失败或进程已退出时快速失败，避免每次 rpc 都空等 60s 超时
    if ((this.proc as any)._spawnFailed || this.proc.exitCode !== null || this.proc.killed) {
      return Promise.reject(new Error(`[${this.name}] 子进程不可用（spawn 失败或已退出）`));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`[${this.name}] ${method} 超时 ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(`[${this.name}] ${method} 错误: ${JSON.stringify(msg.error)}`));
        else resolve(msg.result);
      });
      this.proc.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  /** MCP 握手：initialize + initialized 通知；timeoutMs 用于可选 MCP 快速降级 */
  async connect(timeoutMs = TIMEOUT_MS): Promise<void> {
    await this.rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "novel-factory", version: "0.1.0" },
    }, timeoutMs);
    this.proc.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }

  async listTools(): Promise<ToolDef[]> {
    if (this.toolsCache) return this.toolsCache;
    const r = await this.rpc("tools/list", {});
    this.toolsCache = (r?.tools || []) as ToolDef[];
    return this.toolsCache;
  }

  /** 取 MCP Prompt（如大禹的 build_system_prompt），返回首条文本内容 */
  async getPrompt(name: string, args: Record<string, string> = {}): Promise<string | null> {
    const r: any = await this.rpc("prompts/get", { name, arguments: args });
    const text = r?.messages?.[0]?.content?.text;
    return text == null ? null : String(text);
  }

  /** 调一个工具，返回解析后的 JSON（若 content 是 JSON 文本则自动 parse） */
  async callTool(name: string, args: Record<string, unknown>): Promise<any> {
    const r: ToolResult = await this.rpc("tools/call", { name, arguments: args });
    const text = r.content?.find((c) => c.type === "text")?.text;
    if (r.isError) {
      throw new Error(`[${this.name}] ${name} 调用失败: ${text || JSON.stringify(r)}`);
    }
    if (text == null) return r;
    try { return JSON.parse(text); } catch { return { text }; }
  }

  close(): void {
    try { this.proc.stdin?.end(); } catch { /* noop */ }
    try { this.proc.kill(); } catch { /* noop */ }
  }

  stderr(): string { return (this.proc as any)._stderr?.() || ""; }
}
