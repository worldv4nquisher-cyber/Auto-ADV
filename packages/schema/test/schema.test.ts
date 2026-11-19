import { describe, expect, it } from 'vitest';
import { AppSettings, Character, FORMAT_VERSION, LoreEntry, migrate } from '../src/index.ts';

describe('原生格式 v0', () => {
  it('角色只填必填项时补齐默认值', () => {
    const c = Character.parse({ id: 'char_lin', name: '林夕' });
    expect(c.formatVersion).toBe(FORMAT_VERSION);
    expect(c.role).toBe('npc');
    expect(c.expressions).toEqual(['neutral']);
    expect(c._meta.locked).toEqual([]);
  });

  it('拒绝不合规的 id', () => {
    expect(() => Character.parse({ id: 'Char-Lin', name: 'x' })).toThrow();
  });

  it('设定集条目默认关键词触发、公开', () => {
    const l = LoreEntry.parse({ id: 'lore_a', title: 'A', content: '...' });
    expect(l.activation).toBe('keyword');
    expect(l.knownBy).toBe('public');
  });

  it('应用设置可以从空对象解析', () => {
    expect(AppSettings.parse({})).toEqual({ formatVersion: 0, endpoints: [], roles: {} });
  });
});

describe('migrate', () => {
  it('当前版本原样返回，并保留未知字段', () => {
    expect(migrate({ formatVersion: 0, foo: 1 })).toEqual({ formatVersion: 0, foo: 1 });
  });

  it('来自更新版本的文件给出提示', () => {
    expect(() => migrate({ formatVersion: 999 })).toThrow(/升级应用/);
  });
});
