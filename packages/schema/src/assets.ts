import { z } from 'zod';
import { FORMAT_VERSION } from './version.ts';

/**
 * 素材管线（M4，docs/ARCHITECTURE.md 第 18 节）。
 * 世界需要的每一个素材是一个"槽"，id 由用途决定（bg/<地点 id>、sprite/<角色 id>/<表情>……），重画不改 id。
 */

/** 可以单独开关的素材类型（18.11）。 */
export const ASSET_TOGGLES = ['background', 'sprite', 'expression', 'cg', 'bgm', 'voice'] as const;
export const AssetToggle = z.enum(ASSET_TOGGLES);
export type AssetToggle = z.infer<typeof AssetToggle>;

export const ASSET_TOGGLE_LABELS: Record<AssetToggle, string> = {
  background: '背景',
  sprite: '立绘',
  expression: '表情差分',
  cg: 'CG',
  bgm: 'BGM',
  voice: '语音',
};

/** 槽的类型。 */
export const AssetKind = z.enum(['background', 'sprite', 'cg', 'bgm']);
export type AssetKind = z.infer<typeof AssetKind>;

/** 图片尺寸，写成 宽x高，例如 1536x1024。 */
export const ImageSize = z.string().regex(/^\d{2,5}x\d{2,5}$/, '尺寸要写成 宽x高，例如 1536x1024');

/** 提示词模板。空字符串表示用内置模板。占位符见引擎的 assets/templates.ts。 */
export const ImageTemplates = z.object({
  background: z.string().default(''),
  sprite: z.string().default(''),
  expression: z.string().default(''),
  cg: z.string().default(''),
});
export type ImageTemplates = z.infer<typeof ImageTemplates>;

/** 素材管线的设置（18.11）。全局设置存在 settings.json 的 assets 里，世界里只写和全局不一样的项。 */
export const AssetSettings = z.object({
  enabled: z
    .object({
      background: z.boolean().default(true),
      sprite: z.boolean().default(true),
      expression: z.boolean().default(true),
      cg: z.boolean().default(true),
      bgm: z.boolean().default(true),
      voice: z.boolean().default(true),
    })
    .prefault({}),
  /** 每个世界最多生成多少张图（算上重抽）。 */
  imageCap: z.number().int().min(1).max(100_000).default(60),
  /** 到了上限：ask 停下来问（素材页上点「继续」放宽），stop 直接停。 */
  capAction: z.enum(['ask', 'stop']).default('ask'),
  sizes: z
    .object({
      background: ImageSize.default('1536x1024'),
      sprite: ImageSize.default('1024x1536'),
      cg: ImageSize.default('1536x1024'),
    })
    .prefault({}),
  /** 世界没写画风（style.art.prompt）时用的画风。空字符串表示用内置的默认画风。 */
  artStyle: z.string().default(''),
  templates: ImageTemplates.prefault({}),
  /** 同一个图像接入点同时画几张。 */
  imageConcurrency: z.number().int().min(1).max(16).default(2),
  /** 一张图失败后重试几次（按指数退避）。 */
  retries: z.number().int().min(0).max(10).default(3),
});
export type AssetSettings = z.infer<typeof AssetSettings>;

/** 世界里的素材设置：只写和全局不一样的项（assets/settings.json）。 */
export const AssetSettingsPatch = z.object({
  enabled: z.partialRecord(AssetToggle, z.boolean()).optional(),
  imageCap: z.number().int().min(1).max(100_000).optional(),
  capAction: z.enum(['ask', 'stop']).optional(),
  sizes: z.object({ background: ImageSize, sprite: ImageSize, cg: ImageSize }).partial().optional(),
  artStyle: z.string().optional(),
  templates: ImageTemplates.partial().optional(),
});
export type AssetSettingsPatch = z.infer<typeof AssetSettingsPatch>;

/** 合并全局设置和世界里的设置。 */
export function mergeAssetSettings(base: AssetSettings, patch: AssetSettingsPatch | null | undefined): AssetSettings {
  if (!patch) return base;
  return AssetSettings.parse({
    ...base,
    ...(patch.imageCap !== undefined ? { imageCap: patch.imageCap } : {}),
    ...(patch.capAction !== undefined ? { capAction: patch.capAction } : {}),
    ...(patch.artStyle !== undefined ? { artStyle: patch.artStyle } : {}),
    enabled: { ...base.enabled, ...patch.enabled },
    sizes: { ...base.sizes, ...patch.sizes },
    templates: { ...base.templates, ...patch.templates },
  });
}

/** assets/index.json 里一个槽的登记。槽的状态由它和素材清单（planAssets）一起算出来。 */
export const AssetSlotRecord = z.object({
  id: z.string(),
  /** 现在用的文件（相对世界目录）。 */
  file: z.string().optional(),
  /** 这个文件生成或上传时的参数哈希、输入哈希（参数 + 依赖槽的文件）。和现在的对不上就是过期。 */
  builtParams: z.string().optional(),
  builtInput: z.string().optional(),
  source: z.enum(['generated', 'uploaded', 'builtin']).optional(),
  /** 锁定的槽不会被自动覆盖。 */
  locked: z.boolean().default(false),
  /** 你改过的提示词（整段替换模板拼出来的）。 */
  prompt: z.string().optional(),
  /** 重抽了几次：参与哈希，所以重抽一定会画一张新的。 */
  variant: z.number().int().min(0).default(0),
  /** 你点了重画（过期、重抽、重试），下一轮排队。 */
  requested: z.boolean().default(false),
  /** 最近一次失败的原因和当时的输入哈希：输入没变就不自动重试。 */
  error: z.string().optional(),
  failedInput: z.string().optional(),
  model: z.string().optional(),
  /** 服务端改写后的提示词（有的服务会改写，比如 MiniMax）。 */
  revisedPrompt: z.string().optional(),
  updatedAt: z.string().optional(),
  /** 之前用过的文件，素材页里可以换回去（最多留 10 个）。 */
  history: z
    .array(
      z.object({
        file: z.string(),
        builtParams: z.string().optional(),
        builtInput: z.string().optional(),
        source: z.enum(['generated', 'uploaded', 'builtin']).optional(),
        at: z.string(),
      }),
    )
    .default([]),
});
export type AssetSlotRecord = z.infer<typeof AssetSlotRecord>;

/** assets/index.json：素材槽的登记。 */
export const AssetIndex = z.object({
  formatVersion: z.number().int().default(FORMAT_VERSION),
  slots: z.record(z.string(), AssetSlotRecord).default({}),
  /** 这个世界一共生成了多少张图（算上限用，重抽也算）。 */
  generated: z.number().int().min(0).default(0),
  /** 到了上限之后你放宽了多少张。 */
  capExtra: z.number().int().min(0).default(0),
  /** 暂停生成。 */
  paused: z.boolean().default(false),
});
export type AssetIndex = z.infer<typeof AssetIndex>;

/** 图像职责的路由：用哪个接入点、哪个模型、什么接口。 */
export const MediaRoute = z.object({
  endpointId: z.string(),
  model: z.string(),
  /** 接口类型。openai：/images/generations 和 /images/edits。 */
  api: z.enum(['openai']).default('openai'),
});
export type MediaRoute = z.infer<typeof MediaRoute>;

export const MEDIA_ROLE_IDS = ['image'] as const;
export const MediaRoleId = z.enum(MEDIA_ROLE_IDS);
export type MediaRoleId = z.infer<typeof MediaRoleId>;

export const MEDIA_ROLE_LABELS: Record<MediaRoleId, { name: string; hint: string }> = {
  image: { name: '图像', hint: '背景、立绘、CG。不会用「默认」的文本模型' },
};
