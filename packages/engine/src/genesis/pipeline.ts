import {
  type Character,
  FORMAT_VERSION,
  GENESIS_DEPS,
  GENESIS_STEPS,
  type GenesisStepId,
  type GenesisStepState,
  type Location,
  type LoreEntry,
  type StoryOpening,
  WorldManifest,
} from '@auto-adv/schema';
import type { CreateWorldParams, GenesisChunk, GenesisOptions } from '../api.ts';
import type { ModelGateway, ModelHandle } from '../llm/gateway.ts';
import { generateJson, stripThinking } from '../llm/structured.ts';
import { matchByName } from '../world/render.ts';
import type { WorldData, WorldStore } from '../world/store.ts';
import { shortId } from '../util.ts';
import {
  briefPrompt,
  castPrompt,
  GENESIS_SYSTEM,
  locationsPrompt,
  lorePrompt,
  openingPrompt,
  plotPrompt,
  type SeedInput,
  worldviewPrompt,
} from './prompts.ts';
import { checkGraphOut, graphSpec } from './graph.ts';
import { briefSpec, castSpec, locationsSpec, loreSpec, openingSpec } from './specs.ts';

type Emit = (chunk: GenesisChunk) => void;

interface StepContext {
  worldId: string;
  data: WorldData;
  seed: SeedInput;
  handle: ModelHandle;
  signal: AbortSignal;
  progress: (chars: number) => void;
}

const STEP_IDS = GENESIS_STEPS.map((s) => s.id);
const pad = (i: number) => String(i + 1).padStart(2, '0');

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
    return this.run(manifest.id, undefined, emit, signal);
  }

  /** 续跑没完成的步骤；给了 from 则把这一步和它的下游都重置后重新生成。 */
  async run(worldId: string, from: GenesisStepId | undefined, emit: Emit, outer: AbortSignal): Promise<WorldManifest> {
    if (this.running.has(worldId)) throw new Error('这个世界正在生成中');
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    outer.addEventListener('abort', onAbort);
    const done = this.execute(worldId, from, emit, controller.signal);
    this.running.set(worldId, { controller, done });
    try {
      return await done;
    } finally {
      this.running.delete(worldId);
      outer.removeEventListener('abort', onAbort);
    }
  }

  private async execute(
    worldId: string,
    from: GenesisStepId | undefined,
    emit: Emit,
    signal: AbortSignal,
  ): Promise<WorldManifest> {
    const reset = from ? downstreamOf(from) : new Set<GenesisStepId>();
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
            await this.runStep(step, {
              worldId,
              data,
              seed,
              handle,
              signal,
              progress: (chars) => emit({ type: 'progress', step, chars }),
            });
            const label = `${handle.endpoint.name} / ${handle.model}`;
            await this.store.updateManifest(worldId, (m) =>
              m.models.includes(label) ? m : { ...m, models: [...m.models, label] },
            );
            await setState(step, { status: 'done' });
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

  private runStep(step: GenesisStepId, c: StepContext): Promise<void> {
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

  private async brief(c: StepContext): Promise<void> {
    const { value } = await generateJson(this.gateway, c.handle, {
      system: GENESIS_SYSTEM,
      user: briefPrompt(c.seed),
      spec: briefSpec,
      signal: c.signal,
      onProgress: c.progress,
    });
    const fixedTitle = (c.seed.options as { title?: string }).title;
    await this.store.writeBrief(c.worldId, {
      formatVersion: FORMAT_VERSION,
      genre: value.genre,
      tone: value.tone,
      logline: value.logline,
      era: value.era,
      themes: value.themes,
      rating: c.seed.options.rating ?? 'teen',
      length: 'endless',
      defaultMode: 'chat',
      language: 'zh-CN',
      _meta: { locked: [], generatedBy: c.handle.model },
    });
    await this.store.writeStyle(c.worldId, {
      formatVersion: FORMAT_VERSION,
      prose: { pov: 'second', description: value.proseStyle, samples: [] },
      art: { prompt: value.artStyle.trim(), negative: value.artNegative.trim() },
      music: { description: value.musicStyle.trim() },
      _meta: { locked: [] },
    });
    await this.store.updateManifest(c.worldId, (m) => ({
      ...m,
      title: fixedTitle || value.title,
      logline: value.logline,
    }));
  }

  private async worldview(c: StepContext): Promise<void> {
    let chars = 0;
    const result = await this.gateway.run(
      c.handle,
      {
        messages: [
          { role: 'system', content: GENESIS_SYSTEM },
          { role: 'user', content: worldviewPrompt(c.data, c.seed.options) },
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
  }

  private async cast(c: StepContext): Promise<void> {
    const { value } = await generateJson(this.gateway, c.handle, {
      system: GENESIS_SYSTEM,
      user: castPrompt(c.data, c.seed.options),
      spec: castSpec,
      signal: c.signal,
      onProgress: c.progress,
    });
    const list = [...value.characters];
    // 恰好一个主角，并且排在第一个
    let pi = list.findIndex((x) => x.role === 'protagonist');
    const wanted = c.seed.options.protagonistName?.trim();
    if (pi < 0 && wanted) pi = list.findIndex((x) => x.name === wanted);
    if (pi < 0) pi = 0;
    const [protagonist] = list.splice(pi, 1);
    if (!protagonist) throw new Error('模型没有给出任何角色');
    protagonist.role = 'protagonist';
    if (wanted) protagonist.name = wanted;
    for (const x of list) if (x.role === 'protagonist') x.role = 'npc';
    const ordered = [protagonist, ...list];

    const ids = ordered.map((_, i) => `char_${pad(i)}`);
    const named = ordered.map((x, i) => ({ id: ids[i] as string, name: x.name, aliases: x.aliases }));
    const characters: Character[] = ordered.map((x, i) => {
      const id = ids[i] as string;
      return {
        formatVersion: FORMAT_VERSION,
        id,
        name: x.name,
        aliases: x.aliases,
        role: x.role,
        gender: x.gender,
        age: x.age,
        summary: x.summary,
        appearance: { text: x.appearance, imagePrompt: x.imagePrompt.trim() },
        personality: { traits: x.traits, values: x.values, fears: x.fears },
        speech: { style: x.speechStyle, examples: x.speechExamples },
        background: x.background,
        goals: x.goals.map((text) => ({ text, priority: 1, public: true })),
        secrets: x.secret.trim() ? [{ id: 'secret_1', text: x.secret.trim(), knownBy: [id] }] : [],
        relationships: x.relationships.flatMap((r) => {
          const to = matchByName(r.to, named);
          return to && to.id !== id ? [{ to: to.id, type: r.type, affinity: r.affinity }] : [];
        }),
        expressions: ['neutral'],
        _meta: { locked: [], generatedBy: c.handle.model },
      };
    });
    await this.store.writeCharacters(c.worldId, characters);
  }

  private async locations(c: StepContext): Promise<void> {
    const { value } = await generateJson(this.gateway, c.handle, {
      system: GENESIS_SYSTEM,
      user: locationsPrompt(c.data, c.seed.options),
      spec: locationsSpec,
      signal: c.signal,
      onProgress: c.progress,
    });
    const named = value.locations.map((x, i) => ({ id: `loc_${pad(i)}`, name: x.name }));
    const locations: Location[] = value.locations.map((x, i) => {
      const id = `loc_${pad(i)}`;
      return {
        formatVersion: FORMAT_VERSION,
        id,
        name: x.name,
        description: x.description,
        connections: [
          ...new Set(x.connections.flatMap((n) => matchByName(n, named)?.id ?? []).filter((to) => to !== id)),
        ],
        backgrounds: {},
        _meta: { locked: [], generatedBy: c.handle.model },
      };
    });
    await this.store.writeLocations(c.worldId, locations);
  }

  private async lore(c: StepContext): Promise<void> {
    const { value } = await generateJson(this.gateway, c.handle, {
      system: GENESIS_SYSTEM,
      user: lorePrompt(c.data, c.seed.options),
      spec: loreSpec,
      signal: c.signal,
      onProgress: c.progress,
    });
    const entries: LoreEntry[] = value.entries.map((x, i) => ({
      formatVersion: FORMAT_VERSION,
      id: `lore_${pad(i)}`,
      title: x.title,
      content: x.content,
      category: x.category || 'general',
      keys: [...new Set([x.title, ...x.keys].map((k) => k.trim()).filter(Boolean))],
      activation: x.always ? 'always' : 'keyword',
      scope: 'global',
      priority: x.always ? 100 : 50,
      knownBy: 'public',
      _meta: { locked: [], generatedBy: c.handle.model },
    }));
    await this.store.writeLore(c.worldId, entries);
  }

  /** 剧情图和数值：结构检查不过时把问题反馈给模型重写（最多重写 2 次）。 */
  private async plot(c: StepContext): Promise<void> {
    const ctx = { world: c.data };
    const { value } = await generateJson(this.gateway, c.handle, {
      system: GENESIS_SYSTEM,
      user: plotPrompt(c.data, c.seed.options),
      spec: graphSpec,
      signal: c.signal,
      onProgress: c.progress,
      validate: (v) => checkGraphOut(v, ctx).problem,
    });
    const { graph, variables } = checkGraphOut(value, ctx);
    graph._meta = { locked: [], generatedBy: c.handle.model };
    await this.store.writeVariables(c.worldId, variables);
    await this.store.writePlot(c.worldId, graph);
  }

  private async opening(c: StepContext): Promise<void> {
    const { value } = await generateJson(this.gateway, c.handle, {
      system: GENESIS_SYSTEM,
      user: openingPrompt(c.data, c.seed.options),
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
    await this.store.writeOpening(c.worldId, {
      formatVersion: FORMAT_VERSION,
      locationId: location?.id,
      presentCharacterIds: present,
      narration: value.narration,
      lines,
      _meta: { locked: [], generatedBy: c.handle.model },
    });
  }
}
