/**
 * 大模型客户端
 *
 * 只做一件事：把 messages（可带 tools）发出去，流式收回来，
 * 同时把内容增量和 tool_calls 增量都正确拼装。
 *
 * 兼容任何 OpenAI 格式的端点（DeepSeek / Moonshot / 本地 vLLM 等）。
 */

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ChatOptions {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  /** 正文增量回调，用于实时渲染 */
  onDelta?: (text: string) => void;
  /** 工具调用开始时的回调（拿到工具名和参数片段） */
  onToolCall?: (name: string, rawArgs: string) => void;
  signal?: AbortSignal;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string;
}

const FIRST_BYTE_TIMEOUT = 60000;
const IDLE_TIMEOUT = 90000;

interface DeltaToolCall {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface StreamChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: DeltaToolCall[];
    };
    finish_reason?: string;
  }>;
}

/**
 * 发起一次对话。流式读取，边收边回调。
 * 端点若返回非 SSE（个别兼容层不支持流式），自动退回整体解析。
 */
export async function chat(cfg: LlmConfig, opts: ChatOptions): Promise<ChatResult> {
  if (!cfg.apiKey) throw new Error('缺少 API Key');

  const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';

  const body: Record<string, unknown> = {
    model: cfg.model || 'deepseek-chat',
    messages: opts.messages,
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.maxTokens ?? 4000,
    stream: true,
  };
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools;
    body.tool_choice = 'auto';
  }

  const ctrl = new AbortController();
  let idleTimer = 0;
  const arm = (ms: number): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ctrl.abort(), ms);
  };
  const disarm = (): void => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = 0;
    }
  };

  if (opts.signal) {
    if (opts.signal.aborted) throw new Error('已取消');
    opts.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }

  arm(FIRST_BYTE_TIMEOUT);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + cfg.apiKey,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    disarm();
    const err = e as Error;
    if (err.name === 'AbortError') throw new Error('连接超时 60 秒 请检查网络或接口地址');
    throw new Error('网络请求失败：' + err.message);
  }

  if (!res.ok) {
    disarm();
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      /* ignore */
    }
    const hint =
      res.status === 401
        ? 'API Key 无效'
        : res.status === 402
          ? '账户余额不足'
          : res.status === 429
            ? '请求过于频繁'
            : res.status === 400
              ? '请求参数有误（可能是该端点不支持 tools）'
              : '';
    throw new Error(`HTTP ${res.status}${hint ? '（' + hint + '）' : ''}：${detail}`);
  }

  const ctype = (res.headers.get('content-type') ?? '').toLowerCase();

  /* ---------------- 非流式兜底 ---------------- */
  if (!res.body || !res.body.getReader || !ctype.includes('event-stream')) {
    disarm();
    const data = (await res.json()) as {
      choices?: Array<{
        message?: { content?: string; tool_calls?: ToolCall[] };
        finish_reason?: string;
      }>;
    };
    const msg = data.choices?.[0]?.message;
    return {
      content: msg?.content ?? '',
      toolCalls: msg?.tool_calls ?? [],
      finishReason: data.choices?.[0]?.finish_reason ?? 'stop',
    };
  }

  /* ---------------- 流式解析 ---------------- */
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let finishReason = 'stop';
  const pending = new Map<number, { id: string; name: string; args: string }>();
  let done = false;

  arm(IDLE_TIMEOUT);

  try {
    while (!done) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });

      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');

        if (!line || !line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          done = true;
          break;
        }

        let chunk: StreamChunk;
        try {
          chunk = JSON.parse(payload) as StreamChunk;
        } catch {
          continue;
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;

        const piece = choice.delta?.content;
        if (piece) {
          content += piece;
          opts.onDelta?.(piece);
        }

        const tcs = choice.delta?.tool_calls;
        if (tcs) {
          for (const tc of tcs) {
            const idx = tc.index ?? 0;
            const cur = pending.get(idx) ?? { id: '', name: '', args: '' };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name = tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
            pending.set(idx, cur);
            if (cur.name && cur.args) opts.onToolCall?.(cur.name, cur.args);
          }
        }
      }

      if (!done) arm(IDLE_TIMEOUT);
    }
  } catch (e) {
    disarm();
    const err = e as Error;
    if (err.name === 'AbortError') throw new Error('生成中断 90 秒没有新内容');
    throw new Error('读取响应失败：' + err.message);
  } finally {
    disarm();
  }

  if (done) {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }

  const toolCalls: ToolCall[] = Array.from(pending.entries())
    .sort((a, b) => a[0] - b[0])
    .filter(([, v]) => v.name)
    .map(([, v]) => ({
      id: v.id || `call_${v.name}_${Date.now()}`,
      type: 'function' as const,
      function: { name: v.name, arguments: v.args || '{}' },
    }));

  if (toolCalls.length > 0) finishReason = 'tool_calls';

  return { content, toolCalls, finishReason };
}

/** 把工具调用结果包成一条 tool 消息 */
export function toolResultMessage(callId: string, content: string): ChatMessage {
  return { role: 'tool', tool_call_id: callId, content };
}
