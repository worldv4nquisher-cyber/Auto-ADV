/**
 * M3 第 3 步：剧情 ADV 里没有手写剧本的幕交给 AI 演出（play/adv.ts + plot/runner.ts + plot/judge.ts）。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type MockServer, startMockServer } from '@auto-adv/providers/testing';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createPortPair,
  Engine,
  type EngineContract,
  MemorySecretStore,
  type PlayChunk,
  type PlayEvent,
  type PlayRef,
  type PlayView,
  RpcClient,
  serveRpc,
} from '../src/index.ts';
import { foldPlot } from '../src/plot/progress.ts';
import { buildTimeline } from '../src/plot/stage.ts';

const EXAMPLES = path.resolve(import.meta.dirname, '../../../examples/worlds');

let dir: string;
let server: MockServer;
let engine: Engine;
let client: RpcClient<EngineContract>;
let open = false;

type Req = { messages: { role: string; content: string }[] };
const requests = () => server.requests as unknown as Req[];
const systemOf = (r: Req) => r.messages.find((m) => m.role === 'system')?.content ?? '';
const lastUserOf = (r: Req) => [...r.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
const writers = () => requests().filter((r) => systemOf(r).includes('剧情 ADV（视觉小说）的「演员兼旁白」'));
const directors = () => requests().filter((r) => JSON.stringify(r).includes('adv_beat'));

async function teardown() {
  if (!open) return;
  open = false;
  client.close();
  engine.close();
  await server.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
}

async function setup() {
  await teardown();
  open = true;
  dir = await mkdtemp(path.join(os.tmpdir(), 'auto-adv-adv-ai-'));
  server = await startMockServer({ chunkDelayMs: 0 });
  engine = new Engine({ dataDir: dir, secrets: new MemorySecretStore(), callLogFile: ':memory:' });
  const [a, b] = createPortPair();
  serveRpc(a, engine.handlers());
  client = new RpcClient<EngineContract>(b);
  const ep = await client.call('saveEndpoint', {
    name: '模拟服务',
    baseURL: server.baseURL,
    models: ['mock-chat'],
    currency: 'CNY',
    pricing: { 'mock-chat': { input: 1, output: 2 } },
  });
  await client.call('setRole', { role: 'default', route: { endpointId: ep.id, model: 'mock-chat' } });
}

afterEach(teardown);

async function generated() {
  await setup();
  const summary = await client.stream(
    'createWorld',
    { seed: '雾中的灯塔', preset: 'mystery', options: { characterCount: 2, protagonistName: '阿远' } },
    () => {},
  );
  const world = await client.call('getWorld', { id: summary.id });
  const v = await client.call('startPlaythrough', { worldId: summary.id, mode: 'adv' });
  const ref: PlayRef = { worldId: summary.id, playthroughId: v.playthrough.id };
  return { world, v, ref };
}

const after = (v: PlayView, before: PlayView) => v.path.slice(before.path.length);
const kinds = (events: PlayEvent[]) => events.map((e) => e.kind);
const labels = (v: PlayView) => v.adv?.menu?.options.map((o) => o.label);

describe('剧情 ADV：AI 演出没有手写剧本的幕', () => {
  it('生成的世界：开场之后由导演和演员演出；选项、检定、自由输入、岔路、结局', async () => {
    const { world, v: v0, ref } = await generated();
    const heroine = world.characters.find((c) => c.role !== 'protagonist')?.name as string;
    const aff = world.variables.find((x) => x.id.startsWith('affinity.'))?.id as string;
    // 开场直接接在剧情图的第一幕上；第一幕是 AI 演出的，等玩家点"继续"才调模型
    expect(v0.adv).toMatchObject({ scene: { id: 'sc_01', title: '归乡' }, aiScene: true, needsModel: false, menu: null });
    expect(kinds(v0.path)).toEqual(['opening']);
    expect(v0.path[0]?.stage?.some((c) => c.op === 'bg')).toBe(true);
    await expect(client.stream('advChoose', { ...ref, index: 0 }, () => {})).rejects.toThrow('现在没有可以选的选项');

    // 第一拍：流式推送，导演报告演到第一个要点、给出三个选项（一个带检定）
    const chunks: PlayChunk[] = [];
    let v = await client.stream('advNext', ref, (c) => chunks.push(c));
    expect(chunks.map((c) => c.type)).toContain('seg');
    expect(chunks.filter((c) => c.type === 'phase').map((c) => c.type === 'phase' && c.phase)).toEqual(['thinking', 'writing']);
    let beat = v.path.at(-1) as PlayEvent;
    expect(beat).toMatchObject({ kind: 'ai', plot: { scene: 'sc_01', points: ['sc_01_1'] } });
    expect(beat.stage?.some((c) => c.op === 'say')).toBe(true);
    expect(v.adv?.menu?.source).toBe('ai');
    expect(labels(v)).toEqual([`追问${heroine}灯塔的事`, '仔细观察四周', '先把话题岔开']);
    expect(v.adv?.menu?.options[1]?.check).toEqual({ var: 'skill.insight', dc: 12, label: '仔细观察四周' });
    expect(v.adv?.vars[aff]).toBe(33);
    // 导演只看得到当前幕和打开的出口
    const d1 = lastUserOf(directors()[0] as Req);
    expect(d1).toContain('## 当前这一幕：[sc_01] 归乡');
    expect(d1).toContain('这是岔路，走哪条路由玩家决定');
    expect(d1).not.toContain('sc_04');
    await expect(client.stream('advNext', ref, () => {})).rejects.toThrow('请先做出选择');

    // 选带检定的选项：引擎先掷骰，检定结果交给导演和演员；第二个要点演到，岔路弹出出口菜单
    let prev = v;
    v = await client.stream('advChoose', { ...ref, index: 1 }, () => {});
    expect(kinds(after(v, prev))).toEqual(['choice', 'check', 'ai']);
    const check = after(v, prev)[1]?.check;
    expect(check).toMatchObject({ label: '仔细观察四周', dc: 12, var: 'skill.insight', modifier: 1 });
    expect(lastUserOf(directors().at(-1) as Req)).toContain('# 检定结果');
    const w2 = lastUserOf(writers().at(-1) as Req);
    expect(w2).toContain('［玩家选择：仔细观察四周］');
    expect(w2).toContain('［检定］仔细观察四周');
    expect(v.adv?.menu?.source).toBe('exits');
    expect(labels(v)).toEqual([`和${heroine}一起去灯塔`, '独自去档案馆']);
    // 同一个选项回退再选，骰子结果不变
    const again = await client.call('rewind', { ...ref, eventId: prev.path.at(-1)?.id as string });
    const v2 = await client.stream('advChoose', { ...ref, index: 1 }, () => {});
    expect(v2.path.find((e) => e.kind === 'check' && e.parentId === after(v2, again)[0]?.id)?.check?.roll).toBe(check?.roll);
    v = v2;

    // 岔路：玩家选了"一起去灯塔"，下一拍在新的幕里演出这个选择
    prev = v;
    v = await client.stream('advChoose', { ...ref, index: 0 }, () => {});
    expect(kinds(after(v, prev))).toEqual(['choice', 'ai']);
    expect(after(v, prev)[0]?.plot?.exit).toEqual({ to: 'sc_02', by: 'choice' });
    expect(v.adv?.scene?.id).toBe('sc_02');
    expect(lastUserOf(writers().at(-1) as Req)).toContain(`［玩家选择：和${heroine}一起去灯塔］`);

    // 自由输入：记成玩家事件，演员演出玩家的行动；这一幕演完了、只有一条路，直接走过去
    prev = v;
    v = await client.stream('advInput', { ...ref, text: '  问她那晚到底看到了什么  ' }, () => {});
    expect(kinds(after(v, prev))).toEqual(['player', 'ai']);
    expect(after(v, prev)[0]?.text).toBe('问她那晚到底看到了什么');
    expect(after(v, prev)[1]?.segments?.[0]).toEqual({ kind: 'narration', text: '你决定：问她那晚到底看到了什么。' });
    expect(after(v, prev)[1]?.plot?.exit).toEqual({ to: 'sc_04', by: 'director' });
    expect(v.adv?.menu).toBeNull();
    await expect(client.stream('advInput', { ...ref, text: '   ' }, () => {})).rejects.toThrow('请输入你想做的事');
    // 回想里自由输入也是一条选择记录，可以回到输入之前
    const t = buildTimeline(v.path, { characters: world.characters, graph: world.graph });
    expect(t.backlog.find((b) => b.kind === 'choice' && b.label === '「问她那晚到底看到了什么」')).toBeDefined();

    // 雾潮之夜：好感够了，"告诉她真相"可以选 → 好结局
    v = await client.stream('advNext', ref, () => {});
    expect(v.adv?.scene?.id).toBe('sc_04');
    v = await client.stream('advChoose', { ...ref, index: 0 }, () => {});
    expect(v.adv?.menu).toMatchObject({ source: 'exits', options: [{ label: '告诉她真相', enabled: true }, { label: '独自承担' }] });
    expect(v.adv?.vars[aff]).toBeGreaterThanOrEqual(40);
    v = await client.stream('advChoose', { ...ref, index: 0 }, () => {});
    expect(v.adv).toMatchObject({ finished: true, ending: { id: 'sc_05', kind: 'good' }, aiScene: false });
    expect(v.path.at(-1)?.plot).toMatchObject({ scene: 'sc_05', ending: 'sc_05', finished: true });
    expect(v.path.at(-1)?.segments?.at(-1)).toEqual({ kind: 'narration', text: '故事在这里落下帷幕：守望。' });
    expect(v.adv?.progress).toMatchObject({ reached: 1, total: 2, scenes: { visited: 4, total: 6 } });
    await expect(client.stream('advNext', ref, () => {})).rejects.toThrow('剧情已经结束了');
  });

  it('没配模型：AI 演出的幕用占位旁白走通；手写剧本的幕不能自由输入；配好模型后接着由 AI 演', async () => {
    const { ref } = await generated();
    await client.call('setRole', { role: 'default', route: null });
    let v = await client.call('getPlaythrough', ref);
    expect(v.adv).toMatchObject({ aiScene: true, needsModel: true });
    v = await client.stream('advNext', ref, () => {});
    expect(v.path.at(-1)).toMatchObject({ kind: 'script', segments: [{ kind: 'narration', text: expect.stringContaining('之后由 AI 演出') }] });
    await expect(client.stream('advInput', { ...ref, text: '四处看看' }, () => {})).rejects.toThrow('只能用选项推进');
    expect(directors()).toHaveLength(0);
  });

  it('手写剧本和 AI 演出混在一起：示例世界里没写剧本的结局幕由 AI 收尾', async () => {
    await setup();
    await client.call('importWorld', { path: path.join(EXAMPLES, 'old_library') });
    const worldId = 'old_library';
    let v = await client.call('startPlaythrough', { worldId, mode: 'adv' });
    const ref = { worldId, playthroughId: v.playthrough.id };
    // 第一幕是手写剧本：开局直接播到第一个选项，不调模型
    expect(v.adv?.menu?.source).toBe('script');
    expect(v.adv?.aiScene).toBe(false);
    await expect(client.stream('advInput', { ...ref, text: '你好' }, () => {})).rejects.toThrow('只能用选项推进');
    // "那本书根本不存在吧" → 到了门口好感不够，自动走向没写剧本的坏结局
    for (const pick of [2, 0]) {
      v = await client.stream('advChoose', { ...ref, index: pick }, () => {});
      for (let guard = 0; guard < 10 && !v.adv?.menu && !v.adv?.finished; guard++) v = await client.stream('advNext', ref, () => {});
    }
    expect(v.adv).toMatchObject({ finished: true, ending: { id: 'sc_07', kind: 'bad' } });
    const last = v.path.at(-1) as PlayEvent;
    expect(last).toMatchObject({ kind: 'ai', plot: { scene: 'sc_07', ending: 'sc_07', finished: true } });
    expect(directors()).toHaveLength(1);
    expect(lastUserOf(writers()[0] as Req)).toContain('［结局］擦肩而过');
    expect(v.adv?.progress.reached).toBe(1);
  });
});

describe('剧情 ADV：跑偏时的四个选项（16.6）', () => {
  /** 生成的世界里演一拍，再输入两次跑题的行动：导演连续两拍报告偏离，停下来问玩家。 */
  async function drifted() {
    const g = await generated();
    let v = await client.stream('advNext', g.ref, () => {});
    v = await client.stream('advInput', { ...g.ref, text: '跑题：先去酒馆喝一杯' }, () => {});
    expect(v.path.at(-1)?.plot).toMatchObject({ scene: 'sc_01', offTrack: true });
    expect(v.path.at(-1)?.plot?.askDrift).toBeUndefined();
    expect(v.adv?.drift.ask).toBe(false);
    v = await client.stream('advInput', { ...g.ref, text: '跑题：再点一杯' }, () => {});
    expect(v.path.at(-1)?.plot).toMatchObject({ scene: 'sc_01', offTrack: true, askDrift: true });
    expect(v.adv?.drift).toEqual({ ask: true, paused: false, pullBack: false, detour: true });
    // ADV 里跑偏了先问玩家，导演不会自己往回拉；offTrack 看玩家的行动，不许把主角挡回这一幕
    expect(lastUserOf(directors().at(-1) as Req)).not.toContain('带回这一幕');
    expect(systemOf(directors().at(-1) as Req)).toContain('offTrack：看玩家这一次的行动');
    expect(systemOf(directors().at(-1) as Req)).toContain('不要找理由（拦路、劝阻、让别人代办）');
    return { ...g, v, askAt: v.path.at(-1)?.id as string };
  }

  it('连续偏离就停下来问；回答之前不能往下演；拉回来只管下一拍', async () => {
    const { ref, v: asked } = await drifted();
    expect(asked.adv?.menu?.source).toBe('ai');
    await expect(client.stream('advNext', ref, () => {})).rejects.toThrow('请先决定怎么处理');
    await expect(client.stream('advChoose', { ...ref, index: 0 }, () => {})).rejects.toThrow('请先决定怎么处理');
    await expect(client.stream('advInput', { ...ref, text: '继续喝' }, () => {})).rejects.toThrow('请先决定怎么处理');
    await expect(client.stream('advDrift', { ...ref, choice: 'resume' }, () => {})).rejects.toThrow('剧情图没有暂停');

    let v = await client.stream('advDrift', { ...ref, choice: 'pull' }, () => {});
    expect(kinds(after(v, asked))).toEqual(['drift']);
    expect(v.adv?.drift).toMatchObject({ ask: false, pullBack: true });
    // 上一拍的选项还在，接着选；这一拍导演要把场面带回这一幕
    expect(labels(v)).toEqual(labels(asked));
    v = await client.stream('advInput', { ...ref, text: '跑题：还想再喝' }, () => {});
    expect(lastUserOf(directors().at(-1) as Req)).toContain('玩家想回到这一幕');
    expect(v.path.at(-1)?.plot?.offTrack).toBeUndefined();
    expect(v.path.at(-1)?.plot?.points).toEqual(['sc_01_2']);
    expect(v.adv?.drift.pullBack).toBe(false);
    // 回想里记着这次选择
    const t = buildTimeline(v.path, { characters: [] });
    expect(t.backlog.filter((b) => b.kind === 'note')).toEqual([expect.objectContaining({ label: '剧情图', text: '拉回来' })]);
  });

  it('不用管：这一幕不再提醒', async () => {
    const { ref } = await drifted();
    let v = await client.stream('advDrift', { ...ref, choice: 'ignore' }, () => {});
    expect(v.adv?.drift).toMatchObject({ ask: false, pullBack: false });
    v = await client.stream('advInput', { ...ref, text: '跑题：再来一杯' }, () => {});
    v = await client.stream('advInput', { ...ref, text: '跑题：和酒保聊天' }, () => {});
    expect(v.path.at(-1)?.plot).toMatchObject({ offTrack: true });
    expect(v.path.at(-1)?.plot?.askDrift).toBeUndefined();
    expect(v.adv?.drift.ask).toBe(false);
  });

  it('暂停剧情图：自由推进，不报告进度、不算拍数、选项不带出口；恢复之后下一拍拉回来', async () => {
    const { world, ref, v: asked } = await drifted();
    const beatsBefore = foldPlot(world.graph as never, world.variables, asked.path).sceneBeats;
    let v = await client.stream('advDrift', { ...ref, choice: 'pause' }, () => {});
    expect(v.adv?.drift).toMatchObject({ ask: false, paused: true });
    v = await client.stream('advInput', { ...ref, text: '跑题：在镇上随便逛逛' }, () => {});
    const d = lastUserOf(directors().at(-1) as Req);
    expect(d).toContain('玩家暂停了剧情图');
    expect(d).not.toContain('## 当前这一幕');
    expect(d).not.toContain('## 出口');
    expect(lastUserOf(writers().at(-1) as Req)).toContain('［剧情图暂停中］');
    expect(v.path.at(-1)?.plot).toEqual(expect.objectContaining({ scene: 'sc_01', paused: true }));
    expect(v.path.at(-1)?.plot?.offTrack).toBeUndefined();
    expect(v.path.at(-1)?.plot?.points).toBeUndefined();
    expect(foldPlot(world.graph as never, world.variables, v.path).sceneBeats).toBe(beatsBefore);
    expect(v.adv?.menu?.options.every((o) => !o.exit)).toBe(true);
    // 暂停时还是可以继续往下演，也不会再问
    v = await client.stream('advInput', { ...ref, text: '跑题：去海边吹风' }, () => {});
    expect(v.adv?.drift).toMatchObject({ ask: false, paused: true });

    v = await client.stream('advDrift', { ...ref, choice: 'resume' }, () => {});
    expect(v.adv?.drift).toMatchObject({ paused: false, pullBack: true });
    v = await client.stream('advChoose', { ...ref, index: 0 }, () => {});
    expect(lastUserOf(directors().at(-1) as Req)).toContain('## 当前这一幕：[sc_01]');
    expect(lastUserOf(directors().at(-1) as Req)).toContain('玩家想回到这一幕');
  });

  it('就这样走：导演把跑偏的这一段写成新的一幕，演完接回原来的幕', async () => {
    const { world, ref, v: asked } = await drifted();
    const chunks: PlayChunk[] = [];
    let v = await client.stream('advDrift', { ...ref, choice: 'detour' }, (c) => chunks.push(c));
    expect(chunks).toContainEqual({ type: 'phase', phase: 'detour' });
    const ev = after(v, asked);
    expect(kinds(ev)).toEqual(['drift']);
    const scene = ev[0]?.plot?.append?.scenes[0];
    expect(ev[0]).toMatchObject({ drift: 'detour', text: '酒馆里的插曲', plot: { scene: 'sc_01', exit: { to: 'sc_07', by: 'drift' } } });
    expect(scene).toMatchObject({
      id: 'sc_07',
      chapter: 'ch_01',
      title: '酒馆里的插曲',
      points: [
        { id: 'sc_07_1', text: '在酒馆里听到传闻' },
        { id: 'sc_07_2', text: '有人注意到了主角' },
      ],
      minBeats: 1,
      maxBeats: 4,
      // 当前幕是岔路：只能接回当前幕，岔路还是由玩家决定
      exits: [expect.objectContaining({ to: 'sc_01' })],
    });
    expect(scene?.location).toBeTruthy();
    // 导演写新幕时只看得到当前幕和可以接回的幕
    const prompt = lastUserOf(requests().filter((r) => JSON.stringify(r).includes('adv_detour')).at(-1) as Req);
    expect(prompt).toContain('# 演完之后可以接回的幕\n- sc_01「归乡」');
    expect(prompt).not.toContain('sc_02');
    // 只属于这个周目：世界的剧情图不变
    expect((await client.call('getWorld', { id: ref.worldId })).graph?.scenes.map((s) => s.id)).not.toContain('sc_07');
    expect(v.adv?.scene).toMatchObject({ id: 'sc_07', title: '酒馆里的插曲' });
    expect(v.adv?.drift.ask).toBe(false);
    expect(labels(v)).toEqual(labels(asked));

    // 在新的一幕里演，标题卡用这个周目的剧情图
    v = await client.stream('advChoose', { ...ref, index: 0 }, () => {});
    expect(v.path.at(-1)?.plot).toMatchObject({ scene: 'sc_07', points: ['sc_07_1'] });
    expect(lastUserOf(directors().at(-1) as Req)).toContain('## 当前这一幕：[sc_07] 酒馆里的插曲');
    // 告诉导演：玩家回到原来那条线上不算偏离，收个尾接回去
    expect(lastUserOf(directors().at(-1) as Req)).toContain('这一幕是玩家跑偏时插进来的一段，演完就接回「归乡」');
    const graph = foldPlot(world.graph as never, world.variables, v.path).graph;
    const t = buildTimeline(v.path, { characters: world.characters, graph });
    expect(t.steps.filter((s) => s.kind === 'card').map((s) => s.card?.title)).toContain('酒馆里的插曲');
    expect(t.backlog.find((b) => b.kind === 'note')).toMatchObject({ text: '就这样走：插进新的一幕「酒馆里的插曲」' });
    // 演完接回原来的幕
    v = await client.stream('advChoose', { ...ref, index: 0 }, () => {});
    expect(v.path.at(-1)?.plot?.exit).toEqual({ to: 'sc_01', by: 'director' });
    expect(v.adv?.scene?.id).toBe('sc_01');
  });
});
