import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type MockServer, type MockServerOptions, startMockServer } from '@auto-adv/providers/testing';
import type { PlotGraph } from '@auto-adv/schema';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createPortPair,
  Engine,
  type EngineContract,
  type GenesisChunk,
  MemorySecretStore,
  RpcClient,
  serveRpc,
} from '../src/index.ts';
import { MEMORY } from '../src/play/runtime.ts';

let dir: string;
let server: MockServer;
let engine: Engine;
let client: RpcClient<EngineContract>;

async function setup(mock: MockServerOptions = {}) {
  dir = await mkdtemp(path.join(os.tmpdir(), 'auto-adv-world-'));
  server = await startMockServer({ chunkDelayMs: 0, ...mock });
  engine = new Engine({ dataDir: dir, secrets: new MemorySecretStore(), callLogFile: ':memory:' });
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
  await client.call('setRole', { role: 'default', route: { endpointId: ep.id, model: 'mock-chat' } });
  return ep;
}

afterEach(async () => {
  client?.close();
  engine?.close();
  await server?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function createWorld(options = {}) {
  const chunks: GenesisChunk[] = [];
  const summary = await client.stream('createWorld', { seed: '雾中的灯塔', preset: 'mystery', options }, (c) =>
    chunks.push(c),
  );
  return { summary, chunks };
}

describe('一键创世', () => {
  it('从一句话生成完整的世界并写进世界文件夹', async () => {
    await setup();
    const { summary, chunks } = await createWorld({ characterCount: 2, protagonistName: '阿远' });
    expect(summary.status).toBe('ready');
    expect(summary.title).toBe('雾港谜灯');
    expect(Object.values(summary.steps).every((s) => s?.status === 'done')).toBe(true);
    expect(chunks[0]).toEqual({ type: 'world', worldId: summary.id });
    expect(chunks.some((c) => c.type === 'progress' && c.step === 'worldview')).toBe(true);

    const w = await client.call('getWorld', { id: summary.id });
    expect(w.characters.map((c) => c.name)).toEqual(['阿远', '林夕', '白鸦']);
    expect(w.characters[0]?.role).toBe('protagonist');
    expect(w.characters[0]?.relationships[0]?.to).toBe('char_02');
    expect(w.locations).toHaveLength(4);
    expect(w.locations[0]?.connections).toEqual(['loc_02']);
    expect(w.lore.find((l) => l.title === '雾潮')?.activation).toBe('always');
    expect(w.lore.find((l) => l.title === '灯塔' || l.keys.includes('灯塔'))).toBeTruthy();
    expect(w.opening?.locationId).toBe('loc_01');
    expect(w.opening?.presentCharacterIds).toEqual(['char_02']);
    expect(w.opening?.lines[0]?.characterId).toBe('char_02');
    expect(w.worldview).toContain('## 当前局势');
    // 剧情图：幕重新编号成 sc_NN，要点是 sc_NN_N，地点和角色换成 id，条件按结构解析；能通过结构检查
    const g = w.graph as PlotGraph;
    expect(g.start).toBe('sc_01');
    expect(g.chapters.map((c) => c.id)).toEqual(['ch_01', 'ch_02']);
    expect(g.scenes.map((s) => [s.id, s.points.map((p) => p.id), s.exits.map((e) => e.to)])).toEqual([
      ['sc_01', ['sc_01_1', 'sc_01_2'], ['sc_02', 'sc_03']],
      ['sc_02', ['sc_02_1', 'sc_02_2'], ['sc_04']],
      ['sc_03', ['sc_03_1', 'sc_03_2'], ['sc_04']],
      ['sc_04', ['sc_04_1', 'sc_04_2'], ['sc_05', 'sc_06']],
      ['sc_05', [], []],
      ['sc_06', [], []],
    ]);
    expect(g.scenes[0]).toMatchObject({ location: 'loc_01', cast: ['char_02'], chapter: 'ch_01' });
    expect(g.scenes[3]?.exits[0]?.if).toEqual({ gte: ['affinity.char_02', 40] });
    expect(g.scenes[3]?.default).toBe('sc_06');
    expect(g.scenes[4]?.ending).toMatchObject({ kind: 'good' });
    expect(w.variables.map((v) => [v.id, v.category, v.initial])).toEqual([
      ['affinity.char_02', 'relationship', 30],
      ['flag.found_log', 'other', false],
      ['skill.insight', 'attribute', 1],
    ]);
    expect(w.plotCheck?.ok).toBe(true);
    // 开场提示词里带上了第一幕
    const openingReq = server.requests.find((r) => JSON.stringify(r).includes('story_opening'));
    expect(JSON.stringify(openingReq)).toContain('# 第一幕');
    expect(JSON.stringify(openingReq)).toContain('码头重逢');

    const worldDir = path.join(dir, 'worlds', summary.id);
    const manifest = JSON.parse(await readFile(path.join(worldDir, 'world.json'), 'utf8'));
    expect(manifest.models).toEqual(['模拟服务 / mock-chat']);
    await readFile(path.join(worldDir, 'characters', 'char_01', 'character.json'), 'utf8');
    await readFile(path.join(worldDir, 'setting', 'worldview.md'), 'utf8');
    // 写出来的文件是格式版本 1
    const outline = JSON.parse(await readFile(path.join(worldDir, 'plot', 'outline.json'), 'utf8'));
    expect(outline.formatVersion).toBe(1);
    expect(outline.scenes).toHaveLength(6);
    const vars = JSON.parse(await readFile(path.join(worldDir, 'systems', 'variables.json'), 'utf8'));
    expect(vars.variables).toHaveLength(3);

    const logs = await client.call('listCalls', {});
    const tags = new Set(logs.items.map((c) => c.tag));
    expect(tags).toEqual(
      new Set([
        'genesis.brief',
        'genesis.worldview',
        'genesis.cast',
        'genesis.locations',
        'genesis.plot',
        'genesis.lore',
        'genesis.opening',
      ]),
    );
    expect(logs.items.every((c) => c.role === 'worldgen')).toBe(true);

    expect((await client.call('listWorlds')).map((x) => x.id)).toEqual([summary.id]);
  });

  it('某一步失败后可以续跑；也可以从某一步起重新生成', async () => {
    let breakCast = true;
    await setup({ reply: (_last, info) => (breakCast && info.schemaName === 'world_cast' ? '我不想输出 JSON' : undefined) });
    const { summary } = await createWorld();
    expect(summary.status).toBe('failed');
    expect(summary.steps.cast?.status).toBe('failed');
    expect(summary.steps.cast?.error).toContain('JSON');
    expect(summary.steps.locations?.status).toBe('done');
    expect(summary.steps.lore?.status).toBe('pending');
    // 失败的那步重试了 2 次
    expect(server.requests.filter((r) => JSON.stringify(r).includes('world_cast'))).toHaveLength(3);

    breakCast = false;
    const before = server.requests.length;
    const resumed = await client.stream('runGenesis', { worldId: summary.id }, () => {});
    expect(resumed.status).toBe('ready');
    expect(server.requests.length - before).toBe(4); // cast、plot、lore、opening

    const before2 = server.requests.length;
    const rerun = await client.stream('runGenesis', { worldId: summary.id, from: 'locations' }, () => {});
    expect(rerun.status).toBe('ready');
    expect(server.requests.length - before2).toBe(4); // locations、plot、lore、opening
  });

  it('剧情图过不了结构检查时，把问题反馈给模型重写', async () => {
    let broken = 1;
    await setup({
      reply: (_last, info) => {
        if (info.schemaName !== 'plot_graph' || broken-- <= 0) return undefined;
        // 第二幕是死路，条件写成了字符串表达式，出口指向不存在的幕
        return JSON.stringify({
          scenes: [
            { id: 'a', title: '开头', exits: [{ to: 'b' }, { to: 'x', label: '去不存在的地方', if: 'affinity >= 3' }] },
            { id: 'b', title: '死路' },
            { id: 'c', title: '结局', ending: { kind: 'good' } },
          ],
        });
      },
    });
    const { summary } = await createWorld();
    expect(summary.status).toBe('ready');
    const plots = server.requests.filter((r) => JSON.stringify(r).includes('plot_graph'));
    expect(plots).toHaveLength(2);
    const feedback = JSON.stringify(plots[1]);
    expect(feedback).toContain('剧情图有这些问题');
    expect(feedback).toContain('不存在的幕「x」');
    expect(feedback).toContain('死路');
    expect(feedback).toContain('走不到这一幕');
    const w = await client.call('getWorld', { id: summary.id });
    expect(w.graph?.scenes).toHaveLength(6);
  });

  it('M2 的旧骨架（格式版本 0）读取时迁移成剧情图', async () => {
    await setup();
    const { summary } = await createWorld();
    const file = path.join(dir, 'worlds', summary.id, 'plot', 'outline.json');
    await writeFile(
      file,
      JSON.stringify({
        formatVersion: 0,
        premise: '旧的骨架',
        acts: [{ id: 'act_01', title: '第一篇', chapters: [{ id: 'ch_01_01', title: '归乡', goal: '回到故乡', beats: [{ id: 'b_01', text: '下船' }] }] }],
        endings: [{ id: 'end_01', title: '守望', condition: '留下' }],
      }),
    );
    const w = await client.call('getWorld', { id: summary.id });
    expect(w.graph?.formatVersion).toBe(1);
    expect(w.graph?.scenes.map((s) => [s.id, s.points.map((p) => p.id)])).toEqual([
      ['sc_01', ['b_01']],
      ['sc_02', []],
    ]);
    expect(w.plotCheck?.ok).toBe(true);
  });

  it('中途取消后状态保留，之后可以续跑', async () => {
    await setup({ chunkDelayMs: 3 });
    let worldId = '';
    const ac = new AbortController();
    const p = client.stream(
      'createWorld',
      { seed: '' },
      (c) => {
        if (c.type === 'world') worldId = c.worldId;
        if (c.type === 'step' && c.step === 'worldview' && c.state.status === 'running') ac.abort();
      },
      ac.signal,
    );
    // 取消后引擎把进行中的步骤退回"待生成"并正常收尾
    const result = await p.catch(() => null);
    if (result) expect(result.status).toBe('generating');
    // 等引擎收尾
    for (let i = 0; i < 50 && engine.genesis.isRunning(worldId); i++) await new Promise((r) => setTimeout(r, 20));
    const w = await client.call('getWorld', { id: worldId });
    expect(w.summary.status).toBe('generating');
    expect(w.summary.steps.brief?.status).toBe('done');
    expect(w.summary.steps.worldview?.status).toBe('pending');
    const done = await client.stream('runGenesis', { worldId }, () => {});
    expect(done.status).toBe('ready');
  });

  it('做过能力探测的模型用 json_schema 约束输出', async () => {
    const ep = await setup();
    await client.stream('probe', { endpointId: ep.id, model: 'mock-chat' }, () => {});
    const { summary } = await createWorld();
    expect(summary.status).toBe('ready');
    const cast = server.requests.find((r) => JSON.stringify(r.response_format ?? '').includes('world_cast')) as {
      response_format: { type: string; json_schema: { schema: { properties: object } } };
    };
    expect(cast.response_format.type).toBe('json_schema');
    expect(Object.keys(cast.response_format.json_schema.schema.properties)).toEqual(['characters']);
  });

  it('删除世界', async () => {
    await setup();
    const { summary } = await createWorld();
    await client.call('startPlaythrough', { worldId: summary.id });
    await client.call('deleteWorld', { id: summary.id });
    expect(await client.call('listWorlds')).toEqual([]);
    await expect(client.call('getWorld', { id: summary.id })).rejects.toThrow('世界不存在');
  });
});

describe('自由对话', () => {
  async function ready() {
    await setup();
    const { summary } = await createWorld({ characterCount: 2 });
    const view = await client.call('startPlaythrough', { worldId: summary.id });
    return { worldId: summary.id, playthroughId: view.playthrough.id, view };
  }

  it('开场 → 发言 → 流式回复，台词对应到角色', async () => {
    const { worldId, playthroughId, view } = await ready();
    expect(view.path).toHaveLength(1);
    expect(view.path[0]?.kind).toBe('opening');
    expect(view.scene).toEqual({ locationId: 'loc_01', presentCharacterIds: ['char_02'] });
    expect(view.path[0]?.segments?.at(-1)).toMatchObject({ kind: 'line', characterId: 'char_02', name: '林夕' });

    const chunks: string[] = [];
    const after = await client.stream('send', { worldId, playthroughId, text: '灯塔是谁点亮的？' }, (c) =>
      chunks.push(c.type),
    );
    expect(chunks[0]).toBe('player');
    expect(chunks).toContain('seg');
    expect(after.path.map((e) => e.kind)).toEqual(['opening', 'player', 'ai']);
    const reply = after.path[2];
    expect(reply?.segments).toContainEqual(expect.objectContaining({ kind: 'line', characterId: 'char_02', name: '林夕' }));
    expect(reply?.callId).toBeTruthy();

    // 上下文：系统提示里有世界和角色，最后一条用户消息带触发的设定和玩家行动
    const req = server.requests.at(-1) as { messages: { role: string; content: string }[] };
    expect(req.messages[0]?.content).toContain('# 在场角色\n## 林夕');
    const last = req.messages.at(-1)?.content ?? '';
    expect(last).toContain('雾潮'); // always 条目
    expect(last).toContain('午夜灯光'); // 关键词"灯塔"触发
    expect(last).not.toContain('守灯人：');
    expect(last).toContain('灯塔是谁点亮的？');

    const logs = await client.call('listCalls', {});
    expect(logs.items[0]?.tag).toBe('play.reply');
    expect(logs.items[0]?.role).toBe('actor');
  });

  it('重抽、切换分支、回退、编辑、删除分支', async () => {
    const { worldId, playthroughId } = await ready();
    const ref = { worldId, playthroughId };
    const v1 = await client.stream('send', { ...ref, text: '你好' }, () => {});
    const first = v1.path[2];
    if (!first) throw new Error('no reply');

    const v2 = await client.stream('regenerate', { ...ref, eventId: first.id }, () => {});
    const second = v2.path[2];
    expect(second?.id).not.toBe(first.id);
    expect(second?.siblingIds).toEqual([first.id, second?.id]);
    expect(second?.siblingIndex).toBe(1);
    expect(JSON.stringify(second?.segments)).not.toBe(JSON.stringify(first.segments));

    const v3 = await client.call('switchBranch', { ...ref, eventId: first.id });
    expect(v3.path[2]?.id).toBe(first.id);

    // 回退到开场，再说别的：形成新分支
    const opening = v3.path[0];
    if (!opening) throw new Error('no opening');
    const v4 = await client.call('rewind', { ...ref, eventId: opening.id });
    expect(v4.path).toHaveLength(1);
    const v5 = await client.stream('send', { ...ref, text: '我们去酒馆吧' }, () => {});
    expect(v5.path[1]?.siblingIds).toHaveLength(2);

    // 编辑回复：按文本格式重新解析
    const ai = v5.path[2];
    if (!ai) throw new Error('no ai');
    const v6 = await client.call('editEvent', { ...ref, eventId: ai.id, text: '夜色很深。\n【林夕】走吧。' });
    expect(v6.path[2]?.segments).toEqual([
      { kind: 'narration', text: '夜色很深。' },
      { kind: 'line', characterId: 'char_02', name: '林夕', text: '走吧。' },
    ]);
    expect(v6.path[2]?.edited).toBe(true);

    // 编辑后重发：接在开场后面
    const v7 = await client.stream('send', { ...ref, text: '换个说法', parentId: opening.id }, () => {});
    expect(v7.path[1]?.siblingIds).toHaveLength(3);

    // 删除当前分支：回到父节点上最新的另一个分支
    const v8 = await client.call('deleteBranch', { ...ref, eventId: v7.path[1]?.id ?? '' });
    expect(v8.path[1]?.siblingIds).toHaveLength(2);
    expect(v8.path[1]?.text).toBe('我们去酒馆吧');
  });

  it('继续（空输入）、换场景、存档读档', async () => {
    const { worldId, playthroughId } = await ready();
    const ref = { worldId, playthroughId };
    const v1 = await client.stream('send', { ...ref, text: '' }, () => {});
    expect(v1.path.map((e) => e.kind)).toEqual(['opening', 'ai']);
    const req = server.requests.at(-1) as { messages: { content: string }[] };
    expect(req.messages.at(-1)?.content).toContain('暂时没有行动');

    const saved = await client.call('saveSlot', { ...ref, name: '酒馆之前' });
    expect(saved.saves[0]).toMatchObject({ name: '酒馆之前', eventId: v1.path[1]?.id });

    const v2 = await client.call('setScene', { ...ref, locationId: 'loc_03', presentCharacterIds: ['char_02', 'char_03'] });
    expect(v2.scene).toEqual({ locationId: 'loc_03', presentCharacterIds: ['char_02', 'char_03'] });
    await client.stream('send', { ...ref, text: '老板，来两杯' }, () => {});
    const req2 = server.requests.at(-1) as { messages: { role: string; content: string }[] };
    expect(req2.messages[0]?.content).toContain('- 鲸骨酒馆：');
    expect(req2.messages.some((m) => m.content.includes('［场景切换］地点：鲸骨酒馆'))).toBe(true);

    const loaded = await client.call('loadSave', { ...ref, saveId: saved.saves[0]?.id ?? '' });
    expect(loaded.path).toHaveLength(2);
    expect(loaded.scene.locationId).toBe('loc_01');

    const list = await client.call('listPlaythroughs', { worldId });
    expect(list).toHaveLength(1);
    expect(list[0]?.preview).toContain('林夕');

    const v3 = await client.call('deleteSave', { ...ref, saveId: saved.saves[0]?.id ?? '' });
    expect(v3.saves).toEqual([]);
  });

  it('对话变长后自动整理前情提要，之后的上下文用摘要代替旧内容', async () => {
    const old = { ...MEMORY };
    Object.assign(MEMORY, { triggerEvents: 6, keepEvents: 2 });
    try {
      const { worldId, playthroughId } = await ready();
      const ref = { worldId, playthroughId };
      for (let i = 0; i < 4; i++) await client.stream('send', { ...ref, text: `第 ${i + 1} 句` }, () => {});
      await engine.play.flush(ref);
      const view = await client.call('getPlaythrough', ref);
      expect(view.memory?.text).toContain('前情提要');
      // 第 3 轮后原文 7 条 > 6，压缩到只剩最近 2 条；第 4 轮后原文 4 条，还不需要整理
      expect(view.path).toHaveLength(9);
      expect(view.memory?.coveredEvents).toBe(5);

      await client.stream('send', { ...ref, text: '最后一句' }, () => {});
      const req = server.requests.at(-1) as { messages: { role: string; content: string }[] };
      expect(req.messages[0]?.content).toContain('# 前情提要');
      const all = req.messages.map((m) => m.content).join('\n');
      expect(all).not.toContain('第 1 句');
      expect(all).toContain('第 4 句');
      const logs = await client.call('listCalls', {});
      expect(logs.items.some((c) => c.tag === 'play.memory' && c.role === 'archivist')).toBe(true);
    } finally {
      Object.assign(MEMORY, old);
    }
  });

  it('世界没生成完不能开始游玩', async () => {
    await setup({ reply: (_l, info) => (info.schemaName === 'story_opening' ? 'oops' : undefined) });
    const { summary } = await createWorld();
    expect(summary.status).toBe('failed');
    await expect(client.call('startPlaythrough', { worldId: summary.id })).rejects.toThrow('还没有生成完');
  });
});
