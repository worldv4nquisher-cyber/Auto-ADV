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

/** 表情 id：小写字母开头，字母、数字、下划线。 */
export const ExpressionId = z.string().regex(/^[a-z][a-z0-9_]*$/, '表情 id 只能用小写字母、数字和下划线，字母开头');

/**
 * 表情表里的一项（18.5）：id 是立绘槽和舞台指令里用的名字（sprite/<角色 id>/<表情 id>）；
 * name 是给演员看的名字（台词前的括号里第一个词写它）；synonyms 是同义词，演员写了这些词也认成这个表情；
 * prompt 是画表情差分时告诉图像模型的描述。
 */
export const ExpressionDef = z.object({
  id: ExpressionId,
  name: z.string().trim().min(1, '表情要有名字'),
  synonyms: z.array(z.string().trim().min(1)).default([]),
  prompt: z.string().default(''),
});
export type ExpressionDef = z.infer<typeof ExpressionDef>;

/** 默认的一套表情（18.5）。基础立绘就是 neutral。 */
export const DEFAULT_EXPRESSIONS: ExpressionDef[] = [
  {
    id: 'neutral',
    name: '平静',
    synonyms: ['淡然', '冷静', '面无表情', '认真', '沉默', '思索', '若有所思', '平淡'],
    prompt: '表情平静自然，嘴角放松',
  },
  {
    id: 'smile',
    name: '微笑',
    synonyms: ['笑', '笑着', '轻笑', '浅笑', '开心', '高兴', '愉快', '温柔', '得意', '笑眯眯'],
    prompt: '温和地微笑，眼睛微微弯起',
  },
  {
    id: 'angry',
    name: '生气',
    synonyms: ['愤怒', '恼火', '怒', '皱眉', '瞪', '不满', '不耐烦', '咬牙'],
    prompt: '皱着眉，眼神凶，嘴角向下，生气的样子',
  },
  {
    id: 'sad',
    name: '难过',
    synonyms: ['伤心', '悲伤', '低落', '失落', '黯然', '哽咽', '哭', '落泪', '眼眶发红', '沮丧'],
    prompt: '眉头微蹙，眼神低垂，难过的样子',
  },
  {
    id: 'surprised',
    name: '惊讶',
    synonyms: ['吃惊', '震惊', '愣', '愣住', '一愣', '怔', '错愕', '意外', '睁大眼', '慌', '慌张'],
    prompt: '睁大眼睛，嘴微微张开，惊讶的样子',
  },
  {
    id: 'shy',
    name: '害羞',
    synonyms: ['脸红', '羞涩', '不好意思', '红着脸', '别过脸', '扭捏', '腼腆'],
    prompt: '脸颊泛红，视线移开，害羞的样子',
  },
];

/**
 * 立绘的透明背景怎么做（18.5）：
 * auto 自动：向接口要透明图，同时提示词要纯色背景；返回的图带透明就直接用，不带就用内置抠图；
 * native 直接要透明图（服务支持透明输出时）；key 纯色背景 + 内置抠图；service 纯色背景 + 抠图服务；none 不抠。
 */
export const TransparencyMode = z.enum(['auto', 'native', 'key', 'service', 'none']);
export type TransparencyMode = z.infer<typeof TransparencyMode>;

/** 纯色背景的底色：auto 默认白色，外貌里有白衣、白发、银发这类词时换成绿色。 */
export const KeyColor = z.enum(['auto', 'white', 'green']);
export type KeyColor = z.infer<typeof KeyColor>;

/** 情绪 id：和表情 id 一样，小写字母开头，字母、数字、下划线。 */
export const MoodId = ExpressionId;

/**
 * 情绪表里的一项（18.7）：id 是 BGM 槽（bgm/<情绪 id>）和舞台上 bgm 指令里用的名字；
 * name 是给人看的名字；synonyms 是同义词，导演写了这些词、手写剧本的 bgm 指令和本地曲库的文件名里有这些词，都认成这个情绪；
 * hint 是给导演看的说明（什么样的戏用它）；prompt 是用音乐模型生成时的描述。
 */
export const MoodDef = z.object({
  id: MoodId,
  name: z.string().trim().min(1, '情绪要有名字'),
  synonyms: z.array(z.string().trim().min(1)).default([]),
  hint: z.string().default(''),
  prompt: z.string().default(''),
});
export type MoodDef = z.infer<typeof MoodDef>;

/** 默认的一套情绪（18.7）。第一个是兜底：手写剧本里认不出来的 bgm 指令放它。 */
export const DEFAULT_MOODS: MoodDef[] = [
  {
    id: 'theme',
    name: '主题',
    synonyms: ['主题曲', '片头', '开场', '标题', 'main', 'title', 'opening', 'op', 'prologue'],
    hint: '开场、章节开头、点题的时刻',
    prompt: '主题曲，旋律优美、令人印象深刻，带一点期待感',
  },
  {
    id: 'daily',
    name: '日常',
    synonyms: ['平静', '轻松', '闲聊', '平常', 'calm', 'daily', 'peace', 'peaceful', 'everyday', 'normal', 'relax'],
    hint: '平静的日常、闲聊、没有冲突的场面',
    prompt: '轻松、平静的日常氛围，节奏舒缓',
  },
  {
    id: 'tense',
    name: '紧张',
    synonyms: ['悬疑', '不安', '危险', '神秘', '调查', '对峙', 'mystery', 'suspense', 'tense', 'tension', 'danger', 'dark', 'investigation'],
    hint: '悬疑、调查、对峙、危险逼近',
    prompt: '紧张、悬疑，低音持续，节奏不安',
  },
  {
    id: 'sad',
    name: '悲伤',
    synonyms: ['难过', '伤感', '离别', '失落', '回忆', 'sad', 'sorrow', 'melancholy', 'tragic', 'farewell', 'memory'],
    hint: '离别、失去、伤心的回忆',
    prompt: '悲伤、伤感，旋律缓慢低沉',
  },
  {
    id: 'warm',
    name: '温馨',
    synonyms: ['温暖', '感动', '重逢', '和好', '浪漫', '恋爱', 'warm', 'reunion', 'gentle', 'love', 'romance', 'tender', 'happy'],
    hint: '温暖、感动、重逢、亲近的时刻',
    prompt: '温暖、温柔，旋律明亮柔和',
  },
  {
    id: 'climax',
    name: '高潮',
    synonyms: ['激烈', '决战', '战斗', '真相', '爆发', 'climax', 'battle', 'fight', 'finale', 'epic', 'boss'],
    hint: '真相揭开、激烈冲突、决定性的时刻',
    prompt: '激昂、壮阔，节奏强烈，情绪推到顶点',
  },
];

/** BGM 的三种来源（18.7）：本地曲库、音乐模型、内置古典曲库。 */
export const BGM_SOURCES = ['library', 'model', 'builtin'] as const;
export const BgmSource = z.enum(BGM_SOURCES);
export type BgmSource = z.infer<typeof BgmSource>;

export const BGM_SOURCE_LABELS: Record<BgmSource, string> = { library: '本地曲库', model: '音乐模型', builtin: '内置曲库' };

const uniqueSources = (list: readonly string[]) => new Set(list).size === list.length;

/** BGM 的设置（18.7、18.11）。 */
export const BgmSettings = z.object({
  /** 按顺序找，列表里没有的来源就是关掉了。 */
  sources: z.array(BgmSource).refine(uniqueSources, '来源不能重复').default([...BGM_SOURCES]),
  /** 本地曲库的文件夹（完整路径）。空字符串表示不选。 */
  libraryDir: z.string().default(''),
  /** 本地曲库里按文件夹名和文件名对不上情绪的曲子，让文本模型按文件名挑（每个文件夹只问一次，结果记下来）。 */
  classifyLibrary: z.boolean().default(true),
  /** 情绪表（18.7）。 */
  moods: z
    .array(MoodDef)
    .min(1, '情绪表至少要有一个情绪')
    .refine((list) => new Set(list.map((m) => m.id)).size === list.length, '情绪 id 不能重复')
    .default(DEFAULT_MOODS),
  /** 单个情绪指定来源（素材页上改，只在世界里有）：不按顺序找，只用这个来源。 */
  pins: z.record(z.string(), BgmSource).default({}),
  /** 导演报告的情绪持续几拍才换曲（换幕时马上换）。 */
  switchBeats: z.number().int().min(1).max(10).default(2),
  /** 换曲时淡出淡入几秒。 */
  fadeSeconds: z.number().min(0).max(10).default(2),
  /** 不循环的曲子（内置曲库、本地曲库）放完以后停几秒再放下一首。 */
  gapSeconds: z.number().min(0).max(60).default(3),
  /** 音量，0～100。 */
  volume: z.number().int().min(0).max(100).default(60),
  /** 音乐模型的提示词模板。空字符串表示用内置模板。 */
  template: z.string().default(''),
});
export type BgmSettings = z.infer<typeof BgmSettings>;

/** 世界里单个角色的立绘设置（素材页上改）：expressions 这个角色画哪些表情，不写就按角色类型。 */
export const CharacterAssetSettings = z.object({
  expressions: z.array(ExpressionId).optional(),
});
export type CharacterAssetSettings = z.infer<typeof CharacterAssetSettings>;

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
  /** 表情表（18.5）。 */
  expressions: z
    .array(ExpressionDef)
    .min(1, '表情表至少要有一个表情')
    .refine((list) => new Set(list.map((e) => e.id)).size === list.length, '表情 id 不能重复')
    .default(DEFAULT_EXPRESSIONS),
  /** 主要角色（npc 以外）和其他角色各画哪些表情。平静（基础立绘）总是要画。 */
  spriteSets: z
    .object({
      main: z.array(ExpressionId).default(DEFAULT_EXPRESSIONS.map((e) => e.id)),
      other: z.array(ExpressionId).default(['neutral', 'smile', 'surprised']),
    })
    .prefault({}),
  /** 主角画不画立绘。观察模式的舞台上主角也出场；剧情 ADV 里不给主角出立绘，只玩剧情 ADV 可以关掉省几张。 */
  spriteProtagonist: z.boolean().default(true),
  transparency: TransparencyMode.default('auto'),
  keyColor: KeyColor.default('auto'),
  /** 单个角色的设置（只在世界里有）。 */
  characters: z.record(z.string(), CharacterAssetSettings).default({}),
  /** BGM（18.7）。 */
  bgm: BgmSettings.prefault({}),
  /** 同一个图像接入点同时画几张。 */
  imageConcurrency: z.number().int().min(1).max(16).default(2),
  /** 同一个音乐接入点同时生成几首。 */
  musicConcurrency: z.number().int().min(1).max(8).default(1),
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
  expressions: z.array(ExpressionDef).min(1).optional(),
  spriteSets: z.object({ main: z.array(ExpressionId), other: z.array(ExpressionId) }).partial().optional(),
  spriteProtagonist: z.boolean().optional(),
  transparency: TransparencyMode.optional(),
  keyColor: KeyColor.optional(),
  characters: z.record(z.string(), CharacterAssetSettings).optional(),
  bgm: z
    .object({
      sources: z.array(BgmSource).refine(uniqueSources, '来源不能重复'),
      libraryDir: z.string(),
      classifyLibrary: z.boolean(),
      moods: z.array(MoodDef).min(1),
      pins: z.record(z.string(), BgmSource),
      switchBeats: z.number().int().min(1).max(10),
      fadeSeconds: z.number().min(0).max(10),
      gapSeconds: z.number().min(0).max(60),
      volume: z.number().int().min(0).max(100),
      template: z.string(),
    })
    .partial()
    .optional(),
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
    ...(patch.expressions !== undefined ? { expressions: patch.expressions } : {}),
    ...(patch.spriteProtagonist !== undefined ? { spriteProtagonist: patch.spriteProtagonist } : {}),
    ...(patch.transparency !== undefined ? { transparency: patch.transparency } : {}),
    ...(patch.keyColor !== undefined ? { keyColor: patch.keyColor } : {}),
    enabled: { ...base.enabled, ...patch.enabled },
    sizes: { ...base.sizes, ...patch.sizes },
    templates: { ...base.templates, ...patch.templates },
    spriteSets: { ...base.spriteSets, ...patch.spriteSets },
    characters: { ...base.characters, ...patch.characters },
    bgm: { ...base.bgm, ...patch.bgm },
  });
}

/** assets/index.json 里一个槽的登记。槽的状态由它和素材清单（planAssets）一起算出来。 */
export const AssetSlotRecord = z.object({
  id: z.string(),
  /** 现在用的文件（相对世界目录）。 */
  file: z.string().optional(),
  /** 立绘抠图之前的原图：表情差分拿它当参考图（纯色背景比透明背景更好改）。 */
  rawFile: z.string().optional(),
  /** 抠图没通过透明度检查（重画过一次还是不行）：现在用的是没抠的原图，要你看一下。 */
  review: z.string().optional(),
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
        rawFile: z.string().optional(),
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
  /** 这个世界用音乐模型生成了多少首（只是记一下，不设上限）。 */
  music: z.number().int().min(0).default(0),
  /** 到了上限之后你放宽了多少张。 */
  capExtra: z.number().int().min(0).default(0),
  /** 暂停生成。 */
  paused: z.boolean().default(false),
});
export type AssetIndex = z.infer<typeof AssetIndex>;

/** 媒体职责（图像、抠图、音乐）的路由：用哪个接入点、哪个模型、什么接口。 */
export const MediaRoute = z.object({
  endpointId: z.string(),
  model: z.string(),
  /**
   * 接口类型。openai：/images/generations 和 /images/edits（图像）；
   * rembg：POST <地址>/api/remove，multipart 上传 file，返回抠好的 PNG（抠图，rembg 自带的 HTTP 服务就是这样）；
   * minimax：POST <Base URL>/music_generation（音乐，MiniMax 的接口，和文本接口用同一个 Base URL 和密钥）。
   */
  api: z.enum(['openai', 'rembg', 'minimax']).default('openai'),
});
export type MediaRoute = z.infer<typeof MediaRoute>;

export const MEDIA_ROLE_IDS = ['image', 'cutout', 'music'] as const;
export const MediaRoleId = z.enum(MEDIA_ROLE_IDS);
export type MediaRoleId = z.infer<typeof MediaRoleId>;

export const MEDIA_ROLE_LABELS: Record<MediaRoleId, { name: string; hint: string }> = {
  image: { name: '图像', hint: '背景、立绘、CG。不会用「默认」的文本模型' },
  cutout: { name: '抠图', hint: '立绘的透明背景选「抠图服务」时用，例如本地的 rembg' },
  music: { name: '音乐', hint: 'BGM 的「音乐模型」来源，每种情绪生成一首纯音乐' },
};

/** 每个媒体职责能用的接口类型。 */
export const MEDIA_ROLE_APIS: Record<MediaRoleId, MediaRoute['api'][]> = {
  image: ['openai'],
  cutout: ['rembg'],
  music: ['minimax'],
};
