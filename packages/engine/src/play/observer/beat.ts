import type { Character, ObserverSettings } from '@auto-adv/schema';
import type { BeatMeta, ObserverChunk, PlayEvent, SceneState, Segment } from '../../api.ts';
import { toAct } from '../../genesis/pipeline.ts';
import { plotSpec } from '../../genesis/specs.ts';
import type { Meter, ModelGateway } from '../../llm/gateway.ts';
import { generateJson, stripThinking } from '../../llm/structured.ts';
import { shortId } from '../../util.ts';
import { matchByName } from '../../world/render.ts';
import type { WorldData } from '../../world/store.ts';
import { eventText, sceneAt, transcriptOf } from '../context.ts';
import type { SummaryRow } from '../db.ts';
import { parseScript, ScriptStream } from '../script.ts';
import { foldState, type StoryState } from '../state.ts';
import {
  actorMessages,
  arcPrompt,
  beatInstruction,
  DIRECTOR_SYSTEM,
  type DirectorOut,
  directorPrompt,
  directorSpec,
  narratorMessages,
  writerMessages,
} from './prompts.ts';
import { drawCard, maxSimilarity, QUALITY } from './quality.ts';

export interface BeatInput {
  gateway: ModelGateway;
  world: WorldData;
  /** 从开场到这一拍的父节点。 */
  path: PlayEvent[];
  summary: SummaryRow | null;
  settings: ObserverSettings;
  protagonist: Character | null;
  signal: AbortSignal;
  meter: Meter;
  emit: (c: ObserverChunk) => void;
}

/** 导演最多看最近这么多条原文（更早的靠前情提要）。 */
const RECENT_EVENTS = 12;

function beatText(e: PlayEvent): string {
  return (e.segments ?? []).map((s) => s.text).join('\n');
}

/** 校验导演的安排：不合法的部分丢掉并记下理由，合法的部分转换成 id。 */
export function validatePlan(world: WorldData, state: StoryState, plan: DirectorOut) {
  const rejected: string[] = [];
  let locationId = state.scene.locationId;
  if (plan.location.trim()) {
    const loc = matchByName(plan.location, world.locations);
    if (loc) locationId = loc.id;
    else rejected.push(`地点「${plan.location}」不存在，只能用给定的地点`);
  }
  let present: string[] = [];
  for (const name of plan.present) {
    const c = matchByName(name, world.characters);
    if (c) present.push(c.id);
    else rejected.push(`角色「${name}」不存在`);
  }
  present = [...new Set(present)];
  if (!present.length) present = [...state.scene.presentCharacterIds];

  const speakers: { character: Character; intent: string }[] = [];
  for (const s of plan.speakers) {
    const c = matchByName(s.name, world.characters);
    if (!c) {
      rejected.push(`角色「${s.name}」不存在`);
      continue;
    }
    if (!present.includes(c.id)) {
      // 导演让不在场的人说话：视为登场
      present.push(c.id);
    }
    speakers.push({ character: c, intent: s.intent });
  }

  const allowed = new Set(state.currentChapter?.beats.filter((b) => !state.done.has(b.id)).map((b) => b.id) ?? []);
  const done: string[] = [];
  for (const id of plan.completeBeats) {
    const clean = id.trim();
    if (!clean) continue;
    if (allowed.has(clean)) done.push(clean);
    else if (state.done.has(clean)) rejected.push(`节拍 ${clean} 已经完成过了`);
    else rejected.push(`节拍 ${clean} 不在当前章节里，不能跳着完成`);
  }

  const reveals: NonNullable<BeatMeta['reveals']> = [];
  for (const r of plan.reveals) {
    const owner = matchByName(r.owner, world.characters);
    if (!owner?.secrets.length) {
      rejected.push(`「${r.owner}」没有可以揭开的秘密`);
      continue;
    }
    const to = r.to.flatMap((n) => {
      const c = matchByName(n, world.characters);
      return c && c.id !== owner.id ? [c.id] : [];
    });
    if (to.length) reveals.push({ characterId: owner.id, to: [...new Set(to)] });
  }

  const scene: SceneState = { locationId, presentCharacterIds: present };
  return { scene, speakers, done: [...new Set(done)], reveals, rejected };
}

/** 一个角色是否亲眼见到了某个事件（事件发生时他在场）。 */
function witnessedBy(path: PlayEvent[], characterId: string): PlayEvent[] {
  const out: PlayEvent[] = [];
  let scene: SceneState = { locationId: null, presentCharacterIds: [] };
  for (const e of path) {
    if (e.scene) scene = e.scene;
    if (e.kind === 'directive') continue;
    if (e.kind === 'whisper') continue;
    if (scene.presentCharacterIds.includes(characterId) || (e.kind === 'player' && e.characterId === characterId)) out.push(e);
  }
  return out;
}

function cleanActorLine(raw: string, me: Character): string {
  let t = stripThinking(raw).trim();
  // 去掉自带的名字前缀
  t = t.replace(new RegExp(`^[【\\[［]?${me.name}[】\\]］]?[：:]?\\s*`), '');
  // 演员替别人写了台词：截断
  const cut = t.search(/\n\s*[【\[［][^】\]］]{1,24}[】\]］]/);
  if (cut > 0) t = t.slice(0, cut);
  return t
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/^[「“"](.*)[」”"]$/, '$1');
}

/** 生成一拍：导演安排 → 引擎校验 → 演出。返回待写入事件树的事件（还没有写入）。 */
export async function runBeat(p: BeatInput, parentId: string): Promise<PlayEvent> {
  const { world, gateway, settings, protagonist } = p;
  const pName = protagonist?.name ?? '主角';
  const from = p.summary ? p.path.findIndex((e) => e.id === p.summary?.eventId) + 1 : 0;
  const raw = p.path.slice(from);
  const recent = raw.slice(-RECENT_EVENTS);
  let state = foldState(world, p.path);
  const meta: BeatMeta = { plan: '', strategy: settings.strategy };

  // 1. 骨架走完了：续写新篇章
  if (state.outline && !state.currentChapter) {
    p.emit({ type: 'phase', phase: 'arc' });
    const h = await gateway.forRole('director', 'observer.arc', p.meter);
    const { value } = await generateJson(gateway, h, {
      system: DIRECTOR_SYSTEM,
      user: arcPrompt(world, state, p.summary?.text ?? null, transcriptOf(world, recent, pName)),
      spec: plotSpec,
      signal: p.signal,
    });
    meta.arc = toAct(value, state.outline.acts.length);
    state = foldState(world, p.path, [meta.arc]);
  }

  // 2. 防崩坏：上一拍和之前太像，或者好几拍没有推进
  const warnings: string[] = [];
  const lastBeat = [...raw].reverse().find((e) => e.kind === 'ai' && e.beat);
  if ((lastBeat?.beat?.similarity ?? 0) >= QUALITY.repetition) {
    warnings.push('最近一拍和之前的内容高度重复，这一拍必须换一个方向：新的事件、新的话题或换场景');
  }
  if (state.beatsSinceProgress >= QUALITY.stagnantBeats) {
    warnings.push(`剧情已经连续 ${state.beatsSinceProgress} 拍没有推进了`);
  }
  const card = warnings.length ? drawCard(state.recentCards) : null;
  if (card) meta.card = card;

  // 3. 导演
  p.emit({ type: 'phase', phase: 'director' });
  const whispers = state.whispers;
  const director = await gateway.forRole('director', 'observer.director', p.meter);
  const { value: plan } = await generateJson(gateway, director, {
    system: DIRECTOR_SYSTEM,
    user: directorPrompt({
      world,
      state,
      settings,
      memory: p.summary?.text ?? null,
      recent,
      protagonist,
      warnings,
      card,
      rejected: lastBeat?.beat?.rejected ?? [],
      whispers,
    }),
    spec: directorSpec,
    signal: p.signal,
  });
  const v = validatePlan(world, state, plan);
  meta.plan = plan.plan;
  if (plan.time.trim()) meta.time = plan.time.trim();
  if (v.done.length) meta.done = v.done;
  if (v.reveals.length) meta.reveals = v.reveals;
  if (v.rejected.length) meta.rejected = v.rejected;
  const sceneChanged =
    v.scene.locationId !== state.scene.locationId ||
    v.scene.presentCharacterIds.join() !== state.scene.presentCharacterIds.join();
  const playState: StoryState = { ...state, scene: v.scene, time: meta.time ?? state.time };
  const instruction = beatInstruction(world, plan, card);

  // 4. 演出
  let segments: Segment[] = [];
  let callId: string | null = null;
  if (settings.strategy === 'merged') {
    p.emit({ type: 'phase', phase: 'writer' });
    const h = await gateway.forRole('narrator', 'observer.writer', p.meter);
    const stream = new ScriptStream({ cast: world.characters });
    const result = await gateway.run(
      h,
      { messages: writerMessages(world, playState, p.summary?.text ?? null, p.summary?.characters ?? {}, recent, instruction, pName) },
      {
        signal: p.signal,
        onText: (d) => {
          for (const c of stream.push(d)) p.emit({ type: 'seg', ...c });
        },
      },
    );
    segments = stream.finish();
    if (!segments.length) segments = parseScript(stripThinking(result.text), { cast: world.characters });
    callId = h.lastCallId();
  } else {
    // 旁白先写开头
    p.emit({ type: 'phase', phase: 'narrator' });
    const nh = await gateway.forRole('narrator', 'observer.narrator', p.meter);
    const nr = await gateway.run(
      nh,
      { messages: narratorMessages(world, playState, plan, card, transcriptOf(world, recent.slice(-4), pName)) },
      {
        signal: p.signal,
        onText: () => {},
      },
    );
    const narration = stripThinking(nr.text)
      .split(/\n+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .map((text): Segment => ({ kind: 'narration', text }));
    segments.push(...narration);
    narration.forEach((seg, index) => p.emit({ type: 'seg', index, seg }));
    callId = nh.lastCallId();

    const speakers = v.speakers.length
      ? v.speakers
      : v.scene.presentCharacterIds
          .slice(0, 2)
          .flatMap((id) => world.characters.filter((c) => c.id === id))
          .map((character) => ({ character, intent: '' }));
    for (const { character: me, intent } of speakers) {
      p.emit({ type: 'phase', phase: 'actor', name: me.name });
      const ah = await gateway.forRole('actor', 'observer.actor', p.meter);
      const known = [...state.reveals.entries()]
        .filter(([, to]) => to.has(me.id))
        .flatMap(([owner]) => {
          const o = world.characters.find((c) => c.id === owner);
          return o ? o.secrets.map((s) => `${o.name}：${s.text}`) : [];
        });
      for (const r of v.reveals) {
        if (!r.to.includes(me.id)) continue;
        const o = world.characters.find((c) => c.id === r.characterId);
        if (o) known.push(...o.secrets.map((s) => `${o.name}：${s.text}（刚刚得知）`));
      }
      const index = segments.length;
      let acc = '';
      const ar = await gateway.run(
        ah,
        {
          messages: actorMessages({
            world,
            me,
            state: playState,
            knowledge: p.summary?.characters[me.id] ?? '',
            witnessed: witnessedBy(recent, me.id)
              .map((e) => eventText(e, pName, world))
              .filter(Boolean)
              .join('\n'),
            sofar: segments.map((s) => (s.kind === 'line' ? `${s.name}：${s.text}` : s.text)).join('\n'),
            intent,
            whispers: whispers.filter((w) => w.characterId === me.id).map((w) => w.text ?? ''),
            knownSecrets: known,
          }),
        },
        {
          signal: p.signal,
          onText: (d) => {
            acc += d;
            const t = cleanActorLine(acc, me);
            if (t) p.emit({ type: 'seg', index, seg: { kind: 'line', characterId: me.id, name: me.name, text: t } });
          },
        },
      );
      const line = cleanActorLine(ar.text, me);
      if (line) segments.push({ kind: 'line', characterId: me.id, name: me.name, text: line });
    }
  }
  if (!segments.length) throw new Error('这一拍没有生成任何内容');

  // 5. 记录与之前内容的相似度，下一拍据此判断是否重复
  const previous = raw
    .filter((e) => e.kind === 'ai' || e.kind === 'opening')
    .slice(-QUALITY.window)
    .map(beatText);
  meta.similarity = Math.round(maxSimilarity(segments.map((s) => s.text).join('\n'), previous) * 100) / 100;

  const ev: PlayEvent = {
    id: shortId('ev'),
    parentId,
    kind: 'ai',
    createdAt: Date.now(),
    segments,
    callId,
    beat: meta,
  };
  if (sceneChanged || !sceneAt(p.path).presentCharacterIds.length) ev.scene = v.scene;
  return ev;
}
