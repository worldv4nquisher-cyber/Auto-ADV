import type { PlayEvent, PlotProgress, SceneState } from '../api.ts';
import { foldPlot, type PlotState } from '../plot/progress.ts';
import type { WorldData } from '../world/store.ts';
import { sceneAt } from './context.ts';

/** 把路径上的事件折叠成当前的故事状态（事件溯源：状态永远可以从事件重新算出来）。 */
export interface StoryState {
  scene: SceneState;
  /** 剧情图上的进度（含续写追加的幕）；世界没有剧情图时为 null，导演自由发挥。 */
  plot: PlotState | null;
  time: string | null;
  /** 连续多少拍没有推进剧情（演到要点、换幕、续写）、也没有换地点。 */
  beatsSinceProgress: number;
  recentCards: string[];
  /** 秘密的主人 → 已经知道这个秘密的角色。 */
  reveals: Map<string, Set<string>>;
  /** 上一拍之后观众下的导演指令（下一拍要处理）。 */
  directives: PlayEvent[];
  /** 上一拍之后观众对角色说的悄悄话。 */
  whispers: PlayEvent[];
}

export function foldState(world: WorldData, path: PlayEvent[]): StoryState {
  let time: string | null = null;
  let beatsSinceProgress = 0;
  const cards: string[] = [];
  const reveals = new Map<string, Set<string>>();
  let directives: PlayEvent[] = [];
  let whispers: PlayEvent[] = [];
  let location: string | null = null;

  for (const e of path) {
    if (e.kind === 'directive') directives.push(e);
    if (e.kind === 'whisper') whispers.push(e);
    if (e.kind === 'player') beatsSinceProgress = 0;
    if (e.kind === 'opening') location = e.scene?.locationId ?? null;
    if (e.kind === 'scene') {
      location = e.scene?.locationId ?? location;
      beatsSinceProgress = 0;
    }
    if (e.kind !== 'ai') continue;
    directives = [];
    whispers = [];
    const b = e.beat;
    if (!b) continue;
    if (b.time) time = b.time;
    if (b.card) cards.push(b.card);
    for (const r of b.reveals ?? []) {
      const set = reveals.get(r.characterId) ?? new Set<string>();
      for (const to of r.to) set.add(to);
      reveals.set(r.characterId, set);
    }
    const moved = !!e.scene && e.scene.locationId !== location;
    if (e.scene) location = e.scene.locationId;
    const p = e.plot;
    const advanced = !!p?.points?.length || !!p?.exit || !!p?.append || !!p?.ending || (b.done?.length ?? 0) > 0;
    beatsSinceProgress = advanced || moved ? 0 : beatsSinceProgress + 1;
  }

  return {
    scene: sceneAt(path),
    plot: world.graph ? foldPlot(world.graph, world.variables, path) : null,
    time,
    beatsSinceProgress,
    recentCards: cards.slice(-8),
    reveals,
    directives,
    whispers,
  };
}

export function plotProgress(s: StoryState): PlotProgress {
  const p = s.plot;
  return {
    scene: p?.scene?.id ?? null,
    sceneBeats: p?.sceneBeats ?? 0,
    points: p ? [...p.points] : [],
    visited: p ? [...p.visited] : [],
    appended: p?.appended ?? { chapters: [], scenes: [] },
    ending: p?.ending ?? null,
    finished: p?.finished ?? false,
    time: s.time,
  };
}
