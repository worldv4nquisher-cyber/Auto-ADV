#!/usr/bin/env node
/**
 * Auto-ADV 命令行工具。直接用 Node 运行 TypeScript 源码（Node 22.18+）：
 *   pnpm cli <命令> [参数]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  analyzeRun,
  Engine,
  MemorySecretStore,
  type PathEvent,
  type PlayRef,
  runTranscript,
  totalCost,
} from '@auto-adv/engine';
import {
  computeCost,
  OpenAICompatibleClient,
  PROBE_STEP_LABELS,
  probeCapabilities,
} from '@auto-adv/providers';
import { type MockServer, startMockServer } from '@auto-adv/providers/testing';

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
  observe [灵感]           无人值守跑观察模式，打印质量报告并写出全文记录（调导演和演员的提示词用）
      --beats <N>          跑多少拍，默认 30
      --world <世界 id>    用 --data-dir 里已有的世界；不给就先创世
      --split              分演模式（旁白 + 各演员分开生成），默认合并模式
      --ensemble           群像视角，默认围绕主角
      --budget-tokens <N>  token 预算，默认 2000000
      --rpm <N>            每分钟最多几拍，默认不限
      --out <文件>         全文记录写到哪里，默认 <data-dir>/observe-<时间>.md

genesis / observe 都可以加 --mock：用内置模拟服务跑通流程，不需要 API Key。

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
    mock: { type: 'boolean' },
    beats: { type: 'string' },
    world: { type: 'string' },
    split: { type: 'boolean' },
    ensemble: { type: 'boolean' },
    'budget-tokens': { type: 'string' },
    rpm: { type: 'string' },
    out: { type: 'string' },
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
    case 'observe': {
      await observe();
      return;
    }
    default:
      fail(`未知命令：${command}\n\n${HELP}`);
  }
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** 起一个引擎并配好接入点（--mock 时连内置模拟服务）。 */
async function makeEngine() {
  let mock: MockServer | null = null;
  let baseURL = values['base-url'];
  let model = values.model;
  if (values.mock) {
    mock = await startMockServer({ chunkDelayMs: 0 });
    baseURL = mock.baseURL;
    model = 'mock-chat';
  }
  if (!baseURL) fail('缺少 --base-url（或者加 --mock 用模拟服务）');
  if (!model) fail('缺少 --model');
  const dataDir = path.resolve(values['data-dir'] ?? path.join(os.tmpdir(), 'auto-adv-cli'));
  mkdirSync(dataDir, { recursive: true });
  const engine = new Engine({ dataDir, secrets: new MemorySecretStore(), timeoutMs: 180_000 });
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
  if (values.probe) {
    const probe = engine.probe(ep.id, model, { signal: new AbortController().signal });
    for (let n = await probe.next(); !n.done; n = await probe.next()) {
      console.log(`${n.value.ok ? '✓' : '✕'} 探测 ${PROBE_STEP_LABELS[n.value.step]}`);
    }
  }
  return {
    engine,
    dataDir,
    async close() {
      engine.close();
      await mock?.close();
    },
  };
}

async function createWorld(engine: Engine, seed: string): Promise<string> {
  const started = Date.now();
  const gen = engine.createWorld({ seed, preset: values.preset as never, options: {} }, { signal: new AbortController().signal });
  let worldId = '';
  for (let n = await gen.next(); !n.done; n = await gen.next()) {
    const c = n.value;
    if (c.type === 'world') worldId = c.worldId;
    if (c.type === 'step' && c.state.status !== 'pending') {
      const mark = { running: '…', done: '✓', failed: '✕' }[c.state.status];
      console.log(`${mark} ${c.step}${c.state.error ? `：${c.state.error}` : ''}  (${seconds(Date.now() - started)})`);
    }
  }
  const w = await engine.getWorld(worldId);
  if (w.summary.status !== 'ready') fail('创世没有完成，见上面的错误');
  return worldId;
}

async function genesis() {
  const { engine, dataDir, close } = await makeEngine();
  try {
    const worldId = await createWorld(engine, rest.join(' '));
    const w = await engine.getWorld(worldId);
    console.log(`\n《${w.manifest.title}》${w.manifest.logline}`);
    for (const c of w.characters) console.log(`  · ${c.name}（${c.role}）${c.summary}`);
    console.log(`  地点：${w.locations.map((l) => l.name).join('、')}`);
    console.log(`  设定集：${w.lore.map((l) => l.title).join('、')}`);
    if (w.plot) {
      for (const ch of w.plot.acts.flatMap((a) => a.chapters)) console.log(`  [${ch.title}] ${ch.goal}`);
    }
    if (w.opening) console.log(`\n${w.opening.narration}`);
    const usage = engine.calls.summary();
    console.log(
      `\n— ${usage.calls} 次调用 · 输入 ${usage.inputTokens} · 输出 ${usage.outputTokens}` +
        `${usage.costs.map((x) => ` · 花费 ${x.total.toFixed(4)} ${x.currency}`).join('')}`,
    );
    console.log(`世界文件夹：${path.join(dataDir, 'worlds', worldId)}`);
  } finally {
    await close();
  }
}

/** 无人值守跑观察模式：观众"读"得和生成一样快，跑够 N 拍或被安全阀叫停后打印质量报告。 */
async function observe() {
  const { engine, dataDir, close } = await makeEngine();
  try {
    const worldId = values.world ?? (await createWorld(engine, rest.join(' ')));
    const target = Math.max(1, Number(values.beats ?? 30));
    const started = Date.now();
    const view = await engine.play.start({
      worldId,
      mode: 'observer',
      title: `cli ${new Date().toLocaleString()}`,
      observer: {
        strategy: values.split ? 'split' : 'merged',
        focus: values.ensemble ? 'ensemble' : 'protagonist',
        bufferAhead: 1,
        maxBeatsPerMinute: Number(values.rpm ?? 0),
        ...(values['budget-tokens'] ? { budgetTokens: Number(values['budget-tokens']) } : {}),
      },
    });
    const ref: PlayRef = { worldId, playthroughId: view.playthrough.id };
    const world = await engine.worlds.load(worldId);
    const ac = new AbortController();
    let count = 0;
    let beatStart = Date.now();
    let stopReason: string | null = null;
    let lastError: string | null = null;
    const latencies: number[] = [];

    const printBeat = (e: PathEvent, ms: number) => {
      const b = e.beat;
      const flags = [b?.arc ? '新篇章' : '', b?.card ? `事件卡：${b.card.split('：')[0]}` : '', b?.done?.length ? `完成 ${b.done.length} 个节拍` : '']
        .filter(Boolean)
        .join(' · ');
      console.log(`\n#${count}（${seconds(ms)}）${b?.time ? `［${b.time}］` : ''}${flags ? `［${flags}］` : ''}`);
      console.log(`  导演：${b?.plan ?? ''}`);
      for (const s of e.segments ?? []) console.log(`  ${s.kind === 'line' ? `【${s.name}】` : ''}${s.text}`);
    };

    const finished = new Promise<void>((resolve) => {
      const onSigint = () => {
        stopReason = '手动中止';
        resolve();
      };
      process.once('SIGINT', onSigint);
      void engine.play
        .observerWatch(
          ref,
          (c) => {
            if (c.type === 'beat-start') beatStart = Date.now();
            if (c.type === 'event' && c.event.kind === 'ai') {
              count++;
              latencies.push(Date.now() - beatStart);
              printBeat(c.event, Date.now() - beatStart);
              // 够数了就不再"读"，生成器会停在缓冲上
              if (count >= target) resolve();
              else engine.play.observerRead(ref, c.event.id);
            }
            if (c.type === 'status' && !c.status.running && c.status.stopReason) {
              stopReason = { budget: '达到预算上限', errors: '连续失败', takeover: '接管' }[c.status.stopReason];
              lastError = c.status.lastError;
              resolve();
            }
            if (c.type === 'status' && c.status.activity === 'backoff' && c.status.lastError) {
              console.log(`  ✕ 失败（第 ${c.status.failures} 次）：${c.status.lastError}`);
            }
          },
          ac.signal,
        )
        .finally(() => process.off('SIGINT', onSigint));
    });
    await engine.play.observerControl(ref, 'play');
    await finished;
    await engine.play.observer.halt(ref);
    ac.abort();

    const v = await engine.play.view(ref);
    const r = analyzeRun(world, v.path);
    const u = v.playthrough.usage;
    const calls = engine.calls
      .list(100_000)
      .items.filter((c) => c.ts >= started);
    const byTag = new Map<string, { n: number; ms: number; failed: number }>();
    for (const c of calls) {
      const k = c.tag ?? c.role;
      const t = byTag.get(k) ?? { n: 0, ms: 0, failed: 0 };
      t.n++;
      t.ms += c.latencyMs;
      if (c.status === 'error') t.failed++;
      byTag.set(k, t);
    }
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const out = path.resolve(values.out ?? path.join(dataDir, `observe-${new Date().toISOString().replace(/[:.]/g, '-')}.md`));
    writeFileSync(out, runTranscript(world, v.path), 'utf8');

    const rows: [string, string][] = [
      ['拍数', `${r.beats}（目标 ${target}）${stopReason ? `，${stopReason}${lastError ? `：${lastError}` : ''}` : ''}`],
      ['用时', `${seconds(Date.now() - started)}，平均每拍 ${seconds(avg(latencies))}，最慢 ${seconds(Math.max(0, ...latencies))}`],
      ['篇幅', `平均每拍 ${r.avgChars} 字`],
      ['重复', `平均相似度 ${r.similarity.avg}，最高 ${r.similarity.max}，超过阈值 ${r.similarity.repeated} 拍`],
      ['停滞', `最长连续 ${r.longestStall} 拍没有推进，抽了 ${r.cards} 张事件卡`],
      [
        '剧情',
        `完成节拍 ${r.plot.done}/${r.plot.total}，续写篇章 ${r.plot.arcs} 次，当前章节：${r.plot.currentChapter ?? '（全部完成）'}${r.time ? `，故事时间：${r.time}` : ''}`,
      ],
      ['场景', `换了 ${r.sceneChanges} 次地点：${r.locations.join('、')}`],
      ['台词', r.speakers.map((s) => `${s.name} ${s.lines}`).join(' · ') || '（无）'],
      ['秘密', `揭开 ${r.reveals} 次；导演被驳回 ${r.rejected} 个动作`],
      [
        '用量',
        `${u.calls} 次调用 · 输入 ${u.inputTokens} · 输出 ${u.outputTokens}${
          Object.keys(u.costs).length ? ` · 花费 ${totalCost(u).toFixed(4)} ${Object.keys(u.costs).join('/')}` : ''
        }`,
      ],
    ];
    console.log('\n— 质量报告 —');
    for (const [k, val] of rows) console.log(`${k.padEnd(4, '　')}  ${val}`);
    for (const [tag, t] of [...byTag.entries()].sort()) {
      console.log(`      ${tag.padEnd(20)} ${String(t.n).padStart(4)} 次  平均 ${seconds(t.ms / t.n)}${t.failed ? `  失败 ${t.failed}` : ''}`);
    }
    console.log(`\n全文记录：${out}`);
    console.log(`世界文件夹：${path.join(dataDir, 'worlds', worldId)}`);
  } finally {
    await close();
  }
}

main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
