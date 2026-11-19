import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ObserverSettings, PlayMode } from '@auto-adv/schema';
import type { PlayEvent, PlayUsage, SaveInfo } from '../api.ts';

/** 周目的附加数据（JSON 列，加字段不用改表）。 */
export interface PlaythroughData {
  observer?: ObserverSettings;
  /** 观察模式下玩家接管的角色。 */
  controlledId?: string | null;
  /** 观察模式下观众读到的位置。 */
  readId?: string;
  usage?: PlayUsage;
  /** 生成中途收到、还没写进事件树的导演指令和悄悄话。 */
  pending?: { kind: 'directive' | 'whisper'; text: string; characterId?: string; createdAt: number }[];
}

export interface PlaythroughRow {
  id: string;
  title: string;
  mode: PlayMode;
  protagonistId: string | null;
  headId: string;
  createdAt: number;
  updatedAt: number;
  data: PlaythroughData;
}

export interface SummaryRow {
  eventId: string;
  text: string;
  covered: number;
  /** 各角色视角的记忆：角色 id → 这个角色知道 / 记得的事。 */
  characters: Record<string, string>;
}

interface EventRow {
  id: string;
  parent: string | null;
  kind: PlayEvent['kind'];
  data: string;
  call_id: string | null;
  created_at: number;
}

type EventData = Pick<PlayEvent, 'text' | 'segments' | 'scene' | 'edited' | 'characterId' | 'beat'>;

function toEvent(r: EventRow): PlayEvent {
  const data = JSON.parse(r.data) as EventData;
  return { id: r.id, parentId: r.parent, kind: r.kind, createdAt: r.created_at, callId: r.call_id, ...data };
}

function dataOf(e: PlayEvent): string {
  const d: EventData = {};
  if (e.text !== undefined) d.text = e.text;
  if (e.segments !== undefined) d.segments = e.segments;
  if (e.scene !== undefined) d.scene = e.scene;
  if (e.characterId !== undefined) d.characterId = e.characterId;
  if (e.beat !== undefined) d.beat = e.beat;
  if (e.edited) d.edited = true;
  return JSON.stringify(d);
}

const SCHEMA_VERSION = 2;

/**
 * 一个世界的所有周目：<world>/playthroughs/play.db。
 * 事件是一棵树（parent 指针），存档只是指向某个事件的指针，摘要挂在它覆盖到的最后一个事件上。
 */
export class PlayDb {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    const { user_version } = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (user_version < 1) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS playthroughs (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          mode TEXT NOT NULL,
          protagonist_id TEXT,
          head_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          pt TEXT NOT NULL REFERENCES playthroughs(id) ON DELETE CASCADE,
          parent TEXT,
          kind TEXT NOT NULL,
          data TEXT NOT NULL,
          call_id TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS events_parent ON events (pt, parent);
        CREATE TABLE IF NOT EXISTS summaries (
          event_id TEXT PRIMARY KEY,
          pt TEXT NOT NULL REFERENCES playthroughs(id) ON DELETE CASCADE,
          text TEXT NOT NULL,
          covered INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS saves (
          id TEXT PRIMARY KEY,
          pt TEXT NOT NULL REFERENCES playthroughs(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          event_id TEXT NOT NULL,
          preview TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        PRAGMA user_version = 1;
      `);
    }
    if ((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version < 2) {
      this.db.exec(`
        ALTER TABLE playthroughs ADD COLUMN data TEXT NOT NULL DEFAULT '{}';
        ALTER TABLE summaries ADD COLUMN chars TEXT NOT NULL DEFAULT '{}';
        PRAGMA user_version = ${SCHEMA_VERSION};
      `);
    }
  }

  close(): void {
    this.db.close();
  }

  // ───────────── 周目 ─────────────

  createPlaythrough(pt: PlaythroughRow, root: PlayEvent): void {
    this.tx(() => {
      this.db
        .prepare(
          'INSERT INTO playthroughs (id, title, mode, protagonist_id, head_id, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(pt.id, pt.title, pt.mode, pt.protagonistId, pt.headId, pt.createdAt, pt.updatedAt, JSON.stringify(pt.data));
      this.insertEvent(pt.id, root);
    });
  }

  listPlaythroughs(): PlaythroughRow[] {
    const rows = this.db.prepare('SELECT * FROM playthroughs ORDER BY updated_at DESC').all() as Record<string, unknown>[];
    return rows.map((r) => this.toPt(r));
  }

  getPlaythrough(id: string): PlaythroughRow {
    const r = this.db.prepare('SELECT * FROM playthroughs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!r) throw new Error('周目不存在，可能已被删除');
    return this.toPt(r);
  }

  private toPt(r: Record<string, unknown>): PlaythroughRow {
    return {
      id: r.id as string,
      title: r.title as string,
      mode: r.mode as PlayMode,
      protagonistId: (r.protagonist_id as string | null) ?? null,
      headId: r.head_id as string,
      createdAt: r.created_at as number,
      updatedAt: r.updated_at as number,
      data: JSON.parse((r.data as string | undefined) ?? '{}') as PlaythroughData,
    };
  }

  /** 读-改-写周目附加数据。 */
  updateData(pt: string, fn: (d: PlaythroughData) => PlaythroughData): PlaythroughData {
    const next = fn(this.getPlaythrough(pt).data);
    this.db.prepare('UPDATE playthroughs SET data = ? WHERE id = ?').run(JSON.stringify(next), pt);
    return next;
  }

  setHead(pt: string, headId: string): void {
    this.getEvent(pt, headId);
    this.db.prepare('UPDATE playthroughs SET head_id = ?, updated_at = ? WHERE id = ?').run(headId, Date.now(), pt);
  }

  deletePlaythrough(pt: string): void {
    this.db.prepare('DELETE FROM playthroughs WHERE id = ?').run(pt);
  }

  // ───────────── 事件 ─────────────

  insertEvent(pt: string, e: PlayEvent): void {
    this.db
      .prepare('INSERT INTO events (id, pt, parent, kind, data, call_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(e.id, pt, e.parentId, e.kind, dataOf(e), e.callId ?? null, e.createdAt);
  }

  getEvent(pt: string, id: string): PlayEvent {
    const r = this.db.prepare('SELECT * FROM events WHERE pt = ? AND id = ?').get(pt, id) as EventRow | undefined;
    if (!r) throw new Error('找不到这条内容，可能已被删除');
    return toEvent(r);
  }

  updateEvent(pt: string, e: PlayEvent): void {
    this.db.prepare('UPDATE events SET data = ? WHERE pt = ? AND id = ?').run(dataOf(e), pt, e.id);
  }

  /** 从树根到 id 的路径（含 id）。 */
  path(pt: string, id: string): PlayEvent[] {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE p(id, parent, kind, data, call_id, created_at, depth) AS (
           SELECT id, parent, kind, data, call_id, created_at, 0 FROM events WHERE pt = ? AND id = ?
           UNION ALL
           SELECT e.id, e.parent, e.kind, e.data, e.call_id, e.created_at, p.depth + 1
             FROM events e JOIN p ON e.id = p.parent WHERE e.pt = ?
         )
         SELECT * FROM p ORDER BY depth DESC`,
      )
      .all(pt, id, pt) as unknown as EventRow[];
    if (!rows.length) throw new Error('找不到这条内容，可能已被删除');
    return rows.map(toEvent);
  }

  /** 一批父节点各自的子节点 id（按创建顺序）。 */
  childrenOf(pt: string, parentIds: (string | null)[]): Map<string | null, string[]> {
    const out = new Map<string | null, string[]>();
    const ids = parentIds.filter((x): x is string => x !== null);
    if (parentIds.includes(null)) {
      const roots = this.db.prepare('SELECT id FROM events WHERE pt = ? AND parent IS NULL ORDER BY seq').all(pt) as {
        id: string;
      }[];
      out.set(
        null,
        roots.map((r) => r.id),
      );
    }
    for (let i = 0; i < ids.length; i += 500) {
      const batch = ids.slice(i, i + 500);
      const rows = this.db
        .prepare(`SELECT id, parent FROM events WHERE pt = ? AND parent IN (${batch.map(() => '?').join(',')}) ORDER BY seq`)
        .all(pt, ...batch) as { id: string; parent: string }[];
      for (const r of rows) {
        const list = out.get(r.parent) ?? [];
        list.push(r.id);
        out.set(r.parent, list);
      }
    }
    return out;
  }

  /** 从 id 出发，每一步走最新创建的子节点，直到叶子。 */
  latestLeaf(pt: string, id: string): string {
    const stmt = this.db.prepare('SELECT id FROM events WHERE pt = ? AND parent = ? ORDER BY seq DESC LIMIT 1');
    let cur = id;
    for (;;) {
      const next = stmt.get(pt, cur) as { id: string } | undefined;
      if (!next) return cur;
      cur = next.id;
    }
  }

  /** 删除 id 及其所有后代，连同挂在上面的摘要和存档。返回被删的 id。 */
  deleteSubtree(pt: string, id: string): string[] {
    let removed: string[] = [];
    this.tx(() => {
      const rows = this.db
        .prepare(
          `WITH RECURSIVE d(id) AS (
             SELECT id FROM events WHERE pt = ? AND id = ?
             UNION ALL
             SELECT e.id FROM events e JOIN d ON e.parent = d.id WHERE e.pt = ?
           ) SELECT id FROM d`,
        )
        .all(pt, id, pt) as { id: string }[];
      removed = rows.map((r) => r.id);
      for (let i = 0; i < removed.length; i += 500) {
        const batch = removed.slice(i, i + 500);
        const q = batch.map(() => '?').join(',');
        this.db.prepare(`DELETE FROM summaries WHERE pt = ? AND event_id IN (${q})`).run(pt, ...batch);
        this.db.prepare(`DELETE FROM saves WHERE pt = ? AND event_id IN (${q})`).run(pt, ...batch);
        this.db.prepare(`DELETE FROM events WHERE pt = ? AND id IN (${q})`).run(pt, ...batch);
      }
    });
    return removed;
  }

  // ───────────── 摘要 ─────────────

  /** 路径上最靠后的一份摘要。 */
  latestSummary(pt: string, pathIds: string[]): SummaryRow | null {
    if (!pathIds.length) return null;
    const found = new Map<string, Omit<SummaryRow, 'eventId'>>();
    for (let i = 0; i < pathIds.length; i += 500) {
      const batch = pathIds.slice(i, i + 500);
      const rows = this.db
        .prepare(
          `SELECT event_id, text, covered, chars FROM summaries WHERE pt = ? AND event_id IN (${batch.map(() => '?').join(',')})`,
        )
        .all(pt, ...batch) as { event_id: string; text: string; covered: number; chars: string }[];
      for (const r of rows) {
        found.set(r.event_id, {
          text: r.text,
          covered: r.covered,
          characters: JSON.parse(r.chars || '{}') as Record<string, string>,
        });
      }
    }
    for (let i = pathIds.length - 1; i >= 0; i--) {
      const s = found.get(pathIds[i] as string);
      if (s) return { eventId: pathIds[i] as string, ...s };
    }
    return null;
  }

  putSummary(pt: string, s: SummaryRow): void {
    this.db
      .prepare('INSERT OR REPLACE INTO summaries (event_id, pt, text, covered, chars, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(s.eventId, pt, s.text, s.covered, JSON.stringify(s.characters), Date.now());
  }

  // ───────────── 存档 ─────────────

  listSaves(pt: string): SaveInfo[] {
    const rows = this.db.prepare('SELECT * FROM saves WHERE pt = ? ORDER BY created_at DESC').all(pt) as Record<
      string,
      unknown
    >[];
    return rows.map((r) => ({
      id: r.id as string,
      name: r.name as string,
      eventId: r.event_id as string,
      preview: r.preview as string,
      createdAt: r.created_at as number,
    }));
  }

  addSave(pt: string, s: SaveInfo): void {
    this.db
      .prepare('INSERT INTO saves (id, pt, name, event_id, preview, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(s.id, pt, s.name, s.eventId, s.preview, s.createdAt);
  }

  getSave(pt: string, id: string): SaveInfo {
    const s = this.listSaves(pt).find((x) => x.id === id);
    if (!s) throw new Error('存档不存在');
    return s;
  }

  deleteSave(pt: string, id: string): void {
    this.db.prepare('DELETE FROM saves WHERE pt = ? AND id = ?').run(pt, id);
  }

  private tx(fn: () => void): void {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}
