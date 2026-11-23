/**
 * 模型写剧情图：要求的输出结构、转换成 PlotGraph、结构检查（docs/ARCHITECTURE.md 16.2、16.5）。
 * 创世生成整张剧情图，观察模式在剧情图走完后续写新篇章，都用这一套。
 * 模型写的 id、章节号、地点名、角色名在这里换成正式的 id；条件写错、指向不存在的幕、结构检查不过的地方
 * 整理成一段话，交给 generateJson 反馈给模型重写（和 6.2 的"校验与修复"同一套）。
 */
import {
  Condition,
  PLOT_LIMITS,
  type PlotExit,
  type PlotGraph,
  PlotScene,
  VariableDef,
  VarId,
} from '@auto-adv/schema';
import { z } from 'zod';
import type { JsonSpec } from '../llm/structured.ts';
import { checkPlot, type PlotIssue } from '../plot/check.ts';
import { matchByName } from '../world/render.ts';
import type { WorldData } from '../world/store.ts';
import { bool, list, required, text } from './specs.ts';

const lower = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : v);
const num = z.preprocess((v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().finite()).optional().catch(undefined);

const ExitOut = z.object({
  to: required,
  label: text.default(''),
  when: text.default(''),
  if: z.unknown().optional(),
  auto: bool.default(false),
});

const EndingOut = z.object({
  kind: z.preprocess(lower, z.enum(['good', 'normal', 'bad'])).catch('normal').default('normal'),
  text: text.default(''),
  hidden: bool.default(false),
});

const SceneOut = z.object({
  id: required,
  chapter: z.preprocess((v) => (v === null || v === undefined ? '' : String(v)), z.string()).default(''),
  title: text.default(''),
  what: text.default(''),
  points: list,
  done: text.default(''),
  location: text.default(''),
  cast: list,
  exits: z.array(ExitOut).catch([]).default([]),
  default: text.default(''),
  ending: EndingOut.nullable().catch(null).default(null),
});

const VariableOut = z.object({
  id: required,
  label: text.default(''),
  type: z.preprocess(lower, z.enum(['number', 'boolean'])).catch('number').default('number'),
  initial: z.unknown().optional(),
  min: num,
  max: num,
  category: z.preprocess(lower, z.enum(['relationship', 'attribute', 'other'])).catch('other').default('other'),
});

export const GraphOut = z.object({
  premise: text.default(''),
  chapters: z
    .array(z.preprocess((v) => (typeof v === 'string' ? { title: v } : v), z.object({ title: text.default('') })))
    .catch([])
    .default([]),
  variables: z.array(VariableOut).catch([]).default([]),
  scenes: z.array(SceneOut).min(2),
  threads: z
    .array(z.object({ text: required, payoff: text.default('') }))
    .catch([])
    .default([]),
});
export type GraphOut = z.infer<typeof GraphOut>;

export const graphSpec: JsonSpec<GraphOut> = {
  name: 'plot_graph',
  schema: GraphOut,
  example: {
    premise: '故事的核心冲突和走向（60～120 字）',
    chapters: [{ title: '第一章的标题' }, { title: '第二章的标题' }],
    variables: [
      { id: 'affinity.char_02', label: '某角色的好感', type: 'number', initial: 30, min: 0, max: 100, category: 'relationship' },
      { id: 'flag.found_log', label: '找到了日志', type: 'boolean', initial: false, category: 'other' },
      { id: 'skill.insight', label: '洞察', type: 'number', initial: 1, min: -2, max: 5, category: 'attribute' },
    ],
    scenes: [
      {
        id: 'sc_01',
        chapter: 1,
        title: '幕的标题',
        what: '这一幕要发生什么（一两句）',
        points: ['要点：这一幕里陆续要出现的事（1～4 条）'],
        done: '演到什么程度算这一幕演完了（一句话）',
        location: '建议的地点名',
        cast: ['建议出场的角色名'],
        exits: [
          { to: 'sc_02', label: '给玩家看的选项文字', when: '给导演看的条件，例如：主角答应帮忙' },
          { to: 'sc_03', label: '另一个选项', when: '主角拒绝了' },
        ],
      },
      {
        id: 'sc_06',
        chapter: 2,
        title: '……',
        what: '……',
        exits: [
          { to: 'sc_07', label: '', when: '林夕信任主角', if: { gte: ['affinity.char_02', 60] } },
          { to: 'sc_08', label: '', when: '其他情况' },
        ],
        default: 'sc_08',
      },
      { id: 'sc_07', chapter: 2, title: '结局名', what: '结局里发生什么', ending: { kind: 'good', text: '收场要求：结局要写出什么' }, exits: [] },
    ],
    threads: [{ text: '伏笔：埋下什么', payoff: '在哪一幕回收' }],
  },
};

/** 写给模型的剧情图规则（创世和续写共用）。 */
export const GRAPH_RULES = `剧情图由"幕"组成，是骨架，不是剧本：只规定每一幕必须发生什么，具体怎么演留给演出时即兴发挥。
- 幕：一个完整的场面，演几拍（每拍是几句对话、一个小转折）。what 一两句话；points 是 1～4 个要点，陆续在故事里出现；done 是演完的标准。
- location 和 cast 只能用给出的地点名和角色名，是建议，不是限制。
- 出口 exits：每一幕 1～3 个，指向别的幕的 id。两个以上就是岔路：每个岔路出口都要写 label（给玩家看的选项文字，像视觉小说的选项）和 when（给导演看的判断条件）。
- 结局幕：写 ending（kind 是 good / normal / bad，text 是收场要求），没有出口。
- 条件 if（可选）：满足时这条路才打开。只能用 JSON 结构，不能写字符串表达式，只能引用 variables 里定义过的变量：
  {"gte": ["变量id", 数字]}（同类的还有 gt、lt、lte、eq、ne），{"flag": "布尔变量id"}，{"visited": "幕id"}，
  {"all": [条件, …]}，{"any": [条件, …]}，{"not": 条件}。
  条件主要用在通往不同结局的出口上。一幕的出口全都带条件时，要用 default 指定一个不带条件的出口兜底。
- 所有幕都要能从第一幕（列表里的第一个）走到，每一条路最后都要走到结局。岔路之后可以重新汇合，不要让分支无限分叉。`;

const pad = (n: number) => String(n).padStart(2, '0');

export interface GraphContext {
  world: Pick<WorldData, 'characters' | 'locations'>;
  /** 已有的变量（续写时只能用已有的变量；创世时模型自己定义）。 */
  variables?: readonly VariableDef[];
  /** 续写：新幕的编号从这里之后开始，新章的编号从 chapterOffset 之后开始。 */
  sceneOffset?: number;
  chapterOffset?: number;
  /** 续写：已有的幕（条件和出口可以引用它们，但不能修改）。 */
  known?: readonly { id: string; title?: string }[];
}

export interface GraphResult {
  graph: PlotGraph;
  /** 模型自己定义的变量（创世）；续写时为空。 */
  variables: VariableDef[];
  /** 转换时发现、需要模型改的问题。 */
  problems: string[];
}

function toVariable(v: GraphOut['variables'][number], problems: string[]): VariableDef | null {
  const id = String(v.id).trim().toLowerCase();
  if (!VarId.safeParse(id).success) {
    problems.push(`变量 id「${v.id}」不合法：只能用小写字母、数字、下划线和点，以字母开头`);
    return null;
  }
  const relationship = v.category === 'relationship';
  const min = v.min ?? (relationship ? 0 : undefined);
  const max = v.max ?? (relationship ? 100 : undefined);
  let initial: number | boolean;
  if (v.type === 'boolean') initial = v.initial === true || v.initial === 'true';
  else {
    const n = Number(v.initial);
    initial = Number.isFinite(n) ? n : (min ?? 0);
    if (min !== undefined) initial = Math.max(min, initial);
    if (max !== undefined) initial = Math.min(max, initial);
  }
  const parsed = VariableDef.safeParse({
    id,
    label: v.label || id,
    type: v.type,
    initial,
    ...(v.type === 'number' && min !== undefined ? { min } : {}),
    ...(v.type === 'number' && max !== undefined ? { max } : {}),
    category: v.type === 'boolean' && v.category !== 'other' ? 'other' : v.category,
  });
  if (!parsed.success) {
    problems.push(`变量 ${id} 的定义有问题`);
    return null;
  }
  return parsed.data;
}

/** 把模型写的剧情图转成正式格式：重新编号、名字换成 id、条件按结构解析。 */
export function toGraph(value: GraphOut, ctx: GraphContext): GraphResult {
  const problems: string[] = [];
  const sceneOffset = ctx.sceneOffset ?? 0;
  const chapterOffset = ctx.chapterOffset ?? 0;
  const known = ctx.known ?? [];

  // 变量：续写时只能用已有的
  let variables: VariableDef[] = [];
  if (!ctx.variables) {
    const seen = new Set<string>();
    for (const v of value.variables) {
      const def = toVariable(v, problems);
      if (!def || seen.has(def.id)) continue;
      seen.add(def.id);
      variables.push(def);
    }
  } else variables = [...ctx.variables];

  // 章：按顺序编号；幕的 chapter 可以写序号（从 1 开始）、章的标题或 id
  const chapters = value.chapters.map((c, i) => ({ id: `ch_${pad(chapterOffset + i + 1)}`, title: c.title || `第 ${chapterOffset + i + 1} 章` }));
  const chapterOf = (raw: string): string | undefined => {
    const t = raw.trim();
    if (!t) return chapters[0]?.id;
    const n = Number(/\d+/.exec(t)?.[0]);
    const byTitle = chapters.find((c) => c.title === t || c.id === t);
    if (byTitle) return byTitle.id;
    if (Number.isInteger(n) && n >= 1) return chapters[n - 1]?.id ?? chapters.at(-1)?.id;
    return chapters[0]?.id;
  };

  // 幕：按顺序重新编号，记下模型写的 id 和标题对应到哪个新 id
  const ids = new Map<string, string>();
  value.scenes.forEach((s, i) => {
    const id = `sc_${pad(sceneOffset + i + 1)}`;
    if (!ids.has(s.id.trim())) ids.set(s.id.trim(), id);
    if (s.title.trim() && !ids.has(s.title.trim())) ids.set(s.title.trim(), id);
  });
  const knownIds = new Set(known.map((k) => k.id));
  const resolve = (raw: string): string | undefined => {
    const t = raw.trim();
    if (ids.has(t)) return ids.get(t);
    if (knownIds.has(t)) return t;
    return known.find((k) => k.title && k.title === t)?.id;
  };

  /** 条件里引用的幕 id 也要换成新的 id。 */
  const remapCondition = (c: unknown): unknown => {
    if (Array.isArray(c)) return c.map(remapCondition);
    if (typeof c !== 'object' || c === null) return c;
    const o = c as Record<string, unknown>;
    if (typeof o.visited === 'string') return { visited: resolve(o.visited) ?? o.visited };
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, k === 'all' || k === 'any' || k === 'not' ? remapCondition(v) : v]));
  };

  const scenes: PlotScene[] = value.scenes.map((raw, i) => {
    const id = `sc_${pad(sceneOffset + i + 1)}`;
    const name = raw.title || id;
    const exits: PlotExit[] = [];
    if (!raw.ending) {
      for (const e of raw.exits) {
        const to = resolve(e.to);
        if (!to) {
          problems.push(`幕「${name}」的出口指向不存在的幕「${e.to}」`);
          continue;
        }
        if (exits.some((x) => x.to === to)) continue;
        let cond: Condition | undefined;
        if (e.if !== undefined && e.if !== null && e.if !== '' && !(typeof e.if === 'object' && !Object.keys(e.if).length)) {
          const c = Condition.safeParse(remapCondition(e.if));
          if (c.success) cond = c.data;
          else problems.push(`幕「${name}」去「${e.to}」的条件 ${JSON.stringify(e.if)} 写法不对，只能用规定的 JSON 结构`);
        }
        exits.push({ to, label: e.label, when: e.when, ...(cond ? { if: cond } : {}), auto: e.auto && !!cond, set: [] });
      }
      if (exits.length > PLOT_LIMITS.exits) problems.push(`幕「${name}」有 ${exits.length} 个出口，最多 ${PLOT_LIMITS.exits} 个`);
    }
    const def = raw.default.trim() ? resolve(raw.default) : undefined;
    const location = raw.location.trim() ? matchByName(raw.location, [...ctx.world.locations])?.id : undefined;
    const cast = [...new Set(raw.cast.flatMap((n) => matchByName(n, [...ctx.world.characters])?.id ?? []))];
    return PlotScene.parse({
      id,
      chapter: chapterOf(raw.chapter),
      title: raw.title,
      what: raw.what,
      points: raw.points.slice(0, PLOT_LIMITS.points).map((t, n) => ({ id: `${id}_${n + 1}`, text: t })),
      done: raw.done,
      ...(location ? { location } : {}),
      cast,
      exits,
      // default 必须是本幕不带条件的出口，不是的话直接去掉（结构检查会提醒"可能卡住"）
      ...(def && exits.some((x) => x.to === def && !x.if && !x.auto) ? { default: def } : {}),
      ...(raw.ending ? { ending: raw.ending } : {}),
    });
  });

  const graph: PlotGraph = {
    formatVersion: 1,
    premise: value.premise,
    control: 'guided',
    start: scenes[0]?.id ?? 'sc_01',
    chapters: chapters.length ? chapters : [{ id: `ch_${pad(chapterOffset + 1)}`, title: `第 ${chapterOffset + 1} 章` }],
    scenes,
    threads: value.threads.map((t, i) => ({ id: `thread_${pad(i + 1)}`, text: t.text, ...(t.payoff ? { payoff: t.payoff } : {}) })),
    _meta: { locked: [] },
  };
  if (!chapters.length) for (const s of graph.scenes) s.chapter = graph.chapters[0]?.id;
  return { graph, variables, problems };
}

/** 结构检查的错误写成一句话（幕用标题，方便模型对上）。 */
function issueText(graph: PlotGraph, i: PlotIssue): string {
  const s = i.scene ? graph.scenes.find((x) => x.id === i.scene) : undefined;
  return s ? `幕「${s.title || s.id}」（${s.id}）：${i.message}` : i.message;
}

/** 转换 + 结构检查。有问题时 problem 是给模型看的修改意见。 */
export function checkGraphOut(value: GraphOut, ctx: GraphContext): GraphResult & { problem: string | null } {
  const r = toGraph(value, ctx);
  const check = checkPlot({
    graph: r.graph,
    variables: r.variables,
    characters: ctx.world.characters,
    locations: ctx.world.locations,
    ...(ctx.known ? { known: new Set(ctx.known.map((k) => k.id)) } : {}),
  });
  const all = [...r.problems, ...check.errors.map((e) => issueText(r.graph, e))];
  return { ...r, problem: all.length ? `剧情图有这些问题，请修改：\n${all.map((x) => `- ${x}`).join('\n')}` : null };
}

/** 剧情图给模型看的样子（续写时让导演知道已经有哪些幕）。 */
export function renderScenes(scenes: readonly PlotScene[]): string {
  return scenes
    .map((s) => {
      const head = `- ${s.id}「${s.title || s.id}」${s.ending ? `（结局：${s.ending.kind}）` : ''}：${s.what}`;
      return head;
    })
    .join('\n');
}
