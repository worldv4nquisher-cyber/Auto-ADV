/**
 * 创世步骤的输入哈希和过期（docs/ARCHITECTURE.md 20.4"过期"）。
 * 每一步生成完记下它读到的上游内容的哈希（按来源分开）；上游被手改、重抽以后哈希对不上，这一步就是"过期"的：
 * 世界照样能玩，世界页提示一下，点了才按新的上游重写（锁住的保留）。
 *
 * 只哈希会交给模型的内容：`_meta`（锁、生成者）、立绘和背景图、音色这些不算。
 * 名字先换成 id 再哈希：改名并且把正文里的旧名字也换掉了，下游读到的意思没变，不算过期；
 * 只改了名字、正文里还是旧名字，才算。
 */
import { createHash } from 'node:crypto';
import { GENESIS_STEPS, type GenesisStepId, type GenesisStepState } from '@auto-adv/schema';
import type { WorldData } from '../world/store.ts';

/** 一步读到的一块上游内容。`seed` 是新建时的灵感、预设和选项。 */
export type StepInput = 'seed' | 'brief' | 'worldview' | 'characters' | 'locations' | 'plot';

export const STEP_INPUTS: Record<GenesisStepId, readonly StepInput[]> = {
  brief: ['seed'],
  worldview: ['brief'],
  cast: ['brief', 'worldview'],
  locations: ['brief', 'worldview'],
  plot: ['brief', 'worldview', 'characters', 'locations'],
  lore: ['brief', 'worldview', 'characters', 'locations'],
  opening: ['brief', 'worldview', 'characters', 'locations', 'plot'],
};

export const INPUT_NAMES: Record<StepInput, string> = {
  seed: '世界选项',
  brief: '简报',
  worldview: '世界观',
  characters: '角色',
  locations: '地点',
  plot: '剧情图',
};

/** 一个过期的步骤，和它的哪几块上游改过。 */
export interface StaleStep {
  step: GenesisStepId;
  changed: StepInput[];
}

const DROP = new Set(['_meta', 'formatVersion']);

/** 去掉不交给模型的字段（递归去掉 `_meta`、`formatVersion`，再去掉 extra 里的顶层字段）。 */
function strip(v: unknown, extra: readonly string[] = []): unknown {
  if (Array.isArray(v)) return v.map((x) => strip(x));
  if (typeof v !== 'object' || v === null) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (DROP.has(k) || extra.includes(k)) continue;
    out[k] = strip(x);
  }
  return out;
}

/** 角色和地点的名字（id → 名字和别称）。 */
export function namesOf(world: Pick<WorldData, 'characters' | 'locations'>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const c of world.characters) out[c.id] = [c.name, ...c.aliases].map((x) => x.trim()).filter(Boolean);
  for (const l of world.locations) out[l.id] = [l.name.trim()].filter(Boolean);
  return out;
}

/** 把文字里的名字换成 id（长的名字先换，免得"林夕"把"林夕月"换掉一半）。 */
function normalizer(names: Record<string, string[]>): (s: string) => string {
  const byName = new Map<string, string>();
  for (const [id, list] of Object.entries(names)) for (const n of list) if (!byName.has(n)) byName.set(n, id);
  if (!byName.size) return (s) => s;
  const re = new RegExp(
    [...byName.keys()]
      .sort((a, b) => b.length - a.length)
      .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|'),
    'g',
  );
  return (s) => s.replace(re, (m) => `\u0000${byName.get(m)}\u0000`);
}

function mapStrings(v: unknown, fn: (s: string) => string): unknown {
  if (typeof v === 'string') return fn(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, fn));
  if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, fn)]));
  return v;
}

function projection(world: WorldData, input: StepInput): unknown {
  switch (input) {
    case 'seed': {
      const g = world.manifest.genesis;
      return { seed: g.seed, preset: g.preset ?? '', options: g.options };
    }
    case 'brief':
      return {
        title: world.manifest.title,
        logline: world.manifest.logline,
        brief: strip(world.brief),
        style: strip(world.style),
      };
    case 'worldview':
      return world.worldview.trim();
    case 'characters':
      return world.characters.map((c) => {
        const { referenceImage: _r, ...appearance } = c.appearance;
        return strip({ ...c, appearance }, ['voice', 'expressions']);
      });
    case 'locations':
      return world.locations.map((l) => strip(l, ['backgrounds']));
    case 'plot':
      return strip(world.graph);
  }
}

const hash = (v: unknown) => createHash('sha1').update(JSON.stringify(v ?? null)).digest('hex').slice(0, 12);

/** 一步现在的输入哈希。names 是换成 id 的名字表。 */
export function inputsOf(world: WorldData, step: GenesisStepId, names: Record<string, string[]>): Record<string, string> {
  const norm = normalizer(names);
  return Object.fromEntries(STEP_INPUTS[step].map((k) => [k, hash(mapStrings(projection(world, k), norm))]));
}

/** 生成完这一步时要记下的：输入哈希和当时的名字。 */
export function stampInputs(world: WorldData, step: GenesisStepId): Pick<GenesisStepState, 'inputs' | 'names'> {
  const names = namesOf(world);
  return { inputs: inputsOf(world, step, names), names };
}

/**
 * 过期的步骤。拿来比的名字表：记下时就有的角色和地点用现在的名字（改了名、正文没跟着换就对不上），
 * 已经删掉的用当时的名字；后来新加的不换（免得正文里碰巧出现新名字就算改过）。
 */
export function staleSteps(world: WorldData): StaleStep[] {
  const now = namesOf(world);
  const out: StaleStep[] = [];
  for (const { id } of GENESIS_STEPS) {
    const st = world.manifest.genesis.steps[id];
    if (st?.status !== 'done' || !st.inputs) continue;
    const names: Record<string, string[]> = {};
    for (const [eid, list] of Object.entries(st.names ?? {})) names[eid] = now[eid] ?? list;
    const cur = inputsOf(world, id, names);
    const changed = STEP_INPUTS[id].filter((k) => st.inputs?.[k] !== undefined && st.inputs[k] !== cur[k]);
    if (changed.length) out.push({ step: id, changed });
  }
  return out;
}

/** 做完了、但还没有输入哈希的步骤（M5 之前生成的世界）：在第一次改动之前补上，当作"那时是新的"。 */
export function missingInputs(world: WorldData): GenesisStepId[] {
  return GENESIS_STEPS.map((s) => s.id).filter((id) => {
    const st = world.manifest.genesis.steps[id];
    return st?.status === 'done' && !st.inputs;
  });
}

/**
 * 不算"改了上游"的写入（周目里临时人物升级成正式角色、给已有角色加别称）：写之前不过期的步骤，
 * 按写之后的内容重新记一遍，免得玩着玩着冒出"角色改过了"的提示。写之前就过期的保持过期。
 */
export function freshStamps(before: WorldData, after: WorldData): Partial<Record<GenesisStepId, Pick<GenesisStepState, 'inputs' | 'names'>>> {
  const stale = new Set(staleSteps(before).map((x) => x.step));
  const out: Partial<Record<GenesisStepId, Pick<GenesisStepState, 'inputs' | 'names'>>> = {};
  for (const { id } of GENESIS_STEPS) {
    const st = before.manifest.genesis.steps[id];
    if (st?.status === 'done' && st.inputs && !stale.has(id)) out[id] = stampInputs(after, id);
  }
  return out;
}
