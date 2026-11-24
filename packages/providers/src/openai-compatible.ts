import { estimateMessagesTokens, estimateTokens } from './estimate.ts';
import type {
  ChatMessage,
  ChatRequest,
  ChatResult,
  ExchangeRecord,
  FetchLike,
  ParamFix,
  RequestOptions,
  StreamEvent,
  ToolCall,
  Usage,
} from './types.ts';

/** 模型接口调用失败。message 是给用户看的中文说明。 */
export class ProviderError extends Error {
  readonly status: number | null;
  readonly body: string;
  readonly retryable: boolean;
  readonly aborted: boolean;
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    opts: {
      status?: number | null;
      body?: string;
      retryable?: boolean;
      aborted?: boolean;
      retryAfterMs?: number | null;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = 'ProviderError';
    this.status = opts.status ?? null;
    this.body = opts.body ?? '';
    this.retryable = opts.retryable ?? false;
    this.aborted = opts.aborted ?? false;
    this.retryAfterMs = opts.retryAfterMs ?? null;
  }
}

export interface OpenAICompatibleConfig {
  baseURL: string;
  apiKey?: string;
  headers?: Record<string, string>;
  /** 默认用全局 fetch；桌面端传入 Electron 的 net.fetch 以走系统代理。 */
  fetch?: FetchLike;
  /** 等待响应头、以及流式两个分片之间允许的最长时间。默认 120 秒。 */
  timeoutMs?: number;
  /** 网络错误、429、5xx 的最大重试次数。默认 2。 */
  maxRetries?: number;
  /** 重试的基础等待时间，按指数退避。默认 1000 毫秒。 */
  retryBaseDelayMs?: number;
  /** 每次 HTTP 尝试结束后回调，用于写调用日志。 */
  onExchange?: (record: ExchangeRecord) => void;
}

/** 用户常会把完整地址或带斜杠的地址填进来，统一成不带结尾斜杠、不带 /chat/completions 的形式。 */
export function normalizeBaseURL(input: string): string {
  return input
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/, '')
    .replace(/\/+$/, '');
}

function toWireMessage(m: ChatMessage): Record<string, unknown> {
  const wire: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.name) wire.name = m.name;
  if (m.toolCallId) wire.tool_call_id = m.toolCallId;
  if (m.toolCalls?.length) {
    wire.tool_calls = m.toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: tc.arguments },
    }));
  }
  return wire;
}

/** 构造实际发送的请求体。导出是为了测试和日志。 */
export function buildRequestBody(req: ChatRequest, opts: RequestOptions, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages.map(toWireMessage),
  };
  if (req.temperature !== undefined && !opts.noTemperature) body.temperature = req.temperature;
  if (req.topP !== undefined) body.top_p = req.topP;
  if (req.maxTokens !== undefined) {
    body[opts.useMaxCompletionTokens ? 'max_completion_tokens' : 'max_tokens'] = req.maxTokens;
  }
  const rf = req.responseFormat;
  if (rf && rf.type === 'json_object') body.response_format = { type: 'json_object' };
  if (rf && rf.type === 'json_schema') {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: rf.name, schema: rf.schema, strict: rf.strict ?? true },
    };
  }
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description ?? '', parameters: t.parameters },
    }));
  }
  if (req.toolChoice) {
    body.tool_choice =
      typeof req.toolChoice === 'string'
        ? req.toolChoice
        : { type: 'function', function: { name: req.toolChoice.name } };
  }
  if (req.seed !== undefined) body.seed = req.seed;
  if (req.stop?.length) body.stop = req.stop;
  if (stream) {
    body.stream = true;
    if (opts.streamUsage !== false) body.stream_options = { include_usage: true };
  }
  Object.assign(body, req.extra ?? {});
  return body;
}

/** 从"参数不支持"类错误里判断该怎么修正。 */
export function detectParamFix(
  status: number | null,
  bodyText: string,
  opts: RequestOptions,
  stream: boolean,
): ParamFix | null {
  if (status !== 400 && status !== 422) return null;
  const t = bodyText.toLowerCase();
  if (!opts.useMaxCompletionTokens && t.includes('max_completion_tokens')) return 'useMaxCompletionTokens';
  if (
    !opts.noTemperature &&
    t.includes('temperature') &&
    /(unsupported|not supported|does not support|only the default|only supports)/.test(t)
  ) {
    return 'noTemperature';
  }
  if (stream && opts.streamUsage !== false && t.includes('stream_options')) return 'noStreamUsage';
  return null;
}

function applyFix(opts: RequestOptions, fix: ParamFix): RequestOptions {
  switch (fix) {
    case 'useMaxCompletionTokens':
      return { ...opts, useMaxCompletionTokens: true };
    case 'noTemperature':
      return { ...opts, noTemperature: true };
    case 'noStreamUsage':
      return { ...opts, streamUsage: false };
  }
}

function serverMessage(bodyText: string): string {
  try {
    const json = JSON.parse(bodyText) as { error?: { message?: string } | string; message?: string };
    if (typeof json.error === 'string') return json.error;
    if (json.error?.message) return json.error.message;
    if (json.message) return json.message;
  } catch {
    // 不是 JSON
  }
  return bodyText.slice(0, 300);
}

export function describeHttpError(status: number, bodyText: string): string {
  const detail = serverMessage(bodyText);
  const hint =
    status === 401
      ? 'API Key 无效或缺失'
      : status === 403
        ? '没有权限访问'
        : status === 404
          ? '接口地址或模型不存在，检查 Base URL（很多服务需要以 /v1 结尾）和模型名'
          : status === 429
            ? '请求过于频繁或额度不足'
            : status >= 500
              ? '服务端出错'
              : '请求被拒绝';
  return `${hint}（HTTP ${status}）${detail ? `：${detail}` : ''}`;
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

export function parseRetryAfter(res: Response): number | null {
  const v = res.headers.get('retry-after');
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.min(secs * 1000, 20_000);
  return null;
}

function abortedError(): ProviderError {
  return new ProviderError('已取消', { aborted: true });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortedError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortedError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
  completion_tokens_details?: { reasoning_tokens?: number } | null;
}

function toUsage(raw: RawUsage | null | undefined, messages: ChatMessage[], outputText: string): Usage {
  if (raw && typeof raw.prompt_tokens === 'number') {
    return {
      inputTokens: raw.prompt_tokens,
      outputTokens: raw.completion_tokens ?? 0,
      cachedInputTokens: raw.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens ?? 0,
      reasoningTokens: raw.completion_tokens_details?.reasoning_tokens ?? 0,
      estimated: false,
    };
  }
  return {
    inputTokens: estimateMessagesTokens(messages),
    outputTokens: estimateTokens(outputText),
    cachedInputTokens: 0,
    reasoningTokens: 0,
    estimated: true,
  };
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'object' && part && 'text' in part ? String((part as { text: unknown }).text) : ''))
      .join('');
  }
  return '';
}

/** 逐行读取 SSE，每个 data 行单独产出（OpenAI 风格的服务都不会把一个 JSON 拆成多行）。 */
async function* readSSE(
  body: ReadableStream<Uint8Array>,
  idleMs: number,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const takeLine = (line: string): string | null => {
    if (!line.startsWith('data:')) return null;
    return line.slice(5).replace(/^ /, '');
  };
  try {
    while (true) {
      const { done, value } = await readWithTimeout(reader, idleMs, signal);
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.search(/\r?\n/)) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + (buf[idx] === '\r' ? 2 : 1));
        const data = takeLine(line);
        if (data !== null) yield data;
      }
    }
    buf += decoder.decode();
    const data = takeLine(buf.trim());
    if (data !== null) yield data;
  } finally {
    reader.cancel().catch(() => {});
  }
}

function readWithTimeout<T>(
  reader: ReadableStreamDefaultReader<T>,
  ms: number,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<T>> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortedError());
    const timer = setTimeout(
      () => reject(new ProviderError(`流式响应超过 ${Math.round(ms / 1000)} 秒没有新数据`)),
      ms,
    );
    const onAbort = () => reject(abortedError());
    signal?.addEventListener('abort', onAbort, { once: true });
    reader
      .read()
      .then(resolve, reject)
      .finally(() => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      });
  });
}

interface ToolAcc {
  id: string;
  name: string;
  arguments: string;
}

/** OpenAI 兼容接口的客户端。直接基于 fetch，方便完整记录请求与响应、逐项探测能力。 */
export class OpenAICompatibleClient {
  readonly baseURL: string;
  private readonly apiKey: string | undefined;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly onExchange: ((record: ExchangeRecord) => void) | undefined;

  constructor(cfg: OpenAICompatibleConfig) {
    this.baseURL = normalizeBaseURL(cfg.baseURL);
    this.apiKey = cfg.apiKey || undefined;
    this.headers = cfg.headers ?? {};
    this.fetchImpl = cfg.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = cfg.timeoutMs ?? 120_000;
    this.maxRetries = cfg.maxRetries ?? 2;
    this.retryBaseDelayMs = cfg.retryBaseDelayMs ?? 1000;
    this.onExchange = cfg.onExchange;
  }

  private buildHeaders(stream: boolean): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: stream ? 'text/event-stream' : 'application/json',
      ...this.headers,
    };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  /**
   * 发出请求并等到响应头。超时只覆盖"等响应头"这一段；
   * 返回的 signal 仍与调用方的 signal 相连，用于中止后续的流式读取。
   */
  private async request(
    url: string,
    init: { method: string; body?: string; stream: boolean },
    signal?: AbortSignal,
  ): Promise<Response> {
    if (signal?.aborted) throw abortedError();
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, this.timeoutMs);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: init.method,
        headers: this.buildHeaders(init.stream),
        body: init.body,
        signal: ctrl.signal,
      });
    } catch (err) {
      if (signal?.aborted) throw abortedError();
      if (timedOut) {
        throw new ProviderError(`等待响应超过 ${Math.round(this.timeoutMs / 1000)} 秒`, { retryable: true, cause: err });
      }
      const code = (err as { cause?: { code?: string } }).cause?.code;
      const hint = code === 'ECONNREFUSED' ? '，服务是否已经启动？' : '';
      throw new ProviderError(`无法连接到 ${this.baseURL}${code ? `（${code}）` : ''}${hint}`, {
        retryable: true,
        cause: err,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      signal?.removeEventListener('abort', onAbort);
      const text = await res.text().catch(() => '');
      throw new ProviderError(describeHttpError(res.status, text), {
        status: res.status,
        body: text,
        retryable: isRetryableStatus(res.status),
        retryAfterMs: parseRetryAfter(res),
      });
    }
    return res;
  }

  private retryDelay(retry: number, err: ProviderError): number {
    if (err.retryAfterMs !== null) return err.retryAfterMs;
    return this.retryBaseDelayMs * 2 ** (retry - 1) * (0.8 + Math.random() * 0.4);
  }

  private emit(record: ExchangeRecord): void {
    try {
      this.onExchange?.(record);
    } catch {
      // 日志回调出错不能影响调用本身
    }
  }

  /** 拉取模型列表（GET /models）。 */
  async listModels(signal?: AbortSignal): Promise<string[]> {
    const res = await this.request(`${this.baseURL}/models`, { method: 'GET', stream: false }, signal);
    const json = (await res.json()) as { data?: { id?: string }[]; models?: { id?: string; name?: string }[] };
    const items = json.data ?? json.models ?? [];
    const ids = items.map((m) => m.id ?? (m as { name?: string }).name ?? '').filter(Boolean);
    return [...new Set(ids)].sort();
  }

  /** 非流式对话。 */
  async chat(req: ChatRequest, options: RequestOptions = {}): Promise<ChatResult> {
    let opts = { ...options };
    const fixes: ParamFix[] = [];
    let retries = 0;
    for (let attempt = 1; ; attempt++) {
      const body = buildRequestBody(req, opts, false);
      const url = `${this.baseURL}/chat/completions`;
      const startedAt = Date.now();
      let httpStatus: number | null = null;
      try {
        const res = await this.request(url, { method: 'POST', body: JSON.stringify(body), stream: false }, opts.signal);
        httpStatus = res.status;
        const text = await res.text();
        let json: Record<string, unknown>;
        try {
          json = JSON.parse(text) as Record<string, unknown>;
        } catch {
          throw new ProviderError(`接口返回的不是 JSON：${text.slice(0, 200)}`, { status: res.status, body: text });
        }
        const result = this.parseCompletion(json, req, startedAt, fixes);
        this.emit({
          kind: 'chat', url, request: body, status: 'ok', httpStatus, result, partialText: '',
          error: null, startedAt, latencyMs: result.latencyMs, ttftMs: null, attempt,
        });
        return result;
      } catch (err) {
        const pe = err instanceof ProviderError ? err : new ProviderError(String(err), { cause: err });
        this.emit({
          kind: 'chat', url, request: body, status: pe.aborted ? 'aborted' : 'error',
          httpStatus: pe.status ?? httpStatus, result: null, partialText: '', error: pe.message,
          startedAt, latencyMs: Date.now() - startedAt, ttftMs: null, attempt,
        });
        if (pe.aborted) throw pe;
        const fix = opts.autoFixParams !== false ? detectParamFix(pe.status, pe.body, opts, false) : null;
        if (fix && !fixes.includes(fix)) {
          fixes.push(fix);
          opts = applyFix(opts, fix);
          continue;
        }
        if (pe.retryable && retries < this.maxRetries) {
          retries++;
          await sleep(this.retryDelay(retries, pe), opts.signal);
          continue;
        }
        throw pe;
      }
    }
  }

  private parseCompletion(
    json: Record<string, unknown>,
    req: ChatRequest,
    startedAt: number,
    fixes: ParamFix[],
  ): ChatResult {
    if (json.error) {
      throw new ProviderError(`接口返回错误：${serverMessage(JSON.stringify(json))}`, { body: JSON.stringify(json) });
    }
    const choices = (json.choices as Record<string, unknown>[] | undefined) ?? [];
    const choice = choices[0] ?? {};
    const msg = (choice.message as Record<string, unknown> | undefined) ?? {};
    const text = contentToText(msg.content);
    const reasoning = String(msg.reasoning_content ?? msg.reasoning ?? '');
    const rawCalls = (msg.tool_calls as { id?: string; function?: { name?: string; arguments?: string } }[]) ?? [];
    const toolCalls: ToolCall[] = rawCalls.map((tc, i) => ({
      id: tc.id ?? `call_${i}`,
      name: tc.function?.name ?? '',
      arguments: tc.function?.arguments ?? '',
    }));
    return {
      text,
      reasoning,
      toolCalls,
      finishReason: (choice.finish_reason as string | null | undefined) ?? null,
      usage: toUsage(json.usage as RawUsage | undefined, req.messages, text + reasoning),
      model: (json.model as string | undefined) ?? null,
      latencyMs: Date.now() - startedAt,
      ttftMs: null,
      fixes: [...fixes],
    };
  }

  /**
   * 流式对话。逐个产出增量事件，生成器的返回值是完整结果。
   * 在收到响应头之前出错会按规则重试或自动修正参数；开始输出之后不再重试。
   */
  async *chatStream(req: ChatRequest, options: RequestOptions = {}): AsyncGenerator<StreamEvent, ChatResult> {
    let opts = { ...options };
    const fixes: ParamFix[] = [];
    let retries = 0;
    const url = `${this.baseURL}/chat/completions`;

    let res: Response | undefined;
    let body: Record<string, unknown> = {};
    let startedAt = Date.now();
    let attempt = 0;
    while (!res) {
      attempt++;
      body = buildRequestBody(req, opts, true);
      startedAt = Date.now();
      try {
        res = await this.request(url, { method: 'POST', body: JSON.stringify(body), stream: true }, opts.signal);
      } catch (err) {
        const pe = err instanceof ProviderError ? err : new ProviderError(String(err), { cause: err });
        this.emit({
          kind: 'chat_stream', url, request: body, status: pe.aborted ? 'aborted' : 'error', httpStatus: pe.status,
          result: null, partialText: '', error: pe.message, startedAt, latencyMs: Date.now() - startedAt,
          ttftMs: null, attempt,
        });
        if (pe.aborted) throw pe;
        const fix = opts.autoFixParams !== false ? detectParamFix(pe.status, pe.body, opts, true) : null;
        if (fix && !fixes.includes(fix)) {
          fixes.push(fix);
          opts = applyFix(opts, fix);
          continue;
        }
        if (pe.retryable && retries < this.maxRetries) {
          retries++;
          await sleep(this.retryDelay(retries, pe), opts.signal);
          continue;
        }
        throw pe;
      }
    }

    const httpStatus = res.status;
    let text = '';
    let reasoning = '';
    let finishReason: string | null = null;
    let rawUsage: RawUsage | null = null;
    let model: string | null = null;
    let ttftMs: number | null = null;
    const tools = new Map<number, ToolAcc>();
    let settled = false;

    const partialResult = (): ChatResult => ({
      text,
      reasoning,
      toolCalls: [...tools.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => ({ ...t })),
      finishReason,
      usage: toUsage(rawUsage, req.messages, text + reasoning),
      model,
      latencyMs: Date.now() - startedAt,
      ttftMs,
      fixes: [...fixes],
    });

    const fail = (err: unknown): ProviderError => {
      const aborted = opts.signal?.aborted ?? false;
      const pe =
        err instanceof ProviderError
          ? err
          : aborted
            ? abortedError()
            : new ProviderError(`读取流式响应失败：${String(err)}`, { cause: err });
      settled = true;
      this.emit({
        kind: 'chat_stream', url, request: body, status: pe.aborted ? 'aborted' : 'error', httpStatus,
        result: partialResult(), partialText: text, error: pe.message, startedAt,
        latencyMs: Date.now() - startedAt, ttftMs, attempt,
      });
      return pe;
    };

    if (!res.body) throw fail(new ProviderError('接口没有返回响应体'));

    let completed = false;
    try {
      for await (const data of readSSE(res.body, this.timeoutMs, opts.signal)) {
        if (data === '[DONE]') break;
        let json: Record<string, unknown>;
        try {
          json = JSON.parse(data) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (json.error) {
          throw new ProviderError(`接口返回错误：${serverMessage(data)}`, { body: data });
        }
        if (typeof json.model === 'string') model = json.model;
        if (json.usage) rawUsage = json.usage as RawUsage;
        const choice = (json.choices as Record<string, unknown>[] | undefined)?.[0];
        if (!choice) continue;
        const delta = (choice.delta as Record<string, unknown> | undefined) ?? {};
        const content = contentToText(delta.content);
        if (content) {
          ttftMs ??= Date.now() - startedAt;
          text += content;
          yield { type: 'text', delta: content };
        }
        const r = delta.reasoning_content ?? delta.reasoning;
        if (typeof r === 'string' && r) {
          ttftMs ??= Date.now() - startedAt;
          reasoning += r;
          yield { type: 'reasoning', delta: r };
        }
        const calls = delta.tool_calls as
          | { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]
          | undefined;
        if (Array.isArray(calls)) {
          for (const tc of calls) {
            const index = tc.index ?? 0;
            const acc = tools.get(index) ?? { id: '', name: '', arguments: '' };
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name += tc.function.name;
            if (tc.function?.arguments) acc.arguments += tc.function.arguments;
            tools.set(index, acc);
            ttftMs ??= Date.now() - startedAt;
            yield { type: 'tool_call', index, id: tc.id, name: tc.function?.name, argumentsDelta: tc.function?.arguments };
          }
        }
        if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
      }
      completed = true;
    } catch (err) {
      throw fail(err);
    } finally {
      // 调用方提前停止迭代（break / return）时会直接走到这里，按中止记录
      if (!completed && !settled) fail(abortedError());
    }

    for (const [i, t] of tools) if (!t.id) t.id = `call_${i}`;
    const result = partialResult();
    settled = true;
    this.emit({
      kind: 'chat_stream', url, request: body, status: 'ok', httpStatus, result, partialText: '',
      error: null, startedAt, latencyMs: result.latencyMs, ttftMs, attempt,
    });
    return result;
  }
}
