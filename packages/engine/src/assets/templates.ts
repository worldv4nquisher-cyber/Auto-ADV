import type { ImageTemplates } from '@auto-adv/schema';

/**
 * 图片提示词模板（18.4、18.11）。所有图片的提示词都由引擎按模板拼出来：画风 + 内容 + 构图要求。
 * 设置里可以整段改写模板（全局或者某个世界），留空就用这里的内置模板。
 */

/** 世界没写画风、设置里也没填时用的画风。 */
export const DEFAULT_ART_STYLE = '日系视觉小说风格的插画，干净的线条，细腻的光影，色彩柔和统一';

/** 模板里能用的占位符和说明（设置页显示）。 */
export const TEMPLATE_PLACEHOLDERS: { key: string; hint: string }[] = [
  { key: '画风', hint: '世界的画风；世界没写就用设置里的默认画风' },
  { key: '世界', hint: '时代和题材，来自世界简报' },
  { key: '内容', hint: '这张图画什么：地点的名字和描述、角色的外貌' },
  { key: '表情', hint: '立绘和表情差分：表情表里这个表情的描述' },
  { key: '构图', hint: '这类图的构图要求（背景：横图、没有人物；立绘：膝上半身、人物居中）' },
  { key: '背景', hint: '立绘的背景要求：纯色底，或者透明（看设置里透明背景的做法）' },
  { key: '避免', hint: '不要出现的东西，加上世界画风里写的反向提示词' },
  { key: '人物', hint: 'CG：画面里的角色和他们的外貌' },
  { key: '参考', hint: 'CG：拿角色的立绘当参考图时，告诉模型保持这个角色的长相和服装；不用参考图时是空的' },
  { key: '时段', hint: '时段背景：时段的名字（黄昏、夜晚……）' },
  { key: '时段描述', hint: '时段背景：时段表里这个时段的光线和天色' },
];

export const BUILTIN_TEMPLATES: ImageTemplates = {
  background: ['{画风}', '时代和题材：{世界}', '场景：{内容}', '{构图}', '画面里不要有：{避免}'].join('\n'),
  sprite: ['{画风}', '时代和题材：{世界}', '角色立绘，人物：{内容}', '表情：{表情}', '{构图}', '{背景}', '画面里不要有：{避免}'].join('\n'),
  // 表情差分是拿基础立绘当参考图改图，所以不重复写画风和外貌
  expression: [
    '保持参考图里人物的脸、发型、服装、姿势、构图和画风完全不变，只改表情：{表情}',
    '{背景}',
    '画面里不要有：{避免}',
  ].join('\n'),
  cg: ['{画风}', '时代和题材：{世界}', '画面：{内容}', '画面里的人物：{人物}', '{参考}', '{构图}', '画面里不要有：{避免}'].join('\n'),
  // 时段背景默认拿白天的背景当参考图改光线（设置里选"重新画"时用背景的模板）
  timeOfDay: [
    '把参考图这张背景改成{时段}：{时段描述}',
    '保持构图、视角、建筑和物件完全不变，只改光线、天色和灯光，画面里不要加人物',
    '{画风}',
    '画面里不要有：{避免}',
  ].join('\n'),
};

/** 每类图固定的构图要求和要避免的东西。 */
export const COMPOSITION = {
  background: '视觉小说的背景图，横向构图，视线在人眼高度，画面下方留出放文本框的空间，画面里没有人物',
  sprite: '视觉小说的角色立绘，单人，膝盖以上的半身像，正面略侧，人物居中，头顶留出空白',
  expression: '',
  cg: '视觉小说的事件 CG，横向构图，电影感的镜头',
} as const;

export const AVOID = {
  background: ['人物', '文字', '水印', '画框'],
  sprite: ['多个人物', '文字', '水印', '地面', '投影', '道具和场景'],
  expression: ['多个人物', '文字', '水印'],
  cg: ['文字', '水印', '画框'],
} as const;

/**
 * 立绘的背景要求（18.5）。提示词里不写"透明背景"：多数模型没有透明输出时会画成灰白棋盘格，比纯色更难抠。
 * native（直接要透明图）也写纯色底：服务真给了透明图，这句不影响；没给，纯色底还能抠。
 */
export function backdropText(key: 'white' | 'green' | null): string {
  if (!key) return '简单干净的纯色背景';
  const color = key === 'green' ? '纯绿色（#00FF00）' : '纯白色';
  return `背景是一整片${color}，没有任何图案、渐变、地面和投影，人物和画面边缘之间留出空隙`;
}

/** 外貌里有这些词时，纯色底换成绿色（白衣、白发在白底上抠不干净）。 */
export const WHITE_WORDS = /白衣|白色的?(?:衣|裙|衬衫|外套|长袍|和服|制服|连衣裙|头发|长发|短发)|白裙|白衬衫|白大褂|白发|银发|白色头发|银白|雪白|白金色|white|silver/i;

/** 世界没写音乐风格时用的风格。 */
export const DEFAULT_MUSIC_STYLE = '视觉小说的背景音乐，以钢琴和弦乐为主，旋律清晰，不抢台词';

/** 音乐模板里能用的占位符和说明（设置页显示）。 */
export const MUSIC_PLACEHOLDERS: { key: string; hint: string }[] = [
  { key: '音乐风格', hint: '世界的音乐风格；世界没写就用内置的默认风格' },
  { key: '世界', hint: '时代和题材，来自世界简报' },
  { key: '情绪', hint: '情绪表里这个情绪的描述' },
];

/** 音乐模型的内置模板（18.7）：纯音乐，能循环。MiniMax 的提示词有长度上限，所以写得短。 */
export const BUILTIN_MUSIC_TEMPLATE = ['{音乐风格}', '题材：{世界}', '情绪：{情绪}', '纯音乐，没有人声，一到两分钟，结尾能自然接回开头循环播放'].join('\n');

const PLACEHOLDER = /\{([^{}\s]{1,8})\}/g;

/**
 * 按模板拼提示词：把 {占位符} 换成值。一行里的占位符全都是空的，这一行整个去掉
 * （比如世界没写时代和题材，就不写"时代和题材："这一行）。不认识的占位符原样保留。
 */
export function renderTemplate(template: string, values: Record<string, string>): string {
  const lines: string[] = [];
  for (const line of template.split('\n')) {
    const keys = [...line.matchAll(PLACEHOLDER)].map((m) => m[1] ?? '').filter((k) => k in values);
    if (keys.length > 0 && keys.every((k) => !(values[k] ?? '').trim())) continue;
    lines.push(line.replace(PLACEHOLDER, (all, k: string) => (k in values ? (values[k] ?? '').trim() : all)));
  }
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
