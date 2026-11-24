import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { IMAGE_EXT, ProviderError, sniffImage } from '@auto-adv/providers';
import {
  type AssetIndex,
  type AssetSettings,
  type AssetSettingsPatch,
  type AssetSlotRecord,
  AssetSettingsPatch as PatchSchema,
  mergeAssetSettings,
} from '@auto-adv/schema';
import type { AssetAction, AssetSlotView, AssetsChunk, AssetsControl, AssetsView } from '../api.ts';
import type { ImageHandle, ModelGateway } from '../llm/gateway.ts';
import type { SettingsStore } from '../settings-store.ts';
import { SerialQueue, writeFileAtomic } from '../util.ts';
import type { WorldData, WorldStore } from '../world/store.ts';
import { type AssetFocus, inputHashOf, type PlannedSlot, planAssets, priorityOf, slotState, wantsWork } from './plan.ts';

export type { AssetFocus } from './plan.ts';

export interface AssetServiceOptions {
  /** 失败重试的基础等待时间（按指数退避），默认 2 秒。测试里调小。 */
  retryBaseMs?: number;
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
}

const MAX_HISTORY = 10;
const UPLOAD_LIMIT = 30 * 1024 * 1024;
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
  private disposed = false;
  private readonly store: WorldStore;
  private readonly settings: SettingsStore;
  private readonly gateway: ModelGateway;

  constructor(store: WorldStore, settings: SettingsStore, gateway: ModelGateway, opts: AssetServiceOptions = {}) {
    this.store = store;
    this.settings = settings;
    this.gateway = gateway;
    this.retryBaseMs = opts.retryBaseMs ?? 2000;
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
        ]);
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
        };
        this.worlds.set(worldId, w);
        return w;
      })().finally(() => this.loading.delete(worldId));
      this.loading.set(worldId, p);
    }
    return p;
  }

  /** 重新读世界和设置、重算素材清单（世界改过、创世写了新的一步、设置改了之后调用），然后接着排队。 */
  async refresh(worldId: string): Promise<AssetsView> {
    const w = await this.load(worldId);
    const [world, patch, s] = await Promise.all([this.store.load(worldId), this.store.readAssetSettings(worldId), this.settings.get()]);
    w.world = world;
    w.patch = patch;
    w.global = s.assets;
    w.settings = mergeAssetSettings(s.assets, patch);
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
    this.emit(w);
  }

  async view(worldId: string): Promise<AssetsView> {
    return this.refresh(worldId);
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
    return w.settings.enabled[slot.toggle];
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
        working: w.running.size > 0 || (!!r && !w.index.paused && pending.length > 0 && w.index.generated < limit),
        cap: { used: w.index.generated, limit, reached: w.index.generated >= limit && pending.length > 0, action: w.settings.capAction },
      },
      settings: { world: w.patch, effective: w.settings, global: w.global },
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
        const route = await this.gateway.imageRoute();
        if (!route) return;
        const concurrency = (await this.settings.get()).assets.imageConcurrency;
        for (const w of this.worlds.values()) {
          if (w.index.paused) continue;
          const limit = w.settings.imageCap + w.index.capExtra;
          for (const slot of this.candidates(w)) {
            if ((this.active.get(route.endpointId) ?? 0) >= concurrency) return;
            // 正在画的也算进上限，免得并发时超出
            if (w.index.generated + w.running.size >= limit) break;
            this.start(w, slot, route.endpointId);
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
  private async cached(w: WorldAssets, base: string): Promise<string | null> {
    for (const ext of Object.values(IMAGE_EXT)) {
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
    const input = inputHashOf(slot, w.index);
    const base = this.fileBase(slot, input);
    let rel = await this.cached(w, base);
    let generated: { model: string; revisedPrompt: string | null } | null = null;
    if (!rel) {
      let h: ImageHandle;
      try {
        h = await this.gateway.forImage(`assets.${slot.kind}`);
      } catch {
        return; // 职责在排队期间被清掉了
      }
      const retries = w.settings.retries;
      let lastErr: unknown;
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (signal.aborted) return;
        try {
          const r = await h.client.generate({ model: h.model, prompt: slot.params.prompt, size: slot.params.size }, signal);
          rel = `${base}.${IMAGE_EXT[r.mime] ?? 'png'}`;
          await writeFileAtomic(this.store.assetPath(w.id, rel), r.data);
          generated = { model: h.model, revisedPrompt: r.revisedPrompt };
          break;
        } catch (err) {
          if (signal.aborted || (err instanceof ProviderError && err.aborted)) return;
          lastErr = err;
          const retryable = !(err instanceof ProviderError) || err.retryable || err.status === null;
          if (!retryable || attempt === retries) break;
          await sleep(this.retryBaseMs * 2 ** attempt, signal);
        }
      }
      if (!rel || !generated) {
        const message = lastErr instanceof Error ? lastErr.message : String(lastErr);
        await this.mutate(w, (idx) => {
          const rec = record(idx, slot.id);
          rec.error = message;
          rec.failedInput = input;
          rec.requested = false;
          rec.updatedAt = now();
        });
        return;
      }
    }
    if (signal.aborted) return;
    const file = rel;
    await this.mutate(w, (idx) => {
      const rec = record(idx, slot.id);
      pushHistory(rec);
      rec.file = file;
      rec.builtParams = slot.paramsHash;
      rec.builtInput = input;
      rec.source = 'generated';
      rec.requested = false;
      delete rec.error;
      delete rec.failedInput;
      if (generated) {
        rec.model = generated.model;
        if (generated.revisedPrompt) rec.revisedPrompt = generated.revisedPrompt;
        else delete rec.revisedPrompt;
        idx.generated += 1;
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
    if (!path.isAbsolute(src)) throw new Error('请给出图片的完整路径');
    const stat = await fs.stat(src);
    if (!stat.isFile()) throw new Error('这不是一个文件');
    if (stat.size > UPLOAD_LIMIT) throw new Error('图片太大了（超过 30 MB）');
    const data = await fs.readFile(src);
    const mime = sniffImage(data);
    if (!mime) throw new Error('只支持 PNG、JPEG、WebP 图片');
    const sum = createHash('sha256').update(data).digest('hex').slice(0, 12);
    const rel = `assets/uploads/${slot.dir}-${slot.slug}-${sum}.${IMAGE_EXT[mime]}`;
    await writeFileAtomic(this.store.assetPath(w.id, rel), data);
    w.running.get(slotId)?.abort();
    await this.mutate(w, (idx) => {
      const r = record(idx, slotId);
      pushHistory(r);
      r.file = rel;
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
  const entry = { file: r.file, builtParams: r.builtParams, builtInput: r.builtInput, source: r.source, at: r.updatedAt ?? now() };
  r.history = [entry, ...r.history.filter((h) => h.file !== r.file)].slice(0, MAX_HISTORY);
}
