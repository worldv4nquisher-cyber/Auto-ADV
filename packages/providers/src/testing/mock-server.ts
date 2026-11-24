import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { type MockMessage, type MockRequestInfo, schemaNameOf, storyReply } from './mock-story.ts';
import { mockImage } from './png.ts';

export type { MockRequestInfo } from './mock-story.ts';
export { encodePng, mockImage } from './png.ts';

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
  /** 把推理写进正文开头的 <think>…</think>（模拟 MiniMax M2 / M3 等模型）。 */
  thinkInContent?: boolean;
  /** 自定义回复；返回 undefined 时走内置逻辑（故事模型 → 默认回复）。 */
  reply?: (lastUserMessage: string, info: MockRequestInfo) => string | undefined;
  /** 内置的故事模型（认出创世和游玩请求并返回固定内容），默认开启。 */
  story?: boolean;
  /** 图像接口（/v1/images/generations）每张图的延迟，默认 0。 */
  imageDelayMs?: number;
  /** 前 N 次图像请求返回 500。 */
  imageFailFirst?: number;
  /** 提示词里含有这段文字的图像请求总是返回 400（测试失败的槽）。 */
  imageRejectIf?: string;
  /** 图像接口返回 url 而不是 b64_json（模拟 MiniMax 的 OSS 链接）。 */
  imageUrl?: boolean;
  /** 模拟不认识 response_format 的服务（例如 gpt-image-1）：带了就返回 400。 */
  imageNoResponseFormat?: boolean;
  /** 绑定的主机，默认 127.0.0.1。 */
  host?: string;
  port?: number;
}

export interface MockServer {
  /** 形如 http://127.0.0.1:12345/v1 */
  baseURL: string;
  /** 收到的所有对话请求体。 */
  requests: Record<string, unknown>[];
  /** 收到的所有图像请求体。 */
  imageRequests: Record<string, unknown>[];
  close(): Promise<void>;
}

type WireMessage = MockMessage;

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
    story: true,
    models: ['mock-chat', 'mock-reasoner'],
    ...options,
  };
  const requests: Record<string, unknown>[] = [];
  const imageRequests: Record<string, unknown>[] = [];
  const files = new Map<string, Buffer>();
  let chatCount = 0;
  let imageCount = 0;

  const server = http.createServer(async (req, res) => {
    try {
      if (opts.apiKey && req.headers.authorization !== `Bearer ${opts.apiKey}`) {
        return sendJson(res, 401, { error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } });
      }
      const path = (req.url ?? '').replace(/\?.*$/, '');
      if (req.method === 'GET' && path.startsWith('/files/')) {
        const file = files.get(path.slice('/files/'.length));
        if (!file) return sendJson(res, 404, { error: { message: 'expired' } });
        res.writeHead(200, { 'Content-Type': 'image/png' });
        return res.end(file);
      }
      if (req.method === 'POST' && path === '/v1/images/generations') {
        let raw = '';
        for await (const part of req) raw += part;
        const body = JSON.parse(raw) as Record<string, unknown>;
        imageRequests.push(body);
        imageCount++;
        if (opts.imageDelayMs) await sleep(opts.imageDelayMs);
        if (opts.imageFailFirst && imageCount <= opts.imageFailFirst) {
          return sendJson(res, 500, { error: { message: 'image service busy' } });
        }
        if (opts.imageNoResponseFormat && body.response_format !== undefined) {
          return sendJson(res, 400, { error: { message: "Unknown parameter: 'response_format'." } });
        }
        const prompt = String(body.prompt ?? '');
        if (opts.imageRejectIf && prompt.includes(opts.imageRejectIf)) {
          return sendJson(res, 400, { error: { message: 'prompt rejected by safety system' } });
        }
        // 按请求的比例出一张小图，测试不用真的传几兆的图片
        const [w, h] = String(body.size ?? '1024x1024').split('x').map(Number) as [number, number];
        const scale = 96 / Math.max(w || 1024, h || 1024);
        const png = mockImage(prompt, Math.max(8, Math.round((w || 1024) * scale)), Math.max(8, Math.round((h || 1024) * scale)));
        const item: Record<string, unknown> = { revised_prompt: `（改写）${prompt.slice(0, 40)}` };
        if (opts.imageUrl) {
          const id = `img${imageCount}.png`;
          files.set(id, png);
          item.url = `http://${opts.host ?? '127.0.0.1'}:${(server.address() as AddressInfo).port}/files/${id}`;
        } else {
          item.b64_json = png.toString('base64');
        }
        return sendJson(res, 200, { created: Math.floor(Date.now() / 1000), data: [item] });
      }
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

      const info: MockRequestInfo = { messages, schemaName: schemaNameOf(body, messages), count: chatCount };
      const custom = opts.reply?.(lastUser, info) ?? (opts.story ? storyReply(info) : undefined);
      let text = '';
      let toolCall: { id: string; name: string; arguments: string } | null = null;
      if (wantsTool) {
        toolCall = { id: 'call_mock_1', name: 'get_weather', arguments: JSON.stringify({ city: '北京' }) };
      } else if (custom !== undefined) {
        text = custom;
      } else if (rf?.type === 'json_schema' && opts.jsonSchema) {
        text = JSON.stringify({ answer: '2' });
      } else if (rf?.type === 'json_object' && opts.jsonObject) {
        text = JSON.stringify({ answer: '2' });
      } else {
        text = defaultReply(lastUser);
      }
      let reasoning = opts.reasoning ?? '';
      if (opts.thinkInContent && !toolCall) {
        text = `<think>${reasoning || '先想一想。'}</think>\n\n${text}`;
        reasoning = '';
      }
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
      // 长文本分成大约 200 片，避免测试太慢
      for (const piece of chunk(text, Math.max(2, Math.ceil([...text].length / 200)))) {
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
    imageRequests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
