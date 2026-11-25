import { CUSTOM_API_PRESETS, type CustomApi, CustomApi as CustomApiSchema, type CustomOperation, checkCustomApi } from '@auto-adv/schema';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CustomCutoutClient,
  CustomImageClient,
  CustomMusicClient,
  type ImageExchangeRecord,
  type MusicExchangeRecord,
  type VoiceExchangeRecord,
  pick,
  ProviderError,
  renderJson,
  renderText,
  sniffImage,
} from '../src/index.ts';
import { encodePng } from '../src/testing/png.ts';
import { type MockServer, type MockServerOptions, startMockServer } from '../src/testing/mock-server.ts';

let server: MockServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function mock(opts: MockServerOptions = {}) {
  server = await startMockServer({ chunkDelayMs: 0, ...opts });
  return server;
}

const preset = (role: 'image' | 'cutout' | 'music', id: string): CustomApi => {
  const p = CUSTOM_API_PRESETS[role].find((x) => x.id === id);
  if (!p) throw new Error(id);
  return JSON.parse(JSON.stringify(p.api)) as CustomApi;
};

const op = (o: Partial<CustomOperation> & { url: string }): CustomOperation => CustomApiSchema.parse({ request: o }).request;

const noSleep = async () => {};

describe('模板', () => {
  it('文字里的占位符换成文字；JSON 里整个字符串是占位符时保留类型', () => {
    const vars = { prompt: '画：猫', width: 512, transparent: true, empty: null };
    expect(renderText('Bearer {{ apiKey }}', { apiKey: 'k' })).toBe('Bearer k');
    expect(renderJson({ a: '{{width}}', b: '宽 {{width}}', c: ['{{transparent}}'], d: { e: '{{prompt}}' }, n: 3, z: '{{empty}}' }, vars)).toEqual({
      a: 512,
      b: '宽 512',
      c: [true],
      d: { e: '画：猫' },
      n: 3,
      z: null,
    });
    expect(() => renderText('{{nope}}', {})).toThrow(/nope/);
  });

  it('按位置取值：点号、方括号、数组下标', () => {
    const v = { data: [{ b64_json: 'x', url: 'u' }], output: { audio: 'a' } };
    expect(pick(v, 'data.0.b64_json')).toBe('x');
    expect(pick(v, 'data[0].url')).toBe('u');
    expect(pick(v, 'output.audio')).toBe('a');
    expect(pick(v, 'output.none.deeper')).toBeUndefined();
    expect(pick(v, '')).toBe(v);
  });

  it('检查模板：JSON 写错、占位符不认识、没写结果位置都会指出来', () => {
    const ok = preset('image', 'openai');
    expect(checkCustomApi(ok, 'image')).toBeNull();
    expect(checkCustomApi({ request: { ...ok.request, body: '{"model": ' } }, 'image')).toMatch(/请求体不是合法的 JSON/);
    expect(checkCustomApi({ request: { ...ok.request, headers: '[]' } }, 'image')).toMatch(/请求头要写成 JSON 对象/);
    expect(checkCustomApi({ request: { ...ok.request, body: '{"x": "{{lyrics}}"}' } }, 'image')).toMatch(/\{\{lyrics\}\} 不认识/);
    expect(checkCustomApi({ request: { ...ok.request, resultPath: '' } }, 'image')).toMatch(/结果在响应里的位置/);
    // 改图请求可以用 {{image}}，文生图不行
    expect(checkCustomApi({ request: { ...ok.request, body: '{"i": "{{image_base64}}"}' } }, 'image')).toMatch(/不认识/);
    const async = preset('music', 'async');
    expect(checkCustomApi(async, 'music')).toBeNull();
    const poll = async.request.poll;
    if (!poll) throw new Error('no poll');
    expect(checkCustomApi({ request: { ...async.request, poll: { ...poll, url: '/jobs/{{job}}' } } }, 'music')).toMatch(/\{\{job\}\}/);
    for (const role of ['image', 'cutout', 'music'] as const) {
      for (const p of CUSTOM_API_PRESETS[role]) expect(checkCustomApi(p.api, role), `${role}/${p.id}`).toBeNull();
    }
  });
});

describe('和内置接口一样写法的模板（对着模拟服务）', () => {
  it('OpenAI 风格：文生图拿 b64_json，改图用表单上传参考图；密钥放进请求头，日志里看不到', async () => {
    const s = await mock({ apiKey: 'secret-key' });
    const log: (ImageExchangeRecord | MusicExchangeRecord | VoiceExchangeRecord)[] = [];
    const c = new CustomImageClient(preset('image', 'openai'), { baseURL: s.baseURL, apiKey: 'secret-key', onExchange: (r) => log.push(r) });
    const r = await c.generate({ model: 'mock-image', prompt: '黄昏的图书馆', size: '1536x1024' });
    expect(r.mime).toBe('image/png');
    expect(s.imageRequests[0]).toMatchObject({ model: 'mock-image', prompt: '黄昏的图书馆', size: '1536x1024', n: 1, response_format: 'b64_json' });

    const e = await c.edit({ model: 'mock-image', prompt: '微笑', size: '1024x1024', image: { data: r.data, mime: r.mime } });
    expect(e.mime).toBe('image/png');
    expect(s.imageRequests[1]).toMatchObject({ edit: true, model: 'mock-image', prompt: '微笑', imageBytes: r.data.length });

    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ kind: 'image', status: 'ok', httpStatus: 200, url: `${s.baseURL}/images/generations` });
    expect(log[1]?.request).toMatchObject({ image: expect.stringMatching(/^文件 \d+ KB$/) });
    expect(JSON.stringify(log)).not.toContain('secret-key');
  });

  it('密钥不对时报出服务的错误信息', async () => {
    const s = await mock({ apiKey: 'right' });
    const c = new CustomImageClient(preset('image', 'openai'), { baseURL: s.baseURL, apiKey: 'wrong' });
    await expect(c.generate({ model: 'm', prompt: 'p' })).rejects.toThrow(/HTTP 401.*Incorrect API key/);
  });

  it('没写改图请求时，改图报一句能看懂的话', async () => {
    const s = await mock();
    const { edit: _e, ...api } = preset('image', 'openai');
    const c = new CustomImageClient(api, { baseURL: s.baseURL });
    await expect(c.edit({ model: 'm', prompt: 'p', image: { data: encodePng(8, 8, () => [255, 0, 0, 255]), mime: 'image/png' } })).rejects.toThrow(/改图/);
  });

  it('rembg 风格：表单上传文件，响应本身就是 PNG；没填模型时不发 model 字段', async () => {
    const s = await mock();
    const origin = s.baseURL.replace(/\/v1$/, '');
    const c = new CustomCutoutClient(preset('cutout', 'rembg'), { baseURL: origin });
    const input = encodePng(16, 16, () => [255, 255, 255, 255]);
    const r = await c.remove({ data: input, mime: 'image/png' }, '');
    expect(sniffImage(r.data)).toBe('image/png');
    expect(s.cutoutRequests).toEqual([{ model: '', bytes: input.length }]);
    await c.remove({ data: input, mime: 'image/png' }, 'isnet-anime');
    expect(s.cutoutRequests[1]?.model).toBe('isnet-anime');
  });

  it('MiniMax 风格的音乐：hex 解码；base_resp 的错误码不是 0 就算失败', async () => {
    const s = await mock();
    const c = new CustomMusicClient(preset('music', 'minimax'), { baseURL: s.baseURL });
    const r = await c.generate({ model: 'music-x', prompt: '温暖的钢琴', instrumental: true });
    expect(r.mime).toBe('audio/wav');
    expect(s.musicRequests[0]).toMatchObject({ model: 'music-x', prompt: '温暖的钢琴', is_instrumental: true, output_format: 'hex' });
    await s.close();

    server = await startMockServer({ chunkDelayMs: 0, musicError: { code: 2153, message: 'not available' } });
    const bad = new CustomMusicClient(preset('music', 'minimax'), { baseURL: server.baseURL });
    await expect(bad.generate({ model: 'music-x', prompt: 'p', instrumental: true })).rejects.toThrow(/接口返回错误（2153）：not available/);
  });
});

describe('异步任务', () => {
  it('提交拿到 id，轮询到完成后下载链接里的图片；地址里的 id 会转义', async () => {
    const s = await mock({ jobPolls: 3 });
    const sleeps: number[] = [];
    const c = new CustomImageClient(preset('image', 'async'), {
      baseURL: s.baseURL,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const r = await c.generate({ model: 'm', prompt: '雨夜的车站', size: '1536x1024' });
    expect(r.mime).toBe('image/png');
    expect(s.jobRequests[0]).toMatchObject({ model: 'm', prompt: '雨夜的车站', width: 1536, height: 1024 });
    expect(typeof s.jobRequests[0]?.seed).toBe('number');
    expect(s.jobQueries).toBe(3);
    expect(sleeps).toEqual([3000, 3000, 3000]);
  });

  it('音乐也一样；任务失败时带上服务给的原因', async () => {
    const s = await mock({ jobPolls: 1 });
    const c = new CustomMusicClient(preset('music', 'async'), { baseURL: s.baseURL, sleep: noSleep });
    const r = await c.generate({ model: 'm', prompt: '雪', instrumental: true });
    expect(r.mime).toBe('audio/wav');
    expect(s.jobRequests[0]).toMatchObject({ instrumental: true });
    await expect(c.generate({ model: 'm', prompt: '任务失败', instrumental: true })).rejects.toThrow(/任务失败（failed）：content policy/);
  });

  it('超过最长等待时间就停', async () => {
    const s = await mock({ jobPolls: 1000 });
    const api = preset('image', 'async');
    if (!api.request.poll) throw new Error('no poll');
    api.request.poll.maxMinutes = 0.1;
    let now = Date.now();
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const c = new CustomImageClient(api, {
        baseURL: s.baseURL,
        sleep: async () => {
          now += 3000;
        },
      });
      await expect(c.generate({ model: 'm', prompt: 'p' })).rejects.toThrow(/超过 0.1 分钟/);
    } finally {
      Date.now = realNow;
    }
  });

  it('取消时马上停下', async () => {
    const s = await mock({ jobPolls: 1000 });
    const c = new CustomImageClient(preset('image', 'async'), { baseURL: s.baseURL });
    const ctrl = new AbortController();
    const p = c.generate({ model: 'm', prompt: 'p' }, ctrl.signal);
    setTimeout(() => ctrl.abort(), 50);
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).aborted).toBe(true);
  });
});

describe('其他写法', () => {
  it('GET 请求、地址里的占位符转义、data: 开头的 base64、错误信息位置', async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const png = encodePng(8, 8, () => [0, 128, 255, 255]);
    const fetchImpl = async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      if (url.includes('bad')) return new Response(JSON.stringify({ err: { msg: '提示词不合规' } }), { status: 200 });
      return new Response(JSON.stringify({ result: [{ img: `data:image/png;base64,${Buffer.from(png).toString('base64')}` }] }), { status: 200 });
    };
    const api: CustomApi = {
      request: op({
        method: 'GET',
        url: 'https://img.example.com/draw?q={{prompt}}&w={{width}}&key={{apiKey}}',
        headers: '{"X-Empty": "{{model}}"}',
        bodyType: 'none',
        resultPath: 'result[0].img',
        errorPath: 'err.msg',
      }),
    };
    const log: (ImageExchangeRecord | MusicExchangeRecord | VoiceExchangeRecord)[] = [];
    const c = new CustomImageClient(api, { baseURL: 'http://unused', apiKey: 'k&1', fetch: fetchImpl, onExchange: (r) => log.push(r) });
    const r = await c.generate({ model: '', prompt: '猫 & 狗', size: '512x768' });
    expect(r.data).toEqual(new Uint8Array(png));
    expect(seen[0]?.url).toBe('https://img.example.com/draw?q=%E7%8C%AB%20%26%20%E7%8B%97&w=512&key=k%261');
    expect(seen[0]?.init?.method).toBe('GET');
    expect(seen[0]?.init?.body).toBeUndefined();
    // 换完是空的请求头不发
    expect(seen[0]?.init?.headers).toEqual({});
    await expect(c.generate({ model: '', prompt: 'bad' })).rejects.toThrow(/接口返回错误：提示词不合规/);
    expect(log[1]?.status).toBe('error');
  });

  it('下载结果链接：同一个服务带上请求头，别的地址不带（不把密钥发给别人）', async () => {
    const png = encodePng(8, 8, () => [10, 20, 30, 255]);
    const seen: { url: string; headers: unknown }[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      seen.push({ url, headers: init?.headers });
      if (url.endsWith('/draw')) {
        const target = String(JSON.parse(String(init?.body)).prompt);
        return new Response(JSON.stringify({ url: target }));
      }
      return new Response(new Uint8Array(png));
    };
    const api: CustomApi = { request: op({ url: '/draw', body: '{"prompt": "{{prompt}}"}', resultPath: 'url' }) };
    const c = new CustomImageClient(api, { baseURL: 'https://svc.example.com/v1', apiKey: 'sk-1', fetch: fetchImpl });
    await c.generate({ model: 'm', prompt: 'https://svc.example.com/files/a.png' });
    await c.generate({ model: 'm', prompt: 'https://oss.example.net/a.png?sig=1' });
    expect(seen[1]).toEqual({ url: 'https://svc.example.com/files/a.png', headers: { Authorization: 'Bearer sk-1' } });
    expect(seen[3]).toEqual({ url: 'https://oss.example.net/a.png?sig=1', headers: {} });
  });

  it('返回的不是图片、结果位置没有内容时报错', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('hello').toString('base64') }] }));
    const c = new CustomImageClient(preset('image', 'openai'), { baseURL: 'http://x/v1', fetch: fetchImpl });
    await expect(c.generate({ model: 'm', prompt: 'p' })).rejects.toThrow(/不是认得出的图片/);
    const empty = new CustomImageClient(preset('image', 'openai'), { baseURL: 'http://x/v1', fetch: async () => new Response('{"data": []}') });
    await expect(empty.generate({ model: 'm', prompt: 'p' })).rejects.toThrow(/data\.0\.b64_json 没有结果/);
  });
});
