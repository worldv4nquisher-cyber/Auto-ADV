import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * 一个本地的模拟 OpenAI 兼容服务，用于测试和没有 API Key 时的开发调试。
 * 各项开关可以模拟不同服务商的"兼容程度"。
 */
export interface MockServerOptions {
  /** 设置后要求请求带 Authorization: Bearer <apiKey>。 */
  apiKey?: string;
  models?: string[];
  /** 是否支持 stream_options（默认 true）；false 时带 stream_options 的请求返回 400。 */
  streamUsage?: boolean;
  /** 是否按 json_schema 约束输出（默认 true）；false 时忽略 response_format。 */
  jsonSchema?: boolean;
  /** 是否支持 json_object（默认 true）。 */
  jsonObject?: boolean;
  /** 是否支持工具调用（默认 true）。 */
  tools?: boolean;
  /** 模拟只接受 max_completion_tokens 的推理模型。 */
  requireMaxCompletionTokens?: boolean;
  /** 前 N 次对话请求返回 429。 */
  failFirst?: number;
  /** 流式分片之间的间隔，默认 5 毫秒。 */
  chunkDelayMs?: number;
  /** 在正文前输出的推理内容（模拟 DeepSeek 的 reasoning_content）。 */
  reasoning?: string;
  /** 自定义回复。 */
  reply?: (lastUserMessage: string) => string;
  /** 绑定的主机，默认 127.0.0.1。 */
  host?: string;
  port?: number;
}

export interface MockServer {
  /** 形如 http://127.0.0.1:12345/v1 */
  baseURL: string;
  /** 收到的所有对话请求体。 */
  requests: Record<string, unknown>[];
  close(): Promise<void>;
}

interface WireMessage {
  role: string;
  content: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function defaultReply(last: string): string {
  if (last.includes('只回复两个字母')) return 'OK';
  if (last.includes('从 1 数到 5')) return '1 2 3 4 5';
  return `你好！我是 Auto-ADV 的模拟模型，不会真的思考。你刚才说的是：「${last}」`;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

function chunk(text: string, size: number): string[] {
  const chars = [...text];
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(''));
  return out;
}

export async function startMockServer(options: MockServerOptions = {}): Promise<MockServer> {
  const opts = {
    streamUsage: true,
    jsonSchema: true,
    jsonObject: true,
    tools: true,
    chunkDelayMs: 5,
    models: ['mock-chat', 'mock-reasoner'],
    ...options,
  };
  const requests: Record<string, unknown>[] = [];
  let chatCount = 0;

  const server = http.createServer(async (req, res) => {
    try {
      if (opts.apiKey && req.headers.authorization !== `Bearer ${opts.apiKey}`) {
        return sendJson(res, 401, { error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } });
      }
      const path = (req.url ?? '').replace(/\?.*$/, '');
      if (req.method === 'GET' && path === '/v1/models') {
        return sendJson(res, 200, { object: 'list', data: opts.models.map((id) => ({ id, object: 'model' })) });
      }
      if (req.method !== 'POST' || path !== '/v1/chat/completions') {
        return sendJson(res, 404, { error: { message: `Not found: ${req.method} ${path}` } });
      }

      let raw = '';
      for await (const part of req) raw += part;
      const body = JSON.parse(raw) as Record<string, unknown>;
      requests.push(body);
      chatCount++;

      if (opts.failFirst && chatCount <= opts.failFirst) {
        return sendJson(res, 429, { error: { message: 'Rate limit reached' } }, { 'retry-after': '0' });
      }
      if (opts.requireMaxCompletionTokens && body.max_tokens !== undefined) {
        return sendJson(res, 400, {
          error: {
            message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
          },
        });
      }
      if (body.stream && body.stream_options && !opts.streamUsage) {
        return sendJson(res, 400, { error: { message: 'Unrecognized request argument supplied: stream_options' } });
      }

      const messages = (body.messages as WireMessage[]) ?? [];
      const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      const rf = body.response_format as { type?: string } | undefined;
      const wantsTool = opts.tools && Array.isArray(body.tools) && body.tools.length > 0;

      let text = '';
      let toolCall: { id: string; name: string; arguments: string } | null = null;
      if (wantsTool) {
        toolCall = { id: 'call_mock_1', name: 'get_weather', arguments: JSON.stringify({ city: '北京' }) };
      } else if (rf?.type === 'json_schema' && opts.jsonSchema) {
        text = JSON.stringify({ answer: '2' });
      } else if (rf?.type === 'json_object' && opts.jsonObject) {
        text = JSON.stringify({ answer: '2' });
      } else {
        text = (opts.reply ?? defaultReply)(lastUser);
      }
      const reasoning = opts.reasoning ?? '';
      const model = String(body.model ?? 'mock-chat');
      const promptTokens = messages.reduce((s, m) => s + [...String(m.content)].length, 0);
      const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: [...text].length + [...reasoning].length + (toolCall ? 10 : 0),
        total_tokens: 0,
        prompt_tokens_details: { cached_tokens: 0 },
      };
      usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
      const finish = toolCall ? 'tool_calls' : 'stop';

      if (!body.stream) {
        const message: Record<string, unknown> = { role: 'assistant', content: toolCall ? null : text };
        if (reasoning) message.reasoning_content = reasoning;
        if (toolCall) {
          message.tool_calls = [
            { id: toolCall.id, type: 'function', function: { name: toolCall.name, arguments: toolCall.arguments } },
          ];
        }
        return sendJson(res, 200, {
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          model,
          choices: [{ index: 0, message, finish_reason: finish }],
          usage,
        });
      }

      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
      const send = async (payload: unknown) => {
        res.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`);
        if (opts.chunkDelayMs) await sleep(opts.chunkDelayMs);
      };
      const base = { id: 'chatcmpl-mock', object: 'chat.completion.chunk', model };
      await send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
      for (const piece of chunk(reasoning, 3)) {
        await send({ ...base, choices: [{ index: 0, delta: { reasoning_content: piece }, finish_reason: null }] });
      }
      if (toolCall) {
        await send({
          ...base,
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, id: toolCall.id, type: 'function', function: { name: toolCall.name, arguments: '' } }] },
              finish_reason: null,
            },
          ],
        });
        for (const piece of chunk(toolCall.arguments, 5)) {
          await send({
            ...base,
            choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] }, finish_reason: null }],
          });
        }
      }
      for (const piece of chunk(text, 2)) {
        await send({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
      }
      await send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] });
      const so = body.stream_options as { include_usage?: boolean } | undefined;
      if (so?.include_usage) await send({ ...base, choices: [], usage });
      await send('[DONE]');
      res.end();
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { error: { message: String(err) } });
      else res.end();
    }
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://${opts.host ?? '127.0.0.1'}:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
