import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type MockServer, type MockServerOptions, startMockServer } from '@auto-adv/providers/testing';
import type { ObserverSettings } from '@auto-adv/schema';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createPortPair,
  Engine,
  type EngineContract,
  MemorySecretStore,
  type ObserverChunk,
  type PlayEvent,
  type PlayRef,
  type PlayView,
  RpcClient,
  serveRpc,
} from '../src/index.ts';
import { validatePlan } from '../src/play/observer/beat.ts';
import { drawCard, EVENT_CARDS, maxSimilarity, similarity } from '../src/play/observer/quality.ts';
import { overBudget } from '../src/play/observer/runner.ts';
import { MEMORY } from '../src/play/runtime.ts';
import { foldState } from '../src/play/state.ts';

let dir: string;
let server: MockServer;
let engine: Engine;
let client: RpcClient<EngineContract>;
let open = false;

type Req = { messages: { role: string; content: string }[] };

async function teardown() {
  if (!open) return;
  open = false;
  client.close();
  engine.close();
  await server.close();
  await rm(dir, { recursive: true, force: true });
}

async function setup(mock: MockServerOptions = {}) {
  await teardown();
  open = true;
  dir = await mkdtemp(path.join(os.tmpdir(), 'auto-adv-observer-'));
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
    pricing: { 'mock-chat': { input: 1, output: 2 } },
  });
  await client.call('setRole', { role: 'default', route: { endpointId: ep.id, model: 'mock-chat' } });
}

afterEach(teardown);

/** 生成一个世界并开一个观察模式的周目（默认不限频率）。 */
async function observerReady(observer: Partial<ObserverSettings> = {}, mock: MockServerOptions = {}) {
  await setup(mock);
  const summary = await client.stream(
    'createWorld',
    { seed: '雾中的灯塔', preset: 'mystery', options: { characterCount: 2, protagonistName: '阿远' } },
    () => {},
  );
  const v = await client.call('startPlaythrough', {
    worldId: summary.id,
    mode: 'observer',
    observer: { maxBeatsPerMinute: 0, ...observer },
  });
  const ref: PlayRef = { worldId: summary.id, playthroughId: v.playthrough.id };
  return { ref, v, world: await client.call('getWorld', { id: summary.id }) };
}

async function until<T>(get: () => Promise<T> | T, pred: (v: T) => boolean, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (pred(v)) return v;
    if (Date.now() > end) throw new Error(`等待超时：${JSON.stringify(v).slice(0, 400)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const beats = (v: PlayView) => v.path.filter((e) => e.kind === 'ai');
const requests = () => server.requests as unknown as Req[];
const systemOf = (r: Req) => r.messages[0]?.content ?? '';

describe('观察模式', () => {
  it('后台连续生成：缓冲满了等观众，读到哪里补到哪里；实时推送进度', async () => {
    const { ref, v: start } = await observerReady({ bufferAhead: 2 });
    const view = () => client.call('getPlaythrough', ref);
    expect(start.playthrough.mode).toBe('observer');
    expect(start.playthrough.controlledId).toBeNull();
    expect(start.playthrough.observer?.strategy).toBe('merged');
    // 没有玩家：主角也在场
    expect(start.scene.presentCharacterIds).toEqual(['char_01', 'char_02']);
    expect(start.observer).toMatchObject({ running: false, activity: 'idle', ahead: 0, readId: start.path[0]?.id });
    expect(start.plot.currentChapterId).toBe('ch_01_01');

    const chunks: ObserverChunk[] = [];
    const ac = new AbortController();
    const watching = client.stream('observerWatch', ref, (c) => chunks.push(c), ac.signal).catch(() => {});
    await client.call('observerControl', { ...ref, action: 'play' });

    let v = await until(view, (x) => x.observer?.activity === 'buffered');
    expect(beats(v)).toHaveLength(2);
    expect(v.observer).toMatchObject({ running: true, ahead: 2, readId: v.path[0]?.id });
    const [b1, b2] = beats(v);
    expect(b1?.beat?.plan).toContain('模拟导演');
    expect(b1?.beat?.strategy).toBe('merged');
    expect(b1?.beat?.done).toEqual(['b_01_01_01']);
    expect(b2?.beat?.done).toEqual(['b_01_01_02']);
    expect(typeof b2?.beat?.similarity).toBe('number');
    // 台词都对应到了在场的角色
    const speakers = b1?.segments?.flatMap((s) => (s.kind === 'line' ? [s.characterId] : [])) ?? [];
    expect(speakers.length).toBeGreaterThan(0);
    for (const id of speakers) expect(['char_01', 'char_02', 'char_03']).toContain(id);
    expect(v.plot.done).toEqual(['b_01_01_01', 'b_01_01_02']);

    // 实时推送：开始一拍、导演、编剧、流式内容、完成
    await until(
      () => chunks.filter((c) => c.type === 'event').length,
      (n) => n === 2,
    );
    const types = chunks.map((c) => (c.type === 'phase' ? `phase:${c.phase}` : c.type));
    expect(types).toContain('beat-start');
    expect(types).toContain('phase:director');
    expect(types).toContain('phase:writer');
    expect(types).toContain('seg');
    expect(chunks.some((c) => c.type === 'status' && c.status.activity === 'generating')).toBe(true);

    // 观众读完第一拍：补一拍
    await client.call('observerRead', { ...ref, eventId: b1?.id ?? '' });
    v = await until(view, (x) => beats(x).length === 3 && x.observer?.activity === 'buffered');
    expect(v.observer?.ahead).toBe(2);

    // 调大缓冲：立刻继续生成
    v = await client.call('observerSettings', { ...ref, settings: { bufferAhead: 3 } });
    expect(v.playthrough.observer?.bufferAhead).toBe(3);
    v = await until(view, (x) => beats(x).length === 4 && x.observer?.activity === 'buffered');

    // 用量：每次调用都计入这个周目
    expect(v.playthrough.usage.calls).toBeGreaterThanOrEqual(8);
    expect(v.playthrough.usage.costs.CNY).toBeGreaterThan(0);
    expect(v.observer?.budget.tokens).toBe(v.playthrough.usage.inputTokens + v.playthrough.usage.outputTokens);

    const logs = await client.call('listCalls', {});
    const roles = new Map(logs.items.map((c) => [c.tag, c.role]));
    expect(roles.get('observer.director')).toBe('director');
    expect(roles.get('observer.writer')).toBe('narrator');

    v = await client.call('observerControl', { ...ref, action: 'pause' });
    expect(v.observer?.running).toBe(false);
    v = await until(view, (x) => x.observer?.activity === 'idle');
    ac.abort();
    await watching;
  });

  it('导演指令和悄悄话：空闲时直接写入，生成中排队；下一拍的导演看得到', async () => {
    const { ref } = await observerReady({ bufferAhead: 1 }, { chunkDelayMs: 4 });
    const view = () => client.call('getPlaythrough', ref);
    let v = await client.call('directive', { ...ref, text: '让白鸦突然出现' });
    expect(v.path.at(-1)).toMatchObject({ kind: 'directive', text: '让白鸦突然出现' });
    v = await client.call('whisper', { ...ref, characterId: 'char_02', text: '你其实很害怕' });
    expect(v.path.at(-1)).toMatchObject({ kind: 'whisper', characterId: 'char_02' });
    await expect(client.call('whisper', { ...ref, characterId: 'nobody', text: '嗨' })).rejects.toThrow('角色不存在');

    // 生成中下的指令：排队，下一拍开始前写进树
    let queued = false;
    const ac = new AbortController();
    const watching = client
      .stream(
        'observerWatch',
        ref,
        (c) => {
          if (!queued && c.type === 'phase' && c.phase === 'writer') {
            queued = true;
            void client.call('directive', { ...ref, text: '换到灯塔' }).then((x) => {
              expect(x.observer?.queued).toBe(1);
            });
          }
        },
        ac.signal,
      )
      .catch(() => {});
    await client.call('observerControl', { ...ref, action: 'play' });
    v = await until(view, (x) => x.observer?.activity === 'buffered' && beats(x).length === 1);
    const b1 = beats(v)[0] as PlayEvent;
    expect(b1.beat?.plan).toBe('按观众的要求：让白鸦突然出现');
    const director = requests().find((r) => JSON.stringify(r).includes('director_plan')) as Req;
    expect(JSON.stringify(director)).toContain('对林夕：你其实很害怕');
    expect(v.observer?.queued).toBe(1);

    await client.call('observerRead', { ...ref, eventId: b1.id });
    v = await until(view, (x) => x.observer?.activity === 'buffered' && beats(x).length === 2);
    expect(v.observer?.queued).toBe(0);
    const kinds = v.path.map((e) => e.kind);
    expect(kinds).toEqual(['opening', 'directive', 'whisper', 'ai', 'directive', 'ai']);
    expect(beats(v)[1]?.beat?.plan).toBe('按观众的要求：换到灯塔');
    ac.abort();
    await watching;
  });

  it('分演模式：旁白和各个演员分开生成，演员只知道自己该知道的事', async () => {
    const { ref, world } = await observerReady({ strategy: 'split', bufferAhead: 1 });
    await client.call('observerControl', { ...ref, action: 'play' });
    const v = await until(
      () => client.call('getPlaythrough', ref),
      (x) => x.observer?.activity === 'buffered',
    );
    const b = beats(v)[0] as PlayEvent;
    expect(b.beat?.strategy).toBe('split');
    expect(b.segments?.[0]?.kind).toBe('narration');
    const lines = b.segments?.filter((s) => s.kind === 'line') ?? [];
    expect(lines.length).toBeGreaterThan(0);

    // 导演看得到所有秘密
    const secrets = world.characters.flatMap((c) => c.secrets.map((s) => ({ owner: c, text: s.text })));
    expect(secrets.length).toBeGreaterThan(0);
    const director = JSON.stringify(requests().find((r) => JSON.stringify(r).includes('director_plan')));
    for (const s of secrets) expect(director).toContain(s.text);

    // 演员：只看得到自己的秘密，以及这一拍刚被告知的
    const actors = requests().filter((r) => systemOf(r).startsWith('你是演员'));
    expect(actors).toHaveLength(lines.length);
    for (const r of actors) {
      const name = /扮演「(.+?)」/.exec(systemOf(r))?.[1];
      const me = world.characters.find((c) => c.name === name);
      expect(me).toBeTruthy();
      const told = new Set(b.beat?.reveals?.filter((x) => x.to.includes(me?.id ?? '')).map((x) => x.characterId));
      const all = JSON.stringify(r.messages);
      for (const s of secrets) {
        if (s.owner.id === me?.id || told.has(s.owner.id)) continue;
        expect(all).not.toContain(s.text);
      }
    }
    expect(requests().some((r) => systemOf(r).startsWith('你是互动故事的旁白'))).toBe(true);
    const logs = await client.call('listCalls', {});
    expect(logs.items.some((c) => c.tag === 'observer.narrator' && c.role === 'narrator')).toBe(true);
    expect(logs.items.some((c) => c.tag === 'observer.actor' && c.role === 'actor')).toBe(true);
  });

  it('骨架演完自动续写新篇章；记忆整理出每个角色各自的记忆', async () => {
    const old = { ...MEMORY };
    Object.assign(MEMORY, { triggerEvents: 6, keepEvents: 2 });
    try {
      const { ref } = await observerReady({ bufferAhead: 10 });
      await client.call('observerControl', { ...ref, action: 'play' });
      let v = await until(
        () => client.call('getPlaythrough', ref),
        (x) => beats(x).length >= 10,
        20000,
      );
      await client.call('observerControl', { ...ref, action: 'pause' });
      const metas = beats(v).map((b) => b.beat);
      // 第一篇章 3 + 3 + 2 个节拍，按顺序一拍一个
      expect(metas.slice(0, 8).flatMap((m) => m?.done ?? [])).toEqual([
        'b_01_01_01',
        'b_01_01_02',
        'b_01_01_03',
        'b_01_02_01',
        'b_01_02_02',
        'b_01_02_03',
        'b_01_03_01',
        'b_01_03_02',
      ]);
      expect(metas.slice(0, 8).some((m) => m?.arc)).toBe(false);
      // 第 9 拍：骨架走完，续写第二篇章并接着推进
      expect(metas[8]?.arc?.id).toBe('act_02');
      expect(metas[8]?.arc?.title).toContain('续篇');
      expect(metas[8]?.done).toEqual(['b_02_01_01']);
      v = await client.call('getPlaythrough', ref);
      expect(v.plot.outline?.acts.map((a) => a.id)).toEqual(['act_01', 'act_02']);
      expect(v.plot.currentChapterId).toBe('ch_02_01');
      expect(v.plot.time).toMatch(/第 \d+ 天夜里/);
      const logs = await client.call('listCalls', {});
      expect(logs.items.some((c) => c.tag === 'observer.arc' && c.role === 'director')).toBe(true);

      // 前情提要和各角色的记忆
      await engine.play.flush(ref);
      v = await client.call('getPlaythrough', ref);
      expect(v.memory?.text).toContain('模拟记忆');
      expect(requests().some((r) => JSON.stringify(r).includes('story_memory'))).toBe(true);
      // 之后的编剧拿到了各角色的记忆
      expect(requests().some((r) => systemOf(r).includes('# 各角色目前知道的事'))).toBe(true);
    } finally {
      Object.assign(MEMORY, old);
    }
  });

  it('安全阀：超预算、连续失败、超频都会让它停下或放慢', async () => {
    const { ref } = await observerReady({ budgetTokens: 1, bufferAhead: 5 });
    await client.call('observerControl', { ...ref, action: 'play' });
    const v = await until(
      () => client.call('getPlaythrough', ref),
      (x) => x.observer?.stopReason === 'budget' && x.observer.activity === 'idle',
    );
    expect(v.observer?.running).toBe(false);
    expect(beats(v)).toHaveLength(1);
    // 预算按 token 算：再按播放也会马上停下
    await client.call('observerControl', { ...ref, action: 'play' });
    await until(
      () => client.call('getPlaythrough', ref),
      (x) => x.observer?.stopReason === 'budget' && !x.observer.running,
    );
    expect(beats(await client.call('getPlaythrough', ref))).toHaveLength(1);

    // 导演一直输出坏 JSON：失败次数到上限后停下，并记下错误
    const r2 = await observerReady({ maxFailures: 1 }, { reply: (_l, info) => (info.schemaName === 'director_plan' ? '不给' : undefined) });
    const v2 = await until(
      async () => {
        const x = await client.call('getPlaythrough', r2.ref);
        if (x.observer?.activity === 'idle' && !x.observer.stopReason) await client.call('observerControl', { ...r2.ref, action: 'play' });
        return x;
      },
      (x) => x.observer?.stopReason === 'errors' && x.observer.activity === 'idle',
    );
    expect(v2.observer?.lastError).toBeTruthy();
    expect(v2.observer?.failures).toBe(1);
    expect(beats(v2)).toHaveLength(0);

    // 每分钟最多 1 拍：生成一拍后进入限速等待
    const r3 = await observerReady({ maxBeatsPerMinute: 1, bufferAhead: 5 });
    await client.call('observerControl', { ...r3.ref, action: 'play' });
    const v3 = await until(
      () => client.call('getPlaythrough', r3.ref),
      (x) => x.observer?.activity === 'throttled',
    );
    expect(beats(v3)).toHaveLength(1);
    await client.call('observerControl', { ...r3.ref, action: 'pause' });
  });

  it('接管角色：自动暂停，以该角色身份行动；交还后继续', async () => {
    const { ref } = await observerReady({ bufferAhead: 1 });
    const view = () => client.call('getPlaythrough', ref);
    await expect(client.stream('send', { ...ref, text: '你好' }, () => {})).rejects.toThrow('接管');
    await client.call('observerControl', { ...ref, action: 'play' });
    await until(view, (x) => x.observer?.activity === 'buffered');

    let v = await client.call('takeover', { ...ref, characterId: 'char_02' });
    expect(v.playthrough.controlledId).toBe('char_02');
    expect(v.observer).toMatchObject({ running: false, stopReason: 'takeover', ahead: 0 });
    expect(v.observer?.readId).toBe(v.playthrough.headId);

    v = await client.stream('send', { ...ref, text: '其实我一直在等你回来' }, () => {});
    const [player, reply] = v.path.slice(-2);
    expect(player).toMatchObject({ kind: 'player', characterId: 'char_02' });
    expect(reply?.kind).toBe('ai');
    expect(reply?.beat).toBeUndefined();
    expect(requests().some((r) => systemOf(r).includes('玩家扮演林夕'))).toBe(true);
    expect(v.observer?.readId).toBe(reply?.id);

    // 交还：因接管而暂停的继续播放
    v = await client.call('takeover', { ...ref, characterId: null });
    expect(v.playthrough.controlledId).toBeNull();
    v = await until(view, (x) => x.observer?.activity === 'buffered' && beats(x).filter((b) => b.beat).length === 2);
    expect(v.observer?.running).toBe(true);
    await client.call('observerControl', { ...ref, action: 'pause' });
  });

  it('回退会让它停下；重抽一拍生成新分支；运行中也能删除周目', async () => {
    const { ref } = await observerReady({ bufferAhead: 2 });
    const view = () => client.call('getPlaythrough', ref);
    await client.call('observerControl', { ...ref, action: 'play' });
    let v = await until(view, (x) => x.observer?.activity === 'buffered');
    const [b1] = beats(v);
    if (!b1) throw new Error('no beat');

    v = await client.call('rewind', { ...ref, eventId: b1.id });
    expect(v.observer).toMatchObject({ running: false, activity: 'idle', ahead: 1 });
    expect(beats(v)).toHaveLength(1);

    const chunks: string[] = [];
    v = await client.stream('regenerate', { ...ref, eventId: b1.id }, (c) => chunks.push(c.type));
    expect(chunks).toContain('seg');
    const again = beats(v)[0];
    expect(again?.id).not.toBe(b1.id);
    expect(again?.siblingIds).toEqual([b1.id, again?.id]);
    expect(again?.beat?.done).toEqual(['b_01_01_01']);
    expect(v.plot.done).toEqual(['b_01_01_01']);

    await client.call('observerControl', { ...ref, action: 'play' });
    await client.call('deletePlaythrough', ref);
    expect(await client.call('listPlaythroughs', { worldId: ref.worldId })).toEqual([]);
  });
});

describe('观察模式的纯逻辑', () => {
  it('validatePlan：不存在的地点和角色、跳章的节拍、没有秘密的揭示都被驳回', async () => {
    const { ref } = await observerReady();
    const world = await engine.worlds.load(ref.worldId);
    const v = await client.call('getPlaythrough', ref);
    const state = foldState(world, v.path);
    const plan = validatePlan(world, state, {
      plan: '测试',
      location: '月球',
      present: ['林夕', '路人甲'],
      time: '',
      speakers: [{ name: '白鸦', intent: '' }],
      completeBeats: ['b_01_01_02', 'b_01_02_01', ''],
      reveals: [
        { owner: '阿远', to: ['林夕'] },
        { owner: '林夕', to: ['白鸦', '林夕', '路人甲'] },
      ],
    });
    expect(plan.scene.locationId).toBe(state.scene.locationId);
    // 白鸦被安排说话：视为登场
    expect(plan.scene.presentCharacterIds).toEqual(['char_02', 'char_03']);
    expect(plan.done).toEqual(['b_01_01_02']);
    expect(plan.reveals).toEqual([{ characterId: 'char_02', to: ['char_03'] }]);
    expect(plan.rejected.join('\n')).toMatch(/月球[\s\S]*路人甲[\s\S]*b_01_02_01[\s\S]*阿远/);
  });

  it('foldState：从事件算出进度、时间、停滞、事件卡、秘密和待处理的指令', async () => {
    const { ref } = await observerReady();
    const world = await engine.worlds.load(ref.worldId);
    const [opening] = (await client.call('getPlaythrough', ref)).path;
    const ev = (kind: PlayEvent['kind'], extra: Partial<PlayEvent> = {}): PlayEvent => ({
      id: `e${Math.random()}`,
      parentId: null,
      kind,
      createdAt: 0,
      ...extra,
    });
    const path: PlayEvent[] = [
      opening as PlayEvent,
      ev('directive', { text: '旧指令' }),
      ev('ai', {
        beat: {
          plan: '',
          strategy: 'merged',
          done: ['b_01_01_01'],
          time: '黄昏',
          card: '停电',
          reveals: [{ characterId: 'char_02', to: ['char_03'] }],
        },
      }),
      ev('ai', { beat: { plan: '', strategy: 'merged' } }),
      ev('ai', { beat: { plan: '', strategy: 'merged' } }),
      ev('directive', { text: '新指令' }),
      ev('whisper', { text: '悄悄话', characterId: 'char_02' }),
    ];
    const s = foldState(world, path);
    expect([...s.done]).toEqual(['b_01_01_01']);
    expect(s.currentChapter?.id).toBe('ch_01_01');
    expect(s.time).toBe('黄昏');
    expect(s.beatsSinceProgress).toBe(2);
    expect(s.recentCards).toEqual(['停电']);
    expect([...(s.reveals.get('char_02') ?? [])]).toEqual(['char_03']);
    expect(s.directives.map((d) => d.text)).toEqual(['新指令']);
    expect(s.whispers.map((d) => d.text)).toEqual(['悄悄话']);

    // 换地点也算推进
    const moved = foldState(world, [...path, ev('ai', { beat: { plan: '', strategy: 'merged' }, scene: { locationId: 'loc_03', presentCharacterIds: [] } })]);
    expect(moved.beatsSinceProgress).toBe(0);
    expect(moved.directives).toEqual([]);
  });

  it('重复检测、事件卡、预算判断', () => {
    expect(similarity('灯塔又亮了，林夕看着海面。', '灯塔又亮了，林夕看着海面。')).toBe(1);
    expect(similarity('灯塔又亮了', '酒馆里很吵')).toBe(0);
    expect(maxSimilarity('灯塔又亮了', ['酒馆里很吵', '灯塔又亮了吗'])).toBe(1);
    const used: string[] = EVENT_CARDS.slice(0, EVENT_CARDS.length - 1);
    expect(drawCard(used)).toBe(EVENT_CARDS.at(-1));
    expect(EVENT_CARDS).toContain(drawCard([...EVENT_CARDS]));

    const s = { budgetCost: 1, budgetTokens: 100 } as ObserverSettings;
    const u = { calls: 1, inputTokens: 10, outputTokens: 10, costs: { CNY: 0.5 } };
    expect(overBudget(s, u)).toBe(false);
    expect(overBudget(s, { ...u, costs: { CNY: 0.6, USD: 0.4 } })).toBe(true);
    expect(overBudget(s, { ...u, outputTokens: 90 })).toBe(true);
    expect(overBudget({ ...s, budgetCost: 0, budgetTokens: 0 }, { ...u, outputTokens: 1e9 })).toBe(false);
  });
});
