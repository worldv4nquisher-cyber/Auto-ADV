import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AUDIO_EXTENSIONS } from '@auto-adv/providers';
import type { AssetIndex, BgmSettings, BgmSource, MoodDef } from '@auto-adv/schema';
import { z } from 'zod';
import type { BgmTrack, LibraryTrack, MoodPlaylist } from '../api.ts';
import { moodOf } from '../plot/stage.ts';

export type { BgmTrack, LibraryTrack, MoodPlaylist } from '../api.ts';

/**
 * BGM 的三种来源（18.7）：本地曲库、音乐模型、内置古典曲库，按设置里的顺序找。
 * 音乐模型生成的曲子是素材槽 bgm/<情绪>（和图片一样排队、缓存、锁定、换成自己的文件）；
 * 本地曲库和内置曲库只引用，不复制进世界目录。
 */

// ───────────── 本地曲库 ─────────────

export interface LibraryScan {
  dir: string;
  tracks: LibraryTrack[];
  /** 文件夹读不了（不存在、没权限）。 */
  error: string | null;
  /** 文件太多，只读了前面这些。 */
  truncated: boolean;
}

const MAX_FILES = 2000;
const MAX_DEPTH = 3;
const AUDIO_RE = new RegExp(`\\.(${AUDIO_EXTENSIONS.join('|')})$`, 'i');

const stemOf = (file: string) => path.basename(file).replace(/\.[^.]+$/, '');

/** 一个文件按子文件夹名（从里往外）和文件名认情绪。 */
export function libraryMoodOf(rel: string, moods: readonly MoodDef[]): { mood: string | null; by: LibraryTrack['by'] } {
  const parts = rel.split('/');
  for (const folder of parts.slice(0, -1).reverse()) {
    const m = moodOf(folder, moods);
    if (m) return { mood: m, by: 'folder' };
  }
  const m = moodOf(stemOf(rel), moods);
  return m ? { mood: m, by: 'name' } : { mood: null, by: null };
}

/** 扫一遍本地曲库：最多三层子文件夹、两千个文件，只认音频文件。 */
export async function scanLibrary(dir: string, moods: readonly MoodDef[]): Promise<LibraryScan> {
  const root = path.resolve(dir);
  const tracks: LibraryTrack[] = [];
  let truncated = false;
  const walk = async (abs: string, rel: string, depth: number): Promise<void> => {
    const entries = await fs.readdir(abs, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (tracks.length >= MAX_FILES) {
        truncated = true;
        return;
      }
      if (e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH) await walk(path.join(abs, e.name), r, depth + 1);
      } else if (e.isFile() && AUDIO_RE.test(e.name)) {
        tracks.push({ rel: r, name: stemOf(e.name), ...libraryMoodOf(r, moods) });
      }
    }
  };
  try {
    const st = await fs.stat(root);
    if (!st.isDirectory()) return { dir: root, tracks: [], error: '这不是一个文件夹', truncated: false };
    await walk(root, '', 0);
    return { dir: root, tracks, error: null, truncated };
  } catch (err) {
    const code = (err as { code?: string }).code;
    const error = code === 'ENOENT' ? '文件夹不存在' : code === 'EACCES' || code === 'EPERM' ? '没有权限读这个文件夹' : String(err);
    return { dir: root, tracks: [], error, truncated: false };
  }
}

/** 文本模型按文件名挑情绪的结果：{ 文件夹: { 相对路径: 情绪 id 或 null } }，存在数据目录里，同一个文件只问一次。 */
export const LibraryMoodCache = z.record(z.string(), z.record(z.string(), z.string().nullable()));
export type LibraryMoodCache = z.infer<typeof LibraryMoodCache>;

/** 文本模型挑情绪的缓存键：情绪表变了要重新挑。 */
export const moodTableKey = (moods: readonly MoodDef[]) => moods.map((m) => m.id).join(',');

// ───────────── 内置曲库 ─────────────

/** 内置曲库的一首（resources/bgm/manifest.json）。每首都要写清楚来源和授权（18.7）。 */
export const BuiltinTrackDef = z.object({
  file: z.string().regex(/^[\w.-]+$/, '内置曲目的文件名只能用字母、数字、点、横线和下划线'),
  title: z.string(),
  composer: z.string(),
  mood: z.string(),
  /** 乐谱或录音从哪里来（链接）。 */
  source: z.string(),
  /** 怎么做出来的：用哪个音色库渲染，或者是谁的录音。 */
  method: z.string(),
  /** 授权，例如"作品：公有领域；乐谱：CC0；音色库：…"。 */
  license: z.string(),
});
export type BuiltinTrackDef = z.infer<typeof BuiltinTrackDef>;

export const BuiltinManifest = z.object({ tracks: z.array(BuiltinTrackDef).default([]) });

/** 读内置曲库的清单，去掉文件不在的曲目。文件夹或清单不存在就是空的曲库。 */
export async function loadBuiltin(dir: string | undefined): Promise<BuiltinTrackDef[]> {
  if (!dir) return [];
  try {
    const m = BuiltinManifest.parse(JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')));
    const ok = await Promise.all(m.tracks.map((t) => fs.access(path.join(dir, t.file)).then(() => true, () => false)));
    return m.tracks.filter((_, i) => ok[i]);
  } catch (err) {
    if ((err as { code?: string }).code !== 'ENOENT') console.error('[assets] 读不了内置曲库的清单：', err);
    return [];
  }
}

// ───────────── 每个情绪放什么 ─────────────

export interface BgmSources {
  settings: BgmSettings;
  /** 素材槽的登记（bgm/<情绪> 的文件）。 */
  index: AssetIndex;
  library: readonly LibraryTrack[];
  builtin: readonly BuiltinTrackDef[];
  /** 配了音乐职责没有。 */
  modelReady: boolean;
}

/**
 * 每个情绪按来源顺序找曲子（18.7）：你换成自己的文件的最优先；给这个情绪指定了来源就只用它；
 * 否则按顺序找第一个有曲子的来源。轮到音乐模型、而这首还没生成好时，标上 wantsModel，先用后面的来源。
 */
export function resolveBgm(s: BgmSources): MoodPlaylist[] {
  return s.settings.moods.map((m) => {
    const rec = s.index.slots[`bgm/${m.id}`];
    const base = { mood: m.id, name: m.name };
    if (rec?.file && rec.source === 'uploaded') {
      return { ...base, source: 'uploaded', wantsModel: false, tracks: [{ ref: { kind: 'world', path: rec.file }, title: '自己的文件', source: 'uploaded', loop: true }] };
    }
    const pin = s.settings.pins[m.id];
    const order = pin ? [pin] : s.settings.sources;
    let wantsModel = false;
    for (const src of order) {
      if (src === 'library') {
        const tracks = s.library.filter((t) => t.mood === m.id);
        if (tracks.length) {
          return { ...base, source: src, wantsModel, tracks: tracks.map((t) => ({ ref: { kind: 'library', path: t.rel }, title: t.name, source: src, loop: false })) };
        }
      } else if (src === 'model') {
        if (rec?.file) {
          return { ...base, source: src, wantsModel: false, tracks: [{ ref: { kind: 'world', path: rec.file }, title: '音乐模型生成的', source: src, loop: true }] };
        }
        if (s.modelReady) wantsModel = true;
      } else {
        const tracks = s.builtin.filter((t) => t.mood === m.id);
        if (tracks.length) {
          return {
            ...base,
            source: src,
            wantsModel,
            tracks: tracks.map((t) => ({
              ref: { kind: 'builtin', path: t.file },
              title: `${t.composer}《${t.title}》`,
              source: src,
              loop: false,
              credit: `${t.method}；${t.license}`,
            })),
          };
        }
      }
    }
    return { ...base, source: null, wantsModel, tracks: [] };
  });
}

/**
 * 手写剧本里 bgm 指令写的 id 放什么：先找本地曲库和内置曲库里文件名一样的曲子，
 * 再按情绪表认（calm_daily 认成日常），都认不出来就用情绪表的第一个。
 */
export function namedTracks(library: readonly LibraryTrack[], builtin: readonly BuiltinTrackDef[]): Record<string, BgmTrack> {
  const out: Record<string, BgmTrack> = {};
  for (const t of builtin) {
    out[stemOf(t.file).toLowerCase()] = { ref: { kind: 'builtin', path: t.file }, title: `${t.composer}《${t.title}》`, source: 'builtin', loop: false, credit: `${t.method}；${t.license}` };
  }
  for (const t of library) out[t.name.toLowerCase()] = { ref: { kind: 'library', path: t.rel }, title: t.name, source: 'library', loop: false };
  return out;
}
