import { describe, expect, it } from 'vitest';
import {
  Condition,
  isPlotGraph,
  MIGRATED_FROM_OUTLINE,
  migratePlotOutline,
  PlotGraph,
  PlotOutline,
  VariableDef,
} from '../src/index.ts';

describe('条件的结构', () => {
  it('接受嵌套的 all / any / not 和各种叶子', () => {
    const c = {
      all: [
        { gte: ['affinity.char_lin', 70] },
        { flag: 'flags.sister_found' },
        { not: { visited: 'sc_07' } },
        { any: [{ eq: ['route', 'lin'] }, { check: 'pass' }] },
      ],
    };
    expect(Condition.parse(c)).toEqual(c);
  });

  it('拒绝字符串表达式、一个对象里写两种运算、数字比较写成字符串', () => {
    expect(Condition.safeParse('flags.a && affinity.b >= 70').success).toBe(false);
    expect(Condition.safeParse({ flag: 'a', visited: 'sc_01' }).success).toBe(false);
    expect(Condition.safeParse({ gte: ['affinity.b', '70'] }).success).toBe(false);
    expect(Condition.safeParse({ check: 'maybe' }).success).toBe(false);
  });
});

describe('剧情图', () => {
  it('幕只填必填项时补齐默认值（minBeats 默认 2）', () => {
    const g = PlotGraph.parse({ start: 'sc_01', scenes: [{ id: 'sc_01', ending: {} }] });
    expect(g.scenes[0]).toMatchObject({ minBeats: 2, maxBeats: 8, exits: [], points: [], ending: { kind: 'normal', hidden: false } });
    expect(isPlotGraph(g)).toBe(true);
    expect(isPlotGraph({ premise: '', acts: [] })).toBe(false);
  });

  it('剧本文件名不能跳出 plot/scenes/', () => {
    expect(() => PlotGraph.parse({ start: 'a', scenes: [{ id: 'a', script: '../../x.adv' }] })).toThrow();
  });

  it('变量默认是 other 类，没有每拍上限', () => {
    const v = VariableDef.parse({ id: 'money', label: '钱', type: 'number', initial: 0 });
    expect(v.category).toBe('other');
    expect(v.perBeat).toBeUndefined();
  });
});

describe('旧骨架迁移（16.7）', () => {
  const beats = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `${prefix}_${String(i + 1).padStart(2, '0')}`, text: `节拍 ${i + 1}` }));
  const old = PlotOutline.parse({
    premise: '灯塔重新亮起',
    acts: [
      {
        id: 'act_01',
        title: '第一篇章',
        chapters: [
          { id: 'ch_01_01', title: '归乡', goal: '主角回到雾港', beats: beats('b_01_01', 3) },
          { id: 'ch_01_02', title: '暗流', goal: '找到日志', beats: beats('b_01_02', 7) },
        ],
      },
    ],
    endings: [
      { id: 'end_01', title: '守望', condition: '主角选择留下' },
      { id: 'end_02', title: '离港', condition: '主角公开真相后离开' },
    ],
    threads: [{ id: 'fs_1', text: '日志缺失的三页', plant: 'ch_01_02', payoff: '在灯塔顶层' }],
  });

  it('章节变成幕，节拍变成要点（超过 5 个按顺序拆开），单出口串起来，最后一幕通往各个结局', () => {
    const g = migratePlotOutline(old);
    expect(g.start).toBe('sc_01');
    expect(g.chapters).toEqual([{ id: 'act_01', title: '第一篇章' }]);
    expect(g.scenes.map((s) => [s.id, s.title, s.points.length, s.exits.map((e) => e.to)])).toEqual([
      ['sc_01', '归乡', 3, ['sc_02']],
      ['sc_02', '暗流（1/2）', 5, ['sc_03']],
      ['sc_03', '暗流（2/2）', 2, ['sc_04', 'sc_05']],
      ['sc_04', '守望', 0, []],
      ['sc_05', '离港', 0, []],
    ]);
    // 节拍 id 原样保留为要点 id
    expect(g.scenes[1]?.points.map((p) => p.id)).toEqual(['b_01_02_01', 'b_01_02_02', 'b_01_02_03', 'b_01_02_04', 'b_01_02_05']);
    expect(g.scenes[0]?.what).toBe('主角回到雾港');
    // 字符串结局条件原样写进出口的 when
    expect(g.scenes[2]?.exits.map((e) => [e.label, e.when, e.if])).toEqual([
      ['守望', '主角选择留下', undefined],
      ['离港', '主角公开真相后离开', undefined],
    ]);
    expect(g.scenes[2]?.default).toBe('sc_04');
    expect(g.scenes[3]?.ending?.kind).toBe('normal');
    expect(g.threads[0]?.plant).toBe('sc_02');
    expect(g._meta.generatedBy).toBe(MIGRATED_FROM_OUTLINE);
  });

  it('没有结局时补一个终章，没有章节时直接从结局开始', () => {
    const g = migratePlotOutline(PlotOutline.parse({ premise: '', acts: [] }));
    expect(g.scenes).toHaveLength(1);
    expect(g.start).toBe(g.scenes[0]?.id);
    expect(g.scenes[0]?.ending).toBeDefined();
  });
});
