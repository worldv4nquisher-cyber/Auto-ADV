import { Character } from '@auto-adv/schema';
import { z } from 'zod';
import type { PlayEvent } from '../api.ts';
import { list, required, text } from '../genesis/specs.ts';
import type { JsonSpec } from '../llm/structured.ts';
import { maxIdNumber } from '../plot/progress.ts';
import { isExtraName } from '../plot/stage.ts';
import { matchByName, renderBrief } from '../world/render.ts';
import type { WorldData } from '../world/store.ts';

/**
 * 临时人物（18.5）：AI 演出时导演安排的路人、守卫、伙计，世界里没有这个角色。
 * 上台时用剪影（plot/stage.ts）；同一个人在一个周目里开口满几拍（设置，默认 3），就让模型补一张角色卡，升级成正式角色，
 * 之后素材管线给他画立绘、配音时分配音色。模型认出他其实是已有的角色（换了个叫法）时，只把这个叫法加进那个角色的别称。
 */

export interface ExtraInfo {
  name: string;
  /** 开口的拍数（一拍里说几句都算一拍）。 */
  beats: number;
  /** 说过的话（最多 8 句）。 */
  lines: string[];
  /** 导演安排里提到他的地方（最多 4 条）。 */
  plans: string[];
  /** 最后一次开口时的地点。 */
  locationId: string | null;
}

/** 路径上开口过的临时人物：名字对不上世界里的角色（包括别称）、是一个具体的人。按第一次开口的顺序。 */
export function extrasOf(path: readonly PlayEvent[], characters: readonly Character[]): ExtraInfo[] {
  const found = new Map<string, ExtraInfo>();
  let location: string | null = null;
  for (const e of path) {
    if (e.scene) location = e.scene.locationId;
    if (e.kind !== 'ai') continue;
    const here = new Set<string>();
    for (const s of e.segments ?? []) {
      if (s.kind !== 'line' || s.characterId || !isExtraName(s.name)) continue;
      const name = s.name.trim();
      if (matchByName(name, [...characters])) continue;
      const info = found.get(name) ?? { name, beats: 0, lines: [], plans: [], locationId: null };
      if (!here.has(name)) {
        here.add(name);
        info.beats += 1;
        if (e.beat?.plan.includes(name) && info.plans.length < 4) info.plans.push(e.beat.plan);
      }
      if (info.lines.length < 8) info.lines.push(s.text);
      info.locationId = location;
      found.set(name, info);
    }
  }
  return [...found.values()];
}

/** 模型写的角色卡。sameAs：其实是已有的哪个角色（换了个叫法）；不是就留空。 */
export const ExtraOut = z.object({
  sameAs: text.default(''),
  gender: text.default(''),
  age: text.default(''),
  summary: required,
  appearance: required,
  imagePrompt: text.default(''),
  traits: list,
  speech: text.default(''),
});
export type ExtraOut = z.infer<typeof ExtraOut>;

export const extraSpec: JsonSpec<ExtraOut> = {
  name: 'extra_character',
  schema: ExtraOut,
  example: {
    sameAs: '如果这个人其实就是「已有角色」里的某一个（只是换了个叫法），写那个角色的名字；不是就留空',
    gender: '男 / 女 / 其他',
    age: '年龄，例如 40 多岁',
    summary: '一句话：他是谁、在故事里是什么身份（20～50 字）',
    appearance: '外貌描述：长相、发型、体型、衣着（40～100 字）',
    imagePrompt: '画立绘用的外貌提示词：性别、年龄、发型发色、服装、标志性的特征，用逗号隔开',
    traits: ['性格特点', '两三个'],
    speech: '说话方式（一句话）',
  },
};

export function extraPrompt(world: WorldData, x: ExtraInfo): string {
  const loc = world.locations.find((l) => l.id === x.locationId);
  return [
    `# 世界\n${world.brief ? renderBrief(world.manifest, world.brief, world.style) : world.manifest.title}`,
    `# 已有角色\n${world.characters.map((c) => `- ${c.name}${c.aliases.length ? `（也叫${c.aliases.join('、')}）` : ''}：${c.summary || c.role}`).join('\n')}`,
    `# 这个人\n名字：${x.name}${loc ? `\n出现的地点：${loc.name}` : ''}`,
    x.plans.length ? `# 导演安排里提到他的地方\n${x.plans.map((p) => `- ${p}`).join('\n')}` : '',
    `# 他说过的话\n${x.lines.map((l) => `- ${l}`).join('\n')}`,
    `# 要做的事\n「${x.name}」是演出时临时出场的人物，已经出场好几次了，要把他升级成这个世界的正式角色。按他说过的话和出场的情境，补一张简短的角色卡：外貌要具体，能直接拿去画立绘；不要编造和已有剧情冲突的身份。
如果他其实就是「已有角色」里的某一个（只是换了个叫法，比如用职业称呼），在 sameAs 里写那个角色的名字，其他字段照常填。`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * 模型写的角色卡转成世界里的变化：sameAs 对上了已有角色，就把这个叫法加进那个角色的别称（alias）；
 * 否则新建一个 npc 角色（id 接着往后编号）。
 */
export function extraCharacter(
  world: Pick<WorldData, 'characters'>,
  x: ExtraInfo,
  out: ExtraOut,
): { kind: 'alias'; character: Character } | { kind: 'new'; character: Character } {
  const same = out.sameAs.trim() ? matchByName(out.sameAs, [...world.characters]) : undefined;
  if (same) {
    const aliases = same.aliases.includes(x.name) ? same.aliases : [...same.aliases, x.name];
    return { kind: 'alias', character: { ...same, aliases } };
  }
  const id = `char_${String(maxIdNumber(world.characters, 'char') + 1).padStart(2, '0')}`;
  const character = Character.parse({
    id,
    name: x.name,
    role: 'npc',
    gender: out.gender,
    age: out.age,
    summary: out.summary,
    appearance: { text: out.appearance, imagePrompt: out.imagePrompt },
    personality: { traits: out.traits },
    speech: { style: out.speech, examples: x.lines.slice(0, 2) },
  });
  return { kind: 'new', character };
}
