import { afterEach, describe, expect, it } from 'vitest';
import {
  audioMimeOf,
  encodeWav,
  MiniMaxMusicClient,
  type MusicExchangeRecord,
  ProviderError,
  sniffAudio,
  wavDurationMs,
} from '../src/index.ts';
import { type MockServer, type MockServerOptions, mockMusic, startMockServer } from '../src/testing/mock-server.ts';

let server: MockServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function client(opts: MockServerOptions = {}) {
  server = await startMockServer({ chunkDelayMs: 0, ...opts });
  const log: MusicExchangeRecord[] = [];
  const c = new MiniMaxMusicClient({ baseURL: server.baseURL, apiKey: 'k', onExchange: (r) => log.push(r) });
  return { c, log, s: server };
}

describe('MiniMax 的音乐接口', () => {
  it('只要纯音乐：hex 解出音频，记下时长；日志里没有音频本身', async () => {
    const { c, log, s } = await client();
    expect(c.url).toBe(`${s.baseURL}/music_generation`);
    const r = await c.generate({ model: 'music-x', prompt: '紧张的钢琴', instrumental: true });
    expect(r.mime).toBe('audio/wav');
    expect(r.durationMs).toBe(2000);
    expect(wavDurationMs(r.data)).toBe(2000);
    expect(s.musicRequests[0]).toEqual({
      model: 'music-x',
      prompt: '紧张的钢琴',
      is_instrumental: true,
      stream: false,
      output_format: 'hex',
      audio_setting: { sample_rate: 44100, bitrate: 128000, format: 'mp3' },
    });
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ kind: 'music', status: 'ok', httpStatus: 200, durationMs: 2000, bytes: r.data.length });
    expect(JSON.stringify(log[0])).not.toMatch(/[0-9a-f]{200}/);
  });

  it('错误在 base_resp 里：报出错误码和原因；不支持纯音乐时提示换模型', async () => {
    const { c, log } = await client({ musicError: { code: 2061, message: 'your current token plan not support model' } });
    await expect(c.generate({ model: 'm', prompt: 'x', instrumental: true })).rejects.toThrow('接口返回错误（2061）：your current token plan not support model');
    expect(log[0]).toMatchObject({ status: 'error' });

    await server?.close();
    const again = await client();
    // 模拟服务：没要纯音乐又没给歌词就报 lyrics is required
    const err = await again.c.generate({ model: 'm', prompt: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as Error).message).toContain('lyrics is required');
  });

  it('HTTP 出错时也按 base_resp 报：接口不再开放给新用户时说清楚', async () => {
    const { c } = await client({
      musicError: { code: 2153, message: 'This Music API is no longer available to new users.', http: 410 },
    });
    const err = (await c.generate({ model: 'm', prompt: 'x', instrumental: true }).catch((e: unknown) => e)) as ProviderError;
    expect(err.message).toMatch(/^接口返回错误（2153）：This Music API is no longer available to new users\.（MiniMax 的音乐接口已经不对新用户开放/);
    expect(err.status).toBe(410);
    expect(err.retryable).toBe(false);
  });

  it('限流类的错误码可以重试，其余的不行', async () => {
    const { c } = await client({ musicError: { code: 1002, message: 'rate limit' } });
    const err = (await c.generate({ model: 'm', prompt: 'x', instrumental: true }).catch((e: unknown) => e)) as ProviderError;
    expect(err.retryable).toBe(true);
  });

  it('认音频格式', () => {
    expect(sniffAudio(mockMusic('x'))).toBe('audio/wav');
    expect(sniffAudio(new TextEncoder().encode('ID3\u0004\u0000'))).toBe('audio/mpeg');
    expect(sniffAudio(new Uint8Array([0xff, 0xfb, 0x90, 0x00]))).toBe('audio/mpeg');
    expect(sniffAudio(new TextEncoder().encode('OggS\u0000\u0002'))).toBe('audio/ogg');
    expect(sniffAudio(new TextEncoder().encode('fLaC\u0000'))).toBe('audio/flac');
    expect(sniffAudio(new TextEncoder().encode('<html>'))).toBeNull();
    expect(audioMimeOf('紧张/追逐.OPUS')).toBe('audio/ogg');
    expect(audioMimeOf('cover.jpg')).toBeNull();
    const wav = encodeWav(new Float32Array(8000), 8000);
    expect(wavDurationMs(wav)).toBe(1000);
  });
});
