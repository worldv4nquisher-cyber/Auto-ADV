import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  AssetIndex,
  AssetSettingsPatch,
  Character,
  FORMAT_VERSION,
  Location,
  LoreEntry,
  migrate,
  PlotGraph,
  StoryOpening,
  StyleGuide,
  type VariableDef,
  VariablesFile,
  VoiceCast,
  WorldBrief,
  WorldManifest,
} from '@auto-adv/schema';
import type { z } from 'zod';
import { readJsonFile, SerialQueue, writeFileAtomic } from '../util.ts';

/** 一个世界的全部文本内容。 */
export interface WorldData {
  manifest: WorldManifest;
  brief: WorldBrief | null;
  style: StyleGuide | null;
  worldview: string;
  characters: Character[];
  locations: Location[];
  lore: LoreEntry[];
  /** 剧情图（plot/outline.json）。M2 的旧骨架读取时自动迁移成剧情图（16.7，只在内存里迁移，下次写入时才改文件）。 */
  graph: PlotGraph | null;
  /** systems/variables.json */
  variables: VariableDef[];
  /** 手写剧本：幕 id → plot/scenes/ 下 .adv 文件的原文。 */
  scripts: Record<string, string>;
  opening: StoryOpening | null;
}

const ID_RE = /^[a-z0-9_]{1,64}$/;

export function assertWorldId(id: string): void {
  if (!ID_RE.test(id)) throw new Error('世界 id 不合法');
}

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

/** 一块内容的键（20.5）：`brief`、`style`、`worldview`、`variables`、`opening`、`plot`、`character:<id>`、`location:<id>`、`lore:<id>`。 */
export type WorldPartKey =
  | 'brief'
  | 'style'
  | 'worldview'
  | 'variables'
  | 'opening'
  | 'plot'
  | `character:${string}`
  | `location:${string}`
  | `lore:${string}`;

/** 历史版本是为什么留下的：你改之前、重新生成之前、删掉之前。 */
export type HistoryReason = 'edit' | 'genesis' | 'delete';
export const HISTORY_REASONS: readonly HistoryReason[] = ['edit', 'genesis', 'delete'];

export interface HistoryEntry {
  /** 历史文件名，读取时原样传回来。 */
  name: string;
  /** 被替换下来的时间。 */
  at: string;
  reason: HistoryReason;
}

/** 内容键对应的文件（相对世界目录）。 */
export function partFile(key: WorldPartKey): string {
  const [kind, id] = key.split(':') as [string, string | undefined];
  if (id !== undefined && !/^[a-z][a-z0-9_]*$/.test(id)) throw new Error('id 不合法');
  switch (kind) {
    case 'brief':
      return 'brief.json';
    case 'style':
      return 'style/style.json';
    case 'worldview':
      return 'setting/worldview.md';
    case 'variables':
      return 'systems/variables.json';
    case 'opening':
      return 'story/opening.json';
    case 'plot':
      return 'plot/outline.json';
    case 'character':
      return `characters/${id}/character.json`;
    case 'location':
      return `locations/${id}.json`;
    case 'lore':
      return `setting/lore/${id}.json`;
  }
  throw new Error(`不认识的内容：${key}`);
}

const ENTITY_DIRS = { character: 'characters', location: 'locations', lore: 'setting/lore' } as const;
const HISTORY_DIR = '.history';
const HISTORY_NAME = /^(\d{8}T\d{9}Z)(?:_(\d+))?-(edit|genesis|delete)\.(json|md)$/;

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:.]/g, '');
}

function stampTime(s: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z` : s;
}

export interface WorldStoreOptions {
  /** 每个文件留几个历史版本（20.5），不给就是 20；0 不留。 */
  historyLimit?: () => number;
}

/**
 * 世界文件夹读写。一个世界 = <root>/<id>/ 下的一组 JSON / Markdown 文件，格式见 docs/ARCHITECTURE.md 5.2。
 * 同一个世界的写操作串行执行，避免创世时并行的步骤互相覆盖清单。
 */
export class WorldStore {
  readonly root: string;
  private readonly queues = new Map<string, SerialQueue>();
  private readonly historyLimit: () => number;

  constructor(root: string, opts: WorldStoreOptions = {}) {
    this.root = root;
    this.historyLimit = opts.historyLimit ?? (() => 20);
  }

  dir(id: string): string {
    assertWorldId(id);
    return path.join(this.root, id);
  }

  private file(id: string, ...parts: string[]): string {
    return path.join(this.dir(id), ...parts);
  }

  private queue(id: string): SerialQueue {
    let q = this.queues.get(id);
    if (!q) {
      q = new SerialQueue();
      this.queues.set(id, q);
    }
    return q;
  }

  private async read<T>(file: string, schema: z.ZodType<T>): Promise<T | null> {
    const raw = await readJsonFile(file);
    if (raw === undefined) return null;
    return schema.parse(migrate(raw));
  }

  private async readDir<T>(dir: string, schema: z.ZodType<T>, fileName?: string): Promise<T[]> {
    let names: string[];
    try {
      names = (await fs.readdir(dir)).sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const out: T[] = [];
    for (const name of names) {
      const file = fileName ? path.join(dir, name, fileName) : path.join(dir, name);
      if (!fileName && !name.endsWith('.json')) continue;
      const item = await this.read(file, schema);
      if (item) out.push(item);
    }
    return out;
  }

  // ───────────── 清单 ─────────────

  async list(): Promise<WorldManifest[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.root);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const out: WorldManifest[] = [];
    for (const name of names) {
      if (!ID_RE.test(name)) continue;
      try {
        const m = await this.readManifest(name);
        if (m) out.push(m);
      } catch (err) {
        console.error(`[engine] 读取世界 ${name} 失败：`, err);
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  readManifest(id: string): Promise<WorldManifest | null> {
    return this.read(this.file(id, 'world.json'), WorldManifest);
  }

  async getManifest(id: string): Promise<WorldManifest> {
    const m = await this.readManifest(id);
    if (!m) throw new Error('世界不存在，可能已被删除');
    return m;
  }

  async create(manifest: WorldManifest): Promise<void> {
    await fs.mkdir(this.dir(manifest.id), { recursive: true });
    await writeFileAtomic(this.file(manifest.id, 'world.json'), json(manifest));
  }

  /** 读-改-写清单（串行）。 */
  updateManifest(id: string, fn: (m: WorldManifest) => WorldManifest): Promise<WorldManifest> {
    return this.queue(id).run(async () => {
      const next = WorldManifest.parse(fn(await this.getManifest(id)));
      next.updatedAt = new Date().toISOString();
      await writeFileAtomic(this.file(id, 'world.json'), json(next));
      return next;
    });
  }

  async delete(id: string): Promise<void> {
    await this.queue(id).run(() => fs.rm(this.dir(id), { recursive: true, force: true, maxRetries: 5 }));
    this.queues.delete(id);
  }

  /**
   * 把一个世界文件夹复制进来（不带 playthroughs/ 里的周目记录）。id 已经被占用时加数字后缀。
   * 复制完整读一遍，读不出来就删掉并报错。返回导入后的 id。
   */
  async importFolder(src: string): Promise<string> {
    const from = path.resolve(src);
    const raw = await readJsonFile(path.join(from, 'world.json'));
    if (raw === undefined) throw new Error('这个文件夹里没有 world.json，不是世界文件夹');
    const manifest = WorldManifest.parse(migrate(raw));
    const base = ID_RE.test(manifest.id) ? manifest.id.slice(0, 56) : 'world';
    const taken = new Set(await fs.readdir(this.root).catch(() => [] as string[]));
    let id = base;
    for (let i = 2; taken.has(id); i++) id = `${base}_${i}`;
    const to = this.dir(id);
    await fs.mkdir(this.root, { recursive: true });
    try {
      await fs.cp(from, to, {
        recursive: true,
        errorOnExist: true,
        force: false,
        filter: (s) => path.relative(from, s).split(path.sep)[0] !== 'playthroughs',
      });
      if (id !== manifest.id) await writeFileAtomic(this.file(id, 'world.json'), json({ ...manifest, id }));
      await this.load(id);
    } catch (err) {
      await fs.rm(to, { recursive: true, force: true, maxRetries: 5 });
      throw new Error(`导入失败：${err instanceof Error ? err.message : String(err)}`);
    }
    return id;
  }

  // ───────────── 内容 ─────────────

  async load(id: string): Promise<WorldData> {
    const [manifest, brief, style, worldview, characters, locations, lore, outline, variables, opening] =
      await Promise.all([
        this.getManifest(id),
        this.read(this.file(id, 'brief.json'), WorldBrief),
        this.read(this.file(id, 'style', 'style.json'), StyleGuide),
        this.readWorldview(id),
        this.readDir(this.file(id, 'characters'), Character, 'character.json'),
        this.readDir(this.file(id, 'locations'), Location),
        this.readDir(this.file(id, 'setting', 'lore'), LoreEntry),
        this.read(this.file(id, 'plot', 'outline.json'), PlotGraph),
        this.read(this.file(id, 'systems', 'variables.json'), VariablesFile),
        this.read(this.file(id, 'story', 'opening.json'), StoryOpening),
      ]);
    // 角色按创建顺序（id 里带序号），主角排第一
    characters.sort((a, b) => Number(b.role === 'protagonist') - Number(a.role === 'protagonist'));
    const scripts = outline ? await this.readScripts(id, outline) : {};
    return {
      manifest,
      brief,
      style,
      worldview,
      characters,
      locations,
      lore,
      graph: outline,
      variables: variables?.variables ?? [],
      scripts,
      opening,
    };
  }

  /** plot/scenes/ 下的手写剧本：幕的 script 字段指定的文件，没指定就找 <幕 id>.adv。 */
  private async readScripts(id: string, graph: PlotGraph): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const s of graph.scenes) {
      try {
        out[s.id] = await fs.readFile(this.file(id, 'plot', 'scenes', s.script ?? `${s.id}.adv`), 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    return out;
  }

  async readWorldview(id: string): Promise<string> {
    try {
      return await fs.readFile(this.file(id, 'setting', 'worldview.md'), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw err;
    }
  }

  // ───────────── 写入和历史版本（20.5） ─────────────

  /** 写一个内容文件；原来有、而且内容不一样时，先把原来的存进历史。 */
  private async put(id: string, rel: string, content: string, reason: HistoryReason): Promise<void> {
    await this.snapshot(id, rel, reason, content);
    await writeFileAtomic(path.join(this.dir(id), rel), content);
  }

  /** 把现在的文件存进 .history/<相对路径>/；next 和现在一样时不存。 */
  private async snapshot(id: string, rel: string, reason: HistoryReason, next?: string): Promise<void> {
    const limit = this.historyLimit();
    if (limit <= 0) return;
    let old: string;
    try {
      old = await fs.readFile(path.join(this.dir(id), rel), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    if (next !== undefined && old === next) return;
    const dir = path.join(this.dir(id), HISTORY_DIR, rel);
    await fs.mkdir(dir, { recursive: true });
    const ext = rel.endsWith('.md') ? 'md' : 'json';
    const base = stamp(new Date());
    const taken = new Set(await fs.readdir(dir));
    let name = `${base}-${reason}.${ext}`;
    for (let i = 2; taken.has(name); i++) name = `${base}_${i}-${reason}.${ext}`;
    await writeFileAtomic(path.join(dir, name), old);
    const all = (await fs.readdir(dir)).filter((n) => HISTORY_NAME.test(n)).sort();
    for (const n of all.slice(0, Math.max(0, all.length - limit))) await fs.rm(path.join(dir, n), { force: true });
  }

  /** 一块内容的历史版本，新的在前。 */
  async listHistory(id: string, key: WorldPartKey): Promise<HistoryEntry[]> {
    const dir = path.join(this.dir(id), HISTORY_DIR, partFile(key));
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    return names
      .flatMap((name) => {
        const m = HISTORY_NAME.exec(name);
        return m ? [{ name, at: stampTime(m[1] as string), reason: m[3] as HistoryReason }] : [];
      })
      .sort((a, b) => b.name.localeCompare(a.name));
  }

  /** 读一个历史版本的原文。 */
  async readHistory(id: string, key: WorldPartKey, name: string): Promise<string> {
    if (!HISTORY_NAME.test(name)) throw new Error('历史版本的文件名不合法');
    return fs.readFile(path.join(this.dir(id), HISTORY_DIR, partFile(key), name), 'utf8');
  }

  writeBrief(id: string, brief: WorldBrief, reason: HistoryReason = 'genesis') {
    return this.put(id, partFile('brief'), json(WorldBrief.parse(brief)), reason);
  }

  writeStyle(id: string, style: StyleGuide, reason: HistoryReason = 'genesis') {
    return this.put(id, partFile('style'), json(StyleGuide.parse(style)), reason);
  }

  writeWorldview(id: string, text: string, reason: HistoryReason = 'genesis') {
    return this.put(id, partFile('worldview'), text.endsWith('\n') ? text : `${text}\n`, reason);
  }

  writePlot(id: string, graph: PlotGraph, reason: HistoryReason = 'genesis') {
    return this.put(id, partFile('plot'), json(PlotGraph.parse(graph)), reason);
  }

  writeVariables(id: string, variables: VariableDef[], reason: HistoryReason = 'genesis') {
    return this.put(id, partFile('variables'), json(VariablesFile.parse({ variables })), reason);
  }

  writeOpening(id: string, opening: StoryOpening, reason: HistoryReason = 'genesis') {
    return this.put(id, partFile('opening'), json(StoryOpening.parse(opening)), reason);
  }

  /** 整体替换某一类实体（重新生成这一步）：要去掉的、内容变了的先存进历史，再删旧目录逐个写入。 */
  private async replaceAll<T extends { id: string }>(
    id: string,
    kind: 'character' | 'location' | 'lore',
    items: T[],
    schema: z.ZodType<T>,
  ): Promise<void> {
    const dir = path.join(this.dir(id), ENTITY_DIRS[kind]);
    const next = new Map(items.map((item) => [partFile(`${kind}:${item.id}`), json(schema.parse(item))]));
    let existing: string[] = [];
    try {
      existing = await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    for (const name of existing) {
      const eid = name.replace(/\.json$/, '');
      if (!/^[a-z][a-z0-9_]*$/.test(eid)) continue;
      const rel = partFile(`${kind}:${eid}`);
      await this.snapshot(id, rel, next.has(rel) ? 'genesis' : 'delete', next.get(rel));
    }
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
    for (const [rel, content] of next) await writeFileAtomic(path.join(this.dir(id), rel), content);
  }

  /** 删掉一个角色、地点或设定条目（先存进历史）。 */
  async deleteEntity(id: string, key: `character:${string}` | `location:${string}` | `lore:${string}`): Promise<void> {
    const rel = partFile(key);
    await this.snapshot(id, rel, 'delete');
    const target = key.startsWith('character:') ? path.dirname(rel) : rel;
    await fs.rm(path.join(this.dir(id), target), { recursive: true, force: true, maxRetries: 5 });
  }

  // ───────────── 素材（18.2） ─────────────

  /** 素材文件的绝对路径。rel 是相对世界目录的路径，只能在 assets/ 下面。 */
  assetPath(id: string, rel: string): string {
    const root = path.join(this.dir(id), 'assets');
    const file = path.resolve(this.dir(id), rel);
    if (file !== root && !file.startsWith(root + path.sep)) throw new Error('素材路径不合法');
    return file;
  }

  async readAssetIndex(id: string): Promise<AssetIndex> {
    return (await this.read(this.file(id, 'assets', 'index.json'), AssetIndex)) ?? AssetIndex.parse({});
  }

  writeAssetIndex(id: string, index: AssetIndex) {
    return writeFileAtomic(this.file(id, 'assets', 'index.json'), json(AssetIndex.parse(index)));
  }

  /** 这个世界的素材设置（只写和全局不一样的项）。 */
  async readAssetSettings(id: string): Promise<AssetSettingsPatch> {
    const raw = await readJsonFile(this.file(id, 'assets', 'settings.json'));
    if (raw === undefined) return {};
    const { formatVersion: _v, ...rest } = migrate(raw);
    return AssetSettingsPatch.parse(rest);
  }

  writeAssetSettings(id: string, patch: AssetSettingsPatch) {
    return writeFileAtomic(this.file(id, 'assets', 'settings.json'), json({ formatVersion: FORMAT_VERSION, ...AssetSettingsPatch.parse(patch) }));
  }

  /** 这个世界的配音表（18.8）。 */
  async readVoiceCast(id: string): Promise<VoiceCast> {
    return (await this.read(this.file(id, 'assets', 'voices.json'), VoiceCast)) ?? VoiceCast.parse({});
  }

  writeVoiceCast(id: string, cast: VoiceCast) {
    return writeFileAtomic(this.file(id, 'assets', 'voices.json'), json(VoiceCast.parse(cast)));
  }

  writeCharacters(id: string, items: Character[]) {
    return this.replaceAll(id, 'character', items, Character);
  }

  /** 新建或改写一个角色（只动这个角色的文件）。 */
  writeCharacter(id: string, c: Character, reason: HistoryReason = 'genesis') {
    return this.put(id, partFile(`character:${c.id}`), json(Character.parse(c)), reason);
  }

  writeLocations(id: string, items: Location[]) {
    return this.replaceAll(id, 'location', items, Location);
  }

  writeLocation(id: string, l: Location, reason: HistoryReason = 'genesis') {
    return this.put(id, partFile(`location:${l.id}`), json(Location.parse(l)), reason);
  }

  writeLore(id: string, items: LoreEntry[]) {
    return this.replaceAll(id, 'lore', items, LoreEntry);
  }

  writeLoreEntry(id: string, e: LoreEntry, reason: HistoryReason = 'genesis') {
    return this.put(id, partFile(`lore:${e.id}`), json(LoreEntry.parse(e)), reason);
  }
}
