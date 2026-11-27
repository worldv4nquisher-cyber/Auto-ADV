/**
 * 世界编辑器（M5 第 1 步，docs/ARCHITECTURE.md 20.5）：每一块内容的版本号、手改时自动加锁、引用检查、
 * 删除时列出和去掉引用。只做纯计算，读写文件在 WorldStore 和 Engine 里。
 */
import { createHash } from 'node:crypto';
import {
  Character,
  Location,
  LoreEntry,
  StoryOpening,
  StyleGuide,
  VariableDef,
  WorldBrief,
} from '@auto-adv/schema';
import { z } from 'zod';
import type { WorldData, WorldPartKey } from './store.ts';

/** 能编辑的一块内容。新建的角色、地点、设定条目 id 留空，由引擎分配。 */
export type WorldPart =
  | { part: 'manifest'; data: { title: string; logline: string; locked?: string[] } }
  | { part: 'brief'; data: WorldBrief }
  | { part: 'style'; data: StyleGuide }
  | { part: 'worldview'; data: string }
  | { part: 'variables'; data: VariableDef[] }
  | { part: 'opening'; data: StoryOpening }
  | { part: 'character'; data: Omit<Character, 'id'> & { id?: string } }
  | { part: 'location'; data: Omit<Location, 'id'> & { id?: string } }
  | { part: 'lore'; data: Omit<LoreEntry, 'id'> & { id?: string } };

export type EntityKind = 'character' | 'location' | 'lore';

/** 版本号的键：内容键，外加 `manifest`（世界名和一句话简介）。 */
export type RevKey = WorldPartKey | 'manifest';

/** 一个问题：悬空的引用、重复的名字之类。`key` 指向出问题的那块内容。 */
export interface WorldIssue {
  key: RevKey;
  field?: string;
  level: 'error' | 'warning';
  message: string;
}

/** 别处对某个角色或地点的一处引用。removable：删除时能自动去掉（手写剧本里的要自己改）。 */
export interface WorldRef {
  key: RevKey | `script:${string}`;
  field: string;
  label: string;
  removable: boolean;
}

const hash = (v: unknown) => createHash('sha1').update(JSON.stringify(v ?? null)).digest('hex').slice(0, 12);

/** 某一块内容现在的版本号：保存时带上打开时的版本号，对不上说明这之间被别处改过（20.5 第 3 条）。 */
export function revOf(world: WorldData, key: RevKey): string {
  return hash(contentOf(world, key));
}

export function contentOf(world: WorldData, key: RevKey): unknown {
  const [kind, id] = key.split(':') as [string, string | undefined];
  switch (kind) {
    case 'manifest':
      return { title: world.manifest.title, logline: world.manifest.logline };
    case 'brief':
      return world.brief;
    case 'style':
      return world.style;
    case 'worldview':
      return world.worldview;
    case 'variables':
      return world.variables;
    case 'opening':
      return world.opening;
    case 'plot':
      return world.graph;
    case 'character':
      return world.characters.find((c) => c.id === id) ?? null;
    case 'location':
      return world.locations.find((l) => l.id === id) ?? null;
    case 'lore':
      return world.lore.find((e) => e.id === id) ?? null;
  }
  return null;
}

/** 世界里所有内容的版本号（界面打开时拿到，保存时带回来）。 */
export function allRevs(world: WorldData): Record<string, string> {
  const keys: RevKey[] = [
    'manifest',
    'brief',
    'style',
    'worldview',
    'variables',
    'opening',
    'plot',
    ...world.characters.map((c) => `character:${c.id}` as const),
    ...world.locations.map((l) => `location:${l.id}` as const),
    ...world.lore.map((e) => `lore:${e.id}` as const),
  ];
  return Object.fromEntries(keys.map((k) => [k, revOf(world, k)]));
}

// ───────────── 自动加锁（20.4） ─────────────

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const SKIP = new Set(['_meta', 'formatVersion', 'id']);

/**
 * 两个版本之间改了哪些字段，按字段路径列出（例如 `name`、`appearance.text`）。
 * 只往下看两层：对象里的对象再拆开，列表整个算一个字段。
 */
export function changedPaths(before: unknown, after: unknown, depth = 2, prefix = ''): string[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (depth > 0 && isObject(before) && isObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => !SKIP.has(k));
    return keys.flatMap((k) => changedPaths(before[k], after[k], depth - 1, prefix ? `${prefix}.${k}` : k));
  }
  return prefix ? [prefix] : [];
}

/** 新建的实体拿来对比的"空白"：字符串变空、列表变空，数字和开关不变（不算你填的）。 */
function blank(v: unknown): unknown {
  if (typeof v === 'string') return '';
  if (Array.isArray(v)) return [];
  if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, blank(x)]));
  return v;
}

/** 新建的实体里你填了的字段（和全空的比）。 */
export function filledPaths(after: unknown): string[] {
  return changedPaths(blank(after), after);
}

/** 新建时拿来对比的默认内容：schema 的默认值，必填的文字留空。和它不一样的字段才算你填的。 */
export function defaultsOf(part: 'brief' | 'style' | 'opening' | EntityKind, id = 'x'): unknown {
  switch (part) {
    case 'brief':
      return WorldBrief.parse({ genre: '', tone: '' });
    case 'style':
      return StyleGuide.parse({});
    case 'opening':
      return StoryOpening.parse({ narration: '' });
    case 'character':
      return { ...Character.parse({ id, name: '-' }), name: '' };
    case 'location':
      return { ...Location.parse({ id, name: '-' }), name: '' };
    case 'lore':
      return { ...LoreEntry.parse({ id, title: '-', content: '' }), title: '' };
  }
}

/** 合并锁：已有的锁加上这次改过的字段；已经锁了整个（`*`）就不再细分。 */
export function mergeLocks(locked: readonly string[], changed: readonly string[]): string[] {
  if (locked.includes('*')) return ['*'];
  const out = [...locked];
  for (const p of changed) {
    // 已经锁了上一层（例如锁了 appearance，又改了 appearance.text）就不用再加
    if (out.some((x) => x === p || p.startsWith(`${x}.`))) continue;
    out.push(p);
  }
  return out;
}

// ───────────── 校验 ─────────────

export const PART_SCHEMAS = {
  brief: WorldBrief,
  style: StyleGuide,
  opening: StoryOpening,
  character: Character,
  location: Location,
  lore: LoreEntry,
  variables: z.array(VariableDef),
} as const;

/** zod 的错误改成一句看得懂的话：哪个字段、哪里不对。 */
export function zodMessage(err: z.ZodError): string {
  const first = err.issues.slice(0, 3).map((i) => `${i.path.length ? `${i.path.join('.')}：` : ''}${i.message}`);
  return `${first.join('；')}${err.issues.length > 3 ? `（共 ${err.issues.length} 处）` : ''}`;
}

/** 按 schema 校验，不合格抛出带字段路径的错误。 */
export function parsePart<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const r = schema.safeParse(data);
  if (!r.success) throw Object.assign(new Error(`${label}的内容不对：${zodMessage(r.error)}`), { code: 'invalid' });
  return r.data;
}

/** 新实体的 id：前缀 + 现有最大序号 + 1，两位数起（char_05、loc_07）。 */
export function nextId(prefix: string, taken: readonly string[]): string {
  const re = new RegExp(`^${prefix}_(\\d+)$`);
  const max = taken.reduce((m, id) => Math.max(m, Number(re.exec(id)?.[1] ?? 0)), 0);
  const set = new Set(taken);
  for (let n = max + 1; ; n++) {
    const id = `${prefix}_${String(n).padStart(2, '0')}`;
    if (!set.has(id)) return id;
  }
}

export const ID_PREFIX: Record<EntityKind, string> = { character: 'char', location: 'loc', lore: 'lore' };

// ───────────── 引用检查（20.5 第 2 条） ─────────────

/** 不涉及剧情图结构的检查：悬空的引用、重复的名字、主角的个数。剧情图本身的检查是 checkWorldPlot。 */
export function checkWorld(world: WorldData): WorldIssue[] {
  const issues: WorldIssue[] = [];
  const warn = (key: RevKey, message: string, field?: string) =>
    issues.push({ key, level: 'warning', message, ...(field ? { field } : {}) });
  const chars = new Map(world.characters.map((c) => [c.id, c]));
  const locs = new Map(world.locations.map((l) => [l.id, l]));
  const charName = (id: string) => chars.get(id)?.name ?? id;

  const protagonists = world.characters.filter((c) => c.role === 'protagonist');
  if (world.characters.length && protagonists.length === 0) {
    warn('brief', '没有主角：自由对话里你扮演谁要在开始时另选（把一个角色的定位改成"主角"）');
  }
  if (protagonists.length > 1) {
    for (const c of protagonists.slice(1)) {
      warn(`character:${c.id}`, `有 ${protagonists.length} 个主角，只有第一个（${protagonists[0]?.name}）由你扮演`, 'role');
    }
  }
  const seen = new Map<string, string>();
  for (const c of world.characters) {
    const key = `character:${c.id}` as const;
    const other = seen.get(c.name);
    if (other) warn(key, `和 ${other} 重名，AI 分不清是谁`, 'name');
    else seen.set(c.name, c.id);
    for (const r of c.relationships) {
      if (r.to === c.id) warn(key, '关系里有自己', 'relationships');
      else if (!chars.has(r.to)) warn(key, `关系里的 ${r.to} 不存在`, 'relationships');
    }
    for (const s of c.secrets) {
      if (Array.isArray(s.knownBy)) {
        for (const id of s.knownBy) if (!chars.has(id)) warn(key, `秘密「${clipText(s.text)}」的知情人 ${id} 不存在`, 'secrets');
      }
    }
  }
  const seenLoc = new Map<string, string>();
  for (const l of world.locations) {
    const key = `location:${l.id}` as const;
    if (seenLoc.has(l.name)) warn(key, `和另一个地点重名`, 'name');
    else seenLoc.set(l.name, l.id);
    for (const to of l.connections) {
      if (to === l.id) warn(key, '连着的地点里有自己', 'connections');
      else if (!locs.has(to)) warn(key, `连着的地点 ${to} 不存在`, 'connections');
    }
  }
  for (const e of world.lore) {
    const key = `lore:${e.id}` as const;
    if (Array.isArray(e.knownBy)) {
      for (const id of e.knownBy) if (!chars.has(id)) warn(key, `知情人 ${id} 不存在`, 'knownBy');
    }
    const scope = /^(character|location):(.+)$/.exec(e.scope);
    if (e.scope !== 'global' && !scope) warn(key, `范围「${e.scope}」看不懂：只能是全局、某个角色或某个地点`, 'scope');
    if (scope?.[1] === 'character' && !chars.has(scope[2] as string)) warn(key, `范围里的角色 ${scope[2]} 不存在`, 'scope');
    if (scope?.[1] === 'location' && !locs.has(scope[2] as string)) warn(key, `范围里的地点 ${scope[2]} 不存在`, 'scope');
    if (e.activation === 'keyword' && e.keys.length === 0) warn(key, '按关键词触发，但没有关键词，永远不会出现', 'keys');
  }
  const o = world.opening;
  if (o) {
    if (o.locationId && !locs.has(o.locationId)) warn('opening', `开场地点 ${o.locationId} 不存在`, 'locationId');
    for (const id of o.presentCharacterIds) if (!chars.has(id)) warn('opening', `在场角色 ${id} 不存在`, 'presentCharacterIds');
    for (const l of o.lines) if (!chars.has(l.characterId)) warn('opening', `开场台词的说话人 ${l.characterId} 不存在`, 'lines');
    if (o.lines.some((l) => !o.presentCharacterIds.includes(l.characterId) && chars.has(l.characterId))) {
      const who = o.lines.find((l) => !o.presentCharacterIds.includes(l.characterId))?.characterId ?? '';
      warn('opening', `${charName(who)} 有开场台词，但不在在场角色里`, 'presentCharacterIds');
    }
  }
  return issues;
}

function clipText(s: string, n = 12): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** 别处对某个角色或地点的引用（删除前列出来，20.5"删除"）。设定条目没人引用。 */
export function referencesTo(world: WorldData, kind: EntityKind, id: string): WorldRef[] {
  const refs: WorldRef[] = [];
  const add = (key: WorldRef['key'], field: string, label: string, removable = true) =>
    refs.push({ key, field, label, removable });
  if (kind === 'lore') return refs;
  if (kind === 'character') {
    for (const c of world.characters) {
      if (c.id === id) continue;
      if (c.relationships.some((r) => r.to === id)) add(`character:${c.id}`, 'relationships', `${c.name}的关系`);
      if (c.secrets.some((s) => Array.isArray(s.knownBy) && s.knownBy.includes(id))) {
        add(`character:${c.id}`, 'secrets', `${c.name}的秘密的知情人`);
      }
    }
    for (const e of world.lore) {
      if (Array.isArray(e.knownBy) && e.knownBy.includes(id)) add(`lore:${e.id}`, 'knownBy', `设定「${e.title}」的知情人`);
      if (e.scope === `character:${id}`) add(`lore:${e.id}`, 'scope', `设定「${e.title}」只对这个角色生效（会改成全局）`);
    }
    for (const s of world.graph?.scenes ?? []) {
      if (s.cast.includes(id)) add('plot', `scenes.${s.id}.cast`, `剧情图「${s.title || s.id}」的出场角色`);
    }
    const o = world.opening;
    if (o?.presentCharacterIds.includes(id)) add('opening', 'presentCharacterIds', '开场的在场角色');
    if (o?.lines.some((l) => l.characterId === id)) add('opening', 'lines', '开场台词（会删掉这个角色说的）');
  } else {
    for (const l of world.locations) {
      if (l.id !== id && l.connections.includes(id)) add(`location:${l.id}`, 'connections', `${l.name}连着的地点`);
    }
    for (const e of world.lore) {
      if (e.scope === `location:${id}`) add(`lore:${e.id}`, 'scope', `设定「${e.title}」只在这个地点生效（会改成全局）`);
    }
    for (const s of world.graph?.scenes ?? []) {
      if (s.location === id) add('plot', `scenes.${s.id}.location`, `剧情图「${s.title || s.id}」的地点`);
    }
    if (world.opening?.locationId === id) add('opening', 'locationId', '开场地点');
  }
  // 手写剧本里按 id 写的（立绘、背景、说话人），只能自己改
  const word = new RegExp(`(^|[^a-z0-9_])${id}([^a-z0-9_]|$)`, 'm');
  for (const [sceneId, text] of Object.entries(world.scripts)) {
    if (word.test(text)) add(`script:${sceneId}`, 'text', `幕 ${sceneId} 的手写剧本（要自己改）`, false);
  }
  return refs;
}

/** 删掉某个角色或地点时，把能去掉的引用都去掉，返回改过的内容（还没写盘）。 */
export function withoutReferences(world: WorldData, kind: EntityKind, id: string): Partial<Pick<WorldData, 'characters' | 'locations' | 'lore' | 'graph' | 'opening'>> {
  const out: Partial<Pick<WorldData, 'characters' | 'locations' | 'lore' | 'graph' | 'opening'>> = {};
  const changed = <T>(a: T, b: T) => JSON.stringify(a) !== JSON.stringify(b);
  if (kind === 'lore') return out;
  if (kind === 'character') {
    const chars = world.characters
      .filter((c) => c.id !== id)
      .map((c) => ({
        ...c,
        relationships: c.relationships.filter((r) => r.to !== id),
        secrets: c.secrets.map((s) => (Array.isArray(s.knownBy) ? { ...s, knownBy: s.knownBy.filter((x) => x !== id) } : s)),
      }));
    if (changed(chars, world.characters.filter((c) => c.id !== id))) out.characters = chars;
  } else {
    const locs = world.locations
      .filter((l) => l.id !== id)
      .map((l) => ({ ...l, connections: l.connections.filter((x) => x !== id) }));
    if (changed(locs, world.locations.filter((l) => l.id !== id))) out.locations = locs;
  }
  const scope = `${kind}:${id}`;
  const lore = world.lore.map((e) => ({
    ...e,
    knownBy: kind === 'character' && Array.isArray(e.knownBy) ? e.knownBy.filter((x) => x !== id) : e.knownBy,
    scope: e.scope === scope ? 'global' : e.scope,
  }));
  if (changed(lore, world.lore)) out.lore = lore;
  if (world.graph) {
    const graph = {
      ...world.graph,
      scenes: world.graph.scenes.map((s) => {
        if (kind === 'character') return { ...s, cast: s.cast.filter((x) => x !== id) };
        if (s.location !== id) return s;
        const { location: _l, ...rest } = s;
        return rest;
      }),
    };
    if (changed(graph, world.graph)) out.graph = graph;
  }
  if (world.opening) {
    const o = world.opening;
    const opening =
      kind === 'character'
        ? { ...o, presentCharacterIds: o.presentCharacterIds.filter((x) => x !== id), lines: o.lines.filter((l) => l.characterId !== id) }
        : o.locationId === id
          ? (({ locationId: _x, ...rest }) => rest)(o)
          : o;
    if (changed(opening, o)) out.opening = opening;
  }
  return out;
}
