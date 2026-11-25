/**
 * M4 第 5 步：CG（手写剧本里的、AI 演出时导演标的）和时段背景（docs/ARCHITECTURE.md 18.4、18.6）。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type MockServer, startMockServer } from '@auto-adv/providers/testing';
import { AssetIndex, AssetSettings, DEFAULT_TIME_VARIANTS } from '@auto-adv/schema';
import { afterEach, describe, expect, it } from 'vitest';
import type { PlayEvent, Segment } from '../src/api.ts';
import { estimateAssets } from '../src/assets/estimate.ts';
import { planAssets, priorityOf } from '../src/assets/plan.ts';
import { cgLeft, cgOfPlan, cgSection } from '../src/play/cg.ts';
import { buildTimeline, stageFromSegments, variantOfTime } from '../src/plot/stage.ts';
import {
  type AssetsView,
  createPortPair,
  Engine,
  type EngineContract,
  MemorySecretStore,
  type PlayRef,
  RpcClient,
  serveRpc,
} from '../src/index.ts';

const EXAMPLES = path.resolve(import.meta.dirname, '../../../examples/worlds');
const cast = [
  { id: 'char_lin', name: '林夕' },
  { id: 'char_zhou', name: '老周' },
];

let seq = 0;
const ev = (e: Partial<PlayEvent> & Pick<PlayEvent, 'kind'>): PlayEvent => ({
  id: `ev_${++seq}`,
  parentId: null,
  createdAt: seq,
  ...e,
});
const lines = (...texts: string[]): Segment[] =>
  texts.map((t, i) => (i % 2 ? { kind: 'line', characterId: 'char_lin', name: '林夕', text: t } : { kind: 'narration', text: t }));

describe('时段背景', () => {
  it('故事时间对时段：时段表里的词出现就算，长的词先比；对不上用白天的', () => {
    const cases: [string | null, string | null][] = [
      ['当晚十点', 'night'],
      ['深夜', 'night'],
      ['第 2 天夜里', 'night'],
      ['傍晚时分', 'dusk'],
      ['入夜前', 'dusk'],
      ['Late at night', 'night'],
      ['第二天早上', null],
      ['', null],
      [null, null],
    ];
    for (const [time, want] of cases) expect(variantOfTime(time, DEFAULT_TIME_VARIANTS), String(time)).toBe(want);
  });

  it('AI 演出的拍按故事时间用背景变体；同一个地点时段变了只换背景不清场；手写剧本的背景照写的来', () => {
    const variants = DEFAULT_TIME_VARIANTS;
    const path = [
      ev({ kind: 'opening', segments: lines('开场。'), scene: { locationId: 'loc_reading', presentCharacterIds: ['char_lin'] } }),
      ev({ kind: 'ai', segments: lines('白天的一拍。', '你好。'), beat: { plan: '', strategy: 'merged' } }),
      ev({ kind: 'ai', segments: lines('天黑了。', '该走了。'), beat: { plan: '', strategy: 'merged', time: '当晚十点' } }),
      ev({ kind: 'ai', segments: lines('到了海边。'), beat: { plan: '', strategy: 'merged' }, scene: { locationId: 'loc_seaside', presentCharacterIds: [] } }),
      ev({ kind: 'script', stage: [{ op: 'bg', id: 'seaside_dawn' }, { op: 'narrate', text: '天亮了。' }] }),
    ];
    const t = buildTimeline(path, { characters: cast, auto: { protagonistId: null }, timeOfDay: { variants } });
    const bgOf = (text: string) => t.steps.find((s) => s.text?.text === text)?.view;
    expect(bgOf('白天的一拍。')?.bg?.id).toBe('loc_reading');
    // 时段变了，地点没变：背景换成夜晚的，立绘还在
    expect(bgOf('天黑了。')?.bg).toEqual({ id: 'loc_reading@night', transition: 'fade' });
    expect(bgOf('天黑了。')?.sprites.map((s) => s.characterId)).toEqual(['char_lin']);
    // 换地点：新地点也用夜晚的
    expect(bgOf('到了海边。')?.bg?.id).toBe('loc_seaside@night');
    expect(bgOf('天亮了。')?.bg?.id).toBe('seaside_dawn');
    // 不给时段表就不换
    const plain = buildTimeline(path, { characters: cast, auto: { protagonistId: null } });
    expect(plain.steps.find((s) => s.text?.text === '天黑了。')?.view.bg?.id).toBe('loc_reading');
    // 舞台上已经是夜晚的背景：同一个地点不再出 bg（不清场）
    const cmds = stageFromSegments(lines('还在这里。'), {
      characters: cast,
      before: { bg: { id: 'loc_reading@night' }, sprites: [], cg: null, bgm: null },
      scene: { locationId: 'loc_reading', presentCharacterIds: [] },
      protagonistId: null,
    });
    expect(cmds.some((c) => c.op === 'bg')).toBe(false);
  });
});

describe('导演标的 CG', () => {
  it('每幕、每章最多几张：有剧情图按幕和章数；没有剧情图按同一个地点连着的一段', () => {
    const rules = { perScene: 1, perChapter: 2 };
    const scenes = [
      { id: 'sc_01', chapter: 'ch_01' },
      { id: 'sc_02', chapter: 'ch_01' },
      { id: 'sc_03', chapter: 'ch_01' },
      { id: 'sc_04' },
    ];
    const marked = (scene: string) =>
      ev({ kind: 'ai', plot: { scene }, beat: { plan: '', strategy: 'merged', cg: { id: `ai_${scene}`, title: '', description: '', cast: [] } } });
    expect(cgLeft([], scenes, 'sc_01', rules)).toBe(1);
    expect(cgLeft([marked('sc_01')], scenes, 'sc_01', rules)).toBe(0);
    expect(cgLeft([marked('sc_01')], scenes, 'sc_02', rules)).toBe(1);
    // 这一章已经两张了
    expect(cgLeft([marked('sc_01'), marked('sc_02')], scenes, 'sc_03', rules)).toBe(0);
    // 不在章里的幕只按幕算
    expect(cgLeft([marked('sc_01'), marked('sc_02')], scenes, 'sc_04', rules)).toBe(1);
    // 没有剧情图：换了地点重新算
    const at = (loc: string) => ev({ kind: 'scene', scene: { locationId: loc, presentCharacterIds: [] } });
    const free = (e: PlayEvent) => ({ ...e, plot: undefined }) as PlayEvent;
    expect(cgLeft([at('a'), free(marked('x'))], null, null, rules)).toBe(0);
    expect(cgLeft([at('a'), free(marked('x')), at('b')], null, null, rules)).toBe(1);
  });

  it('导演写的 CG：没写画面、到了上限都不算；画面里的角色只认世界里有的；没写标题取画面的开头', () => {
    const chars = [{ id: 'char_lin', name: '林夕', aliases: [] }] as never;
    const raw = { title: '', description: '林夕在书架间回头，夕阳照在她的侧脸上。', cast: ['林夕', '路人甲'] };
    const cg = cgOfPlan(raw, chars, 1);
    expect(cg).toMatchObject({ title: '林夕在书架间回头，夕', description: raw.description, cast: ['char_lin'] });
    expect(cg?.id).toMatch(/^ai_[a-z0-9]+$/);
    expect(cgOfPlan(raw, chars, 0)).toBeNull();
    expect(cgOfPlan({ ...raw, description: ' ' }, chars, 1)).toBeNull();
    expect(cgOfPlan(null, chars, 1)).toBeNull();
    expect(cgSection(0)).toBe('');
    expect(cgSection(2)).toContain('这一幕最多还能标 2 张');
  });

  it('舞台：放在这一拍中间那句话上，这一拍演完撤下；回想里有一条；不记跨周目解锁', () => {
    const cg = { id: 'ai_x1', title: '雨中的约定', description: '……', cast: ['char_lin'] };
    const path = [
      ev({ kind: 'opening', segments: lines('开场。'), scene: { locationId: 'loc_reading', presentCharacterIds: [] } }),
      ev({ kind: 'ai', segments: lines('一。', '二。', '三。', '四。'), beat: { plan: '', strategy: 'merged', cg } }),
      ev({ kind: 'ai', segments: lines('下一拍。'), beat: { plan: '', strategy: 'merged' } }),
    ];
    const t = buildTimeline(path, { characters: cast, auto: { protagonistId: null } });
    const cgAt = (text: string) => t.steps.find((s) => s.text?.text === text)?.view.cg;
    expect(['一。', '二。', '三。', '四。', '下一拍。'].map(cgAt)).toEqual([null, null, 'ai_x1', 'ai_x1', null]);
    expect(t.steps.some((s) => s.cgShown)).toBe(false);
    const entry = t.backlog.find((b) => b.kind === 'cg');
    expect(entry).toEqual({ kind: 'cg', step: t.steps.findIndex((s) => s.text?.text === '三。'), id: 'ai_x1', title: '雨中的约定' });
    // 剧情 ADV 的拍带着舞台指令，也一样
    const adv = [ev({ kind: 'ai', stage: [{ op: 'narrate', text: '甲。' }, { op: 'narrate', text: '乙。' }], beat: { plan: '', strategy: 'merged', cg } })];
    expect(buildTimeline(adv, { characters: cast }).steps.map((s) => s.view.cg)).toEqual([null, 'ai_x1']);
  });
});

// ───────────── 素材清单和应用里 ─────────────

let dir: string;
let server: MockServer;
let engine: Engine;
let client: RpcClient<EngineContract>;
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

async function setup() {
  await teardown();
  open = true;
  dir = await mkdtemp(path.join(os.tmpdir(), 'auto-adv-cg-'));
  server = await startMockServer({ chunkDelayMs: 0 });
  engine = new Engine({ dataDir: dir, secrets: new MemorySecretStore(), callLogFile: ':memory:', assetRetryBaseMs: 1 });
  const [a, b] = createPortPair();
  serveRpc(a, engine.handlers());
  client = new RpcClient<EngineContract>(b);
  const ep = await client.call('saveEndpoint', { name: '模拟服务', baseURL: server.baseURL, models: ['mock-chat'], currency: 'CNY', pricing: {} });
  return ep.id;
}

async function idle(worldId: string, timeoutMs = 8000): Promise<AssetsView> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await client.call('assetsView', { worldId });
    if (!v.state.working && v.counts.running === 0) return v;
    if (Date.now() > until) throw new Error(`素材一直没画完：${JSON.stringify(v.counts)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('素材清单里的 CG 和时段背景', () => {
  it('剧本里的 CG：画面取幕的标题和之后的旁白，人物是之后开口的角色，拿第一个角色的立绘当参考图；关掉参考图就文生图', async () => {
    await setup();
    const w = await client.call('importWorld', { path: path.join(EXAMPLES, 'old_library') });
    const world = await engine.worlds.load(w.id);
    const settings = AssetSettings.parse({});
    const plan = planAssets(world, settings, AssetIndex.parse({}));
    const reunion = plan.find((p) => p.id === 'cg/cg_reunion');
    expect(reunion).toMatchObject({ kind: 'cg', toggle: 'cg', cgId: 'cg_reunion', ai: false, deps: ['sprite/char_lin/neutral'], sceneIds: ['sc_05'] });
    expect(reunion?.params.mode).toBe('edit');
    expect(reunion?.params.size).toBe('1536x1024');
    expect(reunion?.params.prompt).toContain('黎明时分，潮水漫过了堤岸');
    expect(reunion?.params.prompt).toContain('画面里的人物：林夕（');
    expect(reunion?.params.prompt).toContain('参考图是林夕的立绘');
    const noRef = planAssets(world, AssetSettings.parse({ cg: { reference: false } }), AssetIndex.parse({})).find((p) => p.id === 'cg/cg_reunion');
    expect(noRef?.deps).toEqual([]);
    expect(noRef?.params.mode).toBe('generate');
    expect(noRef?.params.prompt).not.toContain('参考图');
    expect(noRef?.paramsHash).not.toBe(reunion?.paramsHash);
    // 剧本里的 CG 跟着幕排优先级
    expect(priorityOf(reunion as never, world, { locationId: null, characterIds: [], sceneId: 'sc_05' })).toBe(2);
    expect(priorityOf(reunion as never, world, { locationId: null, characterIds: [], sceneId: 'sc_01' })).toBe(5);
  });

  it('导演标的 CG 和用到过的时段背景：登记了才排；时段背景默认拿白天的背景改，选重新画就不依赖', async () => {
    await setup();
    const w = await client.call('importWorld', { path: path.join(EXAMPLES, 'old_library') });
    const world = await engine.worlds.load(w.id);
    const index = AssetIndex.parse({
      cgs: { ai_abc: { title: '书架间的回眸', description: '林夕在书架间回头。', cast: ['char_lin', 'char_zhou'], locationId: 'loc_reading' } },
      variants: ['loc_reading@night', 'loc_nowhere@night', 'loc_reading@noon'],
    });
    const plan = planAssets(world, AssetSettings.parse({}), index);
    const ai = plan.find((p) => p.id === 'cg/ai_abc');
    expect(ai).toMatchObject({ title: '书架间的回眸', ai: true, deps: ['sprite/char_lin/neutral'], locationId: 'loc_reading' });
    expect(ai?.params.prompt).toContain('林夕在书架间回头。地点：阅览室');
    expect(ai?.params.prompt).toContain('老周（');
    expect(priorityOf(ai as never, world, null)).toBe(2);
    // 时段背景：只认世界里有的地点、时段表里有的时段
    expect(plan.filter((p) => p.toggle === 'timeOfDay').map((p) => p.id)).toEqual(['bg/loc_reading@night']);
    const night = plan.find((p) => p.id === 'bg/loc_reading@night');
    expect(night).toMatchObject({ kind: 'background', title: '阅览室 · 夜晚', deps: ['bg/loc_reading'], locationId: 'loc_reading', timeOfDay: 'night' });
    expect(night?.params.mode).toBe('edit');
    expect(night?.params.prompt).toContain('把参考图这张背景改成夜晚');
    expect(priorityOf(night as never, world, { locationId: 'loc_reading', characterIds: [], sceneId: null })).toBe(1);
    const gen = planAssets(world, AssetSettings.parse({ timeOfDay: { mode: 'generate' } }), index).find((p) => p.id === 'bg/loc_reading@night');
    expect(gen?.deps).toEqual([]);
    expect(gen?.params.prompt).toContain('阅览室。闭馆前的阅览室');
    expect(gen?.params.prompt).toContain('天色全黑');
  });
});

async function advWorld(endpointId: string) {
  await client.call('setRole', { role: 'default', route: { endpointId, model: 'mock-chat' } });
  const summary = await client.stream('createWorld', { seed: '雾中的灯塔', preset: 'mystery', options: { characterCount: 2, protagonistName: '阿远' } }, () => {});
  await client.call('setMediaRole', { role: 'image', route: { endpointId, model: 'mock-image', api: 'openai' } });
  const v = await client.call('startPlaythrough', { worldId: summary.id, mode: 'adv' });
  return { worldId: summary.id, ref: { worldId: summary.id, playthroughId: v.playthrough.id } as PlayRef };
}

describe('应用里', () => {
  it('剧情 ADV：导演标的 CG 登记了就画（每幕只留一张），夜里的拍登记时段背景，拿白天的背景改', async () => {
    const endpointId = await setup();
    const { worldId, ref } = await advWorld(endpointId);
    let v = await client.stream('advNext', ref, () => {});
    // 第一拍：导演标了 CG（模拟导演每拍都标），提示词里有「CG」一节
    const directors = () => (server.requests as unknown as { messages: { content: string }[] }[]).filter((r) => JSON.stringify(r).includes('adv_beat'));
    expect(JSON.stringify(directors()[0])).toContain('# CG（可选）');
    const first = v.path.at(-1) as PlayEvent;
    expect(first.beat?.cg?.title).toMatch(/^灯塔下的约定 \d+$/);
    const id = first.beat?.cg?.id as string;
    const n = first.beat?.cg?.title.split(' ')[1];
    // 同一幕的下一拍不能再标
    v = await client.stream('advChoose', { ...ref, index: 0 }, () => {});
    const second = v.path.at(-1) as PlayEvent;
    expect(second.plot?.scene).toBe(first.plot?.scene);
    expect(second.beat?.cg).toBeUndefined();
    expect(JSON.stringify(directors()[1])).not.toContain('# CG（可选）');

    const a = await idle(worldId);
    const slot = a.slots.find((s) => s.id === `cg/${id}`);
    expect(slot).toMatchObject({ kind: 'cg', status: 'done', title: first.beat?.cg?.title });
    expect(slot?.file).toMatch(new RegExp(`^assets/cg/${id}-[0-9a-f]{12}\\.png$`));
    // 画面里的第一个角色有立绘：拿它的基础立绘当参考图改图
    const cgReq = server.imageRequests.find((r) => String(r.prompt).includes(`（模拟 CG #${n}）`));
    expect(cgReq).toMatchObject({ edit: true });
    // 第三拍（模拟导演每三拍报一次夜里）：登记这个地点的夜晚背景，拿白天的那张改
    v = await client.stream('advChoose', { ...ref, index: 0 }, () => {});
    const third = v.path.at(-1) as PlayEvent;
    expect(third.beat?.time).toMatch(/夜里/);
    const after = await idle(worldId);
    const loc = (third.scene ?? v.scene).locationId as string;
    const night = after.slots.find((s) => s.id === `bg/${loc}@night`);
    expect(night).toMatchObject({ status: 'done' });
    expect(server.imageRequests.some((r) => String(r.prompt).includes('把参考图这张背景改成夜晚') && r.edit === true)).toBe(true);
    const index = await engine.worlds.readAssetIndex(worldId);
    expect(index.variants).toContain(`${loc}@night`);
    expect(index.cgs[id]).toMatchObject({ playthroughId: ref.playthroughId, sceneId: first.plot?.scene });
  });

  it('CG 关掉了、没配图像模型：导演不标', async () => {
    const endpointId = await setup();
    const { ref } = await advWorld(endpointId);
    await client.call('saveAssetSettings', { settings: AssetSettings.parse({ enabled: { cg: false } }) });
    const v = await client.stream('advNext', ref, () => {});
    expect(v.path.at(-1)?.beat?.cg).toBeUndefined();
    expect(JSON.stringify(server.requests.at(-2))).not.toContain('# CG（可选）');
  });
});

describe('创世前的用量估算', () => {
  it('按角色数和素材设置估算图片、音乐、语音；没配的模型不算', () => {
    const all = { image: true, music: true, voice: true };
    const e = estimateAssets({ characterCount: 3 }, AssetSettings.parse({}), all);
    // 4 个角色（含主角）× 6 个表情，或者都是 npc 时 × 3 个
    expect(e.images).toMatchObject({ backgrounds: [4, 6], sprites: [12, 24], cgs: [4, 6], timeOfDay: [0, 12], upfront: [16, 30], cap: 60 });
    expect(e.music).toEqual({ tracks: 6, note: '' });
    expect(e.voice).toEqual({ perBeat: [70, 180] });
    // 不画主角、不画表情差分、关掉 CG 和时段背景、旁白也配
    const lean = estimateAssets(
      { characterCount: 2 },
      AssetSettings.parse({ spriteProtagonist: false, enabled: { expression: false, cg: false, timeOfDay: false }, voice: { narrator: true } }),
      all,
    );
    expect(lean.images).toMatchObject({ sprites: [2, 2], cgs: [0, 0], timeOfDay: [0, 0] });
    expect(lean.voice).toEqual({ perBeat: [150, 350] });
    // 内置曲库排在音乐模型前面：不生成
    expect(estimateAssets({}, AssetSettings.parse({ bgm: { sources: ['builtin', 'model'] } }), all).music).toMatchObject({ tracks: 0 });
    const none = estimateAssets({}, AssetSettings.parse({}), { image: false, music: false, voice: false });
    expect(none).toMatchObject({ imageReady: false, images: { upfront: [0, 0] }, music: { tracks: 0, note: '没配音乐模型，用内置曲库' }, voice: null });
  });
});
