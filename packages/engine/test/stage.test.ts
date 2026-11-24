/**
 * M3 第 2 步：VN 舞台的时间线（plot/stage.ts）和应用里的剧情 ADV 周目（PlayService + RPC）。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PlayEvent, PlayView } from '../src/api.ts';
import { createPortPair, Engine, type EngineContract, MemorySecretStore, RpcClient, serveRpc } from '../src/index.ts';
import { PlayDb } from '../src/play/db.ts';
import { type AdvWorld } from '../src/plot/runner.ts';
import { AdvSession, loadAdvWorld } from '../src/plot/session.ts';
import { buildTimeline, findStep, spriteX, stepText, type Timeline } from '../src/plot/stage.ts';
import { type WorldData, WorldStore } from '../src/world/store.ts';

const EXAMPLES = path.resolve(import.meta.dirname, '../../../examples/worlds');

let world: WorldData;
let adv: AdvWorld;

beforeAll(async () => {
  world = await new WorldStore(EXAMPLES).load('old_library');
  adv = loadAdvWorld(world).adv;
});

/** 按 picks 一路选下去，返回整条路径。 */
function playPath(picks: number[], ptId = 'pt_stage'): PlayEvent[] {
  let n = 0;
  const s = new AdvSession(new PlayDb(':memory:'), adv, { newId: (p) => (p === 'pt' ? ptId : `${p}_${++n}`) });
  const pt = s.start('舞台测试');
  const queue = [...picks];
  let state = s.state(pt);
  for (let guard = 0; guard < 100 && !state.finished; guard++) {
    if (state.menu && !queue.length) break;
    state = (state.menu ? s.choose(pt, queue.shift() as number) : s.next(pt)).state;
  }
  return s.path(pt);
}

const timeline = (path: PlayEvent[]): Timeline =>
  buildTimeline(path, { characters: world.characters, graph: world.graph });

describe('舞台时间线', () => {
  it('第一幕：标题卡、背景、立绘站位、台词逐句成步，每一步带着完整画面', () => {
    const t = timeline(playPath([]));
    const [card, first, second] = t.steps;
    expect(card).toMatchObject({ kind: 'card', card: { title: '图书馆的偶遇', chapter: '退潮之夜' }, index: -1 });
    expect(first).toMatchObject({ kind: 'text', index: 0, text: { kind: 'narrate', speaker: null } });
    expect(first?.view).toEqual({ bg: { id: 'reading_evening', transition: 'fade' }, sprites: [], cg: null, bgm: 'calm_daily' });
    expect(second?.text).toEqual({ kind: 'say', speaker: { characterId: 'char_lin', name: '林夕' }, text: '……你也来找那本书？' });
    expect(second?.view.sprites).toEqual([{ key: 'lin', characterId: 'char_lin', name: '林夕', expr: 'neutral', x: 50 }]);
    // 停在选项上：最后一步是选项前的那句台词
    expect(stepText(t.steps.at(-1))).toBe('林夕：我姐姐三年前在这里借走了它，然后就再也没有回来。');
    expect(t.backlog.filter((b) => b.kind === 'text')).toHaveLength(t.steps.filter((s) => s.kind === 'text').length);
  });

  it('选项、检定、数值变化和换幕都落在对的步骤上；回想里的选项可以回到选之前', () => {
    const path = playPath([0, 0, 0]);
    const t = timeline(path);
    const choice = t.backlog.find((b) => b.kind === 'choice' && b.label === '我是来找你的');
    expect(choice?.kind === 'choice' && choice.rewindTo).toBe(path.find((e) => e.plot?.menu)?.id);
    // 选完之后的第一步：表情变了，带着好感 +5
    const after = t.steps[choice?.step ?? -1];
    expect(after?.view.sprites[0]?.expr).toBe('surprised');
    expect(after?.vars).toEqual([{ var: 'affinity.char_lin', from: 30, to: 35 }]);
    // 检定单独一步
    const check = t.steps.find((s) => s.kind === 'check');
    expect(check?.check?.label).toBe('研究门锁的机关');
    expect(check?.scene).toBe('sc_02'); // 检定结果显示时还在这一幕，结果决定的下一幕还没到
    expect(t.backlog.some((b) => b.kind === 'check')).toBe(true);
    // 第二幕的标题卡；bg 换背景时清场，show 写了 left 就站左边
    const card = t.steps.find((s) => s.card?.title === '旧书库的门');
    expect(card?.view.sprites).toHaveLength(1); // 标题卡显示时还是上一幕的画面
    const door = t.steps.find((s) => s.view.bg?.id === 'archive_door');
    expect(door?.view.sprites.map((s) => [s.key, s.x])).toEqual([['lin', 28]]);
  });

  it('CG：第一次显示它的那一步标记 cgShown；只有 CG 没有文字时停一步', () => {
    const t = timeline(playPath([1, 0, 1, 0, 0]));
    const shown = t.steps.filter((s) => s.cgShown);
    expect(shown.map((s) => [s.cgShown, s.kind])).toEqual([['cg_reunion', 'text']]);
    expect(shown[0]?.view.cg).toBe('cg_reunion');
    expect(t.end.cg).toBe('cg_reunion');

    const ev = (stage: PlayEvent['stage']): PlayEvent => ({ id: 'e1', parentId: null, kind: 'script', createdAt: 0, stage });
    const only = buildTimeline([ev([{ op: 'bg', id: 'x' }, { op: 'cg', id: 'cg_x' }])], { characters: [] });
    expect(only.steps.map((s) => [s.kind, s.cgShown])).toEqual([['pause', 'cg_x']]);
  });

  it('自动站位、换表情不换位置、hide、音效提示；没有舞台指令的事件按文本段落播放', () => {
    const e = (id: string, extra: Partial<PlayEvent>): PlayEvent => ({ id, parentId: null, kind: 'script', createdAt: 0, ...extra });
    const t = buildTimeline(
      [
        e('a', {
          stage: [
            { op: 'show', char: 'lin' },
            { op: 'show', char: '老周' },
            { op: 'sfx', id: 'door' },
            { op: 'say', char: 'zhou', text: '拿去吧。' },
            { op: 'show', char: 'char_lin', expr: 'smile' },
            { op: 'hide', char: 'zhou' },
            { op: 'wait', seconds: 1.5 },
          ],
        }),
        e('b', { kind: 'ai', segments: [{ kind: 'narration', text: '夜深了。' }] }),
      ],
      { characters: world.characters },
    );
    expect(t.steps[0]?.view.sprites.map((s) => [s.characterId, s.x])).toEqual([
      ['char_lin', 50],
      ['char_zhou', 28],
    ]);
    expect(t.steps[0]?.cues).toEqual([{ op: 'sfx', id: 'door' }]);
    expect(t.steps[0]?.text?.speaker?.name).toBe('老周');
    expect(t.steps[1]).toMatchObject({ kind: 'wait', seconds: 1.5, eventId: 'a', index: 1 });
    expect(t.steps[1]?.view.sprites).toEqual([{ key: 'lin', characterId: 'char_lin', name: '林夕', expr: 'smile', x: 50 }]);
    expect(t.steps[2]).toMatchObject({ kind: 'text', eventId: 'b', index: 0, text: { kind: 'narrate', text: '夜深了。' } });
    expect(findStep(t, { eventId: 'a', index: 1 })).toBe(1);
    expect(findStep(t, { eventId: 'a', index: 9 })).toBe(1);
    expect(findStep(t, { eventId: 'b', index: -1 })).toBe(2);
    expect(findStep(t, { eventId: 'zzz', index: 0 })).toBe(2);
  });

  it('观察模式：没有舞台指令的事件按地点和在场角色自动排舞台；导演指令和悄悄话只进回想', () => {
    const e = (id: string, extra: Partial<PlayEvent>): PlayEvent => ({ id, parentId: null, kind: 'ai', createdAt: 0, ...extra });
    const t = buildTimeline(
      [
        e('o', {
          kind: 'opening',
          scene: { locationId: 'loc_reading', presentCharacterIds: ['char_lin', 'char_01'] },
          segments: [{ kind: 'narration', text: '雨落在天窗上。' }],
        }),
        e('d', { kind: 'directive', text: '让老周出现' }),
        e('w', { kind: 'whisper', characterId: 'char_lin', text: '他在骗你' }),
        e('a', {
          scene: { locationId: 'loc_reading', presentCharacterIds: ['char_lin', 'char_01', 'char_zhou'] },
          segments: [{ kind: 'line', characterId: 'char_zhou', name: '老周', text: '闭馆了。' }],
          plot: { scene: 'sc_02' },
        }),
        e('p', { kind: 'player', characterId: 'char_lin', text: '再等一会儿。' }),
        e('b', {
          scene: { locationId: 'loc_archive', presentCharacterIds: ['char_lin'] },
          segments: [{ kind: 'narration', text: '铁门在身后合上。' }],
        }),
      ],
      { characters: world.characters, graph: world.graph, auto: { protagonistId: null } },
    );
    const chars = (i: number) => t.steps[i]?.view.sprites.map((s) => s.characterId);
    expect(t.steps[0]).toMatchObject({ kind: 'text', eventId: 'o', view: { bg: { id: 'loc_reading' } } });
    expect(chars(0)).toEqual(['char_lin', 'char_01']); // 观察模式里主角也上台
    expect(t.steps[1]).toMatchObject({ kind: 'card', card: { title: '旧书库的门' } });
    expect(t.steps[2]?.text?.speaker?.name).toBe('老周');
    expect(chars(2)).toEqual(['char_lin', 'char_01', 'char_zhou']);
    expect(t.steps[3]).toMatchObject({ eventId: 'p', text: { kind: 'say', text: '再等一会儿。' } });
    expect(t.steps[4]).toMatchObject({ eventId: 'b', view: { bg: { id: 'loc_archive' } } });
    expect(chars(4)).toEqual(['char_lin']);
    expect(t.backlog.filter((b) => b.kind === 'note')).toEqual([
      { kind: 'note', step: 1, label: '导演指令', text: '让老周出现' },
      { kind: 'note', step: 1, label: '对林夕的悄悄话', text: '他在骗你' },
    ]);
    // 不给 auto 时还是按文本段落播放，没有画面
    const plain = buildTimeline([e('a', { segments: [{ kind: 'narration', text: '夜深了。' }], scene: { locationId: 'x', presentCharacterIds: [] } })], {
      characters: [],
    });
    expect(plain.steps[0]?.view.bg).toBeNull();
  });

  it('站位写法', () => {
    expect([spriteX('left'), spriteX('Far-Right'), spriteX('40%'), spriteX('120'), spriteX('上面'), spriteX(undefined)]).toEqual([
      28, 86, 40, 95, null, null,
    ]);
  });
});

// ───────────── 应用里的剧情 ADV 周目 ─────────────

let dir: string;
let engine: Engine;
let client: RpcClient<EngineContract>;

async function setup() {
  dir = await mkdtemp(path.join(os.tmpdir(), 'auto-adv-stage-'));
  engine = new Engine({ dataDir: dir, secrets: new MemorySecretStore(), callLogFile: ':memory:' });
  const [a, b] = createPortPair();
  serveRpc(a, engine.handlers());
  client = new RpcClient<EngineContract>(b);
}

afterEach(async () => {
  client?.close();
  engine?.close();
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

/** 按 picks 往下玩（遇到选项就用下一个），直到走完或者 picks 用完。 */
async function playTo(ref: { worldId: string; playthroughId: string }, v: PlayView, picks: number[]): Promise<PlayView> {
  const queue = [...picks];
  for (let guard = 0; guard < 50 && v.adv && !v.adv.finished; guard++) {
    if (v.adv.menu && !queue.length) break;
    v = v.adv.menu
      ? await client.stream('advChoose', { ...ref, index: queue.shift() as number }, () => {})
      : await client.stream('advNext', ref, () => {});
  }
  return v;
}

describe('应用里的剧情 ADV', () => {
  it('导入示例世界，开始 ADV 周目，一路选到好结局；CG 在舞台显示后才解锁', async () => {
    await setup();
    await expect(client.call('importWorld', { path: dir })).rejects.toThrow('不是世界文件夹');
    const summary = await client.call('importWorld', { path: path.join(EXAMPLES, 'old_library') });
    expect(summary).toMatchObject({ id: 'old_library', status: 'ready', title: '旧书库的约定' });
    const again = await client.call('importWorld', { path: path.join(EXAMPLES, 'old_library') });
    expect(again.id).toBe('old_library_2');
    const copied = JSON.parse(await readFile(path.join(dir, 'worlds', 'old_library_2', 'world.json'), 'utf8'));
    expect(copied.id).toBe('old_library_2');

    const detail = await client.call('getWorld', { id: 'old_library' });
    expect(detail.plotCheck).toEqual({ ok: true, errors: [], warnings: [] });
    expect('scripts' in detail).toBe(false);

    const worldId = 'old_library';
    let v = await client.call('startPlaythrough', { worldId, mode: 'adv' });
    const ref = { worldId, playthroughId: v.playthrough.id };
    expect(v.playthrough.mode).toBe('adv');
    expect(v.adv).toMatchObject({ scene: { id: 'sc_01', title: '图书馆的偶遇' }, finished: false, ending: null, error: null });
    expect(v.adv?.menu?.options.map((o) => o.label)).toEqual(['我是来找你的', '随便看看', '那本书根本不存在吧']);
    expect(v.adv?.progress).toMatchObject({ reached: 0, total: 3, cgs: { unlocked: [], total: 2 }, scenes: { visited: 1, total: 8 } });
    expect(v.adv?.progress.endings.find((e) => e.id === 'sc_08')?.title).toBe('？？？');
    await expect(client.stream('advNext', ref, () => {})).rejects.toThrow('请先做出选择');
    await expect(client.stream('send', { ...ref, text: '你好' }, () => {})).rejects.toThrow('请用选项推进');

    v = await playTo(ref, v, [1, 0, 1, 0, 0]);
    expect(v.adv).toMatchObject({ finished: true, ending: { id: 'sc_05', title: '潮汐归来', kind: 'good' } });
    expect(v.adv?.progress).toMatchObject({ reached: 1, cgs: { unlocked: [] } });
    const t = buildTimeline(v.path, { characters: detail.characters, graph: detail.graph });
    const cgStep = t.steps.find((s) => s.cgShown) as Timeline['steps'][number];
    expect(await client.call('advShown', { ...ref, eventId: cgStep.eventId, cg: 'cg_reunion' })).toEqual({ unlocked: true });
    expect(await client.call('advShown', { ...ref, eventId: cgStep.eventId, cg: 'cg_reunion' })).toEqual({ unlocked: false });
    v = await client.call('getPlaythrough', ref);
    expect(v.adv?.progress.cgs.unlocked).toEqual(['cg_reunion']);
    expect(v.playthrough.preview).toContain('潮水漫过了堤岸');
  });

  it('存档记住舞台播到哪一句；回到岔路换一条路；跨周目进度累计', async () => {
    await setup();
    await client.call('importWorld', { path: path.join(EXAMPLES, 'old_library') });
    const worldId = 'old_library';
    let v = await client.call('startPlaythrough', { worldId, mode: 'adv', title: '第一周目' });
    const ref = { worldId, playthroughId: v.playthrough.id };
    v = await playTo(ref, v, [1, 0]);
    const t = buildTimeline(v.path, { characters: [], graph: null });
    const mid = t.steps.find((s) => s.text?.text === '旧书库的铁门上挂着一把生了锈的密码锁，锁面刻着潮汐的纹路。');
    expect(mid).toBeDefined();
    v = await client.call('saveSlot', { ...ref, name: '门前', at: { eventId: mid?.eventId as string, index: mid?.index as number } });
    expect(v.saves[0]).toMatchObject({
      name: '门前',
      at: { eventId: mid?.eventId, index: mid?.index },
      preview: '旧书库的铁门上挂着一把生了锈的密码锁，锁面刻着潮汐的纹路。',
      thumb: { bg: 'archive_door', cg: null, chars: ['char_lin'], scene: '旧书库的门' },
    });
    await expect(client.call('saveSlot', { ...ref, at: { eventId: 'ev_nope', index: 0 } })).rejects.toThrow('不在当前路径上');

    // 找老周借钥匙 → 念字条（好感正好 40）→ 陪她去海堤：好结局
    v = await playTo(ref, v, [1, 0, 0]);
    expect(v.adv?.ending?.id).toBe('sc_05');

    // 读档：回到门前，舞台位置跟着存档走
    const save = v.saves.find((s) => s.name === '门前');
    v = await client.call('loadSave', { ...ref, saveId: save?.id as string });
    expect(v.adv?.scene?.id).toBe('sc_02');
    expect(v.adv?.menu?.options.map((o) => o.label)).toEqual(['研究门锁的机关', '去找管理员老周借钥匙', '用力撞门']);

    // 回到第一个选择，换成"那本书根本不存在吧"：好感 -10，到了门口自动走向坏结局
    const tl = buildTimeline(v.path, { characters: [], graph: null });
    const first = tl.backlog.find((b) => b.kind === 'choice');
    v = await client.call('rewind', { ...ref, eventId: (first?.kind === 'choice' && first.rewindTo) as string });
    expect(v.adv?.menu?.options).toHaveLength(3);
    v = await playTo(ref, v, [2, 0]);
    expect(v.adv?.scene?.id).toBe('sc_07');
    expect(v.adv).toMatchObject({ finished: true, ending: { id: 'sc_07', kind: 'bad' } });
    expect(v.adv?.vars['affinity.char_lin']).toBe(20);

    // 新周目也看得到之前达成的结局
    const v2 = await client.call('startPlaythrough', { worldId, mode: 'adv' });
    expect(v2.adv?.progress).toMatchObject({ reached: 2, total: 3 });
    expect(v2.playthrough.title).toBe('周目 2');
  });

  it('剧情图被改坏：开不了新周目，已有的周目显示错误、不能继续', async () => {
    await setup();
    await client.call('importWorld', { path: path.join(EXAMPLES, 'old_library') });
    const worldId = 'old_library';
    const v = await client.call('startPlaythrough', { worldId, mode: 'adv' });
    const ref = { worldId, playthroughId: v.playthrough.id };
    const file = path.join(dir, 'worlds', worldId, 'plot', 'outline.json');
    const g = JSON.parse(await readFile(file, 'utf8'));
    g.start = 'sc_99';
    await writeFile(file, JSON.stringify(g));
    expect((await client.call('getWorld', { id: worldId })).plotCheck?.ok).toBe(false);
    await expect(client.call('startPlaythrough', { worldId, mode: 'adv' })).rejects.toThrow('没有通过结构检查');
    const after = await client.call('getPlaythrough', ref);
    expect(after.adv?.error).toContain('没有通过结构检查');
    await expect(client.stream('advChoose', { ...ref, index: 0 }, () => {})).rejects.toThrow('没有通过结构检查');
  });
});
