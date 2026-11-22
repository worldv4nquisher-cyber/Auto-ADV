/**
 * 从事件折叠出剧情图上的进度（docs/ARCHITECTURE.md 16.2）：在哪一幕、演了几拍、演到哪些要点、走过哪些幕、
 * 变量的值、这一幕最近一次检定、剧本播到哪里、是不是在等玩家选择。
 * 全部记在事件上，所以回退、换分支、重抽、读档之后进度自动正确，不需要另存。
 */
import type { PlotGraph, PlotScene, VariableDef } from '@auto-adv/schema';
import type { PlayEvent, PlotMark, PlotMenu } from '../api.ts';
import type { CheckResult } from './dice.ts';
import { initialValues, type VarValues } from './vars.ts';

export interface PlotState {
  /** 当前所在的幕；剧情图里找不到（被改过）时为 null。 */
  scene: PlotScene | null;
  /** 当前幕里已经演了几拍。 */
  sceneBeats: number;
  /** 演到过的要点（整个路径）。 */
  points: Set<string>;
  /** 走过的幕，按进入顺序（含当前幕）。 */
  visited: string[];
  vars: VarValues;
  /** 这一幕最近一次检定。 */
  lastCheck: CheckResult | null;
  /** 当前幕的手写剧本播到哪里：null 还没开始，-1 播完了。 */
  pc: number | null;
  /** 等玩家选择的选项。 */
  menu: PlotMenu | null;
  /**
   * 玩家刚选了剧本里的选项，选完之后的内容还没演（正常情况下和选项一起生成，只有中途失败或回退到选项事件上才会停在这里）。
   * parentId 是选项事件的父事件（检定的种子），rolled 表示检定已经掷过了。
   */
  pendingChoice: { index: number; parentId: string | null; rolled: boolean } | null;
  /** 达成的结局（结局幕 id）。 */
  ending: string | null;
  /** 结局幕演完，剧情图走完了。 */
  finished: boolean;
  /** 上一拍被驳回或截断的理由。 */
  notes: string[];
}

export function initialPlotState(graph: PlotGraph, variables: readonly VariableDef[]): PlotState {
  const start = graph.scenes.find((s) => s.id === graph.start) ?? null;
  return {
    scene: start,
    sceneBeats: 0,
    points: new Set(),
    visited: start ? [start.id] : [],
    vars: initialValues(variables),
    lastCheck: null,
    pc: null,
    menu: null,
    pendingChoice: null,
    ending: null,
    finished: false,
    notes: [],
  };
}

function enter(graph: PlotGraph, s: PlotState, to: string): void {
  s.scene = graph.scenes.find((x) => x.id === to) ?? null;
  s.sceneBeats = 0;
  s.pc = null;
  s.menu = null;
  s.lastCheck = null;
  s.visited.push(to);
}

function applyMark(graph: PlotGraph, s: PlotState, m: PlotMark): void {
  for (const c of m.vars ?? []) s.vars[c.var] = c.to;
  if (m.exit) enter(graph, s, m.exit.to);
}

/** 拍事件（script / ai）是不是记了剧情图进度。 */
const isBeat = (e: PlayEvent) => (e.kind === 'script' || e.kind === 'ai') && !!e.plot;

/** 把一个事件折叠进状态（原地修改并返回）。生成新的一拍时也用它把刚产生的事件"预演"进状态。 */
export function reducePlot(graph: PlotGraph, s: PlotState, e: PlayEvent): PlotState {
  if (e.kind === 'check' && e.check) {
    s.lastCheck = e.check;
    if (s.pendingChoice) s.pendingChoice.rolled = true;
    return s;
  }
  if (e.kind === 'choice') {
    s.menu = null;
    const index = e.choice?.index;
    s.pendingChoice = e.plot?.exit || index === undefined ? null : { index, parentId: e.parentId, rolled: false };
    if (e.plot) applyMark(graph, s, e.plot);
    return s;
  }
  if (!isBeat(e)) return s;
  const m = e.plot as PlotMark;
  if (m.scene !== s.scene?.id) enter(graph, s, m.scene); // 剧情图被改过等异常情况：以事件记录为准
  s.pendingChoice = null;
  if (m.points) for (const p of m.points) s.points.add(p);
  s.sceneBeats += 1;
  s.pc = m.pc ?? s.pc;
  s.menu = m.menu ?? null;
  s.notes = m.notes ?? [];
  if (m.ending) s.ending = m.ending;
  if (m.finished) s.finished = true;
  applyMark(graph, s, m);
  return s;
}

/**
 * 折叠整条路径。
 * 兼容 M2 观察模式的周目（16.7）：路径上没有任何剧情图记录、只有旧的"完成了哪些节拍"时，
 * 节拍 id 就是迁移后的要点 id，当前幕 = 第一个还有要点没演完的幕（和 M2 的"当前章节"规则一致）。
 */
export function foldPlot(graph: PlotGraph, variables: readonly VariableDef[], path: readonly PlayEvent[]): PlotState {
  const s = initialPlotState(graph, variables);
  let marked = false;
  const legacyDone = new Set<string>();
  for (const e of path) {
    if (e.plot) marked = true;
    else if (e.kind === 'ai') for (const id of e.beat?.done ?? []) legacyDone.add(id);
    reducePlot(graph, s, e);
  }
  if (!marked && legacyDone.size) {
    const plain = graph.scenes.filter((x) => !x.ending);
    const current = plain.find((x) => x.points.some((p) => !legacyDone.has(p.id))) ?? plain.at(-1) ?? null;
    s.points = legacyDone;
    if (current) {
      s.scene = current;
      s.visited = plain.slice(0, plain.indexOf(current) + 1).map((x) => x.id);
    }
  }
  return s;
}

/** 这一幕的剧本播完了、没有选项、也没走：在没有 AI 接手的情况下就卡住了。 */
export function isStuck(s: PlotState): boolean {
  return !!s.scene && !s.finished && !s.menu && s.pc === -1 && s.pendingChoice === null;
}
