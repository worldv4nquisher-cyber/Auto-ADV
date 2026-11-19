import { afterEach, describe, expect, it } from 'vitest';
import {
  buildRequestBody,
  computeCost,
  estimateTokens,
  type ExchangeRecord,
  normalizeBaseURL,
  OpenAICompatibleClient,
  probeCapabilities,
  ProviderError,
  type StreamEvent,
} from '../src/index.ts';
import { type MockServer, type MockServerOptions, startMockServer } from '../src/testing/mock-server.ts';

let server: MockServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function setup(opts: MockServerOptions = {}) {
  server = await startMockServer({ chunkDelayMs: 0, ...opts });
  const records: ExchangeRecord[] = [];
  const client = new OpenAICompatibleClient({
    baseURL: server.baseURL,
    apiKey: opts.apiKey,
    retryBaseDelayMs: 1,
    onExchange: (r) => records.push(r),
  });
  return { client, records, server };
}

async function drain(gen: AsyncGenerator<StreamEvent, unknown>) {
  const events: StreamEvent[] = [];
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  return { events, result: next.value };
}

describe('normalizeBaseURL', () => {
  it('去掉结尾斜杠和 /chat/completions', () => {
    expect(normalizeBaseURL(' https://api.deepseek.com/v1/ ')).toBe('https://api.deepseek.com/v1');
    expect(normalizeBaseURL('https://x.com/v1/chat/completions')).toBe('https://x.com/v1');
    expect(normalizeBaseURL('http://localhost:11434/v1')).toBe('http://localhost:11434/v1');
  });
});

describe('buildRequestBody', () => {
  const req = { model: 'm', messages: [{ role: 'user' as const, content: 'hi' }], temperature: 0.7, maxTokens: 100 };

  it('按能力调整参数', () => {
    expect(buildRequestBody(req, {}, false)).toMatchObject({ max_tokens: 100, temperature: 0.7 });
    const fixed = buildRequestBody(req, { useMaxCompletionTokens: true, noTemperature: true }, false);
    expect(fixed).toMatchObject({ max_completion_tokens: 100 });
    expect(fixed).not.toHaveProperty('max_tokens');
    expect(fixed).not.toHaveProperty('temperature');
  });

  it('流式请求默认带 include_usage，可关闭', () => {
    expect(buildRequestBody(req, {}, true)).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(buildRequestBody(req, { streamUsage: false }, true)).not.toHaveProperty('stream_options');
  });

  it('json_schema 与工具转换为接口格式', () => {
    const body = buildRequestBody(
      {
        ...req,
        responseFormat: { type: 'json_schema', name: 'x', schema: { type: 'object' } },
        tools: [{ name: 't', parameters: { type: 'object' } }],
        toolChoice: { name: 't' },
      },
      {},
      false,
    );
    expect(body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'x', schema: { type: 'object' }, strict: true } });
    expect(body.tools).toEqual([{ type: 'function', function: { name: 't', description: '', parameters: { type: 'object' } } }]);
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 't' } });
  });
});

describe('OpenAICompatibleClient', () => {
  it('非流式对话返回文本与用量，并记录日志', async () => {
    const { client, records } = await setup({ apiKey: 'sk-test' });
    const r = await client.chat({ model: 'mock-chat', messages: [{ role: 'user', content: '你好' }] });
    expect(r.text).toContain('你好');
    expect(r.usage.estimated).toBe(false);
    expect(r.usage.inputTokens).toBeGreaterThan(0);
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe('ok');
    expect(JSON.stringify(records[0]?.request)).not.toContain('sk-test');
  });

  it('密钥错误时给出可读的中文错误', async () => {
    server = await startMockServer({ apiKey: 'right' });
    const client = new OpenAICompatibleClient({ baseURL: server.baseURL, apiKey: 'wrong', maxRetries: 0 });
    await expect(client.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/API Key 无效/);
  });

  it('流式对话逐字产出，并拿到推理内容和用量', async () => {
    const { client, records } = await setup({ reasoning: '先想一想。' });
    const { events, result } = await drain(
      client.chatStream({ model: 'mock-chat', messages: [{ role: 'user', content: '讲个故事' }] }),
    );
    const text = events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('');
    expect(text).toContain('讲个故事');
    expect(result).toMatchObject({ reasoning: '先想一想。', finishReason: 'stop' });
    expect((result as { usage: { estimated: boolean } }).usage.estimated).toBe(false);
    expect((result as { ttftMs: number }).ttftMs).not.toBeNull();
    expect(records.at(-1)?.status).toBe('ok');
  });

  it('流式工具调用会把参数拼完整', async () => {
    const { client } = await setup();
    const { result } = await drain(
      client.chatStream({
        model: 'mock-chat',
        messages: [{ role: 'user', content: '天气' }],
        tools: [{ name: 'get_weather', parameters: { type: 'object' } }],
      }),
    );
    const calls = (result as { toolCalls: { name: string; arguments: string }[] }).toolCalls;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('get_weather');
    expect(JSON.parse(calls[0]?.arguments ?? '')).toEqual({ city: '北京' });
  });

  it('429 自动重试', async () => {
    const { client, records } = await setup({ failFirst: 2 });
    const r = await client.chat({ model: 'mock-chat', messages: [{ role: 'user', content: 'x' }] });
    expect(r.text).toBeTruthy();
    expect(records.map((x) => x.status)).toEqual(['error', 'error', 'ok']);
  });

  it('自动改用 max_completion_tokens 并报告修正', async () => {
    const { client } = await setup({ requireMaxCompletionTokens: true });
    const r = await client.chat({ model: 'mock-reasoner', messages: [{ role: 'user', content: 'x' }], maxTokens: 50 });
    expect(r.fixes).toEqual(['useMaxCompletionTokens']);
  });

  it('不支持 stream_options 时自动去掉，用量改为估算', async () => {
    const { client } = await setup({ streamUsage: false });
    const { result } = await drain(client.chatStream({ model: 'mock-chat', messages: [{ role: 'user', content: '你好' }] }));
    expect((result as { fixes: string[] }).fixes).toEqual(['noStreamUsage']);
    expect((result as { usage: { estimated: boolean } }).usage.estimated).toBe(true);
  });

  it('中途取消会记为 aborted 并保留已收到的文本', async () => {
    const { client, records } = await setup({ chunkDelayMs: 20, reply: () => '这是一段比较长的回复，用来测试中途取消。' });
    const ctrl = new AbortController();
    const gen = client.chatStream({ model: 'mock-chat', messages: [{ role: 'user', content: 'x' }] }, { signal: ctrl.signal });
    await gen.next();
    await gen.next();
    ctrl.abort();
    await expect(drain(gen)).rejects.toMatchObject({ aborted: true });
    const last = records.at(-1);
    expect(last?.status).toBe('aborted');
    expect(last?.partialText.length).toBeGreaterThan(0);
  });

  it('提前停止迭代也记为 aborted', async () => {
    const { client, records } = await setup({ chunkDelayMs: 5 });
    for await (const _ of client.chatStream({ model: 'mock-chat', messages: [{ role: 'user', content: 'x' }] })) {
      break;
    }
    expect(records.at(-1)?.status).toBe('aborted');
  });

  it('连不上服务时提示检查服务', async () => {
    const client = new OpenAICompatibleClient({ baseURL: 'http://127.0.0.1:9/v1', maxRetries: 0 });
    const err = await client.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).message).toMatch(/无法连接/);
  });

  it('拉取模型列表', async () => {
    const { client } = await setup({ models: ['b', 'a'] });
    expect(await client.listModels()).toEqual(['a', 'b']);
  });
});

describe('probeCapabilities', () => {
  it('全能力服务', async () => {
    const { client } = await setup();
    const caps = await probeCapabilities(client, 'mock-chat');
    expect(caps).toMatchObject({ chat: true, streaming: true, streamUsage: true, jsonSchema: true, jsonObject: true, tools: true });
  });

  it('能力有限的服务', async () => {
    const { client } = await setup({ streamUsage: false, jsonSchema: false, tools: false, requireMaxCompletionTokens: true });
    const steps: string[] = [];
    const caps = await probeCapabilities(client, 'mock-reasoner', { onStep: (s, ok) => steps.push(`${s}:${ok}`) });
    expect(caps).toMatchObject({
      chat: true,
      streaming: true,
      streamUsage: false,
      jsonSchema: false,
      jsonObject: true,
      tools: false,
      useMaxCompletionTokens: true,
    });
    expect(steps).toEqual(['chat:true', 'streaming:true', 'jsonSchema:false', 'jsonObject:true', 'tools:false']);
  });

  it('基础对话失败时直接报错', async () => {
    server = await startMockServer({ apiKey: 'right' });
    const client = new OpenAICompatibleClient({ baseURL: server.baseURL, apiKey: 'wrong', maxRetries: 0 });
    await expect(probeCapabilities(client, 'mock-chat')).rejects.toThrow(/401/);
  });
});

describe('计费与估算', () => {
  it('按每百万 token 计费，缓存部分按缓存价', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 500_000, cachedInputTokens: 400_000, reasoningTokens: 0, estimated: false };
    expect(computeCost(usage, { input: 2, output: 8, cachedInput: 0.5 })).toBeCloseTo(0.6 * 2 + 0.4 * 0.5 + 0.5 * 8);
    expect(computeCost(usage, undefined)).toBeNull();
  });

  it('中文按字估算', () => {
    expect(estimateTokens('你好世界')).toBe(4);
    expect(estimateTokens('hello world!')).toBe(3);
  });
});
