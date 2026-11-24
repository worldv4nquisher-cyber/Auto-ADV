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
  { key: '构图', hint: '这类图的构图要求（背景：横图、没有人物）' },
  { key: '避免', hint: '不要出现的东西，加上世界画风里写的反向提示词' },
];

export const BUILTIN_TEMPLATES: ImageTemplates = {
  background: ['{画风}', '时代和题材：{世界}', '场景：{内容}', '{构图}', '画面里不要有：{避免}'].join('\n'),
  // 下面三个在第 2、5 步用上，先把位置留好，设置页可以先改
  sprite: ['{画风}', '时代和题材：{世界}', '人物：{内容}', '{构图}', '画面里不要有：{避免}'].join('\n'),
  expression: ['保持参考图里人物的脸、发型、服装、姿势和构图完全不变，只改表情：{内容}', '{构图}'].join('\n'),
  cg: ['{画风}', '时代和题材：{世界}', '画面：{内容}', '{构图}', '画面里不要有：{避免}'].join('\n'),
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
  sprite: ['多个人物', '文字', '水印'],
  expression: [],
  cg: ['文字', '水印', '画框'],
} as const;

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
