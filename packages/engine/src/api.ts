/**
 * 引擎对外提供的接口契约。界面进程只依赖这个文件里的类型（和 rpc），不会把引擎实现打包进去。
 */
import type { ChatMessage, ProbeStep, StreamEvent, ToolCall, Usage } from '@auto-adv/providers';
import type { AppSettings, Capabilities, Endpoint, RoleId, RoleRoute } from '@auto-adv/schema';
import type { Streaming, Unary } from './rpc/index.ts';

export interface EndpointView extends Endpoint {
  /** 是否已保存 API Key（密钥本身永远不会发给界面）。 */
  hasKey: boolean;
}

export interface SettingsView {
  endpoints: EndpointView[];
  roles: AppSettings['roles'];
  /** 密钥是否用系统加密保存。false 表示当前系统不支持，只能明文保存。 */
  secretsEncrypted: boolean;
  dataDir: string;
}

export interface SaveEndpointParams {
  /** 不填表示新建。 */
  id?: string;
  name: string;
  baseURL: string;
  models: string[];
  defaultModel?: string;
  headers?: Record<string, string>;
  currency: Endpoint['currency'];
  pricing: Endpoint['pricing'];
  /** undefined：保持不变；null：删除；字符串：设置为新值。 */
  apiKey?: string | null;
}

export interface FetchModelsParams {
  /** 已保存的接入点；和下面的字段同时给时，下面的字段优先（用于编辑中尚未保存的表单）。 */
  endpointId?: string;
  baseURL?: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

export interface ProbeChunk {
  step: ProbeStep;
  ok: boolean;
  note?: string;
}

export type ChatTarget = { role: RoleId } | { endpointId: string; model: string };

export interface PlaygroundChatParams {
  target: ChatTarget;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** 默认 true；模型不支持流式时自动退回非流式。 */
  stream?: boolean;
}

export interface PlaygroundResult {
  callId: string | null;
  text: string;
  reasoning: string;
  usage: Usage;
  cost: number | null;
  currency: Endpoint['currency'];
  latencyMs: number;
  ttftMs: number | null;
  model: string;
  endpointName: string;
}

export interface CallSummary {
  id: string;
  ts: number;
  role: string;
  endpointId: string;
  endpointName: string;
  model: string;
  kind: string;
  status: 'ok' | 'error' | 'aborted';
  latencyMs: number;
  ttftMs: number | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  estimated: boolean;
  cost: number | null;
  currency: string;
  error: string | null;
  /** 回复的前 80 个字。 */
  preview: string;
}

export interface CallDetail extends CallSummary {
  url: string;
  httpStatus: number | null;
  attempt: number;
  request: unknown;
  responseText: string;
  reasoning: string;
  toolCalls: ToolCall[];
}

export interface UsageSummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costs: { currency: string; total: number }[];
}

export interface PingResult {
  engineVersion: string;
  node: string;
  dataDir: string;
}

export type EngineContract = {
  ping: Unary<void, PingResult>;
  getSettings: Unary<void, SettingsView>;
  saveEndpoint: Unary<SaveEndpointParams, EndpointView>;
  deleteEndpoint: Unary<{ id: string }, void>;
  fetchModels: Unary<FetchModelsParams, string[]>;
  probe: Streaming<{ endpointId: string; model: string }, ProbeChunk, Capabilities>;
  setRole: Unary<{ role: RoleId; route: RoleRoute | null }, void>;
  chat: Streaming<PlaygroundChatParams, StreamEvent, PlaygroundResult>;
  listCalls: Unary<{ limit?: number; offset?: number }, { items: CallSummary[]; total: number }>;
  getCall: Unary<{ id: string }, CallDetail | null>;
  clearCalls: Unary<void, void>;
  usageSummary: Unary<void, UsageSummary>;
};

/**
 * 宿主（Electron 主进程）提供给引擎的接口。
 * 引擎进程里拿不到 safeStorage，所以加解密交给主进程。
 */
export type HostContract = {
  isEncryptionAvailable: Unary<void, boolean>;
  encrypt: Unary<{ plain: string }, string>;
  decrypt: Unary<{ cipher: string }, string>;
};
