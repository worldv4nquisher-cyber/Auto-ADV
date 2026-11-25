import { sniffAudio } from './audio.ts';
import { describeHttpError, isRetryableStatus, normalizeBaseURL, parseRetryAfter, ProviderError } from './openai-compatible.ts';
import type { FetchLike } from './types.ts';

/**
 * 语音合成（TTS，18.8）：把一句台词念出来。
 * 内置两种接口：OpenAI 风格（POST /audio/speech，返回音频文件）和 MiniMax（POST /t2a_v2，返回 hex）；
 * 别的服务用自定义接口（custom.ts 的 CustomSpeechClient）。
 */

/** 一次语音请求。 */
export interface SpeechRequest {
  model: string;
  text: string;
  /** 音色 id。 */
  voice: string;
  /** 语速，1 是正常。 */
  speed?: number;
  /** 情绪（MiniMax 的 emotion：happy、sad、angry、fearful、disgusted、surprised、calm）。 */
  emotion?: string;
}

export interface SpeechResult {
  data: Uint8Array;
  /** audio/mpeg、audio/wav…… */
  mime: string;
  /** 服务端报告的时长（毫秒）；没报告时为 null（播放时按文件算）。 */
  durationMs: number | null;
  latencyMs: number;
}

/** 每次调用结束后的记录，用于调用日志。不含密钥，也不含音频本身。 */
export interface VoiceExchangeRecord {
  kind: 'voice';
  url: string;
  request: Record<string, unknown>;
  status: 'ok' | 'error' | 'aborted';
  httpStatus: number | null;
  error: string | null;
  bytes: number;
  durationMs: number | null;
  startedAt: number;
  latencyMs: number;
  attempt: number;
}

export interface SpeechClientConfig {
  baseURL: string;
  apiKey?: string;
  headers?: Record<string, string>;
  fetch?: FetchLike;
  /** 等待响应的最长时间，默认 60 秒。 */
  timeoutMs?: number;
  onExchange?: (record: VoiceExchangeRecord) => void;
}

/** 语音服务的音色（分配音色、设置页列表用）。 */
export interface SpeechVoice {
  id: string;
  name: string;
  description: string;
}

/** OpenAI 的内置音色（gpt-4o-mini-tts、tts-1 共用的那些；ballad、verse 只有 gpt-4o-mini-tts 有）。 */
export const OPENAI_VOICES: SpeechVoice[] = [
  { id: 'alloy', name: 'Alloy', description: '中性' },
  { id: 'ash', name: 'Ash', description: '男声' },
  { id: 'ballad', name: 'Ballad', description: '男声（只有 gpt-4o-mini-tts）' },
  { id: 'coral', name: 'Coral', description: '女声' },
  { id: 'echo', name: 'Echo', description: '男声' },
  { id: 'fable', name: 'Fable', description: '男声，英式口音' },
  { id: 'nova', name: 'Nova', description: '女声' },
  { id: 'onyx', name: 'Onyx', description: '男声，低沉' },
  { id: 'sage', name: 'Sage', description: '女声' },
  { id: 'shimmer', name: 'Shimmer', description: '女声' },
  { id: 'verse', name: 'Verse', description: '男声（只有 gpt-4o-mini-tts）' },
];

/** 发一次请求：超时、取消、连不上、HTTP 错误都变成 ProviderError。 */
async function send(
  fetchImpl: FetchLike,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onHttpError?: (status: number, text: string) => ProviderError | null,
): Promise<Response> {
  if (signal?.aborted) throw new ProviderError('已取消', { aborted: true });
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    let res: Response;
    try {
      res = await fetchImpl(url, { ...init, signal: ctrl.signal });
    } catch (err) {
      if (signal?.aborted) throw new ProviderError('已取消', { aborted: true });
      if (timedOut) throw new ProviderError(`等待语音超过 ${Math.round(timeoutMs / 1000)} 秒`, { retryable: true, cause: err });
      const code = (err as { cause?: { code?: string } }).cause?.code;
      throw new ProviderError(`无法连接到 ${new URL(url).host}${code ? `（${code}）` : ''}`, { retryable: true, cause: err });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw (
        onHttpError?.(res.status, text) ??
        new ProviderError(describeHttpError(res.status, text), {
          status: res.status,
          body: text,
          retryable: isRetryableStatus(res.status),
          retryAfterMs: parseRetryAfter(res),
        })
      );
    }
    return res;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

abstract class SpeechBase {
  readonly baseURL: string;
  protected readonly apiKey: string | undefined;
  protected readonly headers: Record<string, string>;
  protected readonly fetchImpl: FetchLike;
  protected readonly timeoutMs: number;
  protected readonly onExchange: ((r: VoiceExchangeRecord) => void) | undefined;

  constructor(cfg: SpeechClientConfig) {
    this.baseURL = normalizeBaseURL(cfg.baseURL);
    this.apiKey = cfg.apiKey || undefined;
    this.headers = cfg.headers ?? {};
    this.fetchImpl = cfg.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = cfg.timeoutMs ?? 60_000;
    this.onExchange = cfg.onExchange;
  }

  protected authHeaders(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', ...this.headers };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  /** 记一次调用（日志出错不影响调用）。 */
  protected log(
    url: string,
    request: Record<string, unknown>,
    startedAt: number,
    status: VoiceExchangeRecord['status'],
    httpStatus: number | null,
    error: string | null,
    result?: SpeechResult,
  ) {
    try {
      this.onExchange?.({
        kind: 'voice',
        url,
        request,
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
  }

  abstract speak(req: SpeechRequest, signal?: AbortSignal): Promise<SpeechResult>;
}

function audioOf(data: Uint8Array): string {
  const mime = sniffAudio(data);
  if (!mime) throw new ProviderError('语音接口返回的不是认得出的音频（MP3、WAV、Ogg、FLAC、M4A）');
  return mime;
}

/**
 * OpenAI 风格的语音接口：POST <Base URL>/audio/speech，{ model, input, voice, speed, response_format }，返回音频文件。
 * 不支持情绪（gpt-4o-mini-tts 的 instructions 以后可以加）。
 */
export class OpenAISpeechClient extends SpeechBase {
  get url() {
    return `${this.baseURL.replace(/\/audio\/speech$/, '')}/audio/speech`;
  }

  bodyOf(req: SpeechRequest): Record<string, unknown> {
    return {
      model: req.model,
      input: req.text,
      voice: req.voice,
      response_format: 'mp3',
      ...(req.speed && req.speed !== 1 ? { speed: req.speed } : {}),
    };
  }

  async speak(req: SpeechRequest, signal?: AbortSignal): Promise<SpeechResult> {
    const body = this.bodyOf(req);
    const startedAt = Date.now();
    let httpStatus: number | null = null;
    try {
      const res = await send(this.fetchImpl, this.url, { method: 'POST', headers: this.authHeaders(), body: JSON.stringify(body) }, this.timeoutMs, signal);
      httpStatus = res.status;
      const data = new Uint8Array(await res.arrayBuffer());
      const result: SpeechResult = { data, mime: audioOf(data), durationMs: null, latencyMs: Date.now() - startedAt };
      this.log(this.url, body, startedAt, 'ok', httpStatus, null, result);
      return result;
    } catch (err) {
      const pe = err instanceof ProviderError ? err : new ProviderError(String(err), { cause: err });
      this.log(this.url, body, startedAt, pe.aborted ? 'aborted' : 'error', httpStatus ?? pe.status ?? null, pe.message);
      throw pe;
    }
  }
}

/** MiniMax 的错误码里可以等一会儿再试的：未知错误、超时、限流。 */
const RETRYABLE_CODES = new Set([1000, 1001, 1002]);

interface BaseResp {
  base_resp?: { status_code?: number; status_msg?: string };
}

function minimaxError(code: number, msg: string, body: string, status?: number): ProviderError {
  return new ProviderError(`接口返回错误（${code}）：${msg || '未知错误'}`, {
    body,
    ...(status ? { status } : {}),
    retryable: RETRYABLE_CODES.has(code),
  });
}

function baseRespOf(text: string): { code: number; msg: string } | null {
  try {
    const j = JSON.parse(text) as BaseResp;
    const code = j.base_resp?.status_code;
    return typeof code === 'number' && code !== 0 ? { code, msg: j.base_resp?.status_msg ?? '' } : null;
  } catch {
    return null;
  }
}

/**
 * MiniMax 的语音接口：POST <Base URL>/t2a_v2，返回 data.audio（hex 编码的音频）和 extra_info.audio_length（毫秒）。
 * 错误在 base_resp 里（status_code 不为 0）。模型不支持情绪时去掉 emotion 再发一次。
 * 音色列表：POST <Base URL>/get_voice，{ voice_type: "system" }。
 */
export class MiniMaxSpeechClient extends SpeechBase {
  get url() {
    return `${this.baseURL.replace(/\/t2a_v2$/, '')}/t2a_v2`;
  }

  bodyOf(req: SpeechRequest): Record<string, unknown> {
    return {
      model: req.model,
      text: req.text,
      stream: false,
      voice_setting: {
        voice_id: req.voice,
        speed: req.speed ?? 1,
        vol: 1,
        pitch: 0,
        ...(req.emotion ? { emotion: req.emotion } : {}),
      },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
      output_format: 'hex',
    };
  }

  async speak(req: SpeechRequest, signal?: AbortSignal): Promise<SpeechResult> {
    try {
      return await this.once(req, signal);
    } catch (err) {
      // 有的模型不认 emotion（或者不认这个情绪）：去掉再试一次
      if (req.emotion && err instanceof ProviderError && !err.aborted && /emotion/i.test(`${err.message} ${err.body}`)) {
        const { emotion: _e, ...rest } = req;
        return this.once(rest, signal);
      }
      throw err;
    }
  }

  private async once(req: SpeechRequest, signal?: AbortSignal): Promise<SpeechResult> {
    const body = this.bodyOf(req);
    const startedAt = Date.now();
    let httpStatus: number | null = null;
    try {
      const res = await send(
        this.fetchImpl,
        this.url,
        { method: 'POST', headers: this.authHeaders(), body: JSON.stringify(body) },
        this.timeoutMs,
        signal,
        (status, text) => {
          const b = baseRespOf(text);
          return b ? minimaxError(b.code, b.msg, text, status) : null;
        },
      );
      httpStatus = res.status;
      const text = await res.text();
      let json: BaseResp & { data?: { audio?: string } | null; extra_info?: { audio_length?: number } };
      try {
        json = JSON.parse(text) as typeof json;
      } catch {
        throw new ProviderError(`接口返回的不是 JSON：${text.slice(0, 200)}`, { status: res.status, body: text });
      }
      const code = json.base_resp?.status_code;
      if (code) throw minimaxError(code, json.base_resp?.status_msg ?? '', text);
      const audio = json.data?.audio?.trim() ?? '';
      if (!/^(?:[0-9a-f]{2})+$/i.test(audio)) throw new ProviderError(`接口没有返回音频：${text.slice(0, 200)}`, { body: text });
      const data = Uint8Array.from(Buffer.from(audio, 'hex'));
      const len = json.extra_info?.audio_length;
      const result: SpeechResult = {
        data,
        mime: audioOf(data),
        durationMs: typeof len === 'number' && len > 0 ? Math.round(len) : null,
        latencyMs: Date.now() - startedAt,
      };
      this.log(this.url, body, startedAt, 'ok', httpStatus, null, result);
      return result;
    } catch (err) {
      const pe = err instanceof ProviderError ? err : new ProviderError(String(err), { cause: err });
      this.log(this.url, body, startedAt, pe.aborted ? 'aborted' : 'error', httpStatus ?? pe.status ?? null, pe.message);
      throw pe;
    }
  }

  /** 服务上的系统音色。 */
  async voices(signal?: AbortSignal): Promise<SpeechVoice[]> {
    const url = `${this.baseURL.replace(/\/t2a_v2$/, '')}/get_voice`;
    const res = await send(this.fetchImpl, url, { method: 'POST', headers: this.authHeaders(), body: JSON.stringify({ voice_type: 'system' }) }, this.timeoutMs, signal);
    const text = await res.text();
    let json: BaseResp & { system_voice?: { voice_id?: string; voice_name?: string; description?: string[] | string }[] | null };
    try {
      json = JSON.parse(text) as typeof json;
    } catch {
      throw new ProviderError(`接口返回的不是 JSON：${text.slice(0, 200)}`, { status: res.status, body: text });
    }
    const code = json.base_resp?.status_code;
    if (code) throw minimaxError(code, json.base_resp?.status_msg ?? '', text);
    return (json.system_voice ?? [])
      .filter((v) => typeof v.voice_id === 'string' && v.voice_id)
      .map((v) => ({
        id: v.voice_id as string,
        name: v.voice_name ?? v.voice_id ?? '',
        description: Array.isArray(v.description) ? v.description.join('；') : (v.description ?? ''),
      }));
  }
}
