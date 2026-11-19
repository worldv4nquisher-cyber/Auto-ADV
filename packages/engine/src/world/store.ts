import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  Character,
  Location,
  LoreEntry,
  migrate,
  PlotOutline,
  StoryOpening,
  StyleGuide,
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
  plot: PlotOutline | null;
  opening: StoryOpening | null;
}

const ID_RE = /^[a-z0-9_]{1,64}$/;

export function assertWorldId(id: string): void {
  if (!ID_RE.test(id)) throw new Error('世界 id 不合法');
}

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

/**
 * 世界文件夹读写。一个世界 = <root>/<id>/ 下的一组 JSON / Markdown 文件，格式见 docs/ARCHITECTURE.md 5.2。
 * 同一个世界的写操作串行执行，避免创世时并行的步骤互相覆盖清单。
 */
export class WorldStore {
  readonly root: string;
  private readonly queues = new Map<string, SerialQueue>();

  constructor(root: string) {
    this.root = root;
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

  // ───────────── 内容 ─────────────

  async load(id: string): Promise<WorldData> {
    const [manifest, brief, style, worldview, characters, locations, lore, plot, opening] = await Promise.all([
      this.getManifest(id),
      this.read(this.file(id, 'brief.json'), WorldBrief),
      this.read(this.file(id, 'style', 'style.json'), StyleGuide),
      this.readWorldview(id),
      this.readDir(this.file(id, 'characters'), Character, 'character.json'),
      this.readDir(this.file(id, 'locations'), Location),
      this.readDir(this.file(id, 'setting', 'lore'), LoreEntry),
      this.read(this.file(id, 'plot', 'outline.json'), PlotOutline),
      this.read(this.file(id, 'story', 'opening.json'), StoryOpening),
    ]);
    // 角色按创建顺序（id 里带序号），主角排第一
    characters.sort((a, b) => Number(b.role === 'protagonist') - Number(a.role === 'protagonist'));
    return { manifest, brief, style, worldview, characters, locations, lore, plot, opening };
  }

  async readWorldview(id: string): Promise<string> {
    try {
      return await fs.readFile(this.file(id, 'setting', 'worldview.md'), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw err;
    }
  }

  writeBrief(id: string, brief: WorldBrief) {
    return writeFileAtomic(this.file(id, 'brief.json'), json(WorldBrief.parse(brief)));
  }

  writeStyle(id: string, style: StyleGuide) {
    return writeFileAtomic(this.file(id, 'style', 'style.json'), json(StyleGuide.parse(style)));
  }

  writeWorldview(id: string, text: string) {
    return writeFileAtomic(this.file(id, 'setting', 'worldview.md'), text.endsWith('\n') ? text : `${text}\n`);
  }

  writePlot(id: string, plot: PlotOutline) {
    return writeFileAtomic(this.file(id, 'plot', 'outline.json'), json(PlotOutline.parse(plot)));
  }

  writeOpening(id: string, opening: StoryOpening) {
    return writeFileAtomic(this.file(id, 'story', 'opening.json'), json(StoryOpening.parse(opening)));
  }

  /** 整体替换某一类实体：先删旧目录再逐个写入。 */
  private async replaceAll<T extends { id: string }>(
    dir: string,
    items: T[],
    schema: z.ZodType<T>,
    fileName?: string,
  ): Promise<void> {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
    for (const item of items) {
      const file = fileName ? path.join(dir, item.id, fileName) : path.join(dir, `${item.id}.json`);
      await writeFileAtomic(file, json(schema.parse(item)));
    }
  }

  writeCharacters(id: string, items: Character[]) {
    return this.replaceAll(this.file(id, 'characters'), items, Character, 'character.json');
  }

  writeLocations(id: string, items: Location[]) {
    return this.replaceAll(this.file(id, 'locations'), items, Location);
  }

  writeLore(id: string, items: LoreEntry[]) {
    return this.replaceAll(this.file(id, 'setting', 'lore'), items, LoreEntry);
  }
}
