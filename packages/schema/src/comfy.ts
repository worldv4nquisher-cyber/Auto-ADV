import { z } from 'zod';

/**
 * 本地生图（ComfyUI，ARCHITECTURE.md 18.9、19.7）：图像职责的接口类型选「ComfyUI」时的设置。
 *
 * 工作流是 ComfyUI 里「导出（API 格式）」得到的 JSON：键是节点 id，值是 { class_type, inputs }。
 * 要引擎填的地方写占位符，和自定义接口的写法一样：整个字符串只有一个占位符时（"{{width}}"）按原来的类型放（数字），
 * 夹在文字里时换成文字。能用的占位符见 COMFY_VARS。
 *
 * 内置两个工作流（文生图、带参考图改图），只用 ComfyUI 自带的节点；工作流留空就用内置的。
 * 每种用途（背景、立绘、表情差分、CG、时段背景）还可以换成自己的工作流：写了 {{image}} 的用在要参考图的时候，
 * 没写的用在文生图的时候，对不上的照样用上面的通用工作流。
 */

/** 工作流里能用的占位符。image 只在改图时有（上传到 ComfyUI 以后的文件名）。 */
export const COMFY_VARS = ['prompt', 'negative', 'width', 'height', 'seed', 'model', 'denoise', 'image'] as const;

export const COMFY_VAR_HINTS: Record<(typeof COMFY_VARS)[number], string> = {
  prompt: '提示词（按素材设置里的模板拼好的）',
  negative: '反向提示词（下面填的）',
  width: '宽（像素，数字）',
  height: '高（像素，数字）',
  seed: '随机种子（数字，每次不一样）',
  model: '模型文件名（职责路由里填的）',
  denoise: '改图的重绘幅度（0～1，数字）',
  image: '参考图（引擎先上传到 ComfyUI，这里是上传后的文件名）',
};

/** 能单独换工作流的用途：和素材的开关同名。 */
export const COMFY_PURPOSES = ['background', 'sprite', 'expression', 'cg', 'timeOfDay'] as const;
export type ComfyPurpose = (typeof COMFY_PURPOSES)[number];
export const COMFY_PURPOSE_LABELS: Record<ComfyPurpose, string> = {
  background: '背景',
  sprite: '基础立绘',
  expression: '表情差分',
  cg: 'CG',
  timeOfDay: '时段背景',
};

export const DEFAULT_COMFY_NEGATIVE = 'lowres, worst quality, bad anatomy, bad hands, extra fingers, text, watermark, signature, frame';

/** 内置的文生图工作流：Checkpoint → 正反提示词 → 空白 latent → KSampler → VAE 解码 → 预览（放在 ComfyUI 的临时目录，不占输出目录）。 */
export const DEFAULT_COMFY_GENERATE = {
  '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: '{{model}}' } },
  '2': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}', clip: ['1', 1] } },
  '3': { class_type: 'CLIPTextEncode', inputs: { text: '{{negative}}', clip: ['1', 1] } },
  '4': { class_type: 'EmptyLatentImage', inputs: { width: '{{width}}', height: '{{height}}', batch_size: 1 } },
  '5': {
    class_type: 'KSampler',
    inputs: {
      model: ['1', 0],
      positive: ['2', 0],
      negative: ['3', 0],
      latent_image: ['4', 0],
      seed: '{{seed}}',
      steps: 28,
      cfg: 6,
      sampler_name: 'euler_ancestral',
      scheduler: 'normal',
      denoise: 1,
    },
  },
  '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
  '7': { class_type: 'PreviewImage', inputs: { images: ['6', 0] } },
};

/** 内置的改图工作流：参考图缩放到目标尺寸 → VAE 编码 → KSampler（重绘幅度 {{denoise}}）→ 解码 → 预览。 */
export const DEFAULT_COMFY_EDIT = {
  '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: '{{model}}' } },
  '2': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}', clip: ['1', 1] } },
  '3': { class_type: 'CLIPTextEncode', inputs: { text: '{{negative}}', clip: ['1', 1] } },
  '4': { class_type: 'LoadImage', inputs: { image: '{{image}}' } },
  '5': { class_type: 'ImageScale', inputs: { image: ['4', 0], upscale_method: 'lanczos', width: '{{width}}', height: '{{height}}', crop: 'center' } },
  '6': { class_type: 'VAEEncode', inputs: { pixels: ['5', 0], vae: ['1', 2] } },
  '7': {
    class_type: 'KSampler',
    inputs: {
      model: ['1', 0],
      positive: ['2', 0],
      negative: ['3', 0],
      latent_image: ['6', 0],
      seed: '{{seed}}',
      steps: 28,
      cfg: 6,
      sampler_name: 'euler_ancestral',
      scheduler: 'normal',
      denoise: '{{denoise}}',
    },
  },
  '8': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['1', 2] } },
  '9': { class_type: 'PreviewImage', inputs: { images: ['8', 0] } },
};

export const ComfySettings = z.object({
  /** 文生图的工作流（JSON 文字），空着用内置的。 */
  generate: z.string().default(''),
  /** 带参考图改图的工作流（JSON 文字，要有 {{image}}），空着用内置的。 */
  edit: z.string().default(''),
  /** 每种用途单独的工作流（JSON 文字）：有 {{image}} 的用在改图，没有的用在文生图。 */
  purposes: z.partialRecord(z.enum(COMFY_PURPOSES), z.string()).default({}),
  negative: z.string().default(DEFAULT_COMFY_NEGATIVE),
  /** 改图的重绘幅度：越大越不像参考图。 */
  denoise: z.number().min(0).max(1).default(0.55),
  /** 查一次结果之间隔多久（秒）。 */
  pollSeconds: z.number().min(0.1).max(30).default(1),
});
export type ComfySettings = z.infer<typeof ComfySettings>;

const PLACEHOLDER = /\{\{\s*([A-Za-z_]\w*)\s*\}\}/g;

/** 工作流（JSON 文字）解析成对象；不合法时抛出中文的错。 */
export function parseComfyWorkflow(text: string, label: string): Record<string, { class_type: string; inputs: Record<string, unknown> }> {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (err) {
    throw new Error(`${label}不是合法的 JSON：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${label}要写成 JSON 对象（ComfyUI 里「导出（API 格式）」得到的那种）`);
  const nodes = v as Record<string, unknown>;
  if (!Object.keys(nodes).length) throw new Error(`${label}里没有节点`);
  for (const [id, n] of Object.entries(nodes)) {
    const node = n as { class_type?: unknown; inputs?: unknown } | null;
    if (!node || typeof node !== 'object' || typeof node.class_type !== 'string' || !node.inputs || typeof node.inputs !== 'object') {
      throw new Error(`${label}的节点 ${id} 不是 API 格式（要有 class_type 和 inputs）。在 ComfyUI 里用「导出（API 格式）」`);
    }
  }
  return nodes as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
}

/** 这次调用用哪个工作流（JSON 文字）：用途单独写了、而且是不是改图对得上就用它，否则用通用的，再没有就用内置的。 */
export function comfyWorkflowFor(s: ComfySettings, purpose: string | null, edit: boolean): { text: string; label: string } {
  const own = purpose && (COMFY_PURPOSES as readonly string[]).includes(purpose) ? s.purposes[purpose as ComfyPurpose]?.trim() : '';
  if (own && hasImage(own) === edit) return { text: own, label: `「${COMFY_PURPOSE_LABELS[purpose as ComfyPurpose]}」的工作流` };
  if (edit) return { text: s.edit.trim() || JSON.stringify(DEFAULT_COMFY_EDIT), label: '改图工作流' };
  return { text: s.generate.trim() || JSON.stringify(DEFAULT_COMFY_GENERATE), label: '文生图工作流' };
}

const hasImage = (text: string) => [...text.matchAll(PLACEHOLDER)].some((m) => m[1] === 'image');

/** 工作流里用到了 {{model}} 没有（没用到时职责路由里的模型可以不填）。 */
export function comfyUsesModel(s: ComfySettings): boolean {
  const texts = [s.generate.trim() || JSON.stringify(DEFAULT_COMFY_GENERATE), s.edit.trim() || JSON.stringify(DEFAULT_COMFY_EDIT), ...Object.values(s.purposes)];
  return texts.some((t) => [...(t ?? '').matchAll(PLACEHOLDER)].some((m) => m[1] === 'model'));
}

/** 检查设置里的工作流：合法的 API 格式 JSON、占位符认得、改图的有 {{image}}、文生图的有 {{prompt}}。返回第一个问题，没问题返回 null。 */
export function checkComfy(s: ComfySettings): string | null {
  const all: [string, string, 'generate' | 'edit' | 'any'][] = [
    [s.generate, '文生图工作流', 'generate'],
    [s.edit, '改图工作流', 'edit'],
    ...COMFY_PURPOSES.map((p) => [s.purposes[p] ?? '', `「${COMFY_PURPOSE_LABELS[p]}」的工作流`, 'any'] as [string, string, 'any']),
  ];
  for (const [text, label, kind] of all) {
    if (!text.trim()) continue;
    try {
      parseComfyWorkflow(text, label);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    const names = [...text.matchAll(PLACEHOLDER)].map((m) => m[1] ?? '');
    const bad = names.find((n) => !(COMFY_VARS as readonly string[]).includes(n));
    if (bad) return `${label}里的占位符 {{${bad}}} 不认识，可以用：${COMFY_VARS.join('、')}`;
    if (kind === 'edit' && !names.includes('image')) return `${label}里要有 {{image}}（参考图），一般写在 LoadImage 节点的 image 上`;
    if (kind === 'generate' && names.includes('image')) return `${label}里不能有 {{image}}，带参考图的写在改图工作流里`;
    if (!names.includes('prompt')) return `${label}里没有 {{prompt}}，提示词放不进去`;
  }
  return null;
}
