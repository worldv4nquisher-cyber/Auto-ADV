/**
 * 引擎对外提供的接口契约。界面进程只依赖这个文件里的类型（和 rpc），不会把引擎实现打包进去。
 */
import type { ChatMessage, ProbeStep, StreamEvent, ToolCall, Usage } from '@auto-adv/providers';
import type { AssetEstimate } from './assets/estimate.ts';
import type {
  AppSettings,
  AssetKind,
  AssetSettings,
  AssetSettingsPatch,
  EditorSettings,
  AssetToggle,
  BgmSource,
  Capabilities,
  ImageTemplates,
  MediaRoleId,
  MediaRoute,
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
  VoiceDef,
  WorldBrief,
  WorldManifest,
} from '@auto-adv/schema';
import type { PlotCheckResult } from './plot/check.ts';
import type { CheckResult } from './plot/dice.ts';
import type { VarChange } from './plot/vars.ts';
import type { Streaming, Unary } from './rpc/index.ts';
import type { EntityKind, RevKey, WorldIssue, WorldPart, WorldRef } from './world/edit.ts';
import type { StaleStep } from './genesis/inputs.ts';
import type { RewriteChunk } from './genesis/pipeline.ts';
import type { RenameHit } from './world/rename.ts';
import type { HistoryEntry, WorldPartKey } from './world/store.ts';

export type { CheckResult } from './plot/dice.ts';
export type { EntityKind, RevKey, WorldIssue, WorldPart, WorldRef } from './world/edit.ts';
export type { HistoryEntry, HistoryReason, WorldPartKey } from './world/store.ts';
export type { StaleStep, StepInput } from './genesis/inputs.ts';
export type { RewriteChunk } from './genesis/pipeline.ts';
export type { RenameHit } from './world/rename.ts';
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
  /** 图像（以后还有语音、音乐）职责。 */
  media: AppSettings['media'];
  /** 素材管线的全局设置。 */
  assets: AssetSettings;
  /** 世界编辑器的设置（20.11）。 */
  editor: EditorSettings;
  /** 内置的默认值：模板、画风、模板里的占位符（设置页显示、恢复默认用）。 */
  assetDefaults: AssetDefaults;
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

export interface AssetDefaults {
  templates: ImageTemplates;
  artStyle: string;
  placeholders: { key: string; hint: string }[];
  settings: AssetSettings;
  /** 音乐模型的内置模板、占位符和世界没写音乐风格时用的风格。 */
  music: { template: string; style: string; placeholders: { key: string; hint: string }[] };
}

// ───────────── 素材（M4，18.2～18.3） ─────────────

/** 一个素材槽现在的样子。 */
export interface AssetSlotView {
  /** bg/<地点 id> 等，由用途决定，重画不变。 */
  id: string;
  kind: AssetKind;
  toggle: AssetToggle;
  title: string;
  subtitle: string;
  /**
   * pending 待生成；running 生成中；done 完成；stale 过期（参数或上游改了）；failed 失败（重试过了）；
   * disabled 这类素材在设置里关掉了，也没有文件。
   */
  status: 'pending' | 'running' | 'done' | 'stale' | 'failed' | 'disabled';
  /** 过期的原因：params 这个槽自己的参数改了（点了才重画）；deps 上游重画了（自动跟上）。 */
  staleBy: 'params' | 'deps' | null;
  locked: boolean;
  /** 锁定的槽，参数或上游改过。 */
  upstreamChanged: boolean;
  /** 排着队等重画。 */
  requested: boolean;
  /** 现在用的文件（相对世界目录）；没有就用占位图。 */
  file: string | null;
  source: 'generated' | 'uploaded' | 'builtin' | null;
  /** 生成时用的提示词（你改过就是你改的）。 */
  prompt: string;
  /** 按模板拼出来的提示词。 */
  defaultPrompt: string;
  promptEdited: boolean;
  size: string;
  error: string | null;
  /** 立绘抠图没通过透明度检查：现在用的是没抠的原图，要你看一下。 */
  review: string | null;
  /** 立绘：哪个角色、哪个表情。 */
  characterId: string | null;
  expression: string | null;
  /** BGM：哪个情绪。 */
  mood: string | null;
  model: string | null;
  revisedPrompt: string | null;
  /** 之前用过的文件，可以换回去。 */
  history: { file: string; at: string }[];
  updatedAt: string | null;
}

// ───────────── BGM（18.7） ─────────────

/** 一首可以放的曲子。 */
export interface BgmTrack {
  /**
   * 界面拿它拼地址：world 是世界目录下的文件（assets/…）；library 是本地曲库里的相对路径；
   * builtin 是内置曲库里的文件名。
   */
  ref: { kind: 'world' | 'library' | 'builtin'; path: string };
  title: string;
  source: BgmSource | 'uploaded';
  /** 能循环（音乐模型生成的）。不能循环的放完淡出、停几秒，再放同一情绪的下一首。 */
  loop: boolean;
  /** 作曲、演奏或渲染方式、授权（内置曲库）。 */
  credit?: string;
}

/** 一个情绪现在放什么。 */
export interface MoodPlaylist {
  mood: string;
  name: string;
  /** 现在给曲子的来源；一首都没有为 null。 */
  source: BgmSource | 'uploaded' | null;
  tracks: BgmTrack[];
  /** 按顺序轮到了音乐模型、而这首还没生成好：音乐模型要生成它（期间先用后面的来源）。 */
  wantsModel: boolean;
}

export interface LibraryTrack {
  /** 相对曲库文件夹的路径，用 / 分隔。 */
  rel: string;
  /** 文件名去掉扩展名。 */
  name: string;
  mood: string | null;
  /** 怎么认出的情绪：子文件夹名、文件名、文本模型按文件名挑的。 */
  by: 'folder' | 'name' | 'model' | null;
}

/** 内置曲库的一首（resources/bgm/manifest.json）：每首都写清楚来源和授权。 */
export interface BuiltinTrackInfo {
  file: string;
  title: string;
  composer: string;
  mood: string;
  source: string;
  method: string;
  license: string;
}

export interface BgmView {
  /** 每个情绪现在放什么（按情绪表的顺序）。 */
  playlists: MoodPlaylist[];
  /** 手写剧本的 bgm 指令按文件名找曲子：本地曲库和内置曲库的文件名（小写、去掉扩展名）→ 曲子。 */
  named: Record<string, BgmTrack>;
  /** 本地曲库：选了文件夹才有。 */
  library: {
    dir: string;
    tracks: LibraryTrack[];
    error: string | null;
    truncated: boolean;
    /** 正在让文本模型按文件名挑情绪。 */
    classifying: boolean;
  } | null;
  /** 内置曲库有几首。 */
  builtinCount: number;
  /** 没配音乐职责。 */
  needsModel: boolean;
}

export interface AssetsView {
  worldId: string;
  slots: AssetSlotView[];
  /** 世界里已经不需要的槽（比如删掉的地点）：文件还留着，可以清理。 */
  orphans: { id: string; file: string | null }[];
  counts: { total: number; done: number; running: number; pending: number; stale: number; failed: number };
  state: {
    /** 没配图像职责：只能用占位图。 */
    needsModel: boolean;
    paused: boolean;
    /** 正在画或者还有排着队的。 */
    working: boolean;
    /** 图片张数上限（算上重抽）。reached：到了上限、还有要画的。 */
    cap: { used: number; limit: number; reached: boolean; action: AssetSettings['capAction'] };
  };
  settings: { world: AssetSettingsPatch; effective: AssetSettings; global: AssetSettings };
  bgm: BgmView;
  /** 世界里的角色（id、名字、别称）：游玩时临时人物升级成正式角色会变，界面据此重新读世界（18.5）。 */
  castKey: string;
}

export type AssetsChunk = { type: 'view'; view: AssetsView };

export type { AssetEstimate } from './assets/estimate.ts';

/** 配音表里的一个角色（18.8）。 */
export interface VoiceCastCharacter {
  id: string;
  name: string;
  role: string;
  /** 分到的音色；还没分配（或者音色表里没有了）为 null。 */
  voiceId: string | null;
  voiceName: string;
  /** 你自己选的，不会被自动改掉。 */
  locked: boolean;
  /** 这个角色配不配（主角默认不配）。 */
  enabled: boolean;
}

/** 一个世界的配音表：谁用什么音色、谁配音。 */
export interface VoiceCastView {
  worldId: string;
  /** 能配音：语音开着、配了语音职责、音色表不空。 */
  ready: boolean;
  /** 不能配音的原因。 */
  reason: string | null;
  /** 音色表。 */
  voices: VoiceDef[];
  characters: VoiceCastCharacter[];
  narrator: { enabled: boolean; voiceId: string | null };
  /** 世界里没有的临时人物用的音色。 */
  extra: { voiceId: string | null };
  /** 最近一次分配音色出的问题（例如文本模型没配，按描述里的性别挑的）。 */
  note: string | null;
}

/** 要念的一句。speaker 为 null 是旁白（或没写角色的心声）。voiceId 给了就用它（试听）。 */
export interface VoiceLineParams {
  speaker: { characterId: string | null; name: string } | null;
  kind: 'say' | 'narrate' | 'think';
  text: string;
  /** 说话时的表情（按设置换成情绪）。 */
  expr?: string | null;
  voiceId?: string;
}

/** 念好的一句：文件（相对世界目录，在 assets/voice/ 下）和时长（服务报告的；没有为 null）。 */
export interface VoiceLineResult {
  file: string;
  durationMs: number | null;
}

/**
 * 素材槽上的操作：regenerate 重抽（换个种子画一张新的）；redraw 按现在的参数重画（过期的槽）；retry 失败后重试；
 * lock / unlock 锁定（不会被自动覆盖）；use 换回之前用过的一张（file）。
 */
export type AssetAction = 'regenerate' | 'redraw' | 'retry' | 'lock' | 'unlock' | 'use';

/**
 * 整个世界的素材：pause / resume 暂停、继续；raiseCap 到了上限之后再放宽 20 张；redrawStale 参数改过的过期槽全部重画；
 * cleanOrphans 清理不再需要的槽；rescanLibrary 重新扫一遍本地曲库。
 */
export type AssetsControl = 'pause' | 'resume' | 'raiseCap' | 'redrawStale' | 'cleanOrphans' | 'rescanLibrary';

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
  /** 每一块内容现在的版本号（20.5）：保存时作为 base 带回来，对不上说明这之间被别处改过。 */
  revs: Record<string, string>;
  /** 引用检查（悬空的引用、重名、主角个数），都是警告；剧情图的结构检查在 plotCheck。 */
  issues: WorldIssue[];
  /** 能不能编辑：正在创世时不能。 */
  editable: boolean;
  /** 过期的创世步骤（20.4）：上游改过，这几步还是按改之前写的。 */
  stale: StaleStep[];
}

/** 保存一块内容（20.5）。 */
export type SaveWorldPartParams = WorldPart & {
  worldId: string;
  /** 打开时的版本号（WorldDetail.revs 里的）；新建的不用给。 */
  base?: string | null;
  /** 这次编辑里你点开了锁的字段：手改了也不自动锁回去。 */
  unlocked?: string[];
  /** 世界观、数值、世界名这几块没有 `_meta`：true 锁住，false 解锁，不给就按"手改自动锁住"。 */
  lock?: boolean;
  /**
   * 角色、地点改了名字时，正文里的旧名字换掉哪些（20.4"改名"）：renameHits 列出来的组，或者 'all'。
   * 不给就按设置（总是替换 = 全换；问、从不 = 不换）。
   */
  rename?: { groups: string[] | 'all' };
};

export interface SaveWorldPartResult {
  /** 保存的是哪一块（新建的实体在这里拿到分配的 id）。 */
  key: RevKey;
  world: WorldDetail;
  /** 改名时正文里换了几处旧名字。 */
  renamed?: number;
}

/** 删掉的角色、地点、设定条目（历史里还留着，能找回来）。 */
export interface DeletedEntity {
  kind: EntityKind;
  id: string;
  /** 名字或标题。 */
  title: string;
  /** 历史文件名（找回时原样传回来）。 */
  name: string;
  at: string;
  /** 能不能直接找回（历史文件的格式读得懂）。 */
  restorable: boolean;
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
  /** 导演报告的这一拍的情绪（情绪表里的 id，18.7），舞台按它换 BGM。 */
  mood?: string;
  /** 导演标的高光时刻（18.6）：素材管线按它画一张 CG（cg/<id>），舞台在这一拍中间那句话上放出来。 */
  cg?: BeatCg;
}

/** 导演标的一张 CG。id 以 ai_ 开头；cast 是画面里的角色 id。 */
export interface BeatCg {
  id: string;
  title: string;
  description: string;
  cast: string[];
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
  /** 图像职责（null 清除）。 */
  setMediaRole: Unary<{ role: MediaRoleId; route: MediaRoute | null }, void>;
  /** 保存素材管线的全局设置。 */
  saveAssetSettings: Unary<{ settings: AssetSettings }, void>;
  /** 保存世界编辑器的设置。 */
  saveEditorSettings: Unary<{ settings: Partial<EditorSettings> }, void>;
  /** 用图像职责（或给的 route）画一张小图试试。会花一张图的额度。 */
  testImage: Unary<{ route?: MediaRoute }, { dataUrl: string; revisedPrompt: string | null; latencyMs: number }>;
  testMusic: Unary<{ route?: MediaRoute }, { dataUrl: string; durationMs: number | null; latencyMs: number }>;
  /** 用语音职责（或给的 route）念一句试试。voice 不给就用音色表里的第一个。 */
  testVoice: Unary<{ route?: MediaRoute; voice?: string; text?: string }, { dataUrl: string; durationMs: number | null; latencyMs: number }>;
  /** 语音服务上的音色（MiniMax 从服务拉取，OpenAI 是固定的一套）。 */
  fetchVoices: Unary<{ route: MediaRoute }, VoiceDef[]>;
  /** ComfyUI 上能用的模型（checkpoint 文件名，CheckpointLoaderSimple 的选项）。 */
  comfyModels: Unary<{ route: MediaRoute }, string[]>;
  /** 一个世界的配音表（还没分配的角色会先分配，可能要等文本模型）。 */
  voiceCast: Unary<{ worldId: string }, VoiceCastView>;
  /** 给一个角色换音色（锁定）；voiceId 为 null 是解除锁定、自动重新分配。 */
  setCharacterVoice: Unary<{ worldId: string; characterId: string; voiceId: string | null }, VoiceCastView>;
  /** 没锁定的角色全部重新分配。 */
  recastVoices: Unary<{ worldId: string }, VoiceCastView>;
  /** 念一句台词：有缓存直接用，没有就生成。不配音的返回 null。 */
  voiceLine: Unary<{ worldId: string; line: VoiceLineParams }, VoiceLineResult | null>;
  /** 用抠图职责（或给的 route）抠一张示例图试试。 */
  testCutout: Unary<{ route?: MediaRoute }, { dataUrl: string; latencyMs: number }>;
  /** 内置曲库的曲目和授权（「关于」页）。 */
  builtinBgm: Unary<void, BuiltinTrackInfo[]>;
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
  /** 创世前估算新世界的素材用量：图片张数、音乐首数、每拍念多少字（6.5、18.3）。 */
  estimateAssets: Unary<{ options: GenesisOptions }, AssetEstimate>;
  /**
   * 续跑没完成的步骤；给了 from 则从这一步起（含下游）全部重新生成；给了 steps 只重新生成这几步（20.4，锁住的保留）。
   * note 是附给这几步的一句说明。
   */
  runGenesis: Streaming<{ worldId: string; from?: GenesisStepId; steps?: GenesisStepId[]; note?: string }, GenesisChunk, WorldSummary>;
  /** 过期的步骤不更新了：按现在的上游记下新的输入哈希（不给 steps 就是全部过期的）。 */
  acceptStale: Unary<{ worldId: string; steps?: GenesisStepId[] }, WorldDetail>;
  /** 只重写一个角色、地点或设定条目（20.4）：id 不变，锁住的字段保留，之前的版本进历史。 */
  rerollEntity: Streaming<{ worldId: string; kind: EntityKind; id: string; note?: string }, RewriteChunk, WorldDetail>;
  /** 只重写一个字段（长文本），返回新的文字，不保存：放进表单里，看过再存。data 是表单里现在的内容。 */
  rewriteField: Streaming<{ worldId: string; key: RevKey; path: string; data?: unknown; note?: string }, RewriteChunk, { text: string }>;
  /** 改名之前：正文里还写着旧名字的地方（draft 是表单里正在改的这一个）。 */
  renameHits: Unary<{ worldId: string; kind: 'character' | 'location'; id: string; to: string; draft?: unknown }, RenameHit[]>;
  /** 删掉的角色、地点、设定条目（新的在前）。 */
  deletedEntities: Unary<{ worldId: string }, DeletedEntity[]>;
  /** 从历史里找回一个删掉的实体（id 被占了就换一个）。 */
  restoreDeleted: Unary<{ worldId: string; kind: EntityKind; id: string; name: string }, SaveWorldPartResult>;

  /** 世界编辑器（M5，20.5）：保存一块内容。 */
  saveWorldPart: Unary<SaveWorldPartParams, SaveWorldPartResult>;
  /** 删掉一个角色、地点或设定条目；removeRefs 时把别处能去掉的引用一起去掉。 */
  deleteWorldPart: Unary<{ worldId: string; kind: EntityKind; id: string; removeRefs: boolean }, WorldDetail>;
  /** 别处对某个角色或地点的引用（删之前列出来）。 */
  worldReferences: Unary<{ worldId: string; kind: EntityKind; id: string }, WorldRef[]>;
  /** 一块内容的历史版本，新的在前。 */
  worldHistory: Unary<{ worldId: string; key: WorldPartKey }, HistoryEntry[]>;
  /** 读一个历史版本：text 是原文，data 是补全了默认值、可以直接拿去保存的内容（读不懂时为 null）。 */
  worldHistoryRead: Unary<{ worldId: string; key: WorldPartKey; name: string }, { text: string; data: unknown }>;

  /** 素材（M4）：世界的素材槽和生成进度。 */
  assetsView: Unary<{ worldId: string }, AssetsView>;
  /** 订阅素材的变化；取消订阅即结束。 */
  assetsWatch: Streaming<{ worldId: string }, AssetsChunk, void>;
  assetAction: Unary<{ worldId: string; slotId: string; action: AssetAction; file?: string }, AssetsView>;
  /** 改一个槽的提示词（null 恢复模板拼出来的）；redraw 改完马上重画。 */
  assetSetPrompt: Unary<{ worldId: string; slotId: string; prompt: string | null; redraw?: boolean }, AssetsView>;
  /** 换成自己的图（本机文件的完整路径）：复制进世界，并锁定。 */
  assetUpload: Unary<{ worldId: string; slotId: string; path: string }, AssetsView>;
  assetsControl: Unary<{ worldId: string; action: AssetsControl }, AssetsView>;
  /** 这个世界的素材设置（只写和全局不一样的项）。 */
  saveWorldAssetSettings: Unary<{ worldId: string; patch: AssetSettingsPatch }, AssetsView>;

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
  /**
   * 剧情 ADV：重抽 AI 演的最后一拍。在同一个位置生成一个新分支（原来的一拍留作分支），
   * 玩家的选择和检定不变（骰子跟剧情位置绑定，重抽换不了结果）。
   */
  advRegenerate: Streaming<PlayRef, PlayChunk, PlayView>;
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
