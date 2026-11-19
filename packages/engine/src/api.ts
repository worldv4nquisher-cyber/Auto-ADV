/**
 * 引擎对外提供的接口契约。界面进程只依赖这个文件里的类型（和 rpc），不会把引擎实现打包进去。
 */
import type { ChatMessage, ProbeStep, StreamEvent, ToolCall, Usage } from '@auto-adv/providers';
import type {
  AppSettings,
  Capabilities,
  Character,
  Endpoint,
  GenesisPresetId,
  GenesisStepId,
  GenesisStepState,
  Location,
  LoreEntry,
  PlayMode,
  RoleId,
  RoleRoute,
  StoryOpening,
  StyleGuide,
  WorldBrief,
  WorldManifest,
} from '@auto-adv/schema';
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
  tag: string | null;
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

// ───────────── 世界与创世 ─────────────

export interface WorldSummary {
  id: string;
  title: string;
  logline: string;
  genre: string;
  status: WorldManifest['status'];
  createdAt: string;
  updatedAt: string;
  characterCount: number;
  steps: Partial<Record<GenesisStepId, GenesisStepState>>;
  /** 引擎里正在为它跑创世管线。 */
  running: boolean;
}

export interface WorldDetail {
  summary: WorldSummary;
  manifest: WorldManifest;
  brief: WorldBrief | null;
  style: StyleGuide | null;
  /** 世界观正文（Markdown）。 */
  worldview: string;
  characters: Character[];
  locations: Location[];
  lore: LoreEntry[];
  opening: StoryOpening | null;
}

/** "更多世界选项"。都可以不填，留给 AI。 */
export interface GenesisOptions {
  /** 除主角外的角色数量，默认 3。 */
  characterCount?: number;
  protagonistName?: string;
  protagonistDescription?: string;
  rating?: WorldBrief['rating'];
  /** 其他要求，原样交给模型。 */
  notes?: string;
}

export interface CreateWorldParams {
  /** 一句话灵感，可以为空。 */
  seed: string;
  /** 世界名，留空则自动起名。 */
  title?: string;
  preset?: GenesisPresetId;
  options?: GenesisOptions;
}

export type GenesisChunk =
  | { type: 'world'; worldId: string }
  | { type: 'step'; step: GenesisStepId; state: GenesisStepState }
  /** 某一步已经收到的字数（用于显示进度）。 */
  | { type: 'progress'; step: GenesisStepId; chars: number };

// ───────────── 游玩 ─────────────

/** 一段台词或旁白。 */
export type Segment =
  | { kind: 'narration'; text: string }
  | {
      kind: 'line';
      /** 对应的角色；临时出场、设定里没有的角色为 null。 */
      characterId: string | null;
      name: string;
      text: string;
    };

export interface SceneState {
  locationId: string | null;
  presentCharacterIds: string[];
}

/**
 * 事件树上的一个节点。
 * opening：开场（树根）；player：玩家的一次输入；ai：模型的一次回复；scene：玩家手动换场景。
 */
export interface PlayEvent {
  id: string;
  parentId: string | null;
  kind: 'opening' | 'player' | 'ai' | 'scene';
  createdAt: number;
  /** player 的输入原文。 */
  text?: string;
  /** opening / ai 的内容。 */
  segments?: Segment[];
  /** 这个事件之后的场景（opening / scene 必有；ai 只在有角色登场时有）。 */
  scene?: SceneState;
  /** 产生它的那次模型调用（可在调用日志里查看）。 */
  callId?: string | null;
  edited?: boolean;
}

export interface PathEvent extends PlayEvent {
  /** 同一父节点下的所有分支（含自己），按创建时间排序。 */
  siblingIds: string[];
  siblingIndex: number;
}

export interface PlaythroughInfo {
  id: string;
  worldId: string;
  title: string;
  mode: PlayMode;
  protagonistId: string | null;
  createdAt: number;
  updatedAt: number;
  headId: string;
  /** 最近一条内容的前几十个字。 */
  preview: string;
}

export interface SaveInfo {
  id: string;
  name: string;
  eventId: string;
  preview: string;
  createdAt: number;
}

export interface PlayView {
  playthrough: PlaythroughInfo;
  /** 从开场到当前位置的事件。 */
  path: PathEvent[];
  scene: SceneState;
  /** 当前位置可用的场景摘要（前情提要）。 */
  memory: { text: string; coveredEvents: number } | null;
  saves: SaveInfo[];
}

export interface PlayRef {
  worldId: string;
  playthroughId: string;
}

export interface SendParams extends PlayRef {
  /** 玩家输入；空字符串表示"继续"，让角色们自己往下演。 */
  text: string;
  /** 接在哪个事件后面，默认当前位置。用于"编辑后重发"。 */
  parentId?: string;
}

export type PlayChunk =
  | { type: 'phase'; phase: 'memory' | 'thinking' | 'writing' }
  /** 已保存的玩家输入。 */
  | { type: 'player'; event: PathEvent }
  /** 第 index 段的最新内容（流式更新，同一段会多次出现）。 */
  | { type: 'seg'; index: number; seg: Segment };

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

  listWorlds: Unary<void, WorldSummary[]>;
  getWorld: Unary<{ id: string }, WorldDetail>;
  deleteWorld: Unary<{ id: string }, void>;
  createWorld: Streaming<CreateWorldParams, GenesisChunk, WorldSummary>;
  /** 续跑没完成的步骤；给了 from 则从这一步起（含下游）全部重新生成。 */
  runGenesis: Streaming<{ worldId: string; from?: GenesisStepId }, GenesisChunk, WorldSummary>;

  listPlaythroughs: Unary<{ worldId: string }, PlaythroughInfo[]>;
  startPlaythrough: Unary<{ worldId: string; title?: string }, PlayView>;
  getPlaythrough: Unary<PlayRef, PlayView>;
  deletePlaythrough: Unary<PlayRef, void>;
  send: Streaming<SendParams, PlayChunk, PlayView>;
  /** 重抽某条回复：在同一位置生成一个新分支。 */
  regenerate: Streaming<PlayRef & { eventId: string }, PlayChunk, PlayView>;
  editEvent: Unary<PlayRef & { eventId: string; text?: string; segments?: Segment[] }, PlayView>;
  /** 切到某个分支，并沿着它最近的后续一直走到底。 */
  switchBranch: Unary<PlayRef & { eventId: string }, PlayView>;
  /** 回退到某个事件（之后的内容保留为分支）。 */
  rewind: Unary<PlayRef & { eventId: string }, PlayView>;
  /** 删除某个事件及其后续。 */
  deleteBranch: Unary<PlayRef & { eventId: string }, PlayView>;
  setScene: Unary<PlayRef & SceneState, PlayView>;
  saveSlot: Unary<PlayRef & { name?: string }, PlayView>;
  loadSave: Unary<PlayRef & { saveId: string }, PlayView>;
  deleteSave: Unary<PlayRef & { saveId: string }, PlayView>;
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
