import { CharacterRole } from '@auto-adv/schema';
import { z } from 'zod';
import type { JsonSpec } from '../llm/structured.ts';

/**
 * 创世各步骤要求模型输出的结构。故意写得宽松：
 * 模型常把列表写成一个字符串、把数字写成字符串，这些都在这里兼容掉，而不是让整步失败。
 */

const text = z.preprocess((v) => (v === null || v === undefined ? '' : typeof v === 'string' ? v : String(v)), z.string());
const required = z.preprocess((v) => (typeof v === 'number' ? String(v) : v), z.string().trim().min(1));
const list = z
  .preprocess(
    (v) =>
      typeof v === 'string'
        ? v
            .split(/[、，,；;\n]/)
            .map((s) => s.trim())
            .filter(Boolean)
        : v === null || v === undefined
          ? []
          : v,
    z.array(z.preprocess((v) => (typeof v === 'string' ? v : JSON.stringify(v)), z.string())),
  )
  .default([]);

// ───────────── 简报 ─────────────

export const BriefOut = z.object({
  title: required,
  logline: required,
  genre: required,
  tone: text.default(''),
  era: text.default(''),
  themes: list,
  proseStyle: text.default(''),
});
export type BriefOut = z.infer<typeof BriefOut>;

export const briefSpec: JsonSpec<BriefOut> = {
  name: 'world_brief',
  schema: BriefOut,
  example: {
    title: '世界名（2～8 个字，有记忆点）',
    logline: '一句话简介（30～60 字），点出主角的处境和核心冲突',
    genre: '题材，例如：蒸汽朋克悬疑',
    tone: '基调，例如：压抑中带着温情',
    era: '时代与科技水平',
    themes: ['主题1', '主题2', '主题3'],
    proseStyle: '文风要求（50～100 字）：句子长短、描写侧重、对话风格等',
  },
};

// ───────────── 角色 ─────────────

const RoleOut = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v),
  CharacterRole.catch('npc'),
);

export const CharacterOut = z.object({
  name: required,
  aliases: list,
  role: RoleOut.default('npc'),
  gender: text.default(''),
  age: text.default(''),
  summary: text.default(''),
  appearance: text.default(''),
  traits: list,
  values: list,
  fears: list,
  speechStyle: text.default(''),
  speechExamples: list,
  background: text.default(''),
  goals: list,
  secret: text.default(''),
  relationships: z
    .array(
      z.object({
        to: required,
        type: text.default(''),
        affinity: z.coerce.number().min(-100).max(100).catch(0).default(0),
      }),
    )
    .catch([])
    .default([]),
});
export type CharacterOut = z.infer<typeof CharacterOut>;

export const CastOut = z.object({ characters: z.array(CharacterOut).min(1) });
export type CastOut = z.infer<typeof CastOut>;

export const castSpec: JsonSpec<CastOut> = {
  name: 'world_cast',
  schema: CastOut,
  example: {
    characters: [
      {
        name: '角色名',
        aliases: ['别称或昵称'],
        role: 'protagonist / heroine / hero / rival / antagonist / mentor / npc 之一',
        gender: '性别',
        age: '年龄或年龄段',
        summary: '一句话介绍（20～40 字）',
        appearance: '外貌与衣着（40～80 字）',
        traits: ['性格特点1', '性格特点2', '性格特点3'],
        values: ['看重的东西'],
        fears: ['害怕的东西'],
        speechStyle: '说话方式：口癖、用词、语气',
        speechExamples: ['一句有代表性的台词', '另一句台词'],
        background: '经历（80～150 字）',
        goals: ['当前想达成的目标'],
        secret: '不为人知的秘密（可以为空）',
        relationships: [{ to: '另一个角色的名字', type: '关系，例如：青梅竹马、暗恋、宿敌', affinity: 30 }],
      },
    ],
  },
};

// ───────────── 地点 ─────────────

export const LocationsOut = z.object({
  locations: z
    .array(
      z.object({
        name: required,
        description: text.default(''),
        connections: list,
      }),
    )
    .min(1),
});
export type LocationsOut = z.infer<typeof LocationsOut>;

export const locationsSpec: JsonSpec<LocationsOut> = {
  name: 'world_locations',
  schema: LocationsOut,
  example: {
    locations: [
      {
        name: '地点名',
        description: '这里的样子、氛围、常见的人和事（60～120 字）',
        connections: ['相连或相邻的其他地点名'],
      },
    ],
  },
};

// ───────────── 设定集 ─────────────

export const LoreOut = z.object({
  entries: z
    .array(
      z.object({
        title: required,
        category: text.default('general'),
        content: required,
        keys: list,
        always: z
          .preprocess((v) => (typeof v === 'string' ? v === 'true' : v), z.boolean())
          .catch(false)
          .default(false),
      }),
    )
    .min(1),
});
export type LoreOut = z.infer<typeof LoreOut>;

export const loreSpec: JsonSpec<LoreOut> = {
  name: 'world_lore',
  schema: LoreOut,
  example: {
    entries: [
      {
        title: '条目名',
        category: '分类，例如：地理、势力、历史、物品、规则、风俗',
        content: '条目正文（50～200 字），自成一体，不依赖其他条目也能看懂',
        keys: ['触发词1', '触发词2'],
        always: false,
      },
    ],
  },
};

// ───────────── 开场 ─────────────

export const OpeningOut = z.object({
  location: text.default(''),
  present: list,
  narration: required,
  lines: z
    .array(z.object({ speaker: required, text: required }))
    .catch([])
    .default([]),
});
export type OpeningOut = z.infer<typeof OpeningOut>;

export const openingSpec: JsonSpec<OpeningOut> = {
  name: 'story_opening',
  schema: OpeningOut,
  example: {
    location: '开场所在的地点名（必须是给定地点之一）',
    present: ['在场角色的名字（不含主角）'],
    narration: '开场叙述（200～400 字）',
    lines: [{ speaker: '在场角色的名字', text: '台词' }],
  },
};
