import type { EngineContract } from '@auto-adv/engine/api';
import { fromDomPort, RpcClient, type StreamKeys, type Streaming, type UnaryKeys } from '@auto-adv/engine/rpc';

/**
 * 与引擎进程的连接。界面通过 preload 请求一个 MessagePort，之后直接和引擎通信，不经过主进程。
 * 引擎崩溃重启后会自动重新连接。
 */
let client: RpcClient<EngineContract> | null = null;
let connecting: Promise<RpcClient<EngineContract>> | null = null;
const listeners = new Set<(connected: boolean) => void>();

function connect(): Promise<RpcClient<EngineContract>> {
  if (client) return Promise.resolve(client);
  connecting ??= new Promise((resolve, reject) => {
    if (!window.autoAdv) {
      reject(new Error('没有检测到桌面环境，请通过 Auto-ADV 应用打开'));
      connecting = null;
      return;
    }
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string } | null;
      if (e.source !== window || data?.type !== 'auto-adv:engine-port' || !e.ports[0]) return;
      window.removeEventListener('message', onMessage);
      client = new RpcClient<EngineContract>(fromDomPort(e.ports[0]));
      connecting = null;
      listeners.forEach((l) => l(true));
      resolve(client);
    };
    window.addEventListener('message', onMessage);
    window.autoAdv.connectEngine();
  });
  return connecting;
}

window.addEventListener('message', (e) => {
  const data = e.data as { type?: string } | null;
  if (e.source === window && data?.type === 'auto-adv:engine-restarted') {
    client?.close('引擎已重启，请重试');
    client = null;
    listeners.forEach((l) => l(false));
    void connect();
  }
});

export function onConnectionChange(listener: (connected: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

type C = EngineContract;
type ParamsArg<T> = T extends { params: infer P } ? ([P] extends [void] ? [] : [P]) : never;
type ChunkOf<T> = T extends Streaming<unknown, infer Ch, unknown> ? Ch : never;

export const engine = {
  async call<K extends UnaryKeys<C>>(method: K, ...args: ParamsArg<C[K]>): Promise<C[K]['result']> {
    return (await connect()).call(method, ...args);
  },
  async stream<K extends StreamKeys<C>>(
    method: K,
    params: C[K]['params'],
    onChunk: (chunk: ChunkOf<C[K]>) => void,
    signal?: AbortSignal,
  ): Promise<C[K]['result']> {
    return (await connect()).stream(method, params, onChunk, signal);
  },
};

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function isAborted(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'aborted';
}
