/**
 * M4 第 1 步：素材槽、素材清单、队列、缓存、背景（docs/ARCHITECTURE.md 18.2～18.4）。
 */
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { encodePng, type MockServer, type MockServerOptions, startMockServer } from '@auto-adv/providers/testing';
import { AssetIndex, AssetSettings } from '@auto-adv/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { type AssetsView, createPortPair, Engine, type EngineContract, MemorySecretStore, RpcClient, serveRpc } from '../src/index.ts';
import { planAssets, priorityOf } from '../src/assets/plan.ts';
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
 * 导入示例世界。默认去掉手写剧本，只剩 3 个地点的背景；scripts: true 时连剧本一起导入（再加 5 张剧本里的背景）。
 * image：要不要配好图像职责。
 */
async function setup(opts: { image?: boolean; mock?: MockServerOptions; assets?: Partial<AssetSettings>; scripts?: boolean } = {}) {
  await teardown();
  open = true;
  dir = await mkdtemp(path.join(os.tmpdir(), 'auto-adv-assets-'));
  server = await startMockServer({ chunkDelayMs: 0, ...opts.mock });
  engine = new Engine({ dataDir: dir, secrets: new MemorySecretStore(), callLogFile: ':memory:', assetRetryBaseMs: 1 });
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
  if (opts.assets) await client.call('saveAssetSettings', { settings: AssetSettings.parse(opts.assets) });
  let src = path.join(EXAMPLES, 'old_library');
  if (!opts.scripts) {
    src = path.join(dir, 'src', 'old_library');
    await cp(path.join(EXAMPLES, 'old_library'), src, { recursive: true });
    await rm(path.join(src, 'plot', 'scenes'), { recursive: true, force: true });
  }
  const w = await client.call('importWorld', { path: src });
  if (opts.image !== false) await setImage();
  return w.id;
}

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
    const plan = planAssets(world, base, AssetIndex.parse({}));
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
    const plan = planAssets(world, AssetSettings.parse({}), AssetIndex.parse({}));
    const pr = (focus: Parameters<typeof priorityOf>[2]) => plan.map((p) => priorityOf(p, world, focus));
    // 没在玩：开始的幕在阅览室，它通往旧书库。剧本里的背景跟着幕走：sc_01 的先画，紧接着的 sc_02 其次
    expect(pr(null)).toEqual([2, 2, 4, 1, 2, 4, 4, 4]);
    expect(pr({ locationId: 'loc_seaside', characterIds: [], sceneId: 'sc_01' })).toEqual([2, 2, 1, 1, 2, 4, 4, 4]);
    expect(pr({ locationId: 'loc_archive', characterIds: [], sceneId: 'sc_03' })).toEqual([1, 4, 2, 4, 4, 1, 2, 2]);
  });

  it('手写剧本里的背景：不是地点 id 的每个 id 一张，用那一幕的地点、标题和第一句旁白描述画面', async () => {
    const world = await new WorldStore(EXAMPLES).load('old_library');
    const plan = planAssets(world, AssetSettings.parse({}), AssetIndex.parse({}));
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
    expect(reused).toHaveLength(8);
  });
});

describe('素材管线', () => {
  it('没配图像职责：全部待生成，不调接口，世界照样能玩', async () => {
    const id = await setup({ image: false });
    const v = await client.call('assetsView', { worldId: id });
    expect(v.state.needsModel).toBe(true);
    expect(v.state.working).toBe(false);
    expect(v.slots.map((s) => s.status)).toEqual(['pending', 'pending', 'pending']);
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
    expect(v.slots.map((s) => s.status)).toEqual(['disabled', 'disabled', 'disabled']);
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
    expect(v.slots).toHaveLength(2);
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
