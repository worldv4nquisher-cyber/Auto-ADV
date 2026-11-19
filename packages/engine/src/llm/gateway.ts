import {
  type ChatRequest,
  type ChatResult,
  computeCost,
  type ExchangeRecord,
  type FetchLike,
  OpenAICompatibleClient,
  type ParamFix,
  type RequestOptions,
  requestOptionsFor,
  type Usage,
} from '@auto-adv/providers';
import { type Capabilities, type Endpoint, ROLE_LABELS, type RoleId, type RoleRoute } from '@auto-adv/schema';
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

  /** 按职责取模型；该职责没配置时用「默认」。 */
  async forRole(role: RoleId, tag: string | null = null): Promise<ModelHandle> {
    const s = await this.o.settings.get();
    const route = s.roles[role] ?? s.roles.default;
    if (!route) {
      throw new Error(`还没有给「${ROLE_LABELS[role].name}」或「默认」职责指定模型，请到 设置 → 职责路由 配置`);
    }
    const endpoint = s.endpoints.find((e) => e.id === route.endpointId);
    if (!endpoint) throw new Error('职责路由指向的接入点已被删除，请重新配置');
    return this.make(endpoint, route.model, role, tag, route);
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
