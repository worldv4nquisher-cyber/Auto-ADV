import { type Character, GENESIS_PRESETS, type GenesisPresetId, type Location, type LoreEntry } from '@auto-adv/schema';
import type { GenesisOptions } from '../api.ts';
import type { FixedItem } from '../world/locks.ts';
import { clip, ratingText, renderBrief, renderCharacter, renderLocation, renderRelationships } from '../world/render.ts';
import type { WorldData } from '../world/store.ts';
import { GRAPH_RULES } from './graph.ts';

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

// ───────────── 锁住的内容、这次的要求（20.4） ─────────────

/** 已经定了的内容：原样交给模型，模型写回来以后引擎还会再盖一遍。 */
export function fixedText(items: readonly FixedItem[], intro = '这些已经定了，照着写（原样放进对应的字段，不要改），其余的围绕它们来写：'): string {
  if (!items.length) return '';
  return `\n${intro}\n${items.map((x) => `- ${x.label}：${x.value}`).join('\n')}`;
}

/** 重抽时附的一句说明。 */
export function noteText(note?: string): string {
  return note?.trim() ? `\n这次重写的要求：${note.trim()}` : '';
}

/** 字段表：[路径, 给模型看的名称, 自定义的写法]。锁住的字段按这张表列出来。 */
export type FieldTable = readonly (readonly [string, string, ((v: unknown) => string)?])[];

export const CHARACTER_FIELDS = (all: readonly Character[]): FieldTable => [
  ['name', '名字'],
  ['aliases', '别称'],
  ['role', '定位（role）'],
  ['gender', '性别'],
  ['age', '年龄'],
  ['summary', '一句话介绍'],
  ['appearance.text', '外貌'],
  ['appearance.imagePrompt', '画立绘用的外貌描述'],
  ['personality.traits', '性格特点'],
  ['personality.values', '看重的东西'],
  ['personality.fears', '害怕的东西'],
  ['speech.style', '说话方式'],
  ['speech.examples', '台词例句'],
  ['background', '经历'],
  ['goals', '目标'],
  ['secrets', '秘密'],
  [
    'relationships',
    '关系',
    (v) =>
      (v as Character['relationships'])
        .map((r) => `${all.find((c) => c.id === r.to)?.name ?? r.to}：${r.type}`)
        .join('；'),
  ],
];

/** 模型能写的角色字段（全锁了就不用重写这个角色）。 */
export const CHARACTER_MODEL_FIELDS = CHARACTER_FIELDS([]).map(([p]) => p);

export const LOCATION_FIELDS = (all: readonly Location[]): FieldTable => [
  ['name', '名字'],
  ['description', '描述'],
  ['connections', '连着的地点', (v) => (v as string[]).map((id) => all.find((l) => l.id === id)?.name ?? id).join('、')],
];
export const LOCATION_MODEL_FIELDS = LOCATION_FIELDS([]).map(([p]) => p);

export const LORE_FIELDS: FieldTable = [
  ['title', '条目名'],
  ['category', '分类'],
  ['content', '正文'],
  ['keys', '触发词'],
];
export const LORE_MODEL_FIELDS = LORE_FIELDS.map(([p]) => p);

/** 重抽一整步时已经有、要留下的实体（20.4 的表）：整个锁住的原样留下，部分锁住的补全没锁的字段。 */
export interface KeepPlan<T> {
  full: T[];
  partial: { item: T; fixed: FixedItem[] }[];
  /** 还要写几个新的（最少、最多）。 */
  fresh: [number, number];
}

function keptBlock<T extends { id: string }>(plan: KeepPlan<T>, what: string, render: (x: T) => string): string {
  const parts: string[] = [`# 已经定了的${what}`];
  for (const x of plan.full) parts.push(`${render(x)}\n（整个定了，原样保留，不用再写）`);
  for (const { item, fixed } of plan.partial) {
    parts.push(
      `## 要补全的${what}（id：${item.id}）\n写进输出时 id 填 ${item.id}。下面这些已经定了，照抄（不要改），其余字段重新写：\n${fixed
        .map((f) => `- ${f.label}：${f.value}`)
        .join('\n')}`,
    );
  }
  return parts.join('\n\n');
}

function freshText([min, max]: [number, number]): string {
  return min === max ? `${min}` : `${min}～${max}`;
}

export function briefPrompt({ seed, preset, options }: SeedInput, fixed: readonly FixedItem[] = [], note?: string): string {
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
  return parts.join('\n') + fixedText(fixed) + noteText(note);
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

export function worldviewPrompt(d: WorldData, o: GenesisOptions, note?: string): string {
  return `${briefOf(d)}

请写出这个世界的世界观正文，用 Markdown，800～1500 字，包含以下小节：
## 概况
## 历史
## 社会与势力
## 规则（魔法、科技、超自然或社会规则，按题材取舍）
## 当前局势
要求：具体、可以直接用来讲故事；埋下 2～3 个能发展成剧情的矛盾或谜团。直接输出正文，不要写前言和总结。${extraNotes(o)}${noteText(note)}`;
}

export function castPrompt(d: WorldData, o: GenesisOptions, plan?: KeepPlan<Character> & { total: number }, note?: string): string {
  const n = Math.max(1, Math.min(8, o.characterCount ?? 3));
  const protagonist = [o.protagonistName && `名字是「${o.protagonistName}」`, o.protagonistDescription]
    .filter(Boolean)
    .join('，');
  const common = `- 其他角色要个性鲜明、说话方式各不相同，各有自己的目标，最好各有一个秘密。
- 角色之间要有张力：爱慕、竞争、误会、利益冲突……relationships 里的 to 填其他角色的名字。${extraNotes(o)}${noteText(note)}`;
  if (!plan || (!plan.full.length && !plan.partial.length)) {
    return `${briefOf(d)}

${worldviewOf(d, 4000)}

请设计这个故事的角色：1 个主角，加上 ${n} 个其他角色，一共 ${n + 1} 个。
- 主角由玩家扮演，role 填 protagonist，放在第一个。${protagonist ? `主角设定：${protagonist}。` : ''}主角的性格可以留一些空白，给玩家代入的空间，但身份和处境要清楚，并且和故事的核心冲突直接相关。
${common}`;
  }
  const keptAll = [...plan.full, ...plan.partial.map((p) => p.item)];
  const hasProtagonist = keptAll.some((c) => c.role === 'protagonist');
  const fresh = plan.fresh[0];
  return `${briefOf(d)}

${worldviewOf(d, 4000)}

${keptBlock(plan, '角色', (c) => renderCharacter(c))}

请设计这个故事的角色：一共 ${plan.total} 个（含主角），上面已经定了的 ${keptAll.length} 个算在内。
- characters 里写${plan.partial.length ? `上面要补全的 ${plan.partial.length} 个（id 照填）` : ''}${plan.partial.length && fresh ? '，' : ''}${fresh ? `另外再写 ${fresh} 个新角色（id 留空）` : ''}；整个定了的不要再写。
- ${hasProtagonist ? '主角已经定了，新角色的 role 不要填 protagonist。' : `主角由玩家扮演，role 填 protagonist。${protagonist ? `主角设定：${protagonist}。` : ''}`}
- 新角色要和已经定了的角色有关系、有张力，不要和他们重复。
${common}`;
}

export function locationsPrompt(d: WorldData, o: GenesisOptions, plan?: KeepPlan<Location>, note?: string): string {
  if (!plan || (!plan.full.length && !plan.partial.length)) {
    return `${briefOf(d)}

${worldviewOf(d, 4000)}

请列出故事主要发生的 4～6 个地点。第一个地点是故事开始的地方。每个地点都要有鲜明的氛围，并且适合发生对话和事件。${extraNotes(o)}${noteText(note)}`;
  }
  const kept = plan.full.length + plan.partial.length;
  return `${briefOf(d)}

${worldviewOf(d, 4000)}

${keptBlock(plan, '地点', (l) => renderLocation(l))}

请列出故事主要发生的地点，一共 4～6 个，上面已经定了的 ${kept} 个算在内。
- locations 里写${plan.partial.length ? `上面要补全的 ${plan.partial.length} 个（id 照填）` : ''}${plan.partial.length && plan.fresh[1] ? '，' : ''}${plan.fresh[1] ? `另外再写 ${freshText(plan.fresh)} 个新地点（id 留空）` : ''}；整个定了的不要再写。
- 每个地点都要有鲜明的氛围，并且适合发生对话和事件；connections 可以写已经定了的地点。${extraNotes(o)}${noteText(note)}`;
}

export function lorePrompt(d: WorldData, o: GenesisOptions, plan?: KeepPlan<LoreEntry>, note?: string): string {
  const kept = plan ? plan.full.length + plan.partial.length : 0;
  const ask = !plan || !kept
    ? '请整理 8～12 条设定集条目。'
    : `${keptBlock(plan, '设定条目', (e) => `## ${e.title}\n${e.content}`)}

请整理设定集条目，一共 8～12 条，上面已经定了的 ${kept} 条算在内。entries 里写${plan.partial.length ? `上面要补全的 ${plan.partial.length} 条（id 照填）` : ''}${plan.partial.length && plan.fresh[1] ? '，' : ''}${plan.fresh[1] ? `另外再写 ${freshText(plan.fresh)} 条新的（id 留空），不要和已经有的重复` : ''}；整个定了的不要再写。`;
  return `${briefOf(d)}

${worldviewOf(d, 5000)}

# 角色
${d.characters.map((c) => renderCharacter(c, 'short')).join('\n')}

# 地点
${d.locations.map((l) => renderLocation(l, 'short')).join('\n')}

${ask}对话时，引擎会在对话里出现 keys 中的词时把这条设定交给演员参考。
- 每条 content 50～200 字，自成一体。
- keys 是对话里可能出现的词：专有名词、别称、简称，2～5 个。
- 只有最核心、每一幕都必须知道的世界规则才把 always 设为 true（不超过 2 条）。
- 不要为角色本身建条目（角色另有角色卡），但可以写角色所属的组织、物品、事件。${extraNotes(o)}${noteText(note)}`;
}

/** 剧情图的规模：按简报里的篇幅。 */
const GRAPH_SIZE: Record<string, string> = {
  short: '5～7 幕（含 2 个结局），2 章',
  medium: '8～12 幕（含 2～3 个结局），2～3 章',
  long: '12～16 幕（含 3～4 个结局），3～4 章',
  endless: '8～12 幕（含 2～3 个结局），2～3 章（之后观察模式会接着续写新的篇章）',
};

/** 角色名和 id 的对照（变量 id 里用角色 id）。 */
export function castIds(d: Pick<WorldData, 'characters'>): string {
  return d.characters.map((c) => `- ${c.id}：${c.name}${c.role === 'protagonist' ? '（主角，玩家扮演）' : ''}`).join('\n');
}

export function plotPrompt(d: WorldData, o: GenesisOptions, fixedVariables = false, note?: string): string {
  const vars = fixedVariables
    ? `- variables 已经定了，只能用下面这些（variables 字段原样照抄）：
${d.variables.map((v) => `  - ${v.id}（${v.label}，${v.type === 'boolean' ? '开关' : `数值${v.min !== undefined || v.max !== undefined ? ` ${v.min ?? ''}～${v.max ?? ''}` : ''}`}，初始 ${String(v.initial)}）`).join('\n') || '  （没有数值）'}`
    : `- variables：2～5 个数值或标记。关系类（category: relationship）用 0～100，id 写成 affinity.<角色 id> 或 trust.<角色 id>；
  属性类（category: attribute）是检定时的修正值，范围 -2～5，比如 skill.insight；标记用 boolean，比如 flag.found_log。`;
  return `${briefOf(d)}

${worldviewOf(d, 3000)}

# 角色
${d.characters.map((c) => renderCharacter(c)).join('\n\n')}

# 角色 id
${castIds(d)}

# 角色关系
${renderRelationships(d.characters) || '（无）'}

# 地点
${d.locations.map((l) => renderLocation(l)).join('\n')}

请设计这个故事的剧情图。
${GRAPH_RULES}

这一次的要求：
- 规模：${GRAPH_SIZE[d.brief?.length ?? 'medium'] ?? GRAPH_SIZE.medium}。至少有一处让玩家做选择的岔路，不同的选择和数值通往不同的结局。
${vars}
- 充分利用角色的目标、秘密和彼此之间的张力，让每个重要角色都有自己的戏份。埋下 2～4 条伏笔，写明在哪一幕回收。
- 第一幕要能在开场后马上展开。${extraNotes(o)}${noteText(note)}`;
}

export function openingPrompt(d: WorldData, o: GenesisOptions, fixed: readonly FixedItem[] = [], note?: string): string {
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
${openingPlotHint(d)}
请设计故事的开场场景。
- location 必须是上面的地点之一；present 是在场的其他角色（不含主角），1～3 个。
- narration 是开场叙述，200～400 字，用第二人称「你」指代主角${protagonist ? `${protagonist.name}` : ''}：交代时间、地点、氛围和主角的处境，以一个需要主角回应的钩子收尾。
- lines 是在场角色的 1～3 句台词，最后一句最好直接对主角说，让玩家自然地接话。
- 不要替主角说话或做决定。${extraNotes(o)}${fixedText(fixed, '开场里这些已经定了，照着写（原样放进对应的字段，不要改）：')}${noteText(note)}`;
}

function openingPlotHint(d: WorldData): string {
  const g = d.graph;
  const sc = g?.scenes.find((s) => s.id === g.start);
  if (!sc) return '';
  const points = sc.points.map((p) => `- ${p.text}`).join('\n');
  return `\n# 第一幕\n「${sc.title || sc.id}」：${sc.what}${points ? `\n要点：\n${points}` : ''}\n开场要自然地引向这一幕，但不要提前把要点演完。\n`;
}

// ───────────── 只重写一个角色、地点、设定条目或者一个字段（20.4） ─────────────

function rewriteAsk(note: string | undefined, what: string): string {
  return note?.trim()
    ? `按这次的要求改写${what}：${note.trim()}`
    : `重新构思${what}，写一个和原来不一样的版本`;
}

export function characterPrompt(d: WorldData, c: Character, fixed: readonly FixedItem[], note?: string): string {
  const others = d.characters.filter((x) => x.id !== c.id);
  return `${briefOf(d)}

${worldviewOf(d, 3000)}

# 其他角色
${others.map((x) => renderCharacter(x, 'short')).join('\n') || '（没有）'}

# 要重写的角色（原来的样子）
${renderCharacter(c)}

请${rewriteAsk(note, '这一个角色')}。${c.role === 'protagonist' ? '这是主角，由玩家扮演，role 填 protagonist。' : '他不是主角，role 不要填 protagonist。'}
- 要和其他角色、世界观对得上；relationships 里的 to 填其他角色的名字。${fixedText(fixed)}`;
}

export function locationPrompt(d: WorldData, l: Location, fixed: readonly FixedItem[], note?: string): string {
  const others = d.locations.filter((x) => x.id !== l.id);
  return `${briefOf(d)}

${worldviewOf(d, 3000)}

# 其他地点
${others.map((x) => renderLocation(x)).join('\n') || '（没有）'}

# 要重写的地点（原来的样子）
${renderLocation(l)}

请${rewriteAsk(note, '这一个地点')}。connections 填其他地点的名字。${fixedText(fixed)}`;
}

export function loreEntryPrompt(d: WorldData, e: LoreEntry, fixed: readonly FixedItem[], note?: string): string {
  const others = d.lore.filter((x) => x.id !== e.id);
  return `${briefOf(d)}

${worldviewOf(d, 3000)}

# 角色
${d.characters.map((c) => renderCharacter(c, 'short')).join('\n')}

# 地点
${d.locations.map((l) => renderLocation(l, 'short')).join('\n')}

# 其他设定条目
${others.map((x) => `- ${x.title}`).join('\n') || '（没有）'}

# 要重写的设定条目（原来的样子）
## ${e.title}
${e.content}

请${rewriteAsk(note, '这一条设定')}。content 50～200 字，自成一体；keys 是对话里可能出现的词，2～5 个；不要和其他条目重复。${fixedText(fixed)}`;
}

/** 只重写一个字段：context 是这块内容给模型看的样子。直接输出新的文字。 */
export function fieldPrompt(d: WorldData, context: string, label: string, current: string, note?: string): string {
  const brief = d.brief ? `${briefOf(d)}\n\n` : '';
  const view = d.worldview.trim() ? `${worldviewOf(d, 2000)}\n\n` : '';
  return `${brief}${view}${context}

请只重写「${label}」这一项：${note?.trim() ? `要求：${note.trim()}` : '写一个和现在不一样的版本'}。
现在写的是：
${current.trim() || '（空）'}

长度和现在差不多，和上面的内容对得上。直接输出新的内容，不要加引号、标题和解释。`;
}
