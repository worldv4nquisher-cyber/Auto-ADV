#!/usr/bin/env node
/**
 * Auto-ADV 命令行工具。直接用 Node 运行 TypeScript 源码（Node 22.18+）：
 *   pnpm cli <命令> [参数]
 */
import { parseArgs } from 'node:util';
import {
  computeCost,
  OpenAICompatibleClient,
  PROBE_STEP_LABELS,
  probeCapabilities,
} from '@auto-adv/providers';
import { startMockServer } from '@auto-adv/providers/testing';

const HELP = `Auto-ADV 命令行工具

用法：pnpm cli <命令> [参数]

命令：
  mock-server              启动本地模拟 OpenAI 兼容服务（没有 API Key 时开发调试用）
      --port <端口>        默认 11435
      --key <密钥>         要求请求携带这个密钥（可选）
  models                   列出服务上的模型
  probe                    能力探测
  chat <消息>              流式对话，结束后打印用量

models / probe / chat 的通用参数：
  --base-url <地址>        例如 https://api.deepseek.com/v1
  --key <密钥>             也可以用环境变量 AUTO_ADV_API_KEY
  --model <模型名>         probe / chat 必填
  --system <提示词>        chat 的系统提示词
  --price-in <价格>        每百万输入 token 价格，用来估算花费
  --price-out <价格>       每百万输出 token 价格
`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    'base-url': { type: 'string' },
    key: { type: 'string' },
    model: { type: 'string' },
    system: { type: 'string' },
    port: { type: 'string' },
    'price-in': { type: 'string' },
    'price-out': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

const [command, ...rest] = positionals;

function fail(msg: string): never {
  console.error(`错误：${msg}`);
  process.exit(1);
}

function client(): OpenAICompatibleClient {
  const baseURL = values['base-url'] ?? fail('缺少 --base-url');
  return new OpenAICompatibleClient({ baseURL, apiKey: values.key ?? process.env.AUTO_ADV_API_KEY });
}

async function main() {
  if (!command || values.help) {
    console.log(HELP);
    return;
  }
  switch (command) {
    case 'mock-server': {
      const server = await startMockServer({ port: Number(values.port ?? 11435), apiKey: values.key, chunkDelayMs: 30 });
      console.log(`模拟服务已启动：${server.baseURL}`);
      console.log('在应用里添加接入点时把它填进 Base URL，模型选 mock-chat。按 Ctrl+C 退出。');
      process.on('SIGINT', () => void server.close().then(() => process.exit(0)));
      return;
    }
    case 'models': {
      for (const m of await client().listModels()) console.log(m);
      return;
    }
    case 'probe': {
      const model = values.model ?? fail('缺少 --model');
      const caps = await probeCapabilities(client(), model, {
        onStep: (step, ok, note) => console.log(`${ok ? '✓' : '✕'} ${PROBE_STEP_LABELS[step]}${note ? `：${note}` : ''}`),
      });
      for (const n of caps.notes) console.log(`· ${n}`);
      return;
    }
    case 'chat': {
      const model = values.model ?? fail('缺少 --model');
      const text = rest.join(' ') || fail('缺少消息内容');
      const messages = [
        ...(values.system ? [{ role: 'system' as const, content: values.system }] : []),
        { role: 'user' as const, content: text },
      ];
      const gen = client().chatStream({ model, messages });
      let next = await gen.next();
      let inReasoning = false;
      while (!next.done) {
        const e = next.value;
        if (e.type === 'reasoning') {
          if (!inReasoning) process.stdout.write('\x1b[2m');
          inReasoning = true;
          process.stdout.write(e.delta);
        } else if (e.type === 'text') {
          if (inReasoning) process.stdout.write('\x1b[0m\n\n');
          inReasoning = false;
          process.stdout.write(e.delta);
        }
        next = await gen.next();
      }
      const r = next.value;
      const pricing =
        values['price-in'] || values['price-out']
          ? { input: Number(values['price-in'] ?? 0), output: Number(values['price-out'] ?? 0) }
          : undefined;
      const cost = computeCost(r.usage, pricing);
      console.log(
        `\n\n— 输入 ${r.usage.inputTokens} · 输出 ${r.usage.outputTokens}${r.usage.estimated ? '（估算）' : ''}` +
          ` · 首字 ${r.ttftMs ?? '—'} ms · 总耗时 ${r.latencyMs} ms${cost !== null ? ` · 花费 ${cost}` : ''}`,
      );
      return;
    }
    default:
      fail(`未知命令：${command}\n\n${HELP}`);
  }
}

main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
