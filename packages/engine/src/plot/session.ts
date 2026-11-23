/**
 * 剧情 ADV 周目：把 runner.ts 算出的新事件写进事件树（play.db），并记下跨周目的解锁（16.8）。
 * 命令行和 PlayService（应用里的 VN 舞台）共用。
 */
import type { PlayMode, PlotEnding, PlotGraph } from '@auto-adv/schema';
import type { AdvView, PlayEvent } from '../api.ts';
import type { PlayDb, UnlockRow } from '../play/db.ts';
import { shortId } from '../util.ts';
import type { WorldData } from '../world/store.ts';
import { type AdvParseResult, parseAdv, walkScript } from './adv.ts';
import { checkPlot, type PlotCheckResult } from './check.ts';
import { foldPlot, isStuck, type PlotState } from './progress.ts';
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
  endings: { id: string; title: string; kind: PlotEnding['kind']; hidden: boolean; reached: boolean }[];
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

/** 手写剧本里出现过的所有 CG。 */
export function scriptCgs(parsed: ReadonlyMap<string, AdvParseResult>): string[] {
  const out = new Set<string>();
  for (const p of parsed.values()) walkScript(p.commands, (c) => c.op === 'cg' && out.add(c.id));
  return [...out];
}

/** 舞台第一次显示 CG 时记一笔（16.8）。这个事件的舞台指令里必须有这张 CG。返回 null 表示以前就解锁过了。 */
export function recordCgShown(db: PlayDb, pt: string, eventId: string, cg: string, now = Date.now()): UnlockRow | null {
  const ev = db.getEvent(pt, eventId);
  if (!ev.stage?.some((c) => c.op === 'cg' && c.id === cg)) throw new Error('这个事件里没有这张 CG');
  const row: UnlockRow = { kind: 'cg', id: cg, firstAt: now, playthroughId: pt, eventId };
  return db.unlock(row) ? row : null;
}

/** 剧情 ADV 周目给界面看的状态。世界的剧情图有错误时仍然给出进度，但 error 不为空、不能继续。 */
export function advView(
  world: Pick<WorldData, 'graph' | 'variables' | 'scripts' | 'characters' | 'locations'>,
  path: readonly PlayEvent[],
  unlocks: readonly UnlockRow[],
): AdvView | null {
  const g = world.graph;
  if (!g) return null;
  const check = checkWorldPlot(world) as PlotCheckResult;
  const s = foldPlot(g, world.variables, path);
  const endScene = s.ending ? g.scenes.find((x) => x.id === s.ending) : undefined;
  const chapter = s.scene?.chapter ? g.chapters.find((c) => c.id === s.scene?.chapter) : undefined;
  const prog = endingProgress(g, unlocks);
  const sceneIds = new Set(g.scenes.map((x) => x.id));
  return {
    scene: s.scene ? { id: s.scene.id, title: s.scene.title || s.scene.id, chapter: chapter ? chapter.title || chapter.id : null } : null,
    menu: s.menu,
    finished: s.finished,
    ending: endScene?.ending
      ? { id: endScene.id, title: endScene.title || endScene.id, kind: endScene.ending.kind, hidden: endScene.ending.hidden }
      : null,
    stuck: isStuck(s) ? `「${s.scene?.title || s.scene?.id}」的剧本演完了，但没有可以走的出口${s.notes.length ? `（${s.notes.join('；')}）` : ''}` : null,
    error: check.ok
      ? null
      : `剧情图没有通过结构检查：${check.errors
          .slice(0, 3)
          .map((e) => e.message)
          .join('；')}`,
    vars: { ...s.vars },
    progress: {
      endings: prog.endings.map((e) => ({ ...e, title: e.hidden && !e.reached ? '？？？' : e.title })),
      reached: prog.reached,
      total: prog.total,
      cgs: { unlocked: unlocks.filter((u) => u.kind === 'cg').map((u) => u.id), total: scriptCgs(parseScripts(world)).length },
      scenes: { visited: unlocks.filter((u) => u.kind === 'scene' && sceneIds.has(u.id)).length, total: g.scenes.length },
    },
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

  /** 舞台第一次显示了某张 CG（命令行打印出来就算显示）。 */
  markShown(pt: string, eventId: string, cg: string): UnlockRow | null {
    return recordCgShown(this.db, pt, eventId, cg, this.now());
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
