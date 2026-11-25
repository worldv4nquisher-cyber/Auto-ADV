import {
  type ChatRequest,
  type ChatResult,
  computeCost,
  CustomCutoutClient,
  CustomImageClient,
  CustomMusicClient,
  CustomSpeechClient,
  type ExchangeRecord,
  type FetchLike,
  type ImageEditRequest,
  type ImageExchangeRecord,
  type ImageRequest,
  type ImageResult,
  MiniMaxMusicClient,
  MiniMaxSpeechClient,
  type MusicExchangeRecord,
  type MusicRequest,
  type MusicResult,
  OpenAICompatibleClient,
  OpenAIImageClient,
  OpenAISpeechClient,
  OPENAI_VOICES,
  type ParamFix,
  RembgCutoutClient,
  type RequestOptions,
  requestOptionsFor,
  type SpeechRequest,
  type SpeechResult,
  type Usage,
  type VoiceExchangeRecord,
} from '@auto-adv/providers';
import { type Capabilities, type Endpoint, type MediaRoute, ROLE_LABELS, type RoleId, type RoleRoute } from '@auto-adv/schema';
import type { ChatTarget } from '../api.ts';
import type { CallLog } from '../call-log.ts';
import { endpointKeyId, type SecretStore } from '../secrets.ts';
import type { SettingsStore } from '../settings-store.ts';

/** 一次（或一组）模型调用需要的一切：用哪个接入点、哪个模型、什么参数，调用记在谁名下。 */
export interface ModelHandle {
  endpoint: Endpoint;
  model: string;
  role: string;
  tag: string | null;
  caps: Capabilities | undefined;
  route: RoleRoute | undefined;
  client: OpenAICompatibleClient;
  /** 本次句柄最近写入的调用日志 id。 */
  lastCallId(): string | null;
}

/** 图像接口：内置的 OpenAI 风格（OpenAIImageClient）或自定义接口（CustomImageClient）。 */
export interface ImageClient {
  generate(req: ImageRequest, signal?: AbortSignal): Promise<ImageResult>;
  edit(req: ImageEditRequest, signal?: AbortSignal): Promise<ImageResult>;
}

/** 抠图接口：rembg 风格（RembgCutoutClient）或自定义接口（CustomCutoutClient）。 */
export interface CutoutClient {
  remove(image: { data: Uint8Array; mime: string }, model: string, signal?: AbortSignal): Promise<ImageResult>;
}

/** 语音接口：OpenAI 风格、MiniMax 或自定义接口。 */
export interface SpeechClient {
  speak(req: SpeechRequest, signal?: AbortSignal): Promise<SpeechResult>;
}

/** 媒体调用的日志记录。 */
type MediaRecord = ImageExchangeRecord | MusicExchangeRecord | VoiceExchangeRecord;

/** 音乐接口：MiniMax 风格（MiniMaxMusicClient）或自定义接口（CustomMusicClient）。 */
export interface MusicClient {
  generate(req: MusicRequest, signal?: AbortSignal): Promise<MusicResult>;
}

/** 图像职责的句柄。 */
export interface ImageHandle {
  endpoint: Endpoint;
  model: string;
  api: MediaRoute['api'];
  client: ImageClient;
  lastCallId(): string | null;
}

/** 抠图职责的句柄。 */
export interface CutoutHandle {
  endpoint: Endpoint;
  model: string;
  client: CutoutClient;
}

/** 音乐职责的句柄。 */
export interface MusicHandle {
  endpoint: Endpoint;
  model: string;
  client: MusicClient;
  lastCallId(): string | null;
}

/** 语音职责的句柄。 */
export interface VoiceHandle {
  endpoint: Endpoint;
  model: string;
  api: MediaRoute['api'];
  client: SpeechClient;
  /** 音色表（设置里的；没写时 OpenAI 用它的固定音色）。 */
  route: MediaRoute;
}

/** 自定义接口选了却没写模板。 */
function customOf(r: MediaRoute, label: string) {
  if (!r.custom) throw new Error(`「${label}」选了自定义接口，但还没有写请求模板，请到 设置 → 职责路由 填写`);
  return r.custom;
}

/** 计量回调：每次 HTTP 调用拿到用量后调用一次（重试、校验失败重来的每一次都算）。 */
export type Meter = (usage: Usage, cost: number | null, currency: string) => void;

export interface RunOptions {
  signal?: AbortSignal;
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  /** 默认 true；模型不支持流式时自动退回非流式。 */
  stream?: boolean;
}

export interface GatewayOptions {
  settings: SettingsStore;
  secrets: SecretStore;
  calls: CallLog;
  fetch?: FetchLike;
  timeoutMs?: number;
}

/** 模型网关：职责路由、按能力调整参数、调用日志、运行时参数修正，全部集中在这里。 */
export class ModelGateway {
  private readonly o: GatewayOptions;
  private readonly runtimeFixes = new Map<string, Set<ParamFix>>();

  constructor(opts: GatewayOptions) {
    this.o = opts;
  }

  /** 这个职责（或「默认」）有没有指定模型，接入点还在不在。 */
  async configured(role: RoleId): Promise<boolean> {
    const s = await this.o.settings.get();
    const route = s.roles[role] ?? s.roles.default;
    return !!route && s.endpoints.some((e) => e.id === route.endpointId);
  }

  /** 按职责取模型；该职责没配置时用「默认」。 */
  async forRole(role: RoleId, tag: string | null = null, meter?: Meter): Promise<ModelHandle> {
    const s = await this.o.settings.get();
    const route = s.roles[role] ?? s.roles.default;
    if (!route) {
      throw new Error(`还没有给「${ROLE_LABELS[role].name}」或「默认」职责指定模型，请到 设置 → 职责路由 配置`);
    }
    const endpoint = s.endpoints.find((e) => e.id === route.endpointId);
    if (!endpoint) throw new Error('职责路由指向的接入点已被删除，请重新配置');
    return this.make(endpoint, route.model, role, tag, route, meter);
  }

  /** 图像职责配了没有（不会退回「默认」的文本模型）。 */
  async imageRoute(): Promise<MediaRoute | null> {
    const s = await this.o.settings.get();
    const route = s.media.image;
    return route && s.endpoints.some((e) => e.id === route.endpointId) ? route : null;
  }

  /** 按图像职责取接入点和模型；给了 route 就用它（设置页里测试还没保存的选择）。 */
  async forImage(tag: string | null, route?: MediaRoute): Promise<ImageHandle> {
    const s = await this.o.settings.get();
    const r = route ?? s.media.image;
    if (!r) throw new Error('还没有给「图像」职责指定模型，请到 设置 → 职责路由 配置');
    const endpoint = s.endpoints.find((e) => e.id === r.endpointId);
    if (!endpoint) throw new Error('图像职责指向的接入点已被删除，请重新配置');
    if (r.api !== 'custom' && !r.model.trim()) throw new Error('没有指定图像模型');
    const apiKey = await this.o.secrets.get(endpointKeyId(endpoint.id));
    let lastCallId: string | null = null;
    const cfg = {
      baseURL: endpoint.baseURL,
      apiKey,
      headers: endpoint.headers,
      fetch: this.o.fetch,
      onExchange: (rec: MediaRecord) => {
        const id = this.logImage(rec, endpoint, r.model, tag);
        if (id) lastCallId = id;
      },
    };
    const client: ImageClient = r.api === 'custom' ? new CustomImageClient(customOf(r, '图像'), cfg) : new OpenAIImageClient(cfg);
    return { endpoint, model: r.model, api: r.api, client, lastCallId: () => lastCallId };
  }

  /** 抠图职责配了没有。 */
  async cutoutRoute(): Promise<MediaRoute | null> {
    const s = await this.o.settings.get();
    const route = s.media.cutout;
    return route && s.endpoints.some((e) => e.id === route.endpointId) ? route : null;
  }

  /** 按抠图职责取接入点（rembg 一类的服务，或自定义接口）。 */
  async forCutout(tag: string | null, route?: MediaRoute): Promise<CutoutHandle> {
    const s = await this.o.settings.get();
    const r = route ?? s.media.cutout;
    if (!r) throw new Error('透明背景选了「抠图服务」，但还没有配「抠图」职责，请到 设置 → 职责路由 配置');
    const endpoint = s.endpoints.find((e) => e.id === r.endpointId);
    if (!endpoint) throw new Error('抠图职责指向的接入点已被删除，请重新配置');
    const apiKey = await this.o.secrets.get(endpointKeyId(endpoint.id));
    const cfg = {
      baseURL: endpoint.baseURL,
      apiKey,
      headers: endpoint.headers,
      fetch: this.o.fetch,
      onExchange: (rec: MediaRecord) => this.logImage(rec, endpoint, r.model, tag, 'cutout'),
    };
    const client: CutoutClient = r.api === 'custom' ? new CustomCutoutClient(customOf(r, '抠图'), cfg) : new RembgCutoutClient(cfg);
    return { endpoint, model: r.model, client };
  }

  /** 音乐职责配了没有。 */
  async musicRoute(): Promise<MediaRoute | null> {
    const s = await this.o.settings.get();
    const route = s.media.music;
    return route && s.endpoints.some((e) => e.id === route.endpointId) ? route : null;
  }

  /** 按音乐职责取接入点和模型（MiniMax 风格的音乐接口，或自定义接口）；给了 route 就用它（设置页里测试还没保存的选择）。 */
  async forMusic(tag: string | null, route?: MediaRoute): Promise<MusicHandle> {
    const s = await this.o.settings.get();
    const r = route ?? s.media.music;
    if (!r) throw new Error('还没有给「音乐」职责指定模型，请到 设置 → 职责路由 配置');
    const endpoint = s.endpoints.find((e) => e.id === r.endpointId);
    if (!endpoint) throw new Error('音乐职责指向的接入点已被删除，请重新配置');
    if (r.api !== 'custom' && !r.model.trim()) throw new Error('没有指定音乐模型');
    const apiKey = await this.o.secrets.get(endpointKeyId(endpoint.id));
    let lastCallId: string | null = null;
    const cfg = {
      baseURL: endpoint.baseURL,
      apiKey,
      headers: endpoint.headers,
      fetch: this.o.fetch,
      onExchange: (rec: MediaRecord) => {
        const id = this.logImage(rec, endpoint, r.model, tag, 'music');
        if (id) lastCallId = id;
      },
    };
    const client: MusicClient = r.api === 'custom' ? new CustomMusicClient(customOf(r, '音乐'), cfg) : new MiniMaxMusicClient(cfg);
    return { endpoint, model: r.model, client, lastCallId: () => lastCallId };
  }

  /** 语音职责配了没有。 */
  async voiceRoute(): Promise<MediaRoute | null> {
    const s = await this.o.settings.get();
    const route = s.media.voice;
    return route && s.endpoints.some((e) => e.id === route.endpointId) ? route : null;
  }

  /** 按语音职责取接入点和模型；给了 route 就用它（设置页里测试还没保存的选择）。 */
  async forVoice(tag: string | null, route?: MediaRoute): Promise<VoiceHandle> {
    const s = await this.o.settings.get();
    const r = route ?? s.media.voice;
    if (!r) throw new Error('还没有给「语音」职责指定模型，请到 设置 → 职责路由 配置');
    const endpoint = s.endpoints.find((e) => e.id === r.endpointId);
    if (!endpoint) throw new Error('语音职责指向的接入点已被删除，请重新配置');
    if (r.api !== 'custom' && !r.model.trim()) throw new Error('没有指定语音模型');
    const apiKey = await this.o.secrets.get(endpointKeyId(endpoint.id));
    const cfg = {
      baseURL: endpoint.baseURL,
      apiKey,
      headers: endpoint.headers,
      fetch: this.o.fetch,
      onExchange: (rec: MediaRecord) => {
        this.logImage(rec, endpoint, r.model, tag, 'voice');
      },
    };
    const client: SpeechClient =
      r.api === 'custom'
        ? new CustomSpeechClient(customOf(r, '语音'), cfg)
        : r.api === 'minimax'
          ? new MiniMaxSpeechClient(cfg)
          : new OpenAISpeechClient(cfg);
    return { endpoint, model: r.model, api: r.api, client, route: r };
  }

  /** 语音服务上的音色（MiniMax 从服务拉取，OpenAI 是固定的一套；自定义接口没有，自己写）。 */
  async listVoices(route: MediaRoute, signal?: AbortSignal) {
    const s = await this.o.settings.get();
    const endpoint = s.endpoints.find((e) => e.id === route.endpointId);
    if (!endpoint) throw new Error('接入点已被删除');
    if (route.api === 'openai') return OPENAI_VOICES;
    if (route.api !== 'minimax') throw new Error('自定义接口没法从服务拉取音色，请自己写音色表');
    const apiKey = await this.o.secrets.get(endpointKeyId(endpoint.id));
    return new MiniMaxSpeechClient({ baseURL: endpoint.baseURL, apiKey, headers: endpoint.headers, fetch: this.o.fetch }).voices(signal);
  }

  private logImage(
    rec: MediaRecord,
    endpoint: Endpoint,
    model: string,
    tag: string | null,
    role = 'image',
  ): string | null {
    const ok =
      rec.kind === 'image'
        ? (rec.revisedPrompt ?? `图片 ${Math.round(rec.bytes / 1024)} KB`)
        : `${rec.kind === 'music' ? '音乐' : '语音'} ${Math.round(rec.bytes / 1024)} KB${rec.durationMs ? `，${(rec.durationMs / 1000).toFixed(1)} 秒` : ''}`;
    try {
      return this.o.calls.insert({
        ts: rec.startedAt,
        role,
        tag,
        endpointId: endpoint.id,
        endpointName: endpoint.name,
        model,
        kind: rec.kind,
        status: rec.status,
        httpStatus: rec.httpStatus,
        url: rec.url,
        attempt: rec.attempt,
        latencyMs: rec.latencyMs,
        ttftMs: null,
        usage: null,
        cost: null,
        currency: endpoint.currency,
        error: rec.error,
        request: rec.request,
        responseText: rec.status === 'ok' ? ok : '',
        reasoning: '',
        toolCalls: [],
      });
    } catch (err) {
      console.error('[engine] 写调用日志失败：', err);
      return null;
    }
  }

  async forTarget(target: ChatTarget, tag: string | null = null): Promise<ModelHandle> {
    if ('role' in target) return this.forRole(target.role, tag);
    const s = await this.o.settings.get();
    const endpoint = s.endpoints.find((e) => e.id === target.endpointId);
    if (!endpoint) throw new Error('接入点不存在，可能已被删除');
    return this.make(endpoint, target.model, 'playground', tag, undefined);
  }

  async forEndpoint(endpointId: string, model: string, role: string, tag: string | null = null): Promise<ModelHandle> {
    const s = await this.o.settings.get();
    const endpoint = s.endpoints.find((e) => e.id === endpointId);
    if (!endpoint) throw new Error('接入点不存在，可能已被删除');
    return this.make(endpoint, model, role, tag, undefined);
  }

  private async make(
    endpoint: Endpoint,
    model: string,
    role: string,
    tag: string | null,
    route: RoleRoute | undefined,
    meter?: Meter,
  ): Promise<ModelHandle> {
    if (!model) throw new Error('没有指定模型');
    const apiKey = await this.o.secrets.get(endpointKeyId(endpoint.id));
    let lastCallId: string | null = null;
    const client = new OpenAICompatibleClient({
      baseURL: endpoint.baseURL,
      apiKey,
      headers: endpoint.headers,
      fetch: this.o.fetch,
      timeoutMs: this.o.timeoutMs,
      onExchange: (rec) => {
        const id = this.log(rec, endpoint, model, role, tag);
        if (id) lastCallId = id;
        const usage = rec.result?.usage;
        if (meter && usage) {
          try {
            meter(usage, computeCost(usage, endpoint.pricing[model]), endpoint.currency);
          } catch (err) {
            console.error('[engine] 计量失败：', err);
          }
        }
      },
    });
    return {
      endpoint,
      model,
      role,
      tag,
      caps: endpoint.capabilities[model],
      route,
      client,
      lastCallId: () => lastCallId,
    };
  }

  private log(rec: ExchangeRecord, endpoint: Endpoint, model: string, role: string, tag: string | null): string | null {
    const result = rec.result;
    const usage = result?.usage ?? null;
    try {
      return this.o.calls.insert({
        ts: rec.startedAt,
        role,
        tag,
        endpointId: endpoint.id,
        endpointName: endpoint.name,
        model,
        kind: rec.kind,
        status: rec.status,
        httpStatus: rec.httpStatus,
        url: rec.url,
        attempt: rec.attempt,
        latencyMs: rec.latencyMs,
        ttftMs: rec.ttftMs,
        usage,
        cost: usage ? computeCost(usage, endpoint.pricing[model]) : null,
        currency: endpoint.currency,
        error: rec.error,
        request: rec.request,
        responseText: result?.text ?? rec.partialText,
        reasoning: result?.reasoning ?? '',
        toolCalls: result?.toolCalls ?? [],
      });
    } catch (err) {
      console.error('[engine] 写调用日志失败：', err);
      return null;
    }
  }

  cost(h: ModelHandle, usage: Usage): number | null {
    return computeCost(usage, h.endpoint.pricing[h.model]);
  }

  private fixKey(h: { endpoint: Endpoint; model: string }) {
    return `${h.endpoint.id}\u0000${h.model}`;
  }

  /** 按能力探测结果和运行中发现的修正，得到请求参数。 */
  options(h: ModelHandle, signal?: AbortSignal): RequestOptions {
    const opts: RequestOptions = { ...requestOptionsFor(h.caps), signal };
    for (const fix of this.runtimeFixes.get(this.fixKey(h)) ?? []) {
      if (fix === 'useMaxCompletionTokens') opts.useMaxCompletionTokens = true;
      if (fix === 'noTemperature') opts.noTemperature = true;
      if (fix === 'noStreamUsage') opts.streamUsage = false;
    }
    return opts;
  }

  /** 发起一次对话调用：默认流式，增量通过回调给出；返回完整结果。 */
  async run(h: ModelHandle, req: Omit<ChatRequest, 'model'>, ro: RunOptions = {}): Promise<ChatResult> {
    const full: ChatRequest = {
      ...req,
      model: h.model,
      temperature: req.temperature ?? h.route?.temperature,
      maxTokens: req.maxTokens ?? h.route?.maxTokens,
    };
    const opts = this.options(h, ro.signal);
    let result: ChatResult;
    if (ro.stream === false || (h.caps && !h.caps.streaming)) {
      result = await h.client.chat(full, opts);
      if (result.reasoning) ro.onReasoning?.(result.reasoning);
      if (result.text) ro.onText?.(result.text);
    } else {
      const gen = h.client.chatStream(full, opts);
      let next = await gen.next();
      while (!next.done) {
        const e = next.value;
        if (e.type === 'text') ro.onText?.(e.delta);
        else if (e.type === 'reasoning') ro.onReasoning?.(e.delta);
        next = await gen.next();
      }
      result = next.value;
    }
    await this.remember(h, result);
    return result;
  }

  /** 记住本次调用中自动修正过的参数；已做过能力探测的模型同时写回设置。 */
  async remember(h: ModelHandle, result: ChatResult): Promise<void> {
    if (!result.fixes.length) return;
    const key = this.fixKey(h);
    const set = this.runtimeFixes.get(key) ?? new Set<ParamFix>();
    result.fixes.forEach((f) => set.add(f));
    this.runtimeFixes.set(key, set);
    if (!h.caps) return;
    await this.o.settings.update((s) => ({
      ...s,
      endpoints: s.endpoints.map((e) => {
        const caps = e.id === h.endpoint.id ? e.capabilities[h.model] : undefined;
        if (!caps) return e;
        const updated: Capabilities = {
          ...caps,
          useMaxCompletionTokens: caps.useMaxCompletionTokens || set.has('useMaxCompletionTokens'),
          noTemperature: caps.noTemperature || set.has('noTemperature'),
          streamUsage: caps.streamUsage && !set.has('noStreamUsage'),
        };
        return { ...e, capabilities: { ...e.capabilities, [h.model]: updated } };
      }),
    }));
  }

  /** 能力探测完成后，清掉运行时修正（以探测结果为准）。 */
  clearFixes(endpointId: string, model: string): void {
    this.runtimeFixes.delete(`${endpointId}\u0000${model}`);
  }
}
