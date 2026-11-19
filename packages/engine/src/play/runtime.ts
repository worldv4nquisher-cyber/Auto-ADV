import path from 'node:path';
import type {
  PathEvent,
  PlayChunk,
  PlayEvent,
  PlaythroughInfo,
  PlayRef,
  PlayView,
  SceneState,
  Segment,
  SendParams,
} from '../api.ts';
import type { ModelGateway } from '../llm/gateway.ts';
import { stripThinking } from '../llm/structured.ts';
import { shortId } from '../util.ts';
import type { WorldData, WorldStore } from '../world/store.ts';
import { buildMessages, eventText, protagonistOf, sceneAt, summaryPrompt } from './context.ts';
import { PlayDb, type PlaythroughRow } from './db.ts';
import { parseScript, ScriptStream, type ScriptOptions } from './script.ts';

type Emit = (chunk: PlayChunk) => void;

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

/** 游玩运行时（M1：自由对话，合并模式——一次调用写出整段回复）。 */
export class PlayService {
  private readonly store: WorldStore;
  private readonly gateway: ModelGateway;
  private readonly dbs = new Map<string, PlayDb>();
  private readonly busy = new Set<string>();
  private readonly memoryJobs = new Map<string, Promise<void>>();

  constructor(store: WorldStore, gateway: ModelGateway) {
    this.store = store;
    this.gateway = gateway;
  }

  private db(worldId: string): PlayDb {
    let db = this.dbs.get(worldId);
    if (!db) {
      db = new PlayDb(path.join(this.store.dir(worldId), 'playthroughs', 'play.db'));
      this.dbs.set(worldId, db);
    }
    return db;
  }

  /** 关闭某个世界的数据库（删除世界前必须先关，Windows 上文件被占用删不掉）。 */
  async closeWorld(worldId: string): Promise<void> {
    await Promise.all(
      [...this.memoryJobs.entries()].filter(([k]) => k.startsWith(`${worldId}/`)).map(([, p]) => p.catch(() => {})),
    );
    this.dbs.get(worldId)?.close();
    this.dbs.delete(worldId);
  }

  /** 立即关闭所有数据库（引擎退出时）。 */
  dispose(): void {
    for (const db of this.dbs.values()) db.close();
    this.dbs.clear();
  }

  /** 等待后台的记忆整理完成（测试用）。 */
  async flush(ref: PlayRef): Promise<void> {
    await this.memoryJobs.get(`${ref.worldId}/${ref.playthroughId}`);
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
    return { ...pt, worldId, preview: preview(head) };
  }

  async start(worldId: string, title?: string): Promise<PlayView> {
    const world = await this.store.load(worldId);
    if (world.manifest.status !== 'ready' || !world.opening) throw new Error('这个世界还没有生成完，不能开始游玩');
    const db = this.db(worldId);
    const now = Date.now();
    const root: PlayEvent = {
      id: shortId('ev'),
      parentId: null,
      kind: 'opening',
      createdAt: now,
      segments: openingSegments(world),
      scene: {
        locationId: world.opening.locationId ?? world.locations[0]?.id ?? null,
        presentCharacterIds: world.opening.presentCharacterIds,
      },
    };
    const pt: PlaythroughRow = {
      id: shortId('pt'),
      title: title?.trim() || `周目 ${db.listPlaythroughs().length + 1}`,
      mode: 'chat',
      protagonistId: protagonistOf(world, null)?.id ?? null,
      headId: root.id,
      createdAt: now,
      updatedAt: now,
    };
    db.createPlaythrough(pt, root);
    return this.view({ worldId, playthroughId: pt.id });
  }

  delete(ref: PlayRef): void {
    if (this.busy.has(this.key(ref))) throw new Error('正在生成中，请先停止');
    this.db(ref.worldId).deletePlaythrough(ref.playthroughId);
  }

  view(ref: PlayRef): PlayView {
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
    };
  }

  // ───────────── 生成 ─────────────

  private key(ref: PlayRef): string {
    return `${ref.worldId}/${ref.playthroughId}`;
  }

  private async exclusive<T>(ref: PlayRef, emit: Emit, fn: () => Promise<T>): Promise<T> {
    const key = this.key(ref);
    if (this.busy.has(key)) throw new Error('上一条回复还在生成中');
    this.busy.add(key);
    try {
      const job = this.memoryJobs.get(key);
      if (job) {
        emit({ type: 'phase', phase: 'memory' });
        await job;
      }
      return await fn();
    } finally {
      this.busy.delete(key);
    }
  }

  /** 玩家发言（或空输入"继续"），然后生成回复。 */
  send(p: SendParams, emit: Emit, signal: AbortSignal): Promise<PlayView> {
    return this.exclusive(p, emit, async () => {
      const db = this.db(p.worldId);
      const pt = db.getPlaythrough(p.playthroughId);
      let parentId = p.parentId ?? pt.headId;
      db.getEvent(pt.id, parentId);
      const text = p.text.trim();
      if (text) {
        const ev: PlayEvent = { id: shortId('ev'), parentId, kind: 'player', createdAt: Date.now(), text };
        db.insertEvent(pt.id, ev);
        db.setHead(pt.id, ev.id);
        emit({ type: 'player', event: { ...ev, siblingIds: [ev.id], siblingIndex: 0 } });
        parentId = ev.id;
      }
      await this.reply(p, parentId, emit, signal);
      return this.view(p);
    });
  }

  /** 重抽一条回复：在同一个父节点下生成新的分支。 */
  regenerate(ref: PlayRef, eventId: string, emit: Emit, signal: AbortSignal): Promise<PlayView> {
    return this.exclusive(ref, emit, async () => {
      const db = this.db(ref.worldId);
      const ev = db.getEvent(ref.playthroughId, eventId);
      if (ev.kind !== 'ai' || !ev.parentId) throw new Error('只能重抽角色的回复');
      await this.reply(ref, ev.parentId, emit, signal);
      return this.view(ref);
    });
  }

  private async reply(ref: PlayRef, parentId: string, emit: Emit, signal: AbortSignal): Promise<PlayEvent> {
    const db = this.db(ref.worldId);
    const pt = db.getPlaythrough(ref.playthroughId);
    const world = await this.store.load(ref.worldId);
    const protagonist = protagonistOf(world, pt.protagonistId);
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
    const h = await this.gateway.forRole('actor', 'play.reply');
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

  // ───────────── 记忆 ─────────────

  private scheduleMemory(ref: PlayRef): void {
    const key = this.key(ref);
    if (this.memoryJobs.has(key)) return;
    const job = this.updateMemory(ref)
      .catch((err) => console.error('[engine] 整理前情提要失败：', err))
      .finally(() => this.memoryJobs.delete(key));
    this.memoryJobs.set(key, job);
  }

  /** 摘要之后的原文太长时，把较旧的部分并入前情提要。 */
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
    const world = await this.store.load(ref.worldId);
    const protagonist = protagonistOf(world, pt.protagonistId);
    const chars = raw.reduce((n, e) => n + eventText(e, '').length, 0);
    if (raw.length <= MEMORY.keepEvents + 2) return;
    if (raw.length <= MEMORY.triggerEvents && chars <= MEMORY.triggerChars) return;

    const cut = events.length - MEMORY.keepEvents - 1;
    const chunk = events.slice(from, cut + 1);
    const { system, user } = summaryPrompt(world, protagonist, summary?.text ?? null, chunk);
    const h = await this.gateway.forRole('archivist', 'play.memory');
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
    const text = stripThinking(result.text).trim();
    if (!text) throw new Error('模型返回了空的前情提要');
    const target = events[cut] as PlayEvent;
    db.putSummary(pt.id, target.id, text, cut + 1);
  }

  // ───────────── 分支与存档 ─────────────

  private guard(ref: PlayRef): void {
    if (this.busy.has(this.key(ref))) throw new Error('正在生成中，请稍等');
  }

  async edit(ref: PlayRef, eventId: string, text?: string, segments?: Segment[]): Promise<PlayView> {
    this.guard(ref);
    const db = this.db(ref.worldId);
    const ev = db.getEvent(ref.playthroughId, eventId);
    if (ev.kind === 'player') {
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

  switchBranch(ref: PlayRef, eventId: string): PlayView {
    this.guard(ref);
    const db = this.db(ref.worldId);
    db.setHead(ref.playthroughId, db.latestLeaf(ref.playthroughId, eventId));
    return this.view(ref);
  }

  rewind(ref: PlayRef, eventId: string): PlayView {
    this.guard(ref);
    this.db(ref.worldId).setHead(ref.playthroughId, eventId);
    return this.view(ref);
  }

  deleteBranch(ref: PlayRef, eventId: string): PlayView {
    this.guard(ref);
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
    this.guard(ref);
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

  save(ref: PlayRef, name?: string): PlayView {
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

  load(ref: PlayRef, saveId: string): PlayView {
    this.guard(ref);
    const db = this.db(ref.worldId);
    const s = db.getSave(ref.playthroughId, saveId);
    db.setHead(ref.playthroughId, s.eventId);
    return this.view(ref);
  }

  deleteSave(ref: PlayRef, saveId: string): PlayView {
    this.db(ref.worldId).deleteSave(ref.playthroughId, saveId);
    return this.view(ref);
  }
}
