import type { ChatMessage } from '@auto-adv/providers';
import type { Character, ObserverSettings } from '@auto-adv/schema';
import { z } from 'zod';
import type { PlayEvent } from '../../api.ts';
import { renderOutline } from '../../genesis/prompts.ts';
import { list, required, text } from '../../genesis/specs.ts';
import type { JsonSpec } from '../../llm/structured.ts';
import { clip, renderBrief, renderCharacter, renderLocation, renderRelationships } from '../../world/render.ts';
import type { WorldData } from '../../world/store.ts';
import { BUDGET, selectLore, transcriptOf } from '../context.ts';
import type { StoryState } from '../state.ts';

// ───────────── 导演 ─────────────

export const DirectorOut = z.object({
  plan: required,
  location: text.default(''),
  present: list,
  time: text.default(''),
  speakers: z
    .array(z.object({ name: required, intent: text.default('') }))
    .catch([])
    .default([]),
  completeBeats: list,
  reveals: z
    .array(z.object({ owner: required, to: list }))
    .catch([])
    .default([]),
});
export type DirectorOut = z.infer<typeof DirectorOut>;

export const directorSpec: JsonSpec<DirectorOut> = {
  name: 'director_plan',
  schema: DirectorOut,
  example: {
    plan: '这一拍要发生什么（40～100 字）：具体的事件、冲突或转折，以及它怎么推动剧情',
    location: '这一拍发生的地点名（不换地点就填当前地点）',
    present: ['这一拍在场的角色名'],
    time: '时间推进了才填，例如：当晚十点；不推进就留空',
    speakers: [{ name: '这一拍开口或行动的角色名，按顺序', intent: '他这一拍想做什么、想说什么' }],
    completeBeats: ['这一拍演完后达成的骨架节拍 id（只能是当前章节里还没完成的）'],
    reveals: [{ owner: '秘密的主人', to: ['这一拍得知这个秘密的角色名'] }],
  },
};

export const DIRECTOR_SYSTEM = `你是一部持续上演的互动故事的导演。你看得到一切：剧情骨架、所有角色的秘密、到目前为止发生的事。
你的工作是决定"下一拍"发生什么。一拍是一个小场面：几句对话、一个动作、一次小转折，大约 200～400 字的戏。
原则：
- 按剧情骨架推进，但不要急：一个节拍可以用几拍来铺垫，确实演到了才标记完成。
- 每一拍都要有变化：新信息、关系变化、决定、意外。不要让角色原地打转、重复说过的话。
- 控制节奏：紧张和舒缓交替，适时换场景、推进时间。
- 让角色按自己的目标和性格行动，利用他们之间的张力和秘密。秘密要慢慢揭开，揭开时在 reveals 里写明。
- 观众给的导演指令要尽量满足，同时保持故事合理。`;

export interface DirectorInput {
  world: WorldData;
  state: StoryState;
  settings: ObserverSettings;
  memory: string | null;
  recent: PlayEvent[];
  protagonist: Character | null;
  warnings: string[];
  card: string | null;
  rejected: string[];
  whispers: PlayEvent[];
}

export function directorPrompt(p: DirectorInput): string {
  const { world, state, protagonist } = p;
  const pName = protagonist?.name ?? '主角';
  const location = world.locations.find((l) => l.id === state.scene.locationId);
  const present = world.characters.filter((c) => state.scene.presentCharacterIds.includes(c.id)).map((c) => c.name);
  const parts = [
    `# 世界\n${world.brief ? renderBrief(world.manifest, world.brief, world.style) : world.manifest.title}`,
    `# 世界观（节选）\n${clip(world.worldview.trim(), 1500)}`,
    `# 角色（全部信息，包括秘密）\n${world.characters.map((c) => renderCharacter(c)).join('\n\n')}`,
    `# 角色关系\n${renderRelationships(world.characters) || '（无）'}`,
    `# 地点\n${world.locations.map((l) => renderLocation(l)).join('\n')}`,
    state.outline
      ? `# 剧情骨架（[x] 是已完成的节拍）\n${renderOutline(state.outline, state.done)}\n\n当前章节：${
          state.currentChapter ? `[${state.currentChapter.id}] ${state.currentChapter.title}：${state.currentChapter.goal}` : '（全部完成）'
        }`
      : '# 剧情骨架\n（没有骨架，自由发展）',
    p.settings.focus === 'protagonist'
      ? `# 视角\n故事围绕${pName}展开。没有玩家，${pName}也由演员扮演，和其他角色一样主动行动。`
      : '# 视角\n群像剧：没有固定的主角，轮流聚焦不同的角色，让每个人都有自己的故事线。',
    p.memory ? `# 前情提要\n${p.memory}` : '',
    `# 最近发生的事\n${transcriptOf(world, p.recent, pName) || '（刚刚开场）'}`,
    `# 现在\n地点：${location?.name ?? '未指定'}；在场：${present.join('、') || '无'}${state.time ? `；时间：${state.time}` : ''}`,
  ];
  if (state.directives.length) {
    parts.push(`# 观众的导演指令（尽量满足）\n${state.directives.map((d) => `- ${d.text}`).join('\n')}`);
  }
  if (p.whispers.length) {
    const lines = p.whispers.map((w) => {
      const who = world.characters.find((c) => c.id === w.characterId)?.name ?? '某个角色';
      return `- 对${who}：${w.text}`;
    });
    parts.push(`# 观众对角色说的悄悄话（只有该角色自己听得到，可能影响他的行动）\n${lines.join('\n')}`);
  }
  if (p.rejected.length) parts.push(`# 上一拍被驳回的安排（请避免）\n${p.rejected.map((r) => `- ${r}`).join('\n')}`);
  if (p.warnings.length || p.card) {
    parts.push(
      `# 注意\n${p.warnings.map((w) => `- ${w}`).join('\n')}${p.card ? `\n- 这一拍必须用上这张事件卡来打破僵局：「${p.card}」` : ''}`,
    );
  }
  parts.push('请安排下一拍。');
  return parts.filter(Boolean).join('\n\n');
}

// ───────────── 合并模式：一次写出整拍 ─────────────

export function writerSystem(
  world: WorldData,
  state: StoryState,
  memory: string | null,
  knowledge: Record<string, string>,
  pName = '主角',
) {
  const location = world.locations.find((l) => l.id === state.scene.locationId);
  const present = world.characters.filter((c) => state.scene.presentCharacterIds.includes(c.id));
  const absent = world.characters.filter((c) => !state.scene.presentCharacterIds.includes(c.id));
  const parts = [
    `你是一部持续上演的互动故事的「演员兼旁白」。没有玩家，所有角色都由你来演，导演会告诉你每一拍要演什么。

# 输出格式（必须严格遵守）
- 角色说话：单独一行，以【角色名】开头，动作和神态写在台词前的括号里。例如：【${present[0]?.name ?? '角色名'}】（抬起头）你来晚了。
- 旁白：不带任何前缀的行，用第三人称（开场里如果有「你」，指的是${pName}）。
- 200～400 字，把导演安排的这一拍完整演出来，然后停下。
- 角色只能说出他们知道的事；秘密要藏在言行的细节里，导演没安排揭开就不要说破。
- 不要重复之前说过的话，不要写任何说明、标题或括号外的旁注。`,
  ];
  if (world.brief) parts.push(`# 世界\n${renderBrief(world.manifest, world.brief, world.style)}`);
  if (world.worldview.trim()) parts.push(`# 世界观\n${clip(world.worldview.trim(), BUDGET.worldview)}`);
  parts.push(`# 在场角色\n${present.map((c) => renderCharacter(c)).join('\n\n') || '（无）'}`);
  if (absent.length) parts.push(`# 其他角色（不在场）\n${absent.map((c) => renderCharacter(c, 'short')).join('\n')}`);
  const rel = renderRelationships(world.characters);
  if (rel) parts.push(`# 角色关系\n${rel}`);
  parts.push(`# 当前场景\n${location ? renderLocation(location) : '- （未指定地点）'}${state.time ? `\n时间：${state.time}` : ''}`);
  if (memory) parts.push(`# 前情提要\n${memory}`);
  const know = world.characters.filter((c) => knowledge[c.id]).map((c) => `- ${c.name}：${knowledge[c.id]}`);
  if (know.length) parts.push(`# 各角色目前知道的事\n${know.join('\n')}`);
  return parts.join('\n\n');
}

export function beatInstruction(world: WorldData, plan: DirectorOut, card: string | null): string {
  const lines = [`［导演安排］${plan.plan}`];
  if (plan.time) lines.push(`［时间］${plan.time}`);
  if (plan.speakers.length) {
    lines.push(`［出场顺序］\n${plan.speakers.map((s) => `- ${s.name}${s.intent ? `：${s.intent}` : ''}`).join('\n')}`);
  }
  if (card) lines.push(`［事件卡］${card}`);
  for (const r of plan.reveals) lines.push(`［这一拍揭开秘密］${r.owner}的秘密被${r.to.join('、')}知道了`);
  return lines.join('\n');
}

export function writerMessages(
  world: WorldData,
  state: StoryState,
  memory: string | null,
  knowledge: Record<string, string>,
  recent: PlayEvent[],
  instruction: string,
  pName: string,
): ChatMessage[] {
  const lore = selectLore(world.lore, `${transcriptOf(world, recent.slice(-4), pName)}\n${instruction}`);
  const user = [
    `［最近发生的事］\n${transcriptOf(world, recent, pName) || '（刚刚开场）'}`,
    lore.length ? `［相关设定，供参考］\n${lore.map((e) => `- ${e.title}：${e.content}`).join('\n')}` : '',
    instruction,
    '请演出这一拍。',
  ]
    .filter(Boolean)
    .join('\n\n');
  return [
    { role: 'system', content: writerSystem(world, state, memory, knowledge, pName) },
    { role: 'user', content: user },
  ];
}

// ───────────── 分演模式：旁白 + 各个演员 ─────────────

export function narratorMessages(world: WorldData, state: StoryState, plan: DirectorOut, card: string | null, recent: string) {
  const location = world.locations.find((l) => l.id === state.scene.locationId);
  const system = `你是互动故事的旁白。用第三人称写这一拍开头的叙述：环境、氛围、人物的动作和神态。
- 1～2 段，60～180 字。不写任何台词（台词由演员负责）。
- 文风：${world.style?.prose.description || '简洁、有画面感'}
- 只输出叙述正文。`;
  const user = [
    `［地点］${location ? `${location.name}：${location.description}` : '未指定'}${state.time ? `\n［时间］${state.time}` : ''}`,
    `［最近发生的事］\n${recent || '（刚刚开场）'}`,
    beatInstruction(world, plan, card),
    '请写这一拍的开头叙述。',
  ].join('\n\n');
  return [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: user },
  ];
}

export interface ActorInput {
  world: WorldData;
  me: Character;
  state: StoryState;
  /** 这个角色视角的记忆。 */
  knowledge: string;
  /** 这个角色亲眼见到的最近的事。 */
  witnessed: string;
  /** 这一拍到目前为止的内容。 */
  sofar: string;
  intent: string;
  whispers: string[];
  /** 别人告诉过他的秘密。 */
  knownSecrets: string[];
}

export function actorMessages(p: ActorInput): ChatMessage[] {
  const { world, me, state } = p;
  const location = world.locations.find((l) => l.id === state.scene.locationId);
  const others = world.characters.filter((c) => c.id !== me.id);
  const myRel = me.relationships
    .map((r) => `- ${world.characters.find((c) => c.id === r.to)?.name ?? r.to}：${r.type}`)
    .join('\n');
  const system = [
    `你是演员，在一部互动故事里扮演「${me.name}」。你只知道${me.name}知道的事，只替${me.name}说话和行动。
输出格式：一段话，动作和神态写在括号里，例如：（攥紧衣角）……我不知道你在说什么。
- 1～3 句，符合${me.name}的性格和说话方式；可以撒谎、隐瞒、试探，但不要说出${me.name}不可能知道的事。
- 不要替别人说话，不要写旁白，不要加名字前缀。`,
    world.brief ? `# 世界\n${renderBrief(world.manifest, world.brief, world.style)}` : '',
    `# 你扮演的角色\n${renderCharacter(me)}`,
    myRel ? `# 你和别人的关系\n${myRel}` : '',
    `# 你认识的人（只知道表面）\n${others.map((c) => `- ${c.name}：${c.summary}`).join('\n')}`,
    p.knownSecrets.length ? `# 别人的秘密（你已经知道了）\n${p.knownSecrets.map((s) => `- ${s}`).join('\n')}` : '',
    p.knowledge ? `# 你记得的事\n${p.knowledge}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const user = [
    `［你最近经历的事］\n${p.witnessed || '（刚刚开场）'}`,
    `［现在］${location?.name ?? '某处'}${state.time ? `，${state.time}` : ''}`,
    p.whispers.length ? `［你心里的声音］\n${p.whispers.map((w) => `- ${w}`).join('\n')}` : '',
    `［刚才］\n${p.sofar || '（这一拍刚开始）'}`,
    p.intent ? `［导演对你的提示］${p.intent}` : '',
    `轮到${me.name}了。`,
  ]
    .filter(Boolean)
    .join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// ───────────── 续写新篇章 ─────────────

export function arcPrompt(world: WorldData, state: StoryState, memory: string | null, recent: string): string {
  return `# 世界
${world.brief ? renderBrief(world.manifest, world.brief, world.style) : world.manifest.title}

# 角色
${world.characters.map((c) => renderCharacter(c, 'short')).join('\n')}

# 地点
${world.locations.map((l) => renderLocation(l, 'short')).join('\n')}

# 已经演完的篇章
${state.outline ? renderOutline(state.outline, state.done) : '（无）'}

# 前情提要
${memory ?? '（无）'}

# 最近发生的事
${recent}

已有的剧情骨架全部演完了，但故事还要继续。请根据现在的局面设计下一个篇章：
- 2～4 章，每章一个清晰的戏剧目标和 3～4 个关键节拍。
- 从当前局面自然生长出新的冲突：可以引入新的威胁、新的谜团、关系的新阶段，回收或延续还没解决的伏笔。
- 不要重复已经演过的情节。`;
}

// ───────────── 角色视角的记忆 ─────────────

export const MemoryOut = z.object({
  summary: required,
  characters: z
    .array(z.object({ name: required, knows: text.default('') }))
    .catch([])
    .default([]),
});
export type MemoryOut = z.infer<typeof MemoryOut>;

export const memorySpec: JsonSpec<MemoryOut> = {
  name: 'story_memory',
  schema: MemoryOut,
  example: {
    summary: '全知视角的前情提要（不超过 800 字）',
    characters: [{ name: '角色名', knows: '这个角色亲身经历或被告知的事、对别人的看法（不超过 200 字）' }],
  },
};

export function memoryPrompt(
  world: WorldData,
  protagonist: Character | null,
  previous: { text: string; characters: Record<string, string> } | null,
  events: PlayEvent[],
) {
  const pName = protagonist?.name ?? '主角';
  const prevChars = world.characters
    .filter((c) => previous?.characters[c.id])
    .map((c) => `- ${c.name}：${previous?.characters[c.id]}`);
  const system =
    '你是互动故事的书记员，负责整理「前情提要」和每个角色各自的记忆，让后续的写作保持连贯。只根据给出的内容整理，不要编造。';
  const user = `# 角色
${world.characters.map((c) => `- ${c.name}`).join('\n')}

# 之前的前情提要
${previous?.text ?? '（无，故事刚开始）'}

# 之前各角色的记忆
${prevChars.join('\n') || '（无）'}

# 新发生的剧情
${transcriptOf(world, events, pName)}

请整合成新的记忆：
- summary：全知视角的前情提要，不超过 800 字。按时间顺序概括关键事件；记下人物关系和态度的变化、做出的承诺、得到的线索和物品、尚未解决的问题；最后一句说明现在所处的地点和状况。
- characters：每个出场过的角色一条，只写这个角色亲眼看到、亲耳听到或被别人告诉的事，以及他现在对别人的看法和打算，不超过 200 字。角色不在场时发生的事，他不知道。`;
  return { system, user };
}
