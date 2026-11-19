import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type MockServer, startMockServer } from '@auto-adv/providers/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Cipher,
  createPortPair,
  Engine,
  type EngineContract,
  FileSecretStore,
  MemorySecretStore,
  RpcClient,
  serveRpc,
} from '../src/index.ts';

let dir: string;
let server: MockServer;
let engine: Engine;
let client: RpcClient<EngineContract>;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'auto-adv-test-'));
  server = await startMockServer({ apiKey: 'sk-secret', chunkDelayMs: 0 });
  engine = new Engine({ dataDir: dir, secrets: new MemorySecretStore(), callLogFile: ':memory:' });
  const [a, b] = createPortPair();
  serveRpc(a, engine.handlers());
  client = new RpcClient<EngineContract>(b);
});

afterEach(async () => {
  client.close();
  engine.close();
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

async function addEndpoint() {
  return client.call('saveEndpoint', {
    name: '模拟服务',
    baseURL: `${server.baseURL}/`,
    models: ['mock-chat'],
    currency: 'CNY',
    pricing: { 'mock-chat': { input: 2, output: 8 } },
    apiKey: 'sk-secret',
  });
}

describe('Engine', () => {
  it('保存接入点：密钥不进 settings.json', async () => {
    const ep = await addEndpoint();
    expect(ep.hasKey).toBe(true);
    expect(ep.baseURL).toBe(server.baseURL);
    const file = await readFile(path.join(dir, 'settings.json'), 'utf8');
    expect(file).toContain('模拟服务');
    expect(file).not.toContain('sk-secret');
    const view = await client.call('getSettings');
    expect(view.endpoints).toHaveLength(1);
    expect(JSON.stringify(view)).not.toContain('sk-secret');
  });

  it('拉取模型列表（用已保存的密钥）', async () => {
    const ep = await addEndpoint();
    expect(await client.call('fetchModels', { endpointId: ep.id })).toEqual(['mock-chat', 'mock-reasoner']);
  });

  it('能力探测：逐项汇报并保存结果', async () => {
    const ep = await addEndpoint();
    const steps: string[] = [];
    const caps = await client.stream('probe', { endpointId: ep.id, model: 'mock-reasoner' }, (c) => steps.push(c.step));
    expect(steps).toEqual(['chat', 'streaming', 'jsonSchema', 'jsonObject', 'tools']);
    expect(caps.tools).toBe(true);
    const view = await client.call('getSettings');
    expect(view.endpoints[0]?.capabilities['mock-reasoner']?.jsonSchema).toBe(true);
    expect(view.endpoints[0]?.models).toContain('mock-reasoner');
    const logs = await client.call('listCalls', {});
    expect(logs.items.every((c) => c.role === 'probe')).toBe(true);
    expect(logs.total).toBe(5);
  });

  it('按职责路由对话：流式输出、计费并写日志', async () => {
    const ep = await addEndpoint();
    await expect(
      client.stream('chat', { target: { role: 'director' }, messages: [{ role: 'user', content: '你好' }] }, () => {}),
    ).rejects.toThrow(/职责路由/);

    await client.call('setRole', { role: 'default', route: { endpointId: ep.id, model: 'mock-chat' } });
    let streamed = '';
    const result = await client.stream(
      'chat',
      { target: { role: 'director' }, messages: [{ role: 'user', content: '讲个故事' }] },
      (e) => {
        if (e.type === 'text') streamed += e.delta;
      },
    );
    expect(streamed).toBe(result.text);
    expect(result.text).toContain('讲个故事');
    expect(result.currency).toBe('CNY');
    expect(result.cost).toBeGreaterThan(0);
    expect(result.callId).toBeTruthy();

    const detail = await client.call('getCall', { id: result.callId as string });
    expect(detail?.role).toBe('director');
    expect(detail?.responseText).toBe(result.text);
    expect(JSON.stringify(detail?.request)).toContain('讲个故事');

    const summary = await client.call('usageSummary');
    expect(summary.calls).toBe(1);
    expect(summary.costs[0]?.currency).toBe('CNY');
  });

  it('删除接入点会清掉相关职责路由和密钥', async () => {
    const ep = await addEndpoint();
    await client.call('setRole', { role: 'actor', route: { endpointId: ep.id, model: 'mock-chat' } });
    await client.call('deleteEndpoint', { id: ep.id });
    const view = await client.call('getSettings');
    expect(view.endpoints).toHaveLength(0);
    expect(view.roles).toEqual({});
  });

  it('settings.json 损坏时备份并用默认设置启动', async () => {
    await writeFile(path.join(dir, 'settings.json'), '{ 这不是 JSON');
    const e2 = new Engine({ dataDir: dir, secrets: new MemorySecretStore(), callLogFile: ':memory:' });
    const view = await e2.getSettingsView();
    expect(view.endpoints).toEqual([]);
    e2.close();
  });
});

describe('FileSecretStore', () => {
  it('有加密能力时加密保存', async () => {
    const cipher: Cipher = {
      isAvailable: async () => true,
      encrypt: async (s) => Buffer.from(s).toString('base64'),
      decrypt: async (s) => Buffer.from(s, 'base64').toString(),
    };
    const store = new FileSecretStore(dir, cipher);
    await store.set('k', 'sk-very-secret');
    const raw = await readFile(path.join(dir, 'secrets.json'), 'utf8');
    expect(raw).not.toContain('sk-very-secret');
    expect(await new FileSecretStore(dir, cipher).get('k')).toBe('sk-very-secret');
  });

  it('没有加密能力时明文保存并如实报告', async () => {
    const store = new FileSecretStore(dir, null);
    await store.set('k', 'v');
    expect(await store.isEncrypted()).toBe(false);
    expect(await new FileSecretStore(dir, null).get('k')).toBe('v');
  });
});
