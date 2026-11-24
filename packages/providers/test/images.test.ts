import { afterEach, describe, expect, it } from 'vitest';
import { OpenAIImageClient, type ImageExchangeRecord, sniffImage } from '../src/index.ts';
import { type MockServer, type MockServerOptions, startMockServer } from '../src/testing/mock-server.ts';

let server: MockServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function client(opts: MockServerOptions = {}) {
  server = await startMockServer({ chunkDelayMs: 0, ...opts });
  const log: ImageExchangeRecord[] = [];
  const c = new OpenAIImageClient({ baseURL: server.baseURL, apiKey: 'k', onExchange: (r) => log.push(r) });
  return { c, log, s: server };
}

describe('OpenAI 风格的图像接口', () => {
  it('b64_json：解出图片，记下改写后的提示词；日志里没有图片本身', async () => {
    const { c, log, s } = await client();
    const r = await c.generate({ model: 'm', prompt: '海边的灯塔', size: '1536x1024' });
    expect(r.mime).toBe('image/png');
    expect(sniffImage(r.data)).toBe('image/png');
    expect(r.revisedPrompt).toBe('（改写）海边的灯塔');
    expect(s.imageRequests[0]).toEqual({ model: 'm', prompt: '海边的灯塔', n: 1, size: '1536x1024', response_format: 'b64_json' });
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ kind: 'image', status: 'ok', httpStatus: 200, attempt: 1 });
    expect(JSON.stringify(log[0])).not.toContain('b64_json":"');
  });

  it('返回链接时马上下载', async () => {
    const { c } = await client({ imageUrl: true });
    const r = await c.generate({ model: 'm', prompt: 'x' });
    expect(r.mime).toBe('image/png');
    expect(r.data.length).toBeGreaterThan(50);
  });

  it('服务端不认识 response_format：去掉再发一次', async () => {
    const { c, s, log } = await client({ imageNoResponseFormat: true });
    const r = await c.generate({ model: 'm', prompt: 'x' });
    expect(r.mime).toBe('image/png');
    expect(s.imageRequests).toHaveLength(2);
    expect(s.imageRequests[1]).not.toHaveProperty('response_format');
    expect(log.map((l) => l.status)).toEqual(['error', 'ok']);
  });

  it('5xx 标成可以重试，4xx 不可以', async () => {
    const { c } = await client({ imageFailFirst: 1, imageRejectIf: '禁' });
    await expect(c.generate({ model: 'm', prompt: 'x' })).rejects.toMatchObject({ status: 500, retryable: true });
    await expect(c.generate({ model: 'm', prompt: '禁' })).rejects.toMatchObject({ status: 400, retryable: false });
  });
});
