import { PlotGraph, VariableDef } from '@auto-adv/schema';
import { describe, expect, it } from 'vitest';
import type { PlayEvent } from '../src/api.ts';
import { GraphOut, toGraph } from '../src/genesis/graph.ts';
import { aiMenu, checkSpecOf, type DirectorReport, judgeBeat } from '../src/plot/judge.ts';
import { continueWith, foldPlot, initialPlotState, type PlotState, reducePlot } from '../src/plot/progress.ts';

const graph = PlotGraph.parse({
  start: 'sc_01',
  chapters: [{ id: 'ch_01', title: '第一章' }],
  scenes: [
    {
      id: 'sc_01',
      chapter: 'ch_01',
      title: '开头',
      points: [
        { id: 'sc_01_1', text: '相遇' },
        { id: 'sc_01_2', text: '约定' },
      ],
      exits: [
        { to: 'sc_02', label: '一起走', when: '答应' },
        { to: 'sc_03', label: '独自走', when: '拒绝', if: { gte: ['affinity.lin', 50] } },
      ],
    },
    { id: 'sc_02', title: '同行', exits: [{ to: 'sc_04' }] },
    { id: 'sc_03', title: '独行', exits: [{ to: 'sc_04' }] },
    { id: 'sc_04', title: '结局', ending: { kind: 'good', text: '一起看日出' } },
  ],
});
const variables = [
  VariableDef.parse({ id: 'affinity.lin', label: '好感', type: 'number', initial: 30, min: 0, max: 100, category: 'relationship' }),
  VariableDef.parse({ id: 'skill.wit', label: '机智', type: 'number', initial: 2, min: -2, max: 5, category: 'attribute' }),
  VariableDef.parse({ id: 'flag.met', label: '见过', type: 'boolean', initial: false }),
];

const report = (r: Partial<DirectorReport> = {}): DirectorReport => ({
  points: [],
  sceneDone: false,
  exit: '',
  offTrack: false,
  set: [],
  ...r,
});

const fresh = () => initialPlotState(graph, variables);
const withBeats = (n: number): PlotState => {
  const s = fresh();
  s.sceneBeats = n;
  return s;
};

describe('judgeBeat：导演报告的进度由引擎核对', () => {
  it('要点只能是当前幕里还没演到的', () => {
    const s = fresh();
    s.points.add('sc_01_1');
    const { mark } = judgeBeat({
      state: s,
      variables,
      mode: 'observer',
      report: report({ points: ['sc_01_1', 'sc_01_2', 'sc_02_1', ''] }),
      playerAction: false,
      check: null,
    });
    expect(mark.points).toEqual(['sc_01_2']);
    expect(mark.notes?.join('\n')).toMatch(/sc_01_1 之前已经演到过[\s\S]*sc_02_1 不属于当前这一幕/);
  });

  it('数值：每拍有上限，演到要点或检定成功时用突破上限；写法不对的丢掉', () => {
    const plain = judgeBeat({
      state: fresh(),
      variables,
      mode: 'observer',
      report: report({ set: [{ var: 'affinity.lin', op: '+', value: 20 }, { var: 'Bad Id', op: '+', value: 1 }, { var: 'flag.met', op: '=', value: 'true' }] }),
      playerAction: false,
      check: null,
    }).mark;
    expect(plain.vars).toEqual([
      { var: 'affinity.lin', from: 30, to: 35 },
      { var: 'flag.met', from: false, to: true },
    ]);
    expect(plain.notes?.join('\n')).toMatch(/Bad Id[\s\S]*最多变化 ±5/);
    const burst = judgeBeat({
      state: fresh(),
      variables,
      mode: 'observer',
      report: report({ points: ['sc_01_1'], set: [{ var: 'affinity.lin', op: '+', value: '20' }] }),
      playerAction: false,
      check: null,
    }).mark;
    expect(burst.vars).toEqual([{ var: 'affinity.lin', from: 30, to: 42 }]);
    // 负数加法当成减法
    const minus = judgeBeat({ state: fresh(), variables, mode: 'observer', report: report({ set: [{ var: 'affinity.lin', op: '+', value: -3 }] }), playerAction: false, check: null }).mark;
    expect(minus.vars).toEqual([{ var: 'affinity.lin', from: 30, to: 27 }]);
  });

  it('出口：没演够最少拍数、条件不成立都驳回；观察模式可以由导演选路', () => {
    const early = judgeBeat({ state: withBeats(0), variables, mode: 'observer', report: report({ sceneDone: true, exit: 'sc_02' }), playerAction: false, check: null }).mark;
    expect(early.exit).toBeUndefined();
    expect(early.notes?.join()).toContain('至少要演 2 拍');
    const closed = judgeBeat({ state: withBeats(2), variables, mode: 'observer', report: report({ sceneDone: true, exit: 'sc_03' }), playerAction: false, check: null }).mark;
    expect(closed.exit).toBeUndefined();
    expect(closed.notes?.join()).toContain('条件不成立');
    const ok = judgeBeat({ state: withBeats(2), variables, mode: 'observer', report: report({ sceneDone: true, exit: 'sc_02' }), playerAction: false, check: null });
    expect(ok.mark.exit).toEqual({ to: 'sc_02', by: 'director' });
    // 观察模式：说演完了但没选路，下一拍必须选
    const noExit = judgeBeat({ state: withBeats(2), variables, mode: 'observer', report: report({ sceneDone: true }), playerAction: false, check: null }).mark;
    expect(noExit.notes?.join()).toContain('下一拍必须从出口里选一条路');
  });

  it('剧情 ADV：岔路只能由玩家决定，没有玩家行动时弹出岔路选项', () => {
    const adv = judgeBeat({ state: withBeats(2), variables, mode: 'adv', report: report({ sceneDone: true, exit: 'sc_02' }), playerAction: false, check: null }).mark;
    expect(adv.exit).toBeUndefined();
    expect(adv.menu?.source).toBe('exits');
    expect(adv.menu?.options.map((o) => [o.label, o.enabled])).toEqual([
      ['一起走', true],
      ['独自走', false],
    ]);
    // 玩家这一拍输入了"我跟你走"，导演把它对应到出口：可以走
    const byInput = judgeBeat({ state: withBeats(2), variables, mode: 'adv', report: report({ exit: 'sc_02' }), playerAction: true, check: null }).mark;
    expect(byInput.exit).toEqual({ to: 'sc_02', by: 'director' });
  });

  it('结局幕：第一拍就算达成结局，记下解锁', () => {
    const s = fresh();
    reducePlot(s, { id: 'c', parentId: null, kind: 'choice', createdAt: 0, choice: { index: 0, label: '' }, plot: { scene: 'sc_01', exit: { to: 'sc_04', by: 'choice' } } });
    const r = judgeBeat({ state: s, variables, mode: 'adv', report: report({ sceneDone: true, exit: 'sc_01' }), playerAction: false, check: null });
    expect(r.mark).toMatchObject({ scene: 'sc_04', ending: 'sc_04', finished: true });
    expect(r.mark.exit).toBeUndefined();
    expect(r.unlocks).toEqual([
      { kind: 'scene', id: 'sc_04' },
      { kind: 'ending', id: 'sc_04' },
    ]);
  });
});

describe('AI 给玩家的选项', () => {
  it('去重、最多 4 个，出口必须是这一幕的，条件不成立的锁住，检定按属性核对', () => {
    const { menu, notes } = aiMenu(
      fresh(),
      [
        { label: '跟她走', exit: 'sc_02' },
        { label: '跟她走' },
        { label: '一个人走', exit: 'sc_03' },
        { label: '去别的地方', exit: 'sc_09' },
        { label: '试着说服她', check: { var: 'skill.wit', dc: 99, label: '说服' } },
        { label: '第五个' },
      ],
      variables,
    );
    expect(menu?.source).toBe('ai');
    expect(menu?.options).toEqual([
      { label: '跟她走', enabled: true, exit: 'sc_02' },
      { label: '一个人走', enabled: false, exit: 'sc_03', lockedBy: expect.stringContaining('好感') },
      { label: '去别的地方', enabled: true },
      { label: '试着说服她', enabled: true, check: { var: 'skill.wit', dc: 30, label: '说服' } },
    ]);
    expect(notes.join()).toContain('sc_09 不是这一幕的出口');
    expect(checkSpecOf({ var: 'nope', dc: 10 }, variables).spec).toBeNull();
    expect(checkSpecOf({ dc: 'x' }, variables).spec).toBeNull();
    expect(checkSpecOf({ dc: 3 }, variables).spec).toEqual({ dc: 5, label: '检定' });
  });

  it('通往隐藏结局、条件还不成立的选项直接去掉，不显示锁住的原因', () => {
    const g = PlotGraph.parse({
      start: 'sc_01',
      scenes: [
        {
          id: 'sc_01',
          exits: [
            { to: 'sc_02', label: '回家', when: '其他' },
            { to: 'sc_03', label: '翻开书', when: '信任', if: { gte: ['affinity.lin', 90] } },
          ],
        },
        { id: 'sc_02', ending: { kind: 'normal' } },
        { id: 'sc_03', ending: { kind: 'good', hidden: true } },
      ],
    });
    const { menu, notes } = aiMenu(
      initialPlotState(g, variables),
      [
        { label: '回家', exit: 'sc_02' },
        { label: '翻开那本书', exit: 'sc_03' },
      ],
      variables,
    );
    expect(menu?.options).toEqual([{ label: '回家', enabled: true, exit: 'sc_02' }]);
    expect(notes.join()).toContain('现在还走不了');
  });
});

describe('续写和旧周目', () => {
  it('续写的幕记在事件上：折叠时接到剧情图后面，从新篇章的起始幕继续', () => {
    const s = fresh();
    const add = {
      chapters: [{ id: 'ch_02', title: '续篇' }],
      scenes: PlotGraph.parse({ start: 'sc_05', scenes: [{ id: 'sc_05', title: '新的开始', exits: [{ to: 'sc_06' }] }, { id: 'sc_06', ending: {} }] }).scenes,
    };
    s.finished = true;
    const next = continueWith(s, add, 'sc_05');
    expect(next.scene?.id).toBe('sc_05');
    expect(next.finished).toBe(false);
    expect(s.graph.scenes).toHaveLength(4); // 原来的状态不变
    const path: PlayEvent[] = [
      { id: 'r', parentId: null, kind: 'opening', createdAt: 0 },
      { id: 'a', parentId: 'r', kind: 'ai', createdAt: 0, plot: { scene: 'sc_05', append: add } },
    ];
    const folded = foldPlot(graph, variables, path);
    expect(folded.scene?.title).toBe('新的开始');
    expect(folded.graph.scenes.map((x) => x.id)).toEqual(['sc_01', 'sc_02', 'sc_03', 'sc_04', 'sc_05', 'sc_06']);
    expect(folded.appended.scenes.map((x) => x.id)).toEqual(['sc_05', 'sc_06']);
    expect(folded.sceneBeats).toBe(1);
  });

  it('M2 观察模式的周目：完成的节拍算要点，续写的篇章接到后面', () => {
    const legacy = PlotGraph.parse({
      start: 'sc_01',
      scenes: [
        { id: 'sc_01', points: [{ id: 'b_1', text: '' }], exits: [{ to: 'sc_02' }] },
        { id: 'sc_02', ending: {} },
      ],
    });
    const ai = (id: string, done: string[], arc?: unknown): PlayEvent =>
      ({ id, parentId: null, kind: 'ai', createdAt: 0, beat: { plan: '', strategy: 'merged', done, ...(arc ? { arc } : {}) } }) as PlayEvent;
    const arc = { id: 'act_02', title: '续篇', chapters: [{ id: 'ch_02_01', title: '新章', goal: '新目标', beats: [{ id: 'b_2', text: '' }, { id: 'b_3', text: '' }] }] };
    const s = foldPlot(legacy, [], [ai('e1', ['b_1']), ai('e2', [], arc), ai('e3', ['b_2'])]);
    expect([...s.points]).toEqual(['b_1', 'b_2']);
    expect(s.graph.scenes.map((x) => [x.id, x.exits.map((e) => e.to)])).toEqual([
      ['sc_01', ['sc_02']],
      ['sc_02', []],
      ['sc_03', ['sc_02']],
    ]);
    expect(s.scene?.id).toBe('sc_03');
  });
});

describe('模型写的剧情图', () => {
  it('重新编号、章节写序号、名字换成 id、visited 条件跟着换；写错的条件交给模型改', () => {
    const value = GraphOut.parse({
      chapters: ['第一章', { title: '第二章' }],
      variables: [{ id: 'Affinity.Lin', label: '好感', type: 'number', initial: '200', category: 'relationship' }],
      scenes: [
        { id: 'start', chapter: 1, title: '开头', points: ['a', 'b', 'c', 'd', 'e', 'f'], location: '海边', cast: ['林夕', '路人'], exits: [{ to: '中间' }, { to: 'end', if: 'affinity > 3' }] },
        { id: 'mid', chapter: '第二章', title: '中间', exits: [{ to: 'end', if: { not: { visited: 'start' } } }, { to: 'end' }], default: 'end' },
        { id: 'end', chapter: 2, title: '结局', ending: { kind: 'GOOD' }, exits: [{ to: 'start' }] },
      ],
    });
    const r = toGraph(value, {
      world: { characters: [{ id: 'char_lin', name: '林夕' }] as never, locations: [{ id: 'loc_sea', name: '海边' }] as never },
    });
    expect(r.variables).toEqual([expect.objectContaining({ id: 'affinity.lin', initial: 100, min: 0, max: 100 })]);
    const [a, b, c] = r.graph.scenes;
    expect(a).toMatchObject({ id: 'sc_01', chapter: 'ch_01', location: 'loc_sea', cast: ['char_lin'] });
    expect(a?.points.map((p) => p.id)).toEqual(['sc_01_1', 'sc_01_2', 'sc_01_3', 'sc_01_4', 'sc_01_5']);
    expect(a?.exits.map((e) => e.to)).toEqual(['sc_02', 'sc_03']);
    expect(a?.exits[1]?.if).toBeUndefined();
    expect(b).toMatchObject({ chapter: 'ch_02', exits: [{ to: 'sc_03', if: { not: { visited: 'sc_01' } } }] });
    expect(b?.default).toBeUndefined(); // default 指向带条件的出口：去掉
    expect(c).toMatchObject({ chapter: 'ch_02', ending: { kind: 'good' }, exits: [] });
    expect(r.problems.join()).toContain('写法不对');
  });
});
