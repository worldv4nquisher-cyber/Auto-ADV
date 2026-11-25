/**
 * M4 第 1 步：素材槽、素材清单、队列、缓存、背景（docs/ARCHITECTURE.md 18.2～18.4）。
 */
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { decodePng, type RgbaImage } from '@auto-adv/providers';
import { encodePng, type MockServer, type MockServerOptions, mockMusic, mockSprite, startMockServer } from '@auto-adv/providers/testing';
import { AssetIndex, AssetSettings, BgmSettings } from '@auto-adv/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { type AssetsView, createPortPair, Engine, type EngineContract, MemorySecretStore, RpcClient, serveRpc } from '../src/index.ts';
import { checkAlpha, hasTransparentBackdrop, keyOut } from '../src/assets/cutout.ts';
import { type PlannedSlot, planAssets, priorityOf } from '../src/assets/plan.ts';
import { BUILTIN_TEMPLATES, DEFAULT_ART_STYLE, renderTemplate } from '../src/assets/templates.ts';
import { WorldStore } from '../src/world/store.ts';

const EXAMPLES = path.resolve(import.meta.dirname, '../../../examples/worlds');

let dir: string;
let server: MockServer;
let engine: Engine;
let client: RpcClient<EngineContract>;
let endpointId = '';
let open = false;

async function teardown() {
  if (!open) return;
  open = false;
  client.close();
  engine.close();
  await server.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
}

afterEach(teardown);

/**
 * 导入示例世界。默认去掉手写剧本、关掉立绘，只剩 3 个地点的背景；
 * scripts: true 时连剧本一起导入（再加 5 张剧本里的背景）；sprites: true 时画立绘（沈默、林夕各 6 个表情，老周 3 个）。
 * image：要不要配好图像职责。
 */
async function setup(
  opts: {
    image?: boolean;
    mock?: MockServerOptions;
    assets?: Partial<AssetSettings>;
    scripts?: boolean;
    sprites?: boolean;
    /** 配好音乐职责。 */
    music?: boolean;
    /** 内置曲库的文件夹。 */
    builtin?: string;
    /** 配好「默认」文本职责（本地曲库按文件名挑情绪用）。 */
    text?: boolean;
  } = {},
) {
  await teardown();
  open = true;
  dir = await mkdtemp(path.join(os.tmpdir(), 'auto-adv-assets-'));
  server = await startMockServer({ chunkDelayMs: 0, ...opts.mock });
  engine = new Engine({
    dataDir: dir,
    secrets: new MemorySecretStore(),
    callLogFile: ':memory:',
    assetRetryBaseMs: 1,
    ...(opts.builtin ? { builtinBgmDir: opts.builtin } : {}),
  });
  const [a, b] = createPortPair();
  serveRpc(a, engine.handlers());
  client = new RpcClient<EngineContract>(b);
  const ep = await client.call('saveEndpoint', {
    name: '模拟服务',
    baseURL: server.baseURL,
    models: ['mock-chat'],
    currency: 'CNY',
    pricing: {},
  });
  endpointId = ep.id;
  const sprites = !!opts.sprites;
  await client.call('saveAssetSettings', {
    settings: AssetSettings.parse({ ...opts.assets, enabled: { sprite: sprites, expression: sprites, ...opts.assets?.enabled } }),
  });
  let src = path.join(EXAMPLES, 'old_library');
  if (!opts.scripts) {
    src = path.join(dir, 'src', 'old_library');
    await cp(path.join(EXAMPLES, 'old_library'), src, { recursive: true });
    await rm(path.join(src, 'plot', 'scenes'), { recursive: true, force: true });
  }
  const w = await client.call('importWorld', { path: src });
  if (opts.text) await client.call('setRole', { role: 'default', route: { endpointId, model: 'mock-chat' } });
  if (opts.music) await setMusic();
  if (opts.image !== false) await setImage();
  return w.id;
}

const setMusic = () => client.call('setMediaRole', { role: 'music', route: { endpointId, model: 'mock-music', api: 'minimax' } });

const setImage = () => client.call('setMediaRole', { role: 'image', route: { endpointId, model: 'mock-image', api: 'openai' } });

/** 等到素材管线停下来（没有在画的，也没有排着队的）。 */
async function idle(worldId: string, timeoutMs = 5000): Promise<AssetsView> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await client.call('assetsView', { worldId });
    if (!v.state.working && v.counts.running === 0) return v;
    if (Date.now() > until) throw new Error(`素材一直没画完：${JSON.stringify(v.counts)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const slot = (v: AssetsView, id: string) => {
  const s = v.slots.find((x) => x.id === id);
  if (!s) throw new Error(`没有槽 ${id}`);
  return s;
};
const prompts = () => server.imageRequests.map((r) => String(r.prompt));

describe('提示词模板', () => {
  it('占位符全是空的那一行去掉，不认识的占位符原样保留', () => {
    expect(renderTemplate('{画风}\n时代和题材：{世界}\n场景：{内容}\n{其他}', { 画风: '水彩', 世界: '', 内容: '海堤' })).toBe(
      '水彩\n场景：海堤\n{其他}',
    );
  });

  it('背景的提示词：画风、地点、构图、要避免的东西；世界没写画风用默认画风，设置里的模板和尺寸生效', async () => {
    const store = new WorldStore(EXAMPLES);
    const world = await store.load('old_library');
    const base = AssetSettings.parse({});
    const plan = planAssets(world, base, AssetIndex.parse({})).filter((p) => p.kind === 'background');
    expect(plan.map((p) => p.id)).toEqual([
      'bg/loc_archive',
      'bg/loc_reading',
      'bg/loc_seaside',
      'bg/reading_evening',
      'bg/archive_door',
      'bg/archive_inner',
      'bg/seaside_dawn',
      'bg/book_sea',
    ]);
    const sea = plan[2];
    expect(sea?.params.prompt).toContain(DEFAULT_ART_STYLE);
    expect(sea?.params.prompt).toContain('场景：海堤。城市边缘的海堤');
    expect(sea?.params.prompt).toContain('画面里没有人物');
    expect(sea?.params.prompt).toContain('画面里不要有：人物、文字、水印、画框');
    expect(sea?.params.size).toBe('1536x1024');
    expect(sea?.defaultPrompt).toBe(sea?.params.prompt);

    const styled = planAssets(
      { ...world, style: { formatVersion: 1, prose: { pov: 'third', description: '', samples: [] }, art: { prompt: '厚涂油画', negative: '低清晰度' }, music: { description: '' }, _meta: { locked: [] } } },
      AssetSettings.parse({ templates: { background: '{画风}｜{内容}｜{避免}' }, sizes: { background: '1280x720' } }),
      AssetIndex.parse({}),
    );
    expect(styled[2]?.params.prompt).toBe('厚涂油画｜海堤。城市边缘的海堤，退潮时能走到很远。｜人物、文字、水印、画框、低清晰度');
    expect(styled[2]?.params.size).toBe('1280x720');
    expect(BUILTIN_TEMPLATES.background).toContain('{构图}');
  });

  it('你改过的提示词和重抽次数进参数哈希', async () => {
    const world = await new WorldStore(EXAMPLES).load('old_library');
    const s = AssetSettings.parse({});
    const a = planAssets(world, s, AssetIndex.parse({}))[0];
    const b = planAssets(world, s, AssetIndex.parse({ slots: { 'bg/loc_archive': { id: 'bg/loc_archive', variant: 1 } } }))[0];
    const c = planAssets(world, s, AssetIndex.parse({ slots: { 'bg/loc_archive': { id: 'bg/loc_archive', prompt: '自己写的' } } }))[0];
    expect(new Set([a?.paramsHash, b?.paramsHash, c?.paramsHash]).size).toBe(3);
    expect(c?.params.prompt).toBe('自己写的');
    expect(c?.defaultPrompt).toBe(a?.params.prompt);
  });

  it('优先级：当前地点 → 当前幕和紧接着的幕的地点 → 其余', async () => {
    const world = await new WorldStore(EXAMPLES).load('old_library');
    const plan = planAssets(world, AssetSettings.parse({}), AssetIndex.parse({})).filter((p) => p.kind === 'background');
    const pr = (focus: Parameters<typeof priorityOf>[2]) => plan.map((p) => priorityOf(p, world, focus));
    // 没在玩：开始的幕在阅览室，它通往旧书库。剧本里的背景跟着幕走：sc_01 的先画，紧接着的 sc_02 其次
    expect(pr(null)).toEqual([2, 2, 4, 1, 2, 4, 4, 4]);
    expect(pr({ locationId: 'loc_seaside', characterIds: [], sceneId: 'sc_01' })).toEqual([2, 2, 1, 1, 2, 4, 4, 4]);
    expect(pr({ locationId: 'loc_archive', characterIds: [], sceneId: 'sc_03' })).toEqual([1, 4, 2, 4, 4, 1, 2, 2]);
  });

  it('手写剧本里的背景：不是地点 id 的每个 id 一张，用那一幕的地点、标题和第一句旁白描述画面', async () => {
    const world = await new WorldStore(EXAMPLES).load('old_library');
    const plan = planAssets(world, AssetSettings.parse({}), AssetIndex.parse({})).filter((p) => p.kind === 'background');
    const door = plan.find((p) => p.id === 'bg/archive_door');
    expect(door).toMatchObject({ kind: 'background', dir: 'bg', slug: 'archive_door', locationId: 'loc_archive', sceneIds: ['sc_02'] });
    expect(door?.title).toBe('旧书库的门 · archive_door');
    expect(door?.subtitle).toBe('剧本里的背景，用在「旧书库的门」，地点：旧书库');
    expect(door?.params.prompt).toContain('场景：旧书库。图书馆地下的旧书库，铁门上挂着刻有潮汐纹路的锁。旧书库的门');
    expect(door?.params.prompt).toContain('旧书库的铁门上挂着一把生了锈的密码锁，锁面刻着潮汐的纹路');
    expect(door?.params.prompt).toContain('画面里不要有：人物、文字、水印、画框');
    // 结局幕没写地点：只用幕的标题、内容和旁白
    const sea = plan.find((p) => p.id === 'bg/book_sea');
    expect(sea?.locationId).toBeUndefined();
    expect(sea?.params.prompt).toContain('场景：书中人。两人翻开无名之书，发现姐姐住进了书里。书页翻开的瞬间');
    // 剧本里直接用地点 id 当背景的，不另开槽
    const reused = planAssets(
      { ...world, scripts: { ...world.scripts, sc_04: 'bg loc_archive\nnarrate "门外。"\nbg archive_door' } },
      AssetSettings.parse({}),
      AssetIndex.parse({}),
    );
    expect(reused.filter((p) => p.id === 'bg/loc_archive')).toHaveLength(1);
    expect(reused.find((p) => p.id === 'bg/archive_door')?.sceneIds).toEqual(['sc_02', 'sc_04']);
    expect(reused.filter((p) => p.kind === 'background')).toHaveLength(8);
  });
});

describe('素材管线', () => {
  it('没配图像职责：全部待生成，不调接口，世界照样能玩', async () => {
    const id = await setup({ image: false });
    const v = await client.call('assetsView', { worldId: id });
    expect(v.state.needsModel).toBe(true);
    expect(v.state.working).toBe(false);
    expect(v.slots.filter((s) => s.kind === 'background').map((s) => s.status)).toEqual(['pending', 'pending', 'pending']);
    expect(server.imageRequests).toHaveLength(0);
  });

  it('配好图像职责后每个地点画一张背景，存进世界的 assets/，登记和调用日志都有', async () => {
    const id = await setup({ image: false });
    await client.call('assetsView', { worldId: id });
    await setImage();
    const v = await idle(id);
    expect(v.counts).toMatchObject({ total: 3, done: 3, pending: 0, failed: 0 });
    expect(server.imageRequests).toHaveLength(3);
    expect(server.imageRequests[0]).toMatchObject({ model: 'mock-image', size: '1536x1024', response_format: 'b64_json', n: 1 });
    const sea = slot(v, 'bg/loc_seaside');
    expect(sea.file).toMatch(/^assets\/bg\/loc_seaside-[0-9a-f]{12}\.png$/);
    expect(sea.revisedPrompt).toMatch(/^（改写）/);
    expect(sea.model).toBe('mock-image');
    const worldDir = path.join(dir, 'worlds', id);
    expect(existsSync(path.join(worldDir, sea.file ?? ''))).toBe(true);
    const index = AssetIndex.parse(JSON.parse(await readFile(path.join(worldDir, 'assets', 'index.json'), 'utf8')));
    expect(index.generated).toBe(3);
    expect(Object.keys(index.slots).sort()).toEqual(['bg/loc_archive', 'bg/loc_reading', 'bg/loc_seaside']);
    const calls = await client.call('listCalls', {});
    expect(calls.items.filter((c) => c.role === 'image' && c.tag === 'assets.background' && c.status === 'ok')).toHaveLength(3);

    // 已经画好的不会再画
    await client.call('assetsView', { worldId: id });
    await idle(id);
    expect(server.imageRequests).toHaveLength(3);
  });

  it('按"马上要用"排队：游玩时所在的地点先画', async () => {
    const id = await setup({ image: false, mock: { imageDelayMs: 20 }, assets: { imageConcurrency: 1 } });
    await engine.assets.focus(id, { locationId: 'loc_seaside', characterIds: [], sceneId: 'sc_01' });
    await setImage();
    await idle(id);
    expect(prompts()[0]).toContain('海堤');
  });

  it('同一个接入点同时只画设置里的张数', async () => {
    const id = await setup({ image: false, mock: { imageDelayMs: 40 }, assets: { imageConcurrency: 2 } });
    await client.call('assetsView', { worldId: id });
    await setImage();
    await new Promise((r) => setTimeout(r, 15));
    const v = await client.call('assetsView', { worldId: id });
    expect(v.counts.running).toBe(2);
    expect(v.counts.pending).toBe(1);
    await idle(id);
  });

  it('重抽画一张新的，旧的进历史可以换回去（换回去就锁定）', async () => {
    const id = await setup();
    const before = slot(await idle(id), 'bg/loc_seaside').file;
    await client.call('assetAction', { worldId: id, slotId: 'bg/loc_seaside', action: 'regenerate' });
    const v = await idle(id);
    const sea = slot(v, 'bg/loc_seaside');
    expect(sea.file).not.toBe(before);
    expect(sea.history.map((h) => h.file)).toEqual([before]);
    expect(server.imageRequests).toHaveLength(4);
    expect(v.state.cap.used).toBe(4);

    const back = await client.call('assetAction', { worldId: id, slotId: 'bg/loc_seaside', action: 'use', file: before ?? '' });
    expect(slot(back, 'bg/loc_seaside')).toMatchObject({ file: before, locked: true, status: 'done' });
    await expect(client.call('assetAction', { worldId: id, slotId: 'bg/loc_seaside', action: 'regenerate' })).rejects.toThrow(/先解锁/);
  });

  it('改提示词：先标成过期，点了才重画；改回原来的提示词直接用缓存，不再调接口', async () => {
    const id = await setup();
    const first = slot(await idle(id), 'bg/loc_reading');
    let v = await client.call('assetSetPrompt', { worldId: id, slotId: 'bg/loc_reading', prompt: '夜里的阅览室，只开着一盏台灯' });
    expect(slot(v, 'bg/loc_reading')).toMatchObject({ status: 'stale', staleBy: 'params', promptEdited: true });
    v = await idle(id);
    expect(server.imageRequests).toHaveLength(3);

    await client.call('assetAction', { worldId: id, slotId: 'bg/loc_reading', action: 'redraw' });
    v = await idle(id);
    expect(slot(v, 'bg/loc_reading').status).toBe('done');
    expect(prompts()[3]).toBe('夜里的阅览室，只开着一盏台灯');

    await client.call('assetSetPrompt', { worldId: id, slotId: 'bg/loc_reading', prompt: null, redraw: true });
    v = await idle(id);
    expect(slot(v, 'bg/loc_reading')).toMatchObject({ status: 'done', file: first.file, promptEdited: false });
    expect(server.imageRequests).toHaveLength(4);
    expect(v.state.cap.used).toBe(4);
  });

  it('世界里的设置覆盖全局：改了尺寸全部过期，"全部重画"才重画；锁定的只提示改过', async () => {
    const id = await setup();
    await idle(id);
    await client.call('assetAction', { worldId: id, slotId: 'bg/loc_archive', action: 'lock' });
    let v = await client.call('saveWorldAssetSettings', { worldId: id, patch: { sizes: { background: '1024x576' } } });
    expect(v.settings.effective.sizes.background).toBe('1024x576');
    expect(v.settings.global.sizes.background).toBe('1536x1024');
    expect(slot(v, 'bg/loc_archive')).toMatchObject({ status: 'done', locked: true, upstreamChanged: true });
    expect(v.counts.stale).toBe(2);
    await idle(id);
    expect(server.imageRequests).toHaveLength(3);

    await client.call('assetsControl', { worldId: id, action: 'redrawStale' });
    v = await idle(id);
    expect(v.counts.stale).toBe(0);
    expect(server.imageRequests.slice(3).map((r) => r.size)).toEqual(['1024x576', '1024x576']);
    expect(existsSync(path.join(dir, 'worlds', id, 'assets', 'settings.json'))).toBe(true);
  });

  it('失败：429 / 5xx 退避重试；被拒绝的不重试，标成失败，点了重试再画', async () => {
    let id = await setup({ mock: { imageFailFirst: 2 } });
    let v = await idle(id);
    expect(v.counts.done).toBe(3);
    expect(server.imageRequests).toHaveLength(5);

    id = await setup({ mock: { imageRejectIf: '海堤' } });
    v = await idle(id);
    expect(slot(v, 'bg/loc_seaside')).toMatchObject({ status: 'failed', file: null });
    expect(slot(v, 'bg/loc_seaside').error).toMatch(/HTTP 400.*safety/);
    expect(server.imageRequests).toHaveLength(3);
    // 失败了也不会自动一直重试
    await client.call('assetsView', { worldId: id });
    await idle(id);
    expect(server.imageRequests).toHaveLength(3);
    await client.call('assetAction', { worldId: id, slotId: 'bg/loc_seaside', action: 'retry' });
    v = await idle(id);
    expect(server.imageRequests).toHaveLength(4);
    expect(slot(v, 'bg/loc_seaside').status).toBe('failed');
  });

  it('图片张数上限：到了就停下来，放宽之后接着画', async () => {
    const id = await setup({ assets: { imageCap: 2, imageConcurrency: 1 } });
    let v = await idle(id);
    expect(v.counts.done).toBe(2);
    expect(v.state.cap).toMatchObject({ used: 2, limit: 2, reached: true, action: 'ask' });
    await client.call('assetsControl', { worldId: id, action: 'raiseCap' });
    v = await idle(id);
    expect(v.counts.done).toBe(3);
    expect(v.state.cap).toMatchObject({ used: 3, limit: 22, reached: false });
  });

  it('暂停、关掉背景：都不画', async () => {
    let id = await setup({ image: false });
    await client.call('assetsControl', { worldId: id, action: 'pause' });
    await setImage();
    let v = await idle(id);
    expect(v.state.paused).toBe(true);
    expect(server.imageRequests).toHaveLength(0);
    await client.call('assetsControl', { worldId: id, action: 'resume' });
    v = await idle(id);
    expect(v.counts.done).toBe(3);

    id = await setup({ assets: { enabled: { background: false } as AssetSettings['enabled'] } });
    v = await idle(id);
    expect(v.slots.filter((s) => s.kind === 'background').map((s) => s.status)).toEqual(['disabled', 'disabled', 'disabled']);
    expect(v.counts.total).toBe(0);
    expect(server.imageRequests).toHaveLength(0);
  });

  it('换成自己的图：复制进世界并锁定；只认图片', async () => {
    const id = await setup({ image: false });
    const png = path.join(dir, 'mine.png');
    await writeFile(png, encodePng(4, 4, () => [10, 20, 30, 255]));
    const v = await client.call('assetUpload', { worldId: id, slotId: 'bg/loc_archive', path: png });
    const s = slot(v, 'bg/loc_archive');
    expect(s).toMatchObject({ status: 'done', locked: true, source: 'uploaded' });
    expect(s.file).toMatch(/^assets\/uploads\/bg-loc_archive-[0-9a-f]{12}\.png$/);
    expect(existsSync(path.join(dir, 'worlds', id, s.file ?? ''))).toBe(true);
    const txt = path.join(dir, 'note.txt');
    await writeFile(txt, 'hello');
    await expect(client.call('assetUpload', { worldId: id, slotId: 'bg/loc_archive', path: txt })).rejects.toThrow(/PNG/);
  });

  it('地点删掉以后它的槽列为不再需要，清理时删掉文件', async () => {
    const id = await setup();
    const v0 = await idle(id);
    const file = slot(v0, 'bg/loc_seaside').file ?? '';
    await rm(path.join(dir, 'worlds', id, 'locations', 'loc_seaside.json'));
    let v = await client.call('assetsView', { worldId: id });
    expect(v.slots.filter((s) => s.kind === 'background')).toHaveLength(2);
    expect(v.orphans).toEqual([{ id: 'bg/loc_seaside', file }]);
    v = await client.call('assetsControl', { worldId: id, action: 'cleanOrphans' });
    expect(v.orphans).toEqual([]);
    expect(existsSync(path.join(dir, 'worlds', id, file))).toBe(false);
  });

  it('订阅：画好一张推一次', async () => {
    const id = await setup({ image: false });
    const ctrl = new AbortController();
    const seen: number[] = [];
    const done = client.stream('assetsWatch', { worldId: id }, (c) => seen.push(c.view.counts.done), ctrl.signal).catch(() => {});
    await new Promise((r) => setTimeout(r, 20));
    await setImage();
    await idle(id);
    await new Promise((r) => setTimeout(r, 20));
    ctrl.abort();
    await done;
    expect(seen[0]).toBe(0);
    expect(seen.at(-1)).toBe(3);
  });

  it('删除世界时停掉它的素材', async () => {
    const id = await setup({ mock: { imageDelayMs: 50 } });
    await client.call('assetsView', { worldId: id });
    await new Promise((r) => setTimeout(r, 10));
    await client.call('deleteWorld', { id });
    expect(existsSync(path.join(dir, 'worlds', id))).toBe(false);
  });

  it('设置页：测试图像职责，返回一张图', async () => {
    await setup();
    const r = await client.call('testImage', {});
    expect(r.dataUrl).toMatch(/^data:image\/png;base64,/);
    const s = await client.call('getSettings');
    expect(s.media.image).toEqual({ endpointId, model: 'mock-image', api: 'openai' });
    expect(s.assetDefaults.templates.background).toContain('{画风}');
  });
});

describe('手写剧本的背景', () => {
  it('带剧本导入：地点和剧本里的背景都画，舞台上剧本用的 id 有图', async () => {
    const id = await setup({ scripts: true });
    const v = await idle(id);
    expect(v.counts).toMatchObject({ total: 8, done: 8 });
    expect(slot(v, 'bg/reading_evening').file).toMatch(/^assets\/bg\/reading_evening-[0-9a-f]{12}\.png$/);
    expect(server.imageRequests).toHaveLength(8);
  });
});

// ───────────── 第 2 步：立绘 ─────────────

const rgba = (png: Uint8Array) => decodePng(png);
const alphaAt = (img: RgbaImage, x: number, y: number) => img.data[(y * img.width + x) * 4 + 3];

describe('内置抠图和透明度检查', () => {
  it('纯白底、纯绿底、偏灰的白底都能抠干净；人物不透明，边缘半透明', () => {
    for (const backdrop of ['white', 'green'] as const) {
      const img = rgba(mockSprite('角色立绘', 64, 96, backdrop));
      expect(hasTransparentBackdrop(img)).toBe(false);
      const cut = keyOut(img);
      expect(alphaAt(cut, 0, 0)).toBe(0);
      expect(alphaAt(cut, 63, 40)).toBe(0);
      expect(alphaAt(cut, 32, 25)).toBe(255); // 脸
      expect(alphaAt(cut, 32, 90)).toBe(255); // 身子
      expect(hasTransparentBackdrop(cut)).toBe(true);
      const check = checkAlpha(cut);
      expect(check.ok).toBe(true);
      expect(check.coverage).toBeGreaterThan(0.15);
      expect(check.coverage).toBeLessThan(0.7);
    }
    const grey = rgba(encodePng(40, 60, (x, y) => (Math.abs(x - 20) < 8 && y > 10 ? [90, 40, 40, 255] : [238, 238, 230, 255])));
    expect(alphaAt(keyOut(grey), 0, 0)).toBe(0);
  });

  it('被人物围起来的大块底色也去掉，小块的高光留着', () => {
    // 一个"口"字形的人物：中间 10x10 的白底（大块），右上角 1 个白点（高光）
    const img = rgba(
      encodePng(40, 60, (x, y) => {
        const inFrame = x >= 8 && x < 32 && y >= 10;
        const hole = x >= 15 && x < 25 && y >= 20 && y < 30;
        const shine = x === 28 && y === 12;
        return inFrame && !hole && !shine ? [60, 60, 120, 255] : [255, 255, 255, 255];
      }),
    );
    const cut = keyOut(img);
    expect(alphaAt(cut, 20, 25)).toBe(0);
    expect(alphaAt(cut, 28, 12)).toBe(255);
  });

  it('白底：挨着轮廓的小块底色（发丝之间）去掉，离轮廓远的小块（眼白）留着；混了底色的轮廓做半透明并去掉底色', () => {
    const img = rgba(
      encodePng(60, 80, (x, y) => {
        if (x === 9 && y >= 10) return [138, 138, 138, 255]; // 深色轮廓和白底各一半
        if (x < 10 || x >= 50 || y < 10) return [255, 255, 255, 255];
        if (x >= 12 && x < 14 && y >= 30 && y < 38) return [255, 255, 255, 255]; // 发丝之间的空隙，离外面 3 个像素
        if (x >= 28 && x < 32 && y >= 40 && y < 43) return [250, 250, 250, 255]; // 眼白，离外面将近 20 个像素
        return [20, 20, 20, 255];
      }),
    );
    const cut = keyOut(img);
    expect(alphaAt(cut, 12, 33)).toBe(0);
    expect(alphaAt(cut, 29, 41)).toBe(255);
    const edge = (9 + 40 * 60) * 4;
    expect(cut.data[edge + 3]).toBeGreaterThan(100);
    expect(cut.data[edge + 3]).toBeLessThan(160);
    expect(cut.data[edge]).toBeLessThan(60); // 去掉白底以后是深色的，不是一圈浅灰
  });

  it('鲜艳的底色（绿）：被围起来的不管大小都去掉（眼镜片后面），轮廓附近压掉渗进来的绿，离轮廓远的绿色留着', () => {
    const img = rgba(
      encodePng(60, 80, (x, y) => {
        if (x < 10 || x >= 50 || y < 10) return [40, 180, 40, 255];
        if (x === 10) return [90, 130, 90, 255]; // 渗了绿的轮廓
        if (x >= 40 && x < 43 && y >= 20 && y < 23) return [45, 175, 45, 255]; // 镜片后面透出来的底色
        if (x >= 28 && x < 31 && y >= 50 && y < 53) return [40, 180, 40, 255];
        if (x === 30 && y === 30) return [30, 120, 90, 255]; // 绿眼睛
        return [150, 150, 150, 255];
      }),
    );
    const cut = keyOut(img);
    expect(alphaAt(cut, 41, 21)).toBe(0);
    expect(alphaAt(cut, 29, 51)).toBe(0);
    const at = (x: number, y: number) => [...cut.data.subarray((y * 60 + x) * 4, (y * 60 + x) * 4 + 3)] as [number, number, number];
    const [r, g, b] = at(10, 40);
    expect(alphaAt(cut, 10, 40)).toBeGreaterThan(0);
    expect(g).toBeLessThanOrEqual(Math.max(r, b));
    expect(at(30, 30)).toEqual([30, 120, 90]);
  });

  it('检查：背景没抠掉、四边有残留、人物被抠没了、身上有洞', () => {
    const noisy = keyOut(rgba(mockSprite('角色立绘', 64, 96, 'noisy')));
    expect(checkAlpha(noisy)).toMatchObject({ ok: false });
    const full = rgba(encodePng(20, 30, () => [10, 10, 10, 255]));
    expect(checkAlpha(full).reason).toBe('背景没有抠掉');
    const empty = rgba(encodePng(20, 30, () => [0, 0, 0, 0]));
    expect(checkAlpha(empty).reason).toBe('人物几乎全被抠掉了');
    const edge = rgba(encodePng(20, 30, (x, y) => (y < 2 || (x > 5 && x < 15 && y > 8) ? [10, 10, 10, 255] : [0, 0, 0, 0])));
    expect(checkAlpha(edge).reason).toBe('四边有没抠干净的背景');
    const holed = rgba(
      encodePng(40, 60, (x, y) => (x >= 8 && x < 32 && y >= 10 && !(x >= 14 && x < 26 && y >= 20 && y < 32) ? [10, 10, 10, 255] : [0, 0, 0, 0])),
    );
    expect(checkAlpha(holed).ok).toBe(true);
    expect(checkAlpha(holed, { holes: true }).reason).toBe('人物身上有大块透明的洞');
  });
});

describe('立绘的素材清单', () => {
  it('每个角色一张基础立绘，主要角色 6 个表情、其他角色 3 个，再加上剧本里用到的；表情差分依赖基础立绘', async () => {
    const world = await new WorldStore(EXAMPLES).load('old_library');
    const plan = planAssets(world, AssetSettings.parse({}), AssetIndex.parse({})).filter((p) => p.kind === 'sprite');
    const ids = (c: string) => plan.filter((p) => p.characterId === c).map((p) => p.expression);
    expect(ids('char_01')).toEqual(['neutral', 'smile', 'angry', 'sad', 'surprised', 'shy']);
    expect(ids('char_lin')).toEqual(['neutral', 'smile', 'angry', 'sad', 'surprised', 'shy']);
    expect(ids('char_zhou')).toEqual(['neutral', 'smile', 'surprised']);
    const base = plan.find((p) => p.id === 'sprite/char_lin/neutral');
    expect(base).toMatchObject({ toggle: 'sprite', deps: [], dir: 'sprite/char_lin', slug: 'neutral', title: '林夕 · 平静' });
    expect(base?.params).toMatchObject({ mode: 'generate', size: '1024x1536', transparency: 'auto', keyColor: 'white' });
    expect(base?.params.prompt).toContain('角色立绘，人物：女，19 岁，黑色及腰长发');
    expect(base?.params.prompt).toContain('表情：表情平静自然，嘴角放松');
    expect(base?.params.prompt).toContain('膝盖以上的半身像');
    expect(base?.params.prompt).toContain('背景是一整片纯白色');
    expect(base?.params.prompt).not.toContain('透明');
    const smile = plan.find((p) => p.id === 'sprite/char_lin/smile');
    expect(smile).toMatchObject({ toggle: 'expression', deps: ['sprite/char_lin/neutral'], title: '林夕 · 微笑' });
    expect(smile?.params.mode).toBe('edit');
    expect(smile?.params.prompt).toContain('只改表情：温和地微笑');
    // 白衬衫：纯色底换成绿色
    expect(plan.find((p) => p.id === 'sprite/char_01/neutral')?.params).toMatchObject({ keyColor: 'green' });
    expect(plan.find((p) => p.id === 'sprite/char_01/neutral')?.params.prompt).toContain('纯绿色（#00FF00）');
    // 剧本里写了表情表里没有的表情：也画
    const extra = planAssets({ ...world, scripts: { sc_01: 'show zhou thinking' } }, AssetSettings.parse({}), AssetIndex.parse({}));
    expect(extra.filter((p) => p.characterId === 'char_zhou').map((p) => p.expression)).toEqual(['neutral', 'smile', 'surprised', 'thinking']);
  });

  it('设置：不画主角、单个角色改表情、换表情表、不抠图、指定底色；透明背景的做法进参数哈希', async () => {
    const world = await new WorldStore(EXAMPLES).load('old_library');
    const plan = (s: Partial<AssetSettings>) => planAssets(world, AssetSettings.parse(s), AssetIndex.parse({})).filter((p) => p.kind === 'sprite');
    expect(plan({ spriteProtagonist: false }).some((p) => p.characterId === 'char_01')).toBe(false);
    const own = plan({ characters: { char_zhou: { expressions: ['angry'] } } });
    expect(own.filter((p) => p.characterId === 'char_zhou').map((p) => p.expression)).toEqual(['neutral', 'angry']);
    const table = plan({
      expressions: [
        { id: 'neutral', name: '平常', synonyms: [], prompt: '面无表情' },
        { id: 'smirk', name: '坏笑', synonyms: [], prompt: '嘴角一边翘起' },
      ],
      spriteSets: { main: ['smirk'], other: [] },
    });
    expect(table.filter((p) => p.characterId === 'char_lin').map((p) => p.expression)).toEqual(['neutral', 'smirk', 'surprised', 'angry', 'sad', 'smile']);
    expect(table.find((p) => p.id === 'sprite/char_lin/smirk')?.params.prompt).toContain('只改表情：嘴角一边翘起');
    expect(table.find((p) => p.id === 'sprite/char_lin/neutral')?.params.prompt).toContain('表情：面无表情');
    const none = plan({ transparency: 'none' }).find((p) => p.id === 'sprite/char_lin/neutral');
    expect(none?.params).toMatchObject({ transparency: 'none', keyColor: null });
    expect(none?.params.prompt).toContain('简单干净的纯色背景');
    expect(plan({ keyColor: 'green' }).find((p) => p.id === 'sprite/char_lin/neutral')?.params.keyColor).toBe('green');
    const hashes = new Set(['auto', 'key', 'none'].map((t) => plan({ transparency: t as AssetSettings['transparency'] })[0]?.paramsHash));
    expect(hashes.size).toBe(3);
  });

  it('优先级：在场角色的基础立绘 → 这一幕和下一幕要出场的 → 在场角色的其他表情 → 其余', async () => {
    const world = await new WorldStore(EXAMPLES).load('old_library');
    const plan = planAssets(world, AssetSettings.parse({}), AssetIndex.parse({}));
    const pr = (id: string, focus: Parameters<typeof priorityOf>[2]) => priorityOf(plan.find((p) => p.id === id) as PlannedSlot, world, focus);
    const focus = { locationId: 'loc_reading', characterIds: ['char_lin'], sceneId: 'sc_01' };
    expect(pr('sprite/char_lin/neutral', focus)).toBe(1);
    expect(pr('sprite/char_zhou/neutral', focus)).toBe(2); // sc_01 → sc_02 有老周
    expect(pr('sprite/char_lin/smile', focus)).toBe(3);
    expect(pr('sprite/char_zhou/smile', focus)).toBe(4);
    expect(pr('sprite/char_01/neutral', focus)).toBe(4);
    // 没在玩：开场没写在场角色，就按起始幕的出场角色
    expect(pr('sprite/char_lin/neutral', null)).toBe(1);
  });
});

/** 立绘相关的槽（关掉背景，只看立绘）。 */
const sprites = (v: AssetsView) => v.slots.filter((s) => s.kind === 'sprite');
const assetFile = async (worldId: string, rel: string) => new Uint8Array(await readFile(path.join(dir, 'worlds', worldId, rel)));

describe('立绘管线', () => {
  it('自动：要透明图（服务忽略了）→ 纯白底内置抠图；表情差分拿抠图前的原图当参考图改图', async () => {
    const id = await setup({ sprites: true, assets: { enabled: { background: false } as AssetSettings['enabled'] } });
    const v = await idle(id);
    expect(v.counts).toMatchObject({ total: 15, done: 15, failed: 0 });
    const gens = server.imageRequests.filter((r) => !r.edit);
    const edits = server.imageRequests.filter((r) => r.edit);
    expect(gens).toHaveLength(3);
    expect(edits).toHaveLength(12);
    expect(gens.every((r) => r.background === 'transparent' && r.size === '1024x1536')).toBe(true);
    const lin = slot(v, 'sprite/char_lin/neutral');
    expect(lin).toMatchObject({ status: 'done', characterId: 'char_lin', expression: 'neutral', review: null });
    expect(lin.file).toMatch(/^assets\/sprite\/char_lin\/neutral-[0-9a-f]{12}\.png$/);
    const index = AssetIndex.parse(JSON.parse(await readFile(path.join(dir, 'worlds', id, 'assets', 'index.json'), 'utf8')));
    const raw = index.slots['sprite/char_lin/neutral']?.rawFile ?? '';
    expect(raw).toMatch(/neutral-[0-9a-f]{12}\.raw\.png$/);
    const cut = rgba(await assetFile(id, lin.file ?? ''));
    expect(alphaAt(cut, 0, 0)).toBe(0);
    expect(alphaAt(rgba(await assetFile(id, raw)), 0, 0)).toBe(255);
    // 表情差分的参考图是原图
    const linEdits = edits.filter((r) => String(r.prompt).includes('温和地微笑'));
    expect(linEdits.length).toBeGreaterThan(0);
    expect(edits.every((r) => Number(r.imageBytes) > 0)).toBe(true);
    const smile = slot(v, 'sprite/char_lin/smile');
    expect(alphaAt(rgba(await assetFile(id, smile.file ?? '')), 0, 0)).toBe(0);
    expect(index.generated).toBe(15);
    const calls = await client.call('listCalls', { limit: 50 });
    expect(calls.items.filter((c) => c.tag === 'assets.sprite')).toHaveLength(3);
    expect(calls.items.filter((c) => c.tag === 'assets.expression')).toHaveLength(12);
  });

  it('服务支持透明输出：直接用，不抠图；表情差分拿透明的基础立绘当参考图', async () => {
    const id = await setup({ sprites: true, mock: { imageTransparent: true }, assets: { enabled: { background: false } as AssetSettings['enabled'] } });
    const v = await idle(id);
    expect(v.counts.done).toBe(15);
    const index = AssetIndex.parse(JSON.parse(await readFile(path.join(dir, 'worlds', id, 'assets', 'index.json'), 'utf8')));
    expect(index.slots['sprite/char_lin/neutral']?.rawFile).toBeUndefined();
    expect(alphaAt(rgba(await assetFile(id, slot(v, 'sprite/char_lin/neutral').file ?? '')), 0, 0)).toBe(0);
  });

  it('图像服务返回 JPEG（H3 就是）：照样内置抠图，原图存成 .raw.jpg，表情差分拿 JPEG 原图当参考图', async () => {
    const jpeg = new Uint8Array(await readFile(path.join(import.meta.dirname, 'fixtures', 'sprite.jpg')));
    const id = await setup({ sprites: true, mock: { spriteJpeg: jpeg }, assets: { enabled: { background: false } as AssetSettings['enabled'] } });
    const v = await idle(id);
    expect(v.counts).toMatchObject({ total: 15, done: 15, failed: 0 });
    const lin = slot(v, 'sprite/char_lin/neutral');
    expect(lin.review).toBeNull();
    expect(lin.file).toMatch(/\.png$/);
    const index = AssetIndex.parse(JSON.parse(await readFile(path.join(dir, 'worlds', id, 'assets', 'index.json'), 'utf8')));
    expect(index.slots['sprite/char_lin/neutral']?.rawFile).toMatch(/neutral-[0-9a-f]{12}\.raw\.jpg$/);
    const cut = rgba(await assetFile(id, lin.file ?? ''));
    expect([cut.width, cut.height]).toEqual([64, 96]);
    expect(alphaAt(cut, 0, 0)).toBe(0);
    expect(alphaAt(cut, 32, 60)).toBe(255);
    // 表情差分的参考图就是那张 JPEG
    expect(server.imageRequests.filter((r) => r.edit).every((r) => r.imageBytes === jpeg.length)).toBe(true);
    expect(alphaAt(rgba(await assetFile(id, slot(v, 'sprite/char_lin/smile').file ?? '')), 0, 0)).toBe(0);
  });

  it('抠图服务：没配就失败并说明；配好以后每张都交给它抠', async () => {
    const id = await setup({
      sprites: true,
      assets: { enabled: { background: false } as AssetSettings['enabled'], transparency: 'service', spriteProtagonist: false },
    });
    let v = await idle(id);
    expect(slot(v, 'sprite/char_lin/neutral')).toMatchObject({ status: 'failed' });
    expect(slot(v, 'sprite/char_lin/neutral').error).toMatch(/还没有配「抠图」职责/);
    expect(server.imageRequests).toHaveLength(0);
    const ep = await client.call('saveEndpoint', {
      name: 'rembg',
      baseURL: server.baseURL.replace(/\/v1$/, ''),
      models: ['isnet-anime'],
      currency: 'CNY',
      pricing: {},
    });
    await client.call('setMediaRole', { role: 'cutout', route: { endpointId: ep.id, model: 'isnet-anime', api: 'rembg' } });
    for (const s of sprites(v).filter((x) => x.expression === 'neutral')) {
      await client.call('assetAction', { worldId: id, slotId: s.id, action: 'retry' });
    }
    v = await idle(id);
    expect(v.counts).toMatchObject({ total: 9, done: 9 });
    expect(server.cutoutRequests).toHaveLength(9);
    expect(server.cutoutRequests.every((r) => r.model === 'isnet-anime')).toBe(true);
    expect(alphaAt(rgba(await assetFile(id, slot(v, 'sprite/char_zhou/smile').file ?? '')), 0, 0)).toBe(0);
    const calls = await client.call('listCalls', { limit: 50 });
    expect(calls.items.filter((c) => c.role === 'cutout' && c.tag === 'assets.cutout')).toHaveLength(9);
  });

  it('抠图检查不过：换一张再试一次，还不过就先用原图，标成"需要看一下"', async () => {
    const id = await setup({
      sprites: true,
      mock: { imageNoisyIf: '花白短发' },
      assets: { enabled: { background: false, expression: false } as AssetSettings['enabled'] },
    });
    const v = await idle(id);
    const zhou = slot(v, 'sprite/char_zhou/neutral');
    expect(zhou.status).toBe('done');
    expect(zhou.review).toBe('背景没有抠掉');
    expect(zhou.file).toMatch(/\.raw\.png$/);
    expect(server.imageRequests.filter((r) => String(r.prompt).includes('花白短发'))).toHaveLength(2);
    expect(slot(v, 'sprite/char_lin/neutral').review).toBeNull();
    const index = AssetIndex.parse(JSON.parse(await readFile(path.join(dir, 'worlds', id, 'assets', 'index.json'), 'utf8')));
    expect(index.generated).toBe(4); // 老周画了两张
  });

  it('重抽基础立绘：表情差分自动跟着重画；换成自己的图也一样；锁定的表情只提示上游改过', async () => {
    const id = await setup({
      sprites: true,
      assets: { enabled: { background: false } as AssetSettings['enabled'], spriteProtagonist: false, spriteSets: { main: ['smile', 'sad'], other: [] } },
    });
    let v = await idle(id);
    // 林夕：平静、微笑、难过 + 角色自己写的惊讶、生气；老周：平静
    expect(sprites(v).map((s) => s.id)).toEqual([
      'sprite/char_lin/neutral',
      'sprite/char_lin/smile',
      'sprite/char_lin/sad',
      'sprite/char_lin/surprised',
      'sprite/char_lin/angry',
      'sprite/char_zhou/neutral',
    ]);
    await client.call('assetAction', { worldId: id, slotId: 'sprite/char_lin/sad', action: 'lock' });
    const before = server.imageRequests.length;
    await client.call('assetAction', { worldId: id, slotId: 'sprite/char_lin/neutral', action: 'regenerate' });
    v = await idle(id);
    // 基础立绘 1 张 + 没锁的 3 个表情
    expect(server.imageRequests.length - before).toBe(4);
    expect(slot(v, 'sprite/char_lin/sad')).toMatchObject({ status: 'done', locked: true, upstreamChanged: true });
    expect(slot(v, 'sprite/char_lin/smile').status).toBe('done');
    // 换成自己的图：表情差分拿它当参考图重画
    const png = path.join(dir, 'lin.png');
    await writeFile(png, mockSprite('自己画的林夕', 40, 60, 'transparent'));
    const n = server.imageRequests.length;
    await client.call('assetUpload', { worldId: id, slotId: 'sprite/char_lin/neutral', path: png });
    v = await idle(id);
    const edits = server.imageRequests.slice(n);
    expect(edits).toHaveLength(3);
    expect(edits.every((r) => r.edit && Number(r.imageBytes) === (mockSprite('自己画的林夕', 40, 60, 'transparent').length))).toBe(true);
  });

  it('关掉立绘：基础立绘不画，表情差分也不画；已经有基础立绘的照样画表情', async () => {
    const id = await setup({ sprites: true, assets: { enabled: { background: false, sprite: false, expression: true } as AssetSettings['enabled'] } });
    const v = await idle(id);
    expect(server.imageRequests).toHaveLength(0);
    expect(new Set(sprites(v).map((s) => s.status))).toEqual(new Set(['disabled']));
    const png = path.join(dir, 'zhou.png');
    await writeFile(png, mockSprite('老周', 40, 60, 'white'));
    await client.call('assetUpload', { worldId: id, slotId: 'sprite/char_zhou/neutral', path: png });
    const after = await idle(id);
    expect(server.imageRequests.filter((r) => r.edit)).toHaveLength(2);
    expect(slot(after, 'sprite/char_zhou/smile').status).toBe('done');
  });
});

describe('BGM', () => {
  const MOODS = ['theme', 'daily', 'tense', 'sad', 'warm', 'climax'];
  const bgmSlots = (v: AssetsView) => v.slots.filter((s) => s.kind === 'bgm');
  const playlist = (v: AssetsView, mood: string) => v.bgm.playlists.find((p) => p.mood === mood);

  /** 一个只有两首曲子的内置曲库。 */
  async function builtinDir() {
    const d = await mkdtemp(path.join(os.tmpdir(), 'auto-adv-builtin-'));
    const track = (file: string, mood: string) => ({ file, title: file, composer: '萨蒂', mood, source: '', method: '渲染', license: '公有领域' });
    await writeFile(path.join(d, 'manifest.json'), JSON.stringify({ tracks: [track('daily-1.wav', 'daily'), track('sad-1.wav', 'sad')] }));
    await writeFile(path.join(d, 'daily-1.wav'), mockMusic('daily'));
    await writeFile(path.join(d, 'sad-1.wav'), mockMusic('sad'));
    return d;
  }

  it('没配音乐职责：BGM 槽不算进进度，不调接口；内置曲库有的情绪用内置曲库', async () => {
    const id = await setup({ builtin: await builtinDir() });
    const v = await idle(id);
    expect(bgmSlots(v).map((s) => [s.id, s.status])).toEqual(MOODS.map((m) => [`bgm/${m}`, 'disabled']));
    expect(v.counts.total).toBe(3);
    expect(v.bgm.needsModel).toBe(true);
    expect(v.bgm.builtinCount).toBe(2);
    expect(playlist(v, 'daily')).toMatchObject({ source: 'builtin', wantsModel: false, tracks: [{ ref: { kind: 'builtin', path: 'daily-1.wav' }, loop: false }] });
    expect(playlist(v, 'tense')).toMatchObject({ source: null, tracks: [] });
    expect(server.musicRequests).toHaveLength(0);
    expect((await client.call('builtinBgm')).map((t) => t.file)).toEqual(['daily-1.wav', 'sad-1.wav']);
  });

  it('配好音乐职责：每种情绪生成一首纯音乐，存进 assets/bgm/，不算图片张数；生成好了就换掉内置曲库', async () => {
    const id = await setup({ image: false, builtin: await builtinDir() });
    await idle(id);
    await setMusic();
    const v = await idle(id);
    expect(bgmSlots(v).every((s) => s.status === 'done')).toBe(true);
    expect(server.musicRequests).toHaveLength(6);
    expect(server.musicRequests[0]).toMatchObject({ model: 'mock-music', is_instrumental: true, output_format: 'hex' });
    const tense = server.musicRequests.find((r) => String(r.prompt).includes('紧张、悬疑'));
    expect(String(tense?.prompt)).toContain('纯音乐，没有人声');
    const daily = slot(v, 'bgm/daily');
    expect(daily.file).toMatch(/^assets\/bgm\/daily-[0-9a-f]{12}\.wav$/);
    expect(existsSync(path.join(dir, 'worlds', id, daily.file ?? ''))).toBe(true);
    expect(playlist(v, 'daily')).toMatchObject({ source: 'model', tracks: [{ ref: { kind: 'world', path: daily.file }, loop: true }] });
    const index = AssetIndex.parse(JSON.parse(await readFile(path.join(dir, 'worlds', id, 'assets', 'index.json'), 'utf8')));
    expect(index).toMatchObject({ music: 6, generated: 0 });
    const calls = await client.call('listCalls', {});
    expect(calls.items.filter((c) => c.role === 'music' && c.tag === 'assets.bgm' && c.status === 'ok')).toHaveLength(6);
    // 背景还在等图像模型
    expect(v.counts).toMatchObject({ total: 9, done: 6, pending: 3 });

    // 改了世界的音乐风格：BGM 过期，点了才重新生成
    await client.call('saveWorldAssetSettings', { worldId: id, patch: { bgm: { template: '{情绪}，纯音乐' } } });
    const stale = await idle(id);
    expect(bgmSlots(stale).every((s) => s.status === 'stale' && s.staleBy === 'params')).toBe(true);
    expect(server.musicRequests).toHaveLength(6);
  });

  it('本地曲库排在前面：曲库里有的情绪不生成；对不上的让文本模型按文件名挑，每个文件只问一次', async () => {
    const lib = await mkdtemp(path.join(os.tmpdir(), 'auto-adv-lib-'));
    for (const f of ['紧张/追逐.wav', 'calm_daily.wav', 'track01.wav']) {
      await mkdir(path.dirname(path.join(lib, f)), { recursive: true });
      await writeFile(path.join(lib, f), mockMusic(f));
    }
    const id = await setup({ image: false, music: true, text: true, assets: { bgm: BgmSettings.parse({ libraryDir: lib }) } });
    const v = await idle(id);
    expect(v.bgm.library?.tracks.map((t) => [t.rel, t.mood, t.by])).toEqual([
      ['calm_daily.wav', 'daily', 'name'],
      ['track01.wav', 'theme', 'model'],
      ['紧张/追逐.wav', 'tense', 'folder'],
    ]);
    expect(playlist(v, 'tense')).toMatchObject({ source: 'library', tracks: [{ ref: { kind: 'library', path: '紧张/追逐.wav' } }] });
    expect(playlist(v, 'theme')?.source).toBe('library');
    // 只有曲库里没有的三种情绪用音乐模型生成
    expect(server.musicRequests).toHaveLength(3);
    expect(bgmSlots(v).filter((s) => s.status === 'done').map((s) => s.mood)).toEqual(['sad', 'warm', 'climax']);
    expect(v.bgm.named.calm_daily).toMatchObject({ ref: { kind: 'library', path: 'calm_daily.wav' } });
    const asked = () => server.requests.filter((r) => JSON.stringify(r).includes('bgm_moods')).length;
    expect(asked()).toBe(1);
    expect(existsSync(path.join(dir, 'bgm-library.json'))).toBe(true);

    // 重新扫描：用记下来的结果，不再问
    await client.call('assetsControl', { worldId: id, action: 'rescanLibrary' });
    const again = await idle(id);
    expect(again.bgm.library?.tracks.find((t) => t.rel === 'track01.wav')).toMatchObject({ mood: 'theme', by: 'model' });
    expect(asked()).toBe(1);

    // 单个情绪指定来源：日常只用内置曲库（没有就不放），不按顺序找
    await client.call('saveWorldAssetSettings', { worldId: id, patch: { bgm: { pins: { daily: 'builtin' } } } });
    expect(playlist(await idle(id), 'daily')).toMatchObject({ source: null, tracks: [] });
    await rm(lib, { recursive: true, force: true });
  });

  it('换成自己的音频：复制进世界并锁定，这个情绪改用它；只认音频', async () => {
    const id = await setup({ image: false });
    await idle(id);
    const src = path.join(dir, 'mine.wav');
    await writeFile(src, mockMusic('mine'));
    const v = await client.call('assetUpload', { worldId: id, slotId: 'bgm/sad', path: src });
    const sad = slot(v, 'bgm/sad');
    expect(sad).toMatchObject({ source: 'uploaded', locked: true, status: 'done' });
    expect(sad.file).toMatch(/^assets\/uploads\/bgm-sad-[0-9a-f]{12}\.wav$/);
    expect(playlist(v, 'sad')).toMatchObject({ source: 'uploaded', tracks: [{ ref: { kind: 'world', path: sad.file }, loop: true }] });
    const png = path.join(dir, 'x.png');
    await writeFile(png, encodePng(4, 4, () => [1, 2, 3, 255]));
    await expect(client.call('assetUpload', { worldId: id, slotId: 'bgm/warm', path: png })).rejects.toThrow('只支持 MP3');
  });

  it('设置页：测试音乐职责，返回一段音频', async () => {
    await setup({ image: false });
    const r = await client.call('testMusic', { route: { endpointId, model: 'mock-music', api: 'minimax' } });
    expect(r.dataUrl).toMatch(/^data:audio\/wav;base64,/);
    expect(r.durationMs).toBe(2000);
  });
});
