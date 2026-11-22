import type { ChatMessage } from '@auto-adv/providers';
import type { Character, LoreEntry } from '@auto-adv/schema';
import type { PlayEvent, SceneState, Segment } from '../api.ts';
import { clip, renderBrief, renderCharacter, renderLocation, renderRelationships } from '../world/render.ts';
import type { WorldData } from '../world/store.ts';
import { segmentsToText } from './script.ts';

/** 上下文预算（按字数）。中文一个字大约一个 token，留足余量给小上下文的模型。 */
export const BUDGET = {
  worldview: 2500,
  lore: 3000,
  history: 12000,
};

export function protagonistOf(world: WorldData, id: string | null): Character | null {
  return world.characters.find((c) => c.id === id) ?? world.characters.find((c) => c.role === 'protagonist') ?? null;
}

/** 当前场景 = 路径上最后一个带场景信息的事件。 */
export function sceneAt(path: PlayEvent[]): SceneState {
  for (let i = path.length - 1; i >= 0; i--) {
    const s = path[i]?.scene;
    if (s) return s;
  }
  return { locationId: null, presentCharacterIds: [] };
}

/** 事件的纯文本（给模型看的记录）。world 用于把玩家事件里的角色 id 换成名字。 */
export function eventText(e: PlayEvent, protagonistName: string, world?: WorldData): string {
  if (e.kind === 'player') {
    const who = (e.characterId && world?.characters.find((c) => c.id === e.characterId)?.name) || protagonistName;
    return `${who}：${e.text ?? ''}`;
  }
  if (e.kind === 'scene' || e.kind === 'directive' || e.kind === 'whisper') return '';
  return (e.segments ?? []).map((s: Segment) => (s.kind === 'line' ? `${s.name}：${s.text}` : s.text)).join('\n');
}

/**
 * 设定集关键词触发：always 条目总是带上；keyword 条目在最近的对话里出现任一关键词时带上。
 * 按优先级、再按命中的关键词数排序，超出预算的丢掉。
 */
export function selectLore(lore: LoreEntry[], recentText: string, budget = BUDGET.lore): LoreEntry[] {
  const hay = recentText.toLowerCase();
  const scored = lore
    .map((e) => {
      const hits = e.keys.filter((k) => k.trim() && hay.includes(k.trim().toLowerCase())).length;
      return { e, hits, on: e.activation === 'always' || hits > 0 };
    })
    .filter((x) => x.on)
    .sort((a, b) => b.e.priority - a.e.priority || b.hits - a.hits);
  const out: LoreEntry[] = [];
  let used = 0;
  for (const { e } of scored) {
    const size = e.title.length + e.content.length;
    if (used + size > budget && out.length) continue;
    out.push(e);
    used += size;
  }
  return out;
}

export interface BuildContextParams {
  world: WorldData;
  protagonist: Character | null;
  scene: SceneState;
  /** 前情提要（覆盖了 history 之前的全部内容）。 */
  memory: string | null;
  /** 摘要之后的原始事件，最后一个可能是玩家输入。 */
  history: PlayEvent[];
}

export function systemPrompt(p: BuildContextParams): string {
  const { world, protagonist, scene } = p;
  const pName = protagonist?.name ?? '主角';
  const present = world.characters.filter((c) => scene.presentCharacterIds.includes(c.id) && c.id !== protagonist?.id);
  const absent = world.characters.filter((c) => !scene.presentCharacterIds.includes(c.id) && c.id !== protagonist?.id);
  const location = world.locations.find((l) => l.id === scene.locationId);
  const parts = [
    `你是一个互动故事中的「演员兼旁白」。玩家扮演${pName}，你扮演其他所有角色，并用旁白描写环境、动作和氛围。

# 输出格式（必须严格遵守）
- 角色说话：单独一行，以【角色名】开头，动作和神态写在台词前的括号里。例如：【${present[0]?.name ?? '角色名'}】（抬起头）你来晚了。
- 旁白：不带任何前缀的行。用第二人称「你」指代${pName}。
- 绝对不要替${pName}说话、行动、思考或做决定，不要写【${pName}】。
- 每次回复 1～5 段，大约 100～400 字；推进一点剧情，然后把机会交还给玩家。
- 在场角色按各自的性格、目标和说话方式行动，不必每人都开口；不在场的角色可以登场，但要先用旁白交代。
- 只输出故事内容，不要写任何说明、标题或括号外的旁注。`,
  ];
  if (world.brief) parts.push(`# 世界\n${renderBrief(world.manifest, world.brief, world.style)}`);
  if (world.worldview.trim()) parts.push(`# 世界观\n${clip(world.worldview.trim(), BUDGET.worldview)}`);
  if (protagonist) parts.push(`# 玩家扮演的角色\n${renderCharacter(protagonist)}`);
  parts.push(
    `# 在场角色\n${present.length ? present.map((c) => renderCharacter(c)).join('\n\n') : '（暂时没有其他角色在场）'}`,
  );
  if (absent.length) parts.push(`# 其他角色（不在场）\n${absent.map((c) => renderCharacter(c, 'short')).join('\n')}`);
  const rel = renderRelationships(world.characters);
  if (rel) parts.push(`# 角色关系\n${rel}`);
  parts.push(
    `# 当前场景\n${location ? renderLocation(location) : '- （未指定地点）'}${
      world.locations.length > 1
        ? `\n其他地点：${world.locations
            .filter((l) => l !== location)
            .map((l) => l.name)
            .join('、')}`
        : ''
    }`,
  );
  if (p.memory) parts.push(`# 前情提要\n${p.memory}`);
  return parts.join('\n\n');
}

/** 一组事件的文字记录（含换场景、时间推进），给导演和书记看。 */
export function transcriptOf(world: WorldData, events: PlayEvent[], protagonistName: string): string {
  return events
    .map((e) => {
      if (e.kind === 'scene' && e.scene) return sceneNote(world, e.scene);
      const head = [
        e.beat?.time ? `［时间］${e.beat.time}` : '',
        e.kind === 'ai' && e.scene ? sceneNote(world, e.scene) : '',
      ]
        .filter(Boolean)
        .join('\n');
      const body = eventText(e, protagonistName, world);
      return [head, body].filter(Boolean).join('\n');
    })
    .filter(Boolean)
    .join('\n');
}

export function sceneNote(world: WorldData, s: SceneState): string {
  const loc = world.locations.find((l) => l.id === s.locationId)?.name ?? '未指定';
  const names = world.characters.filter((c) => s.presentCharacterIds.includes(c.id)).map((c) => c.name);
  return `［场景切换］地点：${loc}；在场：${names.join('、') || '无'}`;
}

/** 合并相邻的同角色消息（有些接口要求用户和助手交替出现）。 */
function mergeAdjacent(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === m.role && m.role !== 'system') last.content = `${last.content}\n\n${m.content}`;
    else out.push({ ...m });
  }
  return out;
}

/**
 * 拼装一次回复的完整上下文。顺序按"越稳定越靠前"，方便服务商做前缀缓存：
 * 系统提示（规则、世界、角色、前情提要）→ 历史对话 → 最后一条用户消息（触发的设定 + 玩家行动）。
 */
export function buildMessages(p: BuildContextParams): ChatMessage[] {
  const pName = p.protagonist?.name ?? '主角';
  const history = [...p.history];
  const last = history[history.length - 1];
  const pending = last?.kind === 'player' ? (history.pop() as PlayEvent) : null;

  // 历史超出预算时，从最旧的开始丢（至少保留最近 2 条）
  let used = 0;
  let start = history.length;
  while (start > 0) {
    const size = eventText(history[start - 1] as PlayEvent, pName, p.world).length;
    if (used + size > BUDGET.history && history.length - start >= 2) break;
    used += size;
    start--;
  }
  const kept = history.slice(start);

  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt(p) }];
  messages.push({ role: 'user', content: start > 0 || p.memory ? '（接着前情提要继续）' : '（故事开始）' });
  for (const e of kept) {
    if (e.kind === 'player') {
      // 接管过别的角色时，标明是谁说的
      const other = e.characterId && e.characterId !== p.protagonist?.id;
      messages.push({ role: 'user', content: other ? eventText(e, pName, p.world) : (e.text ?? '') });
    }
    else if (e.kind === 'scene' && e.scene) messages.push({ role: 'user', content: sceneNote(p.world, e.scene) });
    else if (e.segments?.length) messages.push({ role: 'assistant', content: segmentsToText(e.segments) });
  }

  const recent = [...kept.slice(-4), ...(pending ? [pending] : [])].map((e) => eventText(e, pName, p.world)).join('\n');
  const lore = selectLore(p.world.lore, recent);
  const finalParts: string[] = [];
  if (lore.length) finalParts.push(`［相关设定，供参考］\n${lore.map((e) => `- ${e.title}：${e.content}`).join('\n')}`);
  if (pending) finalParts.push(`［${pName}的行动］\n${pending.text ?? ''}`);
  else finalParts.push(`［${pName}暂时没有行动。请让在场角色自然地把剧情往前推进一小段，然后把机会交还给${pName}。］`);
  messages.push({ role: 'user', content: finalParts.join('\n\n') });
  return mergeAdjacent(messages);
}

export function summaryPrompt(world: WorldData, protagonist: Character | null, previous: string | null, events: PlayEvent[]) {
  const pName = protagonist?.name ?? '主角';
  const transcript = transcriptOf(world, events, pName);
  const system = '你是互动故事的书记员，负责整理「前情提要」，让后续的写作保持连贯。只根据给出的内容整理，不要编造。';
  const user = `# 角色
${world.characters.map((c) => `- ${c.name}${c.id === protagonist?.id ? '（玩家扮演的主角）' : ''}`).join('\n')}

# 之前的前情提要
${previous ?? '（无，故事刚开始）'}

# 新发生的剧情
${transcript}

请把「之前的前情提要」和「新发生的剧情」整合成一份新的前情提要，不超过 800 字：
- 按时间顺序概括关键事件；
- 记下人物关系和态度的变化、做出的承诺、得到的线索和物品、尚未解决的问题；
- 最后一句说明现在所处的地点和状况。
只输出前情提要正文。`;
  return { system, user };
}
