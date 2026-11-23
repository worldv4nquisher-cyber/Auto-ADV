import path from 'node:path';
import {
  type FetchLike,
  normalizeBaseURL,
  OpenAICompatibleClient,
  probeCapabilities,
  type StreamEvent,
} from '@auto-adv/providers';
import { type AppSettings, type Capabilities, type Endpoint, type GenesisStepId, RoleId } from '@auto-adv/schema';
import type {
  CreateWorldParams,
  EndpointView,
  GenesisChunk,
  ObserverChunk,
  WorldDetail,
  WorldSummary,
  EngineContract,
  FetchModelsParams,
  PlaygroundChatParams,
  PlaygroundResult,
  ProbeChunk,
  SaveEndpointParams,
  SettingsView,
} from './api.ts';
import { CallLog } from './call-log.ts';
import { GenesisRunner } from './genesis/pipeline.ts';
import { ModelGateway } from './llm/gateway.ts';
import { PlayService } from './play/runtime.ts';
import { checkWorldPlot } from './plot/session.ts';
import { assertWorldId, type WorldData, WorldStore } from './world/store.ts';
import type { CallContext, Handlers } from './rpc/index.ts';
import { endpointKeyId, type SecretStore } from './secrets.ts';
import { SettingsStore } from './settings-store.ts';
import { fromCallback, shortId } from './util.ts';

export const ENGINE_VERSION = '0.1.0';

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

/** 核心引擎。M0 提供：模型接入点管理、职责路由、能力探测、调试对话、调用日志。 */
export class Engine {
  readonly dataDir: string;
  private readonly settings: SettingsStore;
  private readonly secrets: SecretStore;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly timeoutMs: number | undefined;
  readonly calls: CallLog;
  readonly gateway: ModelGateway;
  readonly worlds: WorldStore;
  readonly genesis: GenesisRunner;
  readonly play: PlayService;

  constructor(opts: EngineOptions) {
    this.dataDir = opts.dataDir;
    this.settings = new SettingsStore(opts.dataDir);
    this.secrets = opts.secrets;
    this.fetchImpl = opts.fetch;
    this.timeoutMs = opts.timeoutMs;
    this.calls = new CallLog(opts.callLogFile ?? path.join(opts.dataDir, 'logs.db'));
    this.gateway = new ModelGateway({
      settings: this.settings,
      secrets: this.secrets,
      calls: this.calls,
      fetch: this.fetchImpl,
      timeoutMs: this.timeoutMs,
    });
    this.worlds = new WorldStore(path.join(opts.dataDir, 'worlds'));
    this.genesis = new GenesisRunner(this.worlds, this.gateway);
    this.play = new PlayService(this.worlds, this.gateway);
  }

  close(): void {
    this.genesis.abortAll();
    this.play.dispose();
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

  /** 调试台对话：流式产出增量，返回完整结果和费用。 */
  chat(p: PlaygroundChatParams, ctx: CallContext): AsyncGenerator<StreamEvent, PlaygroundResult, void> {
    return fromCallback<StreamEvent, PlaygroundResult>(async (emit) => {
      const h = await this.gateway.forTarget(p.target, 'playground');
      const result = await this.gateway.run(
        h,
        { messages: p.messages, temperature: p.temperature, maxTokens: p.maxTokens },
        {
          signal: ctx.signal,
          stream: p.stream,
          onText: (delta) => emit({ type: 'text', delta }),
          onReasoning: (delta) => emit({ type: 'reasoning', delta }),
        },
      );
      return {
        callId: h.lastCallId(),
        text: result.text,
        reasoning: result.reasoning,
        usage: result.usage,
        cost: this.gateway.cost(h, result.usage),
        currency: h.endpoint.currency,
        latencyMs: result.latencyMs,
        ttftMs: result.ttftMs,
        model: result.model ?? h.model,
        endpointName: h.endpoint.name,
      };
    });
  }

  /** 能力探测：逐项产出进度，完成后把结果存进接入点。 */
  probe(endpointId: string, model: string, ctx: CallContext): AsyncGenerator<ProbeChunk, Capabilities, void> {
    return fromCallback<ProbeChunk, Capabilities>(async (emit) => {
      const h = await this.gateway.forEndpoint(endpointId, model, 'probe', 'probe');
      const caps = await probeCapabilities(h.client, model, {
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
      this.gateway.clearFixes(endpointId, model);
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

  // ───────────── 世界 ─────────────

  private summarize(d: WorldData | (Pick<WorldData, 'manifest'> & Partial<WorldData>)): WorldSummary {
    const m = d.manifest;
    return {
      id: m.id,
      title: m.title,
      logline: m.logline,
      genre: d.brief?.genre ?? '',
      status: m.status,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      characterCount: d.characters?.length ?? 0,
      steps: m.genesis.steps,
      running: this.genesis.isRunning(m.id),
    };
  }

  async listWorlds(): Promise<WorldSummary[]> {
    const manifests = await this.worlds.list();
    return Promise.all(manifests.map(async (m) => this.summarize(await this.worlds.load(m.id))));
  }

  async getWorld(id: string): Promise<WorldDetail> {
    const world = await this.worlds.load(id);
    const { scripts: _scripts, ...d } = world;
    return { ...d, plotCheck: checkWorldPlot(world), summary: this.summarize(d) };
  }

  /** 从文件夹导入世界。 */
  async importWorld(src: string): Promise<WorldSummary> {
    if (!path.isAbsolute(src)) throw new Error('请给出世界文件夹的完整路径');
    const id = await this.worlds.importFolder(src);
    return this.summarize(await this.worlds.load(id));
  }

  async deleteWorld(id: string): Promise<void> {
    assertWorldId(id);
    await this.genesis.stop(id);
    await this.play.closeWorld(id);
    await this.worlds.delete(id);
  }

  createWorld(p: CreateWorldParams, ctx: CallContext): AsyncGenerator<GenesisChunk, WorldSummary, void> {
    return fromCallback(async (emit) => {
      const m = await this.genesis.create(p, emit, ctx.signal);
      return this.summarize(await this.worlds.load(m.id));
    });
  }

  runGenesis(worldId: string, from: GenesisStepId | undefined, ctx: CallContext) {
    return fromCallback<GenesisChunk, WorldSummary>(async (emit) => {
      await this.genesis.run(worldId, from, emit, ctx.signal);
      return this.summarize(await this.worlds.load(worldId));
    });
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

      listWorlds: () => this.listWorlds(),
      getWorld: (p) => this.getWorld(p.id),
      deleteWorld: (p) => this.deleteWorld(p.id),
      importWorld: (p) => this.importWorld(p.path),
      createWorld: (p, ctx) => this.createWorld(p, ctx),
      runGenesis: (p, ctx) => this.runGenesis(p.worldId, p.from, ctx),

      listPlaythroughs: (p) => this.play.list(p.worldId),
      startPlaythrough: (p) => this.play.start(p),
      getPlaythrough: (p) => this.play.view(p),
      deletePlaythrough: (p) => this.play.delete(p),
      send: (p, ctx) => fromCallback((emit) => this.play.send(p, emit, ctx.signal)),
      regenerate: (p, ctx) => fromCallback((emit) => this.play.regenerate(p, p.eventId, emit, ctx.signal)),
      editEvent: (p) => this.play.edit(p, p.eventId, p.text, p.segments),
      switchBranch: (p) => this.play.switchBranch(p, p.eventId),
      rewind: (p) => this.play.rewind(p, p.eventId),
      deleteBranch: (p) => this.play.deleteBranch(p, p.eventId),
      setScene: (p) => this.play.setScene(p, { locationId: p.locationId, presentCharacterIds: p.presentCharacterIds }),
      saveSlot: (p) => this.play.save(p, p.name, p.at),
      loadSave: (p) => this.play.load(p, p.saveId),
      deleteSave: (p) => this.play.deleteSave(p, p.saveId),

      advNext: (p, ctx) => fromCallback((emit) => this.play.advAct(p, { kind: 'continue' }, emit, ctx.signal)),
      advChoose: (p, ctx) => fromCallback((emit) => this.play.advAct(p, { kind: 'choose', index: p.index }, emit, ctx.signal)),
      advInput: (p, ctx) => fromCallback((emit) => this.play.advAct(p, { kind: 'input', text: p.text }, emit, ctx.signal)),
      advShown: (p) => this.play.advShown(p, p.eventId, p.cg),

      observerControl: (p) => this.play.observerControl(p, p.action),
      observerSettings: (p) => this.play.observerSettings(p, p.settings),
      observerRead: (p) => this.play.observerRead(p, p.eventId),
      observerWatch: (p, ctx) =>
        fromCallback<ObserverChunk, void>((emit) => this.play.observerWatch(p, emit, ctx.signal)),
      directive: (p) => this.play.note(p, 'directive', p.text),
      whisper: (p) => this.play.note(p, 'whisper', p.text, p.characterId),
      takeover: (p) => this.play.takeover(p, p.characterId),
    };
  }
}
