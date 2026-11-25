import path from 'node:path';
import {
  ComfyImageClient,
  encodeRgbaPng,
  type FetchLike,
  normalizeBaseURL,
  OpenAICompatibleClient,
  probeCapabilities,
  type StreamEvent,
} from '@auto-adv/providers';
import {
  type AppSettings,
  AssetSettings,
  type Capabilities,
  checkComfy,
  ComfySettings,
  comfyUsesModel,
  type Endpoint,
  type GenesisStepId,
  checkCustomApi,
  CustomApi,
  MEDIA_ROLE_APIS,
  MEDIA_ROLE_IDS,
  MediaRoleId,
  type MediaRoute,
  RoleId,
} from '@auto-adv/schema';
import type {
  AssetsChunk,
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
import { AssetService } from './assets/service.ts';
import { VoiceService } from './voice/service.ts';
import { estimateAssets } from './assets/estimate.ts';
import {
  BUILTIN_MUSIC_TEMPLATE,
  BUILTIN_TEMPLATES,
  DEFAULT_ART_STYLE,
  DEFAULT_MUSIC_STYLE,
  MUSIC_PLACEHOLDERS,
  TEMPLATE_PLACEHOLDERS,
} from './assets/templates.ts';
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
  /** 素材生成失败后重试的基础等待时间，默认 2 秒（测试里调小）。 */
  assetRetryBaseMs?: number;
  /** 内置曲库的文件夹（里面有 manifest.json，18.7）。不给就没有内置曲库。 */
  builtinBgmDir?: string;
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
  readonly assets: AssetService;
  readonly voice: VoiceService;

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
    this.assets = new AssetService(this.worlds, this.settings, this.gateway, {
      retryBaseMs: opts.assetRetryBaseMs,
      dataDir: opts.dataDir,
      builtinBgmDir: opts.builtinBgmDir,
    });
    this.voice = new VoiceService(this.worlds, this.gateway, this.assets);
    this.assets.onRefresh = (worldId) => this.voice.invalidate(worldId);
    this.play.onView = (worldId, v) => {
      void this.assets
        .focus(worldId, { locationId: v.scene.locationId, characterIds: v.scene.presentCharacterIds, sceneId: v.plot.scene })
        .catch(() => {});
    };
    this.play.expressionTable = async (worldId) => (await this.assets.effectiveSettings(worldId)).expressions;
    this.play.moodTable = async (worldId) => {
      const a = await this.assets.effectiveSettings(worldId);
      return a.enabled.bgm ? a.bgm.moods : undefined;
    };
    this.play.cgRules = async (worldId) => {
      const a = await this.assets.effectiveSettings(worldId);
      if (!a.enabled.cg || a.cg.perScene <= 0 || !(await this.gateway.imageRoute())) return null;
      return { perScene: a.cg.perScene, perChapter: a.cg.perChapter };
    };
    this.play.extrasRules = async (worldId) => {
      const a = await this.assets.effectiveSettings(worldId);
      return { silhouette: a.extras.silhouette, upgradeAfter: a.extras.upgradeAfter };
    };
    this.play.onWorldChanged = (worldId) => {
      void this.assets.refresh(worldId).catch((err) => console.error('[assets] 重算素材清单失败：', err));
    };
    this.play.onBeatPlanned = (worldId, b) => {
      void this.assets.beatPlanned(worldId, b).catch((err) => console.error('[assets] 登记这一拍的素材失败：', err));
    };
  }

  close(): void {
    this.genesis.abortAll();
    this.assets.dispose();
    this.play.dispose();
    this.calls.close();
  }

  // ───────────── 设置 ─────────────

  async getSettingsView(): Promise<SettingsView> {
    const s = await this.settings.get();
    const endpoints = await Promise.all(s.endpoints.map((e) => this.toView(e)));
    return {
      endpoints,
      roles: s.roles,
      media: s.media,
      assets: s.assets,
      assetDefaults: {
        templates: BUILTIN_TEMPLATES,
        artStyle: DEFAULT_ART_STYLE,
        placeholders: TEMPLATE_PLACEHOLDERS,
        settings: AssetSettings.parse({}),
        music: { template: BUILTIN_MUSIC_TEMPLATE, style: DEFAULT_MUSIC_STYLE, placeholders: MUSIC_PLACEHOLDERS },
      },
      secretsEncrypted: await this.secrets.isEncrypted(),
      dataDir: this.dataDir,
    };
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
      const media = { ...s.media };
      for (const k of MEDIA_ROLE_IDS) if (media[k]?.endpointId === id) delete media[k];
      return { ...s, endpoints: s.endpoints.filter((e) => e.id !== id), roles, media };
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

  /** 检查一个媒体职责的路由：接入点在不在、模型填没填、接口类型对不对，自定义接口的模板写得对不对。 */
  private async checkMediaRoute(role: MediaRoleId, route: MediaRoute, strict: boolean): Promise<MediaRoute> {
    await this.getEndpoint(route.endpointId);
    // 抠图服务的模型可以不填（用服务自己的默认模型）；自定义接口模板、ComfyUI 的工作流里不用 {{model}} 时也可以不填
    const api = MEDIA_ROLE_APIS[role].includes(route.api) ? route.api : (MEDIA_ROLE_APIS[role][0] ?? route.api);
    let comfy: ComfySettings | undefined;
    if (api === 'comfyui') {
      const parsed = ComfySettings.safeParse(route.comfy ?? {});
      if (!parsed.success) throw new Error(`ComfyUI 的设置不对：${parsed.error.issues[0]?.message ?? parsed.error.message}`);
      const problem = checkComfy(parsed.data);
      if (problem) throw new Error(problem);
      comfy = parsed.data;
    }
    const modelOptional = api === 'custom' || role === 'cutout' || (comfy !== undefined && !comfyUsesModel(comfy));
    if (strict && !modelOptional && !route.model.trim()) {
      throw new Error(role === 'image' ? (api === 'comfyui' ? '请填写模型（checkpoint 的文件名，可以从 ComfyUI 读取）' : '请填写图像模型') : role === 'music' ? '请填写音乐模型' : '请填写语音模型');
    }
    if (comfy) return { ...route, model: route.model.trim(), api, comfy };
    if (route.voices) {
      const ids = route.voices.map((v) => v.id.trim());
      if (ids.some((id) => !id)) throw new Error('音色表里有没写 id 的音色');
      if (new Set(ids).size !== ids.length) throw new Error('音色表里有重复的音色 id');
    }
    if (api !== 'custom') {
      // 自定义模板留着，切回自定义时不用重写
      return { ...route, model: route.model.trim(), api };
    }
    if (!route.custom) throw new Error('选了自定义接口，请填写请求模板');
    const parsed = CustomApi.safeParse(route.custom);
    if (!parsed.success) throw new Error(`自定义接口的模板不对：${parsed.error.issues[0]?.message ?? parsed.error.message}`);
    const problem = checkCustomApi(parsed.data, role);
    if (problem) throw new Error(problem);
    return { ...route, model: route.model.trim(), api, custom: parsed.data };
  }

  async setMediaRole(role: MediaRoleId, route: MediaRoute | null): Promise<void> {
    MediaRoleId.parse(role);
    if (route) route = await this.checkMediaRoute(role, route, true);
    await this.settings.update((s) => ({ ...s, media: { ...s.media, [role]: route ?? undefined } }));
    // 换了语音服务：音色表重新拉，配音表下次用的时候核对
    if (role === 'voice') this.voice.invalidate();
    // 配好了图像模型，已经打开的世界马上开始画
    await this.assets.refreshAll();
  }

  async saveAssetSettings(settings: AssetSettings): Promise<void> {
    const parsed = AssetSettings.parse(settings);
    await this.settings.update((s) => ({ ...s, assets: parsed }));
    await this.assets.refreshAll();
  }

  /** 画一张小图试试图像职责。 */
  async testImage(route: MediaRoute | undefined, ctx: CallContext) {
    const h = await this.gateway.forImage('assets.test', route && (await this.checkMediaRoute('image', route, false)));
    const r = await h.client.generate(
      { model: h.model, prompt: '一只坐在窗台上的橘猫，水彩插画，柔和的晨光', size: '1024x1024' },
      ctx.signal,
    );
    return {
      dataUrl: `data:${r.mime};base64,${Buffer.from(r.data).toString('base64')}`,
      revisedPrompt: r.revisedPrompt,
      latencyMs: r.latencyMs,
    };
  }

  /** 生成一首试试音乐职责（会花一首曲子的额度）。 */
  async testMusic(route: MediaRoute | undefined, ctx: CallContext) {
    const h = await this.gateway.forMusic('assets.test', route && (await this.checkMediaRoute('music', route, false)));
    const r = await h.client.generate(
      { model: h.model, prompt: '温暖的钢琴小品，轻柔的弦乐伴奏，视觉小说的日常场景，纯音乐', instrumental: true },
      ctx.signal,
    );
    return {
      dataUrl: `data:${r.mime};base64,${Buffer.from(r.data).toString('base64')}`,
      durationMs: r.durationMs,
      latencyMs: r.latencyMs,
    };
  }

  /** 念一句试试语音职责。 */
  async testVoice(p: { route?: MediaRoute; voice?: string; text?: string }, ctx: CallContext) {
    const route = p.route ? await this.checkMediaRoute('voice', p.route, false) : await this.gateway.voiceRoute();
    if (!route) throw new Error('还没有给「语音」职责指定模型，请到 设置 → 职责路由 配置');
    const h = await this.gateway.forVoice('voice.test', route);
    const voice = p.voice?.trim() || (await this.voice.catalog(route))[0]?.id;
    if (!voice) throw new Error('音色表是空的，请先写音色表（或从服务拉取）');
    const r = await h.client.speak({ model: h.model, text: p.text?.trim() || '你好，这是一句语音测试。今天的风有点大呢。', voice }, ctx.signal);
    return { dataUrl: `data:${r.mime};base64,${Buffer.from(r.data).toString('base64')}`, durationMs: r.durationMs, latencyMs: r.latencyMs };
  }

  /** ComfyUI 上能用的模型（checkpoint 文件名）。 */
  async comfyModels(route: MediaRoute, ctx: CallContext) {
    const r = await this.checkMediaRoute('image', { ...route, api: 'comfyui' }, false);
    const h = await this.gateway.forImage(null, { ...r, model: r.model || '-' });
    if (!(h.client instanceof ComfyImageClient)) throw new Error('图像职责的接口类型不是 ComfyUI');
    return h.client.models(ctx.signal);
  }

  /** 语音服务上的音色。 */
  async fetchVoices(route: MediaRoute, ctx: CallContext) {
    const r = await this.checkMediaRoute('voice', route, false);
    return (await this.gateway.listVoices(r, ctx.signal)).map((v) => ({ id: v.id, name: v.name, description: v.description }));
  }

  /** 抠一张示例图试试抠图职责（白底上一个彩色圆）。 */
  async testCutout(route: MediaRoute | undefined, ctx: CallContext) {
    const c = await this.gateway.forCutout('assets.test', route && (await this.checkMediaRoute('cutout', route, false)));
    const r = await c.client.remove({ data: cutoutSample(), mime: 'image/png' }, c.model, ctx.signal);
    return { dataUrl: `data:${r.mime};base64,${Buffer.from(r.data).toString('base64')}`, latencyMs: r.latencyMs };
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
    await this.assets.closeWorld(id);
    await this.play.closeWorld(id);
    await this.worlds.delete(id);
  }

  /** 创世每完成一步，素材清单可能多了东西（比如地点）：马上开始画，不等整个创世做完（18.10 的"五分钟"）。 */
  private withAssets(emit: (c: GenesisChunk) => void, worldIdOf: () => string | null) {
    return (c: GenesisChunk) => {
      emit(c);
      const id = c.type === 'world' ? c.worldId : worldIdOf();
      if (id && c.type === 'step' && c.state.status === 'done') void this.assets.refresh(id).catch(() => {});
    };
  }

  createWorld(p: CreateWorldParams, ctx: CallContext): AsyncGenerator<GenesisChunk, WorldSummary, void> {
    return fromCallback(async (emit) => {
      let worldId: string | null = null;
      const m = await this.genesis.create(
        p,
        this.withAssets(
          (c) => {
            if (c.type === 'world') worldId = c.worldId;
            emit(c);
          },
          () => worldId,
        ),
        ctx.signal,
      );
      void this.assets.refresh(m.id).catch(() => {});
      return this.summarize(await this.worlds.load(m.id));
    });
  }

  runGenesis(worldId: string, from: GenesisStepId | undefined, ctx: CallContext) {
    return fromCallback<GenesisChunk, WorldSummary>(async (emit) => {
      await this.genesis.run(worldId, from, this.withAssets(emit, () => worldId), ctx.signal);
      void this.assets.refresh(worldId).catch(() => {});
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
      setMediaRole: (p) => this.setMediaRole(p.role, p.route),
      saveAssetSettings: (p) => this.saveAssetSettings(p.settings),
      testImage: (p, ctx) => this.testImage(p.route, ctx),
      testMusic: (p, ctx) => this.testMusic(p.route, ctx),
      testCutout: (p, ctx) => this.testCutout(p.route, ctx),
      testVoice: (p, ctx) => this.testVoice(p, ctx),
      fetchVoices: (p, ctx) => this.fetchVoices(p.route, ctx),
      comfyModels: (p, ctx) => this.comfyModels(p.route, ctx),
      voiceCast: (p) => this.voice.view(p.worldId),
      setCharacterVoice: (p) => this.voice.setVoice(p.worldId, p.characterId, p.voiceId),
      recastVoices: (p) => this.voice.view(p.worldId, true),
      voiceLine: (p) => this.voice.line(p.worldId, p.line),
      builtinBgm: () => this.assets.builtinTracks(),
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
      estimateAssets: async (p) => {
        const [s, image, music, voice] = await Promise.all([
          this.settings.get(),
          this.gateway.imageRoute(),
          this.gateway.musicRoute(),
          this.gateway.voiceRoute(),
        ]);
        return estimateAssets(p.options, s.assets, { image: !!image, music: !!music, voice: !!voice });
      },
      runGenesis: (p, ctx) => this.runGenesis(p.worldId, p.from, ctx),

      assetsView: (p) => this.assets.view(p.worldId),
      assetsWatch: (p, ctx) => fromCallback<AssetsChunk, void>((emit) => this.assets.watch(p.worldId, emit, ctx.signal)),
      assetAction: (p) => this.assets.act(p.worldId, p.slotId, p.action, p.file),
      assetSetPrompt: (p) => this.assets.setPrompt(p.worldId, p.slotId, p.prompt, p.redraw),
      assetUpload: (p) => this.assets.upload(p.worldId, p.slotId, p.path),
      assetsControl: (p) => this.assets.control(p.worldId, p.action),
      saveWorldAssetSettings: (p) => this.assets.saveWorldSettings(p.worldId, p.patch),

      listPlaythroughs: (p) => this.play.list(p.worldId),
      worldProgress: (p) => this.play.progress(p.worldId),
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
      advDrift: (p, ctx) => fromCallback((emit) => this.play.advAct(p, { kind: 'drift', choice: p.choice }, emit, ctx.signal)),
      advRegenerate: (p, ctx) => fromCallback((emit) => this.play.advAct(p, { kind: 'continue' }, emit, ctx.signal, { regenerate: true })),
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

/** 抠图测试用的示例图：256×256 白底，中间一个橙色的圆。 */
function cutoutSample(): Uint8Array {
  const size = 256;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      const inside = (x - 128) ** 2 + (y - 128) ** 2 < 80 ** 2;
      data[o] = inside ? 240 : 255;
      data[o + 1] = inside ? 140 : 255;
      data[o + 2] = inside ? 60 : 255;
      data[o + 3] = 255;
    }
  }
  return new Uint8Array(encodeRgbaPng({ width: size, height: size, data }));
}
