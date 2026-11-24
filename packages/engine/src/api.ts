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
  ObserverSettings,
  PlayMode,
  PlotGraph,
  LegacyAct,
  PlotScene,
  RoleId,
  Scalar,
  RoleRoute,
  StageCommand,
  StoryOpening,
  StyleGuide,
  VariableDef,
  WorldBrief,
  WorldManifest,
} from '@auto-adv/schema';
import type { PlotCheckResult } from './plot/check.ts';
import type { CheckResult } from './plot/dice.ts';
import type { VarChange } from './plot/vars.ts';
import type { Streaming, Unary } from './rpc/index.ts';

export type { CheckResult } from './plot/dice.ts';
export type { PlotCheckResult, PlotIssue } from './plot/check.ts';
export type { CheckOutcome } from './plot/conditions.ts';
export type { VarChange } from './plot/vars.ts';

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
  /** 剧情图：原生的，或者从 M2 的旧骨架自动迁移来的。 */
  graph: PlotGraph | null;
  /** 剧情图的结构检查（带上手写剧本）；有错误时不能开始剧情 ADV 周目。 */
  plotCheck: PlotCheckResult | null;
  variables: VariableDef[];
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

/** 观察模式里一拍的导演记录。 */
export interface BeatMeta {
  /** 导演对这一拍的安排（可以作为"导演笔记"给观众看）。 */
  plan: string;
  strategy: ObserverSettings['strategy'];
  /** 时间推进后的时间描述。 */
  time?: string;
  /** M2 的周目：这一拍完成的骨架节拍 id（M3 起改记在 plot.points 上）。 */
  done?: string[];
  /** 这一拍揭示的秘密：谁的秘密，告诉了谁。 */
  reveals?: { characterId: string; to: string[] }[];
  /** 防崩坏触发时抽到的事件卡。 */
  card?: string;
  /** 被引擎驳回的导演动作和理由。 */
  rejected?: string[];
  /** M2 的周目：骨架走完后这一拍续写出的新篇章（M3 起改记在 plot.append 上）。 */
  arc?: LegacyAct;
  /** 与之前内容的最高相似度（0～1），用于检测重复。 */
  similarity?: number;
}

/** 走出口的原因：auto 条件成立、剧本 jump、玩家选项、只有一条路、演满 maxBeats 走 default、导演判断、剧情 ADV 跑偏时"就这样走"进入新插进来的一幕。 */
export type ExitReason = 'auto' | 'script' | 'choice' | 'single' | 'default' | 'director' | 'drift';

/**
 * 剧情 ADV 跑偏时玩家的选择（16.6）：pull 拉回来（只管下一拍）；detour 就这样走（把跑偏的这一段写成新的一幕，演完接回已有的幕）；
 * pause 暂停剧情图（之后自由推进）；resume 恢复剧情图；ignore 不用管（这一幕不再提醒）。
 */
export type DriftChoice = 'pull' | 'detour' | 'pause' | 'resume' | 'ignore';

/** 一拍结束时弹出的选项（等玩家选）。 */
export interface PlotMenu {
  /** script：手写剧本里的 choice；exits：剧情图的岔路（选项文字来自出口的 label）；ai：AI 演出的一拍结束时导演给的选项。 */
  source: 'script' | 'exits' | 'ai';
  options: {
    label: string;
    enabled: boolean;
    /** 锁住的原因（条件写成的一句话）。 */
    lockedBy?: string;
    /** 选这一项要掷骰。label 是检定的名字（AI 给的选项才有）。 */
    check?: { var?: string; dc: number; label?: string };
    /** ai：选这一项就走这个出口（目标幕 id，引擎核对过是当前幕打开的出口）。 */
    exit?: string;
  }[];
}

/** 续写追加到这个周目剧情图上的章和幕（只追加，不改已有的幕）。 */
export interface PlotAppend {
  chapters: { id: string; title: string }[];
  scenes: PlotScene[];
}

/** 剧情图上的进度（M3），记在 script / ai / choice 事件上，由 plot/progress.ts 折叠。 */
export interface PlotMark {
  /** 这个事件所在的幕。 */
  scene: string;
  /** 这一拍演到的要点。 */
  points?: string[];
  /** 这一拍的数值变化（裁决之后的结果）。 */
  vars?: VarChange[];
  /** 被驳回或截断的内容和理由，下一拍反馈给导演。 */
  notes?: string[];
  /** 手写剧本播到哪里（下一拍从这里继续；-1 表示播完了）。 */
  pc?: number;
  /** 这一拍结束时弹出的选项。 */
  menu?: PlotMenu;
  /** 走了哪个出口：之后的事件在新的幕里。 */
  exit?: { to: string; by: ExitReason };
  /** 这一拍达成的结局（结局幕的第一拍）。 */
  ending?: string;
  /** 剧情图走完了（结局幕演完）。 */
  finished?: boolean;
  /** 续写：这一拍开始前追加的章和幕（观察模式剧情图走完后导演续写的新篇章），scene 是新篇章的起始幕。 */
  append?: PlotAppend;
  /** 导演标记这一拍偏离了当前幕（16.6）。 */
  offTrack?: boolean;
  /** 剧情 ADV：连续几拍偏离了当前幕，这一拍之后问玩家怎么处理（16.6）。 */
  askDrift?: boolean;
  /** 剧情 ADV：这一拍是在剧情图暂停时演的（不推进剧情图，不算这一幕的拍数）。 */
  paused?: boolean;
}

/**
 * 事件树上的一个节点。
 * opening：开场（树根）；player：玩家的一次输入；ai：模型的一次回复（观察模式里是一拍）；scene：玩家手动换场景；
 * directive：观众给导演的指令；whisper：观众对某个角色的悄悄话；
 * script：手写剧本的一拍；choice：玩家选了一个选项；check：引擎掷骰的一次检定。
 */
export interface PlayEvent {
  id: string;
  parentId: string | null;
  kind: 'opening' | 'player' | 'ai' | 'scene' | 'directive' | 'whisper' | 'script' | 'choice' | 'check' | 'drift';
  createdAt: number;
  /** player / directive / whisper 的原文。 */
  text?: string;
  /** player：说话的角色（接管时可能不是主角）；whisper：听到悄悄话的角色。 */
  characterId?: string;
  /** 观察模式下一拍的导演记录。 */
  beat?: BeatMeta;
  /** opening / ai 的内容。 */
  segments?: Segment[];
  /** 这个事件之后的场景（opening / scene 必有；ai 只在有角色登场时有）。 */
  scene?: SceneState;
  /** 产生它的那次模型调用（可在调用日志里查看）。 */
  callId?: string | null;
  edited?: boolean;
  /** 剧情图进度（M3）。 */
  plot?: PlotMark;
  /** script：这一拍的舞台指令（Script IR），VN 舞台按它播放；segments 是同一段内容的文本形式。 */
  stage?: StageCommand[];
  /** choice：选了第几项（从 0 开始）和选项文字。 */
  choice?: { index: number; label: string };
  /** check：检定结果；ai：导演安排里的检定（先掷骰，再演出结果）。 */
  check?: CheckResult;
  /** drift：剧情 ADV 跑偏时玩家的选择；detour 时 text 是新幕的标题，plot 上记着追加的幕和走向它的出口。 */
  drift?: DriftChoice;
}

export interface PathEvent extends PlayEvent {
  /** 同一父节点下的所有分支（含自己），按创建时间排序。 */
  siblingIds: string[];
  siblingIndex: number;
}

export interface PlayUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** 按币种累计的花费（没配价格的调用不计入）。 */
  costs: Record<string, number>;
}

export interface PlaythroughInfo {
  id: string;
  worldId: string;
  title: string;
  mode: PlayMode;
  protagonistId: string | null;
  /** 玩家当前控制的角色：自由对话里是主角；观察模式里接管了谁就是谁，没接管为 null。 */
  controlledId: string | null;
  observer: ObserverSettings | null;
  usage: PlayUsage;
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
  /** 剧情 ADV：存档时 VN 舞台播到哪一步（某个事件里的第 index 步，见 plot/stage.ts）。 */
  at?: StagePos;
  /** 存档缩略图：当时的背景、CG、在场角色和所在的幕。 */
  thumb?: { bg: string | null; cg: string | null; chars: string[]; scene: string | null };
}

/** VN 舞台上的位置：路径上某个事件里的第 index 步。 */
export interface StagePos {
  eventId: string;
  index: number;
}

/** 剧情 ADV 周目的状态（从事件折叠出来的，见 plot/progress.ts）。 */
export interface AdvView {
  /** 当前所在的幕。 */
  scene: { id: string; title: string; chapter: string | null } | null;
  /** 等玩家选的选项。 */
  menu: PlotMenu | null;
  /** 剧情图走完了。 */
  finished: boolean;
  /** 这个周目达成的结局。 */
  ending: { id: string; title: string; kind: 'good' | 'normal' | 'bad'; hidden: boolean } | null;
  /** 卡住的原因：剧本演完了但没有出口（剧情图被改过等）。 */
  stuck: string | null;
  /** 剧情图现在没有通过结构检查（世界文件被改坏了）：不能继续往下演。 */
  error: string | null;
  /** 当前这一幕由 AI 演出（没有手写剧本）：可以输入自由行动。 */
  aiScene: boolean;
  /** 这一幕要由 AI 演出，但还没有配置模型（只能看到占位旁白）。 */
  needsModel: boolean;
  /**
   * 跑偏（16.6）：ask 是连续几拍偏离了当前这一幕，要玩家先决定怎么处理；paused 是剧情图暂停中；
   * pullBack 是下一拍要把场面带回这一幕；detour 是能不能"就这样走"（要调模型写新的一幕）。
   */
  drift: { ask: boolean; paused: boolean; pullBack: boolean; detour: boolean };
  vars: Record<string, Scalar>;
  /** 跨周目进度。隐藏结局达成之前不计入总数，标题显示为"？？？"。 */
  progress: {
    endings: { id: string; title: string; kind: 'good' | 'normal' | 'bad'; hidden: boolean; reached: boolean }[];
    reached: number;
    total: number;
    cgs: { unlocked: string[]; total: number };
    scenes: { visited: number; total: number };
  };
}

/**
 * 一个世界的跨周目收集（16.8）：结局、CG、走过的幕。只增不减，回退、换分支、删周目都不影响。
 * 没达成的隐藏结局不计入总数、标题显示为"？？？"；没解锁的 CG 不告诉出现在哪一幕。
 */
export interface WorldProgress {
  endings: { id: string; title: string; kind: 'good' | 'normal' | 'bad'; hidden: boolean; reached: boolean; firstAt: number | null }[];
  reached: number;
  total: number;
  /** 手写剧本里出现的 CG，按剧情图里幕的顺序。 */
  cgs: { id: string; unlocked: boolean; firstAt: number | null; scene: string | null }[];
  scenes: { visited: number; total: number };
}

/** 剧情图上的进度（从事件折叠出来的，见 plot/progress.ts）。世界没有剧情图时除了 time 都是空的。 */
export interface PlotProgress {
  /** 当前所在的幕。 */
  scene: string | null;
  /** 当前幕里演了几拍。 */
  sceneBeats: number;
  /** 演到的要点（整条路径）。 */
  points: string[];
  /** 走过的幕，按进入顺序。 */
  visited: string[];
  /** 这个周目续写追加的章和幕。 */
  appended: PlotAppend;
  /** 最近达成的结局。 */
  ending: string | null;
  /** 剧情图走完了。 */
  finished: boolean;
  /** 故事里的当前时间（导演推进过时间才有）。 */
  time: string | null;
}

export interface ObserverStatus {
  /** 用户希望它在跑（按了播放）。 */
  running: boolean;
  /**
   * idle：没在跑；generating：正在生成一拍；buffered：领先观众太多，等观众看；
   * throttled：触发了频率限制，稍后继续；backoff：上一拍失败，稍后重试。
   */
  activity: 'idle' | 'generating' | 'buffered' | 'throttled' | 'backoff';
  /** 自动停下的原因。 */
  stopReason: 'budget' | 'errors' | 'takeover' | null;
  lastError: string | null;
  failures: number;
  /** 观众读到了哪个事件。 */
  readId: string;
  /** 已生成但观众还没看的拍数。 */
  ahead: number;
  /** 正在生成时收到、等下一拍开始时写入的导演指令和悄悄话。 */
  queued: number;
  /** 这个周目到目前为止的用量（预算按它算）。 */
  budget: { cost: number; tokens: number; calls: number };
}

export interface PlayView {
  playthrough: PlaythroughInfo;
  /** 从开场到当前位置的事件。 */
  path: PathEvent[];
  scene: SceneState;
  /** 当前位置可用的场景摘要（前情提要）。 */
  memory: { text: string; coveredEvents: number } | null;
  saves: SaveInfo[];
  plot: PlotProgress;
  /** 观察模式的运行状态；自由对话为 null。 */
  observer: ObserverStatus | null;
  /** 剧情 ADV 的状态；其他模式为 null。 */
  adv: AdvView | null;
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

export interface StartPlaythroughParams {
  worldId: string;
  title?: string;
  mode?: PlayMode;
  observer?: Partial<ObserverSettings>;
}

/** 观察模式的实时推送。 */
export type ObserverChunk =
  | { type: 'status'; status: ObserverStatus }
  /** 开始生成新的一拍（parentId 是它接在哪个事件后面）。 */
  | { type: 'beat-start'; parentId: string }
  | { type: 'phase'; phase: 'arc' | 'director' | 'narrator' | 'actor' | 'writer' | 'memory'; name?: string }
  /** 正在生成的这一拍第 index 段的最新内容。 */
  | { type: 'seg'; index: number; seg: Segment }
  /** 一拍完成（或有其他事件写进了树，比如导演指令）。 */
  | { type: 'event'; event: PathEvent };

export type PlayChunk =
  | { type: 'phase'; phase: 'memory' | 'thinking' | 'writing' | 'detour' }
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
  /** 从文件夹导入一个世界（例如 examples/worlds/ 里的示例）。 */
  importWorld: Unary<{ path: string }, WorldSummary>;
  createWorld: Streaming<CreateWorldParams, GenesisChunk, WorldSummary>;
  /** 续跑没完成的步骤；给了 from 则从这一步起（含下游）全部重新生成。 */
  runGenesis: Streaming<{ worldId: string; from?: GenesisStepId }, GenesisChunk, WorldSummary>;

  listPlaythroughs: Unary<{ worldId: string }, PlaythroughInfo[]>;
  /** 跨周目的收集：结局、CG 画廊、走过的幕。世界没有剧情图时为 null。 */
  worldProgress: Unary<{ worldId: string }, WorldProgress | null>;
  startPlaythrough: Unary<StartPlaythroughParams, PlayView>;
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
  /** 存档。剧情 ADV 可以带上舞台播到的位置（at），读档时回到那一句。 */
  saveSlot: Unary<PlayRef & { name?: string; at?: StagePos }, PlayView>;
  loadSave: Unary<PlayRef & { saveId: string }, PlayView>;
  deleteSave: Unary<PlayRef & { saveId: string }, PlayView>;

  /** 剧情 ADV：往下演（手写剧本不调模型，立刻返回；AI 演出的幕推送生成进度）。 */
  advNext: Streaming<PlayRef, PlayChunk, PlayView>;
  /** 剧情 ADV：选第 index 个选项（从 0 开始），并演出选完之后的内容。 */
  advChoose: Streaming<PlayRef & { index: number }, PlayChunk, PlayView>;
  /** 剧情 ADV：在 AI 演出的幕里输入一句自由行动（代替选项）。 */
  advInput: Streaming<PlayRef & { text: string }, PlayChunk, PlayView>;
  /** 剧情 ADV：跑偏时的选择（16.6）。"就这样走"要调模型把跑偏的这一段写成新的一幕。 */
  advDrift: Streaming<PlayRef & { choice: DriftChoice }, PlayChunk, PlayView>;
  /** 剧情 ADV：舞台第一次显示了某张 CG（记跨周目解锁）。 */
  advShown: Unary<PlayRef & { eventId: string; cg: string }, { unlocked: boolean }>;

  /** 观察模式：播放 / 暂停。 */
  observerControl: Unary<PlayRef & { action: 'play' | 'pause' }, PlayView>;
  observerSettings: Unary<PlayRef & { settings: Partial<ObserverSettings> }, PlayView>;
  /** 观众读到了哪里（推进阅读位置，生成器据此决定要不要继续生成）。 */
  observerRead: Unary<PlayRef & { eventId: string }, ObserverStatus>;
  /** 订阅实时进度；取消订阅即结束。 */
  observerWatch: Streaming<PlayRef, ObserverChunk, void>;
  /** 给导演的指令，下一拍生效。 */
  directive: Unary<PlayRef & { text: string }, PlayView>;
  /** 对某个角色说悄悄话（只有他自己听得到）。 */
  whisper: Unary<PlayRef & { characterId: string; text: string }, PlayView>;
  /** 接管某个角色（null 表示交还给 AI）。接管期间自动暂停，用 send 以该角色身份行动。 */
  takeover: Unary<PlayRef & { characterId: string | null }, PlayView>;
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
