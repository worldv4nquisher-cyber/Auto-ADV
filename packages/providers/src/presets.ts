/** 常见 OpenAI 兼容服务的预设，添加接入点时一键填好地址。 */
export interface EndpointPreset {
  id: string;
  name: string;
  baseURL: string;
  currency: 'USD' | 'CNY';
  needsKey: boolean;
  note?: string;
}

export const ENDPOINT_PRESETS: EndpointPreset[] = [
  { id: 'openai', name: 'OpenAI', baseURL: 'https://api.openai.com/v1', currency: 'USD', needsKey: true },
  { id: 'deepseek', name: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', currency: 'CNY', needsKey: true },
  {
    id: 'dashscope',
    name: '通义千问（阿里云百炼）',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    currency: 'CNY',
    needsKey: true,
  },
  { id: 'moonshot', name: 'Kimi（月之暗面）', baseURL: 'https://api.moonshot.cn/v1', currency: 'CNY', needsKey: true },
  { id: 'zhipu', name: '智谱 GLM', baseURL: 'https://open.bigmodel.cn/api/paas/v4', currency: 'CNY', needsKey: true },
  { id: 'siliconflow', name: '硅基流动', baseURL: 'https://api.siliconflow.cn/v1', currency: 'CNY', needsKey: true },
  { id: 'openrouter', name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', currency: 'USD', needsKey: true },
  {
    id: 'ollama',
    name: 'Ollama（本地）',
    baseURL: 'http://localhost:11434/v1',
    currency: 'USD',
    needsKey: false,
    note: '本地运行免费，价格可以留空',
  },
  {
    id: 'lmstudio',
    name: 'LM Studio（本地）',
    baseURL: 'http://localhost:1234/v1',
    currency: 'USD',
    needsKey: false,
    note: '本地运行免费，价格可以留空',
  },
  {
    id: 'comfyui',
    name: 'ComfyUI（本地生图）',
    baseURL: 'http://127.0.0.1:8188',
    currency: 'CNY',
    needsKey: false,
    note: '只用在「图像」职责上：职责路由里接口类型选 ComfyUI，模型从 ComfyUI 读取',
  },
];
