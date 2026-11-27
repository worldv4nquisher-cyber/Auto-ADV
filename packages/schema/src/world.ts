import { z } from 'zod';
import { EntityMeta, Id, KnownBy } from './common.ts';
import { FORMAT_VERSION } from './version.ts';

/** 创世管线中某一步的状态。 */
export const GenesisStepState = z.object({
  status: z.enum(['pending', 'running', 'done', 'failed']),
  error: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type GenesisStepState = z.infer<typeof GenesisStepState>;

/** world.json：世界清单。 */
export const WorldManifest = z.object({
  formatVersion: z.number().int().default(FORMAT_VERSION),
  id: z.string().min(1),
  title: z.string().min(1),
  /** 一句话简介，世界列表里显示。 */
  logline: z.string().default(''),
  /** generating：创世进行中或被中断；failed：某一步失败，可以续跑；ready：可以游玩。 */
  status: z.enum(['generating', 'ready', 'failed']).default('ready'),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** 创世时用的种子文本与选项，便于复现、续跑和重抽。 */
  genesis: z
    .object({
      seed: z.string().default(''),
      preset: z.string().optional(),
      options: z.record(z.string(), z.unknown()).default({}),
      steps: z.record(z.string(), GenesisStepState).default({}),
    })
    .default({ seed: '', options: {}, steps: {} }),
  /** 生成过程中用到的模型，仅作记录。 */
  models: z.array(z.string()).default([]),
  /**
   * 不带 `_meta` 的几块内容的锁（20.4）：`title`、`logline`（世界名、一句话简介）、`worldview`（世界观正文）、
   * `variables`（数值表）。重抽时锁住的不覆盖。
   */
  locked: z.array(z.string()).default([]),
});
export type WorldManifest = z.infer<typeof WorldManifest>;

export const PlayMode = z.enum(['chat', 'adv', 'observer']);
export type PlayMode = z.infer<typeof PlayMode>;

/** brief.json：世界简报。 */
export const WorldBrief = z.object({
  formatVersion: z.number().int().default(FORMAT_VERSION),
  genre: z.string(),
  tone: z.string(),
  logline: z.string().default(''),
  era: z.string().default(''),
  themes: z.array(z.string()).default([]),
  rating: z.enum(['all', 'teen', 'mature']).default('teen'),
  length: z.enum(['short', 'medium', 'long', 'endless']).default('medium'),
  defaultMode: PlayMode.default('chat'),
  language: z.string().default('zh-CN'),
  _meta: EntityMeta.default({ locked: [] }),
});
export type WorldBrief = z.infer<typeof WorldBrief>;

export const CharacterRole = z.enum(['protagonist', 'heroine', 'hero', 'rival', 'antagonist', 'mentor', 'npc']);

/** characters/<id>/character.json */
export const Character = z.object({
  formatVersion: z.number().int().default(FORMAT_VERSION),
  id: Id,
  name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  role: CharacterRole.default('npc'),
  gender: z.string().default(''),
  age: z.string().default(''),
  summary: z.string().default(''),
  appearance: z
    .object({
      text: z.string().default(''),
      imagePrompt: z.string().default(''),
      referenceImage: z.string().optional(),
    })
    .default({ text: '', imagePrompt: '' }),
  personality: z
    .object({
      traits: z.array(z.string()).default([]),
      values: z.array(z.string()).default([]),
      fears: z.array(z.string()).default([]),
    })
    .default({ traits: [], values: [], fears: [] }),
  speech: z
    .object({
      style: z.string().default(''),
      examples: z.array(z.string()).default([]),
    })
    .default({ style: '', examples: [] }),
  background: z.string().default(''),
  goals: z
    .array(z.object({ text: z.string(), priority: z.number().int().default(1), public: z.boolean().default(true) }))
    .default([]),
  secrets: z.array(z.object({ id: Id, text: z.string(), knownBy: KnownBy })).default([]),
  relationships: z
    .array(z.object({ to: Id, type: z.string(), affinity: z.number().min(-100).max(100).default(0) }))
    .default([]),
  expressions: z.array(z.string()).default(['neutral']),
  voice: z.object({ provider: z.string(), voiceId: z.string() }).optional(),
  _meta: EntityMeta.default({ locked: [] }),
});
export type Character = z.infer<typeof Character>;

/** setting/lore/*.json：设定集条目。触发字段与 SillyTavern 世界书对齐。 */
export const LoreEntry = z.object({
  formatVersion: z.number().int().default(FORMAT_VERSION),
  id: Id,
  title: z.string().min(1),
  content: z.string(),
  category: z.string().default('general'),
  keys: z.array(z.string()).default([]),
  activation: z.enum(['always', 'keyword', 'semantic']).default('keyword'),
  /** global / character:<id> / location:<id> */
  scope: z.string().default('global'),
  priority: z.number().int().default(50),
  knownBy: KnownBy.default('public'),
  _meta: EntityMeta.default({ locked: [] }),
});
export type LoreEntry = z.infer<typeof LoreEntry>;

/** locations/<id>.json */
export const Location = z.object({
  formatVersion: z.number().int().default(FORMAT_VERSION),
  id: Id,
  name: z.string().min(1),
  description: z.string().default(''),
  connections: z.array(Id).default([]),
  /** 背景图变体，如 { "day": "assets/bg/library_day.png" } */
  backgrounds: z.record(z.string(), z.string()).default({}),
  _meta: EntityMeta.default({ locked: [] }),
});
export type Location = z.infer<typeof Location>;

/** style/style.json：文风、画风、音乐风格指南。 */
export const StyleGuide = z.object({
  formatVersion: z.number().int().default(FORMAT_VERSION),
  prose: z
    .object({
      pov: z.enum(['first', 'second', 'third']).default('third'),
      description: z.string().default(''),
      samples: z.array(z.string()).default([]),
    })
    .default({ pov: 'third', description: '', samples: [] }),
  art: z
    .object({ prompt: z.string().default(''), negative: z.string().default('') })
    .default({ prompt: '', negative: '' }),
  music: z.object({ description: z.string().default('') }).default({ description: '' }),
  _meta: EntityMeta.default({ locked: [] }),
});
export type StyleGuide = z.infer<typeof StyleGuide>;

/** story/opening.json：第一个周目的开场。 */
export const StoryOpening = z.object({
  formatVersion: z.number().int().default(FORMAT_VERSION),
  locationId: Id.optional(),
  presentCharacterIds: z.array(Id).default([]),
  narration: z.string(),
  lines: z.array(z.object({ characterId: Id, text: z.string() })).default([]),
  _meta: EntityMeta.default({ locked: [] }),
});
export type StoryOpening = z.infer<typeof StoryOpening>;
