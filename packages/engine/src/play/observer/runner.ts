import type { ObserverSettings } from '@auto-adv/schema';
import type { ObserverChunk, ObserverStatus, PlayRef, PlayUsage } from '../../api.ts';

/** 观察模式的运行器需要宿主（PlayService）提供的能力。 */
export interface RunnerHost {
  /** 生成一拍并写进事件树（宿主负责加锁、计量、整理记忆）。 */
  runBeat(ref: PlayRef, signal: AbortSignal, emit: (c: ObserverChunk) => void): Promise<void>;
  settings(ref: PlayRef): ObserverSettings;
  usage(ref: PlayRef): PlayUsage;
  /** 观众读到的位置，以及之后还有几拍没看。 */
  cursor(ref: PlayRef): { readId: string; ahead: number };
}

export function overBudget(s: ObserverSettings, u: PlayUsage): boolean {
  const cost = Object.values(u.costs).reduce((a, b) => a + b, 0);
  if (s.budgetCost > 0 && cost >= s.budgetCost) return true;
  if (s.budgetTokens > 0 && u.inputTokens + u.outputTokens >= s.budgetTokens) return true;
  return false;
}

const isAbort = (err: unknown) =>
  (err as { aborted?: boolean })?.aborted === true || (err as Error)?.name === 'AbortError' || (err as { code?: string })?.code === 'aborted';

/** 一个周目的后台循环：缓冲不满就生成下一拍；预算、频率、连续失败都会让它停下或放慢。 */
class Runner {
  running = false;
  activity: ObserverStatus['activity'] = 'idle';
  stopReason: ObserverStatus['stopReason'] = null;
  lastError: string | null = null;
  failures = 0;
  readonly listeners = new Set<(c: ObserverChunk) => void>();
  private loop: Promise<void> | null = null;
  private ctrl: AbortController | null = null;
  private wake: (() => void) | null = null;
  private beatTimes: number[] = [];
  private readonly ref: PlayRef;
  private readonly host: RunnerHost;
  private readonly statusOf: () => ObserverStatus;

  constructor(ref: PlayRef, host: RunnerHost, statusOf: () => ObserverStatus) {
    this.ref = ref;
    this.host = host;
    this.statusOf = statusOf;
  }

  emit(c: ObserverChunk): void {
    for (const l of this.listeners) {
      try {
        l(c);
      } catch (err) {
        console.error('[engine] 推送观察模式进度失败：', err);
      }
    }
  }

  broadcast(): void {
    let status: ObserverStatus;
    try {
      status = this.statusOf();
    } catch {
      return; // 周目已被删除
    }
    this.emit({ type: 'status', status });
  }

  play(): void {
    this.running = true;
    this.stopReason = null;
    this.failures = 0;
    this.lastError = null;
    this.start();
    this.poke();
    this.broadcast();
  }

  private start(): void {
    if (this.loop) return;
    this.loop = this.run()
      .catch((err) => {
        // 宿主出错（比如周目被删了）：停下，不让异常漏出去
        this.running = false;
        this.stopReason = 'errors';
        this.lastError = (err as Error)?.message ?? String(err);
      })
      .finally(() => {
        this.loop = null;
        // 循环正要退出时又按了播放：重新开始
        if (this.running) return this.start();
        this.activity = 'idle';
        this.broadcast();
      });
  }

  /** 停下：不再开始新的一拍；abort 为 true 时连正在生成的这一拍也丢掉。 */
  async pause(abort: boolean, reason: ObserverStatus['stopReason'] = null): Promise<void> {
    this.running = false;
    if (reason) this.stopReason = reason;
    if (abort) this.ctrl?.abort();
    this.poke();
    if (abort) await this.loop?.catch(() => {});
    this.broadcast();
  }

  /** 有变化（观众读到了新位置、改了设置），叫醒等待中的循环。 */
  poke(): void {
    this.wake?.();
  }

  private sleep(ms: number | null): Promise<void> {
    return new Promise((resolve) => {
      const timer = ms === null ? null : setTimeout(done, ms);
      const self = this;
      function done() {
        if (timer) clearTimeout(timer);
        if (self.wake === done) self.wake = null;
        resolve();
      }
      this.wake = done;
    });
  }

  private set(activity: ObserverStatus['activity']) {
    if (this.activity === activity) return;
    this.activity = activity;
    this.broadcast();
  }

  private async run(): Promise<void> {
    while (this.running) {
      const s = this.host.settings(this.ref);
      if (overBudget(s, this.host.usage(this.ref))) {
        this.running = false;
        this.stopReason = 'budget';
        break;
      }
      if (this.host.cursor(this.ref).ahead >= s.bufferAhead) {
        this.set('buffered');
        await this.sleep(null);
        continue;
      }
      const now = Date.now();
      this.beatTimes = this.beatTimes.filter((t) => now - t < 60_000);
      if (s.maxBeatsPerMinute > 0 && this.beatTimes.length >= s.maxBeatsPerMinute) {
        this.set('throttled');
        await this.sleep(60_000 - (now - (this.beatTimes[0] ?? now)) + 50);
        continue;
      }
      this.set('generating');
      const ctrl = new AbortController();
      this.ctrl = ctrl;
      try {
        await this.host.runBeat(this.ref, ctrl.signal, (c) => this.emit(c));
        this.beatTimes.push(Date.now());
        this.failures = 0;
        this.lastError = null;
      } catch (err) {
        if (ctrl.signal.aborted || isAbort(err)) continue;
        this.failures++;
        this.lastError = (err as Error)?.message ?? String(err);
        if (this.failures >= s.maxFailures) {
          this.running = false;
          this.stopReason = 'errors';
          break;
        }
        this.set('backoff');
        await this.sleep(Math.min(30_000, 2000 * 2 ** (this.failures - 1)));
      } finally {
        this.ctrl = null;
      }
    }
  }
}

export class ObserverService {
  private readonly runners = new Map<string, Runner>();
  private readonly host: RunnerHost;
  private readonly statusOf: (ref: PlayRef) => ObserverStatus;

  constructor(host: RunnerHost, statusOf: (ref: PlayRef) => ObserverStatus) {
    this.host = host;
    this.statusOf = statusOf;
  }

  private key(ref: PlayRef) {
    return `${ref.worldId}/${ref.playthroughId}`;
  }

  private runner(ref: PlayRef): Runner {
    const k = this.key(ref);
    let r = this.runners.get(k);
    if (!r) {
      r = new Runner({ worldId: ref.worldId, playthroughId: ref.playthroughId }, this.host, () => this.statusOf(ref));
      this.runners.set(k, r);
    }
    return r;
  }

  /** 运行状态（没有运行器时是空闲）。 */
  state(ref: PlayRef): Pick<Runner, 'running' | 'activity' | 'stopReason' | 'lastError' | 'failures'> {
    const r = this.runners.get(this.key(ref));
    return r ?? { running: false, activity: 'idle', stopReason: null, lastError: null, failures: 0 };
  }

  play(ref: PlayRef): void {
    this.runner(ref).play();
  }

  pause(ref: PlayRef, reason: ObserverStatus['stopReason'] = null): Promise<void> {
    return this.runners.get(this.key(ref))?.pause(false, reason) ?? Promise.resolve();
  }

  /** 立即停下（丢弃正在生成的一拍）并等它收尾。回退、换分支、删除之前调用。 */
  halt(ref: PlayRef, reason: ObserverStatus['stopReason'] = null): Promise<void> {
    return this.runners.get(this.key(ref))?.pause(true, reason) ?? Promise.resolve();
  }

  poke(ref: PlayRef): void {
    const r = this.runners.get(this.key(ref));
    r?.poke();
    r?.broadcast();
  }

  emit(ref: PlayRef, c: ObserverChunk): void {
    this.runners.get(this.key(ref))?.emit(c);
  }

  /** 订阅实时进度，直到 signal 中止。 */
  async watch(ref: PlayRef, emit: (c: ObserverChunk) => void, signal: AbortSignal): Promise<void> {
    const r = this.runner(ref);
    r.listeners.add(emit);
    emit({ type: 'status', status: this.statusOf(ref) });
    try {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    } finally {
      r.listeners.delete(emit);
    }
  }

  /** 停下并丢掉运行器（删除周目前调用）。 */
  async drop(ref: PlayRef): Promise<void> {
    const k = this.key(ref);
    const r = this.runners.get(k);
    if (!r) return;
    await r.pause(true);
    this.runners.delete(k);
  }

  async haltWorld(worldId: string): Promise<void> {
    await Promise.all(
      [...this.runners.entries()]
        .filter(([k]) => k.startsWith(`${worldId}/`))
        .map(async ([k, r]) => {
          await r.pause(true);
          this.runners.delete(k);
        }),
    );
  }

  haltAll(): void {
    for (const r of this.runners.values()) void r.pause(true);
  }
}
