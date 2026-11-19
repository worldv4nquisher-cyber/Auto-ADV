import type { Character, Location, StyleGuide, WorldBrief, WorldManifest } from '@auto-adv/schema';

/** 把世界内容渲染成给模型看的文本。创世和游玩共用。 */

const RATING_TEXT: Record<WorldBrief['rating'], string> = {
  all: '全年龄：不写血腥、暴力细节和性内容',
  teen: '青少年向：可以有冒险、轻度暴力和情感纠葛，不写露骨内容',
  mature: '成人向：可以写黑暗、暴力题材，但要服务于故事',
};

export function ratingText(rating: WorldBrief['rating']): string {
  return RATING_TEXT[rating];
}

/** 文本截断到 max 个字，超出时在末尾标注。 */
export function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max).join('')}……（后略）`;
}

export function renderBrief(m: WorldManifest, b: WorldBrief, style?: StyleGuide | null): string {
  const lines = [
    `标题：${m.title}`,
    `一句话简介：${b.logline || m.logline}`,
    `题材：${b.genre}`,
    b.tone && `基调：${b.tone}`,
    b.era && `时代：${b.era}`,
    b.themes.length ? `主题：${b.themes.join('、')}` : '',
    `内容分级：${ratingText(b.rating)}`,
    style?.prose.description && `文风：${style.prose.description}`,
  ];
  return lines.filter(Boolean).join('\n');
}

export function renderCharacter(c: Character, detail: 'full' | 'short' = 'full'): string {
  const head = [c.name, c.aliases.length ? `（又名${c.aliases.join('、')}）` : '', c.gender && ` ${c.gender}`, c.age && ` ${c.age}`]
    .filter(Boolean)
    .join('');
  if (detail === 'short') return `- ${head}：${c.summary}`;
  const p = c.personality;
  const lines = [
    `## ${head}`,
    c.summary,
    c.appearance.text && `外貌：${c.appearance.text}`,
    p.traits.length ? `性格：${p.traits.join('、')}` : '',
    p.values.length ? `看重：${p.values.join('、')}` : '',
    p.fears.length ? `害怕：${p.fears.join('、')}` : '',
    c.speech.style && `说话方式：${c.speech.style}`,
    c.speech.examples.length ? `台词示例：${c.speech.examples.map((e) => `「${e}」`).join(' ')}` : '',
    c.background && `经历：${c.background}`,
    c.goals.length ? `目标：${c.goals.map((g) => g.text).join('；')}` : '',
    c.secrets.length ? `秘密（不会轻易说出口）：${c.secrets.map((s) => s.text).join('；')}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

export function renderRelationships(chars: Character[]): string {
  const byId = new Map(chars.map((c) => [c.id, c.name]));
  const out: string[] = [];
  for (const c of chars) {
    for (const r of c.relationships) {
      const to = byId.get(r.to);
      if (to) out.push(`- ${c.name} → ${to}：${r.type}${r.affinity ? `（好感 ${r.affinity}）` : ''}`);
    }
  }
  return out.join('\n');
}

export function renderLocation(l: Location, detail: 'full' | 'short' = 'full'): string {
  return detail === 'short' ? `- ${l.name}` : `- ${l.name}：${l.description}`;
}

/** 名字匹配：先比全名和别称，再比包含关系。用来把模型输出里的名字对应到实体 id。 */
export function matchByName<T extends { name: string; aliases?: string[] }>(name: string, items: T[]): T | undefined {
  const norm = (s: string) => s.replace(/[\s·・.。]/g, '').toLowerCase();
  const n = norm(name);
  if (!n) return undefined;
  const exact = items.find((i) => norm(i.name) === n || (i.aliases ?? []).some((a) => norm(a) === n));
  if (exact) return exact;
  return items.find((i) => {
    const m = norm(i.name);
    return m.length >= 2 && n.length >= 2 && (m.includes(n) || n.includes(m));
  });
}
