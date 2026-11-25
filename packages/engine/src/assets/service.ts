import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  AUDIO_EXT,
  decodeJpeg,
  decodePng,
  encodeRgbaPng,
  IMAGE_EXT,
  type ImageResult,
  type MusicResult,
  ProviderError,
  type RgbaImage,
  sniffAudio,
  sniffImage,
} from '@auto-adv/providers';
import {
  type AssetIndex,
  type AssetSettings,
  type AssetSettingsPatch,
  type AssetSlotRecord,
  AssetSettingsPatch as PatchSchema,
  mergeAssetSettings,
} from '@auto-adv/schema';
import { z } from 'zod';
import type { AssetAction, AssetSlotView, AssetsChunk, AssetsControl, AssetsView, BgmView } from '../api.ts';
import type { ImageHandle, ModelGateway, MusicHandle } from '../llm/gateway.ts';
import { generateJson } from '../llm/structured.ts';
import type { SettingsStore } from '../settings-store.ts';
import { SerialQueue, writeFileAtomic } from '../util.ts';
import type { WorldData, WorldStore } from '../world/store.ts';
import {
  type BuiltinTrackDef,
  type LibraryScan,
  LibraryMoodCache,
  loadBuiltin,
  type MoodPlaylist,
  moodTableKey,
  namedTracks,
  resolveBgm,
  scanLibrary,
} from './bgm.ts';
import { checkAlpha, hasTransparentBackdrop, keyOut } from './cutout.ts';
import { type AssetFocus, inputHashOf, type PlannedSlot, planAssets, priorityOf, slotState, wantsWork } from './plan.ts';

export type { AssetFocus } from './plan.ts';

export interface AssetServiceOptions {
  /** 失败重试的基础等待时间（按指数退避），默认 2 秒。测试里调小。 */
  retryBaseMs?: number;
  /** 数据目录：本地曲库按文件名挑情绪的结果记在这里（bgm-library.json）。不给就不记。 */
  dataDir?: string;
  /** 内置曲库的文件夹（里面有 manifest.json）。不给就没有内置曲库。 */
  builtinBgmDir?: string;
}

/** 一个世界在内存里的素材状态。 */
interface WorldAssets {
  id: string;
  world: WorldData;
  index: AssetIndex;
  patch: AssetSettingsPatch;
  settings: AssetSettings;
  global: AssetSettings;
  plan: PlannedSlot[];
  running: Map<string, AbortController>;
  focus: AssetFocus | null;
  listeners: Set<(c: AssetsChunk) => void>;
  /** 写 index.json 串行。 */
  queue: SerialQueue;
  /** 本地曲库扫出来的曲子（选了文件夹才有）。moods：扫的时候的情绪表（情绪表改了要重新认）。 */
  library: (LibraryScan & { moods: string }) | null;
  /** 正在让文本模型按文件名挑情绪。 */
  classifying: boolean;
  /** 每个情绪现在放什么（18.7）。 */
  bgm: MoodPlaylist[];
}

const MAX_HISTORY = 10;
const UPLOAD_LIMIT = 30 * 1024 * 1024;
const AUDIO_UPLOAD_LIMIT = 200 * 1024 * 1024;
/** 一次最多让文本模型挑多少个文件名。 */
const CLASSIFY_BATCH = 200;

const isMusic = (slot: { kind: string }) => slot.kind === 'bgm';

/** 文本模型按文件名挑情绪的回答。 */
const ClassifyOut = z.object({
  files: z
    .array(z.object({ index: z.coerce.number().int(), mood: z.string().default('') }))
    .catch([])
    .default([]),
});
const RAISE_STEP = 20;

const now = () => new Date().toISOString();
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

/**
 * 素材管线（18.2～18.3）：按素材清单排队生成、缓存、推送进度。
 * 队列不单独存：没画过的、上游重画了的、你点了重画的槽就是队列，按"马上要用"排优先级；应用重启后接着做。
 */
export class AssetService {
  private readonly worlds = new Map<string, WorldAssets>();
  private readonly loading = new Map<string, Promise<WorldAssets>>();
  /** 每个图像接入点正在画几张（并发按接入点算，跨世界共用）。 */
  private readonly active = new Map<string, number>();
  private readonly retryBaseMs: number;
  private readonly dataDir: string | undefined;
  private readonly builtinDir: string | undefined;
  /** 内置曲库（所有世界共用，读一次）。 */
  private builtin: BuiltinTrackDef[] = [];
  private builtinLoad: Promise<void> | null = null;
  /** 配了音乐职责没有（排队时更新）。 */
  private musicReady = false;
  private disposed = false;
  private readonly store: WorldStore;
  private readonly settings: SettingsStore;
  private readonly gateway: ModelGateway;
  /** 世界或设置改了（refresh）时通知别的服务（语音的配音表要重算）。 */
  onRefresh: ((worldId: string) => void) | null = null;

  constructor(store: WorldStore, settings: SettingsStore, gateway: ModelGateway, opts: AssetServiceOptions = {}) {
    this.store = store;
    this.settings = settings;
    this.gateway = gateway;
    this.retryBaseMs = opts.retryBaseMs ?? 2000;
    this.dataDir = opts.dataDir;
    this.builtinDir = opts.builtinBgmDir;
  }

  /** 内置曲库的曲目（「关于」页列授权用）。 */
  async builtinTracks(): Promise<BuiltinTrackDef[]> {
    this.builtinLoad ??= loadBuiltin(this.builtinDir).then((t) => {
      this.builtin = t;
    });
    await this.builtinLoad;
    return this.builtin;
  }

  dispose(): void {
    this.disposed = true;
    for (const w of this.worlds.values()) for (const c of w.running.values()) c.abort();
  }

  /** 世界被删掉或者关闭：停掉正在画的，丢掉内存里的状态。 */
  async closeWorld(worldId: string): Promise<void> {
    const w = this.worlds.get(worldId) ?? (await this.loading.get(worldId)?.catch(() => undefined));
    if (!w) return;
    for (const c of w.running.values()) c.abort();
    await w.queue.run(async () => {});
    this.worlds.delete(worldId);
  }

  // ───────────── 读 ─────────────

  private async load(worldId: string): Promise<WorldAssets> {
    const have = this.worlds.get(worldId);
    if (have) return have;
    let p = this.loading.get(worldId);
    if (!p) {
      p = (async () => {
        const [world, index, patch, s] = await Promise.all([
          this.store.load(worldId),
          this.store.readAssetIndex(worldId),
          this.store.readAssetSettings(worldId),
          this.settings.get(),
          this.builtinTracks(),
        ]);
        this.musicReady = !!(await this.gateway.musicRoute());
        const settings = mergeAssetSettings(s.assets, patch);
        const w: WorldAssets = {
          id: worldId,
          world,
          index,
          patch,
          settings,
          global: s.assets,
          plan: planAssets(world, settings, index),
          running: new Map(),
          focus: null,
          listeners: new Set(),
          queue: new SerialQueue(),
          library: null,
          classifying: false,
          bgm: [],
        };
        await this.syncLibrary(w);
        w.bgm = this.playlists(w);
        this.worlds.set(worldId, w);
        return w;
      })().finally(() => this.loading.delete(worldId));
      this.loading.set(worldId, p);
    }
    return p;
  }

  /** 重新读世界和设置、重算素材清单（世界改过、创世写了新的一步、设置改了之后调用），然后接着排队。 */
  async refresh(worldId: string): Promise<AssetsView> {
    this.onRefresh?.(worldId);
    const w = await this.load(worldId);
    const [world, patch, s] = await Promise.all([this.store.load(worldId), this.store.readAssetSettings(worldId), this.settings.get()]);
    w.world = world;
    w.patch = patch;
    w.global = s.assets;
    w.settings = mergeAssetSettings(s.assets, patch);
    this.musicReady = !!(await this.gateway.musicRoute());
    await this.syncLibrary(w);
    this.replan(w);
    void this.pumpAll();
    return this.viewOf(w);
  }

  /** 全局设置改了：所有已经加载的世界重算。 */
  async refreshAll(): Promise<void> {
    await Promise.all([...this.worlds.keys()].map((id) => this.refresh(id).catch(() => undefined)));
  }

  private replan(w: WorldAssets) {
    w.plan = planAssets(w.world, w.settings, w.index);
    w.bgm = this.playlists(w);
    this.emit(w);
  }

  private playlists(w: WorldAssets): MoodPlaylist[] {
    return resolveBgm({
      settings: w.settings.bgm,
      index: w.index,
      library: w.settings.bgm.sources.includes('library') || Object.values(w.settings.bgm.pins).includes('library') ? (w.library?.tracks ?? []) : [],
      builtin: this.builtin,
      modelReady: this.musicReady,
    });
  }

  // ───────────── 本地曲库 ─────────────

  /** 曲库文件夹换了（或者还没扫过）就扫一遍。force：重新扫。 */
  private async syncLibrary(w: WorldAssets, force = false): Promise<void> {
    const dir = w.settings.bgm.libraryDir.trim();
    if (!dir) {
      w.library = null;
      return;
    }
    if (!force && w.library && w.library.dir === path.resolve(dir) && w.library.moods === moodTableKey(w.settings.bgm.moods)) return;
    const scan = await scanLibrary(dir, w.settings.bgm.moods);
    w.library = { ...scan, moods: moodTableKey(w.settings.bgm.moods) };
    await this.applyCachedMoods(w);
    if (w.settings.bgm.classifyLibrary) void this.classify(w);
  }

  private cacheFile() {
    return this.dataDir ? path.join(this.dataDir, 'bgm-library.json') : null;
  }

  private async readMoodCache(): Promise<LibraryMoodCache> {
    const f = this.cacheFile();
    if (!f) return {};
    try {
      return LibraryMoodCache.parse(JSON.parse(await fs.readFile(f, 'utf8')));
    } catch {
      return {};
    }
  }

  private cacheKey(w: WorldAssets) {
    return `${w.library?.dir ?? ''}|${moodTableKey(w.settings.bgm.moods)}`;
  }

  /** 之前让文本模型挑过的文件，直接用记下来的结果。 */
  private async applyCachedMoods(w: WorldAssets): Promise<boolean> {
    const lib = w.library;
    if (!lib || !w.settings.bgm.classifyLibrary) return false;
    const cached = (await this.readMoodCache())[this.cacheKey(w)] ?? {};
    const ids = new Set(w.settings.bgm.moods.map((m) => m.id));
    let changed = false;
    for (const t of lib.tracks) {
      const m = cached[t.rel];
      if (t.mood === null && m && ids.has(m)) {
        t.mood = m;
        t.by = 'model';
        changed = true;
      }
    }
    return changed;
  }

  /**
   * 文件夹名和文件名都对不上情绪的曲子，让文本模型按文件名挑（18.7）。每个文件只问一次，结果记在数据目录里。
   * 没配文本模型就不挑；挑不出来的留着不用。
   */
  private async classify(w: WorldAssets): Promise<void> {
    const lib = w.library;
    if (!lib || w.classifying || !lib.tracks.some((t) => t.mood === null)) return;
    // 挑完之前先不让音乐模型生成（挑出来的情绪可能就不用生成了）
    w.classifying = true;
    try {
      const key = this.cacheKey(w);
      const known = (await this.readMoodCache())[key] ?? {};
      const todo = lib.tracks.filter((t) => t.mood === null && !(t.rel in known)).slice(0, CLASSIFY_BATCH);
      if (!todo.length || !(await this.gateway.configured('archivist'))) return;
      this.emit(w);
      const moods = w.settings.bgm.moods;
      const h = await this.gateway.forRole('archivist', 'assets.library');
      const { value } = await generateJson(this.gateway, h, {
        system: '你在给视觉小说挑背景音乐。下面是一个音乐文件夹里的文件名（包括子文件夹名），请按名字猜每首曲子适合哪种情绪。只按名字判断，猜不出来就留空。',
        user: [
          `# 情绪\n${moods.map((m) => `- ${m.id}（${m.name}）${m.hint ? `：${m.hint}` : ''}`).join('\n')}`,
          `# 文件\n${todo.map((t, i) => `${i}. ${t.rel}`).join('\n')}`,
        ].join('\n\n'),
        spec: {
          name: 'bgm_moods',
          schema: ClassifyOut,
          example: { files: [{ index: 0, mood: '情绪 id；猜不出来就留空' }] },
        },
      });
      const ids = new Set(moods.map((m) => m.id));
      const picked: Record<string, string | null> = {};
      for (const [i, t] of todo.entries()) {
        const m = value.files.find((f) => f.index === i)?.mood.trim() ?? '';
        picked[t.rel] = ids.has(m) ? m : null;
      }
      const latest = await this.readMoodCache();
      latest[key] = { ...latest[key], ...picked };
      const f = this.cacheFile();
      if (f) await writeFileAtomic(f, `${JSON.stringify(latest, null, 2)}\n`);
      if (w.library === lib) {
        for (const t of lib.tracks) {
          const m = picked[t.rel];
          if (t.mood === null && m) {
            t.mood = m;
            t.by = 'model';
          }
        }
      }
    } catch (err) {
      console.error('[assets] 让文本模型给曲库挑情绪失败：', err);
    } finally {
      w.classifying = false;
      this.replan(w);
      void this.pumpAll();
    }
  }

  async view(worldId: string): Promise<AssetsView> {
    return this.refresh(worldId);
  }

  /** 这个世界生效的素材设置（全局 + 世界）。 */
  async effectiveSettings(worldId: string): Promise<AssetSettings> {
    return (await this.load(worldId)).settings;
  }

  /** 游玩时告诉素材管线现在在哪里，按"马上要用"排优先级。 */
  async focus(worldId: string, focus: AssetFocus): Promise<void> {
    const w = await this.load(worldId);
    w.focus = focus;
    void this.pumpAll();
  }

  /** 订阅变化：先推一次当前状态，之后每次变化推一次，signal 中止时结束。 */
  async watch(worldId: string, emit: (c: AssetsChunk) => void, signal: AbortSignal): Promise<void> {
    const w = await this.load(worldId);
    w.listeners.add(emit);
    try {
      emit({ type: 'view', view: await this.refresh(worldId) });
      if (!signal.aborted) await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
    } finally {
      w.listeners.delete(emit);
    }
  }

  private emit(w: WorldAssets) {
    if (!w.listeners.size) return;
    void this.viewOfAsync(w).then((view) => {
      for (const l of w.listeners) {
        try {
          l({ type: 'view', view });
        } catch {
          // 订阅方出错不影响别人
        }
      }
    });
  }

  private async viewOfAsync(w: WorldAssets): Promise<AssetsView> {
    return this.viewOf(w, await this.gateway.imageRoute());
  }

  private enabled(w: WorldAssets, slot: PlannedSlot) {
    if (!w.settings.enabled[slot.toggle]) return false;
    // BGM：按来源顺序轮到了音乐模型（前面的来源没有这个情绪的曲子）才生成；你点了重新生成也生成
    if (isMusic(slot)) {
      // 本地曲库正在按文件名挑情绪：等挑完再定哪些情绪要生成
      if (!this.musicReady || w.classifying) return false;
      return !!w.index.slots[slot.id]?.requested || !!w.bgm.find((b) => b.mood === slot.mood)?.wantsModel;
    }
    // 立绘关掉了：表情差分只有基础立绘已经有了才画
    if (slot.toggle === 'expression' && !w.settings.enabled.sprite) return slot.deps.every((d) => !!w.index.slots[d]?.file);
    return true;
  }

  private async viewOf(w: WorldAssets, route?: Awaited<ReturnType<ModelGateway['imageRoute']>>): Promise<AssetsView> {
    const r = route === undefined ? await this.gateway.imageRoute() : route;
    const slots: AssetSlotView[] = w.plan.map((p) => {
      const rec = w.index.slots[p.id];
      const st = slotState(p, w.index, { running: w.running.has(p.id), enabled: this.enabled(w, p) });
      return {
        id: p.id,
        kind: p.kind,
        toggle: p.toggle,
        title: p.title,
        subtitle: p.subtitle,
        status: st.status,
        staleBy: st.staleBy,
        locked: !!rec?.locked,
        upstreamChanged: st.upstreamChanged,
        requested: !!rec?.requested,
        file: rec?.file ?? null,
        source: rec?.source ?? null,
        prompt: p.params.prompt,
        defaultPrompt: p.defaultPrompt,
        promptEdited: !!rec?.prompt?.trim(),
        size: p.params.size,
        error: rec?.error ?? null,
        review: rec?.review ?? null,
        characterId: p.characterId ?? null,
        expression: p.expression ?? null,
        mood: p.mood ?? null,
        model: rec?.model ?? null,
        revisedPrompt: rec?.revisedPrompt ?? null,
        history: (rec?.history ?? []).map((h) => ({ file: h.file, at: h.at })),
        updatedAt: rec?.updatedAt ?? null,
      };
    });
    const planned = new Set(w.plan.map((p) => p.id));
    const orphans = Object.values(w.index.slots)
      .filter((r) => !planned.has(r.id))
      .map((r) => ({ id: r.id, file: r.file ?? null }));
    const counted = slots.filter((s) => s.status !== 'disabled');
    const limit = w.settings.imageCap + w.index.capExtra;
    const pending = this.candidates(w);
    const images = pending.filter((p) => !isMusic(p));
    const canWork = !w.index.paused && ((!!r && images.length > 0 && w.index.generated < limit) || (this.musicReady && pending.some(isMusic)));
    const lib = w.library;
    const bgm: BgmView = {
      playlists: w.bgm,
      named: namedTracks(lib?.tracks ?? [], this.builtin),
      library: lib ? { dir: lib.dir, tracks: lib.tracks, error: lib.error, truncated: lib.truncated, classifying: w.classifying } : null,
      builtinCount: this.builtin.length,
      needsModel: !this.musicReady,
    };
    return {
      worldId: w.id,
      slots,
      orphans,
      counts: {
        total: counted.length,
        done: counted.filter((s) => s.status === 'done').length,
        running: counted.filter((s) => s.status === 'running').length,
        pending: counted.filter((s) => s.status === 'pending').length,
        stale: counted.filter((s) => s.status === 'stale').length,
        failed: counted.filter((s) => s.status === 'failed').length,
      },
      state: {
        needsModel: !r,
        paused: w.index.paused,
        working: w.running.size > 0 || canWork,
        cap: { used: w.index.generated, limit, reached: w.index.generated >= limit && images.length > 0, action: w.settings.capAction },
      },
      settings: { world: w.patch, effective: w.settings, global: w.global },
      bgm,
    };
  }

  // ───────────── 队列 ─────────────

  /** 现在该画的槽，按优先级排好。 */
  private candidates(w: WorldAssets): PlannedSlot[] {
    return w.plan
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => wantsWork(p, w.index, { running: w.running.has(p.id), enabled: this.enabled(w, p) }))
      .sort((a, b) => priorityOf(a.p, w.world, w.focus) - priorityOf(b.p, w.world, w.focus) || a.i - b.i)
      .map(({ p }) => p);
  }

  private pumping = false;
  private pumpAgain = false;

  /** 给所有加载了的世界排队，直到接入点的并发占满。 */
  private async pumpAll(): Promise<void> {
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        if (this.disposed) return;
        const [image, music, s] = await Promise.all([this.gateway.imageRoute(), this.gateway.musicRoute(), this.settings.get()]);
        if (this.musicReady !== !!music) {
          // 音乐职责刚配上（或者清掉了）：哪些情绪要音乐模型生成跟着变
          this.musicReady = !!music;
          for (const w of this.worlds.values()) this.replan(w);
        }
        for (const w of this.worlds.values()) {
          if (w.index.paused) continue;
          const limit = w.settings.imageCap + w.index.capExtra;
          for (const slot of this.candidates(w)) {
            const route = isMusic(slot) ? music : image;
            if (!route) continue;
            // 图像和音乐分开排队，并发按接入点算
            const key = `${isMusic(slot) ? 'music' : 'image'}:${route.endpointId}`;
            const concurrency = isMusic(slot) ? s.assets.musicConcurrency : s.assets.imageConcurrency;
            if ((this.active.get(key) ?? 0) >= concurrency) continue;
            // 正在画的也算进上限，免得并发时超出（音乐不算张数）
            const drawing = [...w.running.keys()].filter((id) => !id.startsWith('bgm/')).length;
            if (!isMusic(slot) && w.index.generated + drawing >= limit) continue;
            this.start(w, slot, key);
          }
        }
      } while (this.pumpAgain);
    } finally {
      this.pumping = false;
    }
  }

  private start(w: WorldAssets, slot: PlannedSlot, endpointId: string) {
    const ctrl = new AbortController();
    w.running.set(slot.id, ctrl);
    this.active.set(endpointId, (this.active.get(endpointId) ?? 0) + 1);
    this.emit(w);
    void this.produce(w, slot, ctrl.signal)
      .catch((err) => console.error(`[assets] ${w.id} ${slot.id}：`, err))
      .finally(() => {
        w.running.delete(slot.id);
        this.active.set(endpointId, Math.max(0, (this.active.get(endpointId) ?? 1) - 1));
        this.emit(w);
        void this.pumpAll();
      });
  }

  private fileBase(slot: PlannedSlot, input: string) {
    return `assets/${slot.dir}/${slot.slug}-${input.slice(0, 12)}`;
  }

  /** 同样的输入已经画过（比如重画之后又改回原来的参数）：直接用原来的文件，不花钱（18.3）。 */
  private async cached(w: WorldAssets, base: string, exts: readonly string[] = Object.values(IMAGE_EXT)): Promise<string | null> {
    for (const ext of exts) {
      const rel = `${base}.${ext}`;
      try {
        await fs.access(this.store.assetPath(w.id, rel));
        return rel;
      } catch {
        // 没有
      }
    }
    return null;
  }

  private async produce(w: WorldAssets, slot: PlannedSlot, signal: AbortSignal): Promise<void> {
    if (isMusic(slot)) return this.produceMusic(w, slot, signal);
    const input = inputHashOf(slot, w.index);
    const base = this.fileBase(slot, input);
    const hit = await this.cached(w, base);
    if (hit) {
      if (signal.aborted) return;
      await this.commit(w, slot, input, { file: hit, rawFile: (await this.cached(w, `${base}.raw`)) ?? undefined });
      return;
    }
    const mode = slot.params.transparency;
    if (mode === 'service' && !(await this.gateway.cutoutRoute())) {
      await this.fail(w, slot, input, '透明背景选了「抠图服务」，但还没有配「抠图」职责，请到 设置 → 职责路由 配置');
      return;
    }
    let h: ImageHandle;
    try {
      h = await this.gateway.forImage(`assets.${slot.toggle}`);
    } catch {
      return; // 职责在排队期间被清掉了
    }
    // 表情差分：拿基础立绘抠图之前的原图当参考图
    let reference: { data: Uint8Array; mime: string } | undefined;
    if (slot.params.mode === 'edit') {
      const dep = w.index.slots[slot.deps[0] ?? ''];
      const ref = dep?.rawFile ?? dep?.file;
      if (!ref) return;
      const data = new Uint8Array(await fs.readFile(this.store.assetPath(w.id, ref)));
      reference = { data, mime: sniffImage(data) ?? 'image/png' };
    }

    let r = await this.call(w, h, slot, reference, signal);
    if (!r) return;
    if ('error' in r) {
      await this.fail(w, slot, input, r.error);
      return;
    }
    let count = 1;
    const meta = () => ({ model: h.model, revisedPrompt: (r as ImageResult).revisedPrompt, count });
    if (slot.kind !== 'sprite' || !mode || mode === 'none') {
      const rel = `${base}.${IMAGE_EXT[r.mime] ?? 'png'}`;
      await writeFileAtomic(this.store.assetPath(w.id, rel), r.data);
      if (!signal.aborted) await this.commit(w, slot, input, { file: rel, generated: meta() });
      return;
    }

    // 立绘：抠图 → 检查透明度，不合格换一张再试一次，还不合格先用没抠的原图，标成"需要看一下"（18.5）
    let cut = await this.cutout(slot, r, signal);
    if (cut.reason && cut.retry && !signal.aborted) {
      const again = await this.call(w, h, slot, reference, signal);
      if (!again) return;
      if (!('error' in again)) {
        count += 1;
        r = again;
        cut = await this.cutout(slot, r, signal);
      }
    }
    if (signal.aborted) return;
    if (cut.image && !cut.reason && cut.native) {
      // 服务直接给了透明图：原图就是成品
      const rel = `${base}.png`;
      await writeFileAtomic(this.store.assetPath(w.id, rel), r.data);
      if (!signal.aborted) await this.commit(w, slot, input, { file: rel, generated: meta() });
      return;
    }
    const raw = `${base}.raw.${IMAGE_EXT[r.mime] ?? 'png'}`;
    await writeFileAtomic(this.store.assetPath(w.id, raw), r.data);
    if (cut.image && !cut.reason) {
      const rel = `${base}.png`;
      await writeFileAtomic(this.store.assetPath(w.id, rel), encodeRgbaPng(cut.image));
      if (!signal.aborted) await this.commit(w, slot, input, { file: rel, rawFile: raw, generated: meta() });
    } else if (!signal.aborted) {
      await this.commit(w, slot, input, { file: raw, rawFile: raw, review: cut.reason ?? '抠图失败', generated: meta() });
    }
  }

  /** BGM：用音乐模型生成这个情绪的一首纯音乐（18.7）。 */
  private async produceMusic(w: WorldAssets, slot: PlannedSlot, signal: AbortSignal): Promise<void> {
    const input = inputHashOf(slot, w.index);
    const base = this.fileBase(slot, input);
    const hit = await this.cached(w, base, Object.values(AUDIO_EXT));
    if (hit) {
      if (!signal.aborted) await this.commit(w, slot, input, { file: hit });
      return;
    }
    let h: MusicHandle;
    try {
      h = await this.gateway.forMusic('assets.bgm');
    } catch {
      return; // 职责在排队期间被清掉了
    }
    const r = await this.withRetries(w, signal, (sig) =>
      h.client.generate({ model: h.model, prompt: slot.params.prompt, instrumental: true }, sig),
    );
    if (!r) return;
    if ('error' in r) {
      await this.fail(w, slot, input, r.error);
      return;
    }
    const rel = `${base}.${AUDIO_EXT[r.mime] ?? 'mp3'}`;
    await writeFileAtomic(this.store.assetPath(w.id, rel), r.data);
    if (!signal.aborted) await this.commit(w, slot, input, { file: rel, generated: { model: h.model, revisedPrompt: null, count: 1 } });
  }

  /** 调一次图像接口（失败按设置退避重试）。返回 null 表示中止了。 */
  private async call(
    w: WorldAssets,
    h: ImageHandle,
    slot: PlannedSlot,
    reference: { data: Uint8Array; mime: string } | undefined,
    signal: AbortSignal,
  ): Promise<ImageResult | { error: string } | null> {
    const transparent = slot.params.transparency === 'auto' || slot.params.transparency === 'native';
    const req = { model: h.model, prompt: slot.params.prompt, size: slot.params.size, transparent };
    return this.withRetries(w, signal, (sig) => (reference ? h.client.edit({ ...req, image: reference }, sig) : h.client.generate(req, sig)));
  }

  /** 失败按设置退避重试。返回 null 表示中止了。 */
  private async withRetries<T extends ImageResult | MusicResult>(
    w: WorldAssets,
    signal: AbortSignal,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | { error: string } | null> {
    const retries = w.settings.retries;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (signal.aborted) return null;
      try {
        return await run(signal);
      } catch (err) {
        if (signal.aborted || (err instanceof ProviderError && err.aborted)) return null;
        lastErr = err;
        const retryable = !(err instanceof ProviderError) || err.retryable || err.status === null;
        if (!retryable || attempt === retries) break;
        await sleep(this.retryBaseMs * 2 ** attempt, signal);
      }
    }
    return { error: lastErr instanceof Error ? lastErr.message : String(lastErr) };
  }

  /**
   * 立绘抠图（18.5）。image：抠好的图；reason：没通过检查的原因；retry：换一张图值不值得再试
   * （格式不对、抠图服务连不上这类问题换一张也没用）；native：服务直接给了透明图。
   */
  private async cutout(
    slot: PlannedSlot,
    r: ImageResult,
    signal: AbortSignal,
  ): Promise<{ image: RgbaImage | null; reason: string | null; retry: boolean; native: boolean }> {
    const mode = slot.params.transparency;
    const bad = (reason: string, retry = false) => ({ image: null, reason, retry, native: false });
    if (mode === 'service') {
      let out: ImageResult;
      try {
        const c = await this.gateway.forCutout('assets.cutout');
        out = await c.client.remove({ data: r.data, mime: r.mime }, c.model, signal);
      } catch (err) {
        return bad(`抠图服务出错：${err instanceof Error ? err.message : String(err)}`);
      }
      if (out.mime !== 'image/png') return bad('抠图服务返回的不是 PNG');
      const img = decodePng(out.data);
      const check = checkAlpha(img, { holes: true });
      return { image: img, reason: check.reason, retry: true, native: false };
    }
    // H3 这类服务返回的是 JPEG（不带透明），也能内置抠图
    const decode = r.mime === 'image/png' ? decodePng : r.mime === 'image/jpeg' ? decodeJpeg : null;
    if (!decode) return bad(`图像服务返回的是 ${IMAGE_EXT[r.mime] ?? r.mime}，内置抠图只能处理 PNG 和 JPEG`);
    let img: RgbaImage;
    try {
      img = decode(r.data);
    } catch (err) {
      return bad(`读不了这张图：${err instanceof Error ? err.message : String(err)}`);
    }
    if ((mode === 'auto' || mode === 'native') && hasTransparentBackdrop(img)) {
      const check = checkAlpha(img, { holes: true });
      return { image: img, reason: check.reason, retry: true, native: true };
    }
    const keyed = keyOut(img);
    const check = checkAlpha(keyed);
    return { image: keyed, reason: check.reason, retry: true, native: false };
  }

  private async fail(w: WorldAssets, slot: PlannedSlot, input: string, message: string): Promise<void> {
    await this.mutate(w, (idx) => {
      const rec = record(idx, slot.id);
      rec.error = message;
      rec.failedInput = input;
      rec.requested = false;
      rec.updatedAt = now();
    });
  }

  /** 画好了（或者用了缓存）：登记文件。 */
  private async commit(
    w: WorldAssets,
    slot: PlannedSlot,
    input: string,
    o: { file: string; rawFile?: string; review?: string; generated?: { model: string; revisedPrompt: string | null; count: number } },
  ): Promise<void> {
    await this.mutate(w, (idx) => {
      const rec = record(idx, slot.id);
      pushHistory(rec);
      rec.file = o.file;
      if (o.rawFile) rec.rawFile = o.rawFile;
      else delete rec.rawFile;
      if (o.review) rec.review = o.review;
      else delete rec.review;
      rec.builtParams = slot.paramsHash;
      rec.builtInput = input;
      rec.source = 'generated';
      rec.requested = false;
      delete rec.error;
      delete rec.failedInput;
      if (o.generated) {
        rec.model = o.generated.model;
        if (o.generated.revisedPrompt) rec.revisedPrompt = o.generated.revisedPrompt;
        else delete rec.revisedPrompt;
        if (isMusic(slot)) idx.music += o.generated.count;
        else idx.generated += o.generated.count;
      }
      rec.updatedAt = now();
    });
  }

  /** 改 index 并保存（串行），然后重算清单（提示词、重抽次数会影响参数）并推送。 */
  private async mutate(w: WorldAssets, fn: (idx: AssetIndex) => void): Promise<void> {
    await w.queue.run(async () => {
      const next = structuredClone(w.index);
      fn(next);
      await this.store.writeAssetIndex(w.id, next);
      w.index = next;
    });
    this.replan(w);
  }

  // ───────────── 操作 ─────────────

  private slot(w: WorldAssets, slotId: string): PlannedSlot {
    const s = w.plan.find((p) => p.id === slotId);
    if (!s) throw new Error('这个素材槽不存在，可能世界已经改过');
    return s;
  }

  async act(worldId: string, slotId: string, action: AssetAction, file?: string): Promise<AssetsView> {
    const w = await this.load(worldId);
    const slot = this.slot(w, slotId);
    const rec = w.index.slots[slotId];
    if ((action === 'regenerate' || action === 'redraw' || action === 'retry') && rec?.locked) {
      throw new Error('这个素材锁定了，先解锁再重画');
    }
    if (action === 'use' && !rec?.history.some((h) => h.file === file)) throw new Error('找不到这张图');
    // 重画时停掉正在画的那张
    if (action === 'regenerate' || action === 'redraw' || action === 'use') w.running.get(slotId)?.abort();
    await this.mutate(w, (idx) => {
      const r = record(idx, slot.id);
      if (action === 'regenerate') {
        r.variant += 1;
        r.requested = true;
      } else if (action === 'redraw' || action === 'retry') {
        r.requested = true;
        delete r.error;
        delete r.failedInput;
      } else if (action === 'lock') {
        if (!r.file) throw new Error('还没有图，不能锁定');
        r.locked = true;
        r.requested = false;
      } else if (action === 'unlock') {
        r.locked = false;
      } else if (action === 'use') {
        const h = r.history.find((x) => x.file === file);
        if (!h) return;
        r.history = r.history.filter((x) => x !== h);
        pushHistory(r);
        r.file = h.file;
        if (h.rawFile) r.rawFile = h.rawFile;
        else delete r.rawFile;
        delete r.review;
        r.builtParams = h.builtParams;
        r.builtInput = h.builtInput;
        r.source = h.source;
        // 你选的图：锁定，免得因为参数对不上又被画掉
        r.locked = true;
        r.requested = false;
      }
      r.updatedAt = now();
    });
    void this.pumpAll();
    return this.viewOf(w);
  }

  async setPrompt(worldId: string, slotId: string, prompt: string | null, redraw = false): Promise<AssetsView> {
    const w = await this.load(worldId);
    this.slot(w, slotId);
    if (redraw && w.index.slots[slotId]?.locked) throw new Error('这个素材锁定了，先解锁再重画');
    await this.mutate(w, (idx) => {
      const r = record(idx, slotId);
      if (prompt?.trim()) r.prompt = prompt.trim();
      else delete r.prompt;
      if (redraw) {
        r.requested = true;
        delete r.error;
        delete r.failedInput;
      }
      r.updatedAt = now();
    });
    void this.pumpAll();
    return this.viewOf(w);
  }

  /** 换成自己的图：复制进 assets/uploads/，锁定。 */
  async upload(worldId: string, slotId: string, src: string): Promise<AssetsView> {
    const w = await this.load(worldId);
    const slot = this.slot(w, slotId);
    const music = isMusic(slot);
    if (!path.isAbsolute(src)) throw new Error(`请给出${music ? '音频文件' : '图片'}的完整路径`);
    const stat = await fs.stat(src);
    if (!stat.isFile()) throw new Error('这不是一个文件');
    if (!music && stat.size > UPLOAD_LIMIT) throw new Error('图片太大了（超过 30 MB）');
    if (music && stat.size > AUDIO_UPLOAD_LIMIT) throw new Error('音频文件太大了（超过 200 MB）');
    const data = await fs.readFile(src);
    const mime = music ? sniffAudio(data) : sniffImage(data);
    if (!mime) throw new Error(music ? '只支持 MP3、Ogg、WAV、FLAC、M4A 音频' : '只支持 PNG、JPEG、WebP 图片');
    const sum = createHash('sha256').update(data).digest('hex').slice(0, 12);
    const ext = music ? (/\.opus$/i.test(src) ? 'opus' : AUDIO_EXT[mime]) : IMAGE_EXT[mime];
    const rel = `assets/uploads/${slot.dir}-${slot.slug}-${sum}.${ext}`;
    await writeFileAtomic(this.store.assetPath(w.id, rel), data);
    w.running.get(slotId)?.abort();
    await this.mutate(w, (idx) => {
      const r = record(idx, slotId);
      pushHistory(r);
      r.file = rel;
      delete r.rawFile;
      delete r.review;
      r.builtParams = slot.paramsHash;
      r.builtInput = inputHashOf(slot, idx);
      r.source = 'uploaded';
      r.locked = true;
      r.requested = false;
      delete r.error;
      delete r.failedInput;
      delete r.revisedPrompt;
      delete r.model;
      r.updatedAt = now();
    });
    return this.viewOf(w);
  }

  async control(worldId: string, action: AssetsControl): Promise<AssetsView> {
    const w = await this.load(worldId);
    if (action === 'rescanLibrary') {
      await this.syncLibrary(w, true);
      this.replan(w);
      void this.pumpAll();
      return this.viewOf(w);
    }
    if (action === 'cleanOrphans') {
      const planned = new Set(w.plan.map((p) => p.id));
      const gone = Object.values(w.index.slots).filter((r) => !planned.has(r.id));
      const keep = new Set(Object.values(w.index.slots).filter((r) => planned.has(r.id)).flatMap((r) => [r.file, ...r.history.map((h) => h.file)]));
      for (const r of gone) {
        for (const f of [r.file, ...r.history.map((h) => h.file)]) {
          if (f && !keep.has(f)) await fs.rm(this.store.assetPath(w.id, f), { force: true });
        }
      }
      await this.mutate(w, (idx) => {
        for (const r of gone) delete idx.slots[r.id];
      });
      return this.viewOf(w);
    }
    await this.mutate(w, (idx) => {
      if (action === 'pause') idx.paused = true;
      if (action === 'resume') idx.paused = false;
      if (action === 'raiseCap') idx.capExtra = Math.max(idx.capExtra, idx.generated - w.settings.imageCap) + RAISE_STEP;
      if (action === 'redrawStale') {
        for (const p of w.plan) {
          const st = slotState(p, idx, { running: w.running.has(p.id), enabled: this.enabled(w, p) });
          if (st.status === 'stale' && !idx.slots[p.id]?.locked) record(idx, p.id).requested = true;
        }
      }
    });
    if (action === 'pause') for (const c of w.running.values()) c.abort();
    void this.pumpAll();
    return this.viewOf(w);
  }

  async saveWorldSettings(worldId: string, patch: AssetSettingsPatch): Promise<AssetsView> {
    await this.load(worldId);
    await this.store.writeAssetSettings(worldId, PatchSchema.parse(patch));
    return this.refresh(worldId);
  }
}

function record(idx: AssetIndex, id: string): AssetSlotRecord {
  let r = idx.slots[id];
  if (!r) {
    r = { id, locked: false, variant: 0, requested: false, history: [] };
    idx.slots[id] = r;
  }
  return r;
}

/** 换图之前把现在的文件记进历史，素材页里可以换回去。 */
function pushHistory(r: AssetSlotRecord) {
  if (!r.file) return;
  const entry = {
    file: r.file,
    ...(r.rawFile ? { rawFile: r.rawFile } : {}),
    builtParams: r.builtParams,
    builtInput: r.builtInput,
    source: r.source,
    at: r.updatedAt ?? now(),
  };
  r.history = [entry, ...r.history.filter((h) => h.file !== r.file)].slice(0, MAX_HISTORY);
}
