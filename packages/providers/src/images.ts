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
  /** 要透明背景（OpenAI 风格接口的 background: "transparent"）。服务不认识这个字段时自动去掉重发。 */
  transparent?: boolean;
}

/** 带参考图改图（/images/edits）。 */
export interface ImageEditRequest extends ImageRequest {
  image: { data: Uint8Array; mime: string };
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

/** 服务端不认识时可以去掉重发的字段（不同服务支持的字段不一样）。 */
const DROPPABLE = ['response_format', 'background'] as const;

/** 服务端因为某个字段报 400 / 422 时，找出是哪个可以去掉的字段。 */
function droppableField(err: unknown, body: Record<string, unknown>): string | null {
  if (!(err instanceof ProviderError) || (err.status !== 400 && err.status !== 422)) return null;
  return DROPPABLE.find((k) => k in body && err.body.includes(k)) ?? null;
}

/**
 * OpenAI 风格的图像接口：/images/generations 文生图，/images/edits 带参考图改图（multipart 上传 image）。
 * 返回 b64_json 或 url 都支持；返回链接时马上下载（MiniMax 的链接 24 小时就失效）。
 * 重试交给调用方（素材队列按自己的设置退避重试），这里每次调用只发一次请求；
 * 只有服务端说不认识 response_format、background 这类字段时，去掉它再发。
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

  private bodyOf(req: ImageRequest): Record<string, unknown> {
    return {
      model: req.model,
      prompt: req.prompt,
      n: 1,
      ...(req.size ? { size: req.size } : {}),
      response_format: 'b64_json',
      ...(req.transparent ? { background: 'transparent' } : {}),
      ...req.extra,
    };
  }

  async generate(req: ImageRequest, signal?: AbortSignal): Promise<ImageResult> {
    return this.withDrops(this.bodyOf(req), (body, attempt) => this.once(`${this.baseURL}/images/generations`, body, attempt, signal));
  }

  /** 带参考图改图：multipart 上传参考图和其余字段。 */
  async edit(req: ImageEditRequest, signal?: AbortSignal): Promise<ImageResult> {
    return this.withDrops(this.bodyOf(req), (body, attempt) => {
      const form = new FormData();
      for (const [k, v] of Object.entries(body)) form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
      const ext = IMAGE_EXT[req.image.mime] ?? 'png';
      form.append('image', new Blob([new Uint8Array(req.image.data)], { type: req.image.mime }), `image.${ext}`);
      return this.once(`${this.baseURL}/images/edits`, body, attempt, signal, form, req.image.data.length);
    });
  }

  /** 服务端不认识某个字段时去掉它再发（每个字段最多去一次）。 */
  private async withDrops(
    first: Record<string, unknown>,
    run: (body: Record<string, unknown>, attempt: number) => Promise<ImageResult>,
  ): Promise<ImageResult> {
    let body = first;
    for (let attempt = 1; ; attempt++) {
      try {
        return await run(body, attempt);
      } catch (err) {
        const drop = attempt <= DROPPABLE.length ? droppableField(err, body) : null;
        if (!drop) throw err;
        const { [drop]: _drop, ...rest } = body;
        body = rest;
      }
    }
  }

  private async once(
    url: string,
    body: Record<string, unknown>,
    attempt: number,
    signal?: AbortSignal,
    form?: FormData,
    imageBytes?: number,
  ): Promise<ImageResult> {
    const startedAt = Date.now();
    let httpStatus: number | null = null;
    const log = (status: ImageExchangeRecord['status'], error: string | null, result?: ImageResult) => {
      try {
        this.onExchange?.({
          kind: 'image',
          url,
          request: imageBytes !== undefined ? { ...body, image: `参考图 ${Math.round(imageBytes / 1024)} KB` } : body,
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
      const res = await this.send(url, { method: 'POST', body: form ?? JSON.stringify(body), auth: true }, signal);
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

  private async send(url: string, init: { method: string; body?: string | FormData; auth: boolean }, signal?: AbortSignal): Promise<Response> {
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
      // multipart 的 Content-Type（带 boundary）交给 fetch 自己填
      const headers: Record<string, string> = init.auth
        ? { ...(typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}), Accept: 'application/json', ...this.headers }
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

// ───────────── 抠图服务 ─────────────

export interface CutoutClientConfig {
  /** 服务地址，例如 http://127.0.0.1:7000（rembg s 默认的端口）。写成完整的 …/api/remove 也行。 */
  baseURL: string;
  apiKey?: string;
  headers?: Record<string, string>;
  fetch?: FetchLike;
  timeoutMs?: number;
  onExchange?: (record: ImageExchangeRecord) => void;
}

/**
 * 抠图服务（18.5 的第 3 种做法）。接口和 rembg 自带的 HTTP 服务一样：
 * POST <地址>/api/remove，multipart 上传 file（可以带 model），返回抠好的 PNG。
 * 别的抠图服务等通用 HTTP 适配器（18.9，第 6 步）。
 */
export class RembgCutoutClient {
  readonly url: string;
  private readonly apiKey: string | undefined;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly onExchange: ((r: ImageExchangeRecord) => void) | undefined;

  constructor(cfg: CutoutClientConfig) {
    const base = cfg.baseURL.trim().replace(/\/+$/, '').replace(/\/api\/remove$/, '');
    this.url = `${base}/api/remove`;
    this.apiKey = cfg.apiKey || undefined;
    this.headers = cfg.headers ?? {};
    this.fetchImpl = cfg.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = cfg.timeoutMs ?? 120_000;
    this.onExchange = cfg.onExchange;
  }

  async remove(image: { data: Uint8Array; mime: string }, model: string, signal?: AbortSignal): Promise<ImageResult> {
    const startedAt = Date.now();
    const request = { model, file: `图片 ${Math.round(image.data.length / 1024)} KB` };
    let httpStatus: number | null = null;
    const log = (status: ImageExchangeRecord['status'], error: string | null, bytes = 0) => {
      try {
        this.onExchange?.({
          kind: 'image',
          url: this.url,
          request,
          status,
          httpStatus,
          error,
          revisedPrompt: null,
          bytes,
          startedAt,
          latencyMs: Date.now() - startedAt,
          attempt: 1,
        });
      } catch {
        // 日志出错不影响调用
      }
    };
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
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(image.data)], { type: image.mime }), `image.${IMAGE_EXT[image.mime] ?? 'png'}`);
      if (model.trim()) form.append('model', model.trim());
      const headers: Record<string, string> = { ...this.headers };
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
      let res: Response;
      try {
        res = await this.fetchImpl(this.url, { method: 'POST', headers, body: form, signal: ctrl.signal });
      } catch (err) {
        if (signal?.aborted) throw new ProviderError('已取消', { aborted: true });
        if (timedOut) throw new ProviderError(`抠图超过 ${Math.round(this.timeoutMs / 1000)} 秒`, { retryable: true, cause: err });
        throw new ProviderError(`无法连接到抠图服务 ${new URL(this.url).host}`, { retryable: true, cause: err });
      }
      httpStatus = res.status;
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new ProviderError(describeHttpError(res.status, text), {
          status: res.status,
          body: text,
          retryable: isRetryableStatus(res.status),
          retryAfterMs: parseRetryAfter(res),
        });
      }
      const data = new Uint8Array(await res.arrayBuffer());
      const mime = sniffImage(data);
      if (!mime) throw new ProviderError('抠图服务返回的不是图片');
      log('ok', null, data.length);
      return { data, mime, revisedPrompt: null, latencyMs: Date.now() - startedAt };
    } catch (err) {
      const pe = err instanceof ProviderError ? err : new ProviderError(String(err), { cause: err });
      log(pe.aborted ? 'aborted' : 'error', pe.message);
      throw pe;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}
