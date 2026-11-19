import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ToolCall, Usage } from '@auto-adv/providers';
import type { CallDetail, CallSummary, UsageSummary } from './api.ts';

export interface CallInsert {
  ts: number;
  role: string;
  endpointId: string;
  endpointName: string;
  model: string;
  kind: string;
  status: 'ok' | 'error' | 'aborted';
  httpStatus: number | null;
  url: string;
  attempt: number;
  latencyMs: number;
  ttftMs: number | null;
  usage: Usage | null;
  cost: number | null;
  currency: string;
  error: string | null;
  request: unknown;
  responseText: string;
  reasoning: string;
  toolCalls: ToolCall[];
}

const SCHEMA_VERSION = 1;

/** 调用日志，存在 SQLite 里（Node / Electron 自带的 node:sqlite，不需要编译原生模块）。 */
export class CallLog {
  private readonly db: DatabaseSync;
  private readonly maxRows: number;
  private insertsSincePrune = 0;

  /** file 传 ':memory:' 用于测试。maxRows 是保留的最大条数，超出后删最旧的。 */
  constructor(file: string, maxRows = 5000) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.maxRows = maxRows;
    this.db.exec('PRAGMA journal_mode = WAL;');
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (row.user_version < 1) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS calls (
          id TEXT PRIMARY KEY,
          ts INTEGER NOT NULL,
          role TEXT NOT NULL,
          endpoint_id TEXT NOT NULL,
          endpoint_name TEXT NOT NULL,
          model TEXT NOT NULL,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          http_status INTEGER,
          url TEXT NOT NULL,
          attempt INTEGER NOT NULL,
          latency_ms INTEGER NOT NULL,
          ttft_ms INTEGER,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cached_tokens INTEGER NOT NULL DEFAULT 0,
          reasoning_tokens INTEGER NOT NULL DEFAULT 0,
          estimated INTEGER NOT NULL DEFAULT 0,
          cost REAL,
          currency TEXT NOT NULL,
          error TEXT,
          request_json TEXT NOT NULL,
          response_text TEXT NOT NULL,
          reasoning TEXT NOT NULL,
          tool_calls_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS calls_ts ON calls (ts DESC);
        PRAGMA user_version = ${SCHEMA_VERSION};
      `);
    }
  }

  insert(c: CallInsert): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO calls (id, ts, role, endpoint_id, endpoint_name, model, kind, status, http_status, url, attempt,
          latency_ms, ttft_ms, input_tokens, output_tokens, cached_tokens, reasoning_tokens, estimated, cost, currency,
          error, request_json, response_text, reasoning, tool_calls_json)
         VALUES (:id, :ts, :role, :endpoint_id, :endpoint_name, :model, :kind, :status, :http_status, :url, :attempt,
          :latency_ms, :ttft_ms, :input_tokens, :output_tokens, :cached_tokens, :reasoning_tokens, :estimated, :cost,
          :currency, :error, :request_json, :response_text, :reasoning, :tool_calls_json)`,
      )
      .run({
        id,
        ts: c.ts,
        role: c.role,
        endpoint_id: c.endpointId,
        endpoint_name: c.endpointName,
        model: c.model,
        kind: c.kind,
        status: c.status,
        http_status: c.httpStatus,
        url: c.url,
        attempt: c.attempt,
        latency_ms: Math.round(c.latencyMs),
        ttft_ms: c.ttftMs === null ? null : Math.round(c.ttftMs),
        input_tokens: c.usage?.inputTokens ?? 0,
        output_tokens: c.usage?.outputTokens ?? 0,
        cached_tokens: c.usage?.cachedInputTokens ?? 0,
        reasoning_tokens: c.usage?.reasoningTokens ?? 0,
        estimated: c.usage?.estimated ? 1 : 0,
        cost: c.cost,
        currency: c.currency,
        error: c.error,
        request_json: JSON.stringify(c.request),
        response_text: c.responseText,
        reasoning: c.reasoning,
        tool_calls_json: JSON.stringify(c.toolCalls),
      });
    if (++this.insertsSincePrune >= 50) this.prune();
    return id;
  }

  list(limit = 100, offset = 0): { items: CallSummary[]; total: number } {
    const rows = this.db
      .prepare(
        `SELECT *, substr(response_text, 1, 80) AS preview FROM calls ORDER BY ts DESC, rowid DESC LIMIT :limit OFFSET :offset`,
      )
      .all({ limit, offset }) as unknown as Row[];
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM calls').get() as { n: number };
    return { items: rows.map(toSummary), total: n };
  }

  get(id: string): CallDetail | null {
    const row = this.db
      .prepare('SELECT *, substr(response_text, 1, 80) AS preview FROM calls WHERE id = :id')
      .get({ id }) as unknown as Row | undefined;
    if (!row) return null;
    return {
      ...toSummary(row),
      url: row.url,
      httpStatus: row.http_status,
      attempt: row.attempt,
      request: JSON.parse(row.request_json) as unknown,
      responseText: row.response_text,
      reasoning: row.reasoning,
      toolCalls: JSON.parse(row.tool_calls_json) as ToolCall[],
    };
  }

  clear(): void {
    this.db.exec('DELETE FROM calls');
  }

  summary(): UsageSummary {
    const totals = this.db
      .prepare('SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o FROM calls')
      .get() as { calls: number; i: number; o: number };
    const costs = this.db
      .prepare('SELECT currency, SUM(cost) AS total FROM calls WHERE cost IS NOT NULL GROUP BY currency ORDER BY currency')
      .all() as { currency: string; total: number }[];
    return {
      calls: totals.calls,
      inputTokens: totals.i,
      outputTokens: totals.o,
      costs: costs.map((c) => ({ currency: c.currency, total: c.total })),
    };
  }

  prune(): void {
    this.insertsSincePrune = 0;
    this.db
      .prepare('DELETE FROM calls WHERE rowid NOT IN (SELECT rowid FROM calls ORDER BY ts DESC, rowid DESC LIMIT :n)')
      .run({ n: this.maxRows });
  }

  close(): void {
    this.db.close();
  }
}

interface Row {
  id: string;
  ts: number;
  role: string;
  endpoint_id: string;
  endpoint_name: string;
  model: string;
  kind: string;
  status: 'ok' | 'error' | 'aborted';
  http_status: number | null;
  url: string;
  attempt: number;
  latency_ms: number;
  ttft_ms: number | null;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
  estimated: number;
  cost: number | null;
  currency: string;
  error: string | null;
  request_json: string;
  response_text: string;
  reasoning: string;
  tool_calls_json: string;
  preview: string;
}

function toSummary(r: Row): CallSummary {
  return {
    id: r.id,
    ts: r.ts,
    role: r.role,
    endpointId: r.endpoint_id,
    endpointName: r.endpoint_name,
    model: r.model,
    kind: r.kind,
    status: r.status,
    latencyMs: r.latency_ms,
    ttftMs: r.ttft_ms,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cachedInputTokens: r.cached_tokens,
    reasoningTokens: r.reasoning_tokens,
    estimated: r.estimated === 1,
    cost: r.cost,
    currency: r.currency,
    error: r.error,
    preview: r.preview,
  };
}
