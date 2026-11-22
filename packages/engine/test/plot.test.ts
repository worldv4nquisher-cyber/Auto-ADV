import { type Condition, PlotGraph, type PlotScene, VariableDef } from '@auto-adv/schema';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { parseAdv } from '../src/plot/adv.ts';
import { checkPlot } from '../src/plot/check.ts';
import { type ConditionContext, describeCondition, evalCondition } from '../src/plot/conditions.ts';
import { d20, outcomeOf, rollCheck } from '../src/plot/dice.ts';
import { compileScript } from '../src/plot/runner.ts';
import { decideTransition } from '../src/plot/transition.ts';
import { applyEffects, mergeChanges } from '../src/plot/vars.ts';

const vars = [
  { id: 'affinity.char_lin', label: '林夕的好感', type: 'number', initial: 30, min: 0, max: 100, category: 'relationship' },
  { id: 'attr.wit', label: '机智', type: 'number', initial: 1, min: -2, max: 5, category: 'attribute' },
  { id: 'money', label: '钱', type: 'number', initial: 0 },
  { id: 'flags.met', label: '见过面', type: 'boolean', initial: false },
  { id: 'route', label: '路线', type: 'string', initial: '' },
].map((v) => VariableDef.parse(v));

const ctx = (over: Partial<ConditionContext> = {}): ConditionContext => ({
  vars: { 'affinity.char_lin': 45, 'flags.met': true, route: 'lin', money: 3 },
  visited: new Set(['sc_01', 'sc_02']),
  check: null,
  ...over,
});

describe('条件求值（16.3）', () => {
  it('组合、比较、标记、走过、检定', () => {
    const c: Condition = {
      all: [{ gte: ['affinity.char_lin', 40] }, { flag: 'flags.met' }, { not: { visited: 'sc_07' } }, { eq: ['route', 'lin'] }],
    };
    expect(evalCondition(c, ctx())).toBe(true);
    expect(evalCondition(c, ctx({ vars: { 'affinity.char_lin': 39, 'flags.met': true, route: 'lin' } }))).toBe(false);
    expect(evalCondition({ all: [] }, ctx())).toBe(true);
    expect(evalCondition({ any: [] }, ctx())).toBe(false);
    expect(evalCondition(undefined, ctx())).toBe(true);
    expect(evalCondition({ check: 'pass' }, ctx())).toBe(false); // 这一幕还没检定过
    expect(evalCondition({ check: 'pass' }, ctx({ check: 'narrow' }))).toBe(true); // 险胜也算通过
    expect(evalCondition({ check: 'fail' }, ctx({ check: 'fail' }))).toBe(true);
  });

  it('不存在的变量、类型对不上都算不成立', () => {
    expect(evalCondition({ gte: ['nope', 1] }, ctx())).toBe(false);
    expect(evalCondition({ ne: ['nope', 1] }, ctx())).toBe(false);
    expect(evalCondition({ eq: ['route', 1] }, ctx())).toBe(false);
    expect(evalCondition({ gt: ['route', 1] }, ctx())).toBe(false);
    expect(evalCondition({ flag: 'money' }, ctx())).toBe(false);
  });

  it('写成人能读的一句话', () => {
    const names = { vars: new Map(vars.map((v) => [v.id, v])) };
    expect(describeCondition({ all: [{ flag: 'flags.met' }, { gte: ['affinity.char_lin', 40] }] }, names)).toBe(
      '见过面 且 林夕的好感 ≥ 40',
    );
    expect(describeCondition({ any: [{ flag: 'flags.met' }, { all: [{ lt: ['money', 1] }, { check: 'pass' }] }] }, names)).toBe(
      '见过面 或 （钱 < 1 且 检定通过）',
    );
  });
});

describe('数值裁决（16.4）', () => {
  const base = { 'affinity.char_lin': 30, 'attr.wit': 1, money: 0, 'flags.met': false, route: '' };

  it('模型提出的关系类数值每拍合计不超过 ±5，演到要点或检定成功时可以到 ±12', () => {
    const r = applyEffects(vars, base, [
      { var: 'affinity.char_lin', op: '+', value: 6 },
      { var: 'affinity.char_lin', op: '+', value: 3 },
    ], { source: 'model' });
    expect(r.values['affinity.char_lin']).toBe(35);
    expect(r.changes).toEqual([{ var: 'affinity.char_lin', from: 30, to: 35 }]);
    expect(r.notes[0]).toContain('截成 +5');
    const burst = applyEffects(vars, base, [{ var: 'affinity.char_lin', op: '+', value: 20 }], { source: 'model', burst: true });
    expect(burst.values['affinity.char_lin']).toBe(42);
    const down = applyEffects(vars, base, [{ var: 'affinity.char_lin', op: '=', value: 0 }], { source: 'model' });
    expect(down.values['affinity.char_lin']).toBe(25);
  });

  it('作者写死的效果只检查范围，不受每拍上限限制', () => {
    const r = applyEffects(vars, base, [{ var: 'affinity.char_lin', op: '+', value: 80 }], { source: 'author' });
    expect(r.values['affinity.char_lin']).toBe(100);
    expect(r.notes[0]).toContain('超出范围');
    // 其他类数值没有每拍上限
    expect(applyEffects(vars, base, [{ var: 'money', op: '+', value: 999 }], { source: 'model' }).values.money).toBe(999);
  });

  it('不存在的变量、类型不对的值、对非数值用 + 都会被驳回', () => {
    const r = applyEffects(vars, base, [
      { var: 'nope', op: '=', value: 1 },
      { var: 'flags.met', op: '+', value: 1 },
      { var: 'route', op: '=', value: 3 },
      { var: 'money', op: '=', value: 'x' },
      { var: 'flags.met', op: '=', value: true },
    ], { source: 'model' });
    expect(r.notes).toHaveLength(4);
    expect(r.changes).toEqual([{ var: 'flags.met', from: false, to: true }]);
  });

  it('同一拍几批变化合并成一条', () => {
    expect(
      mergeChanges(
        [{ var: 'money', from: 0, to: 5 }],
        [{ var: 'money', from: 5, to: 0 }, { var: 'route', from: '', to: 'lin' }],
      ),
    ).toEqual([{ var: 'route', from: '', to: 'lin' }]);
  });
});

describe('检定（16.4）', () => {
  it('四档结果：20 大成功、1 总是失败、差 1～2 点险胜', () => {
    expect(outcomeOf(20, 21, 30)).toBe('crit');
    expect(outcomeOf(1, 30, 10)).toBe('fail');
    expect(outcomeOf(10, 12, 12)).toBe('success');
    expect(outcomeOf(9, 10, 12)).toBe('narrow');
    expect(outcomeOf(8, 9, 12)).toBe('fail');
  });

  it('骰子跟剧情位置绑定：同一个周目、父事件、检定 id 结果不变', () => {
    const spec = { id: 'lock', dc: 12, label: '撬锁', var: 'attr.wit' };
    const a = rollCheck(spec, 2, { playthroughId: 'pt_1', parentId: 'ev_9' });
    const b = rollCheck(spec, 2, { playthroughId: 'pt_1', parentId: 'ev_9' });
    expect(b).toEqual(a);
    expect(a.total).toBe(a.roll + 2);
    expect(a.roll).toBeGreaterThanOrEqual(1);
    expect(a.roll).toBeLessThanOrEqual(20);
  });

  it('d20 大致均匀', () => {
    const counts = new Array(21).fill(0) as number[];
    for (let i = 0; i < 20000; i++) counts[d20(`pt|ev_${i}|x`)] = (counts[d20(`pt|ev_${i}|x`)] ?? 0) + 1;
    for (let face = 1; face <= 20; face++) {
      expect(counts[face]).toBeGreaterThan(800);
      expect(counts[face]).toBeLessThan(1200);
    }
  });
});

describe('.adv 剧本解析', () => {
  const text = [
    '# 注释',
    'bg library fade',
    'show lin neutral left',
    'lin "……你也来找那本书？"',
    '"夕阳把书架的影子拉得很长。"',
    'think "要不要告诉她？"',
    'set affinity.char_lin +5',
    'set route "lin"',
    'point sc_01_1',
    'choice',
    '  "我是来找你的" -> set affinity.char_lin +5; set flags.met true',
    '    lin 「……找我？」',
    '  "撬开锁" check attr.wit dc 12 id lock',
    '    if {"check": "pass"}',
    '      narrate "锁开了。"',
    '    else',
    '      narrate "锁纹丝不动。"',
    '  "离开" if {"flag": "flags.met"} -> goto sc_03',
    'bgm stop',
    'jump sc_02',
  ].join('\n');

  it('解析成 Script IR', () => {
    const r = parseAdv(text);
    expect(r.errors).toEqual([]);
    const ops = r.commands.map((c) => c.op);
    expect(ops).toEqual(['bg', 'show', 'say', 'narrate', 'think', 'set', 'set', 'point', 'choice', 'bgm', 'jump']);
    expect(r.commands[0]).toEqual({ op: 'bg', id: 'library', transition: 'fade', line: 2 });
    expect(r.commands[2]).toEqual({ op: 'say', char: 'lin', text: '……你也来找那本书？', line: 4 });
    expect(r.commands[6]).toMatchObject({ op: 'set', effect: { var: 'route', op: '=', value: 'lin' } });
    const choice = r.commands[8];
    if (choice?.op !== 'choice') throw new Error('应该是 choice');
    expect(choice.options.map((o) => o.label)).toEqual(['我是来找你的', '撬开锁', '离开']);
    expect(choice.options[0]?.set).toEqual([
      { var: 'affinity.char_lin', op: '+', value: 5 },
      { var: 'flags.met', op: '=', value: true },
    ]);
    expect(choice.options[0]?.body).toEqual([{ op: 'say', char: 'lin', text: '……找我？', line: 12 }]);
    expect(choice.options[1]?.check).toEqual({ id: 'lock', var: 'attr.wit', dc: 12, label: '撬开锁' });
    expect(choice.options[1]?.body[0]).toMatchObject({ op: 'if', cond: { check: 'pass' } });
    expect(choice.options[2]).toMatchObject({ if: { flag: 'flags.met' }, goto: 'sc_03' });
    expect(r.commands[9]).toMatchObject({ op: 'bgm', id: null });
  });

  it('编译成线性指令：选项和 if 变成跳转', () => {
    const p = compileScript(parseAdv(text).commands);
    const menu = p.ops.find((o) => o.k === 'menu');
    if (menu?.k !== 'menu') throw new Error('应该有 menu');
    expect(menu.options.map((o) => p.ops[o.body]?.k)).toEqual(['stage', 'br', 'jump']);
  });

  it('错误带行号，不认识的写法和字符串表达式都报错，其余行照常解析', () => {
    const r = parseAdv(
      [
        'bg library',
        'flyto moon',
        'choice',
        '  "a" if affinity.char_lin >= 50',
        '  "b" -> set x',
        '    narrate "ok"',
        '      narrate "缩进太深"',
        'if {"gte": ["a", "1"]}',
        '  narrate "x"',
        'else',
        'narrate "最后一行"',
      ].join('\n'),
    );
    expect(r.errors.map((e) => e.line)).toEqual([2, 4, 5, 8, 10]);
    expect(r.errors[1]?.message).toContain('JSON');
    expect(r.commands.map((c) => c.op)).toEqual(['bg', 'choice', 'narrate']);
  });
});

// ───────────── 结构检查 ─────────────

type SceneInput = z.input<typeof PlotGraph>['scenes'] extends (infer T)[] | undefined ? T : never;
const scene = (s: SceneInput) => s;
const graph = (scenes: SceneInput[], start = 'sc_01') => PlotGraph.parse({ start, scenes });

const messages = (r: { errors: { message: string; scene?: string }[] }) => r.errors.map((e) => `${e.scene ?? ''} ${e.message}`);

describe('结构检查（16.5）', () => {
  const good = graph([
    scene({
      id: 'sc_01',
      exits: [
        { to: 'sc_02', label: '帮忙', when: '答应' },
        { to: 'sc_03', label: '离开', when: '拒绝', if: { lt: ['affinity.char_lin', 20] } },
      ],
      default: 'sc_02',
    }),
    scene({ id: 'sc_02', ending: { kind: 'good' } }),
    scene({ id: 'sc_03', ending: { kind: 'bad' } }),
  ]);

  it('合格的剧情图没有错误也没有警告', () => {
    const r = checkPlot({ graph: good, variables: vars });
    expect(r).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it('起始幕、出口目标、死路、走不到的幕、走不到结局', () => {
    const r = checkPlot({
      graph: graph(
        [
          scene({ id: 'sc_01', exits: [{ to: 'sc_02' }, { to: 'sc_99' }] }),
          scene({ id: 'sc_02' }),
          scene({ id: 'sc_03', ending: {} }),
        ],
        'sc_00',
      ),
      variables: vars,
    });
    expect(messages(r)).toEqual(
      expect.arrayContaining([
        ' 起始幕 sc_00 不存在',
        'sc_01 出口 2（→ sc_99）指向不存在的幕',
        'sc_02 不是结局，却没有任何出口（死路）',
      ]),
    );
    const r2 = checkPlot({
      graph: graph([
        scene({ id: 'sc_01', exits: [{ to: 'sc_02' }] }),
        scene({ id: 'sc_02', exits: [{ to: 'sc_01' }] }),
        scene({ id: 'sc_03', ending: {} }),
      ]),
      variables: vars,
    });
    expect(messages(r2)).toEqual(['sc_03 从起始幕 sc_01 走不到这一幕', ' 从起始幕出发走不到任何结局']);
  });

  it('能走到结局但中途有一个绕不出去的圈', () => {
    const r = checkPlot({
      graph: graph([
        scene({ id: 'sc_01', exits: [{ to: 'sc_02', label: 'a', when: 'a' }, { to: 'sc_04', label: 'b', when: 'b' }] }),
        scene({ id: 'sc_02', exits: [{ to: 'sc_03' }] }),
        scene({ id: 'sc_03', exits: [{ to: 'sc_02' }] }),
        scene({ id: 'sc_04', ending: {} }),
      ]),
      variables: vars,
    });
    expect(messages(r)).toEqual([
      'sc_02 从这一幕出发走不到任何结局（会在几幕之间绕圈）',
      'sc_03 从这一幕出发走不到任何结局（会在几幕之间绕圈）',
    ]);
  });

  it('条件引用、值的类型、数量上限、minBeats、default、结局幕的出口', () => {
    const r = checkPlot({
      graph: graph([
        scene({
          id: 'sc_01',
          minBeats: 5,
          maxBeats: 3,
          points: Array.from({ length: 6 }, (_, i) => ({ id: `p_${i}`, text: 'x' })),
          exits: [
            { to: 'sc_02', if: { gte: ['nope', 1] } },
            { to: 'sc_02', if: { eq: ['affinity.char_lin', 'high'] } },
            { to: 'sc_02', if: { gt: ['route', 1] } },
            { to: 'sc_02', if: { flag: 'money' } },
            { to: 'sc_02', if: { visited: 'sc_42' }, set: [{ var: 'flags.met', op: '+', value: 1 }] },
          ],
          default: 'sc_09',
        }),
        scene({ id: 'sc_02', ending: {}, exits: [{ to: 'sc_01' }] }),
      ]),
      variables: vars,
    });
    expect(messages(r)).toEqual(
      expect.arrayContaining([
        'sc_01 要点有 6 条，最多 5 条',
        'sc_01 出口有 5 个，最多 4 个',
        'sc_01 minBeats（5）大于 maxBeats（3）',
        'sc_01 出口 1（→ sc_02）引用了不存在的变量 nope',
        'sc_01 出口 2（→ sc_02）拿 "high" 和 number 类型的变量 affinity.char_lin 比较',
        'sc_01 出口 3（→ sc_02）拿 1 和 string 类型的变量 route 比较',
        'sc_01 出口 4（→ sc_02）用 flag 读了不是布尔值的变量 money',
        'sc_01 出口 5（→ sc_02）引用了不存在的幕 sc_42',
        'sc_01 出口 5（→ sc_02）给 boolean 类型的变量 flags.met 设了 +1',
        'sc_01 default（sc_09）不是本幕的出口',
        'sc_02 结局幕不能有出口',
      ]),
    );
  });

  it('default 是兜底，不能带条件', () => {
    const r = checkPlot({
      graph: graph([
        scene({
          id: 'sc_01',
          exits: [
            { to: 'sc_02', label: 'a', when: 'a', if: { flag: 'flags.met' } },
            { to: 'sc_03', label: 'b', when: 'b' },
          ],
          default: 'sc_02',
        }),
        scene({ id: 'sc_02', ending: {} }),
        scene({ id: 'sc_03', ending: {} }),
      ]),
      variables: vars,
    });
    expect(messages(r)).toEqual(['sc_01 default 出口（→ sc_02）是兜底，不能带条件']);
  });

  it('警告：岔路缺 label / when、条件相同、不可能成立、只有一个结局、可能卡住、迁移来的文字条件', () => {
    const r = checkPlot({
      graph: PlotGraph.parse({
        start: 'sc_01',
        _meta: { generatedBy: 'migrate:outline-v1' },
        scenes: [
          scene({
            id: 'sc_01',
            exits: [
              { to: 'sc_02', if: { gte: ['affinity.char_lin', 120] } },
              { to: 'sc_02', label: 'b', when: 'b', if: { gte: ['affinity.char_lin', 120] } },
            ],
          }),
          scene({ id: 'sc_02', exits: [{ to: 'sc_03', when: '主角留下' }, { to: 'sc_03', auto: true }] }),
          scene({ id: 'sc_03', ending: {} }),
        ],
      }),
      variables: vars,
    });
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => `${w.scene ?? ''} ${w.message}`)).toEqual([
      'sc_01 出口 1（→ sc_02）的条件「林夕的好感 ≥ 120」不可能成立（范围 0～100）',
      'sc_01 出口 2（→ sc_02）的条件「林夕的好感 ≥ 120」不可能成立（范围 0～100）',
      'sc_01 岔路出口 → sc_02 缺少给玩家看的 label',
      'sc_01 岔路出口 → sc_02 缺少给导演看的 when',
      'sc_01 出口 → sc_02 和 → sc_02 的条件完全相同',
      'sc_01 所有出口都带条件也没有 default，条件都不成立时会卡在这一幕',
      'sc_02 出口 1（→ sc_03）的结局条件「主角留下」是从旧骨架迁移来的文字，只能交给导演判断，建议改成结构化条件',
      'sc_02 出口 2（→ sc_03）是 auto 出口但没有条件，进入这一幕后马上就会走',
      ' 有岔路却只有一个结局',
    ]);
  });

  it('手写剧本：解析错误、走到没声明的出口、不属于这一幕的要点、检定变量', () => {
    const r = checkPlot({
      graph: good,
      variables: vars,
      scripts: new Map([
        [
          'sc_01',
          parseAdv(
            [
              'lin "你好"',
              'nobody "我是谁"',
              'point sc_09_1',
              'choice',
              '  "a" check money dc 10 -> goto sc_02',
              '  "b" check route dc 10 -> goto sc_05',
              'flyto moon',
              'jump sc_03',
            ].join('\n'),
          ),
        ],
        ['sc_02', parseAdv('jump sc_01')],
      ]),
      characters: [{ id: 'char_lin', name: '林夕' }],
    });
    expect(r.errors.map((e) => `${e.scene}:${e.line} ${e.message}`)).toEqual([
      'sc_01:7 剧本：看不懂这一行：flyto moon',
      'sc_01:3 剧本：要点 sc_09_1 不属于这一幕',
      'sc_01:6 剧本：sc_05 不是这一幕声明过的出口',
      'sc_01:6 选项「b」的检定变量 route 不是数值',
      'sc_02:1 剧本：结局幕没有出口，不能走到 sc_01',
    ]);
    expect(r.warnings.map((w) => `${w.scene}:${w.line} ${w.message}`)).toEqual([
      'sc_01:2 剧本：角色 nobody 不在角色表里',
      'sc_01:5 选项「a」的检定变量 money 不是属性类（category: attribute）',
    ]);
  });
});

// ───────────── 换幕规则 ─────────────

describe('换幕由引擎决定（16.2）', () => {
  const fork = PlotGraph.parse({
    start: 'sc_01',
    scenes: [
      {
        id: 'sc_01',
        minBeats: 2,
        maxBeats: 4,
        exits: [
          { to: 'sc_02', label: '帮忙', when: '答应' },
          { to: 'sc_03', label: '离开', when: '拒绝', if: { flag: 'flags.met' } },
          { to: 'sc_04', auto: true, if: { lt: ['affinity.char_lin', 10] } },
        ],
        default: 'sc_02',
      },
      { id: 'sc_05', minBeats: 2, maxBeats: 3, exits: [{ to: 'sc_02' }] },
    ],
  }).scenes;
  const sc01 = fork[0] as PlotScene;
  const single = fork[1] as PlotScene;
  const c = (over: Partial<ConditionContext['vars']> = {}): ConditionContext => ({
    vars: { 'affinity.char_lin': 30, 'flags.met': false, ...over },
    visited: new Set(['sc_01']),
    check: null,
  });
  const decide = (o: Partial<Parameters<typeof decideTransition>[0]> & { report: Parameters<typeof decideTransition>[0]['report'] }) =>
    decideTransition({ scene: sc01, mode: 'adv', beats: 3, ctx: c(), ...o });

  it('auto 出口条件成立就直接走，不管导演说了什么；回复被截断时不走', () => {
    const report = { by: 'director' as const, done: true, exit: 'sc_02', playerAction: true };
    expect(decide({ ctx: c({ 'affinity.char_lin': 5 }), report }).exit).toMatchObject({ to: 'sc_04', by: 'auto' });
    expect(decide({ ctx: c({ 'affinity.char_lin': 5 }), report: { ...report, truncated: true } }).exit?.to).toBe('sc_02');
  });

  it('导演的请求要演满 minBeats、出口要声明过且条件成立', () => {
    const early = decide({ beats: 1, report: { by: 'director', done: true, exit: 'sc_02', playerAction: true } });
    expect(early.exit).toBeUndefined();
    expect(early.notes.join()).toContain('至少要演 2 拍');
    expect(decide({ report: { by: 'director', done: false, exit: 'sc_03', playerAction: true } }).notes.join()).toContain('条件不成立');
    expect(decide({ report: { by: 'director', done: false, exit: 'sc_04', playerAction: true } }).notes.join()).toContain('不是这一幕可以选的出口');
    expect(decide({ report: { by: 'director', done: false, exit: 'sc_02', playerAction: true } }).exit).toMatchObject({ to: 'sc_02', by: 'director' });
  });

  it('ADV 模式的岔路只能由玩家决定：没有玩家行动时驳回导演，弹出选项', () => {
    const t = decide({ report: { by: 'director', done: true, exit: 'sc_02', playerAction: false } });
    expect(t.exit).toBeUndefined();
    expect(t.notes.join()).toContain('岔路只能由玩家决定');
    expect(t.menu?.options).toEqual([
      { label: '帮忙', enabled: true },
      { label: '离开', enabled: false, lockedBy: 'flags.met' },
    ]);
    // 观察模式没有这条限制
    expect(decide({ mode: 'observer', report: { by: 'director', done: true, exit: 'sc_02', playerAction: false } }).exit?.to).toBe('sc_02');
  });

  it('演满 maxBeats：ADV 的岔路弹出选项，观察模式走 default；只有一条路就直接走', () => {
    const report = { by: 'director' as const, done: false, playerAction: false };
    expect(decide({ beats: 4, report }).menu).toBeDefined();
    expect(decide({ beats: 4, mode: 'observer', report }).exit).toMatchObject({ to: 'sc_02', by: 'default' });
    expect(decide({ beats: 3, mode: 'observer', report: { ...report, done: true } })).toMatchObject({ mustChoose: true });
    expect(decideTransition({ scene: single, mode: 'adv', beats: 3, ctx: c(), report }).exit).toMatchObject({ to: 'sc_02', by: 'default' });
    expect(decideTransition({ scene: single, mode: 'adv', beats: 2, ctx: c(), report }).exit).toBeUndefined();
  });

  it('剧本作者的 jump 不受 minBeats 限制', () => {
    expect(decide({ beats: 1, report: { by: 'script', done: false, exit: 'sc_02', playerAction: false } }).exit).toMatchObject({
      to: 'sc_02',
      by: 'script',
    });
  });
});
