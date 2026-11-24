/**
 * 用手写的示例世界（examples/worlds/old_library）从头玩到不同结局：剧情图、选项、检定、回退换分支、跨周目进度。
 * 不调模型。
 */
import path from 'node:path';
import { LegacyPlotOutline, migratePlotOutline, PlotGraph } from '@auto-adv/schema';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PlayEvent } from '../src/api.ts';
import { PlayDb } from '../src/play/db.ts';
import { foldPlot, type PlotState } from '../src/plot/progress.ts';
import { AdvError, type AdvWorld } from '../src/plot/runner.ts';
import { AdvSession, checkWorldPlot, endingProgress, loadAdvWorld } from '../src/plot/session.ts';
import { type WorldData, WorldStore } from '../src/world/store.ts';

const EXAMPLES = path.resolve(import.meta.dirname, '../../../examples/worlds');

let world: WorldData;
let adv: AdvWorld;

beforeAll(async () => {
  world = await new WorldStore(EXAMPLES).load('old_library');
  adv = loadAdvWorld(world).adv;
});

/** 确定的 id，让骰子结果可以复现。 */
function session(ptId = 'pt_test', db = new PlayDb(':memory:')) {
  let n = 0;
  const s = new AdvSession(db, adv, { newId: (p) => (p === 'pt' ? ptId : `${p}_${ptId}_${++n}`), now: () => 1000 + n });
  return { s, db, pt: s.start('测试周目') };
}

interface Run {
  state: PlotState;
  events: PlayEvent[];
}

/** 一直往下演，遇到选项就按顺序用 picks 里的下标（从 0 开始），用完就停。 */
function play(s: AdvSession, pt: string, picks: number[]): Run {
  const queue = [...picks];
  const events: PlayEvent[] = [];
  let state = s.state(pt);
  for (let guard = 0; guard < 100 && !state.finished; guard++) {
    if (state.menu && !queue.length) break;
    const r = state.menu ? s.choose(pt, queue.shift() as number) : s.next(pt);
    events.push(...r.events);
    state = r.state;
  }
  return { state, events };
}

const beatsIn = (events: PlayEvent[], scene: string) => events.filter((e) => e.kind === 'script' && e.plot?.scene === scene);

describe('示例世界：旧书库的约定', () => {
  it('读取剧情图、变量和手写剧本，结构检查没有错误也没有警告', () => {
    expect(world.graph?.scenes).toHaveLength(8);
    expect(world.variables.map((v) => v.id)).toEqual(['affinity.char_lin', 'attr.wit', 'flags.door_open', 'flags.told_truth']);
    expect(Object.keys(world.scripts).sort()).toEqual(['sc_01', 'sc_02', 'sc_03', 'sc_05', 'sc_08']);
    expect(checkWorldPlot(world)).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it('坏结局：在第一个岔路选「独自离开」', () => {
    const { s, pt } = session();
    const r = play(s, pt, [0, 1]);
    expect(r.state.finished).toBe(true);
    expect(r.state.ending).toBe('sc_07');
    expect(r.state.visited).toEqual(['sc_01', 'sc_07']);
    // 第一幕：剧本里的选项 → 选完之后的内容 + 剧情图的岔路
    const [first, second] = beatsIn(r.events, 'sc_01');
    expect(first?.plot?.menu?.source).toBe('script');
    expect(first?.plot?.points).toEqual(['sc_01_1']);
    expect(second?.plot?.vars).toEqual([{ var: 'affinity.char_lin', from: 30, to: 35 }]);
    expect(second?.plot?.menu).toEqual({
      source: 'exits',
      options: [
        { label: '一起去旧书库', enabled: true },
        { label: '独自离开', enabled: true },
      ],
    });
    expect(second?.segments?.[0]).toEqual({ kind: 'line', characterId: 'char_lin', name: '林夕', text: '……找我？你这人真奇怪。' });
    const choice = r.events.find((e) => e.kind === 'choice' && e.plot?.exit);
    expect(choice?.plot?.exit).toEqual({ to: 'sc_07', by: 'choice' });
    // 没有手写剧本的结局幕：第一拍写出收场，提交时就算达成结局
    const end = beatsIn(r.events, 'sc_07')[0];
    expect(end?.plot).toMatchObject({ ending: 'sc_07', finished: true });
    expect(end?.segments?.[0]?.text).toContain('走进了雨里');
  });

  it('坏结局：好感太低时 auto 出口直接走，不等剧本里的选项', () => {
    const { s, pt } = session();
    const r = play(s, pt, [2, 0]);
    expect(r.state.ending).toBe('sc_07');
    const door = beatsIn(r.events, 'sc_02')[0];
    expect(door?.plot?.exit).toEqual({ to: 'sc_07', by: 'auto' });
    expect(door?.plot?.menu).toBeUndefined();
    expect(r.state.vars['affinity.char_lin']).toBe(20);
  });

  it('好结局：说出字条的事，好感够 40；隐藏结局的选项锁住时显示为"？？？"', () => {
    const { s, pt } = session();
    const r = play(s, pt, [1, 0, 1, 0]);
    expect(r.state.menu?.options).toEqual([
      { label: '陪她去海堤找姐姐', enabled: true },
      { label: '送她回家', enabled: true },
      { label: '？？？', enabled: false },
    ]);
    expect(r.state.vars).toMatchObject({ 'affinity.char_lin': 40, 'flags.told_truth': true, 'flags.door_open': true });
    // 剧本 jump 走出口
    expect(beatsIn(r.events, 'sc_02').at(-1)?.plot?.exit).toEqual({ to: 'sc_03', by: 'script' });
    const end = play(s, pt, [0]);
    expect(end.state.ending).toBe('sc_05');
    expect(end.events.at(-1)?.stage?.map((c) => c.op)).toEqual(['bg', 'bgm', 'cg', 'narrate', 'say', 'narrate']);
  });

  it('隐藏结局：好感到 45 才打开；CG 在舞台第一次显示时才解锁', () => {
    const { s, pt, db } = session();
    const r = play(s, pt, [0, 0, 1, 0, 2]);
    expect(r.state.ending).toBe('sc_08');
    expect(r.state.visited).toEqual(['sc_01', 'sc_02', 'sc_03', 'sc_08']);
    expect(r.state.points).toEqual(new Set(['sc_01_1', 'sc_01_2', 'sc_03_1', 'sc_03_2']));
    const kinds = () => db.listUnlocks().map((u) => `${u.kind}:${u.id}`);
    expect(kinds()).toEqual(['scene:sc_01', 'scene:sc_02', 'scene:sc_03', 'scene:sc_08', 'ending:sc_08']);
    const last = r.events.at(-1) as PlayEvent;
    expect(() => s.markShown(pt, last.id, 'cg_reunion')).toThrow('这个事件里没有这张 CG');
    expect(s.markShown(pt, last.id, 'cg_book')?.eventId).toBe(last.id);
    expect(s.markShown(pt, last.id, 'cg_book')).toBeNull();
    expect(kinds().at(-1)).toBe('cg:cg_book');
  });

  it('普通结局：门没打开，走进没有手写剧本的幕（占位旁白），唯一的出口自动走', () => {
    // 找一个"研究门锁"检定失败的周目（骰子由周目 id 和剧情位置决定，所以结果是确定的）
    let found: Run | null = null;
    for (let i = 0; i < 40 && !found; i++) {
      const { s, pt } = session(`pt_fail_${i}`);
      const r = play(s, pt, [0, 0, 0]);
      if (r.events.find((e) => e.kind === 'check')?.check?.outcome === 'fail') found = r;
    }
    if (!found) throw new Error('40 个周目里没有一次检定失败');
    expect(found.state.ending).toBe('sc_06');
    expect(found.state.visited).toEqual(['sc_01', 'sc_02', 'sc_04', 'sc_06']);
    const stub = beatsIn(found.events, 'sc_04')[0];
    expect(stub?.segments?.[0]?.text).toContain('之后由 AI 演出');
    expect(stub?.plot?.exit).toEqual({ to: 'sc_06', by: 'single' });
  });

  it('普通结局：藏起字条，送她回家；锁住的选项选不了', () => {
    const { s, pt } = session();
    const r = play(s, pt, [0, 0, 1, 1]);
    expect(r.state.menu?.options[0]).toEqual({
      label: '陪她去海堤找姐姐',
      enabled: false,
      lockedBy: '把字条的事告诉了林夕 且 林夕的好感 ≥ 40',
    });
    expect(() => s.choose(pt, 0)).toThrow(AdvError);
    expect(() => s.choose(pt, 2)).toThrow(/现在选不了/);
    expect(() => s.next(pt)).toThrow(/请先做出选择/);
    expect(play(s, pt, [1]).state.ending).toBe('sc_06');
    expect(() => s.next(pt)).toThrow(/已经结束/);
  });
});

describe('检定跟剧情位置绑定', () => {
  it('回退后再选同一项，骰子结果不变；两次选择是同一个父事件下的兄弟节点', () => {
    const { s, pt, db } = session('pt_dice');
    play(s, pt, [0, 0]);
    const head = db.getPlaythrough(pt).headId;
    expect(s.state(pt).menu?.options.map((o) => o.check)).toEqual([{ var: 'attr.wit', dc: 12 }, undefined, { dc: 16 }]);
    const a = s.choose(pt, 0).events;
    s.rewind(pt, head);
    const b = s.choose(pt, 0).events;
    const ca = a.find((e) => e.kind === 'check')?.check;
    const cb = b.find((e) => e.kind === 'check')?.check;
    expect(ca).toBeDefined();
    expect(cb).toEqual(ca);
    expect(ca?.modifier).toBe(1);
    expect(a[0]?.parentId).toBe(head);
    expect(b[0]?.parentId).toBe(head);
    expect(db.childrenOf(pt, [head]).get(head)).toHaveLength(2);
    // 检定事件先于演出，选项之后的内容按结果分支
    expect(a.map((e) => e.kind)).toEqual(['choice', 'check', 'script']);
    // 回退到选项事件本身（还没掷骰）再继续：补掷的还是同一个结果
    s.rewind(pt, (a[0] as PlayEvent).id);
    const c = s.next(pt).events;
    expect(c.map((e) => e.kind)).toEqual(['check', 'script']);
    expect(c[0]?.check).toEqual(ca);
    // 回退到检定事件上再继续：不再掷骰，直接演
    s.rewind(pt, (a[1] as PlayEvent).id);
    expect(s.next(pt).events.map((e) => e.kind)).toEqual(['script']);
  });
});

describe('出口上的检定（16.4）', () => {
  /** 示例世界第一幕的岔路「独自离开」加一个检定。 */
  function withExitCheck() {
    const graph = PlotGraph.parse({
      ...world.graph,
      scenes: world.graph?.scenes.map((sc) =>
        sc.id === 'sc_01'
          ? { ...sc, exits: sc.exits.map((e) => (e.to === 'sc_07' ? { ...e, check: { var: 'attr.wit', dc: 12, label: '冒雨离开' } } : e)) }
          : sc,
      ),
    });
    const w2: WorldData = { ...world, graph };
    expect(checkWorldPlot(w2)).toEqual({ ok: true, errors: [], warnings: [] });
    let n = 0;
    const db = new PlayDb(':memory:');
    const s = new AdvSession(db, loadAdvWorld(w2).adv, { newId: (p) => (p === 'pt' ? 'pt_exit' : `${p}_${++n}`), now: () => 1000 + n });
    return { s, db, pt: s.start('出口检定') };
  }

  it('选了这条路才掷：记在换幕之后，下一幕按结果演；回退再选结果不变', () => {
    const { s, db, pt } = withExitCheck();
    play(s, pt, [0]);
    const head = db.getPlaythrough(pt).headId;
    expect(s.state(pt).menu).toEqual({
      source: 'exits',
      options: [
        { label: '一起去旧书库', enabled: true },
        { label: '独自离开', enabled: true, check: { var: 'attr.wit', dc: 12, label: '冒雨离开' } },
      ],
    });
    const a = s.choose(pt, 1).events;
    expect(a.map((e) => e.kind)).toEqual(['choice', 'check', 'script']);
    expect(a[0]?.plot?.exit).toEqual({ to: 'sc_07', by: 'choice' });
    expect(a[1]?.check).toMatchObject({ id: 'sc_01:exit:sc_07', label: '冒雨离开', dc: 12, modifier: 1 });
    expect(a[2]?.plot).toMatchObject({ scene: 'sc_07', ending: 'sc_07' });
    // 回退再选：同一个父事件，骰子不变
    s.rewind(pt, head);
    const b = s.choose(pt, 1).events;
    expect(b[1]?.check).toEqual(a[1]?.check);
    // 回退到选项事件本身（还没掷骰）再继续：补掷的还是同一个结果
    s.rewind(pt, (a[0] as PlayEvent).id);
    const c = s.next(pt).events;
    expect(c.map((e) => e.kind)).toEqual(['check', 'script']);
    expect(c[0]?.check).toEqual(a[1]?.check);
    // 另一条路没有检定
    s.rewind(pt, head);
    expect(s.choose(pt, 0).events.map((e) => e.kind)).toEqual(['choice', 'script']);
  });

  it('结构检查：auto 出口和只有一条路的幕上的检定不会掷骰，变量要是数值', () => {
    const graph = PlotGraph.parse({
      ...world.graph,
      scenes: world.graph?.scenes.map((sc) => {
        if (sc.id === 'sc_02') return { ...sc, exits: sc.exits.map((e) => (e.auto ? { ...e, check: { dc: 10 } } : e)) };
        if (sc.id === 'sc_04') return { ...sc, exits: sc.exits.map((e) => ({ ...e, check: { var: 'flags.door_open', dc: 10 } })) };
        return sc;
      }),
    });
    const r = checkWorldPlot({ ...world, graph });
    if (!r) throw new Error('世界没有剧情图');
    expect(r.errors.map((e) => e.message)).toEqual(['出口 1（→ sc_06）的检定变量 flags.door_open 不是数值']);
    expect(r.warnings.map((e) => e.message)).toEqual([
      '出口 3（→ sc_07）是 auto 出口，上面的检定不会掷骰',
      '出口 1（→ sc_06）上有检定，但这一幕不是岔路：只有一条路时由导演换幕，检定不会掷骰',
    ]);
  });
});

describe('回退和换分支：进度从事件折叠，自动正确', () => {
  it('回到最后的岔路换一条路，结局进度不会被撤销', () => {
    const { s, pt, db } = session();
    const hidden = play(s, pt, [0, 0, 1, 0, 2]);
    expect(hidden.state.ending).toBe('sc_08');

    const fork = hidden.events.find((e) => e.plot?.scene === 'sc_03' && e.plot.menu?.source === 'exits') as PlayEvent;
    const back = s.rewind(pt, fork.id);
    expect(back.scene?.id).toBe('sc_03');
    expect(back.ending).toBeNull();
    expect(back.finished).toBe(false);
    expect(back.menu?.options.map((o) => o.enabled)).toEqual([true, true, true]);
    expect(back.vars['affinity.char_lin']).toBe(45);

    const normal = play(s, pt, [1]);
    expect(normal.state.ending).toBe('sc_06');
    expect(normal.state.visited).toEqual(['sc_01', 'sc_02', 'sc_03', 'sc_06']);
    expect(db.childrenOf(pt, [fork.id]).get(fork.id)).toHaveLength(2);

    // 回到开头：数值、要点、走过的幕都回到当时
    const root = s.path(pt)[0] as PlayEvent;
    const start = s.rewind(pt, root.id);
    expect(start.scene?.id).toBe('sc_01');
    expect(start.vars['affinity.char_lin']).toBe(30);
    expect(start.points.size).toBe(0);
    expect(start.visited).toEqual(['sc_01']);

    // 跨周目进度不随回退撤销：两个结局都还在
    const prog = endingProgress(adv.graph, db.listUnlocks());
    expect(prog.endings.filter((e) => e.reached).map((e) => e.id)).toEqual(['sc_06', 'sc_08']);
    expect(prog).toMatchObject({ reached: 2, total: 4 });
  });
});

describe('跨周目进度', () => {
  it('删掉周目也不影响已有记录；隐藏结局达成前不计入总数；同一项只记第一次', () => {
    const db = new PlayDb(':memory:');
    const a = session('pt_a', db);
    play(a.s, a.pt, [0, 1]);
    expect(endingProgress(adv.graph, db.listUnlocks())).toMatchObject({ reached: 1, total: 3 });
    db.deletePlaythrough(a.pt);
    expect(db.listUnlocks('ending')).toEqual([{ kind: 'ending', id: 'sc_07', firstAt: expect.any(Number), playthroughId: 'pt_a', eventId: expect.any(String) }]);

    const b = session('pt_b', db);
    const r = play(b.s, b.pt, [0, 0, 1, 0, 2]);
    expect(r.state.ending).toBe('sc_08');
    expect(endingProgress(adv.graph, db.listUnlocks())).toMatchObject({ reached: 2, total: 4 });
    // 再走一次坏结局：已经记过，不会再记
    const c = session('pt_c', db);
    const again = play(c.s, c.pt, [0]);
    const last = c.s.choose(c.pt, 1);
    expect(again.state.menu?.source).toBe('exits');
    expect(last.unlocked).toEqual([]);
    expect(db.listUnlocks('ending').find((u) => u.id === 'sc_07')?.playthroughId).toBe('pt_a');
  });
});

describe('解锁表', () => {
  it('旧的 play.db 打开时自动加上解锁表，重新打开后记录还在', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const os = await import('node:os');
    const { DatabaseSync } = await import('node:sqlite');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'auto-adv-unlock-'));
    const file = path.join(dir, 'play.db');
    try {
      new PlayDb(file).close();
      // 模拟 M2 的数据库：去掉解锁表，版本退回 2
      const raw = new DatabaseSync(file);
      raw.exec('DROP TABLE unlocks; PRAGMA user_version = 2;');
      raw.close();
      const db = new PlayDb(file);
      expect(db.unlock({ kind: 'cg', id: 'cg_1', firstAt: 1, playthroughId: 'pt', eventId: 'ev' })).toBe(true);
      expect(db.unlock({ kind: 'cg', id: 'cg_1', firstAt: 2, playthroughId: 'pt2', eventId: 'ev2' })).toBe(false);
      db.close();
      const again = new PlayDb(file);
      expect(again.listUnlocks()).toEqual([{ kind: 'cg', id: 'cg_1', firstAt: 1, playthroughId: 'pt', eventId: 'ev' }]);
      again.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('开玩前的检查和旧周目兼容', () => {
  it('结构检查有错误时不能开始 ADV 周目', () => {
    const broken: WorldData = {
      ...world,
      graph: PlotGraph.parse({ ...world.graph, scenes: world.graph?.scenes.filter((x) => x.id !== 'sc_04') }),
    };
    expect(() => loadAdvWorld(broken)).toThrow(/没有通过结构检查.*sc_02.*sc_04/);
  });

  it('M2 观察模式的周目：只有"完成了哪些节拍"，当前幕 = 第一个还有要点没演完的幕', () => {
    const graph = migratePlotOutline(
      LegacyPlotOutline.parse({
        premise: '',
        acts: [
          {
            id: 'act_01',
            title: '第一篇章',
            chapters: [
              { id: 'ch_01_01', goal: 'a', beats: [{ id: 'b_1', text: '1' }, { id: 'b_2', text: '2' }] },
              { id: 'ch_01_02', goal: 'b', beats: [{ id: 'b_3', text: '3' }, { id: 'b_4', text: '4' }] },
            ],
          },
        ],
        endings: [{ id: 'end_01', title: '终', condition: '' }],
      }),
    );
    const ev = (id: string, done: string[]): PlayEvent => ({
      id,
      parentId: null,
      kind: 'ai',
      createdAt: 0,
      beat: { plan: '', strategy: 'merged', done },
    });
    const s = foldPlot(graph, [], [{ id: 'r', parentId: null, kind: 'opening', createdAt: 0 }, ev('e1', ['b_1']), ev('e2', ['b_2', 'b_3'])]);
    expect(s.scene?.id).toBe('sc_02');
    expect(s.visited).toEqual(['sc_01', 'sc_02']);
    expect([...s.points]).toEqual(['b_1', 'b_2', 'b_3']);
    const all = foldPlot(graph, [], [ev('e1', ['b_1', 'b_2', 'b_3', 'b_4'])]);
    expect(all.scene?.id).toBe('sc_02'); // 全部演完：停在通往结局的最后一幕
  });
});
