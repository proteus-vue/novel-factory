/**
 * 写稿模型客户端：OpenAI Chat Completions 兼容端点。
 * 配置来自环境变量；无 baseURL/key 时自动进入 mock 模式（确定性模板），便于无密钥验证流水线闭环。
 */
export interface LlmConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
}

export function loadLlmConfig(): LlmConfig {
  const baseURL = (process.env.NOVEL_LLM_BASE_URL || "").replace(/\/$/, "");
  return {
    baseURL,
    apiKey: process.env.NOVEL_LLM_API_KEY || "",
    model: process.env.NOVEL_LLM_MODEL || "gpt-4o-mini",
    temperature: Number(process.env.NOVEL_LLM_TEMPERATURE ?? "0.85"),
    maxTokens: Number(process.env.NOVEL_LLM_MAX_TOKENS ?? "4096"),
    timeoutMs: Number(process.env.NOVEL_LLM_TIMEOUT_MS ?? "120000"),
  };
}

export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }

export interface LlmClient {
  readonly mock: boolean;
  chat(messages: ChatMessage[]): Promise<string>;
}

/** 真实 OpenAI 兼容客户端 */
class HttpLlmClient implements LlmClient {
  readonly mock = false;
  constructor(private cfg: LlmConfig) {}
  async chat(messages: ChatMessage[]): Promise<string> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs);
    try {
      const resp = await fetch(`${this.cfg.baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: this.cfg.model,
          messages,
          temperature: this.cfg.temperature,
          max_tokens: this.cfg.maxTokens,
        }),
        signal: ctrl.signal,
      });
      if (!resp.ok) {
        throw new Error(`LLM HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
      }
      const data: any = await resp.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error("LLM 返回无 choices[0].message.content");
      return content;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Mock 客户端：从 system/user prompt 里抽章节号，生成确定性的"正文"，用于无密钥跑通闭环 */
class MockLlmClient implements LlmClient {
  readonly mock = true;
  private seq = 0;
  async chat(messages: ChatMessage[]): Promise<string> {
    const user = messages.map((m) => m.content).join("\n");
    const chMatch = user.match(/第\s*(\d+)\s*章/);
    const ch = chMatch ? Number(chMatch[1]) : ++this.seq;
    const cn = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
    const cnNum = (n: number) => n < 10 ? cn[n] : n < 20 ? "十" + (n % 10 ? cn[n % 10] : "") : String(n); // 避免裸数字，TTS 友好
    // 重写时针对打回意见收敛：去掉括号段 + 用中文数字
    const isRewrite = /重写|打回|避免|must_avoid|括号|TTS/i.test(user);
    const paras = [
      `第${cnNum(ch)}章鉴定开始了。`,
      `“准备好了吗？”他盯着面前泛着冷光的检测台，指节微微收紧。`,
      `${isRewrite ? "这一次他学会了隐藏锋芒，不再多说一个字。" : "周围很安静，只有仪器低低的嗡鸣。"}`,
      `他深吸一口气把手按了上去，屏幕亮起的瞬间所有人都愣住了。`,
    ];
    // 重写模式下绝不带括号尾注（大禹 TTS 红线：括号大段/尾注）
    return paras.join("\n\n");
  }
}

export function createLlmClient(cfg: LlmConfig): LlmClient {
  if (!cfg.baseURL || !cfg.apiKey) return new MockLlmClient();
  return new HttpLlmClient(cfg);
}
