/**
 * M4 第 5 步：临时人物（docs/ARCHITECTURE.md 18.5）。AI 演出时世界里没有的路人开口时用剪影上台，
 * 同一个人在一个周目里开口满几拍，就让书记补一张角色卡，升级成正式角色。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type MockServer, startMockServer } from '@auto-adv/providers/testing';
import { AssetSettings, Character } from '@auto-adv/schema';
import { afterEach, describe, expect, it } from 'vitest';
import type { PlayEvent, PlayView, Segment } from '../src/api.ts';
import { extraCharacter, extrasOf } from '../src/play/extras.ts';
import { buildTimeline, isExtraName, stageFromSegments } from '../src/plot/stage.ts';
import { createPortPair, Engine, type EngineContract, MemorySecretStore, type PlayRef, RpcClient, serveRpc } from '../src/index.ts';

const lin = Character.parse({ id: 'char_lin', name: '林夕', aliases: ['小林'] });
const zhou = Character.parse({ id: 'char_01', name: '老周', role: 'npc' });
const say = (name: string, text: string, characterId: string | null = null): Segment => ({ kind: 'line', characterId, name, text });

let seq = 0;
const beat = (segments: Segment[], plan = ''): PlayEvent => ({ id: `ev_${++seq}`, parentId: null, createdAt: seq, kind: 'ai', segments, beat: { plan, strategy: 'merged' } });

describe('临时人物的纯逻辑', () => {
  it('能上台的名字：一个具体的人；一群人、画外音、太长的不算', () => {
    for (const n of ['码头老板', '守卫甲', '卖花的女孩']) expect(isExtraName(n), n).toBe(true);
    for (const n of ['众人', '大家', '画外音', '？？？', '', '一个名字特别特别长的人物']) expect(isExtraName(n), n).toBe(false);
  });

  it('剪影上台：开口时上台，下一拍不开口就下台；关掉就不上台', () => {
    const scene = { locationId: 'loc', presentCharacterIds: ['char_lin'] };
    const opts = { characters: [lin], scene, protagonistId: null };
    const first = stageFromSegments([say('码头老板', '雾大。'), say('林夕', '嗯。', 'char_lin')], {
      ...opts,
      before: { bg: { id: 'loc' }, sprites: [], cg: null, bgm: null },
      extras: true,
    });
    expect(first.filter((c) => c.op === 'show').map((c) => c.op === 'show' && c.char)).toEqual(['char_lin', '码头老板']);
    // 下一拍他不说话：下台；林夕还在
    const t = buildTimeline(
      [
        { id: 'o', parentId: null, createdAt: 0, kind: 'opening', segments: [], scene },
        beat([say('码头老板', '雾大。'), say('众人', '……')]),
        beat([say('林夕', '走吧。', 'char_lin')]),
      ],
      { characters: [lin], auto: { protagonistId: null, extras: true } },
    );
    const spritesAt = (text: string) => t.steps.find((s) => s.text?.text === text)?.view.sprites.map((s) => s.characterId ?? s.name);
    expect(spritesAt('雾大。')).toEqual(['char_lin', '码头老板']);
    expect(spritesAt('走吧。')).toEqual(['char_lin']);
    // 不开剪影：和以前一样只出名字
    const off = buildTimeline([{ id: 'o', parentId: null, createdAt: 0, kind: 'opening', segments: [], scene }, beat([say('码头老板', '雾大。')])], {
      characters: [lin],
      auto: { protagonistId: null },
    });
    expect(off.steps.find((s) => s.text?.text === '雾大。')?.view.sprites.map((s) => s.name)).toEqual(['林夕']);
  });

  it('数临时人物开口的拍数：一拍说几句算一拍；对得上角色名字或别称的不算', () => {
    const path = [
      beat([say('码头老板', '一。'), say('码头老板', '二。')], '码头老板告诉众人雾里有船'),
      beat([say('码头老板', '三。'), say('小林', '……'), say('大家', '啊？')]),
      { ...beat([say('守卫', '站住。')]), scene: { locationId: 'loc_gate', presentCharacterIds: [] } },
    ];
    const list = extrasOf(path, [lin]);
    expect(list.map((x) => [x.name, x.beats])).toEqual([
      ['码头老板', 2],
      ['守卫', 1],
    ]);
    expect(list[0]?.lines).toEqual(['一。', '二。', '三。']);
    expect(list[0]?.plans).toEqual(['码头老板告诉众人雾里有船']);
    expect(list[1]?.locationId).toBe('loc_gate');
  });

  it('角色卡：认出是已有角色就加别称；否则新建 npc，id 接着编号，说过的话当台词示例', () => {
    const x = { name: '码头老板', beats: 3, lines: ['雾大。', '船不出港。', '还有事？'], plans: [], locationId: null };
    const card = { sameAs: '', gender: '男', age: '50 多岁', summary: '开酒馆的', appearance: '矮胖', imagePrompt: '男性，矮胖', traits: ['精明'], speech: '慢吞吞' };
    const made = extraCharacter({ characters: [lin, zhou] }, x, card);
    expect(made.kind).toBe('new');
    expect(made.character).toMatchObject({
      id: 'char_02',
      name: '码头老板',
      role: 'npc',
      appearance: { text: '矮胖', imagePrompt: '男性，矮胖' },
      speech: { style: '慢吞吞', examples: ['雾大。', '船不出港。'] },
    });
    const alias = extraCharacter({ characters: [lin, zhou] }, x, { ...card, sameAs: '老周' });
    expect(alias).toMatchObject({ kind: 'alias', character: { id: 'char_01', aliases: ['码头老板'] } });
  });
});

// ───────────── 应用里 ─────────────

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

async function advWorld(assets?: Partial<AssetSettings>) {
  await teardown();
  open = true;
  dir = await mkdtemp(path.join(os.tmpdir(), 'auto-adv-extras-'));
  server = await startMockServer({ chunkDelayMs: 0 });
  engine = new Engine({ dataDir: dir, secrets: new MemorySecretStore(), callLogFile: ':memory:', assetRetryBaseMs: 1 });
  const [a, b] = createPortPair();
  serveRpc(a, engine.handlers());
  client = new RpcClient<EngineContract>(b);
  const ep = await client.call('saveEndpoint', { name: '模拟服务', baseURL: server.baseURL, models: ['mock-chat'], currency: 'CNY', pricing: {} });
  await client.call('setRole', { role: 'default', route: { endpointId: ep.id, model: 'mock-chat' } });
  if (assets) await client.call('saveAssetSettings', { settings: AssetSettings.parse(assets) });
  const summary = await client.stream('createWorld', { seed: '雾中的灯塔', preset: 'mystery', options: { characterCount: 2, protagonistName: '阿远' } }, () => {});
  const v = await client.call('startPlaythrough', { worldId: summary.id, mode: 'adv' });
  return { ref: { worldId: summary.id, playthroughId: v.playthrough.id } as PlayRef, v };
}

/** 一拍：有出口菜单就先选第一个，然后输入"去问码头老板"。 */
async function askOwner(ref: PlayRef, v: PlayView): Promise<PlayView> {
  let cur = v;
  if (cur.adv?.menu?.source === 'exits') cur = await client.stream('advChoose', { ...ref, index: 0 }, () => {});
  return client.stream('advInput', { ...ref, text: '去问码头老板' }, () => {});
}

describe('应用里的临时人物', () => {
  it('剧情 ADV：码头老板开口时剪影上台；开口满 3 拍升级成正式角色，素材管线跟着排他的立绘', async () => {
    const { ref, v: v0 } = await advWorld();
    let v = await client.stream('advNext', ref, () => {});
    v = await askOwner(ref, v);
    const first = v.path.at(-1) as PlayEvent;
    expect(first.segments?.some((s) => s.kind === 'line' && s.name === '码头老板' && !s.characterId)).toBe(true);
    expect(first.stage).toContainEqual({ op: 'show', char: '码头老板' });
    v = await askOwner(ref, v);
    await engine.play.flush(ref);
    expect((await engine.worlds.load(ref.worldId)).characters.some((c) => c.name === '码头老板')).toBe(false);
    v = await askOwner(ref, v);
    await engine.play.flush(ref);
    const world = await engine.worlds.load(ref.worldId);
    const owner = world.characters.find((c) => c.name === '码头老板');
    expect(owner).toMatchObject({ role: 'npc', gender: '男', appearance: { imagePrompt: '男性，50 多岁，矮胖，花白短发，帆布围裙，挽起的袖子' } });
    expect(server.requests.filter((r) => JSON.stringify(r).includes('extra_character'))).toHaveLength(1);
    // 下一拍他开口时认得出是这个角色
    v = await askOwner(ref, v);
    const next = v.path.at(-1) as PlayEvent;
    expect(next.segments?.find((s) => s.kind === 'line' && s.name === '码头老板')).toMatchObject({ characterId: owner?.id });
    // 以前的拍按名字也认得出来（舞台指令写的是名字）
    const t = buildTimeline(v.path, { characters: world.characters });
    const old = t.steps.find((s) => s.eventId === first.id && s.text?.speaker?.name === '码头老板');
    expect(old?.text?.speaker?.characterId).toBe(owner?.id);
    // 素材清单里有了他的立绘（npc 画平静、微笑、惊讶）
    const assets = await client.call('assetsView', { worldId: ref.worldId });
    expect(assets.slots.filter((s) => s.characterId === owner?.id).map((s) => s.id)).toEqual([
      `sprite/${owner?.id}/neutral`,
      `sprite/${owner?.id}/smile`,
      `sprite/${owner?.id}/surprised`,
    ]);
    expect(assets.castKey).toContain('码头老板');
    expect(v0.path).toHaveLength(1);
  });

  it('升级关掉（0 拍）、剪影关掉：只出名字，不升级', async () => {
    const { ref } = await advWorld({ extras: { silhouette: false, upgradeAfter: 0 } });
    let v = await client.stream('advNext', ref, () => {});
    for (let i = 0; i < 3; i++) v = await askOwner(ref, v);
    await engine.play.flush(ref);
    expect(v.path.some((e) => e.stage?.some((c) => c.op === 'show' && c.char === '码头老板'))).toBe(false);
    expect((await engine.worlds.load(ref.worldId)).characters.some((c) => c.name === '码头老板')).toBe(false);
    expect(server.requests.some((r) => JSON.stringify(r).includes('extra_character'))).toBe(false);
  });
});
