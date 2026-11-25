import { z } from 'zod';

/**
 * 自定义接口（通用 HTTP 适配器，ARCHITECTURE.md 19.4）：内置的接口类型不认识的服务，
 * 自己写请求模板、再说明结果在响应的哪里。图像、抠图、音乐、语音职责都能选。
 *
 * 模板里用 {{占位符}}：
 * - 地址、请求头、表单字段里的占位符换成文字；
 * - JSON 请求体里，整个字符串只有一个占位符时（"{{width}}"）按原来的类型放（数字、布尔），
 *   夹在文字里时（"画：{{prompt}}"）换成文字。
 * 每种职责能用哪些占位符见 CUSTOM_API_VARS。
 */

export const CUSTOM_METHODS = ['POST', 'GET', 'PUT'] as const;

/** 结果的编码：auto 自动认（http 链接就下载，data: 开头或 base64 就解码，只有 0-9a-f 就按 hex）。 */
export const CUSTOM_ENCODINGS = ['auto', 'base64', 'hex', 'url'] as const;

/** 一个请求：地址、请求头、请求体。 */
export const CustomRequest = z.object({
  method: z.enum(CUSTOM_METHODS).default('POST'),
  /** 以 / 开头时接在接入点的 Base URL 后面，也可以写完整的 http(s) 地址。 */
  url: z.string().trim().min(1, '请填写请求地址'),
  /** 请求头，JSON 对象的文字，例如 {"Authorization": "Bearer {{apiKey}}"}。 */
  headers: z.string().default('{"Authorization": "Bearer {{apiKey}}"}'),
  /** json：请求体是 JSON；multipart：表单（值是 "{{image}}" 的字段上传图片文件）；none：没有请求体。 */
  bodyType: z.enum(['json', 'multipart', 'none']).default('json'),
  /** 请求体模板，JSON 对象的文字。multipart 时每个键是一个表单字段。 */
  body: z.string().default('{}'),
});
export type CustomRequest = z.infer<typeof CustomRequest>;

/** 一个操作：请求、结果在哪里、出错时怎么认、要不要轮询。 */
export const CustomOperation = CustomRequest.extend({
  /** json：结果在响应的 JSON 里；binary：响应本身就是文件（图片或音频）。 */
  responseType: z.enum(['json', 'binary']).default('json'),
  /** 结果在 JSON 里的位置，例如 data.0.b64_json 或 data[0].url。 */
  resultPath: z.string().trim().default(''),
  encoding: z.enum(CUSTOM_ENCODINGS).default('auto'),
  /** 错误信息的位置，例如 error.message。这里有内容就算失败。 */
  errorPath: z.string().trim().default(''),
  /** 错误码的位置，例如 base_resp.status_code。填了就按它判断：不是 0、也不是空就算失败。 */
  errorCodePath: z.string().trim().default(''),
  /**
   * 异步任务：提交后返回任务 id，再反复查询直到完成。
   * 查询的地址里用 {{id}}；状态在 statusPath，完成时结果按上面的 resultPath 从查询的响应里取。
   */
  poll: z
    .object({
      idPath: z.string().trim().min(1, '请填写任务 id 的位置'),
      method: z.enum(CUSTOM_METHODS).default('GET'),
      url: z.string().trim().min(1, '请填写查询地址'),
      /** 查询的请求体（POST、PUT 时用，JSON 对象的文字，可以用 {{id}}）。空着就不带请求体。 */
      body: z.string().default(''),
      statusPath: z.string().trim().min(1, '请填写任务状态的位置'),
      /** 状态是这些值时算完成（逗号分隔也行，不分大小写）。 */
      done: z.array(z.string()).default(['succeeded', 'success', 'completed', 'done']),
      /** 状态是这些值时算失败。 */
      failed: z.array(z.string()).default(['failed', 'error', 'canceled', 'cancelled']),
      intervalSeconds: z.number().min(0.2).max(60).default(3),
      /** 最多等多久。 */
      maxMinutes: z.number().min(0.1).max(60).default(10),
    })
    .optional(),
});
export type CustomOperation = z.infer<typeof CustomOperation>;

/** 一个媒体职责的自定义接口。request 是主要的操作（文生图、抠图、生成音乐、说一句话），edit 只有图像用（表情差分的改图）。 */
export const CustomApi = z.object({
  request: CustomOperation,
  edit: CustomOperation.optional(),
});
export type CustomApi = z.infer<typeof CustomApi>;

/** 每种职责能用的占位符（apiKey 是接入点的密钥，baseURL 是接入点的地址）。 */
export const CUSTOM_API_VARS = {
  common: ['baseURL', 'apiKey', 'model'],
  image: ['prompt', 'size', 'width', 'height', 'seed', 'transparent'],
  imageEdit: ['image', 'image_base64', 'image_data_url', 'image_mime'],
  cutout: ['image', 'image_base64', 'image_data_url', 'image_mime'],
  music: ['prompt', 'instrumental', 'lyrics'],
  /** text 要说的话；voice 音色 id；speed 语速（1 是正常）；emotion 情绪（没有时是空的）。 */
  voice: ['text', 'voice', 'speed', 'emotion'],
  poll: ['id'],
} as const;

/** 能选自定义接口的职责。 */
export type CustomRole = 'image' | 'cutout' | 'music' | 'voice';

const ROLE_VARS: Record<CustomRole, readonly string[]> = {
  image: CUSTOM_API_VARS.image,
  cutout: CUSTOM_API_VARS.cutout,
  music: CUSTOM_API_VARS.music,
  voice: CUSTOM_API_VARS.voice,
};

const ROLE_LABEL: Record<CustomRole, string> = { image: '文生图请求', cutout: '抠图请求', music: '音乐请求', voice: '语音请求' };

/** 这个职责的主要请求能用的占位符（含 baseURL、apiKey、model）。 */
export function customVarsOf(role: CustomRole): string[] {
  return [...CUSTOM_API_VARS.common, ...ROLE_VARS[role]];
}

const PLACEHOLDER = /\{\{\s*([A-Za-z_]\w*)\s*\}\}/g;

/** 模板文字里用到的占位符。 */
export function placeholdersOf(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((m) => m[1] ?? '');
}

/**
 * 检查一个自定义接口：请求头和请求体是不是合法的 JSON 对象，占位符认不认识。
 * 返回第一个问题（中文），没问题返回 null。
 */
export function checkCustomApi(api: CustomApi, role: CustomRole): string | null {
  const check = (op: CustomOperation, label: string, vars: readonly string[]): string | null => {
    for (const [field, text] of [
      ['请求头', op.headers],
      ['请求体', op.body],
    ] as const) {
      if (field === '请求体' && op.bodyType === 'none') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text || '{}');
      } catch (err) {
        return `${label}的${field}不是合法的 JSON：${err instanceof Error ? err.message : String(err)}`;
      }
      if (field === '请求头' || op.bodyType === 'multipart') {
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return `${label}的${field}要写成 JSON 对象`;
      }
    }
    if ((op.responseType === 'json' || op.poll) && !op.resultPath) return `${label}要填结果在响应里的位置`;
    const allowed = new Set<string>([...CUSTOM_API_VARS.common, ...vars]);
    const texts = [op.url, op.headers, op.bodyType === 'none' ? '' : op.body];
    for (const name of texts.flatMap(placeholdersOf)) {
      if (!allowed.has(name)) return `${label}里的占位符 {{${name}}} 不认识，可以用：${[...allowed].join('、')}`;
    }
    if (op.poll) {
      if (op.poll.body.trim() && op.poll.method !== 'GET') {
        try {
          JSON.parse(op.poll.body);
        } catch (err) {
          return `${label}的查询请求体不是合法的 JSON：${err instanceof Error ? err.message : String(err)}`;
        }
      }
      const pollAllowed = new Set<string>([...allowed, ...CUSTOM_API_VARS.poll]);
      for (const name of [op.poll.url, op.poll.body].flatMap(placeholdersOf)) {
        if (!pollAllowed.has(name)) return `${label}的查询请求里的占位符 {{${name}}} 不认识`;
      }
    }
    return null;
  };
  return (
    check(api.request, ROLE_LABEL[role], ROLE_VARS[role]) ??
    (role === 'image' && api.edit ? check(api.edit, '改图请求', [...CUSTOM_API_VARS.image, ...CUSTOM_API_VARS.imageEdit]) : null)
  );
}

/** 起步用的模板：和内置的几种接口一样的写法，再加一个异步任务的例子，选一个再照着自己的服务改。 */
export interface CustomApiPreset {
  id: string;
  label: string;
  api: CustomApi;
}

const op = (o: Partial<CustomOperation> & Pick<CustomOperation, 'url'>): CustomOperation => CustomOperation.parse(o);

export const CUSTOM_API_PRESETS: Record<CustomRole, CustomApiPreset[]> = {
  image: [
    {
      id: 'openai',
      label: 'OpenAI 风格（返回 base64）',
      api: {
        request: op({
          url: '/images/generations',
          body: JSON.stringify(
            { model: '{{model}}', prompt: '{{prompt}}', size: '{{size}}', n: 1, response_format: 'b64_json' },
            null,
            2,
          ),
          resultPath: 'data.0.b64_json',
          errorPath: 'error.message',
        }),
        edit: op({
          url: '/images/edits',
          bodyType: 'multipart',
          body: JSON.stringify(
            { model: '{{model}}', prompt: '{{prompt}}', size: '{{size}}', n: '1', response_format: 'b64_json', image: '{{image}}' },
            null,
            2,
          ),
          resultPath: 'data.0.b64_json',
          errorPath: 'error.message',
        }),
      },
    },
    {
      id: 'async',
      label: '异步任务（提交后轮询，返回链接）',
      api: {
        request: op({
          url: '/jobs',
          body: JSON.stringify({ model: '{{model}}', prompt: '{{prompt}}', width: '{{width}}', height: '{{height}}', seed: '{{seed}}' }, null, 2),
          resultPath: 'output.url',
          encoding: 'url',
          errorPath: 'error.message',
          poll: { idPath: 'id', method: 'GET', url: '/jobs/{{id}}', body: '', statusPath: 'status', done: ['succeeded'], failed: ['failed'], intervalSeconds: 3, maxMinutes: 10 },
        }),
      },
    },
  ],
  cutout: [
    {
      id: 'rembg',
      label: 'rembg 风格（上传文件，返回 PNG）',
      api: {
        request: op({
          url: '/api/remove',
          headers: '{}',
          bodyType: 'multipart',
          body: JSON.stringify({ file: '{{image}}', model: '{{model}}' }, null, 2),
          responseType: 'binary',
        }),
      },
    },
    {
      id: 'json',
      label: 'JSON（传 base64，返回 base64）',
      api: {
        request: op({
          url: '/remove',
          body: JSON.stringify({ image: '{{image_data_url}}', model: '{{model}}' }, null, 2),
          resultPath: 'image',
          encoding: 'base64',
          errorPath: 'error',
        }),
      },
    },
  ],
  music: [
    {
      id: 'minimax',
      label: 'MiniMax 风格（返回 hex）',
      api: {
        request: op({
          url: '/music_generation',
          body: JSON.stringify(
            {
              model: '{{model}}',
              prompt: '{{prompt}}',
              is_instrumental: '{{instrumental}}',
              lyrics: '{{lyrics}}',
              stream: false,
              output_format: 'hex',
              audio_setting: { sample_rate: 44100, bitrate: 128000, format: 'mp3' },
            },
            null,
            2,
          ),
          resultPath: 'data.audio',
          encoding: 'hex',
          errorPath: 'base_resp.status_msg',
          errorCodePath: 'base_resp.status_code',
        }),
      },
    },
    {
      id: 'async',
      label: '异步任务（提交后轮询，返回链接）',
      api: {
        request: op({
          url: '/jobs',
          body: JSON.stringify({ model: '{{model}}', prompt: '{{prompt}}', instrumental: '{{instrumental}}' }, null, 2),
          resultPath: 'output.url',
          encoding: 'url',
          errorPath: 'error.message',
          poll: { idPath: 'id', method: 'GET', url: '/jobs/{{id}}', body: '', statusPath: 'status', done: ['succeeded'], failed: ['failed'], intervalSeconds: 3, maxMinutes: 10 },
        }),
      },
    },
  ],
  voice: [
    {
      id: 'openai',
      label: 'OpenAI 风格（/audio/speech，返回音频文件）',
      api: {
        request: op({
          url: '/audio/speech',
          body: JSON.stringify({ model: '{{model}}', input: '{{text}}', voice: '{{voice}}', speed: '{{speed}}', response_format: 'mp3' }, null, 2),
          responseType: 'binary',
          errorPath: 'error.message',
        }),
      },
    },
    {
      id: 'minimax',
      label: 'MiniMax 风格（/t2a_v2，返回 hex）',
      api: {
        request: op({
          url: '/t2a_v2',
          body: JSON.stringify(
            {
              model: '{{model}}',
              text: '{{text}}',
              stream: false,
              voice_setting: { voice_id: '{{voice}}', speed: '{{speed}}', emotion: '{{emotion}}' },
              audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
              output_format: 'hex',
            },
            null,
            2,
          ),
          resultPath: 'data.audio',
          encoding: 'hex',
          errorPath: 'base_resp.status_msg',
          errorCodePath: 'base_resp.status_code',
        }),
      },
    },
    {
      id: 'get',
      label: '本地服务（GET，返回音频文件）',
      api: {
        request: op({
          method: 'GET',
          url: '/tts?text={{text}}&voice={{voice}}&speed={{speed}}',
          headers: '{}',
          bodyType: 'none',
          responseType: 'binary',
        }),
      },
    },
  ],
};
