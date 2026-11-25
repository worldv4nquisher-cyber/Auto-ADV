import { sniffAudio } from './audio.ts';
import { describeHttpError, isRetryableStatus, normalizeBaseURL, parseRetryAfter, ProviderError } from './openai-compatible.ts';
import type { FetchLike } from './types.ts';

/** 一次音乐生成请求。 */
export interface MusicRequest {
  model: string;
  /** 风格、情绪、乐器、场景的描述。 */
  prompt: string;
  /** 只要纯音乐，不要人声（MiniMax 的 is_instrumental）。 */
  instrumental?: boolean;
  /** 歌词（要人声时才写）。 */
  lyrics?: string;
  /** 输出格式，默认 mp3。 */
  format?: 'mp3' | 'wav' | 'pcm';
  /** 透传给接口的额外字段。 */
  extra?: Record<string, unknown>;
}

export interface MusicResult {
  data: Uint8Array;
  /** audio/mpeg、audio/wav…… */
  mime: string;
  /** 服务端报告的时长（毫秒）；没报告时为 null。 */
  durationMs: number | null;
  latencyMs: number;
}

/** 每次 HTTP 尝试结束后的记录，用于调用日志。不含密钥，也不含音频本身。 */
export interface MusicExchangeRecord {
  kind: 'music';
  url: string;
  request: Record<string, unknown>;
  status: 'ok' | 'error' | 'aborted';
  httpStatus: number | null;
  error: string | null;
  /** 返回的音频大小（字节）和时长（毫秒）。 */
  bytes: number;
  durationMs: number | null;
  startedAt: number;
  latencyMs: number;
  attempt: number;
}

export interface MusicClientConfig {
  /** 和文本接口一样的 Base URL，例如 https://api.minimaxi.com/v1。 */
  baseURL: string;
  apiKey?: string;
  headers?: Record<string, string>;
  fetch?: FetchLike;
  /** 等待响应的最长时间，默认 300 秒（一首一两分钟的曲子要生成好一会儿）。 */
  timeoutMs?: number;
  onExchange?: (record: MusicExchangeRecord) => void;
}

/** MiniMax 的错误码里可以等一会儿再试的：未知错误、超时、限流。 */
const RETRYABLE_CODES = new Set([1000, 1001, 1002]);

/** 认得的错误码补一句该怎么办。 */
function hintOf(code: number, msg: string, instrumental: boolean | undefined): string {
  if (code === 2153 || /no longer available/i.test(msg)) {
    return '（MiniMax 的音乐接口已经不对新用户开放，这个账号用不了；BGM 可以改用本地曲库或内置曲库）';
  }
  if (instrumental && /lyric/i.test(msg)) return '（这个模型可能不支持只要纯音乐，换一个支持 is_instrumental 的模型试试）';
  return '';
}

function baseRespOf(text: string): { code: number; msg: string } | null {
  try {
    const j = JSON.parse(text) as { base_resp?: { status_code?: unknown; status_msg?: unknown } };
    const code = j.base_resp?.status_code;
    return typeof code === 'number' && code !== 0 ? { code, msg: typeof j.base_resp?.status_msg === 'string' ? j.base_resp.status_msg : '' } : null;
  } catch {
    return null;
  }
}

function baseRespError(code: number, msg: string, o: { body: string; status?: number; instrumental?: boolean | undefined }): ProviderError {
  return new ProviderError(`接口返回错误（${code}）：${msg || '未知错误'}${hintOf(code, msg, o.instrumental)}`, {
    body: o.body,
    ...(o.status ? { status: o.status } : {}),
    retryable: RETRYABLE_CODES.has(code),
  });
}

/**
 * MiniMax 的音乐生成接口（18.7、18.9）：POST <Base URL>/music_generation，
 * 返回 data.audio（hex 编码的音频，或者 output_format 为 url 时的下载链接）和 extra_info.music_duration（毫秒）。
 * 错误在 HTTP 200 的 base_resp 里（status_code 不为 0）。
 * 重试交给调用方（素材队列按自己的设置退避重试），这里每次调用只发一次请求。
 */
export class MiniMaxMusicClient {
  readonly url: string;
  private readonly apiKey: string | undefined;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly onExchange: ((r: MusicExchangeRecord) => void) | undefined;

  constructor(cfg: MusicClientConfig) {
    this.url = `${normalizeBaseURL(cfg.baseURL).replace(/\/music_generation$/, '')}/music_generation`;
    this.apiKey = cfg.apiKey || undefined;
    this.headers = cfg.headers ?? {};
    this.fetchImpl = cfg.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = cfg.timeoutMs ?? 300_000;
    this.onExchange = cfg.onExchange;
  }

  bodyOf(req: MusicRequest): Record<string, unknown> {
    const format = req.format ?? 'mp3';
    return {
      model: req.model,
      prompt: req.prompt,
      ...(req.instrumental ? { is_instrumental: true } : {}),
      ...(req.lyrics ? { lyrics: req.lyrics } : {}),
      stream: false,
      output_format: 'hex',
      audio_setting: { sample_rate: 44100, bitrate: 128000, format },
      ...req.extra,
    };
  }

  async generate(req: MusicRequest, signal?: AbortSignal): Promise<MusicResult> {
    const body = this.bodyOf(req);
    const startedAt = Date.now();
    let httpStatus: number | null = null;
    const log = (status: MusicExchangeRecord['status'], error: string | null, result?: MusicResult) => {
      try {
        this.onExchange?.({
          kind: 'music',
          url: this.url,
          request: body,
          status,
          httpStatus,
          error,
          bytes: result?.data.length ?? 0,
          durationMs: result?.durationMs ?? null,
          startedAt,
          latencyMs: Date.now() - startedAt,
          attempt: 1,
        });
      } catch {
        // 日志出错不影响调用
      }
    };
    try {
      const res = await this.send(this.url, { method: 'POST', body: JSON.stringify(body), auth: true, instrumental: req.instrumental }, signal);
      httpStatus = res.status;
      const text = await res.text();
      let json: {
        data?: { audio?: string; status?: number } | null;
        extra_info?: { music_duration?: number };
        base_resp?: { status_code?: number; status_msg?: string };
      };
      try {
        json = JSON.parse(text) as typeof json;
      } catch {
        throw new ProviderError(`接口返回的不是 JSON：${text.slice(0, 200)}`, { status: res.status, body: text });
      }
      const code = json.base_resp?.status_code;
      if (code) throw baseRespError(code, json.base_resp?.status_msg ?? '', { body: text, instrumental: req.instrumental });
      const audio = json.data?.audio?.trim();
      let data: Uint8Array;
      if (audio && /^https?:\/\//.test(audio)) {
        const file = await this.send(audio, { method: 'GET', auth: false }, signal);
        data = new Uint8Array(await file.arrayBuffer());
      } else if (audio && /^(?:[0-9a-f]{2})+$/i.test(audio)) {
        data = Uint8Array.from(Buffer.from(audio, 'hex'));
      } else {
        throw new ProviderError(
          json.data?.status === 1 ? '接口说音乐还在生成，没有返回音频' : `接口没有返回音频：${text.slice(0, 200)}`,
          { body: text, retryable: json.data?.status === 1 },
        );
      }
      const mime = sniffAudio(data);
      if (!mime) throw new ProviderError('返回的内容不是认得出的音频（MP3、WAV、Ogg、FLAC）');
      const duration = json.extra_info?.music_duration;
      const result: MusicResult = {
        data,
        mime,
        durationMs: typeof duration === 'number' && duration > 0 ? Math.round(duration) : null,
        latencyMs: Date.now() - startedAt,
      };
      log('ok', null, result);
      return result;
    } catch (err) {
      const pe = err instanceof ProviderError ? err : new ProviderError(String(err), { cause: err });
      log(pe.aborted ? 'aborted' : 'error', pe.message);
      throw pe;
    }
  }

  private async send(
    url: string,
    init: { method: string; body?: string; auth: boolean; instrumental?: boolean | undefined },
    signal?: AbortSignal,
  ): Promise<Response> {
    if (signal?.aborted) throw new ProviderError('已取消', { aborted: true });
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, this.timeoutMs);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const headers: Record<string, string> = init.auth ? { 'Content-Type': 'application/json', Accept: 'application/json', ...this.headers } : {};
      if (init.auth && this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
      let res: Response;
      try {
        res = await this.fetchImpl(url, { method: init.method, headers, body: init.body, signal: ctrl.signal });
      } catch (err) {
        if (signal?.aborted) throw new ProviderError('已取消', { aborted: true });
        if (timedOut) throw new ProviderError(`等待音乐超过 ${Math.round(this.timeoutMs / 1000)} 秒`, { retryable: true, cause: err });
        const code = (err as { cause?: { code?: string } }).cause?.code;
        throw new ProviderError(`无法连接到 ${new URL(url).host}${code ? `（${code}）` : ''}`, { retryable: true, cause: err });
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // 有的错误（比如接口不再开放）是 HTTP 4xx 加 base_resp：按错误码报，比一大段原文好懂
        const base = init.auth ? baseRespOf(text) : null;
        if (base) throw baseRespError(base.code, base.msg, { body: text, status: res.status, instrumental: init.instrumental });
        throw new ProviderError(describeHttpError(res.status, text), {
          status: res.status,
          body: text,
          retryable: isRetryableStatus(res.status),
          retryAfterMs: parseRetryAfter(res),
        });
      }
      return res;
    } finally {
      clearTimeout(timer);
    }
  }
}

