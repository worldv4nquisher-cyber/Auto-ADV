import type { LoreEntry } from '@auto-adv/schema';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { castSpec, openingSpec } from '../src/genesis/specs.ts';
import { extractJson } from '../src/llm/structured.ts';
import { selectLore } from '../src/play/context.ts';
import { parseScript, ScriptStream, segmentsToText } from '../src/play/script.ts';

const cast = [
  { id: 'char_02', name: '林夕', aliases: ['小夕'] },
  { id: 'char_03', name: '白鸦' },
];
const protagonist = { id: 'char_01', name: '沈默' };

describe('回复解析', () => {
  it('识别台词、旁白、别称和冒号写法，丢掉替主角写的台词', () => {
    const text = [
      '雨停了。',
      '',
      '【林夕】（抬头）你来了。',
      '【小夕】又是我。',
      '白鸦：哼。',
      '【沈默】我替玩家说话了',
      '「这句也是主角的」',
      '【神秘人】……',
      '时间：午夜', // 不是已知角色，按旁白处理
    ].join('\n');
    expect(parseScript(text, { cast, protagonist })).toEqual([
      { kind: 'narration', text: '雨停了。' },
      { kind: 'line', characterId: 'char_02', name: '林夕', text: '（抬头）你来了。' },
      { kind: 'line', characterId: 'char_02', name: '林夕', text: '又是我。' },
      { kind: 'line', characterId: 'char_03', name: '白鸦', text: '哼。' },
      { kind: 'line', characterId: null, name: '神秘人', text: '……' },
      { kind: 'narration', text: '时间：午夜' },
    ]);
  });

  it('兼容 Markdown 强调和引号包住的台词', () => {
    expect(parseScript('**林夕**：「走吧。」\n*她转身离开*\n［白鸦］“等等”', { cast })).toEqual([
      { kind: 'line', characterId: 'char_02', name: '林夕', text: '走吧。' },
      { kind: 'narration', text: '（她转身离开）' },
      { kind: 'line', characterId: 'char_03', name: '白鸦', text: '等等' },
    ]);
  });

  it('名字单独一行时，台词取下一行；去掉 <think>', () => {
    expect(parseScript('<think>想一想</think>\n【林夕】\n好。', { cast })).toEqual([
      { kind: 'line', characterId: 'char_02', name: '林夕', text: '好。' },
    ]);
    expect(parseScript('<think>还在想', { cast })).toEqual([]);
  });

  it('流式解析：没写完的【名字】先不出现，最终结果和整体解析一致', () => {
    const s = new ScriptStream({ cast, protagonist });
    const full = '风很大。\n【林夕】走吧。\n【白鸦】等等。';
    const seen: string[] = [];
    for (const piece of ['风很', '大。\n【林', '夕】走', '吧。\n【白鸦】等等。']) {
      for (const c of s.push(piece)) seen.push(`${c.index}:${c.seg.kind}:${c.seg.text}`);
    }
    expect(seen).not.toContain('1:narration:【林');
    expect(seen).toContain('1:line:走');
    expect(s.finish()).toEqual(parseScript(full, { cast, protagonist }));
    expect(segmentsToText(s.finish())).toBe(full);
  });
});

describe('JSON 提取', () => {
  it('兼容代码块、前后多余文字、结尾逗号、思考标签', () => {
    expect(extractJson('好的：\n```json\n{"a": [1, 2,],}\n```\n希望有帮助')).toEqual({ a: [1, 2] });
    expect(extractJson('<think>{"x":1}</think>{"b": "含 } 的字符串"}')).toEqual({ b: '含 } 的字符串' });
    expect(() => extractJson('{"a": ')).toThrow('不完整');
    expect(() => extractJson('没有')).toThrow('没有 JSON');
  });

  it('宽松校验：列表写成字符串、数字写成字符串都能接受', () => {
    const r = castSpec.schema.parse({
      characters: [{ name: '林夕', traits: '温柔、固执', age: 17, relationships: [{ to: '白鸦', type: '宿敌', affinity: '-30' }] }],
    });
    expect(r.characters[0]).toMatchObject({ traits: ['温柔', '固执'], age: '17', role: 'npc' });
    expect(r.characters[0]?.relationships[0]?.affinity).toBe(-30);
  });

  it('能转换成 JSON Schema（json_schema 模式用）', () => {
    const s = z.toJSONSchema(openingSpec.schema, { io: 'input', unrepresentable: 'any' }) as { properties: object };
    expect(Object.keys(s.properties)).toEqual(['location', 'present', 'narration', 'lines']);
    expect(() => z.toJSONSchema(castSpec.schema, { io: 'input', unrepresentable: 'any' })).not.toThrow();
  });
});

describe('设定集触发', () => {
  const entry = (id: string, keys: string[], extra: Partial<LoreEntry> = {}): LoreEntry => ({
    formatVersion: 0,
    id,
    title: id,
    content: '内容'.repeat(10),
    category: 'general',
    keys,
    activation: 'keyword',
    scope: 'global',
    priority: 50,
    knownBy: 'public',
    _meta: { locked: [] },
    ...extra,
  });

  it('always 总是带上，关键词命中才带上，按优先级排序，超预算丢弃', () => {
    const lore = [
      entry('a', ['灯塔']),
      entry('b', ['酒馆']),
      entry('c', [], { activation: 'always', priority: 100 }),
      entry('d', ['Lamp']),
    ];
    expect(selectLore(lore, '我们去灯塔看看 lamp').map((e) => e.id)).toEqual(['c', 'a', 'd']);
    expect(selectLore(lore, '灯塔', 30).map((e) => e.id)).toEqual(['c']);
  });
});
