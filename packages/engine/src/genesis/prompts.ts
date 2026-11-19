import { GENESIS_PRESETS, type GenesisPresetId } from '@auto-adv/schema';
import type { GenesisOptions } from '../api.ts';
import { clip, ratingText, renderBrief, renderCharacter, renderLocation, renderRelationships } from '../world/render.ts';
import type { WorldData } from '../world/store.ts';

export const GENESIS_SYSTEM = `你是一位经验丰富的视觉小说、文字冒险游戏编剧，也是世界观设计师。
你在为一个由 AI 驱动的互动故事应用创作世界：玩家会进入这个世界，和其中的角色自由对话、经历故事。
要求：
- 一律使用简体中文。
- 具体、有画面感，能直接拿来讲故事；少用空泛的形容词和套话，避免俗套设定。
- 处处留下冲突、悬念和人物之间的张力，让故事有东西可演。
- 名字要有特色，并且符合这个世界的风格。`;

/** 没有种子时随机抽几个灵感词，避免每次都生成差不多的世界。 */
const INSPIRATIONS = [
  '灯塔', '失落的信', '雨季', '契约', '钟表', '旧照片', '列车', '面具', '海底', '雪原', '图书馆', '双胞胎',
  '遗产', '流星', '禁忌之歌', '人偶', '药剂师', '废墟', '花园', '剧团', '赌约', '迷宫', '月蚀', '集市',
  '机械心脏', '狐狸', '浮空岛', '旅馆', '最后一天', '盲眼画家', '无人车站', '樱花', '沙漠', '记忆交易', '墨水', '星图',
];

function pick<T>(arr: readonly T[], n: number): T[] {
  const copy = [...arr];
  const out: T[] = [];
  while (out.length < n && copy.length) out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0] as T);
  return out;
}

export interface SeedInput {
  seed: string;
  preset?: GenesisPresetId;
  options: GenesisOptions;
}

export function briefPrompt({ seed, preset, options }: SeedInput): string {
  const presetPrompt = GENESIS_PRESETS.find((p) => p.id === preset)?.prompt ?? '';
  const parts = ['请为一个新的互动故事世界写一份世界简报。'];
  if (seed.trim()) parts.push(`玩家给出的灵感：${seed.trim()}`);
  if (presetPrompt) parts.push(`题材方向：${presetPrompt}`);
  if (!seed.trim() && !presetPrompt) {
    parts.push(`玩家没有给出灵感，请自由构思一个新颖、有趣、适合互动故事的世界。可以从这几个词里找灵感（不必全用）：${pick(INSPIRATIONS, 3).join('、')}`);
  }
  if (options.protagonistName || options.protagonistDescription) {
    parts.push(`主角（玩家扮演）：${[options.protagonistName, options.protagonistDescription].filter(Boolean).join('，')}`);
  }
  parts.push(`内容分级：${ratingText(options.rating ?? 'teen')}`);
  if (options.notes?.trim()) parts.push(`其他要求：${options.notes.trim()}`);
  return parts.join('\n');
}

function briefOf(d: WorldData): string {
  if (!d.brief) throw new Error('缺少世界简报，请先生成简报');
  return `# 世界简报\n${renderBrief(d.manifest, d.brief, d.style)}`;
}

function worldviewOf(d: WorldData, max: number): string {
  if (!d.worldview.trim()) throw new Error('缺少世界观，请先生成世界观');
  return `# 世界观\n${clip(d.worldview.trim(), max)}`;
}

function extraNotes(o: GenesisOptions): string {
  return o.notes?.trim() ? `\n其他要求：${o.notes.trim()}` : '';
}

export function worldviewPrompt(d: WorldData, o: GenesisOptions): string {
  return `${briefOf(d)}

请写出这个世界的世界观正文，用 Markdown，800～1500 字，包含以下小节：
## 概况
## 历史
## 社会与势力
## 规则（魔法、科技、超自然或社会规则，按题材取舍）
## 当前局势
要求：具体、可以直接用来讲故事；埋下 2～3 个能发展成剧情的矛盾或谜团。直接输出正文，不要写前言和总结。${extraNotes(o)}`;
}

export function castPrompt(d: WorldData, o: GenesisOptions): string {
  const n = Math.max(1, Math.min(8, o.characterCount ?? 3));
  const protagonist = [o.protagonistName && `名字是「${o.protagonistName}」`, o.protagonistDescription]
    .filter(Boolean)
    .join('，');
  return `${briefOf(d)}

${worldviewOf(d, 4000)}

请设计这个故事的角色：1 个主角，加上 ${n} 个其他角色，一共 ${n + 1} 个。
- 主角由玩家扮演，role 填 protagonist，放在第一个。${protagonist ? `主角设定：${protagonist}。` : ''}主角的性格可以留一些空白，给玩家代入的空间，但身份和处境要清楚，并且和故事的核心冲突直接相关。
- 其他角色要个性鲜明、说话方式各不相同，各有自己的目标，最好各有一个秘密。
- 角色之间要有张力：爱慕、竞争、误会、利益冲突……relationships 里的 to 填其他角色的名字。${extraNotes(o)}`;
}

export function locationsPrompt(d: WorldData, o: GenesisOptions): string {
  return `${briefOf(d)}

${worldviewOf(d, 4000)}

请列出故事主要发生的 4～6 个地点。第一个地点是故事开始的地方。每个地点都要有鲜明的氛围，并且适合发生对话和事件。${extraNotes(o)}`;
}

export function lorePrompt(d: WorldData, o: GenesisOptions): string {
  return `${briefOf(d)}

${worldviewOf(d, 5000)}

# 角色
${d.characters.map((c) => renderCharacter(c, 'short')).join('\n')}

# 地点
${d.locations.map((l) => renderLocation(l, 'short')).join('\n')}

请整理 8～12 条设定集条目。对话时，引擎会在对话里出现 keys 中的词时把这条设定交给演员参考。
- 每条 content 50～200 字，自成一体。
- keys 是对话里可能出现的词：专有名词、别称、简称，2～5 个。
- 只有最核心、每一幕都必须知道的世界规则才把 always 设为 true（不超过 2 条）。
- 不要为角色本身建条目（角色另有角色卡），但可以写角色所属的组织、物品、事件。${extraNotes(o)}`;
}

export function openingPrompt(d: WorldData, o: GenesisOptions): string {
  const protagonist = d.characters.find((c) => c.role === 'protagonist');
  const others = d.characters.filter((c) => c !== protagonist);
  return `${briefOf(d)}

${worldviewOf(d, 2500)}

# 主角（玩家扮演）
${protagonist ? renderCharacter(protagonist) : '（未设定）'}

# 其他角色
${others.map((c) => renderCharacter(c)).join('\n\n')}

# 角色关系
${renderRelationships(d.characters) || '（无）'}

# 地点
${d.locations.map((l) => renderLocation(l)).join('\n')}

请设计故事的开场场景。
- location 必须是上面的地点之一；present 是在场的其他角色（不含主角），1～3 个。
- narration 是开场叙述，200～400 字，用第二人称「你」指代主角${protagonist ? `${protagonist.name}` : ''}：交代时间、地点、氛围和主角的处境，以一个需要主角回应的钩子收尾。
- lines 是在场角色的 1～3 句台词，最后一句最好直接对主角说，让玩家自然地接话。
- 不要替主角说话或做决定。${extraNotes(o)}`;
}
