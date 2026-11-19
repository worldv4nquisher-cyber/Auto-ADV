/**
 * 极简的类型安全 RPC，跑在任意"端口"上（Electron 的 MessagePort、浏览器 MessagePort、内存管道）。
 * 支持普通调用和流式调用（服务端用 async generator 实现，产出的每一项推给客户端，返回值作为最终结果），
 * 客户端可以取消正在进行的调用。
 */

export interface Unary<P, R> {
  kind: 'unary';
  params: P;
  result: R;
}

export interface Streaming<P, C, R> {
  kind: 'stream';
  params: P;
  chunk: C;
  result: R;
}

// 契约的各项类型由使用方定义，这里只约束形状
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Contract = Record<string, Unary<any, any> | Streaming<any, any, any>>;

export interface CallContext {
  signal: AbortSignal;
}

export type Handlers<C extends Contract> = {
  [K in keyof C]: C[K] extends Streaming<infer P, infer Ch, infer R>
    ? (params: P, ctx: CallContext) => AsyncGenerator<Ch, R, void>
    : C[K] extends Unary<infer P, infer R>
      ? (params: P, ctx: CallContext) => R | Promise<R>
      : never;
};

export type UnaryKeys<C extends Contract> = { [K in keyof C]: C[K] extends Unary<unknown, unknown> ? K : never }[keyof C] &
  string;
export type StreamKeys<C extends Contract> = {
  [K in keyof C]: C[K] extends Streaming<unknown, unknown, unknown> ? K : never;
}[keyof C] &
  string;

type ParamsArg<T> = T extends { params: infer P } ? ([P] extends [void] ? [] : [P]) : never;

export interface PortLike {
  postMessage(message: unknown): void;
  /** 订阅消息，返回取消订阅函数。 */
  subscribe(handler: (message: unknown) => void): () => void;
}

export interface RpcErrorData {
  message: string;
  code?: string;
}

type RpcMessage =
  | { t: 'req'; id: number; method: string; params: unknown }
  | { t: 'cancel'; id: number }
  | { t: 'chunk'; id: number; data: unknown }
  | { t: 'res'; id: number; ok: true; result: unknown }
  | { t: 'res'; id: number; ok: false; error: RpcErrorData };

function isRpcMessage(m: unknown): m is RpcMessage {
  return typeof m === 'object' && m !== null && 't' in m && 'id' in m;
}

export class RpcError extends Error {
  readonly code: string | undefined;
  constructor(data: RpcErrorData) {
    super(data.message);
    this.name = 'RpcError';
    this.code = data.code;
  }
}

function toErrorData(err: unknown): RpcErrorData {
  if (err instanceof Error) {
    const e = err as Error & { code?: unknown; aborted?: unknown };
    const code = e.aborted === true ? 'aborted' : typeof e.code === 'string' ? e.code : e.name;
    return { message: e.message, code };
  }
  return { message: String(err) };
}

function isAsyncGenerator(v: unknown): v is AsyncGenerator<unknown, unknown, void> {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as AsyncGenerator).next === 'function' &&
    typeof (v as AsyncGenerator)[Symbol.asyncIterator] === 'function'
  );
}

/** 在端口上提供服务。返回停止函数（会取消所有进行中的调用）。 */
export function serveRpc<C extends Contract>(port: PortLike, handlers: Handlers<C>): () => void {
  const inflight = new Map<number, AbortController>();
  const table = handlers as unknown as Record<string, (p: unknown, ctx: CallContext) => unknown>;

  const handle = async (msg: Extract<RpcMessage, { t: 'req' }>) => {
    const fn = table[msg.method];
    if (!fn) {
      port.postMessage({ t: 'res', id: msg.id, ok: false, error: { message: `未知方法：${msg.method}`, code: 'not_found' } });
      return;
    }
    const ctrl = new AbortController();
    inflight.set(msg.id, ctrl);
    try {
      const out = fn(msg.params, { signal: ctrl.signal });
      let result: unknown;
      if (isAsyncGenerator(out)) {
        let next = await out.next();
        while (!next.done) {
          port.postMessage({ t: 'chunk', id: msg.id, data: next.value });
          next = await out.next();
        }
        result = next.value;
      } else {
        result = await out;
      }
      port.postMessage({ t: 'res', id: msg.id, ok: true, result });
    } catch (err) {
      const data = ctrl.signal.aborted ? { message: '已取消', code: 'aborted' } : toErrorData(err);
      port.postMessage({ t: 'res', id: msg.id, ok: false, error: data });
    } finally {
      inflight.delete(msg.id);
    }
  };

  const unsubscribe = port.subscribe((m) => {
    if (!isRpcMessage(m)) return;
    if (m.t === 'req') void handle(m);
    else if (m.t === 'cancel') inflight.get(m.id)?.abort();
  });

  return () => {
    unsubscribe();
    for (const ctrl of inflight.values()) ctrl.abort();
    inflight.clear();
  };
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  onChunk?: (c: unknown) => void;
}

export class RpcClient<C extends Contract> {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly unsubscribe: () => void;
  private readonly port: PortLike;

  constructor(port: PortLike) {
    this.port = port;
    this.unsubscribe = port.subscribe((m) => {
      if (!isRpcMessage(m)) return;
      const p = this.pending.get(m.id);
      if (!p) return;
      if (m.t === 'chunk') p.onChunk?.(m.data);
      else if (m.t === 'res') {
        this.pending.delete(m.id);
        if (m.ok) p.resolve(m.result);
        else p.reject(new RpcError(m.error));
      }
    });
  }

  call<K extends UnaryKeys<C>>(method: K, ...args: ParamsArg<C[K]>): Promise<C[K]['result']> {
    return this.send(method, (args as unknown[])[0], undefined, undefined) as Promise<C[K]['result']>;
  }

  stream<K extends StreamKeys<C>>(
    method: K,
    params: C[K]['params'],
    onChunk: (chunk: C[K] extends Streaming<unknown, infer Ch, unknown> ? Ch : never) => void,
    signal?: AbortSignal,
  ): Promise<C[K]['result']> {
    return this.send(method, params, onChunk as (c: unknown) => void, signal) as Promise<C[K]['result']>;
  }

  private send(method: string, params: unknown, onChunk?: (c: unknown) => void, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new RpcError({ message: '已取消', code: 'aborted' }));
      this.pending.set(id, { resolve, reject, onChunk });
      signal?.addEventListener('abort', () => this.port.postMessage({ t: 'cancel', id }), { once: true });
      this.port.postMessage({ t: 'req', id, method, params });
    });
  }

  /** 断开连接，所有未完成的调用以错误结束。 */
  close(reason = '连接已断开'): void {
    this.unsubscribe();
    for (const p of this.pending.values()) p.reject(new RpcError({ message: reason, code: 'disconnected' }));
    this.pending.clear();
  }
}

/** 内存中的一对端口，用于测试和同进程使用。消息会被结构化克隆，模拟真实端口。 */
export function createPortPair(): [PortLike, PortLike] {
  const handlers: [Set<(m: unknown) => void>, Set<(m: unknown) => void>] = [new Set(), new Set()];
  const make = (self: 0 | 1): PortLike => ({
    postMessage(message) {
      const copy = structuredClone(message);
      const other = handlers[self === 0 ? 1 : 0];
      queueMicrotask(() => {
        for (const h of other) h(copy);
      });
    },
    subscribe(handler) {
      handlers[self].add(handler);
      return () => handlers[self].delete(handler);
    },
  });
  return [make(0), make(1)];
}

/** 浏览器 / 渲染进程里的 MessagePort。 */
export function fromDomPort(port: MessagePort): PortLike {
  return {
    postMessage: (m) => port.postMessage(m),
    subscribe(handler) {
      const listener = (e: MessageEvent) => handler(e.data);
      port.addEventListener('message', listener);
      port.start();
      return () => port.removeEventListener('message', listener);
    },
  };
}

/** Electron 主进程 / utilityProcess 里的 MessagePortMain（事件对象带 data 字段）。 */
export interface NodeStylePort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (e: { data: unknown }) => void): unknown;
  off(event: 'message', listener: (e: { data: unknown }) => void): unknown;
  start?(): void;
}

export function fromNodePort(port: NodeStylePort): PortLike {
  return {
    postMessage: (m) => port.postMessage(m),
    subscribe(handler) {
      const listener = (e: { data: unknown }) => handler(e.data);
      port.on('message', listener);
      port.start?.();
      return () => port.off('message', listener);
    },
  };
}
