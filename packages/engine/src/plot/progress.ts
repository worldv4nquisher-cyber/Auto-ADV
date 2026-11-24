/**
 * 从事件折叠出剧情图上的进度（docs/ARCHITECTURE.md 16.2）：在哪一幕、演了几拍、演到哪些要点、走过哪些幕、
 * 变量的值、这一幕最近一次检定、剧本播到哪里、是不是在等玩家选择。
 * 全部记在事件上，所以回退、换分支、重抽、读档之后进度自动正确，不需要另存。
 *
 * 续写（观察模式剧情图走完后导演续写的篇章）也记在事件上：折叠时把追加的幕接到世界的剧情图后面，
 * 得到"这个周目的剧情图"。已有的幕永远不改（先承诺，后判定）。
 */
import { type LegacyAct, type PlotGraph, PlotScene, type VariableDef } from '@auto-adv/schema';
import type { PlayEvent, PlotAppend, PlotMark, PlotMenu } from '../api.ts';
import type { CheckResult } from './dice.ts';
import { initialValues, type VarValues } from './vars.ts';

export interface PlotState {
  /** 这个周目的剧情图：世界的剧情图，加上路径上续写追加的幕。 */
  graph: PlotGraph;
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
   * 玩家刚选了剧本里或 AI 给的选项，选完之后的内容还没演（正常情况下和选项一起生成，只有中途失败或回退到选项事件上才会停在这里）。
   * parentId 是选项事件的父事件（检定的种子），rolled 表示检定已经掷过了。
   */
  pendingChoice: { index: number; parentId: string | null; rolled: boolean; source: 'script' | 'ai'; label: string } | null;
  /** 剧情 ADV：玩家刚输入了一句自由行动，还没演。 */
  pendingInput: string | null;
  /** 达成的结局（结局幕 id；续写之后再达成的结局会覆盖它）。 */
  ending: string | null;
  /** 结局幕演完，剧情图走完了（续写追加新的幕之后又变回 false）。 */
  finished: boolean;
  /** 上一拍被驳回或截断的理由。 */
  notes: string[];
  /** 导演连续几拍标记了"偏离当前幕"（换幕、玩家处理过跑偏之后清零）。 */
  offTrack: number;
  /** 剧情 ADV：上一拍之后要问玩家跑偏了怎么处理（16.6），回答之前不能往下演。 */
  driftAsk: boolean;
  /** 剧情 ADV：玩家选了"拉回来"或者恢复了剧情图，下一拍要把场面带回当前幕。 */
  pullBack: boolean;
  /** 剧情 ADV：玩家选了"不用管"，这一幕不再提醒跑偏。 */
  driftIgnored: boolean;
  /** 剧情 ADV：剧情图暂停中，按玩家的行动自由推进，不换幕、不算拍数。 */
  paused: boolean;
  /** 路径上续写追加的章和幕（按追加顺序）。 */
  appended: PlotAppend;
}

export function initialPlotState(graph: PlotGraph, variables: readonly VariableDef[]): PlotState {
  const start = graph.scenes.find((s) => s.id === graph.start) ?? null;
  return {
    graph,
    scene: start,
    sceneBeats: 0,
    points: new Set(),
    visited: start ? [start.id] : [],
    vars: initialValues(variables),
    lastCheck: null,
    pc: null,
    menu: null,
    pendingChoice: null,
    pendingInput: null,
    ending: null,
    finished: false,
    notes: [],
    offTrack: 0,
    driftAsk: false,
    pullBack: false,
    driftIgnored: false,
    paused: false,
    appended: { chapters: [], scenes: [] },
  };
}

function enter(s: PlotState, to: string): void {
  s.scene = s.graph.scenes.find((x) => x.id === to) ?? null;
  s.sceneBeats = 0;
  s.pc = null;
  s.menu = null;
  s.lastCheck = null;
  s.offTrack = 0;
  s.driftAsk = false;
  s.pullBack = false;
  s.driftIgnored = false;
  s.visited.push(to);
}

/** 剧情图暂停或换到新的幕之后，上一拍的选项里带着出口的去掉（那些出口属于原来的幕）。 */
function withoutExits(menu: PlotMenu | null): PlotMenu | null {
  if (!menu || menu.source !== 'ai') return null;
  const options = menu.options.filter((o) => !o.exit);
  return options.some((o) => o.enabled) ? { ...menu, options } : null;
}

function applyMark(s: PlotState, m: PlotMark): void {
  for (const c of m.vars ?? []) s.vars[c.var] = c.to;
  if (m.exit) enter(s, m.exit.to);
}

/** 把追加的章和幕接到这个周目的剧情图上（id 重复的忽略：已有的幕不能改）。 */
export function appendToGraph(s: PlotState, add: PlotAppend): void {
  const sceneIds = new Set(s.graph.scenes.map((x) => x.id));
  const chapterIds = new Set(s.graph.chapters.map((x) => x.id));
  const scenes = add.scenes.filter((x) => !sceneIds.has(x.id));
  const chapters = add.chapters.filter((x) => !chapterIds.has(x.id));
  if (!scenes.length && !chapters.length) return;
  s.graph = { ...s.graph, chapters: [...s.graph.chapters, ...chapters], scenes: [...s.graph.scenes, ...scenes] };
  s.appended = { chapters: [...s.appended.chapters, ...chapters], scenes: [...s.appended.scenes, ...scenes] };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** <prefix>_NN 形式的 id 用到的最大编号（续写的新幕、新章从下一个编号开始）。 */
export function maxIdNumber(items: readonly { id: string }[], prefix: string): number {
  let n = 0;
  const re = new RegExp(`^${prefix}_(\\d+)$`);
  for (const s of items) {
    const m = re.exec(s.id);
    if (m) n = Math.max(n, Number(m[1]));
  }
  return n;
}

/**
 * M2 观察模式续写的篇章（beat.arc）折叠成追加的幕：每个章节一幕，按顺序串起来，最后一幕通往世界原有的结局。
 * 节拍 id 原样保留为要点 id（超过 5 个的丢掉），所以旧事件里"完成了哪些节拍"不用改。
 */
export function legacyArcAppend(graph: PlotGraph, arc: LegacyAct): PlotAppend {
  let n = maxIdNumber(graph.scenes, 'sc');
  const endings = graph.scenes.filter((s) => s.ending).map((s) => s.id);
  const scenes = arc.chapters.map((ch) =>
    PlotScene.parse({
      id: `sc_${pad(++n)}`,
      chapter: arc.id,
      title: ch.title,
      what: ch.goal,
      points: ch.beats.slice(0, 5).map((b) => ({ id: b.id, text: b.text })),
    }),
  );
  scenes.forEach((s, i) => {
    const next = scenes[i + 1];
    s.exits = next ? [{ to: next.id, label: '', when: '', auto: false, set: [] }] : endings.map((to) => ({ to, label: '', when: '', auto: false, set: [] }));
  });
  return { chapters: [{ id: arc.id, title: arc.title }], scenes };
}

export function cloneState(s: PlotState): PlotState {
  return {
    ...s,
    pendingChoice: s.pendingChoice && { ...s.pendingChoice },
    points: new Set(s.points),
    visited: [...s.visited],
    vars: { ...s.vars },
    notes: [...s.notes],
    appended: { chapters: [...s.appended.chapters], scenes: [...s.appended.scenes] },
  };
}

/** 续写：接上新的章和幕，从新篇章的起始幕开始（和折叠记了 append 的那一拍时一样）。返回新的状态。 */
export function continueWith(s: PlotState, add: PlotAppend, start: string): PlotState {
  const n = cloneState(s);
  appendToGraph(n, add);
  n.finished = false;
  enter(n, start);
  return n;
}

/** 拍事件（script / ai）是不是记了剧情图进度。 */
const isBeat = (e: PlayEvent) => (e.kind === 'script' || e.kind === 'ai') && !!e.plot;

/** 把一个事件折叠进状态（原地修改并返回）。生成新的一拍时也用它把刚产生的事件"预演"进状态。 */
export function reducePlot(s: PlotState, e: PlayEvent): PlotState {
  if (e.kind === 'drift') {
    // 剧情 ADV 跑偏时玩家的选择（16.6）：上一拍的选项留着，玩家接着选
    s.driftAsk = false;
    s.offTrack = 0;
    if (e.drift === 'pull' || e.drift === 'resume') s.pullBack = true;
    if (e.drift === 'ignore') s.driftIgnored = true;
    if (e.drift === 'pause') {
      s.paused = true;
      s.menu = withoutExits(s.menu);
    }
    if (e.drift === 'resume') s.paused = false;
    if (e.plot?.append) appendToGraph(s, e.plot.append);
    if (e.plot?.exit) {
      // 就这样走：跑偏的这一段成了新的一幕，从这里进去
      const menu = s.menu;
      applyMark(s, e.plot);
      s.menu = withoutExits(menu);
    }
    return s;
  }
  if (e.kind === 'check' && e.check) {
    s.lastCheck = e.check;
    if (s.pendingChoice) s.pendingChoice.rolled = true;
    return s;
  }
  if (e.kind === 'choice') {
    const source = s.menu?.source;
    s.menu = null;
    s.pendingInput = null;
    const index = e.choice?.index;
    // 岔路选项选完就换幕；剧本和 AI 的选项选完之后还要演一拍
    const done = index === undefined || source === 'exits' || (!source && !!e.plot?.exit);
    s.pendingChoice = done
      ? null
      : { index, parentId: e.parentId, rolled: false, source: source === 'ai' ? 'ai' : 'script', label: e.choice?.label ?? '' };
    if (e.plot) applyMark(s, e.plot);
    return s;
  }
  if (e.kind === 'player') {
    s.menu = null;
    s.pendingChoice = null;
    s.pendingInput = e.text ?? '';
    return s;
  }
  if (!isBeat(e)) return s;
  const m = e.plot as PlotMark;
  if (m.append) {
    appendToGraph(s, m.append);
    s.finished = false;
  }
  if (m.scene !== s.scene?.id) enter(s, m.scene); // 续写、剧情图被改过等情况：以事件记录为准
  if (e.check) s.lastCheck = e.check; // 导演安排里的检定，和这一拍记在同一个事件上
  s.pendingChoice = null;
  s.pendingInput = null;
  if (m.points) for (const p of m.points) s.points.add(p);
  // 剧情图暂停时演的拍不算这一幕的拍数（恢复之后这一幕的节奏照旧）
  if (!m.paused) s.sceneBeats += 1;
  s.pc = m.pc ?? s.pc;
  s.menu = m.menu ?? null;
  s.notes = m.notes ?? [];
  s.offTrack = m.offTrack ? s.offTrack + 1 : 0;
  s.driftAsk = !!m.askDrift;
  s.pullBack = false;
  if (m.ending) s.ending = m.ending;
  if (m.finished) s.finished = true;
  applyMark(s, m);
  return s;
}

/**
 * 折叠整条路径。
 * 兼容 M2 观察模式的周目（16.7）：旧的"完成了哪些节拍"就是迁移后的要点 id，续写的篇章（beat.arc）接到剧情图后面；
 * 路径上还没有任何剧情图记录时，当前幕 = 第一个还有要点没演完的幕（和 M2 的"当前章节"规则一致）。
 */
export function foldPlot(graph: PlotGraph, variables: readonly VariableDef[], path: readonly PlayEvent[]): PlotState {
  const s = initialPlotState(graph, variables);
  let marked = false;
  let legacy = false;
  for (const e of path) {
    if (e.plot) marked = true;
    else if (e.kind === 'ai' && e.beat) {
      if (e.beat.arc) appendToGraph(s, legacyArcAppend(s.graph, e.beat.arc));
      for (const id of e.beat.done ?? []) {
        s.points.add(id);
        legacy = true;
      }
    }
    reducePlot(s, e);
  }
  if (!marked && legacy) {
    const plain = s.graph.scenes.filter((x) => !x.ending);
    const current = plain.find((x) => x.points.some((p) => !s.points.has(p.id))) ?? plain.at(-1) ?? null;
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

/** 在这个周目的剧情图里按 id 找幕。 */
export function sceneById(s: PlotState, id: string): PlotScene | undefined {
  return s.graph.scenes.find((x) => x.id === id);
}
