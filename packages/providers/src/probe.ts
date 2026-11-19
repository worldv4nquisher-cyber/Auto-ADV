import type { Capabilities } from '@auto-adv/schema';
import { type OpenAICompatibleClient, ProviderError } from './openai-compatible.ts';
import type { ParamFix, RequestOptions } from './types.ts';

export interface ProbeOptions {
  signal?: AbortSignal;
  /** 每完成一项检测回调一次，界面用来显示进度。 */
  onStep?: (step: ProbeStep, ok: boolean, note?: string) => void;
}

export type ProbeStep = 'chat' | 'streaming' | 'jsonSchema' | 'jsonObject' | 'tools';

export const PROBE_STEP_LABELS: Record<ProbeStep, string> = {
  chat: '基础对话',
  streaming: '流式输出',
  jsonSchema: 'JSON Schema 结构化输出',
  jsonObject: 'JSON 模式',
  tools: '工具调用',
};

const MAX_TOKENS = 512;

function tryParseObject(text: string): Record<string, unknown> | null {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
  try {
    const v = JSON.parse(trimmed) as unknown;
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 依次探测一个模型支持哪些能力。基础对话失败会直接抛错（说明地址、密钥或模型名有问题），
 * 其余各项失败只记为不支持。整个过程大约 5 次很短的调用。
 */
export async function probeCapabilities(
  client: OpenAICompatibleClient,
  model: string,
  options: ProbeOptions = {},
): Promise<Capabilities> {
  const { signal, onStep } = options;
  const notes: string[] = [];
  const fixes = new Set<ParamFix>();
  const reqOpts = (): RequestOptions => ({
    signal,
    useMaxCompletionTokens: fixes.has('useMaxCompletionTokens'),
    noTemperature: fixes.has('noTemperature'),
  });
  const rethrowAbort = (err: unknown) => {
    if (err instanceof ProviderError && err.aborted) throw err;
  };

  // 1. 基础对话
  try {
    const r = await client.chat(
      {
        model,
        messages: [
          { role: 'system', content: '这是一次连通性测试。' },
          { role: 'user', content: '只回复两个字母：OK' },
        ],
        temperature: 0,
        maxTokens: MAX_TOKENS,
      },
      reqOpts(),
    );
    r.fixes.forEach((f) => fixes.add(f));
    if (!r.text && r.reasoning) notes.push('该模型会先输出推理内容');
    onStep?.('chat', true);
  } catch (err) {
    onStep?.('chat', false, err instanceof Error ? err.message : String(err));
    throw err;
  }

  // 2. 流式 + 用量
  let streaming = false;
  let streamUsage = false;
  try {
    const gen = client.chatStream(
      { model, messages: [{ role: 'user', content: '从 1 数到 5，用空格分隔。' }], maxTokens: MAX_TOKENS },
      { ...reqOpts(), streamUsage: true },
    );
    let next = await gen.next();
    while (!next.done) next = await gen.next();
    const r = next.value;
    r.fixes.forEach((f) => fixes.add(f));
    streaming = true;
    streamUsage = !r.usage.estimated && !fixes.has('noStreamUsage');
    if (!streamUsage) notes.push('流式输出不返回用量，费用将按字数估算');
    onStep?.('streaming', true);
  } catch (err) {
    rethrowAbort(err);
    notes.push(`流式输出不可用：${err instanceof Error ? err.message : String(err)}`);
    onStep?.('streaming', false);
  }

  // 3. JSON Schema（提示词里不提 JSON，能返回合规 JSON 才说明接口真的按 schema 约束了输出）
  let jsonSchema = false;
  try {
    const r = await client.chat(
      {
        model,
        messages: [{ role: 'user', content: '1 加 1 等于几？' }],
        maxTokens: MAX_TOKENS,
        responseFormat: {
          type: 'json_schema',
          name: 'probe_answer',
          schema: {
            type: 'object',
            properties: { answer: { type: 'string' } },
            required: ['answer'],
            additionalProperties: false,
          },
          strict: true,
        },
      },
      { ...reqOpts(), autoFixParams: false },
    );
    const obj = tryParseObject(r.text);
    jsonSchema = !!obj && typeof obj.answer === 'string';
    onStep?.('jsonSchema', jsonSchema);
  } catch (err) {
    rethrowAbort(err);
    onStep?.('jsonSchema', false);
  }

  // 4. JSON 模式（OpenAI 要求提示词里出现 "json"）
  let jsonObject = false;
  try {
    const r = await client.chat(
      {
        model,
        messages: [{ role: 'user', content: '用一个 json 对象回答，包含字段 answer：1 加 1 等于几？' }],
        maxTokens: MAX_TOKENS,
        responseFormat: { type: 'json_object' },
      },
      { ...reqOpts(), autoFixParams: false },
    );
    jsonObject = tryParseObject(r.text) !== null;
    onStep?.('jsonObject', jsonObject);
  } catch (err) {
    rethrowAbort(err);
    onStep?.('jsonObject', false);
  }

  // 5. 工具调用
  let tools = false;
  try {
    const r = await client.chat(
      {
        model,
        messages: [{ role: 'user', content: '北京今天天气怎么样？请调用工具查询。' }],
        maxTokens: MAX_TOKENS,
        tools: [
          {
            name: 'get_weather',
            description: '查询某个城市今天的天气',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string', description: '城市名' } },
              required: ['city'],
            },
          },
        ],
        toolChoice: 'auto',
      },
      { ...reqOpts(), autoFixParams: false },
    );
    tools = r.toolCalls.some((t) => t.name === 'get_weather');
    onStep?.('tools', tools);
  } catch (err) {
    rethrowAbort(err);
    onStep?.('tools', false);
  }

  if (fixes.has('useMaxCompletionTokens')) notes.push('该模型要求使用 max_completion_tokens 参数');
  if (fixes.has('noTemperature')) notes.push('该模型不支持自定义 temperature');

  return {
    model,
    testedAt: new Date().toISOString(),
    chat: true,
    streaming,
    streamUsage,
    jsonSchema,
    jsonObject,
    tools,
    useMaxCompletionTokens: fixes.has('useMaxCompletionTokens'),
    noTemperature: fixes.has('noTemperature'),
    notes,
  };
}

/** 把能力探测结果转成请求参数。 */
export function requestOptionsFor(caps: Capabilities | undefined): RequestOptions {
  if (!caps) return {};
  return {
    useMaxCompletionTokens: caps.useMaxCompletionTokens,
    noTemperature: caps.noTemperature,
    streamUsage: caps.streamUsage,
  };
}
