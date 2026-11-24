/**
 * 剧情图（格式版本 1 起的 plot/outline.json）、条件、数值定义和 Script IR。
 * 设计见 docs/ARCHITECTURE.md 16 节；M2 的"篇章 / 章节 / 节拍"骨架（格式版本 0）读取时自动迁移（16.7）。
 */
import { z } from 'zod';
import { EntityMeta, Id } from './common.ts';
import { FORMAT_VERSION } from './version.ts';

// ───────────── 变量 ─────────────

/** 变量 id：小写字母开头，可以用点分组，例如 affinity.char_lin、flags.sister_found。 */
export const VarId = z.string().regex(/^[a-z][a-z0-9_.]*$/, '变量 id 只能包含小写字母、数字、下划线和点，且以字母开头');

export const Scalar = z.union([z.number(), z.boolean(), z.string()]);
export type Scalar = z.infer<typeof Scalar>;

/**
 * 变量的类别。relationship：0～100 的关系类数值（好感、信任……），默认每拍变化上限 ±5、关键突破 ±12；
 * attribute：属性，检定时作为修正值；other：其他（金钱、日期、标记……）。
 */
export const VariableCategory = z.enum(['relationship', 'attribute', 'other']);
export type VariableCategory = z.infer<typeof VariableCategory>;

/** systems/variables.json 中的一项：数值或标记的定义。 */
export const VariableDef = z.object({
  id: VarId,
  label: z.string(),
  type: z.enum(['number', 'boolean', 'string']),
  initial: Scalar,
  min: z.number().optional(),
  max: z.number().optional(),
  visible: z.boolean().default(true),
  category: VariableCategory.default('other'),
  /** 模型提出的变化每拍的上限（16.4）。burst 只在演到要点或检定成功的那一拍可用。不填按类别取默认值。 */
  perBeat: z.object({ normal: z.number().min(0), burst: z.number().min(0) }).optional(),
});
export type VariableDef = z.infer<typeof VariableDef>;

/** systems/variables.json */
export const VariablesFile = z.object({
  formatVersion: z.number().int().default(FORMAT_VERSION),
  variables: z.array(VariableDef).default([]),
});
export type VariablesFile = z.infer<typeof VariablesFile>;

/** 一条数值变化：`+` / `-` 只用于数字，`=` 直接赋值。 */
export const VarEffect = z.object({
  var: VarId,
  op: z.enum(['+', '-', '=']).default('='),
  value: Scalar,
});
export type VarEffect = z.infer<typeof VarEffect>;

// ───────────── 条件（16.3） ─────────────

export const COMPARE_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'] as const;
export type CompareOp = (typeof COMPARE_OPS)[number];

/**
 * 声明式条件：一个 JSON 结构，由引擎直接求值，不经过模型，也不执行任何代码。
 * `all: []` 为真，`any: []` 为假；比较的左边是变量 id；`check` 读这一幕最近一次检定的结果。
 */
export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { eq: [string, Scalar] }
  | { ne: [string, Scalar] }
  | { gt: [string, number] }
  | { gte: [string, number] }
  | { lt: [string, number] }
  | { lte: [string, number] }
  | { flag: string }
  | { visited: string }
  | { check: 'pass' | 'fail' };

export const Condition: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.strictObject({ all: z.array(Condition) }),
    z.strictObject({ any: z.array(Condition) }),
    z.strictObject({ not: Condition }),
    z.strictObject({ eq: z.tuple([VarId, Scalar]) }),
    z.strictObject({ ne: z.tuple([VarId, Scalar]) }),
    z.strictObject({ gt: z.tuple([VarId, z.number()]) }),
    z.strictObject({ gte: z.tuple([VarId, z.number()]) }),
    z.strictObject({ lt: z.tuple([VarId, z.number()]) }),
    z.strictObject({ lte: z.tuple([VarId, z.number()]) }),
    z.strictObject({ flag: VarId }),
    z.strictObject({ visited: Id }),
    z.strictObject({ check: z.enum(['pass', 'fail']) }),
  ]),
);

// ───────────── 检定（16.4） ─────────────

/** 一次检定：d20 + 修正值（var 的当前值，没有就是纯运气）对比 dc。 */
export const CheckSpec = z.object({
  /** 检定 id，参与骰子种子；不填时由所在位置生成。 */
  id: z.string().optional(),
  var: VarId.optional(),
  dc: z.number().int().min(1).max(40),
  label: z.string().default(''),
});
export type CheckSpec = z.infer<typeof CheckSpec>;

// ───────────── 剧情图（16.2） ─────────────

export const PlotExit = z.object({
  to: Id,
  /** 给玩家看的选项文字。 */
  label: z.string().default(''),
  /** 给导演看的自然语言条件（"主角答应帮忙"），由导演判断。 */
  when: z.string().default(''),
  /** 引擎求值的条件，不满足时这条路是关着的。 */
  if: Condition.optional(),
  /** 条件一满足就直接走，不等导演说演完。 */
  auto: z.boolean().default(false),
  /** 走这条路时的效果（作者的决定，只检查范围，不受每拍上限限制）。 */
  set: z.array(VarEffect).default([]),
  /**
   * 玩家选这条路时由引擎掷骰（16.4）。结果记成一条检定事件，下一幕的第一拍按结果演，
   * 下一幕的条件也能用 `check` 读到它。只在玩家从岔路里选的时候掷：导演换幕、auto 出口不掷。
   */
  check: CheckSpec.optional(),
});
export type PlotExit = z.infer<typeof PlotExit>;

export const PlotEnding = z.object({
  kind: z.enum(['good', 'normal', 'bad']).default('normal'),
  /** 隐藏结局：达成前不计入结局总数。 */
  hidden: z.boolean().default(false),
  /** 收场要求。 */
  text: z.string().default(''),
});
export type PlotEnding = z.infer<typeof PlotEnding>;

/** 每幕最多几条要点、几个出口（结构检查会查）。 */
export const PLOT_LIMITS = { points: 5, exits: 4 } as const;

export const PlotScene = z.object({
  /** 稳定 id，一般是 sc_NN。 */
  id: Id,
  chapter: Id.optional(),
  title: z.string().default(''),
  /** 这一幕要发生什么（一两句）。 */
  what: z.string().default(''),
  /** 要点，最多 5 条，陆续在故事里出现，不要求一拍写完。 */
  points: z.array(z.object({ id: Id, text: z.string() })).default([]),
  /** 演到什么算演完。 */
  done: z.string().default(''),
  /** 建议的地点和出场角色（提示，不是白名单）。 */
  location: Id.optional(),
  cast: z.array(Id).default([]),
  /** 这一幕至少 / 最多演几拍。真实模型短测里节奏偏快，所以 minBeats 默认 2。 */
  minBeats: z.number().int().min(0).default(2),
  maxBeats: z.number().int().min(1).default(8),
  /** 出口，最多 4 个；两个以上就是岔路。 */
  exits: z.array(PlotExit).default([]),
  /** 演满 maxBeats 还没判出走哪条路时走这个出口（必须是本幕出口的 to，且出口不能带条件）。 */
  default: Id.optional(),
  /** 有这个字段的就是结局幕，结局幕没有出口。 */
  ending: PlotEnding.optional(),
  /** 手写剧本的文件名（plot/scenes/ 下）。不填时自动找 plot/scenes/<id>.adv。 */
  script: z
    .string()
    .regex(/^[a-z0-9_]+\.adv$/, '剧本文件名只能是 plot/scenes/ 下的 <名字>.adv')
    .optional(),
});
export type PlotScene = z.infer<typeof PlotScene>;

export const PlotThread = z.object({
  id: Id,
  text: z.string(),
  plant: z.string().optional(),
  payoff: z.string().optional(),
});

/** plot/outline.json（M3 起）：由幕组成的剧情图。是骨架，不是剧本。 */
export const PlotGraph = z.object({
  formatVersion: z.number().int().default(FORMAT_VERSION),
  premise: z.string().default(''),
  control: z.enum(['sandbox', 'guided', 'linear']).default('guided'),
  start: Id,
  /** 章只用来分组显示和出章节标题卡，不参与逻辑。 */
  chapters: z.array(z.object({ id: Id, title: z.string().default('') })).default([]),
  scenes: z.array(PlotScene).default([]),
  threads: z.array(PlotThread).default([]),
  _meta: EntityMeta.default({ locked: [] }),
});
export type PlotGraph = z.infer<typeof PlotGraph>;

// ───────────── 旧骨架迁移（16.7） ─────────────

const LegacyBeat = z.object({ id: Id, text: z.string(), required: z.boolean().default(false) });
const LegacyChapter = z.object({ id: Id, title: z.string().default(''), goal: z.string(), beats: z.array(LegacyBeat).default([]) });
export const LegacyAct = z.object({ id: Id, title: z.string(), chapters: z.array(LegacyChapter).default([]) });
export type LegacyAct = z.infer<typeof LegacyAct>;

/** M2 的 plot/outline.json（格式版本 0）："篇章 / 章节 / 节拍"骨架。只在迁移和折叠旧周目时用。 */
export const LegacyPlotOutline = z.object({
  formatVersion: z.number().int().default(0),
  premise: z.string().default(''),
  control: z.enum(['sandbox', 'guided', 'linear']).default('guided'),
  acts: z.array(LegacyAct).default([]),
  endings: z.array(z.object({ id: Id, title: z.string(), condition: z.string().default('') })).default([]),
  threads: z
    .array(z.object({ id: Id, text: z.string(), plant: z.string().optional(), payoff: z.string().optional() }))
    .default([]),
  _meta: EntityMeta.default({ locked: [] }),
});
export type LegacyPlotOutline = z.infer<typeof LegacyPlotOutline>;

/** outline.json 是不是 M2 的旧骨架：按结构区分（有 acts、没有 scenes）。 */
export function isLegacyOutline(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as { scenes?: unknown; acts?: unknown };
  return !Array.isArray(d.scenes) && Array.isArray(d.acts);
}

/** 迁移得到的剧情图在 _meta.generatedBy 里记这个标记，结构检查据此提示改成结构化条件。 */
export const MIGRATED_FROM_OUTLINE = 'migrate:outline-v1';

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * 把 M2 的"篇章 / 章节 / 节拍"骨架转成剧情图：
 * 篇章 → 章；章节 → 幕（goal → what，节拍 → 要点，超过 5 个按顺序拆成几幕）；
 * 幕之间按原顺序用单出口串起来，最后一幕通往各个结局幕；
 * 字符串结局条件原样写进出口的 when，交给导演判断；节拍 id 原样保留为要点 id。
 */
export function migratePlotOutline(old: LegacyPlotOutline): PlotGraph {
  const scenes: PlotScene[] = [];
  /** 旧章节 id → 它变成的第一幕（伏笔的埋设 / 回收写的是旧章节 id 时换过来）。 */
  const chapterScene = new Map<string, string>();
  let n = 0;
  const nextId = () => `sc_${pad(++n)}`;
  for (const act of old.acts) {
    for (const ch of act.chapters) {
      const chunks: (typeof ch.beats)[] = [];
      for (let i = 0; i < Math.max(ch.beats.length, 1); i += PLOT_LIMITS.points) {
        chunks.push(ch.beats.slice(i, i + PLOT_LIMITS.points));
      }
      chapterScene.set(ch.id, `sc_${pad(n + 1)}`);
      chunks.forEach((beats, i) => {
        scenes.push(
          PlotScene.parse({
            id: nextId(),
            chapter: act.id,
            title: chunks.length > 1 ? `${ch.title}（${i + 1}/${chunks.length}）` : ch.title,
            what: ch.goal,
            points: beats.map((b) => ({ id: b.id, text: b.text })),
          }),
        );
      });
    }
  }
  const legacyEndings = old.endings.length ? old.endings : [{ id: 'end_01', title: '终章', condition: '' }];
  const endings = legacyEndings.map((e) =>
    PlotScene.parse({ id: nextId(), title: e.title, what: e.condition, ending: { kind: 'normal', text: e.title } }),
  );
  // 串起来：每一幕通往下一幕，最后一幕通往各个结局
  scenes.forEach((s, i) => {
    const next = scenes[i + 1];
    s.exits = next ? [PlotExit.parse({ to: next.id })] : [];
  });
  const last = scenes.at(-1);
  if (last) {
    last.exits = endings.map((e, i) =>
      PlotExit.parse({ to: e.id, label: legacyEndings[i]?.title ?? '', when: legacyEndings[i]?.condition ?? '' }),
    );
    if (endings.length > 1) last.default = endings[0]?.id;
  }
  const mapRef = (ref: string | undefined) => (ref ? (chapterScene.get(ref) ?? ref) : ref);
  return PlotGraph.parse({
    premise: old.premise,
    control: old.control,
    start: (scenes[0] ?? endings[0])?.id,
    chapters: old.acts.map((a) => ({ id: a.id, title: a.title })),
    scenes: [...scenes, ...endings],
    threads: old.threads.map((t) => ({ ...t, plant: mapRef(t.plant), payoff: mapRef(t.payoff) })),
    _meta: { ...old._meta, generatedBy: MIGRATED_FROM_OUTLINE },
  });
}

// ───────────── Script IR（5.4） ─────────────

/** 舞台表现指令：播放器按顺序执行，不影响剧情逻辑。 */
export type StageCommand =
  | { op: 'bg'; id: string; transition?: string }
  | { op: 'show'; char: string; expr?: string; pos?: string }
  | { op: 'hide'; char: string }
  | { op: 'say'; char: string; text: string }
  | { op: 'narrate'; text: string }
  | { op: 'think'; char?: string; text: string }
  | { op: 'bgm'; id: string | null }
  | { op: 'sfx' | 'voice' | 'cg' | 'video'; id: string }
  | { op: 'effect'; name: string }
  | { op: 'wait'; seconds: number };

export interface ChoiceOption {
  label: string;
  /** 不满足时选项显示为锁住。 */
  if?: Condition;
  /** 选这一项时由引擎掷骰。 */
  check?: CheckSpec;
  /** 选这一项的效果（作者的决定，不受每拍上限限制）。 */
  set: VarEffect[];
  /** 选这一项之后的内容。 */
  body: ScriptCommand[];
  /** 选完之后走哪个出口（必须是这一幕声明过的出口）。 */
  goto?: string;
  line?: number;
}

/** Script IR：手写剧本和 AI 生成的内容都编译成这一种指令流。line 是在 .adv 文件里的行号。 */
export type ScriptCommand =
  | (StageCommand & { line?: number })
  | { op: 'set'; effect: VarEffect; line?: number }
  /** 演到了这一幕的某个要点。 */
  | { op: 'point'; id: string; line?: number }
  /** 走这一幕的某个出口（和 AI 走同一条换幕规则）。 */
  | { op: 'jump'; to: string; line?: number }
  | { op: 'choice'; options: ChoiceOption[]; line?: number }
  | { op: 'if'; cond: Condition; then: ScriptCommand[]; else: ScriptCommand[]; line?: number };

export const STAGE_OPS = [
  'bg',
  'show',
  'hide',
  'say',
  'narrate',
  'think',
  'bgm',
  'sfx',
  'voice',
  'cg',
  'video',
  'effect',
  'wait',
] as const;
