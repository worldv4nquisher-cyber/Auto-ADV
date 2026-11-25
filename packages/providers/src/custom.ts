import type { CustomApi, CustomOperation } from '@auto-adv/schema';
import { sniffAudio } from './audio.ts';
import type { ImageEditRequest, ImageExchangeRecord, ImageRequest, ImageResult } from './images.ts';
import { IMAGE_EXT, sniffImage } from './images.ts';
import type { MusicExchangeRecord, MusicRequest, MusicResult } from './music.ts';
import type { SpeechRequest, SpeechResult, VoiceExchangeRecord } from './speech.ts';
import { describeHttpError, isRetryableStatus, normalizeBaseURL, parseRetryAfter, ProviderError } from './openai-compatible.ts';
import type { FetchLike } from './types.ts';

/**
 * 自定义接口（通用 HTTP 适配器，ARCHITECTURE.md 19.4）：按设置里写的请求模板发请求，按写好的位置从响应里取出文件。
 * 图像、抠图、音乐、语音各包一层（CustomImageClient、CustomCutoutClient、CustomMusicClient、CustomSpeechClient），
 * 和内置的接口类型用法一样。模板的写法见 @auto-adv/schema 的 custom-api.ts。
 */

/** 模板里能用的值。 */
export type TemplateVars = Record<string, string | number | boolean | null | undefined>;

/** 要上传的文件（multipart 里写成 "{{image}}" 的字段；JSON 里 {{image}} 是 base64）。 */
export interface TemplateFile {
  data: Uint8Array;
  mime: string;
  name: string;
}

export interface CustomClientConfig {
  baseURL: string;
  apiKey?: string;
  /** 接入点上配的额外请求头（模板里的请求头优先）。 */
  headers?: Record<string, string>;
  fetch?: FetchLike;
  /** 单次请求最长等多久（轮询时每次查询各算各的），默认 300 秒。 */
  timeoutMs?: number;
  /** 调用日志用：记成图像、音乐还是语音。 */
  kind: 'image' | 'music' | 'voice';
  onExchange?: (record: ImageExchangeRecord | MusicExchangeRecord | VoiceExchangeRecord) => void;
  /** 测试用：轮询的等待。 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface CustomResult {
  data: Uint8Array;
  latencyMs: number;
}

const WHOLE = /^\{\{\s*([A-Za-z_]\w*)\s*\}\}$/;
const ANY = /\{\{\s*([A-Za-z_]\w*)\s*\}\}/g;

function lookup(vars: TemplateVars, name: string): string | number | boolean | null {
  if (!(name in vars)) throw new ProviderError(`模板里的占位符 {{${name}}} 不认识`);
  return vars[name] ?? null;
}

/** 文字里的占位符换成值。 */
export function renderText(text: string, vars: TemplateVars): string {
  return text.replace(ANY, (_, name: string) => {
    const v = lookup(vars, name);
    return v === null ? '' : String(v);
  });
}

/** JSON 模板：整个字符串就是一个占位符时按原来的类型放，否则换成文字。 */
export function renderJson(value: unknown, vars: TemplateVars): unknown {
  if (typeof value === 'string') {
    const whole = WHOLE.exec(value);
    if (whole) return lookup(vars, whole[1] ?? '');
    return renderText(value, vars);
  }
  if (Array.isArray(value)) return value.map((v) => renderJson(v, vars));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, renderJson(v, vars)]));
  }
  return value;
}

/** 按位置取值：data.0.b64_json、data[0].url、output.audio 都行。 */
export function pick(value: unknown, path: string): unknown {
  const keys = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((k) => k.trim())
    .filter(Boolean);
  let cur: unknown = value;
  for (const k of keys) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) cur = cur[Number(k)];
    else if (typeof cur === 'object') cur = (cur as Record<string, unknown>)[k];
    else return undefined;
  }
  return cur;
}

function parseObject(text: string, what: string): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(text || '{}');
  } catch (err) {
    throw new ProviderError(`${what}不是合法的 JSON：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ProviderError(`${what}要写成 JSON 对象`);
  return v as Record<string, unknown>;
}

/** 日志里不放密钥和大段的 base64。 */
function scrub(value: unknown, secret: string | undefined): unknown {
  if (typeof value === 'string') {
    let s = secret ? value.split(secret).join('***') : value;
    if (s.length > 300) s = `${s.slice(0, 60)}…（共 ${s.length} 个字符）`;
    return s;
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, secret));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, scrub(v, secret)]));
  }
  return value;
}

function asText(v: unknown): string {
  if (v === undefined || v === null) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new ProviderError('已取消', { aborted: true }));
      },
      { once: true },
    );
  });

/** 按模板发请求、取结果。 */
export class CustomHttpClient {
  readonly baseURL: string;
  private readonly apiKey: string | undefined;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly kind: 'image' | 'music' | 'voice';
  private readonly onExchange: CustomClientConfig['onExchange'];
  private readonly sleep: NonNullable<CustomClientConfig['sleep']>;

  constructor(cfg: CustomClientConfig) {
    this.baseURL = normalizeBaseURL(cfg.baseURL);
    this.apiKey = cfg.apiKey || undefined;
    this.headers = cfg.headers ?? {};
    this.fetchImpl = cfg.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = cfg.timeoutMs ?? 300_000;
    this.kind = cfg.kind;
    this.onExchange = cfg.onExchange;
    this.sleep = cfg.sleep ?? defaultSleep;
  }

  /** 发一次（带轮询的话一直查到完成），返回文件的字节。 */
  async run(op: CustomOperation, vars: TemplateVars, files: Record<string, TemplateFile>, signal?: AbortSignal): Promise<CustomResult> {
    const startedAt = Date.now();
    const all: TemplateVars = { baseURL: this.baseURL, apiKey: this.apiKey ?? '', ...vars };
    for (const [name, f] of Object.entries(files)) {
      const b64 = Buffer.from(f.data).toString('base64');
      all[name] = b64;
      all[`${name}_base64`] = b64;
      all[`${name}_data_url`] = `data:${f.mime};base64,${b64}`;
      all[`${name}_mime`] = f.mime;
    }
    let url = '';
    let request: unknown = {};
    let httpStatus: number | null = null;
    const log = (status: 'ok' | 'error' | 'aborted', error: string | null, bytes = 0) => {
      try {
        const base = {
          url: this.apiKey ? url.split(this.apiKey).join('***') : url,
          request: scrub(request, this.apiKey) as Record<string, unknown>,
          status,
          httpStatus,
          error,
          bytes,
          startedAt,
          latencyMs: Date.now() - startedAt,
          attempt: 1,
        };
        this.onExchange?.(
          this.kind === 'image' ? { kind: 'image', ...base, revisedPrompt: null } : { kind: this.kind, ...base, durationMs: null },
        );
      } catch {
        // 日志出错不影响调用
      }
    };
    try {
      url = this.urlOf(op.url, all);
      const sent = await this.send(op, url, all, files, signal);
      request = sent.request;
      httpStatus = sent.res.status;
      let data: Uint8Array;
      if (op.poll) {
        // 异步任务：结果从最后一次查询的 JSON 里取
        const submitted = await this.readJson(sent.res, op);
        const finished = await this.poll(op, op.poll, submitted, all, signal, (status) => {
          httpStatus = status;
        });
        data = await this.extract(finished, op, { url, headers: sent.headers }, signal);
      } else if (op.responseType === 'binary') {
        data = new Uint8Array(await sent.res.arrayBuffer());
      } else {
        data = await this.extract(await this.readJson(sent.res, op), op, { url, headers: sent.headers }, signal);
      }
      log('ok', null, data.length);
      return { data, latencyMs: Date.now() - startedAt };
    } catch (err) {
      const pe = err instanceof ProviderError ? err : new ProviderError(String(err), { cause: err });
      log(pe.aborted ? 'aborted' : 'error', pe.message);
      throw pe;
    }
  }

  /** 异步任务：从提交的响应里取任务 id，反复查询直到完成，返回最后一次查询的 JSON。 */
  private async poll(
    op: CustomOperation,
    poll: NonNullable<CustomOperation['poll']>,
    submitted: unknown,
    vars: TemplateVars,
    signal: AbortSignal | undefined,
    onStatus: (status: number) => void,
  ): Promise<unknown> {
    const id = asText(pick(submitted, poll.idPath));
    if (!id) {
      throw new ProviderError(`响应里 ${poll.idPath} 没有任务 id：${JSON.stringify(submitted).slice(0, 200)}`, { body: JSON.stringify(submitted) });
    }
    const deadline = Date.now() + poll.maxMinutes * 60_000;
    const done = new Set(poll.done.map((s) => s.trim().toLowerCase()));
    const failed = new Set(poll.failed.map((s) => s.trim().toLowerCase()));
    const pollVars: TemplateVars = { ...vars, id };
    const query: CustomOperation = {
      ...op,
      method: poll.method,
      url: poll.url,
      bodyType: poll.method === 'GET' || !poll.body.trim() ? 'none' : 'json',
      body: poll.body,
    };
    for (;;) {
      await this.sleep(poll.intervalSeconds * 1000, signal);
      if (Date.now() > deadline) throw new ProviderError(`任务 ${id} 超过 ${poll.maxMinutes} 分钟还没完成`, { retryable: true });
      const q = await this.send(query, this.urlOf(poll.url, pollVars), pollVars, {}, signal);
      onStatus(q.res.status);
      const json = await this.parseJson(q.res);
      const state = asText(pick(json, poll.statusPath)).trim().toLowerCase();
      // 先看状态：失败的任务多半也带着错误信息，报「任务失败」更清楚
      if (failed.has(state)) {
        const msg = op.errorPath ? asText(pick(json, op.errorPath)) : '';
        throw new ProviderError(`任务失败（${state}）${msg ? `：${msg}` : ''}`, { body: JSON.stringify(json) });
      }
      this.checkError(json, op);
      if (done.has(state)) return json;
    }
  }

  private urlOf(template: string, vars: TemplateVars): string {
    // 地址里的值（除了 baseURL）要转义，提示词、任务 id 里有空格、& 也不会弄坏地址
    const raw = template.trim().replace(ANY, (_, name: string) => {
      const v = lookup(vars, name);
      if (v === null) return '';
      return name === 'baseURL' ? String(v) : encodeURIComponent(String(v));
    });
    const full = /^https?:\/\//i.test(raw) ? raw : `${this.baseURL}${raw.startsWith('/') ? '' : '/'}${raw}`;
    try {
      const u = new URL(full);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
    } catch {
      throw new ProviderError(`请求地址不对：${full.slice(0, 200)}`);
    }
    return full;
  }

  private async send(
    op: CustomOperation,
    url: string,
    vars: TemplateVars,
    files: Record<string, TemplateFile>,
    signal?: AbortSignal,
  ): Promise<{ res: Response; request: unknown; headers: Record<string, string> }> {
    const headers: Record<string, string> = { ...this.headers };
    for (const [k, v] of Object.entries(parseObject(op.headers, '请求头'))) {
      const value = renderText(asText(v), vars);
      if (value.trim()) headers[k] = value;
    }
    let body: string | FormData | undefined;
    let request: unknown = {};
    if (op.bodyType === 'json') {
      let tpl: unknown;
      try {
        tpl = JSON.parse(op.body || '{}');
      } catch (err) {
        throw new ProviderError(`请求体不是合法的 JSON：${err instanceof Error ? err.message : String(err)}`);
      }
      request = renderJson(tpl, vars);
      body = JSON.stringify(request);
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
    } else if (op.bodyType === 'multipart') {
      const form = new FormData();
      const shown: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(parseObject(op.body, '请求体'))) {
        const whole = typeof v === 'string' ? WHOLE.exec(v) : null;
        const file = whole ? files[whole[1] ?? ''] : undefined;
        if (file) {
          form.append(k, new Blob([new Uint8Array(file.data)], { type: file.mime }), file.name);
          shown[k] = `文件 ${Math.round(file.data.length / 1024)} KB`;
        } else {
          const value = typeof v === 'string' ? renderText(v, vars) : JSON.stringify(renderJson(v, vars));
          // 换完是空的字段不发（比如没填模型时的 model），和请求头一样
          if (!value.trim()) continue;
          form.append(k, value);
          shown[k] = value;
        }
      }
      body = form;
      request = shown;
      // multipart 的 Content-Type 要带 boundary，交给 fetch 自己写
      for (const k of Object.keys(headers)) if (k.toLowerCase() === 'content-type') delete headers[k];
    }
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
      let res: Response;
      try {
        res = await this.fetchImpl(url, { method: op.method, headers, body: op.method === 'GET' ? undefined : body, signal: ctrl.signal });
      } catch (err) {
        if (signal?.aborted) throw new ProviderError('已取消', { aborted: true });
        if (timedOut) throw new ProviderError(`等待超过 ${Math.round(this.timeoutMs / 1000)} 秒`, { retryable: true, cause: err });
        const code = (err as { cause?: { code?: string } }).cause?.code;
        throw new ProviderError(`无法连接到 ${new URL(url).host}${code ? `（${code}）` : ''}`, { retryable: true, cause: err });
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let msg = '';
        try {
          msg = op.errorPath ? asText(pick(JSON.parse(text), op.errorPath)) : '';
        } catch {
          // 不是 JSON
        }
        throw new ProviderError(msg ? `接口返回错误（HTTP ${res.status}）：${msg}` : describeHttpError(res.status, text), {
          status: res.status,
          body: text,
          retryable: isRetryableStatus(res.status),
          retryAfterMs: parseRetryAfter(res),
        });
      }
      return { res, request, headers };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** 读 JSON 响应，按错误码和错误信息的位置判断有没有出错。 */
  private async readJson(res: Response, op: CustomOperation): Promise<unknown> {
    const json = await this.parseJson(res);
    this.checkError(json, op);
    return json;
  }

  private async parseJson(res: Response): Promise<unknown> {
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new ProviderError(`接口返回的不是 JSON：${text.slice(0, 200)}`, { status: res.status, body: text });
    }
  }

  private checkError(json: unknown, op: CustomOperation): void {
    const text = JSON.stringify(json);
    const msg = op.errorPath ? asText(pick(json, op.errorPath)) : '';
    if (op.errorCodePath) {
      const code = pick(json, op.errorCodePath);
      if (code !== undefined && code !== null && code !== 0 && code !== '0' && code !== '') {
        throw new ProviderError(`接口返回错误（${asText(code)}）${msg ? `：${msg}` : ''}`, { body: text });
      }
    } else if (msg) {
      throw new ProviderError(`接口返回错误：${msg}`, { body: text });
    }
  }

  /**
   * 从 JSON 里按位置取出结果，按编码解成字节。
   * 结果是链接时下载它；链接和请求是同一个服务（同源）时带上请求的请求头（自己架的服务下载也要密钥），
   * 别的地址（对象存储之类）什么都不带，免得把密钥发给别人。
   */
  private async extract(
    json: unknown,
    op: CustomOperation,
    from: { url: string; headers: Record<string, string> },
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const v = pick(json, op.resultPath);
    if (typeof v !== 'string' || !v.trim()) {
      throw new ProviderError(`响应里 ${op.resultPath} 没有结果：${JSON.stringify(json).slice(0, 200)}`, { body: JSON.stringify(json) });
    }
    const s = v.trim();
    let enc = op.encoding;
    if (enc === 'auto') {
      if (/^https?:\/\//i.test(s)) enc = 'url';
      else if (/^data:/i.test(s)) enc = 'base64';
      else if (/^(?:[0-9a-f]{2})+$/i.test(s)) enc = 'hex';
      else enc = 'base64';
    }
    if (enc === 'url') {
      if (!/^https?:\/\//i.test(s)) throw new ProviderError(`结果不是 http 链接：${s.slice(0, 100)}`);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      const onAbort = () => ctrl.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const sameOrigin = new URL(s).origin === new URL(from.url).origin;
        const headers = sameOrigin
          ? Object.fromEntries(Object.entries(from.headers).filter(([k]) => k.toLowerCase() !== 'content-type'))
          : {};
        const res = await this.fetchImpl(s, { method: 'GET', headers, signal: ctrl.signal });
        if (!res.ok) throw new ProviderError(`下载结果失败（HTTP ${res.status}）`, { status: res.status, retryable: isRetryableStatus(res.status) });
        return new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        if (signal?.aborted) throw new ProviderError('已取消', { aborted: true });
        throw new ProviderError(`下载结果失败：${err instanceof Error ? err.message : String(err)}`, { retryable: true, cause: err });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    }
    if (enc === 'hex') {
      if (!/^(?:[0-9a-f]{2})+$/i.test(s)) throw new ProviderError('结果不是 hex 编码');
      return Uint8Array.from(Buffer.from(s, 'hex'));
    }
    const b64 = s.replace(/^data:[^,]*,/i, '');
    return Uint8Array.from(Buffer.from(b64, 'base64'));
  }
}

// ───────────── 三种职责 ─────────────

function sizeOf(size: string | undefined): { width: number | null; height: number | null } {
  const m = /^(\d+)x(\d+)$/.exec(size ?? '');
  return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: null, height: null };
}

/** 自定义的图像接口：request 文生图，edit 带参考图改图（没写就画不了表情差分）。 */
export class CustomImageClient {
  private readonly http: CustomHttpClient;
  private readonly api: CustomApi;
  constructor(api: CustomApi, cfg: Omit<CustomClientConfig, 'kind'>) {
    this.api = api;
    this.http = new CustomHttpClient({ ...cfg, kind: 'image' });
  }

  private vars(req: ImageRequest): TemplateVars {
    return {
      model: req.model,
      prompt: req.prompt,
      size: req.size ?? '',
      ...sizeOf(req.size),
      seed: Math.floor(Math.random() * 2_147_483_647),
      transparent: req.transparent ?? false,
    };
  }

  private async image(r: CustomResult): Promise<ImageResult> {
    const mime = sniffImage(r.data);
    if (!mime) throw new ProviderError('自定义接口返回的不是认得出的图片（PNG、JPEG、WebP）');
    return { data: r.data, mime, revisedPrompt: null, latencyMs: r.latencyMs };
  }

  async generate(req: ImageRequest, signal?: AbortSignal): Promise<ImageResult> {
    return this.image(await this.http.run(this.api.request, this.vars(req), {}, signal));
  }

  async edit(req: ImageEditRequest, signal?: AbortSignal): Promise<ImageResult> {
    if (!this.api.edit) throw new ProviderError('自定义的图像接口没有写「改图」请求，画不了表情差分（可以在素材设置里关掉表情差分）');
    const file = { data: req.image.data, mime: req.image.mime, name: `image.${IMAGE_EXT[req.image.mime] ?? 'png'}` };
    return this.image(await this.http.run(this.api.edit, this.vars(req), { image: file }, signal));
  }
}

/** 自定义的抠图接口：上传 {{image}}，返回抠好的 PNG。 */
export class CustomCutoutClient {
  private readonly http: CustomHttpClient;
  private readonly api: CustomApi;
  constructor(api: CustomApi, cfg: Omit<CustomClientConfig, 'kind'>) {
    this.api = api;
    this.http = new CustomHttpClient({ ...cfg, kind: 'image' });
  }

  async remove(image: { data: Uint8Array; mime: string }, model: string, signal?: AbortSignal): Promise<ImageResult> {
    const file = { data: image.data, mime: image.mime, name: `image.${IMAGE_EXT[image.mime] ?? 'png'}` };
    const r = await this.http.run(this.api.request, { model }, { image: file }, signal);
    const mime = sniffImage(r.data);
    if (!mime) throw new ProviderError('抠图服务返回的不是图片');
    return { data: r.data, mime, revisedPrompt: null, latencyMs: r.latencyMs };
  }
}

/** 自定义的音乐接口。 */
export class CustomMusicClient {
  private readonly http: CustomHttpClient;
  private readonly api: CustomApi;
  constructor(api: CustomApi, cfg: Omit<CustomClientConfig, 'kind'>) {
    this.api = api;
    this.http = new CustomHttpClient({ ...cfg, kind: 'music' });
  }

  async generate(req: MusicRequest, signal?: AbortSignal): Promise<MusicResult> {
    const vars: TemplateVars = { model: req.model, prompt: req.prompt, instrumental: req.instrumental ?? false, lyrics: req.lyrics ?? '' };
    const r = await this.http.run(this.api.request, vars, {}, signal);
    const mime = sniffAudio(r.data);
    if (!mime) throw new ProviderError('自定义接口返回的不是认得出的音频（MP3、WAV、Ogg、FLAC、M4A）');
    return { data: r.data, mime, durationMs: null, latencyMs: r.latencyMs };
  }
}

/** 自定义的语音接口：{{text}} 念成 {{voice}} 的声音。 */
export class CustomSpeechClient {
  private readonly http: CustomHttpClient;
  private readonly api: CustomApi;
  constructor(api: CustomApi, cfg: Omit<CustomClientConfig, 'kind'>) {
    this.api = api;
    this.http = new CustomHttpClient({ timeoutMs: 60_000, ...cfg, kind: 'voice' });
  }

  async speak(req: SpeechRequest, signal?: AbortSignal): Promise<SpeechResult> {
    const vars: TemplateVars = { model: req.model, text: req.text, voice: req.voice, speed: req.speed ?? 1, emotion: req.emotion ?? '' };
    const r = await this.http.run(this.api.request, vars, {}, signal);
    const mime = sniffAudio(r.data);
    if (!mime) throw new ProviderError('自定义接口返回的不是认得出的音频（MP3、WAV、Ogg、FLAC、M4A）');
    return { data: r.data, mime, durationMs: null, latencyMs: r.latencyMs };
  }
}
