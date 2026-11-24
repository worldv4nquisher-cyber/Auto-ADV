import { describeHttpError, isRetryableStatus, normalizeBaseURL, parseRetryAfter, ProviderError } from './openai-compatible.ts';
import type { FetchLike } from './types.ts';

/** 一次图像请求。 */
export interface ImageRequest {
  model: string;
  prompt: string;
  /** 宽x高，例如 1536x1024。 */
  size?: string;
  /** 透传给接口的额外字段。 */
  extra?: Record<string, unknown>;
}

export interface ImageResult {
  data: Uint8Array;
  /** image/png、image/jpeg、image/webp。 */
  mime: string;
  /** 服务端改写后的提示词（有的服务会返回）。 */
  revisedPrompt: string | null;
  latencyMs: number;
}

/** 每次 HTTP 尝试结束后的记录，用于调用日志。不含密钥，也不含图片本身。 */
export interface ImageExchangeRecord {
  kind: 'image';
  url: string;
  request: Record<string, unknown>;
  status: 'ok' | 'error' | 'aborted';
  httpStatus: number | null;
  error: string | null;
  revisedPrompt: string | null;
  /** 返回的图片大小（字节）。 */
  bytes: number;
  startedAt: number;
  latencyMs: number;
  attempt: number;
}

export interface ImageClientConfig {
  baseURL: string;
  apiKey?: string;
  headers?: Record<string, string>;
  fetch?: FetchLike;
  /** 等待响应的最长时间，默认 180 秒（一张图通常要 10～60 秒）。 */
  timeoutMs?: number;
  onExchange?: (record: ImageExchangeRecord) => void;
}

/** 按文件头认出图片格式。 */
export function sniffImage(data: Uint8Array): string | null {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (
    data.length >= 12 &&
    String.fromCharCode(...data.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...data.subarray(8, 12)) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

export const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/**
 * OpenAI 风格的图像接口（/images/generations）。
 * 返回 b64_json 或 url 都支持；返回链接时马上下载（MiniMax 的链接 24 小时就失效）。
 * 重试交给调用方（素材队列按自己的设置退避重试），这里每次调用只发一次请求；
 * 只有服务端说不认识 response_format 时，去掉它再发一次。
 */
export class OpenAIImageClient {
  readonly baseURL: string;
  private readonly apiKey: string | undefined;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly onExchange: ((r: ImageExchangeRecord) => void) | undefined;

  constructor(cfg: ImageClientConfig) {
    this.baseURL = normalizeBaseURL(cfg.baseURL);
    this.apiKey = cfg.apiKey || undefined;
    this.headers = cfg.headers ?? {};
    this.fetchImpl = cfg.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = cfg.timeoutMs ?? 180_000;
    this.onExchange = cfg.onExchange;
  }

  async generate(req: ImageRequest, signal?: AbortSignal): Promise<ImageResult> {
    let body: Record<string, unknown> = {
      model: req.model,
      prompt: req.prompt,
      n: 1,
      ...(req.size ? { size: req.size } : {}),
      response_format: 'b64_json',
      ...req.extra,
    };
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.once(`${this.baseURL}/images/generations`, body, attempt, signal);
      } catch (err) {
        if (
          attempt === 1 &&
          err instanceof ProviderError &&
          (err.status === 400 || err.status === 422) &&
          err.body.includes('response_format') &&
          'response_format' in body
        ) {
          const { response_format: _drop, ...rest } = body;
          body = rest;
          continue;
        }
        throw err;
      }
    }
  }

  private async once(url: string, body: Record<string, unknown>, attempt: number, signal?: AbortSignal): Promise<ImageResult> {
    const startedAt = Date.now();
    let httpStatus: number | null = null;
    const log = (status: ImageExchangeRecord['status'], error: string | null, result?: ImageResult) => {
      try {
        this.onExchange?.({
          kind: 'image',
          url,
          request: body,
          status,
          httpStatus,
          error,
          revisedPrompt: result?.revisedPrompt ?? null,
          bytes: result?.data.length ?? 0,
          startedAt,
          latencyMs: Date.now() - startedAt,
          attempt,
        });
      } catch {
        // 日志出错不影响调用
      }
    };
    try {
      const res = await this.send(url, { method: 'POST', body: JSON.stringify(body), auth: true }, signal);
      httpStatus = res.status;
      const text = await res.text();
      let json: { data?: { b64_json?: string; url?: string; revised_prompt?: string }[]; error?: unknown; base_resp?: { status_code?: number; status_msg?: string } };
      try {
        json = JSON.parse(text) as typeof json;
      } catch {
        throw new ProviderError(`接口返回的不是 JSON：${text.slice(0, 200)}`, { status: res.status, body: text });
      }
      if (json.base_resp && json.base_resp.status_code && json.base_resp.status_code !== 0) {
        throw new ProviderError(`接口返回错误：${json.base_resp.status_msg ?? json.base_resp.status_code}`, { body: text });
      }
      const item = json.data?.[0];
      let data: Uint8Array;
      if (item?.b64_json) {
        data = Uint8Array.from(Buffer.from(item.b64_json, 'base64'));
      } else if (item?.url) {
        const img = await this.send(item.url, { method: 'GET', auth: false }, signal);
        data = new Uint8Array(await img.arrayBuffer());
      } else {
        throw new ProviderError(`接口没有返回图片：${text.slice(0, 200)}`, { body: text });
      }
      const mime = sniffImage(data);
      if (!mime) throw new ProviderError('返回的内容不是 PNG、JPEG 或 WebP 图片');
      const result: ImageResult = { data, mime, revisedPrompt: item.revised_prompt ?? null, latencyMs: Date.now() - startedAt };
      log('ok', null, result);
      return result;
    } catch (err) {
      const pe = err instanceof ProviderError ? err : new ProviderError(String(err), { cause: err });
      log(pe.aborted ? 'aborted' : 'error', pe.message);
      throw pe;
    }
  }

  private async send(url: string, init: { method: string; body?: string; auth: boolean }, signal?: AbortSignal): Promise<Response> {
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
      const headers: Record<string, string> = init.auth
        ? { 'Content-Type': 'application/json', Accept: 'application/json', ...this.headers }
        : {};
      if (init.auth && this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
      let res: Response;
      try {
        res = await this.fetchImpl(url, { method: init.method, headers, body: init.body, signal: ctrl.signal });
      } catch (err) {
        if (signal?.aborted) throw new ProviderError('已取消', { aborted: true });
        if (timedOut) throw new ProviderError(`等待图片超过 ${Math.round(this.timeoutMs / 1000)} 秒`, { retryable: true, cause: err });
        const code = (err as { cause?: { code?: string } }).cause?.code;
        throw new ProviderError(`无法连接到 ${new URL(url).host}${code ? `（${code}）` : ''}`, { retryable: true, cause: err });
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new ProviderError(describeHttpError(res.status, text), {
          status: res.status,
          body: text,
          retryable: isRetryableStatus(res.status),
          retryAfterMs: parseRetryAfter(res),
        });
      }
      return res;
    } finally {
      // 不摘掉 onAbort：调用方中止时还要能打断后面读响应体
      clearTimeout(timer);
    }
  }
}
