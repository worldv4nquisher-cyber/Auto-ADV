/**
 * 引擎进程入口（Electron utilityProcess）。
 * 核心逻辑全部在 @auto-adv/engine 里，这里只负责接线：
 *  - 从主进程拿到 host 端口（加解密）；
 *  - 每个界面窗口连接时拿到一个 client 端口，在上面提供引擎 RPC 服务。
 */
import {
  type Cipher,
  Engine,
  FileSecretStore,
  fromNodePort,
  type HostContract,
  RpcClient,
  serveRpc,
} from '@auto-adv/engine';
import { net } from 'electron';

const dataDir = process.env.AUTO_ADV_DATA_DIR;
if (!dataDir) throw new Error('AUTO_ADV_DATA_DIR 未设置');

let resolveHost: (c: RpcClient<HostContract>) => void = () => {};
const host = new Promise<RpcClient<HostContract>>((r) => {
  resolveHost = r;
});

const cipher: Cipher = {
  isAvailable: async () => (await host).call('isEncryptionAvailable'),
  encrypt: async (plain) => (await host).call('encrypt', { plain }),
  decrypt: async (text) => (await host).call('decrypt', { cipher: text }),
};

const engine = new Engine({
  dataDir,
  secrets: new FileSecretStore(dataDir, cipher),
  // 用 Chromium 的网络栈发请求，自动遵循系统代理设置
  fetch: (url, init) => net.fetch(url, init),
});
const handlers = engine.handlers();

process.parentPort.on('message', (e) => {
  const data = e.data as { type?: string } | undefined;
  const port = e.ports[0];
  if (!port) return;
  if (data?.type === 'host-port') {
    resolveHost(new RpcClient<HostContract>(fromNodePort(port)));
  } else if (data?.type === 'client-port') {
    const stop = serveRpc(fromNodePort(port), handlers);
    port.on('close', stop);
  }
});

process.on('exit', () => engine.close());
