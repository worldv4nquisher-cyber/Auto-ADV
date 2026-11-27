/**
 * 模型写的角色、地点、设定条目转成正式格式，以及重抽时和锁住的实体合并（docs/ARCHITECTURE.md 20.4）。
 */
import { type Character, FORMAT_VERSION, type Location, type LoreEntry } from '@auto-adv/schema';
import { nextId } from '../world/edit.ts';
import { allLocked, applyLocks, type FixedItem, fixedItems } from '../world/locks.ts';
import { matchByName } from '../world/render.ts';
import type { FieldTable, KeepPlan } from './prompts.ts';
import type { CharacterOut, LocationOut, LoreEntryOut } from './specs.ts';

type Named = { id: string; name: string; aliases?: string[] };

/** 模型写的一个角色 → Character。base 是原来的（重抽时）：模型不写的字段（表情、音色、参考图）从它来。 */
export function toCharacter(x: CharacterOut, id: string, named: readonly Named[], model: string, base?: Character): Character {
  const secret = x.secret.trim();
  return {
    formatVersion: FORMAT_VERSION,
    id,
    name: x.name,
    aliases: x.aliases,
    role: x.role,
    gender: x.gender,
    age: x.age,
    summary: x.summary,
    appearance: {
      text: x.appearance,
      imagePrompt: x.imagePrompt.trim(),
      ...(base?.appearance.referenceImage ? { referenceImage: base.appearance.referenceImage } : {}),
    },
    personality: { traits: x.traits, values: x.values, fears: x.fears },
    speech: { style: x.speechStyle, examples: x.speechExamples },
    background: x.background,
    goals: x.goals.map((text) => ({ text, priority: 1, public: true })),
    secrets: secret ? [{ id: base?.secrets[0]?.id ?? 'secret_1', text: secret, knownBy: [id] }] : [],
    relationships: x.relationships.flatMap((r) => {
      const to = matchByName(r.to, [...named]);
      return to && to.id !== id ? [{ to: to.id, type: r.type, affinity: r.affinity }] : [];
    }),
    expressions: base?.expressions ?? ['neutral'],
    ...(base?.voice ? { voice: base.voice } : {}),
    _meta: { locked: base?._meta.locked ?? [], generatedBy: model },
  };
}

export function toLocation(x: LocationOut, id: string, named: readonly Named[], model: string, base?: Location): Location {
  return {
    formatVersion: FORMAT_VERSION,
    id,
    name: x.name,
    description: x.description,
    connections: [...new Set(x.connections.flatMap((n) => matchByName(n, [...named])?.id ?? []).filter((to) => to !== id))],
    backgrounds: base?.backgrounds ?? {},
    _meta: { locked: base?._meta.locked ?? [], generatedBy: model },
  };
}

/** 设定条目：重抽时只重写标题、分类、正文、触发词；触发方式、范围、优先级、知情人是设置，留着原来的。 */
export function toLore(x: LoreEntryOut, id: string, model: string, base?: LoreEntry): LoreEntry {
  return {
    formatVersion: FORMAT_VERSION,
    id,
    title: x.title,
    content: x.content,
    category: x.category || 'general',
    keys: [...new Set([x.title, ...x.keys].map((k) => k.trim()).filter(Boolean))],
    activation: base?.activation ?? (x.always ? 'always' : 'keyword'),
    scope: base?.scope ?? 'global',
    priority: base?.priority ?? (x.always ? 100 : 50),
    knownBy: base?.knownBy ?? 'public',
    _meta: { locked: base?._meta.locked ?? [], generatedBy: model },
  };
}

// ───────────── 重抽一整步时留下锁住的（20.4 的表） ─────────────

type Lockable = { id: string; _meta: { locked: string[] } };

/**
 * 原来的实体分三种：整个锁住的（或者模型能写的字段全锁了）原样留下；部分锁住的留下 id，模型只重写没锁的；
 * 没锁的换成新的。range 是这一步一共要几个（最少、最多），锁住的也算在内。
 */
export function keepPlan<T extends Lockable>(
  old: readonly T[],
  fields: FieldTable,
  modelFields: readonly string[],
  range: [number, number],
): KeepPlan<T> {
  const kept = old.filter((x) => x._meta.locked.length > 0);
  const full = kept.filter((x) => allLocked(x._meta.locked, modelFields));
  const partial = kept
    .filter((x) => !full.includes(x))
    .map((item): { item: T; fixed: FixedItem[] } => ({ item, fixed: fixedItems(item, item._meta.locked, fields) }));
  const n = kept.length;
  return { full, partial, fresh: [Math.max(0, range[0] - n), Math.max(0, range[1] - n)] };
}

/**
 * 模型写回来的列表和计划合并：带 id（或者名字对得上）的是要补全的那几个，其余是新的。
 * 返回按原来顺序排的留下的实体（部分锁住的已经盖回锁住的字段）和新的模型输出（最多 fresh[1] 个）。
 */
export function mergeKept<T extends Lockable & { name?: string; title?: string }, O extends { id: string }>(
  plan: KeepPlan<T>,
  old: readonly T[],
  outs: readonly O[],
  nameOf: (o: O) => string,
  build: (o: O, base: T) => T,
): { kept: T[]; fresh: O[] } {
  const waiting = new Map(plan.partial.map((p) => [p.item.id, p.item]));
  const merged = new Map<string, T>();
  const fresh: O[] = [];
  for (const o of outs) {
    const want = o.id.trim();
    let base = want ? waiting.get(want) : undefined;
    if (!base) base = [...waiting.values()].find((x) => (x.name ?? x.title ?? '') === nameOf(o).trim());
    if (base) {
      waiting.delete(base.id);
      merged.set(base.id, applyLocks(build(o, base), base, base._meta.locked));
    } else fresh.push(o);
  }
  const keepIds = new Set([...plan.full.map((x) => x.id), ...plan.partial.map((p) => p.item.id)]);
  // 模型漏写的部分锁住的：原样留下
  const kept = old.filter((x) => keepIds.has(x.id)).map((x) => merged.get(x.id) ?? x);
  return { kept, fresh: fresh.slice(0, Math.max(plan.fresh[1], 0)) };
}

/** 依次分配新 id：不和现在的、历史里出现过的重复。 */
export function idAllocator(prefix: string, taken: readonly string[]): () => string {
  const all = [...taken];
  return () => {
    const id = nextId(prefix, all);
    all.push(id);
    return id;
  };
}

/**
 * 重抽一整步时，换上来的和被换掉的同名（比如世界选项里定了主角叫什么）：当作同一个，用回原来的 id，
 * 这样剧情图、开场、周目存档和留下的角色的关系都还接得上。返回 新 id → 原来的 id。
 */
export function sameNameIds(created: readonly { id: string; name: string }[], replaced: readonly { id: string; name: string }[]): Map<string, string> {
  const map = new Map<string, string>();
  const free = [...replaced];
  for (const x of created) {
    const i = free.findIndex((o) => o.name.trim() === x.name.trim());
    const hit = free[i];
    if (!hit) continue;
    map.set(x.id, hit.id);
    free.splice(i, 1);
  }
  return map;
}

export function remapCharacterIds(list: Character[], map: ReadonlyMap<string, string>): Character[] {
  if (!map.size) return list;
  const to = (id: string) => map.get(id) ?? id;
  return list.map((c) => ({
    ...c,
    id: to(c.id),
    relationships: c.relationships.map((r) => ({ ...r, to: to(r.to) })),
    secrets: c.secrets.map((s) => (Array.isArray(s.knownBy) ? { ...s, knownBy: s.knownBy.map(to) } : s)),
  }));
}

export function remapLocationIds(list: Location[], map: ReadonlyMap<string, string>): Location[] {
  if (!map.size) return list;
  const to = (id: string) => map.get(id) ?? id;
  return list.map((l) => ({ ...l, id: to(l.id), connections: l.connections.map(to) }));
}

/** 去掉角色之间指向已经不在的角色的引用（关系、秘密的知情人）。 */
export function pruneCharacterRefs(list: Character[]): Character[] {
  const ids = new Set(list.map((c) => c.id));
  return list.map((c) => ({
    ...c,
    relationships: c.relationships.filter((r) => ids.has(r.to) && r.to !== c.id),
    secrets: c.secrets.map((s) => (Array.isArray(s.knownBy) ? { ...s, knownBy: s.knownBy.filter((x) => ids.has(x)) } : s)),
  }));
}

export function pruneLocationRefs(list: Location[]): Location[] {
  const ids = new Set(list.map((l) => l.id));
  return list.map((l) => ({ ...l, connections: l.connections.filter((x) => ids.has(x) && x !== l.id) }));
}
