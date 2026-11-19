export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  /** 模型给出的参数，原样保留的 JSON 字符串。 */
  arguments: string;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ToolDef {
  name: string;
  description?: string;
  /** JSON Schema */
  parameters: Record<string, unknown>;
}

export type ResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | { type: 'json_schema'; name: string; schema: Record<string, unknown>; strict?: boolean };

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  responseFormat?: ResponseFormat;
  tools?: ToolDef[];
  toolChoice?: 'auto' | 'none' | 'required' | { name: string };
  seed?: number;
  stop?: string[];
  /** 透传给接口的额外字段（各家私有参数）。 */
  extra?: Record<string, unknown>;
}

/** 按模型能力调整请求参数。通常来自能力探测结果。 */
export interface RequestOptions {
  signal?: AbortSignal;
  /** 用 max_completion_tokens 代替 max_tokens。 */
  useMaxCompletionTokens?: boolean;
  /** 不发送 temperature。 */
  noTemperature?: boolean;
  /** 流式请求时附带 stream_options.include_usage（默认 true）。 */
  streamUsage?: boolean;
  /** 遇到"参数不支持"类 400 错误时自动修正并重试一次（默认 true）。 */
  autoFixParams?: boolean;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  /** 接口没返回用量时按字数估算，此时为 true。 */
  estimated: boolean;
}

export interface ChatResult {
  text: string;
  /** 推理内容（DeepSeek 的 reasoning_content 等），没有则为空串。 */
  reasoning: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage: Usage;
  /** 接口实际返回的模型名。 */
  model: string | null;
  latencyMs: number;
  /** 首个 token 到达的耗时，非流式为 null。 */
  ttftMs: number | null;
  /** 本次自动修正过的参数，如 "useMaxCompletionTokens"。调用方可以把它记进能力配置。 */
  fixes: ParamFix[];
}

export type ParamFix = 'useMaxCompletionTokens' | 'noTemperature' | 'noStreamUsage';

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool_call'; index: number; id?: string; name?: string; argumentsDelta?: string };

/** 每次 HTTP 尝试结束后的完整记录，用于调用日志。不包含任何密钥。 */
export interface ExchangeRecord {
  kind: 'chat' | 'chat_stream';
  url: string;
  request: Record<string, unknown>;
  status: 'ok' | 'error' | 'aborted';
  httpStatus: number | null;
  /** 成功时的结果；中止或出错时为已经收到的部分。 */
  result: ChatResult | null;
  partialText: string;
  error: string | null;
  startedAt: number;
  latencyMs: number;
  ttftMs: number | null;
  attempt: number;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
