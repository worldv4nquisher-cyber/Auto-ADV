/**
 * 剧情 ADV 周目：把 runner.ts 算出的新事件写进事件树（play.db），并记下跨周目的解锁（16.8）。
 * M3 第 1 步只给命令行和测试用；第 2 步接到 PlayService 和界面。
 */
import type { PlayMode, PlotGraph } from '@auto-adv/schema';
import type { PlayEvent } from '../api.ts';
import type { PlayDb, UnlockRow } from '../play/db.ts';
import { shortId } from '../util.ts';
import type { WorldData } from '../world/store.ts';
import { type AdvParseResult, parseAdv } from './adv.ts';
import { checkPlot, type PlotCheckResult } from './check.ts';
import { foldPlot, type PlotState } from './progress.ts';
import { type AdvAction, type AdvWorld, compileScript, type Program, stepAdv } from './runner.ts';

/** 解析世界里的手写剧本。 */
export function parseScripts(world: Pick<WorldData, 'scripts'>): Map<string, AdvParseResult> {
  return new Map(Object.entries(world.scripts).map(([id, text]) => [id, parseAdv(text)]));
}

/** 对一个世界的剧情图做结构检查（带上手写剧本、角色和地点）。 */
export function checkWorldPlot(
  world: Pick<WorldData, 'graph' | 'variables' | 'scripts' | 'characters' | 'locations'>,
): PlotCheckResult | null {
  if (!world.graph) return null;
  return checkPlot({
    graph: world.graph,
    variables: world.variables,
    scripts: parseScripts(world),
    characters: world.characters,
    locations: world.locations,
  });
}

export interface LoadedAdv {
  adv: AdvWorld;
  check: PlotCheckResult;
}

/** 准备 ADV 周目要用的东西：结构检查有错误时抛出（有错误时不能开始 ADV 周目）。 */
export function loadAdvWorld(world: WorldData, mode: PlayMode = 'adv'): LoadedAdv {
  if (!world.graph) throw new Error('这个世界还没有剧情图');
  const check = checkWorldPlot(world) as PlotCheckResult;
  if (!check.ok) {
    const first = check.errors
      .slice(0, 3)
      .map((e) => `${e.scene ? `${e.scene}${e.line ? `:${e.line}` : ''} ` : ''}${e.message}`)
      .join('；');
    throw new Error(`剧情图没有通过结构检查（${check.errors.length} 个错误）：${first}`);
  }
  const programs = new Map<string, Program>();
  for (const [id, parsed] of parseScripts(world)) programs.set(id, compileScript(parsed.commands));
  return {
    adv: { graph: world.graph, variables: world.variables, programs, characters: world.characters, mode },
    check,
  };
}

export interface EndingProgress {
  /** 已达成的结局数。 */
  reached: number;
  /** 结局总数：隐藏结局达成前不计入。 */
  total: number;
  endings: { id: string; title: string; kind: string; hidden: boolean; reached: boolean }[];
}

export function endingProgress(graph: PlotGraph, unlocks: readonly UnlockRow[]): EndingProgress {
  const got = new Set(unlocks.filter((u) => u.kind === 'ending').map((u) => u.id));
  const endings = graph.scenes.flatMap((s) =>
    s.ending
      ? [{ id: s.id, title: s.title || s.id, kind: s.ending.kind, hidden: s.ending.hidden, reached: got.has(s.id) }]
      : [],
  );
  return {
    reached: endings.filter((e) => e.reached).length,
    total: endings.filter((e) => !e.hidden || e.reached).length,
    endings,
  };
}

export interface ActResult {
  /** 写进事件树的新事件（按顺序，每个接在前一个后面）。 */
  events: PlayEvent[];
  /** 这一步第一次解锁的东西。 */
  unlocked: UnlockRow[];
  state: PlotState;
}

export interface AdvSessionOptions {
  newId?: (prefix: string) => string;
  now?: () => number;
}

export class AdvSession {
  readonly db: PlayDb;
  readonly adv: AdvWorld;
  private readonly newId: (prefix: string) => string;
  private readonly now: () => number;

  constructor(db: PlayDb, adv: AdvWorld, opts: AdvSessionOptions = {}) {
    this.db = db;
    this.adv = adv;
    this.newId = opts.newId ?? shortId;
    this.now = opts.now ?? Date.now;
  }

  /** 开一个新周目，返回周目 id。树根是一个空的开场事件，第一拍由 next() 演出。 */
  start(title: string, protagonistId: string | null = null): string {
    const now = this.now();
    const start = this.adv.graph.scenes.find((s) => s.id === this.adv.graph.start);
    const root: PlayEvent = {
      id: this.newId('ev'),
      parentId: null,
      kind: 'opening',
      createdAt: now,
      segments: [],
      scene: { locationId: start?.location ?? null, presentCharacterIds: start?.cast ?? [] },
    };
    const id = this.newId('pt');
    this.db.createPlaythrough(
      { id, title, mode: 'adv', protagonistId, headId: root.id, createdAt: now, updatedAt: now, data: {} },
      root,
    );
    return id;
  }

  path(pt: string, at?: string): PlayEvent[] {
    return this.db.path(pt, at ?? this.db.getPlaythrough(pt).headId);
  }

  state(pt: string, at?: string): PlotState {
    return foldPlot(this.adv.graph, this.adv.variables, this.path(pt, at));
  }

  /** 往下演一拍（等选择时会报错）。 */
  next(pt: string): ActResult {
    return this.act(pt, { kind: 'continue' });
  }

  /** 选第 index 个选项（从 0 开始），并演出选完之后的一拍。 */
  choose(pt: string, index: number): ActResult {
    return this.act(pt, { kind: 'choose', index });
  }

  /** 回到某个事件（之后的内容保留为分支）。回到岔路那一拍再选另一项，就是换一条路。 */
  rewind(pt: string, eventId: string): PlotState {
    this.db.setHead(pt, eventId);
    return this.state(pt);
  }

  private act(pt: string, action: AdvAction): ActResult {
    const head = this.db.getPlaythrough(pt).headId;
    const state = foldPlot(this.adv.graph, this.adv.variables, this.db.path(pt, head));
    const step = stepAdv(this.adv, state, action, { playthroughId: pt, headId: head });
    const events: PlayEvent[] = [];
    let parent = head;
    const now = this.now();
    for (const d of step.events) {
      const e: PlayEvent = { ...d, id: this.newId('ev'), parentId: parent, createdAt: now };
      events.push(e);
      parent = e.id;
    }
    this.db.appendEvents(pt, events);
    const unlocked: UnlockRow[] = [];
    for (const u of step.unlocks) {
      const row: UnlockRow = {
        kind: u.kind,
        id: u.id,
        firstAt: now,
        playthroughId: pt,
        eventId: (events[u.event] as PlayEvent).id,
      };
      if (this.db.unlock(row)) unlocked.push(row);
    }
    return { events, unlocked, state: this.state(pt) };
  }
}
