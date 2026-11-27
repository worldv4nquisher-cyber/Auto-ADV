import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type MockServer, startMockServer } from '@auto-adv/providers/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { createPortPair, Engine, type EngineContract, MemorySecretStore, RpcClient, serveRpc } from '../src/index.ts';
import { changedPaths, filledPaths, mergeLocks, nextId } from '../src/world/edit.ts';

let dir: string;
let server: MockServer;
let engine: Engine;
let client: RpcClient<EngineContract>;

async function setup() {
  dir = await mkdtemp(path.join(os.tmpdir(), 'auto-adv-editor-'));
  server = await startMockServer({ chunkDelayMs: 0 });
  engine = new Engine({ dataDir: dir, secrets: new MemorySecretStore(), callLogFile: ':memory:' });
  const [a, b] = createPortPair();
  serveRpc(a, engine.handlers());
  client = new RpcClient<EngineContract>(b);
  const ep = await client.call('saveEndpoint', { name: '模拟服务', baseURL: server.baseURL, models: ['mock-chat'], currency: 'CNY', pricing: {} });
  await client.call('setRole', { role: 'default', route: { endpointId: ep.id, model: 'mock-chat' } });
  const summary = await client.stream('createWorld', { seed: '雾中的灯塔', preset: 'mystery', options: { characterCount: 2 } }, () => {});
  return summary.id;
}

afterEach(async () => {
  client?.close();
  engine?.close();
  await server?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

const errorOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    return err as Error & { code?: string };
  }
  throw new Error('应该失败');
};

describe('改了哪些字段、锁', () => {
  it('按字段路径列出改动：对象拆两层，列表整个算一个', () => {
    const a = { id: 'x', name: '甲', appearance: { text: '高', imagePrompt: '' }, goals: [{ text: '一' }], _meta: { locked: [] } };
    const b = { ...a, name: '乙', appearance: { text: '矮', imagePrompt: '' }, goals: [{ text: '二' }], _meta: { locked: ['name'] } };
    expect(changedPaths(a, b)).toEqual(['name', 'appearance.text', 'goals']);
    expect(changedPaths(a, { ...a })).toEqual([]);
    expect(filledPaths({ id: 'x', name: '丙', age: '', tags: [], n: 3, sub: { a: '有', b: '' } })).toEqual(['name', 'sub.a']);
  });

  it('合并锁：锁了上一层或整个就不再细分', () => {
    expect(mergeLocks(['name'], ['name', 'age'])).toEqual(['name', 'age']);
    expect(mergeLocks(['appearance'], ['appearance.text'])).toEqual(['appearance']);
    expect(mergeLocks(['*'], ['age'])).toEqual(['*']);
  });

  it('新实体的 id 接着最大的序号往下排', () => {
    expect(nextId('char', ['char_01', 'char_02', 'char_lin'])).toBe('char_03');
    expect(nextId('loc', [])).toBe('loc_01');
  });
});

describe('世界编辑器：保存', () => {
  it('改一个角色：手改的字段自动锁住，旧版本进历史，版本号对不上时拒绝', async () => {
    const worldId = await setup();
    let w = await client.call('getWorld', { id: worldId });
    expect(w.editable).toBe(true);
    const c = w.characters[1];
    if (!c) throw new Error('没有角色');
    const key = `character:${c.id}` as const;
    const base = w.revs[key];
    const r = await client.call('saveWorldPart', {
      worldId,
      part: 'character',
      base,
      data: { ...c, name: '改过的名字', appearance: { ...c.appearance, text: '一头短发' } },
    });
    expect(r.key).toBe(key);
    const saved = r.world.characters.find((x) => x.id === c.id);
    expect(saved?.name).toBe('改过的名字');
    expect(saved?._meta.locked).toEqual(['name', 'appearance.text']);
    expect(saved?._meta.generatedBy).toBe('user');
    expect(r.world.revs[key]).not.toBe(base);

    // 用旧的版本号再存一次：冲突
    const err = await errorOf(client.call('saveWorldPart', { worldId, part: 'character', base, data: { ...c, age: '99' } }));
    expect(err.code).toBe('conflict');

    // 历史里有改之前的版本，读出来就是原来的角色
    const hist = await client.call('worldHistory', { worldId, key });
    expect(hist).toHaveLength(1);
    expect(hist[0]?.reason).toBe('edit');
    const old = await client.call('worldHistoryRead', { worldId, key, name: hist[0]?.name ?? '' });
    expect((old.data as { name: string }).name).toBe(c.name);

    // 这次编辑里点开了锁的字段，手改了也不锁回去；只改锁不算你写的
    w = r.world;
    const now = w.characters.find((x) => x.id === c.id);
    if (!now) throw new Error('角色不见了');
    const r2 = await client.call('saveWorldPart', {
      worldId,
      part: 'character',
      base: w.revs[key],
      unlocked: ['name'],
      data: { ...now, name: '又改了', _meta: { ...now._meta, locked: ['appearance.text'] } },
    });
    expect(r2.world.characters.find((x) => x.id === c.id)?._meta.locked).toEqual(['appearance.text']);
  });

  it('新建角色：分配 id，填了的字段锁住；不合格的内容拒绝', async () => {
    const worldId = await setup();
    const w = await client.call('getWorld', { id: worldId });
    const r = await client.call('saveWorldPart', {
      worldId,
      part: 'character',
      data: { formatVersion: 1, name: '新来的', role: 'npc', summary: '路过的旅人', secrets: [{ id: 'secret_1', text: '其实是逃兵', knownBy: [] }] } as never,
    });
    expect(r.key).toBe(`character:char_${String(w.characters.length + 1).padStart(2, '0')}`);
    const c = r.world.characters.find((x) => `character:${x.id}` === r.key);
    // 只锁你填的：和默认值一样的（定位是配角、表情只有平静）不算
    expect(c?._meta.locked).toEqual(['name', 'summary', 'secrets']);
    // 自己的秘密自己总是知道
    expect(c?.secrets[0]?.knownBy).toEqual([c?.id]);

    const bad = await errorOf(client.call('saveWorldPart', { worldId, part: 'character', data: { name: '' } as never }));
    expect(bad.code).toBe('invalid');
    expect(bad.message).toContain('name');
  });

  it('世界名、世界观、数值表：锁记在 world.json 里；数值 id 重复拒绝', async () => {
    const worldId = await setup();
    let w = await client.call('getWorld', { id: worldId });
    w = (await client.call('saveWorldPart', { worldId, part: 'manifest', base: w.revs.manifest, data: { title: '新名字', logline: w.manifest.logline } })).world;
    expect(w.manifest.title).toBe('新名字');
    expect(w.manifest.locked).toEqual(['title']);
    w = (await client.call('saveWorldPart', { worldId, part: 'worldview', base: w.revs.worldview, data: `${w.worldview}\n\n补一段。` })).world;
    expect(w.worldview).toContain('补一段。');
    expect(w.manifest.locked).toEqual(['title', 'worldview']);
    w = (await client.call('saveWorldPart', { worldId, part: 'worldview', data: w.worldview, lock: false })).world;
    expect(w.manifest.locked).toEqual(['title']);

    const vars = [...w.variables, { id: 'clue', label: '线索', type: 'number' as const, initial: 0, visible: true, category: 'other' as const }];
    w = (await client.call('saveWorldPart', { worldId, part: 'variables', data: vars })).world;
    expect(w.variables.map((v) => v.id)).toContain('clue');
    expect(w.manifest.locked).toContain('variables');
    const dup = await errorOf(client.call('saveWorldPart', { worldId, part: 'variables', data: [...vars, vars.at(-1) as (typeof vars)[number]] }));
    expect(dup.message).toContain('clue');
  });
});

describe('世界编辑器：删除和引用', () => {
  it('删角色前列出引用；一起删时去掉关系、开场和剧情图里的引用，文件进历史', async () => {
    const worldId = await setup();
    const w = await client.call('getWorld', { id: worldId });
    // 找一个在开场里出场的角色
    const id = w.opening?.presentCharacterIds[0];
    if (!id) throw new Error('开场没有角色');
    // 手写剧本里提到这个角色：只能列出来，自己改
    const scene = w.graph?.scenes[0]?.id;
    if (!scene) throw new Error('没有剧情图');
    const scenes = path.join(dir, 'worlds', worldId, 'plot', 'scenes');
    await mkdir(scenes, { recursive: true });
    await writeFile(path.join(scenes, `${scene}.adv`), `@show ${id} neutral\n`);
    const refs = await client.call('worldReferences', { worldId, kind: 'character', id });
    expect(refs.some((r) => r.key === 'opening')).toBe(true);
    expect(refs.find((r) => r.key === `script:${scene}`)?.removable).toBe(false);

    const after = await client.call('deleteWorldPart', { worldId, kind: 'character', id, removeRefs: true });
    expect(after.characters.some((c) => c.id === id)).toBe(false);
    expect(after.opening?.presentCharacterIds).not.toContain(id);
    expect(after.opening?.lines.some((l) => l.characterId === id)).toBe(false);
    for (const c of after.characters) expect(c.relationships.some((r) => r.to === id)).toBe(false);
    for (const s of after.graph?.scenes ?? []) expect(s.cast).not.toContain(id);
    const hist = await client.call('worldHistory', { worldId, key: `character:${id}` });
    expect(hist[0]?.reason).toBe('delete');
    // 引用都去掉了，检查里没有悬空的引用
    expect(after.issues.filter((i) => i.message.includes(id))).toEqual([]);
  });

  it('只删不去引用：引用检查里列出悬空的引用', async () => {
    const worldId = await setup();
    const w = await client.call('getWorld', { id: worldId });
    const loc = w.opening?.locationId;
    if (!loc) throw new Error('开场没有地点');
    const after = await client.call('deleteWorldPart', { worldId, kind: 'location', id: loc, removeRefs: false });
    expect(after.issues.some((i) => i.key === 'opening' && i.field === 'locationId')).toBe(true);
    const missing = await errorOf(client.call('deleteWorldPart', { worldId, kind: 'location', id: loc, removeRefs: false }));
    expect(missing.message).toContain('不存在');
  });
});

describe('历史版本', () => {
  it('重新生成一步之前把被换掉的存进历史，超过上限删最早的', async () => {
    const worldId = await setup();
    await client.call('saveEditorSettings', { settings: { autoLock: true, historyLimit: 2 } });
    for (let i = 0; i < 3; i++) await client.stream('runGenesis', { worldId, from: 'lore' }, () => {});
    const w = await client.call('getWorld', { id: worldId });
    const first = w.lore[0];
    if (!first) throw new Error('没有设定');
    const hist = await client.call('worldHistory', { worldId, key: `lore:${first.id}` });
    // 模拟服务每次给的内容一样，内容没变就不存；改一下文件再重抽
    expect(hist.length).toBeLessThanOrEqual(2);
    const file = path.join(dir, 'worlds', worldId, 'setting', 'lore', `${first.id}.json`);
    for (let i = 0; i < 3; i++) {
      const raw = JSON.parse(await readFile(file, 'utf8'));
      await writeFile(file, JSON.stringify({ ...raw, content: `改过 ${i}` }));
      await client.stream('runGenesis', { worldId, from: 'lore' }, () => {});
    }
    const after = await client.call('worldHistory', { worldId, key: `lore:${first.id}` });
    expect(after).toHaveLength(2);
    expect(after.every((h) => h.reason === 'genesis')).toBe(true);
    const newest = await client.call('worldHistoryRead', { worldId, key: `lore:${first.id}`, name: after[0]?.name ?? '' });
    expect((newest.data as { content: string }).content).toBe('改过 2');
    expect(await readdir(path.join(dir, 'worlds', worldId, '.history', 'setting', 'lore', `${first.id}.json`))).toHaveLength(2);
    const bad = await errorOf(client.call('worldHistoryRead', { worldId, key: `lore:${first.id}`, name: '../../world.json' }));
    expect(bad.message).toContain('不合法');
  });
});
