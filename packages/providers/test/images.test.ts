import { afterEach, describe, expect, it } from 'vitest';
import { decodePng, type ImageExchangeRecord, OpenAIImageClient, RembgCutoutClient, sniffImage } from '../src/index.ts';
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

describe('带参考图改图、透明背景、抠图服务', () => {
  it('改图：multipart 上传参考图，日志里只记参考图大小', async () => {
    const { c, s, log } = await client();
    const base = await c.generate({ model: 'm', prompt: '角色立绘，人物：短发', size: '1024x1536' });
    const r = await c.edit({ model: 'm', prompt: '只改表情：微笑', size: '1024x1536', image: { data: base.data, mime: base.mime } });
    expect(r.mime).toBe('image/png');
    expect(s.imageRequests[1]).toMatchObject({ edit: true, model: 'm', prompt: '只改表情：微笑', size: '1024x1536', n: '1', imageBytes: base.data.length });
    expect(log[1]?.url).toMatch(/\/images\/edits$/);
    expect(log[1]?.request.image).toMatch(/^参考图 \d+ KB$/);
  });

  it('要透明背景：带 background；服务不认识就去掉再发', async () => {
    const a = await client();
    await a.c.generate({ model: 'm', prompt: 'x', transparent: true });
    expect(a.s.imageRequests[0]?.background).toBe('transparent');
    await server?.close();
    const b = await client({ imageNoBackground: true });
    const r = await b.c.generate({ model: 'm', prompt: 'x', transparent: true });
    expect(r.mime).toBe('image/png');
    expect(b.s.imageRequests).toHaveLength(2);
    expect(b.s.imageRequests[1]?.background).toBeUndefined();
    expect(b.log.map((l) => l.status)).toEqual(['error', 'ok']);
  });

  it('抠图服务（rembg 的接口）：上传图片，拿回透明 PNG；地址写成完整的 /api/remove 也行', async () => {
    const { c, s } = await client();
    const img = await c.generate({ model: 'm', prompt: '角色立绘', size: '1024x1536' });
    const root = s.baseURL.replace(/\/v1$/, '');
    for (const url of [root, `${root}/api/remove`]) {
      const log: ImageExchangeRecord[] = [];
      const cut = new RembgCutoutClient({ baseURL: url, onExchange: (r) => log.push(r) });
      const out = await cut.remove({ data: img.data, mime: img.mime }, 'isnet-anime');
      const decoded = decodePng(out.data);
      expect(decoded.data[3]).toBe(0); // 左上角是背景，抠掉了
      expect(log[0]).toMatchObject({ status: 'ok', request: { model: 'isnet-anime' } });
    }
    expect(s.cutoutRequests.map((r) => r.model)).toEqual(['isnet-anime', 'isnet-anime']);
  });
});
