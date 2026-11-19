import path from 'node:path';
import {
  type ChatResult,
  computeCost,
  type ExchangeRecord,
  type FetchLike,
  normalizeBaseURL,
  OpenAICompatibleClient,
  type ParamFix,
  probeCapabilities,
  type RequestOptions,
  requestOptionsFor,
  type StreamEvent,
} from '@auto-adv/providers';
import { type AppSettings, type Capabilities, type Endpoint, ROLE_LABELS, RoleId } from '@auto-adv/schema';
import type {
  ChatTarget,
  EndpointView,
  EngineContract,
  FetchModelsParams,
  PlaygroundChatParams,
  PlaygroundResult,
  ProbeChunk,
  SaveEndpointParams,
  SettingsView,
} from './api.ts';
import { CallLog } from './call-log.ts';
import type { CallContext, Handlers } from './rpc/index.ts';
import { endpointKeyId, type SecretStore } from './secrets.ts';
import { SettingsStore } from './settings-store.ts';
import { fromCallback, shortId } from './util.ts';

export const ENGINE_VERSION = '0.0.1';

export interface EngineOptions {
  /** 数据目录：settings.json、secrets.json、logs.db 都在这里。 */
  dataDir: string;
  secrets: SecretStore;
  /** 桌面端传入 Electron 的 net.fetch（走系统代理）；默认全局 fetch。 */
  fetch?: FetchLike;
  /** 调用日志文件；默认 <dataDir>/logs.db，测试可传 ':memory:'。 */
  callLogFile?: string;
  /** 模型请求超时，默认 120 秒。 */
  timeoutMs?: number;
}

interface CallScope {
  role: string;
  endpoint: Endpoint;
  model: string;
  /** 最后一条日志的 id。 */
  lastCallId: string | null;
}

/** 核心引擎。M0 提供：模型接入点管理、职责路由、能力探测、调试对话、调用日志。 */
export class Engine {
  readonly dataDir: string;
  private readonly settings: SettingsStore;
  private readonly secrets: SecretStore;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly timeoutMs: number | undefined;
  readonly calls: CallLog;
  /** 运行中发现的参数修正（还没做能力探测的模型也能受益）。 */
  private readonly runtimeFixes = new Map<string, Set<ParamFix>>();

  constructor(opts: EngineOptions) {
    this.dataDir = opts.dataDir;
    this.settings = new SettingsStore(opts.dataDir);
    this.secrets = opts.secrets;
    this.fetchImpl = opts.fetch;
    this.timeoutMs = opts.timeoutMs;
    this.calls = new CallLog(opts.callLogFile ?? path.join(opts.dataDir, 'logs.db'));
  }

  close(): void {
    this.calls.close();
  }

  // ───────────── 设置 ─────────────

  async getSettingsView(): Promise<SettingsView> {
    const s = await this.settings.get();
    const endpoints = await Promise.all(s.endpoints.map((e) => this.toView(e)));
    return { endpoints, roles: s.roles, secretsEncrypted: await this.secrets.isEncrypted(), dataDir: this.dataDir };
  }

  private async toView(e: Endpoint): Promise<EndpointView> {
    return { ...e, hasKey: (await this.secrets.get(endpointKeyId(e.id))) !== undefined };
  }

  private async getEndpoint(id: string): Promise<Endpoint> {
    const e = (await this.settings.get()).endpoints.find((x) => x.id === id);
    if (!e) throw new Error('接入点不存在，可能已被删除');
    return e;
  }

  async saveEndpoint(p: SaveEndpointParams): Promise<EndpointView> {
    const id = p.id ?? shortId('ep');
    const baseURL = normalizeBaseURL(p.baseURL);
    const models = [...new Set(p.models.map((m) => m.trim()).filter(Boolean))];
    const next = await this.settings.update((s) => {
      const existing = s.endpoints.find((e) => e.id === id);
      const endpoint: Endpoint = {
        id,
        name: p.name.trim(),
        kind: 'openai-compatible',
        baseURL,
        models,
        defaultModel: p.defaultModel && models.includes(p.defaultModel) ? p.defaultModel : models[0],
        headers: p.headers ?? existing?.headers ?? {},
        currency: p.currency,
        pricing: p.pricing,
        // 换了地址，之前的探测结果就不可信了
        capabilities: existing && existing.baseURL === baseURL ? existing.capabilities : {},
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      };
      const endpoints = existing ? s.endpoints.map((e) => (e.id === id ? endpoint : e)) : [...s.endpoints, endpoint];
      return { ...s, endpoints };
    });
    if (p.apiKey === null) await this.secrets.delete(endpointKeyId(id));
    else if (typeof p.apiKey === 'string' && p.apiKey.trim()) await this.secrets.set(endpointKeyId(id), p.apiKey.trim());
    const saved = next.endpoints.find((e) => e.id === id);
    if (!saved) throw new Error('保存失败');
    return this.toView(saved);
  }

  async deleteEndpoint(id: string): Promise<void> {
    await this.settings.update((s) => {
      const roles: AppSettings['roles'] = {};
      for (const [role, route] of Object.entries(s.roles)) {
        if (route && route.endpointId !== id) roles[role as RoleId] = route;
      }
      return { ...s, endpoints: s.endpoints.filter((e) => e.id !== id), roles };
    });
    await this.secrets.delete(endpointKeyId(id));
  }

  async setRole(role: RoleId, route: AppSettings['roles'][RoleId] | null): Promise<void> {
    RoleId.parse(role);
    if (route) {
      await this.getEndpoint(route.endpointId);
      if (!route.model.trim()) throw new Error('请选择模型');
      route = { ...route, model: route.model.trim() };
    }
    await this.settings.update((s) => {
      const roles = { ...s.roles };
      if (route) roles[role] = route;
      else delete roles[role];
      return { ...s, roles };
    });
  }

  // ───────────── 模型调用 ─────────────

  private makeClient(endpoint: Endpoint, apiKey: string | undefined, scope: CallScope): OpenAICompatibleClient {
    return new OpenAICompatibleClient({
      baseURL: endpoint.baseURL,
      apiKey,
      headers: endpoint.headers,
      fetch: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      onExchange: (rec) => this.logExchange(rec, scope),
    });
  }

  private logExchange(rec: ExchangeRecord, scope: CallScope): void {
    const result = rec.result;
    const usage = result?.usage ?? null;
    const pricing = scope.endpoint.pricing[scope.model];
    try {
      scope.lastCallId = this.calls.insert({
        ts: rec.startedAt,
        role: scope.role,
        endpointId: scope.endpoint.id,
        endpointName: scope.endpoint.name,
        model: scope.model,
        kind: rec.kind,
        status: rec.status,
        httpStatus: rec.httpStatus,
        url: rec.url,
        attempt: rec.attempt,
        latencyMs: rec.latencyMs,
        ttftMs: rec.ttftMs,
        usage,
        cost: usage ? computeCost(usage, pricing) : null,
        currency: scope.endpoint.currency,
        error: rec.error,
        request: rec.request,
        responseText: result?.text ?? rec.partialText,
        reasoning: result?.reasoning ?? '',
        toolCalls: result?.toolCalls ?? [],
      });
    } catch (err) {
      console.error('[engine] 写调用日志失败：', err);
    }
  }

  private fixKey(endpointId: string, model: string) {
    return `${endpointId}\u0000${model}`;
  }

  private optionsFor(endpoint: Endpoint, model: string, signal?: AbortSignal): RequestOptions {
    const opts: RequestOptions = { ...requestOptionsFor(endpoint.capabilities[model]), signal };
    for (const fix of this.runtimeFixes.get(this.fixKey(endpoint.id, model)) ?? []) {
      if (fix === 'useMaxCompletionTokens') opts.useMaxCompletionTokens = true;
      if (fix === 'noTemperature') opts.noTemperature = true;
      if (fix === 'noStreamUsage') opts.streamUsage = false;
    }
    return opts;
  }

  private async rememberFixes(endpoint: Endpoint, model: string, result: ChatResult): Promise<void> {
    if (!result.fixes.length) return;
    const key = this.fixKey(endpoint.id, model);
    const set = this.runtimeFixes.get(key) ?? new Set<ParamFix>();
    result.fixes.forEach((f) => set.add(f));
    this.runtimeFixes.set(key, set);
    if (!endpoint.capabilities[model]) return;
    await this.settings.update((s) => ({
      ...s,
      endpoints: s.endpoints.map((e) => {
        const caps = e.id === endpoint.id ? e.capabilities[model] : undefined;
        if (!caps) return e;
        const updated: Capabilities = {
          ...caps,
          useMaxCompletionTokens: caps.useMaxCompletionTokens || set.has('useMaxCompletionTokens'),
          noTemperature: caps.noTemperature || set.has('noTemperature'),
          streamUsage: caps.streamUsage && !set.has('noStreamUsage'),
        };
        return { ...e, capabilities: { ...e.capabilities, [model]: updated } };
      }),
    }));
  }

  private async resolveTarget(target: ChatTarget) {
    const s = await this.settings.get();
    if ('role' in target) {
      const route = s.roles[target.role] ?? s.roles.default;
      if (!route) {
        const name = ROLE_LABELS[target.role].name;
        throw new Error(`还没有给「${name}」或「默认」职责指定模型，请到 设置 → 职责路由 配置`);
      }
      const endpoint = s.endpoints.find((e) => e.id === route.endpointId);
      if (!endpoint) throw new Error('职责路由指向的接入点已被删除，请重新配置');
      return { endpoint, model: route.model, route, role: target.role as string };
    }
    const endpoint = s.endpoints.find((e) => e.id === target.endpointId);
    if (!endpoint) throw new Error('接入点不存在，可能已被删除');
    return { endpoint, model: target.model, route: undefined, role: 'playground' };
  }

  /** 调试台对话：流式产出增量，返回完整结果和费用。 */
  async *chat(p: PlaygroundChatParams, ctx: CallContext): AsyncGenerator<StreamEvent, PlaygroundResult, void> {
    const { endpoint, model, route, role } = await this.resolveTarget(p.target);
    if (!model) throw new Error('没有指定模型');
    const apiKey = await this.secrets.get(endpointKeyId(endpoint.id));
    const scope: CallScope = { role, endpoint, model, lastCallId: null };
    const client = this.makeClient(endpoint, apiKey, scope);
    const req = {
      model,
      messages: p.messages,
      temperature: p.temperature ?? route?.temperature,
      maxTokens: p.maxTokens ?? route?.maxTokens,
    };
    const opts = this.optionsFor(endpoint, model, ctx.signal);
    const caps = endpoint.capabilities[model];
    let result: ChatResult;
    if (p.stream === false || (caps && !caps.streaming)) {
      result = await client.chat(req, opts);
      if (result.reasoning) yield { type: 'reasoning', delta: result.reasoning };
      if (result.text) yield { type: 'text', delta: result.text };
    } else {
      result = yield* client.chatStream(req, opts);
    }
    await this.rememberFixes(endpoint, model, result);
    return {
      callId: scope.lastCallId,
      text: result.text,
      reasoning: result.reasoning,
      usage: result.usage,
      cost: computeCost(result.usage, endpoint.pricing[model]),
      currency: endpoint.currency,
      latencyMs: result.latencyMs,
      ttftMs: result.ttftMs,
      model: result.model ?? model,
      endpointName: endpoint.name,
    };
  }

  /** 能力探测：逐项产出进度，完成后把结果存进接入点。 */
  probe(endpointId: string, model: string, ctx: CallContext): AsyncGenerator<ProbeChunk, Capabilities, void> {
    return fromCallback<ProbeChunk, Capabilities>(async (emit) => {
      const endpoint = await this.getEndpoint(endpointId);
      const apiKey = await this.secrets.get(endpointKeyId(endpoint.id));
      const scope: CallScope = { role: 'probe', endpoint, model, lastCallId: null };
      const client = this.makeClient(endpoint, apiKey, scope);
      const caps = await probeCapabilities(client, model, {
        signal: ctx.signal,
        onStep: (step, ok, note) => emit({ step, ok, note }),
      });
      await this.settings.update((s) => ({
        ...s,
        endpoints: s.endpoints.map((e) =>
          e.id === endpointId
            ? {
                ...e,
                models: e.models.includes(model) ? e.models : [...e.models, model],
                defaultModel: e.defaultModel ?? model,
                capabilities: { ...e.capabilities, [model]: caps },
              }
            : e,
        ),
      }));
      this.runtimeFixes.delete(this.fixKey(endpointId, model));
      return caps;
    });
  }

  async fetchModels(p: FetchModelsParams): Promise<string[]> {
    const endpoint = p.endpointId ? await this.getEndpoint(p.endpointId) : undefined;
    const baseURL = p.baseURL ?? endpoint?.baseURL;
    if (!baseURL) throw new Error('请先填写 Base URL');
    const apiKey = p.apiKey || (endpoint ? await this.secrets.get(endpointKeyId(endpoint.id)) : undefined);
    const client = new OpenAICompatibleClient({
      baseURL,
      apiKey,
      headers: p.headers ?? endpoint?.headers,
      fetch: this.fetchImpl,
      timeoutMs: 30_000,
      maxRetries: 0,
    });
    return client.listModels();
  }

  /** 所有 RPC 处理函数。 */
  handlers(): Handlers<EngineContract> {
    return {
      ping: () => ({ engineVersion: ENGINE_VERSION, node: process.versions.node, dataDir: this.dataDir }),
      getSettings: () => this.getSettingsView(),
      saveEndpoint: (p) => this.saveEndpoint(p),
      deleteEndpoint: (p) => this.deleteEndpoint(p.id),
      fetchModels: (p) => this.fetchModels(p),
      probe: (p, ctx) => this.probe(p.endpointId, p.model, ctx),
      setRole: (p) => this.setRole(p.role, p.route),
      chat: (p, ctx) => this.chat(p, ctx),
      listCalls: (p) => this.calls.list(Math.min(p.limit ?? 100, 500), p.offset ?? 0),
      getCall: (p) => this.calls.get(p.id),
      clearCalls: () => this.calls.clear(),
      usageSummary: () => this.calls.summary(),
    };
  }
}
