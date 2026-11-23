import type { ChatMessage, ResponseFormat } from '@auto-adv/providers';
import { z } from 'zod';
import type { ModelGateway, ModelHandle } from './gateway.ts';

/** 一种要求模型输出的 JSON 结构。 */
export interface JsonSpec<T> {
  /** 结构名，只用字母数字下划线（会作为 json_schema 的 name）。 */
  name: string;
  schema: z.ZodType<T>;
  /** 给模型看的示例，字段值里可以写说明。比 JSON Schema 更容易被各种模型理解。 */
  example: unknown;
}

export interface GenerateJsonParams<T> {
  system: string;
  user: string;
  spec: JsonSpec<T>;
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  /** 收到的字数（流式进度）。 */
  onProgress?: (chars: number) => void;
  /** 校验失败后最多重试几次，默认 2。 */
  maxRetries?: number;
  /** 结构对了之后的内容检查：返回给模型看的修改意见，没问题返回 null。有意见时和格式错误一样反馈给模型重写。 */
  validate?: (value: T) => string | null;
}

export interface GenerateJsonResult<T> {
  value: T;
  raw: string;
  callIds: string[];
}

export class StructuredOutputError extends Error {
  readonly raw: string;
  constructor(message: string, raw: string) {
    super(message);
    this.name = 'StructuredOutputError';
    this.raw = raw;
  }
}

/** 去掉思考标签和代码块围栏，取出第一个完整的 JSON 对象并解析。宽松处理结尾多余的逗号。 */
export function extractJson(text: string): unknown {
  let t = stripThinking(text).trim();
  const fence = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/.exec(t);
  if (fence?.[1]?.includes('{')) t = fence[1];
  const start = t.indexOf('{');
  if (start < 0) throw new Error('输出里没有 JSON 对象');
  const end = findObjectEnd(t, start);
  if (end < 0) throw new Error('JSON 不完整（可能被截断了）');
  const body = t.slice(start, end + 1);
  try {
    return JSON.parse(body);
  } catch {
    // 常见小毛病：对象或数组末尾多一个逗号
    return JSON.parse(body.replace(/,\s*([}\]])/g, '$1'));
  }
}

/** 去掉部分模型写在正文里的 <think>…</think>。 */
export function stripThinking(text: string): string {
  return text.replace(/^\s*<think>[\s\S]*?(<\/think>|$)/, '');
}

/** 从 start 处的 { 开始，找到与之配对的 }，正确跳过字符串里的括号。 */
function findObjectEnd(t: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function responseFormatFor(h: ModelHandle, spec: JsonSpec<unknown>): ResponseFormat | undefined {
  if (h.caps?.jsonSchema) {
    const schema = z.toJSONSchema(spec.schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
    delete schema.$schema;
    return { type: 'json_schema', name: spec.name, schema, strict: false };
  }
  if (h.caps?.jsonObject) return { type: 'json_object' };
  // 没做能力探测或都不支持：只靠提示词，然后宽松解析
  return undefined;
}

function formatInstructions(spec: JsonSpec<unknown>): string {
  return [
    `只输出一个 JSON 对象（schema 名：${spec.name}），不要输出任何其他文字，不要用代码块包裹。`,
    '格式示例（字段值里的文字是说明，请替换成真实内容）：',
    JSON.stringify(spec.example, null, 2),
  ].join('\n');
}

/**
 * 让模型输出符合 schema 的 JSON。
 * 按能力选择 json_schema / json_object / 纯提示词，解析或校验失败时把错误反馈给模型重试。
 */
export async function generateJson<T>(
  gw: ModelGateway,
  h: ModelHandle,
  p: GenerateJsonParams<T>,
): Promise<GenerateJsonResult<T>> {
  const messages: ChatMessage[] = [
    { role: 'system', content: p.system },
    { role: 'user', content: `${p.user}\n\n${formatInstructions(p.spec as JsonSpec<unknown>)}` },
  ];
  const responseFormat = responseFormatFor(h, p.spec as JsonSpec<unknown>);
  const maxRetries = p.maxRetries ?? 2;
  const callIds: string[] = [];
  let lastError = '';
  let raw = '';

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let chars = 0;
    const result = await gw.run(
      h,
      { messages, responseFormat, temperature: p.temperature, maxTokens: p.maxTokens },
      {
        signal: p.signal,
        onText: (delta) => {
          chars += delta.length;
          p.onProgress?.(chars);
        },
      },
    );
    const id = h.lastCallId();
    if (id) callIds.push(id);
    raw = result.text;

    let problem: string;
    try {
      const parsed = p.spec.schema.safeParse(extractJson(raw));
      if (parsed.success) {
        const issue = p.validate?.(parsed.data) ?? null;
        if (!issue) return { value: parsed.data, raw, callIds };
        problem = issue;
      } else problem = `JSON 不符合要求：\n${z.prettifyError(parsed.error)}`;
    } catch (err) {
      problem = result.finishReason === 'length' ? '输出被截断了（超过长度上限）' : (err as Error).message;
      if (result.finishReason === 'length') problem += '，请把内容写得更精炼一些';
    }
    lastError = problem;
    messages.push(
      { role: 'assistant', content: raw || '（空）' },
      { role: 'user', content: `上面的输出有问题：${problem}\n请修正后重新输出完整的 JSON 对象，只输出 JSON。` },
    );
  }
  throw new StructuredOutputError(`模型没能给出合格的 JSON（已重试 ${maxRetries} 次）：${lastError}`, raw);
}
