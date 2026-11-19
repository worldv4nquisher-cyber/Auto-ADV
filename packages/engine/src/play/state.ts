import type { PlotOutline } from '@auto-adv/schema';
import type { PlayEvent, PlotProgress, SceneState } from '../api.ts';
import type { WorldData } from '../world/store.ts';
import { sceneAt } from './context.ts';

/** 把路径上的事件折叠成当前的故事状态（事件溯源：状态永远可以从事件重新算出来）。 */
export interface StoryState {
  scene: SceneState;
  /** 世界骨架 + 路径上续写的篇章。 */
  outline: PlotOutline | null;
  done: Set<string>;
  currentChapter: PlotOutline['acts'][number]['chapters'][number] | null;
  time: string | null;
  /** 连续多少拍没有推进骨架、也没有换地点。 */
  beatsSinceProgress: number;
  recentCards: string[];
  /** 秘密的主人 → 已经知道这个秘密的角色。 */
  reveals: Map<string, Set<string>>;
  /** 上一拍之后观众下的导演指令（下一拍要处理）。 */
  directives: PlayEvent[];
  /** 上一拍之后观众对角色说的悄悄话。 */
  whispers: PlayEvent[];
}

/** extraActs：还没写进事件树、但这一拍要用的新篇章。 */
export function foldState(
  world: WorldData,
  path: PlayEvent[],
  extraActs: PlotOutline['acts'] = [],
): StoryState {
  const done = new Set<string>();
  const acts = [...(world.plot?.acts ?? [])];
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
    if (b.arc) acts.push(b.arc);
    for (const id of b.done ?? []) done.add(id);
    if (b.time) time = b.time;
    if (b.card) cards.push(b.card);
    for (const r of b.reveals ?? []) {
      const set = reveals.get(r.characterId) ?? new Set<string>();
      for (const to of r.to) set.add(to);
      reveals.set(r.characterId, set);
    }
    const moved = !!e.scene && e.scene.locationId !== location;
    if (e.scene) location = e.scene.locationId;
    beatsSinceProgress = (b.done?.length ?? 0) > 0 || moved ? 0 : beatsSinceProgress + 1;
  }

  acts.push(...extraActs);
  const outline = world.plot ? { ...world.plot, acts } : null;
  const chapters = acts.flatMap((a) => a.chapters);
  const currentChapter = chapters.find((ch) => ch.beats.some((b) => !done.has(b.id))) ?? null;
  return {
    scene: sceneAt(path),
    outline,
    done,
    currentChapter,
    time,
    beatsSinceProgress,
    recentCards: cards.slice(-8),
    reveals,
    directives,
    whispers,
  };
}

export function plotProgress(s: StoryState): PlotProgress {
  return {
    outline: s.outline,
    done: [...s.done],
    currentChapterId: s.currentChapter?.id ?? null,
    time: s.time,
  };
}
