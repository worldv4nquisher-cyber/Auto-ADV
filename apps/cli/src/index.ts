#!/usr/bin/env node
/**
 * Auto-ADV 命令行工具。直接用 Node 运行 TypeScript 源码（Node 22.18+）：
 *   pnpm cli <命令> [参数]
 */
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Engine, MemorySecretStore } from '@auto-adv/engine';
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
  genesis [灵感]           不开界面跑一遍一键创世，打印结果（调提示词用）
      --preset <题材>      random / romance / fantasy / mystery / horror / cyberpunk / wuxia / scifi / slice
      --probe              先做能力探测（支持 json_schema 的模型会用上）
      --data-dir <目录>    世界写到哪里，默认系统临时目录下的 auto-adv-cli

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
    preset: { type: 'string' },
    probe: { type: 'boolean' },
    'data-dir': { type: 'string' },
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
    case 'genesis': {
      await genesis();
      return;
    }
    default:
      fail(`未知命令：${command}\n\n${HELP}`);
  }
}

async function genesis() {
  const baseURL = values['base-url'] ?? fail('缺少 --base-url');
  const model = values.model ?? fail('缺少 --model');
  const dataDir = path.resolve(values['data-dir'] ?? path.join(os.tmpdir(), 'auto-adv-cli'));
  mkdirSync(dataDir, { recursive: true });
  const engine = new Engine({ dataDir, secrets: new MemorySecretStore(), timeoutMs: 180_000 });
  try {
    const priced = values['price-in'] || values['price-out'];
    const ep = await engine.saveEndpoint({
      name: 'cli',
      baseURL,
      models: [model],
      currency: 'CNY',
      pricing: priced ? { [model]: { input: Number(values['price-in'] ?? 0), output: Number(values['price-out'] ?? 0) } } : {},
      apiKey: values.key ?? process.env.AUTO_ADV_API_KEY ?? null,
    });
    await engine.setRole('default', { endpointId: ep.id, model });
    const signal = new AbortController().signal;
    if (values.probe) {
      const probe = engine.probe(ep.id, model, { signal });
      for (let n = await probe.next(); !n.done; n = await probe.next()) {
        console.log(`${n.value.ok ? '✓' : '✕'} 探测 ${PROBE_STEP_LABELS[n.value.step]}`);
      }
    }
    const started = Date.now();
    const gen = engine.createWorld(
      { seed: rest.join(' '), preset: values.preset as never, options: {} },
      { signal },
    );
    let worldId = '';
    for (let n = await gen.next(); !n.done; n = await gen.next()) {
      const c = n.value;
      if (c.type === 'world') worldId = c.worldId;
      if (c.type === 'step' && c.state.status !== 'pending') {
        const mark = { running: '…', done: '✓', failed: '✕' }[c.state.status];
        console.log(`${mark} ${c.step}${c.state.error ? `：${c.state.error}` : ''}  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
      }
    }
    const w = await engine.getWorld(worldId);
    console.log(`\n《${w.manifest.title}》${w.manifest.logline}`);
    for (const c of w.characters) console.log(`  · ${c.name}（${c.role}）${c.summary}`);
    console.log(`  地点：${w.locations.map((l) => l.name).join('、')}`);
    console.log(`  设定集：${w.lore.map((l) => l.title).join('、')}`);
    if (w.opening) console.log(`\n${w.opening.narration}`);
    const usage = engine.calls.summary();
    console.log(
      `\n— ${usage.calls} 次调用 · 输入 ${usage.inputTokens} · 输出 ${usage.outputTokens}` +
        `${usage.costs.map((x) => ` · 花费 ${x.total.toFixed(4)} ${x.currency}`).join('')}`,
    );
    console.log(`世界文件夹：${path.join(dataDir, 'worlds', worldId)}`);
  } finally {
    engine.close();
  }
}

main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
