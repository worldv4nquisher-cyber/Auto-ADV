import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type MockServer, startMockServer } from '@auto-adv/providers/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { createPortPair, Engine, type EngineContract, MemorySecretStore, RpcClient, serveRpc, type WorldDetail } from '../src/index.ts';
import { applyLocks, getAt, isLockedPath, setAt } from '../src/world/locks.ts';
import { applyRenames, findRenames } from '../src/world/rename.ts';
import type { WorldData } from '../src/world/store.ts';

let dir: string;
let server: MockServer;
let engine: Engine;
let client: RpcClient<EngineContract>;

async function setup(options: Record<string, unknown> = {}) {
  dir = await mkdtemp(path.join(os.tmpdir(), 'auto-adv-reroll-'));
  server = await startMockServer({ chunkDelayMs: 0 });
  engine = new Engine({ dataDir: dir, secrets: new MemorySecretStore(), callLogFile: ':memory:' });
  const [a, b] = createPortPair();
  serveRpc(a, engine.handlers());
  client = new RpcClient<EngineContract>(b);
  const ep = await client.call('saveEndpoint', { name: '模拟服务', baseURL: server.baseURL, models: ['mock-chat'], currency: 'CNY', pricing: {} });
  await client.call('setRole', { role: 'default', route: { endpointId: ep.id, model: 'mock-chat' } });
  const summary = await client.stream('createWorld', { seed: '雾中的灯塔', preset: 'mystery', options: { characterCount: 2, ...options } }, () => {});
  return summary.id;
}

afterEach(async () => {
  client?.close();
  engine?.close();
  await server?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
  (client as unknown) = undefined;
  (engine as unknown) = undefined;
  (server as unknown) = undefined;
  dir = '';
});

const world = (id: string) => client.call('getWorld', { id });
const staleOf = (w: WorldDetail) => Object.fromEntries(w.stale.map((s) => [s.step, s.changed]));
/** 最近一次发给模型、而且内容里有 marker 的请求（转成文字）。 */
const lastPrompt = (marker: string) => JSON.stringify([...server.requests].reverse().find((r) => JSON.stringify(r).includes(marker)) ?? null);

/** 保存一个实体，只改锁（不改内容）。 */
async function lock(w: WorldDetail, kind: 'character' | 'location' | 'lore', id: string, locked: string[]) {
  const list = kind === 'character' ? w.characters : kind === 'location' ? w.locations : w.lore;
  const item = list.find((x) => x.id === id);
  if (!item) throw new Error(`没有 ${id}`);
  const r = await client.call('saveWorldPart', {
    worldId: w.manifest.id,
    part: kind,
    base: w.revs[`${kind}:${id}`],
    data: { ...item, _meta: { ...item._meta, locked } },
  } as Parameters<typeof client.call<'saveWorldPart'>>[1]);
  return r.world;
}

describe('锁的工具', () => {
  it('字段路径的读写、锁住的字段盖回去', () => {
    const old = { name: '林夕', appearance: { text: '长发', imagePrompt: 'a' }, goals: ['一'] };
    const fresh = { name: '苏晚', appearance: { text: '短发', imagePrompt: 'b' }, goals: ['二'] };
    expect(applyLocks(fresh, old, ['name', 'appearance.text'])).toEqual({ name: '林夕', appearance: { text: '长发', imagePrompt: 'b' }, goals: ['二'] });
    expect(applyLocks(fresh, old, ['*'])).toEqual(old);
    expect(applyLocks(fresh, null, ['name'])).toBe(fresh);
    expect(isLockedPath(['appearance'], 'appearance.text')).toBe(true);
    expect(isLockedPath(['appearance.text'], 'appearance')).toBe(false);
    expect(getAt(old, 'appearance.text')).toBe('长发');
    // 原来没有这个字段（开场没有地点）：锁住了就去掉
    expect(setAt({ a: 1, b: 2 }, 'b', undefined)).toEqual({ a: 1 });
  });
});

describe('重抽一整步（20.4）', () => {
  it('角色：整个锁住的原样留下，部分锁住的 id 不变只重写没锁的，没锁的换成新的；下游标过期', async () => {
    const worldId = await setup();
    let w = await world(worldId);
    expect(w.stale).toEqual([]);
    const [p, a, b] = w.characters;
    if (!p || !a || !b) throw new Error('角色不够');
    w = await lock(w, 'character', p.id, ['*']);
    w = await lock(w, 'character', a.id, ['name', 'summary']);
    await client.stream('runGenesis', { worldId, steps: ['cast'], note: '反派再狠一点' }, () => {});
    w = await world(worldId);
    const prompt = lastPrompt('已经定了的角色');
    expect(prompt).toContain('反派再狠一点');
    expect(prompt).toContain(`id 填 ${a.id}`);
    expect(prompt).toContain('另外再写 1 个新角色');
    // 一共 3 个（其他角色 2 个 + 主角，锁住的算在内）
    expect(w.characters).toHaveLength(3);
    const p2 = w.characters.find((x) => x.id === p.id);
    expect(p2).toEqual(p.id === p2?.id ? { ...p, _meta: { ...p._meta, locked: ['*'] } } : null);
    const a2 = w.characters.find((x) => x.id === a.id);
    expect(a2?.name).toBe(a.name);
    expect(a2?.summary).toBe(a.summary);
    expect(a2?.background).toContain('模拟');
    expect(a2?._meta.locked).toEqual(['name', 'summary']);
    // 没锁的换成新的：新 id，不用原来的
    const fresh = w.characters.find((x) => x.id !== p.id && x.id !== a.id);
    expect(fresh?.id).not.toBe(b.id);
    expect(fresh?.id).toBe('char_04');
    expect(w.characters.filter((x) => x.role === 'protagonist').map((x) => x.id)).toEqual([p.id]);
    // 原来指向被换掉的角色的关系去掉了
    for (const c of w.characters) for (const r of c.relationships) expect(w.characters.some((x) => x.id === r.to)).toBe(true);
    // 下游（剧情图、设定集、开场）按改之前的角色写的：标过期；世界观、地点没变
    expect(staleOf(w)).toEqual({ plot: ['characters'], lore: ['characters'], opening: ['characters'] });
    // 被换掉的角色在"删掉的"里，能找回来
    const gone = await client.call('deletedEntities', { worldId });
    expect(gone.map((x) => x.id)).toContain(b.id);
    // 更新这几步：锁住的保留，之后不再过期
    await client.stream('runGenesis', { worldId, steps: ['plot', 'lore', 'opening'] }, () => {});
    w = await world(worldId);
    expect(w.stale).toEqual([]);
    expect(w.characters.find((x) => x.id === p.id)?._meta.locked).toEqual(['*']);
  });

  it('角色：换上来的和被换掉的同名（世界选项定了主角的名字）就用回原来的 id，留下的角色的关系还接得上', async () => {
    const worldId = await setup({ protagonistName: '阿远' });
    let w = await world(worldId);
    const hero = w.characters.find((x) => x.role === 'protagonist');
    const lin = w.characters.find((x) => x.role !== 'protagonist');
    if (!hero || !lin) throw new Error('角色不够');
    expect(hero.name).toBe('阿远');
    w = (
      await client.call('saveWorldPart', {
        worldId,
        part: 'character',
        base: w.revs[`character:${lin.id}`],
        data: { ...lin, relationships: [{ to: hero.id, type: '旧识', affinity: 20 }], _meta: { ...lin._meta, locked: ['*'] } },
      })
    ).world;
    await client.stream('runGenesis', { worldId, steps: ['cast'] }, () => {});
    w = await world(worldId);
    const hero2 = w.characters.find((x) => x.role === 'protagonist');
    expect(hero2?.name).toBe('阿远');
    expect(hero2?.id).toBe(hero.id);
    expect(hero2?.summary).not.toBe(hero.summary);
    expect(w.characters.find((x) => x.id === lin.id)?.relationships).toEqual([{ to: hero.id, type: '旧识', affinity: 20 }]);
    // 同名的不算删掉的
    expect((await client.call('deletedEntities', { worldId })).map((x) => x.id)).not.toContain(hero.id);
  });

  it('简报：锁住的题材和世界名不变，锁住的世界观、开场旁白、数值表不重写', async () => {
    const worldId = await setup();
    let w = await world(worldId);
    const brief = w.brief;
    if (!brief || !w.opening) throw new Error('缺内容');
    // 手改题材、世界名（自动锁住）
    w = (await client.call('saveWorldPart', { worldId, part: 'brief', base: w.revs.brief, data: { ...brief, genre: '雾港奇谈' } })).world;
    w = (await client.call('saveWorldPart', { worldId, part: 'manifest', base: w.revs.manifest, data: { title: '灯塔守夜录', logline: w.manifest.logline } })).world;
    expect(w.brief?._meta.locked).toEqual(['genre']);
    expect(w.manifest.locked).toEqual(['title']);
    expect(staleOf(w).worldview).toEqual(['brief']);
    await client.stream('runGenesis', { worldId, steps: ['brief'] }, () => {});
    w = await world(worldId);
    expect(w.brief?.genre).toBe('雾港奇谈');
    expect(w.manifest.title).toBe('灯塔守夜录');
    expect(w.brief?.tone).toBe(brief.tone);
    const prompt = lastPrompt('请为一个新的互动故事世界写一份世界简报');
    expect(prompt).toContain('题材：雾港奇谈');
    expect(prompt).toContain('世界名：灯塔守夜录');

    // 世界观整篇锁住：不调模型
    w = (await client.call('saveWorldPart', { worldId, part: 'worldview', base: w.revs.worldview, data: w.worldview, lock: true })).world;
    const before = server.requests.length;
    await client.stream('runGenesis', { worldId, steps: ['worldview'] }, () => {});
    expect(server.requests.length).toBe(before);
    expect((await world(worldId)).summary.steps.worldview?.status).toBe('done');

    // 开场：锁住旁白
    w = await world(worldId);
    const o = w.opening;
    if (!o) throw new Error('没有开场');
    w = (await client.call('saveWorldPart', { worldId, part: 'opening', base: w.revs.opening, data: { ...o, narration: '你站在码头上。雾很大。', _meta: o._meta } })).world;
    await client.stream('runGenesis', { worldId, steps: ['opening'] }, () => {});
    w = await world(worldId);
    expect(w.opening?.narration).toBe('你站在码头上。雾很大。');
    expect(lastPrompt('请设计故事的开场场景')).toContain('开场叙述（narration）：你站在码头上。雾很大。');

    // 数值表锁住：剧情图重写时只能用已有的数值
    const vars = w.variables.slice(0, 2);
    w = (await client.call('saveWorldPart', { worldId, part: 'variables', base: w.revs.variables, data: vars, lock: true })).world;
    await client.stream('runGenesis', { worldId, steps: ['plot'] }, () => {});
    w = await world(worldId);
    expect(w.variables).toEqual(vars);
    expect(lastPrompt('请设计这个故事的剧情图')).toContain('variables 已经定了');
  });
});

describe('只重写一个实体、一个字段（20.4）', () => {
  it('重写一个角色：id 不变，锁住的字段保留，之前的版本进历史', async () => {
    const worldId = await setup();
    let w = await world(worldId);
    const a = w.characters[1];
    if (!a) throw new Error('没有角色');
    w = await lock(w, 'character', a.id, ['name']);
    const chunks: unknown[] = [];
    w = await client.stream('rerollEntity', { worldId, kind: 'character', id: a.id, note: '更冷淡一点' }, (c) => chunks.push(c));
    const a2 = w.characters.find((x) => x.id === a.id);
    expect(a2?.name).toBe(a.name);
    expect(a2?.summary).toContain('重写过的角色');
    expect(a2?._meta.locked).toEqual(['name']);
    expect(a2?.role).not.toBe('protagonist');
    expect(chunks.length).toBeGreaterThan(0);
    const prompt = lastPrompt('要重写的角色');
    expect(prompt).toContain('更冷淡一点');
    expect(prompt).toContain(`名字：${a.name}`);
    const hist = await client.call('worldHistory', { worldId, key: `character:${a.id}` });
    expect(hist[0]?.reason).toBe('genesis');
    // 下游过期；整个锁住的不让重写
    expect(staleOf(w).plot).toEqual(['characters']);
    await lock(w, 'character', a.id, ['*']);
    await expect(client.stream('rerollEntity', { worldId, kind: 'character', id: a.id }, () => {})).rejects.toThrow('整个锁住');
  });

  it('重写一个地点、一条设定；只重写一个字段时不保存，返回新的文字', async () => {
    const worldId = await setup();
    let w = await world(worldId);
    const l = w.locations[1];
    const e = w.lore[0];
    if (!l || !e) throw new Error('缺内容');
    w = await client.stream('rerollEntity', { worldId, kind: 'location', id: l.id }, () => {});
    expect(w.locations.find((x) => x.id === l.id)?.description).toContain('重写过的地点');
    w = await lock(w, 'lore', e.id, ['title']);
    w = await client.stream('rerollEntity', { worldId, kind: 'lore', id: e.id }, () => {});
    const e2 = w.lore.find((x) => x.id === e.id);
    expect(e2?.title).toBe(e.title);
    expect(e2?.content).toContain('重写过的设定');
    expect(e2?.activation).toBe(e.activation);

    const c = w.characters[1];
    if (!c) throw new Error('没有角色');
    const before = await world(worldId);
    const r = await client.stream('rewriteField', { worldId, key: `character:${c.id}`, path: 'background', data: { ...c, summary: '表单里还没存的简介' }, note: '多写一点童年' }, () => {});
    expect(r.text).toContain('重写过的经历');
    const prompt = lastPrompt('请只重写「经历」这一项');
    expect(prompt).toContain('多写一点童年');
    expect(prompt).toContain('表单里还没存的简介');
    expect((await world(worldId)).revs).toEqual(before.revs);
    await expect(client.stream('rewriteField', { worldId, key: `character:${c.id}`, path: 'name' }, () => {})).rejects.toThrow('不能单独重写');
  });
});

describe('过期（20.4）', () => {
  it('手改角色以后下游过期；「不用了」记下新的；M5 之前的世界在第一次改动前补上哈希', async () => {
    const worldId = await setup();
    // 模拟 M5 之前生成的世界：没有输入哈希
    const file = path.join(dir, 'worlds', worldId, 'world.json');
    const m = JSON.parse(await readFile(file, 'utf8'));
    for (const st of Object.values(m.genesis.steps) as { inputs?: unknown; names?: unknown }[]) {
      delete st.inputs;
      delete st.names;
    }
    await writeFile(file, JSON.stringify(m));
    let w = await world(worldId);
    expect(w.stale).toEqual([]);
    const c = w.characters[1];
    if (!c) throw new Error('没有角色');
    w = (await client.call('saveWorldPart', { worldId, part: 'character', base: w.revs[`character:${c.id}`], data: { ...c, background: '完全不同的经历' } })).world;
    expect(staleOf(w)).toEqual({ plot: ['characters'], lore: ['characters'], opening: ['characters'] });
    // 地点也改：剧情图的过期来源有两块
    const l = w.locations[0];
    if (!l) throw new Error('没有地点');
    w = (await client.call('saveWorldPart', { worldId, part: 'location', base: w.revs[`location:${l.id}`], data: { ...l, description: '新的描述' } })).world;
    expect(staleOf(w).plot).toEqual(['characters', 'locations']);
    w = await client.call('acceptStale', { worldId, steps: ['lore'] });
    expect(staleOf(w).lore).toBeUndefined();
    w = await client.call('acceptStale', { worldId });
    expect(w.stale).toEqual([]);
  });

  it('删掉一个角色：只算角色改过，世界观里提到他不算世界观改过', async () => {
    const worldId = await setup();
    let w = await world(worldId);
    const b = w.characters[2];
    if (!b) throw new Error('没有角色');
    w = (await client.call('saveWorldPart', { worldId, part: 'worldview', base: w.revs.worldview, data: `${w.worldview}\n\n${b.name}是港口的常客。`, lock: false })).world;
    await client.call('acceptStale', { worldId });
    w = await client.call('deleteWorldPart', { worldId, kind: 'character', id: b.id, removeRefs: true });
    expect(staleOf(w).cast).toBeUndefined();
    expect(staleOf(w).plot).toContain('characters');
  });
});

describe('改名（20.4）', () => {
  it('列出正文里的旧名字；全部替换以后下游不算过期；只换一部分算', async () => {
    const worldId = await setup();
    let w = await world(worldId);
    const a = w.characters.find((x) => x.name === '林夕');
    if (!a) throw new Error('没有林夕');
    const hits = await client.call('renameHits', { worldId, kind: 'character', id: a.id, to: '苏晚' });
    const groups = hits.map((h) => h.group);
    expect(groups).toContain(`character:${a.id}/summary`);
    expect(groups).toContain(`character:${a.id}/secrets`);
    expect(groups).not.toContain(`character:${a.id}/name`);
    expect(hits.find((h) => h.group === `character:${a.id}/summary`)?.preview).toContain('林夕');
    // 表单里已经改掉的（还没保存）按表单算
    const drafted = await client.call('renameHits', { worldId, kind: 'character', id: a.id, to: '苏晚', draft: { ...a, summary: '一个外乡人' } });
    expect(drafted.map((h) => h.group)).not.toContain(`character:${a.id}/summary`);
    const r = await client.call('saveWorldPart', {
      worldId,
      part: 'character',
      base: w.revs[`character:${a.id}`],
      data: { ...a, name: '苏晚' },
      unlocked: ['name'],
      rename: { groups: 'all' },
    });
    expect(r.renamed).toBe(hits.reduce((n, h) => n + h.count, 0));
    w = r.world;
    // 除了创世步骤记下的当时的名字，哪里都没有旧名字了
    expect(JSON.stringify({ ...w, manifest: { ...w.manifest, genesis: null }, summary: null })).not.toContain('林夕');
    expect(w.characters.find((x) => x.id === a.id)?.summary).toContain('苏晚');
    expect(w.stale).toEqual([]);
    // 再改回去，只换一部分：没换的地方还是旧名字，下游算过期
    const again = await client.call('renameHits', { worldId, kind: 'character', id: a.id, to: '林夕' });
    const one = again.find((h) => h.group.startsWith('plot/')) ?? again[0];
    const a2 = w.characters.find((x) => x.id === a.id);
    if (!a2 || !one) throw new Error('缺内容');
    const r2 = await client.call('saveWorldPart', { worldId, part: 'character', base: w.revs[`character:${a.id}`], data: { ...a2, name: '林夕' }, rename: { groups: [one.group] } });
    expect(r2.renamed).toBe(one.count);
    expect(r2.world.stale.length).toBeGreaterThan(0);
  });

  it('设置成"总是替换"：不问直接全换；别人的名字里含着旧名字的不换', async () => {
    const worldId = await setup();
    await client.call('saveEditorSettings', { settings: { rename: 'always' } });
    let w = await world(worldId);
    const a = w.characters.find((x) => x.name === '林夕');
    const b = w.characters.find((x) => x.name === '白鸦');
    if (!a || !b) throw new Error('缺角色');
    // 白鸦改名叫"林夕月"，背景里写上两个名字
    w = (await client.call('saveWorldPart', { worldId, part: 'character', base: w.revs[`character:${b.id}`], data: { ...b, name: '林夕月', background: '林夕月和林夕是表姐妹。' } })).world;
    const a2 = w.characters.find((x) => x.id === a.id);
    if (!a2) throw new Error('没有林夕');
    const r = await client.call('saveWorldPart', { worldId, part: 'character', base: w.revs[`character:${a.id}`], data: { ...a2, name: '苏晚' } });
    expect(r.renamed).toBeGreaterThan(0);
    expect(r.world.characters.find((x) => x.id === b.id)?.background).toBe('林夕月和苏晚是表姐妹。');
  });

  it('纯计算：剧情图的一幕、手写剧本、开场台词都能换', () => {
    const w = {
      manifest: { title: '雾港', logline: '林夕回来了' },
      brief: null,
      style: null,
      worldview: '林夕和林夕月',
      characters: [
        { id: 'char_01', name: '苏晚', aliases: [] },
        { id: 'char_02', name: '林夕月', aliases: [] },
      ],
      locations: [],
      lore: [],
      graph: { premise: '', chapters: [], threads: [], scenes: [{ id: 'sc_01', title: '林夕的信', what: '林夕写信', points: [{ id: 'sc_01_1', text: '林夕哭了' }], cast: ['char_01'], exits: [] }] },
      opening: { narration: '', lines: [{ characterId: 'char_01', text: '我是林夕' }], presentCharacterIds: [] },
      variables: [],
      scripts: { sc_01: '林夕：你好' },
    } as unknown as WorldData;
    const self = { kind: 'character' as const, id: 'char_01' };
    const hits = findRenames(w, '林夕', '苏晚', self);
    expect(hits.map((h) => [h.group, h.count])).toEqual([
      ['manifest/logline', 1],
      ['worldview', 1],
      ['plot/scene:sc_01', 3],
      ['opening/lines', 1],
      ['script:sc_01', 1],
    ]);
    const patch = applyRenames(w, '林夕', '苏晚', ['worldview', 'plot/scene:sc_01'], self);
    expect(patch.worldview).toBe('苏晚和林夕月');
    expect(patch.graph?.scenes[0]?.points[0]?.text).toBe('苏晚哭了');
    expect(patch.manifest).toBeUndefined();
    expect(patch.count).toBe(4);
  });
});

describe('最近删掉的', () => {
  it('删掉的角色能找回来；新加的角色不用删掉的 id', async () => {
    const worldId = await setup();
    let w = await world(worldId);
    const b = w.characters[2];
    if (!b) throw new Error('没有角色');
    w = await client.call('deleteWorldPart', { worldId, kind: 'character', id: b.id, removeRefs: true });
    const gone = await client.call('deletedEntities', { worldId });
    expect(gone[0]).toMatchObject({ kind: 'character', id: b.id, title: b.name, restorable: true });
    const added = await client.call('saveWorldPart', { worldId, part: 'character', data: { ...b, id: undefined, name: '新来的人' } as never });
    expect(added.key).not.toBe(`character:${b.id}`);
    const r = await client.call('restoreDeleted', { worldId, kind: 'character', id: b.id, name: gone[0]?.name ?? '' });
    expect(r.key).toBe(`character:${b.id}`);
    expect(r.world.characters.find((x) => x.id === b.id)?.name).toBe(b.name);
    expect((await client.call('deletedEntities', { worldId })).some((x) => x.id === b.id)).toBe(false);
  });
});
