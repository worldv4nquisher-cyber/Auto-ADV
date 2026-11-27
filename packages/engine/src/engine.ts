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
  EditorSettings,
  type Endpoint,
  type GenesisStepId,
  checkCustomApi,
  CustomApi,
  MEDIA_ROLE_APIS,
  MEDIA_ROLE_IDS,
  MediaRoleId,
  type MediaRoute,
  migrate,
  PlotGraph,
  RoleId,
  VariablesFile,
} from '@auto-adv/schema';
import type {
  AssetsChunk,
  CreateWorldParams,
  DeletedEntity,
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
  SaveWorldPartParams,
  SaveWorldPartResult,
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
import { missingInputs, staleSteps, stampInputs } from './genesis/inputs.ts';
import { type GenesisRunOptions, GenesisRunner, type RewriteChunk } from './genesis/pipeline.ts';
import { applyRenames, findRenames, type RenamePatch } from './world/rename.ts';
import { ModelGateway } from './llm/gateway.ts';
import { PlayService } from './play/runtime.ts';
import { checkWorldPlot } from './plot/session.ts';
import { assertWorldId, type WorldData, type WorldPartKey, WorldStore } from './world/store.ts';
import {
  allRevs,
  changedPaths,
  checkWorld,
  defaultsOf,
  type EntityKind,
  ID_PREFIX,
  mergeLocks,
  nextId,
  PART_SCHEMAS,
  parsePart,
  referencesTo,
  type RevKey,
  revOf,
  withoutReferences,
} from './world/edit.ts';
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
    this.worlds = new WorldStore(path.join(opts.dataDir, 'worlds'), {
      historyLimit: () => this.settings.peek()?.editor.historyLimit ?? 20,
    });
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
      editor: s.editor,
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

  /** 编辑器设置：只给要改的项也行，没给的留着原来的。 */
  async saveEditorSettings(settings: Partial<EditorSettings>): Promise<void> {
    await this.settings.update((s) => ({ ...s, editor: EditorSettings.parse({ ...s.editor, ...settings }) }));
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
    return {
      ...d,
      plotCheck: checkWorldPlot(world),
      summary: this.summarize(d),
      revs: allRevs(world),
      issues: checkWorld(world),
      editable: !this.genesis.isRunning(id),
      stale: staleSteps(world),
    };
  }

  /** M5 之前生成的世界没有输入哈希：第一次改动之前按现在的内容补上，当作"那时是新的"（20.4"过期"）。 */
  private async baseline(world: WorldData): Promise<void> {
    const missing = missingInputs(world);
    if (!missing.length) return;
    await this.worlds.updateManifest(world.manifest.id, (m) => {
      const steps = { ...m.genesis.steps };
      for (const id of missing) {
        const st = steps[id];
        if (st?.status === 'done' && !st.inputs) steps[id] = { ...st, ...stampInputs(world, id) };
      }
      return { ...m, genesis: { ...m.genesis, steps } };
    });
  }

  /** 过期的步骤不更新了：按现在的上游记下新的输入哈希。 */
  async acceptStale(p: { worldId: string; steps?: GenesisStepId[] }): Promise<WorldDetail> {
    const world = await this.editableWorld(p.worldId);
    const targets = new Set(p.steps ?? staleSteps(world).map((x) => x.step));
    await this.worlds.updateManifest(p.worldId, (m) => {
      const steps = { ...m.genesis.steps };
      for (const id of targets) {
        const st = steps[id];
        if (st?.status === 'done') steps[id] = { ...st, ...stampInputs(world, id) };
      }
      return { ...m, genesis: { ...m.genesis, steps } };
    });
    return this.getWorld(p.worldId);
  }

  /** 只重写一个角色、地点或设定条目（20.4"一个实体"）。 */
  rerollEntity(p: { worldId: string; kind: EntityKind; id: string; note?: string }, ctx: CallContext) {
    return fromCallback<RewriteChunk, WorldDetail>(async (emit) => {
      const world = await this.editableWorld(p.worldId);
      await this.baseline(world);
      await this.genesis.rewriteEntity(p.worldId, p, emit, ctx.signal);
      await this.worlds.updateManifest(p.worldId, (m) => m);
      void this.assets.refresh(p.worldId).catch(() => {});
      return this.getWorld(p.worldId);
    });
  }

  /** 只重写一个字段，返回新的文字（不保存）。 */
  rewriteField(p: { worldId: string; key: RevKey; path: string; data?: unknown; note?: string }, ctx: CallContext) {
    return fromCallback<RewriteChunk, { text: string }>(async (emit) => {
      assertWorldId(p.worldId);
      return { text: await this.genesis.rewriteField(p.worldId, p, emit, ctx.signal) };
    });
  }

  /** 改名之前：正文里还写着旧名字的地方（20.4"改名"）。 */
  async renameHits(p: { worldId: string; kind: 'character' | 'location'; id: string; to: string; draft?: unknown }) {
    assertWorldId(p.worldId);
    const world = await this.worlds.load(p.worldId);
    const item = (p.kind === 'character' ? world.characters : world.locations).find((x) => x.id === p.id);
    if (!item) return [];
    // 正在改的这一个按表单里的算（保存后才是它），解析不了就按存着的
    if (p.draft && typeof p.draft === 'object') {
      const data = { ...item, ...p.draft, id: p.id };
      if (p.kind === 'character') {
        const parsed = PART_SCHEMAS.character.safeParse(data);
        if (parsed.success) world.characters = world.characters.map((c) => (c.id === p.id ? parsed.data : c));
      } else {
        const parsed = PART_SCHEMAS.location.safeParse(data);
        if (parsed.success) world.locations = world.locations.map((l) => (l.id === p.id ? parsed.data : l));
      }
    }
    return findRenames(world, item.name, p.to.trim(), { kind: p.kind, id: p.id });
  }

  /** 把改名替换写回去（都记成你改的，进历史，不加锁）。 */
  private async writeRenames(worldId: string, world: WorldData, patch: RenamePatch): Promise<void> {
    if (patch.manifest) {
      const { title, logline } = patch.manifest;
      await this.worlds.updateManifest(worldId, (m) => ({ ...m, title: title.trim() || m.title, logline }));
    }
    if (patch.brief) await this.worlds.writeBrief(worldId, patch.brief, 'edit');
    if (patch.style) await this.worlds.writeStyle(worldId, patch.style, 'edit');
    if (patch.worldview !== undefined) await this.worlds.writeWorldview(worldId, patch.worldview, 'edit');
    for (const c of patch.characters) await this.worlds.writeCharacter(worldId, c, 'edit');
    for (const l of patch.locations) await this.worlds.writeLocation(worldId, l, 'edit');
    for (const e of patch.lore) await this.worlds.writeLoreEntry(worldId, e, 'edit');
    if (patch.graph) await this.worlds.writePlot(worldId, patch.graph, 'edit');
    if (patch.variables) await this.worlds.writeVariables(worldId, patch.variables, 'edit');
    if (patch.opening) await this.worlds.writeOpening(worldId, patch.opening, 'edit');
    for (const [sceneId, text] of Object.entries(patch.scripts)) {
      const scene = world.graph?.scenes.find((x) => x.id === sceneId);
      await this.worlds.writeScript(worldId, scene?.script ?? `${sceneId}.adv`, text, 'edit');
    }
  }

  /** 删掉的角色、地点、设定条目：历史里还在、现在没有了的（20.5"历史版本"）。 */
  async deletedEntities(p: { worldId: string }): Promise<DeletedEntity[]> {
    assertWorldId(p.worldId);
    const world = await this.worlds.load(p.worldId);
    const out: DeletedEntity[] = [];
    for (const kind of ['character', 'location', 'lore'] as const) {
      const list: { id: string }[] = kind === 'character' ? world.characters : kind === 'location' ? world.locations : world.lore;
      const now = new Set(list.map((x) => x.id));
      for (const id of await this.worlds.historyIds(p.worldId, kind)) {
        if (now.has(id)) continue;
        const key = `${kind}:${id}` as const;
        const last = (await this.worlds.listHistory(p.worldId, key))[0];
        if (!last) continue;
        const r = await this.worldHistoryRead({ worldId: p.worldId, key, name: last.name });
        const d = r.data as { name?: string; title?: string } | null;
        out.push({ kind, id, title: d?.name ?? d?.title ?? id, name: last.name, at: last.at, restorable: d !== null });
      }
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }

  /** 从历史里找回一个删掉的实体。id 已经被占了就换一个新的。删的时候一起去掉的引用不会回来。 */
  async restoreDeleted(p: { worldId: string; kind: EntityKind; id: string; name: string }): Promise<SaveWorldPartResult> {
    const world = await this.editableWorld(p.worldId);
    await this.baseline(world);
    const r = await this.worldHistoryRead({ worldId: p.worldId, key: `${p.kind}:${p.id}`, name: p.name });
    if (!r.data) throw Object.assign(new Error('这个版本的格式读不懂，没法找回'), { code: 'invalid' });
    const list: { id: string }[] = p.kind === 'character' ? world.characters : p.kind === 'location' ? world.locations : world.lore;
    const taken = list.map((x) => x.id);
    const id = taken.includes(p.id) ? nextId(ID_PREFIX[p.kind], [...taken, ...(await this.worlds.historyIds(p.worldId, p.kind))]) : p.id;
    if (p.kind === 'character') {
      const c = PART_SCHEMAS.character.parse({ ...(r.data as object), id });
      c.secrets = c.secrets.map((s) => (Array.isArray(s.knownBy) ? { ...s, knownBy: s.knownBy.map((x) => (x === p.id ? id : x)) } : s));
      await this.worlds.writeCharacter(p.worldId, c, 'edit');
    } else if (p.kind === 'location') {
      await this.worlds.writeLocation(p.worldId, PART_SCHEMAS.location.parse({ ...(r.data as object), id }), 'edit');
    } else {
      await this.worlds.writeLoreEntry(p.worldId, PART_SCHEMAS.lore.parse({ ...(r.data as object), id }), 'edit');
    }
    await this.worlds.updateManifest(p.worldId, (m) => m);
    void this.assets.refresh(p.worldId).catch(() => {});
    return { key: `${p.kind}:${id}`, world: await this.getWorld(p.worldId) };
  }

  // ───────────── 世界编辑器（20.5） ─────────────

  private async editableWorld(worldId: string): Promise<WorldData> {
    assertWorldId(worldId);
    if (this.genesis.isRunning(worldId)) {
      throw Object.assign(new Error('这个世界正在生成，等生成完再改'), { code: 'busy' });
    }
    return this.worlds.load(worldId);
  }

  /** 保存一块内容：校验、检查版本号、手改的字段自动锁住、旧版本进历史，然后重算素材清单。 */
  async saveWorldPart(p: SaveWorldPartParams): Promise<SaveWorldPartResult> {
    const world = await this.editableWorld(p.worldId);
    await this.baseline(world);
    const { autoLock, rename: renameMode } = (await this.settings.get()).editor;
    let rename: { kind: 'character' | 'location'; id: string; from: string; to: string } | null = null;
    const unlocked = new Set(p.unlocked ?? []);
    const now = new Date().toISOString();
    const check = (key: RevKey) => {
      if (p.base && p.base !== revOf(world, key)) {
        throw Object.assign(new Error('这块内容在你打开以后被改过（可能是创世或者另一个窗口），请重新打开再改'), { code: 'conflict' });
      }
    };
    /** 实体：手改的字段加进 _meta.locked，改过内容的记成你写的。 */
    const stamp = <T extends { _meta: { locked: string[]; generatedBy?: string; updatedAt?: string } }>(
      before: T | null,
      next: T,
      part: Parameters<typeof defaultsOf>[0],
    ): T => {
      const changed = changedPaths(before ?? defaultsOf(part, (next as { id?: string }).id), next);
      const locked = autoLock ? mergeLocks(next._meta.locked, changed.filter((x) => !unlocked.has(x))) : next._meta.locked;
      return {
        ...next,
        _meta: { ...next._meta, locked, ...(changed.length ? { generatedBy: 'user', updatedAt: now } : {}) },
      };
    };
    /** 没有 _meta 的几块：锁记在 world.json 的 locked 里。 */
    const lockPart = async (name: string, changed: boolean) => {
      const want = p.lock ?? (autoLock && changed && !unlocked.has(name) ? true : undefined);
      if (want === undefined) return;
      await this.worlds.updateManifest(p.worldId, (m) => ({
        ...m,
        locked: want ? [...new Set([...m.locked, name])] : m.locked.filter((x) => x !== name),
      }));
    };
    let key: RevKey;
    switch (p.part) {
      case 'manifest': {
        key = 'manifest';
        check(key);
        const title = p.data.title.trim();
        if (!title) throw Object.assign(new Error('世界名不能为空'), { code: 'invalid' });
        const logline = p.data.logline.trim();
        const m = world.manifest;
        const changed = [...(title !== m.title ? ['title'] : []), ...(logline !== m.logline ? ['logline'] : [])];
        await this.worlds.updateManifest(p.worldId, (x) => {
          const base = p.data.locked ?? x.locked;
          const locked = autoLock ? mergeLocks(base, changed.filter((c) => !unlocked.has(c))) : base;
          return { ...x, title, logline, locked };
        });
        break;
      }
      case 'brief': {
        key = 'brief';
        check(key);
        const next = stamp(world.brief, parsePart(PART_SCHEMAS.brief, p.data, '世界简报'), 'brief');
        await this.worlds.writeBrief(p.worldId, next, 'edit');
        break;
      }
      case 'style': {
        key = 'style';
        check(key);
        const next = stamp(world.style, parsePart(PART_SCHEMAS.style, p.data, '风格'), 'style');
        await this.worlds.writeStyle(p.worldId, next, 'edit');
        break;
      }
      case 'worldview': {
        key = 'worldview';
        check(key);
        const text = String(p.data ?? '');
        await this.worlds.writeWorldview(p.worldId, text, 'edit');
        await lockPart('worldview', text.trim() !== world.worldview.trim());
        break;
      }
      case 'variables': {
        key = 'variables';
        check(key);
        const vars = parsePart(PART_SCHEMAS.variables, p.data, '数值表');
        const dup = vars.find((v, i) => vars.findIndex((x) => x.id === v.id) !== i);
        if (dup) throw Object.assign(new Error(`数值表里的 ${dup.id} 重复了`), { code: 'invalid' });
        await this.worlds.writeVariables(p.worldId, vars, 'edit');
        await lockPart('variables', JSON.stringify(vars) !== JSON.stringify(world.variables));
        break;
      }
      case 'opening': {
        key = 'opening';
        check(key);
        const next = stamp(world.opening, parsePart(PART_SCHEMAS.opening, p.data, '开场'), 'opening');
        await this.worlds.writeOpening(p.worldId, next, 'edit');
        break;
      }
      case 'character':
      case 'location':
      case 'lore': {
        const kind = p.part;
        const list: { id: string }[] =
          kind === 'character' ? world.characters : kind === 'location' ? world.locations : world.lore;
        const id = p.data.id || nextId(ID_PREFIX[kind], [...list.map((x) => x.id), ...(await this.worlds.historyIds(p.worldId, kind))]);
        const before = list.find((x) => x.id === id) as { name?: string } | undefined;
        if (kind !== 'lore' && before?.name && p.data.name && before.name !== p.data.name.trim()) {
          rename = { kind, id, from: before.name, to: p.data.name.trim() };
        }
        key = `${kind}:${id}`;
        check(key);
        const label = { character: '角色', location: '地点', lore: '设定条目' }[kind];
        if (kind === 'character') {
          const parsed = parsePart(PART_SCHEMAS.character, { ...p.data, id }, label);
          // 自己的秘密自己总是知道（新角色在保存前还没有 id，界面上没法勾自己）
          parsed.secrets = parsed.secrets.map((x) =>
            Array.isArray(x.knownBy) && !x.knownBy.includes(id) ? { ...x, knownBy: [id, ...x.knownBy] } : x,
          );
          const next = stamp(world.characters.find((c) => c.id === id) ?? null, parsed, kind);
          await this.worlds.writeCharacter(p.worldId, next, 'edit');
        } else if (kind === 'location') {
          const next = stamp(world.locations.find((l) => l.id === id) ?? null, parsePart(PART_SCHEMAS.location, { ...p.data, id }, label), kind);
          await this.worlds.writeLocation(p.worldId, next, 'edit');
        } else {
          const next = stamp(world.lore.find((e) => e.id === id) ?? null, parsePart(PART_SCHEMAS.lore, { ...p.data, id }, label), kind);
          await this.worlds.writeLoreEntry(p.worldId, next, 'edit');
        }
        break;
      }
      default:
        throw Object.assign(new Error('不认识的内容'), { code: 'invalid' });
    }
    // 改名：正文里的旧名字按选的换掉（不给就按设置：总是替换才全换）
    let renamed: number | undefined;
    const groups = p.rename?.groups ?? (renameMode === 'always' ? 'all' : []);
    if (rename && (groups === 'all' || groups.length)) {
      const after = await this.worlds.load(p.worldId);
      const patch = applyRenames(after, rename.from, rename.to, groups, rename);
      await this.writeRenames(p.worldId, after, patch);
      renamed = patch.count;
    }
    await this.worlds.updateManifest(p.worldId, (m) => m);
    void this.assets.refresh(p.worldId).catch(() => {});
    return { key, world: await this.getWorld(p.worldId), ...(renamed !== undefined ? { renamed } : {}) };
  }

  /** 删掉一个角色、地点或设定条目；removeRefs 时先把别处能去掉的引用去掉（20.5"删除"）。 */
  async deleteWorldPart(p: { worldId: string; kind: EntityKind; id: string; removeRefs: boolean }): Promise<WorldDetail> {
    const world = await this.editableWorld(p.worldId);
    await this.baseline(world);
    const key = `${p.kind}:${p.id}` as const;
    const list: { id: string }[] =
      p.kind === 'character' ? world.characters : p.kind === 'location' ? world.locations : world.lore;
    if (!list.some((x) => x.id === p.id)) throw new Error('要删的内容不存在，可能已经删掉了');
    if (p.removeRefs) {
      const patch = withoutReferences(world, p.kind, p.id);
      const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
      for (const c of patch.characters ?? []) {
        if (!same(c, world.characters.find((x) => x.id === c.id))) await this.worlds.writeCharacter(p.worldId, c, 'edit');
      }
      for (const l of patch.locations ?? []) {
        if (!same(l, world.locations.find((x) => x.id === l.id))) await this.worlds.writeLocation(p.worldId, l, 'edit');
      }
      for (const e of patch.lore ?? []) {
        if (!same(e, world.lore.find((x) => x.id === e.id))) await this.worlds.writeLoreEntry(p.worldId, e, 'edit');
      }
      if (patch.graph) await this.worlds.writePlot(p.worldId, patch.graph, 'edit');
      if (patch.opening) await this.worlds.writeOpening(p.worldId, patch.opening, 'edit');
    }
    await this.worlds.deleteEntity(p.worldId, key);
    await this.worlds.updateManifest(p.worldId, (m) => m);
    void this.assets.refresh(p.worldId).catch(() => {});
    return this.getWorld(p.worldId);
  }

  async worldReferences(p: { worldId: string; kind: EntityKind; id: string }) {
    assertWorldId(p.worldId);
    return referencesTo(await this.worlds.load(p.worldId), p.kind, p.id);
  }

  /** 读一个历史版本，顺带转成能直接保存的内容（数值表只要列表）。 */
  async worldHistoryRead(p: { worldId: string; key: WorldPartKey; name: string }): Promise<{ text: string; data: unknown }> {
    assertWorldId(p.worldId);
    const text = await this.worlds.readHistory(p.worldId, p.key, p.name);
    if (p.key === 'worldview') return { text, data: text };
    // 按现在的格式补全默认值（旧版本、手写的文件可能缺字段）；读不懂的给 null，界面上只能看不能用
    let raw: unknown;
    try {
      raw = migrate(JSON.parse(text));
    } catch {
      return { text, data: null };
    }
    const kind = p.key.split(':')[0] as string;
    const schema =
      kind === 'variables' ? VariablesFile : kind === 'plot' ? PlotGraph : PART_SCHEMAS[kind as keyof typeof PART_SCHEMAS];
    const r = schema?.safeParse(raw);
    if (!r?.success) return { text, data: null };
    return { text, data: kind === 'variables' ? (r.data as VariablesFile).variables : r.data };
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

  runGenesis(worldId: string, opts: GenesisRunOptions, ctx: CallContext) {
    return fromCallback<GenesisChunk, WorldSummary>(async (emit) => {
      assertWorldId(worldId);
      // 重抽某一步之前先给没有输入哈希的步骤补上，这样它的下游之后能标过期
      if (!this.genesis.isRunning(worldId)) await this.baseline(await this.worlds.load(worldId));
      await this.genesis.run(worldId, opts, this.withAssets(emit, () => worldId), ctx.signal);
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
      saveEditorSettings: (p) => this.saveEditorSettings(p.settings),
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
      saveWorldPart: (p) => this.saveWorldPart(p),
      deleteWorldPart: (p) => this.deleteWorldPart(p),
      worldReferences: (p) => this.worldReferences(p),
      worldHistory: (p) => (assertWorldId(p.worldId), this.worlds.listHistory(p.worldId, p.key)),
      worldHistoryRead: (p) => this.worldHistoryRead(p),
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
      runGenesis: (p, ctx) =>
        this.runGenesis(
          p.worldId,
          { ...(p.from ? { from: p.from } : {}), ...(p.steps ? { steps: p.steps } : {}), ...(p.note ? { note: p.note } : {}) },
          ctx,
        ),
      acceptStale: (p) => this.acceptStale(p),
      rerollEntity: (p, ctx) => this.rerollEntity(p, ctx),
      rewriteField: (p, ctx) => this.rewriteField(p, ctx),
      renameHits: (p) => this.renameHits(p),
      deletedEntities: (p) => this.deletedEntities(p),
      restoreDeleted: (p) => this.restoreDeleted(p),

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
