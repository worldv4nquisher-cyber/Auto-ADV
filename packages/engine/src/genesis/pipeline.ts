import {
  Character,
  FORMAT_VERSION,
  GENESIS_DEPS,
  GENESIS_STEPS,
  type GenesisStepId,
  type GenesisStepState,
  Location,
  LoreEntry,
  StoryOpening,
  StyleGuide,
  type WorldBrief,
  WorldManifest,
} from '@auto-adv/schema';
import type { CreateWorldParams, GenesisChunk, GenesisOptions } from '../api.ts';
import type { ModelGateway, ModelHandle } from '../llm/gateway.ts';
import { generateJson, stripThinking } from '../llm/structured.ts';
import type { EntityKind } from '../world/edit.ts';
import { allLocked, applyLocks, type FixedItem, fixedItems, getAt, isLockedPath } from '../world/locks.ts';
import { matchByName, renderCharacter, renderLocation } from '../world/render.ts';
import type { WorldData, WorldStore } from '../world/store.ts';
import { shortId } from '../util.ts';
import {
  briefPrompt,
  CHARACTER_FIELDS,
  CHARACTER_MODEL_FIELDS,
  castPrompt,
  characterPrompt,
  fieldPrompt,
  GENESIS_SYSTEM,
  LOCATION_FIELDS,
  LOCATION_MODEL_FIELDS,
  LORE_FIELDS,
  LORE_MODEL_FIELDS,
  locationPrompt,
  locationsPrompt,
  loreEntryPrompt,
  lorePrompt,
  openingPrompt,
  plotPrompt,
  type SeedInput,
  worldviewPrompt,
} from './prompts.ts';
import { checkGraphOut, graphSpec } from './graph.ts';
import {
  idAllocator,
  keepPlan,
  mergeKept,
  pruneCharacterRefs,
  pruneLocationRefs,
  remapCharacterIds,
  remapLocationIds,
  sameNameIds,
  toCharacter,
  toLocation,
  toLore,
} from './convert.ts';
import type { KeepPlan } from './prompts.ts';
import { stampInputs } from './inputs.ts';
import {
  briefSpec,
  castRerollSpec,
  castSpec,
  characterSpec,
  locationSpec,
  locationsRerollSpec,
  locationsSpec,
  loreEntrySpec,
  loreRerollSpec,
  loreSpec,
  openingSpec,
  type CharacterOut,
  type LocationOut,
  type LoreEntryOut,
} from './specs.ts';

type Emit = (chunk: GenesisChunk) => void;

interface StepContext {
  worldId: string;
  data: WorldData;
  seed: SeedInput;
  handle: ModelHandle;
  signal: AbortSignal;
  progress: (chars: number) => void;
  /** 这次重抽附的一句说明（只给点了重抽的那几步）。 */
  note?: string;
}

/** 跑哪些步骤（20.4）：不给就是续跑没完成的。 */
export interface GenesisRunOptions {
  /** 从这一步起，连同所有下游一起重新生成。 */
  from?: GenesisStepId;
  /** 只重新生成这几步（下游不动，之后会标过期）。 */
  steps?: GenesisStepId[];
  /** 附给这几步的一句说明（"反派再狠一点"）。 */
  note?: string;
}

/** 只重写一个实体时推送的进度。 */
export type RewriteChunk = { type: 'progress'; chars: number };

const STEP_IDS = GENESIS_STEPS.map((s) => s.id);

/** 简报这一步模型写的字段，和它们在哪块内容里、锁的路径。 */
const BRIEF_OUT = [
  ['title', '世界名', 'manifest', 'title'],
  ['logline', '一句话简介', 'manifest', 'logline'],
  ['genre', '题材', 'brief', 'genre'],
  ['tone', '基调', 'brief', 'tone'],
  ['era', '时代', 'brief', 'era'],
  ['themes', '主题', 'brief', 'themes'],
  ['proseStyle', '文风', 'style', 'prose.description'],
  ['artStyle', '画风', 'style', 'art.prompt'],
  ['artNegative', '画面里要避免的', 'style', 'art.negative'],
  ['musicStyle', '音乐风格', 'style', 'music.description'],
] as const;

function isAbort(err: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (err as { aborted?: boolean })?.aborted === true || (err as Error)?.name === 'AbortError';
}

/** 某一步以及所有直接或间接依赖它的步骤。 */
export function downstreamOf(step: GenesisStepId): Set<GenesisStepId> {
  const out = new Set<GenesisStepId>([step]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const id of STEP_IDS) {
      if (!out.has(id) && GENESIS_DEPS[id].some((d) => out.has(d))) {
        out.add(id);
        grew = true;
      }
    }
  }
  return out;
}

/** 创世管线：按依赖图执行各步骤，能并行的并行；每步的结果立即落盘，中断后可以续跑。 */
export class GenesisRunner {
  private readonly store: WorldStore;
  private readonly gateway: ModelGateway;
  private readonly running = new Map<string, { controller: AbortController; done: Promise<unknown> }>();

  constructor(store: WorldStore, gateway: ModelGateway) {
    this.store = store;
    this.gateway = gateway;
  }

  isRunning(worldId: string): boolean {
    return this.running.has(worldId);
  }

  /** 停止某个世界的创世并等它收尾。 */
  async stop(worldId: string): Promise<void> {
    const job = this.running.get(worldId);
    if (!job) return;
    job.controller.abort();
    await job.done.catch(() => {});
  }

  abortAll(): void {
    for (const job of this.running.values()) job.controller.abort();
  }

  async create(p: CreateWorldParams, emit: Emit, signal: AbortSignal): Promise<WorldManifest> {
    const now = new Date().toISOString();
    const title = p.title?.trim();
    const manifest = WorldManifest.parse({
      formatVersion: FORMAT_VERSION,
      id: shortId('w'),
      title: title || '新世界',
      status: 'generating',
      createdAt: now,
      updatedAt: now,
      genesis: {
        seed: p.seed.trim(),
        preset: p.preset,
        options: { ...(p.options ?? {}), ...(title ? { title } : {}) },
        steps: Object.fromEntries(STEP_IDS.map((id) => [id, { status: 'pending' }])),
      },
    });
    await this.store.create(manifest);
    emit({ type: 'world', worldId: manifest.id });
    return this.run(manifest.id, {}, emit, signal);
  }

  /** 续跑没完成的步骤；给了 from 则把这一步和它的下游都重置后重新生成，给了 steps 只重新生成这几步。 */
  run(worldId: string, opts: GenesisRunOptions, emit: Emit, outer: AbortSignal): Promise<WorldManifest> {
    return this.exclusive(worldId, outer, (signal) => this.execute(worldId, opts, emit, signal));
  }

  /** 独占一个世界做一件事（创世、重写一个实体）：这期间不能编辑，也不能再开一次。 */
  private async exclusive<T>(worldId: string, outer: AbortSignal, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.running.has(worldId)) throw Object.assign(new Error('这个世界正在生成中'), { code: 'busy' });
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (outer.aborted) controller.abort();
    outer.addEventListener('abort', onAbort);
    const done = fn(controller.signal);
    this.running.set(worldId, { controller, done });
    try {
      return await done;
    } finally {
      this.running.delete(worldId);
      outer.removeEventListener('abort', onAbort);
    }
  }

  private async execute(worldId: string, opts: GenesisRunOptions, emit: Emit, signal: AbortSignal): Promise<WorldManifest> {
    const reset = opts.from ? downstreamOf(opts.from) : new Set<GenesisStepId>(opts.steps ?? []);
    const noted = new Set<GenesisStepId>(opts.steps ?? (opts.from ? [opts.from] : []));
    let manifest = await this.store.updateManifest(worldId, (m) => {
      const steps = { ...m.genesis.steps };
      for (const id of STEP_IDS) {
        const st = steps[id];
        // 上次运行中途退出（崩溃或关闭）的步骤，状态还停在 running
        if (!st || reset.has(id) || st.status === 'running' || st.status === 'failed') steps[id] = { status: 'pending' };
      }
      return { ...m, status: 'generating', genesis: { ...m.genesis, steps } };
    });
    for (const id of STEP_IDS) emit({ type: 'step', step: id, state: manifest.genesis.steps[id] as GenesisStepState });

    const failed = new Set<GenesisStepId>();
    const setState = async (step: GenesisStepId, state: GenesisStepState) => {
      const s = { ...state, updatedAt: new Date().toISOString() };
      manifest = await this.store.updateManifest(worldId, (m) => ({
        ...m,
        genesis: { ...m.genesis, steps: { ...m.genesis.steps, [step]: s } },
      }));
      emit({ type: 'step', step, state: s });
    };

    while (!signal.aborted) {
      const status = (id: GenesisStepId) => manifest.genesis.steps[id]?.status;
      const runnable = STEP_IDS.filter(
        (id) => status(id) !== 'done' && !failed.has(id) && GENESIS_DEPS[id].every((d) => status(d) === 'done'),
      );
      if (!runnable.length) break;
      // 同一批的步骤都基于同一份快照：它们的依赖都已完成
      const data = await this.store.load(worldId);
      await Promise.all(
        runnable.map(async (step) => {
          await setState(step, { status: 'running' });
          try {
            const handle = await this.gateway.forRole('worldgen', `genesis.${step}`);
            const seed: SeedInput = {
              seed: data.manifest.genesis.seed,
              preset: data.manifest.genesis.preset as SeedInput['preset'],
              options: data.manifest.genesis.options as GenesisOptions,
            };
            const used = await this.runStep(step, {
              worldId,
              data,
              seed,
              handle,
              signal,
              progress: (chars) => emit({ type: 'progress', step, chars }),
              ...(opts.note?.trim() && noted.has(step) ? { note: opts.note.trim() } : {}),
            });
            if (used !== false) {
              const label = `${handle.endpoint.name} / ${handle.model}`;
              await this.store.updateManifest(worldId, (m) =>
                m.models.includes(label) ? m : { ...m, models: [...m.models, label] },
              );
            }
            // 记下这一步读到的上游内容，之后上游改了能看出来（20.4"过期"）
            await setState(step, { status: 'done', ...stampInputs(data, step) });
          } catch (err) {
            if (isAbort(err, signal)) {
              await setState(step, { status: 'pending' });
              return;
            }
            failed.add(step);
            await setState(step, { status: 'failed', error: (err as Error).message || String(err) });
          }
        }),
      );
    }

    const allDone = STEP_IDS.every((id) => manifest.genesis.steps[id]?.status === 'done');
    return this.store.updateManifest(worldId, (m) => ({
      ...m,
      status: allDone ? 'ready' : failed.size ? 'failed' : 'generating',
    }));
  }

  // ───────────── 各步骤 ─────────────
  // 每一步都按锁定规则写（20.4）：锁住的内容作为"已经定了"交给模型，模型写回来以后再把锁住的字段盖回去。
  // 返回 false 表示全锁了、没有调模型。

  private runStep(step: GenesisStepId, c: StepContext): Promise<boolean | void> {
    switch (step) {
      case 'brief':
        return this.brief(c);
      case 'worldview':
        return this.worldview(c);
      case 'cast':
        return this.cast(c);
      case 'locations':
        return this.locations(c);
      case 'plot':
        return this.plot(c);
      case 'lore':
        return this.lore(c);
      case 'opening':
        return this.opening(c);
    }
  }

  private async brief(c: StepContext): Promise<boolean> {
    const m = c.data.manifest;
    const old = c.data.brief;
    const oldStyle = c.data.style;
    const fixedTitle = (c.seed.options as { title?: string }).title?.trim();
    const lockOf = (part: string, path: string) =>
      part === 'manifest'
        ? m.locked.includes(path) || (path === 'logline' && !!old && isLockedPath(old._meta.locked, 'logline'))
        : isLockedPath((part === 'brief' ? old : oldStyle)?._meta.locked ?? [], path);
    const valueOf = (part: string, path: string): unknown => {
      if (part === 'manifest') return path === 'title' ? m.title : m.logline;
      const src = (part === 'brief' ? old : oldStyle) as Record<string, unknown> | null;
      return path.split('.').reduce<unknown>((x, k) => (x && typeof x === 'object' ? (x as Record<string, unknown>)[k] : undefined), src);
    };
    const fixed: FixedItem[] = [];
    if (fixedTitle && !lockOf('manifest', 'title')) fixed.push({ label: '世界名', value: fixedTitle });
    let all = true;
    for (const [, label, part, path] of BRIEF_OUT) {
      const hasOld = part === 'manifest' || (part === 'brief' ? !!old : !!oldStyle);
      if (hasOld && lockOf(part, path)) {
        const v = valueOf(part, path);
        const text = Array.isArray(v) ? v.join('、') : String(v ?? '').trim();
        if (text) fixed.push({ label, value: text });
      } else all = false;
    }
    if (all) return false;
    const { value } = await generateJson(this.gateway, c.handle, {
      system: GENESIS_SYSTEM,
      user: briefPrompt(c.seed, fixed, c.note),
      spec: briefSpec,
      signal: c.signal,
      onProgress: c.progress,
    });
    // 模型不写的（分级、篇幅、默认模式、人称、例句）：重抽时留着原来的
    const brief: WorldBrief = {
      formatVersion: FORMAT_VERSION,
      genre: value.genre,
      tone: value.tone,
      logline: value.logline,
      era: value.era,
      themes: value.themes,
      rating: old?.rating ?? c.seed.options.rating ?? 'teen',
      length: old?.length ?? 'endless',
      defaultMode: old?.defaultMode ?? 'chat',
      language: old?.language ?? 'zh-CN',
      _meta: { locked: old?._meta.locked ?? [], generatedBy: c.handle.model },
    };
    await this.store.writeBrief(c.worldId, applyLocks(brief, old, old?._meta.locked ?? []));
    const style: StyleGuide = {
      formatVersion: FORMAT_VERSION,
      prose: { pov: oldStyle?.prose.pov ?? 'second', description: value.proseStyle, samples: oldStyle?.prose.samples ?? [] },
      art: { prompt: value.artStyle.trim(), negative: value.artNegative.trim() },
      music: { description: value.musicStyle.trim() },
      _meta: { locked: oldStyle?._meta.locked ?? [] },
    };
    await this.store.writeStyle(c.worldId, applyLocks(style, oldStyle, oldStyle?._meta.locked ?? []));
    await this.store.updateManifest(c.worldId, (x) => ({
      ...x,
      title: x.locked.includes('title') ? x.title : fixedTitle || value.title,
      logline: x.locked.includes('logline') ? x.logline : value.logline,
    }));
    return true;
  }

  private async worldview(c: StepContext): Promise<boolean> {
    // 世界观整篇锁
    if (c.data.manifest.locked.includes('worldview') && c.data.worldview.trim()) return false;
    let chars = 0;
    const result = await this.gateway.run(
      c.handle,
      {
        messages: [
          { role: 'system', content: GENESIS_SYSTEM },
          { role: 'user', content: worldviewPrompt(c.data, c.seed.options, c.note) },
        ],
      },
      {
        signal: c.signal,
        onText: (d) => {
          chars += d.length;
          c.progress(chars);
        },
      },
    );
    const text = stripThinking(result.text).trim();
    if (text.length < 50) throw new Error('模型返回的世界观太短，请重试');
    await this.store.writeWorldview(c.worldId, text);
    return true;
  }

  private async cast(c: StepContext): Promise<boolean> {
    const old = c.data.characters;
    const n = Math.max(1, Math.min(8, c.seed.options.characterCount ?? 3));
    const total = Math.max(n + 1, old.filter((x) => x._meta.locked.length).length);
    const plan = keepPlan(old, CHARACTER_FIELDS(old), CHARACTER_MODEL_FIELDS, [total, total]);
    const keptCount = plan.full.length + plan.partial.length;
    const allocate = idAllocator('char', [...old.map((x) => x.id), ...(await this.store.historyIds(c.worldId, 'character'))]);
    const outs = new Map<string, CharacterOut>();
    let fresh: CharacterOut[] = [];
    const called = !keptCount || plan.partial.length > 0 || plan.fresh[0] > 0;
    if (called) {
      const { value } = await generateJson(this.gateway, c.handle, {
        system: GENESIS_SYSTEM,
        user: castPrompt(c.data, c.seed.options, keptCount ? { ...plan, total } : undefined, c.note),
        spec: keptCount ? castRerollSpec : castSpec,
        signal: c.signal,
        onProgress: c.progress,
      });
      fresh = keptCount ? splitKept(plan, old, value.characters, (o) => o.name, outs) : value.characters;
    }
    // 名字对照（关系按名字找）：留下的、新写的都算，新写的先占好 id
    const keptBase = keptOf(plan, old);
    const freshIds = fresh.map(() => allocate());
    const named = [
      ...keptBase.map((x) => ({ id: x.id, name: renamed(x, outs.get(x.id)?.name), aliases: x.aliases })),
      ...fresh.map((x, i) => ({ id: freshIds[i] as string, name: x.name, aliases: x.aliases })),
    ];
    const kept = keptBase.map((x) => {
      const o = outs.get(x.id);
      return o ? applyLocks(toCharacter(o, x.id, named, c.handle.model, x), x, x._meta.locked) : x;
    });
    const created = fresh.map((x, i) => toCharacter(x, freshIds[i] as string, named, c.handle.model));
    let list = [...kept, ...created];
    if (!list.length) throw new Error('模型没有给出任何角色');

    // 恰好一个主角，排在第一个；锁住了定位的不改
    const keptIds = new Set(kept.map((x) => x.id));
    const roleLocked = (x: Character) => keptIds.has(x.id) && isLockedPath(x._meta.locked, 'role');
    const wanted = c.seed.options.protagonistName?.trim();
    const protagonist =
      list.find((x) => x.role === 'protagonist' && roleLocked(x)) ??
      (wanted ? list.find((x) => x.name === wanted) : undefined) ??
      list.find((x) => x.role === 'protagonist') ??
      list.find((x) => !roleLocked(x)) ??
      (list[0] as Character);
    for (const x of list) if (x !== protagonist && x.role === 'protagonist' && !roleLocked(x)) x.role = 'npc';
    if (!roleLocked(protagonist)) protagonist.role = 'protagonist';
    if (wanted && !keptIds.has(protagonist.id)) protagonist.name = wanted;
    list = [protagonist, ...list.filter((x) => x !== protagonist)];
    list = remapCharacterIds(list, sameNameIds(created, old.filter((x) => !keptIds.has(x.id))));
    await this.store.writeCharacters(c.worldId, pruneCharacterRefs(list));
    return called;
  }

  private async locations(c: StepContext): Promise<boolean> {
    const old = c.data.locations;
    const plan = keepPlan(old, LOCATION_FIELDS(old), LOCATION_MODEL_FIELDS, [4, 6]);
    const keptCount = plan.full.length + plan.partial.length;
    const allocate = idAllocator('loc', [...old.map((x) => x.id), ...(await this.store.historyIds(c.worldId, 'location'))]);
    const outs = new Map<string, LocationOut>();
    let fresh: LocationOut[] = [];
    const called = !keptCount || plan.partial.length > 0 || plan.fresh[1] > 0;
    if (called) {
      const { value } = await generateJson(this.gateway, c.handle, {
        system: GENESIS_SYSTEM,
        user: locationsPrompt(c.data, c.seed.options, keptCount ? plan : undefined, c.note),
        spec: keptCount ? locationsRerollSpec : locationsSpec,
        signal: c.signal,
        onProgress: c.progress,
      });
      fresh = keptCount ? splitKept(plan, old, value.locations, (o) => o.name, outs) : value.locations;
    }
    const keptBase = keptOf(plan, old);
    const freshIds = fresh.map(() => allocate());
    const named = [
      ...keptBase.map((x) => ({ id: x.id, name: renamed(x, outs.get(x.id)?.name) })),
      ...fresh.map((x, i) => ({ id: freshIds[i] as string, name: x.name })),
    ];
    const kept = keptBase.map((x) => {
      const o = outs.get(x.id);
      return o ? applyLocks(toLocation(o, x.id, named, c.handle.model, x), x, x._meta.locked) : x;
    });
    const created = fresh.map((x, i) => toLocation(x, freshIds[i] as string, named, c.handle.model));
    if (!kept.length && !created.length) throw new Error('模型没有给出任何地点');
    const keptIds = new Set(kept.map((x) => x.id));
    const list = remapLocationIds([...kept, ...created], sameNameIds(created, old.filter((x) => !keptIds.has(x.id))));
    await this.store.writeLocations(c.worldId, pruneLocationRefs(list));
    return called;
  }

  private async lore(c: StepContext): Promise<boolean> {
    const old = c.data.lore;
    const plan = keepPlan(old, LORE_FIELDS, LORE_MODEL_FIELDS, [8, 12]);
    const keptCount = plan.full.length + plan.partial.length;
    const allocate = idAllocator('lore', [...old.map((x) => x.id), ...(await this.store.historyIds(c.worldId, 'lore'))]);
    const outs = new Map<string, LoreEntryOut>();
    let fresh: LoreEntryOut[] = [];
    const called = !keptCount || plan.partial.length > 0 || plan.fresh[1] > 0;
    if (called) {
      const { value } = await generateJson(this.gateway, c.handle, {
        system: GENESIS_SYSTEM,
        user: lorePrompt(c.data, c.seed.options, keptCount ? plan : undefined, c.note),
        spec: keptCount ? loreRerollSpec : loreSpec,
        signal: c.signal,
        onProgress: c.progress,
      });
      fresh = keptCount ? splitKept(plan, old, value.entries, (o) => o.title, outs) : value.entries;
    }
    const kept = keptOf(plan, old).map((x) => {
      const o = outs.get(x.id);
      return o ? applyLocks(toLore(o, x.id, c.handle.model, x), x, x._meta.locked) : x;
    });
    const created = fresh.map((x) => toLore(x, allocate(), c.handle.model));
    await this.store.writeLore(c.worldId, [...kept, ...created]);
    return called;
  }

  /** 剧情图和数值：结构检查不过时把问题反馈给模型重写（最多重写 2 次）。整张锁住的不重写；数值表锁住时只能用已有的数值。 */
  private async plot(c: StepContext): Promise<boolean> {
    const old = c.data.graph;
    if (old && old._meta.locked.includes('*')) return false;
    const fixedVariables = c.data.manifest.locked.includes('variables');
    const ctx = { world: c.data, ...(fixedVariables ? { variables: c.data.variables } : {}) };
    const { value } = await generateJson(this.gateway, c.handle, {
      system: GENESIS_SYSTEM,
      user: plotPrompt(c.data, c.seed.options, fixedVariables, c.note),
      spec: graphSpec,
      signal: c.signal,
      onProgress: c.progress,
      validate: (v) => checkGraphOut(v, ctx).problem,
    });
    const { graph, variables } = checkGraphOut(value, ctx);
    graph._meta = { locked: old?._meta.locked ?? [], generatedBy: c.handle.model };
    if (!fixedVariables) await this.store.writeVariables(c.worldId, variables);
    await this.store.writePlot(c.worldId, graph);
    return true;
  }

  private async opening(c: StepContext): Promise<boolean> {
    const old = c.data.opening;
    const locked = old?._meta.locked ?? [];
    if (old && locked.includes('*')) return false;
    const fields = old ? openingFixed(c.data, old, locked) : [];
    const { value } = await generateJson(this.gateway, c.handle, {
      system: GENESIS_SYSTEM,
      user: openingPrompt(c.data, c.seed.options, fields, c.note),
      spec: openingSpec,
      signal: c.signal,
      onProgress: c.progress,
    });
    const protagonist = c.data.characters.find((x) => x.role === 'protagonist');
    const others = c.data.characters.filter((x) => x !== protagonist);
    const location = matchByName(value.location, c.data.locations) ?? c.data.locations[0];
    const present = [...new Set(value.present.flatMap((n) => matchByName(n, others)?.id ?? []))];
    const lines: StoryOpening['lines'] = [];
    for (const line of value.lines) {
      const who = matchByName(line.speaker, others);
      if (!who) continue;
      lines.push({ characterId: who.id, text: line.text });
      if (!present.includes(who.id)) present.push(who.id);
    }
    if (!present.length && others[0]) present.push(others[0].id);
    const fresh: StoryOpening = {
      formatVersion: FORMAT_VERSION,
      ...(location ? { locationId: location.id } : {}),
      presentCharacterIds: present,
      narration: value.narration,
      lines,
      _meta: { locked, generatedBy: c.handle.model },
    };
    await this.store.writeOpening(c.worldId, applyLocks(fresh, old, locked));
    return true;
  }

  // ───────────── 只重写一个实体（20.4"一个实体"） ─────────────

  /**
   * 只重写一个角色、地点或设定条目：世界的其余部分作为上下文，id 不变，锁住的字段原样保留。
   * 重写之前的版本进历史。这期间这个世界不能编辑。
   */
  rewriteEntity(
    worldId: string,
    p: { kind: EntityKind; id: string; note?: string },
    emit: (c: RewriteChunk) => void,
    outer: AbortSignal,
  ): Promise<void> {
    return this.exclusive(worldId, outer, async (signal) => {
      const data = await this.store.load(worldId);
      const handle = await this.gateway.forRole('worldgen', `rewrite.${p.kind}`);
      const common = { system: GENESIS_SYSTEM, signal, onProgress: (chars: number) => emit({ type: 'progress', chars }) };
      const model = handle.model;
      if (p.kind === 'character') {
        const base = data.characters.find((x) => x.id === p.id);
        if (!base) throw new Error('要重写的角色不存在');
        if (allLocked(base._meta.locked, CHARACTER_MODEL_FIELDS)) throw Object.assign(new Error('这个角色整个锁住了，先解锁再重抽'), { code: 'invalid' });
        const fixed = fixedItems(base, base._meta.locked, CHARACTER_FIELDS(data.characters));
        const { value } = await generateJson(this.gateway, handle, { ...common, user: characterPrompt(data, base, fixed, p.note), spec: characterSpec });
        const next = applyLocks(toCharacter(value, base.id, data.characters, model, base), base, base._meta.locked);
        // 主角还是主角；别人不能变成主角
        if (!isLockedPath(base._meta.locked, 'role')) next.role = base.role === 'protagonist' ? 'protagonist' : next.role === 'protagonist' ? 'npc' : next.role;
        await this.store.writeCharacter(worldId, pruneCharacterRefs([...data.characters.filter((x) => x.id !== base.id), next]).at(-1) as Character);
      } else if (p.kind === 'location') {
        const base = data.locations.find((x) => x.id === p.id);
        if (!base) throw new Error('要重写的地点不存在');
        if (allLocked(base._meta.locked, LOCATION_MODEL_FIELDS)) throw Object.assign(new Error('这个地点整个锁住了，先解锁再重抽'), { code: 'invalid' });
        const fixed = fixedItems(base, base._meta.locked, LOCATION_FIELDS(data.locations));
        const { value } = await generateJson(this.gateway, handle, { ...common, user: locationPrompt(data, base, fixed, p.note), spec: locationSpec });
        await this.store.writeLocation(worldId, applyLocks(toLocation(value, base.id, data.locations, model, base), base, base._meta.locked));
      } else {
        const base = data.lore.find((x) => x.id === p.id);
        if (!base) throw new Error('要重写的设定条目不存在');
        if (allLocked(base._meta.locked, LORE_MODEL_FIELDS)) throw Object.assign(new Error('这条设定整个锁住了，先解锁再重抽'), { code: 'invalid' });
        const fixed = fixedItems(base, base._meta.locked, LORE_FIELDS);
        const { value } = await generateJson(this.gateway, handle, { ...common, user: loreEntryPrompt(data, base, fixed, p.note), spec: loreEntrySpec });
        await this.store.writeLoreEntry(worldId, applyLocks(toLore(value, base.id, model, base), base, base._meta.locked));
      }
      const label = `${handle.endpoint.name} / ${handle.model}`;
      await this.store.updateManifest(worldId, (m) => (m.models.includes(label) ? m : { ...m, models: [...m.models, label] }));
    });
  }

  /** 只重写一个字段，返回新的文字（不保存，由界面放进表单）。draft 是表单里现在的内容。 */
  async rewriteField(
    worldId: string,
    p: { key: string; path: string; data?: unknown; note?: string },
    emit: (c: RewriteChunk) => void,
    signal: AbortSignal,
  ): Promise<string> {
    const [kind, id] = p.key.split(':') as [string, string | undefined];
    const label = REWRITE_FIELDS[kind]?.[p.path];
    if (!label) throw Object.assign(new Error('这一项不能单独重写'), { code: 'invalid' });
    const data = await this.store.load(worldId);
    let context = '';
    let current: unknown;
    switch (kind) {
      case 'character': {
        const saved = data.characters.find((x) => x.id === id);
        const c = draftOf(Character, p.data && { ...(p.data as object), id: id || 'char_new' }, saved);
        if (!c) throw new Error('要重写的角色不存在');
        const others = data.characters.filter((x) => x.id !== c.id);
        context = `# 其他角色\n${others.map((x) => renderCharacter(x, 'short')).join('\n') || '（没有）'}\n\n# 这个角色\n${renderCharacter(c)}`;
        current = getAt(c, p.path);
        break;
      }
      case 'location': {
        const l = draftOf(Location, p.data && { ...(p.data as object), id: id || 'loc_new' }, data.locations.find((x) => x.id === id));
        if (!l) throw new Error('要重写的地点不存在');
        context = `# 地点\n${data.locations.filter((x) => x.id !== l.id).map((x) => renderLocation(x, 'short')).join('\n')}\n\n# 这个地点\n${renderLocation(l)}`;
        current = l.description;
        break;
      }
      case 'lore': {
        const e = draftOf(LoreEntry, p.data && { ...(p.data as object), id: id || 'lore_new' }, data.lore.find((x) => x.id === id));
        if (!e) throw new Error('要重写的设定条目不存在');
        context = `# 这条设定\n## ${e.title}\n${e.content}`;
        current = e.content;
        break;
      }
      case 'opening': {
        const o = draftOf(StoryOpening, p.data, data.opening);
        context = `# 角色\n${data.characters.map((x) => renderCharacter(x, 'short')).join('\n')}\n\n# 地点\n${data.locations.map((x) => renderLocation(x)).join('\n')}`;
        current = o?.narration ?? '';
        break;
      }
      case 'style': {
        const st = draftOf(StyleGuide, p.data, data.style);
        context = `# 风格\n文风：${st?.prose.description ?? ''}\n画风：${st?.art.prompt ?? ''}\n音乐：${st?.music.description ?? ''}`;
        current = st ? getAt(st, p.path) : '';
        break;
      }
      case 'manifest': {
        const d = (p.data ?? {}) as { title?: string; logline?: string };
        context = `# 世界\n世界名：${d.title ?? data.manifest.title}`;
        current = d.logline ?? data.manifest.logline;
        break;
      }
    }
    const handle = await this.gateway.forRole('worldgen', `rewrite.field`);
    let chars = 0;
    const result = await this.gateway.run(
      handle,
      {
        messages: [
          { role: 'system', content: GENESIS_SYSTEM },
          { role: 'user', content: fieldPrompt(data, context, label, String(current ?? ''), p.note) },
        ],
      },
      {
        signal,
        onText: (d) => {
          chars += d.length;
          emit({ type: 'progress', chars });
        },
      },
    );
    const text = cleanText(result.text);
    if (!text) throw new Error('模型没有写出内容，请重试');
    return text;
  }
}

/** 能单独重写的字段（长文本）：内容类型 → 字段路径 → 给模型看的名称（20.4"一个字段"）。 */
export const REWRITE_FIELDS: Record<string, Record<string, string>> = {
  character: {
    summary: '一句话介绍（20～40 字）',
    'appearance.text': '外貌与衣着',
    'appearance.imagePrompt': '画立绘用的外貌描述（给图像模型看：发型和发色、瞳色、身材、服装和配饰，不写性格、动作和背景）',
    'speech.style': '说话方式',
    background: '经历',
  },
  location: { description: '描述（这里的样子、氛围、常见的人和事）' },
  lore: { content: '正文' },
  opening: { narration: '开场叙述（用第二人称「你」指代主角）' },
  style: { 'prose.description': '文风', 'art.prompt': '画风（给图像模型看）', 'music.description': '音乐风格' },
  manifest: { logline: '一句话简介' },
};

/** 表单里的内容按 schema 补全；读不懂就用存着的。 */
function draftOf<T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T } }, draft: unknown, saved: T | undefined | null): T | null {
  if (draft !== undefined) {
    const r = schema.safeParse(draft);
    if (r.success) return r.data as T;
  }
  return saved ?? null;
}

/** 去掉模型常加的引号和标签。 */
function cleanText(s: string): string {
  let t = stripThinking(s).trim();
  t = t.replace(/^(?:新的)?(?:内容|版本)[:：]\s*/, '');
  const pairs: [string, string][] = [['「', '」'], ['“', '”'], ['"', '"'], ['『', '』']];
  for (const [a, b] of pairs) if (t.startsWith(a) && t.endsWith(b) && t.length > 2) t = t.slice(1, -1).trim();
  return t;
}

/** 开场里锁住的字段，写成给模型看的样子。 */
function openingFixed(d: WorldData, o: StoryOpening, locked: readonly string[]): FixedItem[] {
  const name = (id: string) => d.characters.find((c) => c.id === id)?.name ?? id;
  return fixedItems(o, locked, [
    ['locationId', '开场地点（location）', (v) => d.locations.find((l) => l.id === v)?.name ?? ''],
    ['presentCharacterIds', '在场角色（present）', (v) => (v as string[]).map(name).join('、')],
    ['narration', '开场叙述（narration）'],
    ['lines', '台词（lines）', (v) => (v as StoryOpening['lines']).map((l) => `${name(l.characterId)}：${l.text}`).join(' / ')],
  ]);
}

/** 留下的实体（整个锁住的和部分锁住的），按原来的顺序。 */
function keptOf<T extends { id: string }>(plan: KeepPlan<T>, old: readonly T[]): T[] {
  const ids = new Set([...plan.full.map((x) => x.id), ...plan.partial.map((p) => p.item.id)]);
  return old.filter((x) => ids.has(x.id));
}

/**
 * 模型写回来的列表分成两部分：带 id（或者名字对得上）的是要补全的那几个，记进 outs；其余是新的，
 * 最多留计划里说的个数。
 */
function splitKept<T extends { id: string; _meta: { locked: string[] } }, O extends { id: string }>(
  plan: KeepPlan<T>,
  old: readonly T[],
  list: readonly O[],
  nameOf: (o: O) => string,
  outs: Map<string, O>,
): O[] {
  return mergeKept(plan, old as (T & { name?: string })[], list, nameOf, (o, base) => {
    outs.set(base.id, o);
    return base;
  }).fresh;
}

/** 部分锁住的实体重写以后的名字（名字没锁时模型可能改了）。 */
function renamed(x: { name: string; _meta: { locked: string[] } }, out: string | undefined): string {
  return out && !isLockedPath(x._meta.locked, 'name') ? out : x.name;
}
