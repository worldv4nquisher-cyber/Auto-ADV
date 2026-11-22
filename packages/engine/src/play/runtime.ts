import path from 'node:path';
import { ObserverSettings } from '@auto-adv/schema';
import type {
  ObserverChunk,
  ObserverStatus,
  PathEvent,
  PlayChunk,
  PlayEvent,
  PlaythroughInfo,
  PlayRef,
  PlayUsage,
  PlayView,
  SceneState,
  Segment,
  SendParams,
  StartPlaythroughParams,
} from '../api.ts';
import type { Meter, ModelGateway } from '../llm/gateway.ts';
import { generateJson, stripThinking } from '../llm/structured.ts';
import { shortId } from '../util.ts';
import { matchByName } from '../world/render.ts';
import type { WorldData, WorldStore } from '../world/store.ts';
import { buildMessages, eventText, protagonistOf, sceneAt, summaryPrompt } from './context.ts';
import { PlayDb, type PlaythroughRow } from './db.ts';
import { runBeat } from './observer/beat.ts';
import { memoryPrompt, memorySpec } from './observer/prompts.ts';
import { ObserverService } from './observer/runner.ts';
import { parseScript, ScriptStream, type ScriptOptions } from './script.ts';
import { foldState, plotProgress } from './state.ts';

type Emit = (chunk: PlayChunk) => void;
type ObserverEmit = (chunk: ObserverChunk) => void;

/** 摘要之后的原始事件超过这么多条（或这么多字）时，整理一次前情提要。 */
export const MEMORY = {
  triggerEvents: 24,
  triggerChars: 16000,
  /** 整理后保留最近这么多条原文不压缩。 */
  keepEvents: 10,
};

function preview(e: PlayEvent | undefined, max = 40): string {
  if (!e) return '';
  const t =
    e.kind === 'player'
      ? (e.text ?? '')
      : e.kind === 'scene'
        ? '（换场景）'
        : e.kind === 'directive'
          ? `（导演指令）${e.text ?? ''}`
          : e.kind === 'whisper'
            ? `（悄悄话）${e.text ?? ''}`
            : (e.segments ?? []).map((s) => (s.kind === 'line' ? `${s.name}：${s.text}` : s.text)).join(' ');
  const chars = [...t.replace(/\s+/g, ' ').trim()];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}

function openingSegments(world: WorldData): Segment[] {
  const o = world.opening;
  if (!o) return [];
  const segs: Segment[] = o.narration
    .split(/\n+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((text) => ({ kind: 'narration', text }));
  for (const l of o.lines) {
    const c = world.characters.find((x) => x.id === l.characterId);
    segs.push({ kind: 'line', characterId: c?.id ?? null, name: c?.name ?? '？', text: l.text });
  }
  return segs;
}

export const emptyUsage = (): PlayUsage => ({ calls: 0, inputTokens: 0, outputTokens: 0, costs: {} });
const usageOf = (pt: PlaythroughRow): PlayUsage => pt.data.usage ?? emptyUsage();
const settingsOf = (pt: PlaythroughRow): ObserverSettings => ObserverSettings.parse(pt.data.observer ?? {});
export const totalCost = (u: PlayUsage) => Object.values(u.costs).reduce((a, b) => a + b, 0);

/** 玩家当前控制的角色：自由对话默认是主角；观察模式只有接管时才有。 */
function controlledOf(pt: PlaythroughRow): string | null {
  if (pt.data.controlledId !== undefined) return pt.data.controlledId;
  return pt.mode === 'observer' ? null : pt.protagonistId;
}

/** 观察模式的进度推送转成自由对话的进度（重抽观察模式的一拍时用）。 */
function toPlayChunk(c: ObserverChunk): PlayChunk | null {
  if (c.type === 'seg') return c;
  if (c.type !== 'phase') return null;
  if (c.phase === 'memory') return { type: 'phase', phase: 'memory' };
  return { type: 'phase', phase: c.phase === 'arc' || c.phase === 'director' ? 'thinking' : 'writing' };
}

/**
 * 游玩运行时。
 * 自由对话：玩家说一句，模型回一段（合并模式）。
 * 观察模式：后台循环一拍一拍地生成（导演 → 引擎校验 → 演出），观众可以随时下指令、说悄悄话、接管角色。
 */
export class PlayService {
  private readonly store: WorldStore;
  private readonly gateway: ModelGateway;
  private readonly dbs = new Map<string, PlayDb>();
  private readonly busy = new Set<string>();
  private readonly memoryJobs = new Map<string, Promise<void>>();
  private disposed = false;
  readonly observer: ObserverService;

  constructor(store: WorldStore, gateway: ModelGateway) {
    this.store = store;
    this.gateway = gateway;
    this.observer = new ObserverService(
      {
        runBeat: (ref, signal, emit) => this.autoBeat(ref, signal, emit),
        settings: (ref) => settingsOf(this.pt(ref)),
        usage: (ref) => usageOf(this.pt(ref)),
        cursor: (ref) => this.cursor(ref),
      },
      (ref) => this.status(ref),
    );
  }

  private db(worldId: string): PlayDb {
    if (this.disposed) throw new Error('引擎已关闭');
    let db = this.dbs.get(worldId);
    if (!db) {
      db = new PlayDb(path.join(this.store.dir(worldId), 'playthroughs', 'play.db'));
      this.dbs.set(worldId, db);
    }
    return db;
  }

  private pt(ref: PlayRef): PlaythroughRow {
    return this.db(ref.worldId).getPlaythrough(ref.playthroughId);
  }

  /** 关闭某个世界的数据库（删除世界前必须先关，Windows 上文件被占用删不掉）。 */
  async closeWorld(worldId: string): Promise<void> {
    await this.observer.haltWorld(worldId);
    await Promise.all(
      [...this.memoryJobs.entries()].filter(([k]) => k.startsWith(`${worldId}/`)).map(([, p]) => p.catch(() => {})),
    );
    this.dbs.get(worldId)?.close();
    this.dbs.delete(worldId);
  }

  /** 立即关闭所有数据库（引擎退出时）。 */
  dispose(): void {
    this.observer.haltAll();
    this.disposed = true;
    for (const db of this.dbs.values()) db.close();
    this.dbs.clear();
  }

  /** 等待后台的记忆整理完成（测试用）。 */
  async flush(ref: PlayRef): Promise<void> {
    await this.memoryJobs.get(this.key(ref));
  }

  // ───────────── 周目 ─────────────

  list(worldId: string): PlaythroughInfo[] {
    const db = this.db(worldId);
    return db.listPlaythroughs().map((pt) => this.info(worldId, db, pt));
  }

  private info(worldId: string, db: PlayDb, pt: PlaythroughRow): PlaythroughInfo {
    let head: PlayEvent | undefined;
    try {
      head = db.getEvent(pt.id, pt.headId);
    } catch {
      head = undefined;
    }
    const { data: _data, ...row } = pt;
    return {
      ...row,
      worldId,
      preview: preview(head),
      controlledId: controlledOf(pt),
      observer: pt.mode === 'observer' ? settingsOf(pt) : null,
      usage: usageOf(pt),
    };
  }

  async start(p: StartPlaythroughParams): Promise<PlayView> {
    const world = await this.store.load(p.worldId);
    if (world.manifest.status !== 'ready' || !world.opening) throw new Error('这个世界还没有生成完，不能开始游玩');
    const mode = p.mode ?? 'chat';
    if (mode === 'adv') throw new Error('结构化 ADV 模式还没有开放');
    const protagonist = protagonistOf(world, null);
    let present = world.opening.presentCharacterIds;
    // 观察模式没有玩家，主角也是由 AI 扮演的在场角色
    if (mode === 'observer' && protagonist && !present.includes(protagonist.id)) present = [protagonist.id, ...present];
    const db = this.db(p.worldId);
    const now = Date.now();
    const root: PlayEvent = {
      id: shortId('ev'),
      parentId: null,
      kind: 'opening',
      createdAt: now,
      segments: openingSegments(world),
      scene: {
        locationId: world.opening.locationId ?? world.locations[0]?.id ?? null,
        presentCharacterIds: present,
      },
    };
    const pt: PlaythroughRow = {
      id: shortId('pt'),
      title: p.title?.trim() || `周目 ${db.listPlaythroughs().length + 1}`,
      mode,
      protagonistId: protagonist?.id ?? null,
      headId: root.id,
      createdAt: now,
      updatedAt: now,
      data: mode === 'observer' ? { observer: ObserverSettings.parse(p.observer ?? {}), readId: root.id } : {},
    };
    db.createPlaythrough(pt, root);
    return this.view({ worldId: p.worldId, playthroughId: pt.id });
  }

  async delete(ref: PlayRef): Promise<void> {
    await this.observer.drop(ref);
    this.guard(ref);
    this.db(ref.worldId).deletePlaythrough(ref.playthroughId);
  }

  async view(ref: PlayRef): Promise<PlayView> {
    // 先读世界再读周目：读世界要等 IO，期间后台可能又写进了一拍
    const world = await this.store.load(ref.worldId);
    const db = this.db(ref.worldId);
    const pt = db.getPlaythrough(ref.playthroughId);
    const events = db.path(pt.id, pt.headId);
    const children = db.childrenOf(pt.id, [...new Set(events.map((e) => e.parentId))]);
    const path: PathEvent[] = events.map((e) => {
      const siblingIds = children.get(e.parentId) ?? [e.id];
      return { ...e, siblingIds, siblingIndex: Math.max(0, siblingIds.indexOf(e.id)) };
    });
    const summary = db.latestSummary(
      pt.id,
      events.map((e) => e.id),
    );
    return {
      playthrough: this.info(ref.worldId, db, pt),
      path,
      scene: sceneAt(events),
      memory: summary ? { text: summary.text, coveredEvents: summary.covered } : null,
      saves: db.listSaves(pt.id),
      plot: plotProgress(foldState(world, events)),
      observer: pt.mode === 'observer' ? this.status(ref) : null,
    };
  }

  private pathEvent(db: PlayDb, pt: string, e: PlayEvent): PathEvent {
    const siblingIds = db.childrenOf(pt, [e.parentId]).get(e.parentId) ?? [e.id];
    return { ...e, siblingIds, siblingIndex: Math.max(0, siblingIds.indexOf(e.id)) };
  }

  // ───────────── 生成 ─────────────

  private key(ref: PlayRef): string {
    return `${ref.worldId}/${ref.playthroughId}`;
  }

  /** 同一个周目同时只能有一个生成任务；开始前等后台的记忆整理做完。 */
  private async exclusive<T>(ref: PlayRef, fn: () => Promise<T>, onWait?: () => void): Promise<T> {
    const key = this.key(ref);
    if (this.busy.has(key)) throw new Error('上一条回复还在生成中');
    this.busy.add(key);
    try {
      const job = this.memoryJobs.get(key);
      if (job) {
        onWait?.();
        await job;
      }
      return await fn();
    } finally {
      this.busy.delete(key);
    }
  }

  /** 每次模型调用后累计这个周目的用量（预算按它算）。 */
  private meter(ref: PlayRef): Meter {
    return (usage, cost, currency) => {
      try {
        this.db(ref.worldId).updateData(ref.playthroughId, (d) => {
          const u = d.usage ?? emptyUsage();
          const costs = { ...u.costs };
          if (cost !== null) costs[currency] = (costs[currency] ?? 0) + cost;
          return {
            ...d,
            usage: {
              calls: u.calls + 1,
              inputTokens: u.inputTokens + usage.inputTokens,
              outputTokens: u.outputTokens + usage.outputTokens,
              costs,
            },
          };
        });
      } catch (err) {
        console.error('[engine] 记录用量失败：', err);
      }
    };
  }

  /** 玩家发言（或空输入"继续"），然后生成回复。观察模式下需要先接管一个角色。 */
  send(p: SendParams, emit: Emit, signal: AbortSignal): Promise<PlayView> {
    return this.exclusive(
      p,
      async () => {
        const db = this.db(p.worldId);
        const pt = db.getPlaythrough(p.playthroughId);
        const controlled = controlledOf(pt);
        if (pt.mode === 'observer' && !controlled) throw new Error('观察模式下请先接管一个角色，或者给导演下指令');
        let parentId = p.parentId ?? pt.headId;
        db.getEvent(pt.id, parentId);
        const text = p.text.trim();
        if (text) {
          const ev: PlayEvent = { id: shortId('ev'), parentId, kind: 'player', createdAt: Date.now(), text };
          if (controlled) ev.characterId = controlled;
          db.insertEvent(pt.id, ev);
          db.setHead(pt.id, ev.id);
          emit({ type: 'player', event: { ...ev, siblingIds: [ev.id], siblingIndex: 0 } });
          parentId = ev.id;
        }
        const reply = await this.reply(p, parentId, emit, signal);
        // 接管期间自己演的部分，观众当然都看过了
        if (pt.mode === 'observer') db.updateData(pt.id, (d) => ({ ...d, readId: reply.id }));
        return this.view(p);
      },
      () => emit({ type: 'phase', phase: 'memory' }),
    );
  }

  /** 重抽一条回复：在同一个父节点下生成新的分支。观察模式的一拍会重新走一遍导演和演出。 */
  async regenerate(ref: PlayRef, eventId: string, emit: Emit, signal: AbortSignal): Promise<PlayView> {
    const db = this.db(ref.worldId);
    const ev = db.getEvent(ref.playthroughId, eventId);
    if (ev.kind !== 'ai' || !ev.parentId) throw new Error('只能重抽角色的回复');
    const parentId = ev.parentId;
    if (!ev.beat) {
      return this.exclusive(
        ref,
        async () => {
          await this.reply(ref, parentId, emit, signal);
          return this.view(ref);
        },
        () => emit({ type: 'phase', phase: 'memory' }),
      );
    }
    await this.observer.halt(ref);
    return this.exclusive(
      ref,
      async () => {
        await this.generateBeat(ref, parentId, signal, (c) => {
          this.observer.emit(ref, c);
          const pc = toPlayChunk(c);
          if (pc) emit(pc);
        });
        return this.view(ref);
      },
      () => emit({ type: 'phase', phase: 'memory' }),
    );
  }

  private async reply(ref: PlayRef, parentId: string, emit: Emit, signal: AbortSignal): Promise<PlayEvent> {
    const db = this.db(ref.worldId);
    const pt = db.getPlaythrough(ref.playthroughId);
    const world = await this.store.load(ref.worldId);
    const protagonist = protagonistOf(world, controlledOf(pt) ?? pt.protagonistId);
    const events = db.path(pt.id, parentId);
    const scene = sceneAt(events);
    const summary = db.latestSummary(
      pt.id,
      events.map((e) => e.id),
    );
    const from = summary ? events.findIndex((e) => e.id === summary.eventId) + 1 : 0;
    const messages = buildMessages({
      world,
      protagonist,
      scene,
      memory: summary?.text ?? null,
      history: events.slice(from),
    });

    const opts: ScriptOptions = {
      cast: world.characters.filter((c) => c.id !== protagonist?.id),
      protagonist,
    };
    const stream = new ScriptStream(opts);
    const h = await this.gateway.forRole('actor', 'play.reply', this.meter(ref));
    emit({ type: 'phase', phase: 'thinking' });
    let writing = false;
    const result = await this.gateway.run(
      h,
      { messages },
      {
        signal,
        onText: (delta) => {
          if (!writing) {
            writing = true;
            emit({ type: 'phase', phase: 'writing' });
          }
          for (const c of stream.push(delta)) emit({ type: 'seg', ...c });
        },
      },
    );
    let segments = stream.finish();
    if (!segments.length) segments = parseScript(stripThinking(result.text), opts);
    if (!segments.length) throw new Error('模型没有返回内容，请重试');

    // 有不在场的角色开口了：视为登场
    const joined = segments.flatMap((s) =>
      s.kind === 'line' && s.characterId && !scene.presentCharacterIds.includes(s.characterId) ? [s.characterId] : [],
    );
    const ev: PlayEvent = {
      id: shortId('ev'),
      parentId,
      kind: 'ai',
      createdAt: Date.now(),
      segments,
      callId: h.lastCallId(),
    };
    if (joined.length) {
      ev.scene = { ...scene, presentCharacterIds: [...new Set([...scene.presentCharacterIds, ...joined])] };
    }
    db.insertEvent(pt.id, ev);
    db.setHead(pt.id, ev.id);
    this.scheduleMemory(ref);
    return ev;
  }

  // ───────────── 观察模式 ─────────────

  /** 在 parentId 后面生成一拍并设为当前位置。调用方负责加锁。 */
  private async generateBeat(ref: PlayRef, parentId: string, signal: AbortSignal, emit: ObserverEmit): Promise<PlayEvent> {
    const db = this.db(ref.worldId);
    const pt = db.getPlaythrough(ref.playthroughId);
    const world = await this.store.load(ref.worldId);
    const events = db.path(pt.id, parentId);
    const summary = db.latestSummary(
      pt.id,
      events.map((e) => e.id),
    );
    emit({ type: 'beat-start', parentId });
    const ev = await runBeat(
      {
        gateway: this.gateway,
        world,
        path: events,
        summary,
        settings: settingsOf(pt),
        protagonist: protagonistOf(world, pt.protagonistId),
        signal,
        meter: this.meter(ref),
        emit,
      },
      parentId,
    );
    signal.throwIfAborted();
    db.insertEvent(pt.id, ev);
    db.setHead(pt.id, ev.id);
    emit({ type: 'event', event: this.pathEvent(db, pt.id, ev) });
    this.scheduleMemory(ref);
    return ev;
  }

  /** 后台循环的一拍：先把排队的指令写进树，再接着当前位置生成。 */
  private autoBeat(ref: PlayRef, signal: AbortSignal, emit: ObserverEmit): Promise<void> {
    return this.exclusive(
      ref,
      async () => {
        const pt = this.pt(ref);
        if (pt.mode !== 'observer') throw new Error('这个周目不是观察模式');
        this.flushPending(ref);
        await this.generateBeat(ref, this.pt(ref).headId, signal, emit);
      },
      () => emit({ type: 'phase', phase: 'memory' }),
    );
  }

  private flushPending(ref: PlayRef): void {
    const db = this.db(ref.worldId);
    const pt = db.getPlaythrough(ref.playthroughId);
    const pending = pt.data.pending ?? [];
    if (!pending.length) return;
    let head = pt.headId;
    for (const p of pending) {
      const ev: PlayEvent = { id: shortId('ev'), parentId: head, kind: p.kind, createdAt: p.createdAt, text: p.text };
      if (p.characterId) ev.characterId = p.characterId;
      db.insertEvent(pt.id, ev);
      head = ev.id;
      this.observer.emit(ref, { type: 'event', event: this.pathEvent(db, pt.id, ev) });
    }
    db.setHead(pt.id, head);
    db.updateData(pt.id, (d) => ({ ...d, pending: [] }));
  }

  /** 观众读到的位置，以及之后还有几拍没看。读到的位置不在当前分支上时（回退、换分支后）算作读到了最新。 */
  private cursor(ref: PlayRef): { readId: string; ahead: number } {
    const db = this.db(ref.worldId);
    const pt = db.getPlaythrough(ref.playthroughId);
    const events = db.path(pt.id, pt.headId);
    let i = events.findIndex((e) => e.id === pt.data.readId);
    if (i < 0) {
      i = events.length - 1;
      db.updateData(pt.id, (d) => ({ ...d, readId: pt.headId }));
    }
    const ahead = events.slice(i + 1).filter((e) => e.kind === 'ai').length;
    return { readId: (events[i] as PlayEvent).id, ahead };
  }

  private status(ref: PlayRef): ObserverStatus {
    const pt = this.pt(ref);
    const st = this.observer.state(ref);
    const { readId, ahead } = this.cursor(ref);
    const u = usageOf(pt);
    return {
      running: st.running,
      activity: st.activity,
      stopReason: st.stopReason,
      lastError: st.lastError,
      failures: st.failures,
      readId,
      ahead,
      queued: pt.data.pending?.length ?? 0,
      budget: { cost: totalCost(u), tokens: u.inputTokens + u.outputTokens, calls: u.calls },
    };
  }

  private observerPt(ref: PlayRef): PlaythroughRow {
    const pt = this.pt(ref);
    if (pt.mode !== 'observer') throw new Error('这个周目不是观察模式');
    return pt;
  }

  /** 播放 / 暂停。播放时如果正接管着角色，先交还给 AI。 */
  async observerControl(ref: PlayRef, action: 'play' | 'pause'): Promise<PlayView> {
    const pt = this.observerPt(ref);
    if (action === 'play') {
      if (pt.data.controlledId) this.db(ref.worldId).updateData(pt.id, (d) => ({ ...d, controlledId: null }));
      this.observer.play(ref);
    } else {
      await this.observer.pause(ref);
    }
    return this.view(ref);
  }

  async observerSettings(ref: PlayRef, settings: Partial<ObserverSettings>): Promise<PlayView> {
    const pt = this.observerPt(ref);
    const next = ObserverSettings.parse({ ...settingsOf(pt), ...settings });
    this.db(ref.worldId).updateData(pt.id, (d) => ({ ...d, observer: next }));
    this.observer.poke(ref);
    return this.view(ref);
  }

  /** 观众读到了 eventId（必须在当前分支上）。 */
  observerRead(ref: PlayRef, eventId: string): ObserverStatus {
    const pt = this.observerPt(ref);
    const db = this.db(ref.worldId);
    if (!db.path(pt.id, pt.headId).some((e) => e.id === eventId)) throw new Error('这条内容不在当前分支上');
    db.updateData(pt.id, (d) => ({ ...d, readId: eventId }));
    this.observer.poke(ref);
    return this.status(ref);
  }

  observerWatch(ref: PlayRef, emit: ObserverEmit, signal: AbortSignal): Promise<void> {
    this.observerPt(ref);
    return this.observer.watch(ref, emit, signal);
  }

  /** 导演指令 / 悄悄话：空闲时直接写进树；正在生成时排队，下一拍开始前写入。 */
  async note(ref: PlayRef, kind: 'directive' | 'whisper', text: string, characterId?: string): Promise<PlayView> {
    const t = text.trim();
    if (!t) throw new Error('内容不能为空');
    this.observerPt(ref);
    if (kind === 'whisper') {
      const world = await this.store.load(ref.worldId);
      if (!world.characters.some((c) => c.id === characterId)) throw new Error('角色不存在');
    }
    const db = this.db(ref.worldId);
    const pt = db.getPlaythrough(ref.playthroughId);
    if (this.busy.has(this.key(ref))) {
      db.updateData(pt.id, (d) => ({
        ...d,
        pending: [...(d.pending ?? []), { kind, text: t, characterId, createdAt: Date.now() }],
      }));
    } else {
      const ev: PlayEvent = { id: shortId('ev'), parentId: pt.headId, kind, createdAt: Date.now(), text: t };
      if (characterId) ev.characterId = characterId;
      db.insertEvent(pt.id, ev);
      db.setHead(pt.id, ev.id);
      this.observer.emit(ref, { type: 'event', event: this.pathEvent(db, pt.id, ev) });
    }
    this.observer.poke(ref);
    return this.view(ref);
  }

  /** 接管一个角色（自动暂停），或交还给 AI（因接管而暂停的会继续播放）。 */
  async takeover(ref: PlayRef, characterId: string | null): Promise<PlayView> {
    this.observerPt(ref);
    if (characterId) {
      const world = await this.store.load(ref.worldId);
      if (!world.characters.some((c) => c.id === characterId)) throw new Error('角色不存在');
      await this.observer.halt(ref, 'takeover');
      // 接管时跳过还没看的部分：玩家要在最新的位置上行动
      this.db(ref.worldId).updateData(ref.playthroughId, (d) => ({ ...d, controlledId: characterId }));
      const pt = this.pt(ref);
      this.db(ref.worldId).updateData(pt.id, (d) => ({ ...d, readId: pt.headId }));
    } else {
      this.db(ref.worldId).updateData(ref.playthroughId, (d) => ({ ...d, controlledId: null }));
      if (this.observer.state(ref).stopReason === 'takeover') this.observer.play(ref);
    }
    this.observer.poke(ref);
    return this.view(ref);
  }

  // ───────────── 记忆 ─────────────

  private scheduleMemory(ref: PlayRef): void {
    const key = this.key(ref);
    if (this.memoryJobs.has(key)) return;
    const job = this.updateMemory(ref)
      .catch((err) => console.error('[engine] 整理前情提要失败：', err))
      .finally(() => this.memoryJobs.delete(key));
    this.memoryJobs.set(key, job);
  }

  /** 摘要之后的原文太长时，把较旧的部分并入前情提要（观察模式还会整理每个角色各自的记忆）。 */
  private async updateMemory(ref: PlayRef): Promise<void> {
    const db = this.db(ref.worldId);
    const pt = db.getPlaythrough(ref.playthroughId);
    const events = db.path(pt.id, pt.headId);
    const summary = db.latestSummary(
      pt.id,
      events.map((e) => e.id),
    );
    const from = summary ? events.findIndex((e) => e.id === summary.eventId) + 1 : 0;
    const raw = events.slice(from);
    const chars = raw.reduce((n, e) => n + eventText(e, '').length, 0);
    if (raw.length <= MEMORY.keepEvents + 2) return;
    if (raw.length <= MEMORY.triggerEvents && chars <= MEMORY.triggerChars) return;

    const world = await this.store.load(ref.worldId);
    const protagonist = protagonistOf(world, pt.protagonistId);
    const cut = events.length - MEMORY.keepEvents - 1;
    const chunk = events.slice(from, cut + 1);
    const h = await this.gateway.forRole('archivist', 'play.memory', this.meter(ref));
    let text = '';
    const characters = { ...(summary?.characters ?? {}) };
    if (pt.mode === 'observer') {
      try {
        const { system, user } = memoryPrompt(world, protagonist, summary, chunk);
        const { value } = await generateJson(this.gateway, h, { system, user, spec: memorySpec });
        text = value.summary.trim();
        for (const c of value.characters) {
          const m = matchByName(c.name, world.characters);
          if (m && c.knows.trim()) characters[m.id] = c.knows.trim();
        }
      } catch (err) {
        console.error('[engine] 整理角色记忆失败，改用普通的前情提要：', err);
      }
    }
    if (!text) {
      const { system, user } = summaryPrompt(world, protagonist, summary?.text ?? null, chunk);
      const result = await this.gateway.run(
        h,
        {
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        },
        { stream: false },
      );
      text = stripThinking(result.text).trim();
    }
    if (!text) throw new Error('模型返回了空的前情提要');
    const target = events[cut] as PlayEvent;
    db.putSummary(pt.id, { eventId: target.id, text, covered: cut + 1, characters });
  }

  // ───────────── 分支与存档 ─────────────

  private guard(ref: PlayRef): void {
    if (this.busy.has(this.key(ref))) throw new Error('正在生成中，请稍等');
  }

  /** 会改变当前位置的操作：先让观察模式停下（丢弃正在生成的一拍）。 */
  private async settle(ref: PlayRef): Promise<void> {
    await this.observer.halt(ref);
    this.guard(ref);
  }

  async edit(ref: PlayRef, eventId: string, text?: string, segments?: Segment[]): Promise<PlayView> {
    const db = this.db(ref.worldId);
    const ev = db.getEvent(ref.playthroughId, eventId);
    if (ev.kind === 'player' || ev.kind === 'directive' || ev.kind === 'whisper') {
      if (!text?.trim()) throw new Error('内容不能为空');
      ev.text = text.trim();
    } else if (ev.kind === 'ai' || ev.kind === 'opening') {
      let next = segments;
      if (!next && text !== undefined) {
        // 编辑时按文本格式重新解析；名字对不上的保留原名
        const world = await this.store.load(ref.worldId);
        next = parseScript(text, { cast: world.characters });
      }
      if (!next?.length) throw new Error('内容不能为空');
      ev.segments = next;
    } else {
      throw new Error('这条内容不能编辑');
    }
    ev.edited = true;
    db.updateEvent(ref.playthroughId, ev);
    return this.view(ref);
  }

  async switchBranch(ref: PlayRef, eventId: string): Promise<PlayView> {
    await this.settle(ref);
    const db = this.db(ref.worldId);
    db.setHead(ref.playthroughId, db.latestLeaf(ref.playthroughId, eventId));
    return this.view(ref);
  }

  async rewind(ref: PlayRef, eventId: string): Promise<PlayView> {
    await this.settle(ref);
    this.db(ref.worldId).setHead(ref.playthroughId, eventId);
    return this.view(ref);
  }

  async deleteBranch(ref: PlayRef, eventId: string): Promise<PlayView> {
    await this.settle(ref);
    const db = this.db(ref.worldId);
    const pt = db.getPlaythrough(ref.playthroughId);
    const ev = db.getEvent(pt.id, eventId);
    if (!ev.parentId) throw new Error('不能删除开场');
    const headPath = db.path(pt.id, pt.headId).map((e) => e.id);
    db.deleteSubtree(pt.id, eventId);
    if (headPath.includes(eventId)) {
      // 当前位置被删了：退到父节点，如果父节点还有别的分支就走过去
      db.setHead(pt.id, db.latestLeaf(pt.id, ev.parentId));
    }
    return this.view(ref);
  }

  async setScene(ref: PlayRef, scene: SceneState): Promise<PlayView> {
    await this.settle(ref);
    const world = await this.store.load(ref.worldId);
    if (scene.locationId && !world.locations.some((l) => l.id === scene.locationId)) throw new Error('地点不存在');
    const ids = scene.presentCharacterIds.filter((id) => world.characters.some((c) => c.id === id));
    const db = this.db(ref.worldId);
    const pt = db.getPlaythrough(ref.playthroughId);
    const ev: PlayEvent = {
      id: shortId('ev'),
      parentId: pt.headId,
      kind: 'scene',
      createdAt: Date.now(),
      scene: { locationId: scene.locationId, presentCharacterIds: [...new Set(ids)] },
    };
    db.insertEvent(pt.id, ev);
    db.setHead(pt.id, ev.id);
    return this.view(ref);
  }

  save(ref: PlayRef, name?: string): Promise<PlayView> {
    const db = this.db(ref.worldId);
    const pt = db.getPlaythrough(ref.playthroughId);
    const head = db.getEvent(pt.id, pt.headId);
    db.addSave(pt.id, {
      id: shortId('sv'),
      name: name?.trim() || `存档 ${db.listSaves(pt.id).length + 1}`,
      eventId: head.id,
      preview: preview(head, 60),
      createdAt: Date.now(),
    });
    return this.view(ref);
  }

  async load(ref: PlayRef, saveId: string): Promise<PlayView> {
    await this.settle(ref);
    const db = this.db(ref.worldId);
    const s = db.getSave(ref.playthroughId, saveId);
    db.setHead(ref.playthroughId, s.eventId);
    return this.view(ref);
  }

  deleteSave(ref: PlayRef, saveId: string): Promise<PlayView> {
    this.db(ref.worldId).deleteSave(ref.playthroughId, saveId);
    return this.view(ref);
  }
}
