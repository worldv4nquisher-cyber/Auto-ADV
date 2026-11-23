import type { PlayEvent } from '../../api.ts';
import type { WorldData } from '../../world/store.ts';
import { sceneNote } from '../context.ts';
import { foldState } from '../state.ts';
import { QUALITY } from './quality.ts';

/** 一段观察模式运行的质量报告（命令行和界面都用）。 */
export interface RunReport {
  beats: number;
  /** 每拍平均字数。 */
  avgChars: number;
  /** 与之前内容的相似度：平均、最高，以及超过重复阈值的拍数。 */
  similarity: { avg: number; max: number; repeated: number };
  /** 抽到事件卡的拍数。 */
  cards: number;
  /** 最长连续多少拍没有推进剧情（演到要点、换幕、续写）、也没有换地点。 */
  longestStall: number;
  /** 导演被引擎驳回的动作数。 */
  rejected: number;
  /**
   * 剧情图：演到的要点 / 走过的幕里的要点总数、走过几幕、续写了几次、达成过的结局、当前所在的幕。
   */
  plot: { points: number; total: number; scenes: number; arcs: number; endings: string[]; currentScene: string | null };
  sceneChanges: number;
  locations: string[];
  /** 每个角色说了几句（看群像是否均衡）。 */
  speakers: { name: string; lines: number }[];
  reveals: number;
  directives: number;
  time: string | null;
}

export function analyzeRun(world: WorldData, path: PlayEvent[]): RunReport {
  const beats = path.filter((e) => e.kind === 'ai' && e.beat);
  const sims = beats.map((e) => e.beat?.similarity ?? 0);
  const chars = beats.map((e) => (e.segments ?? []).reduce((n, s) => n + [...s.text].length, 0));
  const speakers = new Map<string, number>();
  const locations = new Set<string>();
  let location: string | null = null;
  let sceneChanges = 0;
  let stall = 0;
  let longestStall = 0;
  for (const e of path) {
    const before = location;
    if (e.scene) {
      if (e.scene.locationId && e.scene.locationId !== location && location !== null) sceneChanges++;
      location = e.scene.locationId ?? location;
      if (location) locations.add(location);
    }
    if (e.kind === 'player' || e.kind === 'scene') stall = 0;
    if (e.kind !== 'ai' || !e.beat) continue;
    for (const s of e.segments ?? []) if (s.kind === 'line') speakers.set(s.name, (speakers.get(s.name) ?? 0) + 1);
    const moved = !!e.scene && e.scene.locationId !== before;
    const p = e.plot;
    const advanced = !!p?.points?.length || !!p?.exit || !!p?.append || !!p?.ending || (e.beat.done?.length ?? 0) > 0;
    stall = advanced || moved ? 0 : stall + 1;
    longestStall = Math.max(longestStall, stall);
  }
  const state = foldState(world, path);
  const plot = state.plot;
  const visited = plot ? plot.graph.scenes.filter((s) => plot.visited.includes(s.id)) : [];
  const title = (id: string) => plot?.graph.scenes.find((s) => s.id === id)?.title || id;
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    beats: beats.length,
    avgChars: beats.length ? Math.round(chars.reduce((a, b) => a + b, 0) / beats.length) : 0,
    similarity: {
      avg: sims.length ? round(sims.reduce((a, b) => a + b, 0) / sims.length) : 0,
      max: round(Math.max(0, ...sims)),
      repeated: sims.filter((s) => s >= QUALITY.repetition).length,
    },
    cards: beats.filter((e) => e.beat?.card).length,
    longestStall,
    rejected: beats.reduce((n, e) => n + (e.beat?.rejected?.length ?? 0), 0),
    plot: {
      points: plot?.points.size ?? 0,
      total: visited.reduce((n, s) => n + s.points.length, 0),
      scenes: new Set(plot?.visited ?? []).size,
      arcs: beats.filter((e) => e.plot?.append || e.beat?.arc).length,
      endings: beats.flatMap((e) => (e.plot?.ending ? [title(e.plot.ending)] : [])),
      currentScene: plot?.scene && !plot.finished ? plot.scene.title || plot.scene.id : null,
    },
    sceneChanges,
    locations: [...locations].map((id) => world.locations.find((l) => l.id === id)?.name ?? id),
    speakers: [...speakers.entries()].map(([name, lines]) => ({ name, lines })).sort((a, b) => b.lines - a.lines),
    reveals: beats.reduce((n, e) => n + (e.beat?.reveals?.length ?? 0), 0),
    directives: path.filter((e) => e.kind === 'directive').length,
    time: state.time,
  };
}

/** 整段运行的文字记录（Markdown），带导演笔记，方便人工检查。 */
export function runTranscript(world: WorldData, path: PlayEvent[]): string {
  const out: string[] = [`# ${world.manifest.title}`, ''];
  let n = 0;
  for (const e of path) {
    if (e.kind === 'opening') {
      out.push('## 开场', '', ...(e.segments ?? []).map((s) => (s.kind === 'line' ? `**${s.name}**：${s.text}` : s.text)), '');
      if (e.scene) out.push(`> ${sceneNote(world, e.scene)}`, '');
      continue;
    }
    if (e.kind === 'directive') {
      out.push(`> 🎬 导演指令：${e.text ?? ''}`, '');
      continue;
    }
    if (e.kind === 'whisper') {
      const who = world.characters.find((c) => c.id === e.characterId)?.name ?? '?';
      out.push(`> 🤫 对${who}的悄悄话：${e.text ?? ''}`, '');
      continue;
    }
    if (e.kind === 'scene' && e.scene) {
      out.push(`> ${sceneNote(world, e.scene)}`, '');
      continue;
    }
    if (e.kind === 'player') {
      const who = world.characters.find((c) => c.id === e.characterId)?.name ?? '玩家';
      out.push(`**${who}（玩家）**：${e.text ?? ''}`, '');
      continue;
    }
    n++;
    const b = e.beat;
    out.push(`## 第 ${n} 拍${b?.time ? ` · ${b.time}` : ''}`, '');
    if (b) {
      const notes = [`导演：${b.plan}`];
      const p = e.plot;
      if (b.arc) notes.push(`续写新篇章：${b.arc.title}`);
      if (p?.append) notes.push(`续写新篇章：${p.append.scenes.map((s) => s.title || s.id).join(' → ')}`);
      if (p) notes.push(`幕：${p.scene}`);
      if (b.card) notes.push(`事件卡：${b.card}`);
      if (b.done?.length) notes.push(`完成节拍：${b.done.join('、')}`);
      if (e.check) notes.push(`检定「${e.check.label}」：${e.check.roll}+${e.check.modifier} / ${e.check.dc}，${e.check.outcome}`);
      if (p?.points?.length) notes.push(`演到要点：${p.points.join('、')}`);
      if (p?.vars?.length) notes.push(`数值：${p.vars.map((c) => `${c.var} ${c.from}→${c.to}`).join('，')}`);
      if (p?.exit) notes.push(`换幕：→ ${p.exit.to}（${p.exit.by}）`);
      if (p?.ending) notes.push(`达成结局：${p.ending}`);
      if (p?.notes?.length) notes.push(`引擎：${p.notes.join('；')}`);
      for (const r of b.reveals ?? []) {
        const name = (id: string) => world.characters.find((c) => c.id === id)?.name ?? id;
        notes.push(`揭开秘密：${name(r.characterId)} → ${r.to.map(name).join('、')}`);
      }
      if (b.rejected?.length) notes.push(`驳回：${b.rejected.join('；')}`);
      if (b.similarity !== undefined) notes.push(`相似度：${b.similarity}`);
      out.push(...notes.map((x) => `> ${x}`), '');
    }
    if (e.scene) out.push(`> ${sceneNote(world, e.scene)}`, '');
    out.push(...(e.segments ?? []).map((s) => (s.kind === 'line' ? `**${s.name}**：${s.text}` : s.text)), '');
  }
  return out.join('\n');
}
