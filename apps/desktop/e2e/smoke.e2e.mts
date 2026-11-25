/**
 * 端到端冒烟测试：真正启动 Electron 应用，连一个本地模拟的 OpenAI 兼容服务，走一遍完整流程：
 * 添加接入点 → 拉取模型 → 能力探测 → 设置职责路由 → 调试台对话 → 查看调用日志（M0）
 * → 一键创世 → 开始周目 → 对话 → 重抽 / 切换分支 → 存档 → 继续 → 读档（M1）
 * → 观察模式：在 VN 舞台上自动演出（M3 第 4 步）→ 切到文本看法 → 导演指令 → 暂停 → 接管角色 → 交还（M2）→ 回想里有导演指令
 * → 剧情 ADV（生成的世界，每一幕由 AI 演出）：AI 给的选项 → 跑偏 → 自由输入 → 重抽一拍 → 岔路 → 带检定的选项（M3 第 3 步）
 * → 剧情 ADV：导入手写的示例世界 → VN 舞台上快进、自动、点击推进 → 选项和检定 → 存档 → 好结局
 *   → 回到上一个选择走普通结局 → 读档 → 回想（M3 第 2 步）
 * → 素材：配好图像职责 → 素材页里每个地点和剧本里的背景画好 → 重抽 → 改世界的背景尺寸后全部重画 → 换成自己的图
 *   → 剧情 ADV 舞台上换成真背景（M4 第 1 步）
 *   → 每个角色的基础立绘和表情差分画好、抠成透明 → 给一个角色多加一个表情 → 舞台上换成真立绘（M4 第 2 步）。
 *
 * 用法：先 `pnpm build`，再 `pnpm e2e`。Linux 无显示环境用 `xvfb-run -a pnpm e2e`。
 * 设置 E2E_SCREENSHOTS=目录 可以保存各步骤截图。
 * 设置 E2E_APP_PATH=打包后的可执行文件 可以测试安装包里的应用（例如 release/win-unpacked/Auto-ADV.exe）。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { decodePng } from '@auto-adv/providers';
import { encodePng, mockMusic, startMockServer } from '@auto-adv/providers/testing';
import { _electron as electron, type Page } from 'playwright-core';

const appDir = path.resolve(import.meta.dirname, '..');
const shotsDir = process.env.E2E_SCREENSHOTS;
const API_KEY = 'sk-e2e-secret-key';

/** 点舞台（避开文本框里的按钮），一直到出现选项、跑偏的提示或周目结束。 */
async function advUntil(page: Page, what: 'menu' | 'ending' | 'drift', max = 300) {
  const sel = `[data-testid="adv-${what}"]`;
  for (let i = 0; i < max; i++) {
    if (await page.$(sel)) return;
    // AI 在演这一拍：等它演完再点
    if (await page.$('[data-testid="adv-stage"][data-busy="1"]')) {
      await page.waitForSelector('[data-testid="adv-stage"][data-busy="0"]', { timeout: 60_000 });
      continue;
    }
    if (what === 'ending' && (await page.$('[data-testid="adv-menu"]'))) throw new Error('还没到结局就出现了选项');
    await page.click('[data-testid="adv-stage"]', { position: { x: 12, y: 12 } });
    await page.waitForTimeout(15);
  }
  throw new Error(`点了 ${max} 次还没有${what === 'menu' ? '出现选项' : what === 'drift' ? '出现跑偏的提示' : '到结局'}`);
}

async function choose(page: Page, index: number, label: string) {
  const opt = page.locator(`[data-testid="adv-option-${index}"]`);
  assert.match((await opt.textContent()) ?? '', new RegExp(label));
  await page.waitForTimeout(450); // 选项刚弹出时不接受点击（防止连点误选）
  await opt.click();
  await page.waitForSelector('[data-testid="adv-menu"]', { state: 'detached' });
}

async function shot(page: Page, name: string) {
  if (!shotsDir) return;
  await page.screenshot({ path: path.join(shotsDir, `${name}.png`) });
}

function step(msg: string) {
  console.log(`▸ ${msg}`);
}

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'auto-adv-e2e-'));
const server = await startMockServer({ apiKey: API_KEY, chunkDelayMs: 15, reasoning: '先想一下场景和人物。' });
const packaged = process.env.E2E_APP_PATH;
const executablePath = packaged
  ? path.resolve(packaged)
  : ((await import('electron')).default as unknown as string);
const args = [
  ...(packaged ? [] : [path.join(appDir, 'out/main/index.js')]),
  ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
];
console.log(`启动：${packaged ? `打包后的应用 ${executablePath}` : '开发构建 out/'}`);

const app = await electron.launch({
  executablePath,
  args,
  env: { ...process.env, AUTO_ADV_DATA_DIR: dataDir },
  cwd: appDir,
});

try {
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.waitForSelector('text=引擎 v');
  step('应用启动，引擎已连接');
  await shot(page, '01-home');

  // ── 添加接入点
  await page.click('[data-nav="settings"]');
  await page.click('[data-testid="add-endpoint"]');
  await page.selectOption('[data-testid="preset"]', 'deepseek');
  await page.fill('input[name="name"]', '本地模拟服务');
  await page.fill('input[name="baseURL"]', server.baseURL);
  await page.fill('input[name="apiKey"]', API_KEY);
  await page.click('[data-testid="fetch-models"]');
  await page.click('button:has-text("＋ mock-chat")');
  await page.fill('input[placeholder="0"] >> nth=0', '2');
  await page.fill('input[placeholder="0"] >> nth=1', '8');
  await shot(page, '02-endpoint-editor');
  await page.click('[data-testid="save-endpoint"]');
  await page.waitForSelector('text=已保存密钥');
  step('接入点已保存');

  // ── 能力探测
  await page.click('[data-testid="probe-mock-chat"]');
  await page.waitForSelector('text=重新探测', { timeout: 20_000 });
  await page.waitForSelector('text=✓ 工具调用');
  step('能力探测完成');
  await shot(page, '03-endpoints');

  // ── 职责路由
  await page.click('button:has-text("职责路由")');
  const endpointId = await page.$eval(
    '[data-testid="role-endpoint-default"] option:nth-child(2)',
    (o) => (o as HTMLOptionElement).value,
  );
  await page.selectOption('[data-testid="role-endpoint-default"]', endpointId);
  await page.click('[data-testid="role-save-default"]');
  await page.waitForSelector('text=已保存「默认」');
  step('默认职责已设置');
  await shot(page, '04-roles');

  // ── 调试台
  await page.click('[data-nav="playground"]');
  await page.fill('[data-testid="pg-input"]', '写一段雨夜车站重逢的开场');
  await page.click('[data-testid="pg-send"]');
  await page.waitForSelector('[data-testid="pg-meta"]', { timeout: 20_000 });
  const reply = await page.textContent('[data-testid="pg-assistant"]');
  assert.ok(reply?.includes('雨夜车站'), `回复里应包含用户输入，实际：${reply}`);
  const meta = await page.textContent('[data-testid="pg-meta"]');
  assert.ok(meta?.includes('¥'), `应显示人民币花费，实际：${meta}`);
  step(`调试台对话成功：${meta}`);
  await shot(page, '05-playground');

  // ── 调用日志
  await page.click('[data-nav="logs"]');
  await page.waitForSelector('[data-testid="logs-table"]');
  const rows = await page.$$('[data-testid="logs-table"] tbody tr');
  assert.equal(rows.length, 6, '应有 5 条探测记录 + 1 条对话记录');
  await rows[0]?.click();
  await page.waitForSelector('[data-testid="log-detail"] >> text=请求');
  const detailText = (await page.textContent('[data-testid="log-detail"]')) ?? '';
  assert.ok(!detailText.includes(API_KEY), '日志里不能出现 API Key');
  step('调用日志正常，且不含密钥');
  await shot(page, '06-logs');

  // ── 密钥不进设置文件
  const settingsFile = await readFile(path.join(dataDir, 'settings.json'), 'utf8');
  assert.ok(!settingsFile.includes(API_KEY), 'settings.json 里不能出现 API Key');
  const secretsFile = await readFile(path.join(dataDir, 'secrets.json'), 'utf8');
  const encrypted = !secretsFile.includes(API_KEY);
  step(`密钥保存方式：${encrypted ? '系统加密' : '明文（当前系统不支持加密）'}`);
  if (process.platform === 'win32') assert.ok(encrypted, 'Windows 上密钥必须加密保存');

  // ── 一键创世
  await page.click('[data-nav="home"]');
  await page.click('[data-testid="new-world"]');
  await page.fill('[data-testid="seed"]', '雾中的灯塔');
  await page.click('button:has-text("悬疑推理")');
  await shot(page, '07-create-world');
  await page.click('[data-testid="create-world"]');
  await page.waitForSelector('[data-testid="genesis-steps"]');
  await page.waitForSelector('[data-step="worldview"][data-status="running"], [data-step="worldview"][data-status="done"]', {
    timeout: 30_000,
  });
  await shot(page, '08-genesis-running');
  await page.waitForSelector('[data-step="opening"][data-status="done"]', { timeout: 60_000 });
  assert.equal(await page.getAttribute('[data-step="plot"]', 'data-status'), 'done');
  await page.waitForSelector('[data-testid="start-play"]:not([disabled])');
  await page.waitForSelector('text=雾港谜灯');
  step('一键创世完成：雾港谜灯');
  await page.click('button:has-text("角色") >> nth=0');
  await page.waitForSelector('text=主角（你）');
  await shot(page, '09-world-characters');
  await page.click('button:has-text("剧情图")');
  await page.waitForSelector('[data-scene="sc_01"]');
  await page.waitForSelector('[data-testid="plot-check"] >> text=剧情图检查通过');
  await shot(page, '09b-world-plot');
  await page.click('button:has-text("概览")');

  // ── 游玩：对话、重抽、分支
  await page.click('[data-testid="start-play"]');
  await page.click('[data-testid="start-confirm"]');
  await page.waitForSelector('[data-testid="play-event"][data-kind="opening"]');
  await page.fill('[data-testid="play-input"]', '灯塔是谁点亮的？');
  await page.click('[data-testid="play-send"]');
  await page.waitForSelector('[data-testid="play-event"][data-kind="ai"]', { timeout: 30_000 });
  await page.waitForSelector('[data-testid="play-streaming"]', { state: 'detached' });
  const replyText = (await page.textContent('[data-testid="play-event"][data-kind="ai"]')) ?? '';
  assert.ok(replyText.includes('灯塔是谁点亮的？'), `回复应回应玩家，实际：${replyText}`);
  step('对话成功');

  await page.hover('[data-testid="play-event"][data-kind="ai"]');
  await page.click('[data-testid="regenerate"]');
  await page.waitForSelector('[data-testid="pager-label"]:has-text("2/2")', { timeout: 30_000 });
  await page.click('[data-testid="pager-prev"]');
  await page.waitForSelector('[data-testid="pager-label"]:has-text("1/2")');
  step('重抽出新分支，并能切回原来的回复');

  // ── 存档 → 继续 → 读档
  await page.click('[data-testid="save-slot"]');
  await page.waitForSelector('[data-testid="save"]');
  await page.click('[data-testid="play-send"]'); // 输入为空 = 继续
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="play-event"][data-kind="ai"]').length === 2,
    undefined,
    { timeout: 30_000 },
  );
  await page.waitForSelector('[data-testid="play-streaming"]', { state: 'detached' });
  await shot(page, '10-play');
  await page.click('[data-testid="load-save"]');
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="play-event"][data-kind="ai"]').length === 1,
  );
  step('存档、继续、读档正常');

  // ── 观察模式：AI 自己演
  await page.click('button:has-text("‹ 雾港谜灯")');
  await page.click('[data-testid="start-play"]');
  await page.click('[data-testid="mode-observer"]');
  await shot(page, '11-start-observer');
  await page.click('[data-testid="start-confirm"]');
  // 默认是舞台看法：开场停在最后一句上，上面盖着"开始自动演出"
  await page.waitForSelector('[data-testid="observe-stage"]');
  await page.waitForSelector('[data-testid="observe-stopped"]');
  await page.waitForSelector('[data-testid="observe-bg"]');
  await page.selectOption('[data-testid="observe-speed"]', '1');
  await page.click('[data-testid="observe-play"]');
  // 新的一拍在舞台上播：标题卡、立绘、名字牌和逐字显示的台词
  await page.waitForSelector('[data-testid="observe-card"]', { timeout: 60_000 });
  await page.waitForSelector('[data-testid="observe-name"]', { timeout: 60_000 });
  assert.ok((await page.$$('[data-testid="observe-sprite"]')).length >= 1, '舞台上应该有立绘');
  await shot(page, '11b-observer-stage');
  step('观察模式在 VN 舞台上自动演出（标题卡、立绘、台词）');

  // 切到文本看法：接着从舞台播到的地方往下，像视觉小说一样逐字播放
  await page.click('[data-testid="observe-view-text"]');
  await page.waitForSelector('[data-testid="observe-current"]', { timeout: 60_000 });
  await shot(page, '11c-observer-typing');
  await page.selectOption('[data-testid="observe-speed"]', '0'); // 即时，不等打字
  const aiCount = () => page.$$eval('[data-testid="play-event"][data-kind="ai"]', (els) => els.length);
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="play-event"][data-kind="ai"]').length >= 2,
    undefined,
    { timeout: 60_000 },
  );
  const plotText = (await page.textContent('[data-testid="observe-plot"]')) ?? '';
  assert.match(plotText, /✓|走过 [2-9] 幕/, `剧情进度应该在推进：${plotText}`);
  step('观察模式自动演出，按剧情图一幕一幕推进');

  await page.fill('[data-testid="observe-input"]', '让白鸦突然出现');
  await page.click('[data-testid="observe-send"]');
  await page.waitForSelector('[data-testid="play-event"][data-kind="directive"]', { timeout: 60_000 });
  await page.waitForFunction(
    () => {
      const kinds = [...document.querySelectorAll('[data-testid="play-event"]')].map((e) => e.getAttribute('data-kind'));
      return kinds.lastIndexOf('ai') > kinds.indexOf('directive');
    },
    undefined,
    { timeout: 60_000 },
  );
  step('导演指令写进故事，之后继续演出');
  await shot(page, '12-observer');

  await page.click('[data-testid="observe-toggle"]');
  await page.waitForSelector('[data-testid="observe-status"][data-activity="idle"]', { timeout: 30_000 });
  step('暂停自动演出');

  await page.click('[data-testid="takeover"] >> nth=1');
  await page.waitForSelector('[data-testid="handback"]');
  const before = await aiCount();
  await page.fill('[data-testid="observe-input"]', '其实我一直在等你回来');
  await page.click('[data-testid="observe-send"]');
  await page.waitForSelector('[data-testid="play-event"][data-kind="player"] >> text=其实我一直在等你回来', {
    timeout: 30_000,
  });
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid="play-event"][data-kind="ai"]').length > n, before, {
    timeout: 30_000,
  });
  await shot(page, '13-takeover');
  await page.click('[data-testid="handback"]');
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid="play-event"][data-kind="ai"]').length > n + 1, before, {
    timeout: 60_000,
  });
  await page.click('[data-testid="observe-toggle"]');
  step('接管角色说话，交还后继续自动演出');

  // 回到舞台看法：回想里有导演指令和刚才以角色身份说的话
  await page.click('[data-testid="observe-view-stage"]');
  await page.waitForSelector('[data-testid="observe-stage"]');
  await page.click('[data-testid="observe-backlog"]');
  await page.waitForSelector('[data-testid="observe-backlog-note"] >> text=让白鸦突然出现');
  await page.waitForSelector('[data-testid="observe-backlog-panel"] >> text=其实我一直在等你回来');
  await shot(page, '13a-observer-backlog');
  await page.click('[data-testid="observe-panel-close"]');
  step('舞台的回想里有导演指令和接管时说的话');

  // ── 剧情 ADV：生成的世界没有手写剧本，每一幕由 AI 演出
  await page.click('button:has-text("‹ 雾港谜灯")');
  await page.click('[data-testid="start-play"]');
  await page.click('[data-testid="mode-adv"]');
  await page.click('[data-testid="start-confirm"]');
  await page.waitForSelector('[data-testid="adv-stage"]');
  await advUntil(page, 'menu');
  const aiMenu = (await page.textContent('[data-testid="adv-menu"]')) ?? '';
  assert.match(aiMenu, /仔细观察四周.*难度 12/, `AI 应该给出带检定的选项：${aiMenu}`);
  await shot(page, '13b-adv-ai-menu');
  step('剧情 ADV：AI 演出第一幕，给出选项');

  // 跑偏：连续两拍离开这一幕要讲的事，停下来问玩家（模拟导演看到"跑题"就报告偏离）
  for (const [text, until] of [
    ['跑题：先去码头边的酒馆坐坐', 'menu'],
    ['跑题：再要一杯热茶', 'drift'],
  ] as const) {
    await page.fill('[data-testid="adv-input"] input', text);
    await page.press('[data-testid="adv-input"] input', 'Enter');
    await page.waitForSelector(`[data-testid="adv-text"] >> text=你决定：${text}`, { timeout: 60_000 });
    await advUntil(page, until);
  }
  assert.match((await page.textContent('[data-testid="adv-drift"]')) ?? '', /离开了「归乡」要讲的事[\s\S]*拉回来[\s\S]*就这样走[\s\S]*暂停剧情图[\s\S]*不用管/);
  assert.equal(await page.$('[data-testid="adv-menu"]'), null, '跑偏的提示先于选项');
  await shot(page, '13b2-adv-drift');
  await page.click('[data-testid="adv-drift-pause"]');
  await page.waitForSelector('[data-testid="adv-paused"]');
  await page.waitForSelector('[data-testid="adv-menu"]');
  await page.click('[data-testid="adv-resume"]');
  await page.waitForSelector('[data-testid="adv-paused"]', { state: 'detached' });
  await page.click('[data-testid="adv-backlog"]');
  assert.match((await page.textContent('[data-testid="adv-backlog-panel"]')) ?? '', /暂停剧情图[\s\S]*恢复剧情图/);
  await page.click('[data-testid="adv-panel-close"]');
  step('跑偏时停下来问玩家；暂停剧情图、再恢复');

  await page.fill('[data-testid="adv-input"] input', '问她那晚看到了什么');
  await page.press('[data-testid="adv-input"] input', 'Enter');
  await page.waitForSelector('[data-testid="adv-text"] >> text=你决定：问她那晚看到了什么', { timeout: 60_000 });
  await advUntil(page, 'menu');
  assert.match((await page.textContent('[data-testid="adv-menu"]')) ?? '', /接下来去哪里/);
  step('自由输入行动，演完这一幕后在岔路停下');

  // 重抽 AI 演的这一拍：在同一个位置重新演，从新的一拍开头播
  assert.doesNotMatch((await page.textContent('[data-testid="adv-text"]')) ?? '', /你决定：问她那晚看到了什么/);
  await page.click('[data-testid="adv-regenerate"]');
  await page.waitForSelector('[data-testid="adv-text"] >> text=你决定：问她那晚看到了什么', { timeout: 60_000 });
  await advUntil(page, 'menu');
  assert.match((await page.textContent('[data-testid="adv-menu"]')) ?? '', /接下来去哪里/);
  step('重抽 AI 演的一拍，从新的一拍开头重新播');

  await choose(page, 0, '一起去灯塔');
  await page.waitForSelector('[data-testid="adv-card"] >> text=同行', { timeout: 60_000 });
  await advUntil(page, 'menu');
  await choose(page, 1, '仔细观察四周');
  await page.waitForSelector('[data-testid="adv-check"] >> text=仔细观察四周', { timeout: 60_000 });
  await shot(page, '13c-adv-ai-check');
  step('岔路由玩家选；AI 给的选项也能掷骰检定');
  await page.click('[data-testid="adv-exit"]');

  // ── 世界文件夹
  const worlds = await readdir(path.join(dataDir, 'worlds'));
  assert.equal(worlds.length, 1);
  const worldJson = JSON.parse(await readFile(path.join(dataDir, 'worlds', worlds[0] as string, 'world.json'), 'utf8'));
  assert.equal(worldJson.status, 'ready');
  step(`世界文件夹已写入：worlds/${worlds[0]}`);

  // ── 剧情 ADV：导入手写的示例世界（系统的选文件夹对话框换成直接返回示例目录）
  const example = path.resolve(appDir, '../../examples/worlds/old_library');
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as unknown as typeof dialog.showOpenDialog;
  }, example);
  await page.click('[data-nav="home"]');
  await page.click('[data-testid="import-world"]');
  await page.waitForSelector('text=已导入「旧书库的约定」');
  await page.click('button:has-text("剧情图")');
  await page.waitForSelector('[data-testid="plot-check"] >> text=剧情图检查通过');
  await shot(page, '14-adv-world');
  await page.click('[data-testid="start-play"]');
  // 没有开场的手写世界只能玩剧情 ADV，默认就选中了
  await page.waitForSelector('[data-testid="mode-chat"][disabled]');
  await page.click('[data-testid="start-confirm"]');
  await page.waitForSelector('[data-testid="adv-stage"]');
  await page.waitForSelector('[data-testid="adv-card"] >> text=图书馆的偶遇');
  await shot(page, '15-adv-title-card');
  step('导入示例世界，开始剧情 ADV 周目（标题卡）');

  // 自动播放：不点也会往下走
  await page.click('[data-testid="adv-auto"]');
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="adv-stage"]')?.getAttribute('data-step')) >= 2, undefined, {
    timeout: 20_000,
  });
  await page.click('[data-testid="adv-auto"]');
  await page.waitForSelector('[data-testid="adv-sprite"][data-char="char_lin"][data-x="50"]');
  await shot(page, '16-adv-stage');
  // 快进：一直播到选项停下
  await page.click('[data-testid="adv-skip"]');
  await page.waitForSelector('[data-testid="adv-menu"]', { timeout: 20_000 });
  assert.equal(await page.textContent('[data-testid="adv-name"]'), '林夕');
  await shot(page, '17-adv-menu');
  step('自动播放、快进到第一个选项');

  await choose(page, 1, '随便看看');
  await advUntil(page, 'menu');
  assert.match((await page.textContent('[data-testid="adv-menu"]')) ?? '', /接下来去哪里/);
  await choose(page, 0, '一起去旧书库');
  await advUntil(page, 'menu');
  assert.match((await page.textContent('[data-testid="adv-scene"]')) ?? '', /旧书库的门/);
  await page.waitForSelector('[data-testid="adv-sprite"][data-char="char_lin"][data-x="28"]');
  assert.match((await page.textContent('[data-testid="adv-option-0"]')) ?? '', /难度 12/);
  // 存档：记住舞台播到哪一句
  await page.click('[data-testid="adv-save"]');
  await page.fill('[data-testid="adv-save-name"]', '门前');
  await page.click('[data-testid="adv-save-confirm"]');
  await page.waitForSelector('[data-testid="adv-save-slot"] >> text=旧书库的门');
  await shot(page, '18-adv-save');
  await page.click('[data-testid="adv-panel-close"]');
  step('换幕、立绘站位、带检定的选项，存档');

  await choose(page, 1, '去找管理员老周借钥匙');
  await advUntil(page, 'menu');
  await choose(page, 0, '把字条念给她听');
  await advUntil(page, 'menu');
  await shot(page, '19-adv-fork');
  await choose(page, 0, '陪她去海堤找姐姐');
  await page.waitForSelector('[data-testid="adv-cg"]', { timeout: 20_000 });
  await advUntil(page, 'ending');
  assert.equal(await page.textContent('[data-testid="adv-ending-title"]'), '潮汐归来');
  assert.equal(await page.textContent('[data-testid="adv-progress-endings"]'), '1 / 3');
  await shot(page, '20-adv-ending');
  step('手写剧本玩到好结局「潮汐归来」，CG 显示');

  await page.click('[data-testid="adv-ending-rewind"]');
  await page.waitForSelector('[data-testid="adv-menu"]');
  await choose(page, 1, '送她回家');
  await advUntil(page, 'ending');
  assert.equal(await page.textContent('[data-testid="adv-ending-title"]'), '各自的路');
  assert.equal(await page.textContent('[data-testid="adv-progress-endings"]'), '2 / 3');
  await page.click('[data-testid="adv-panel-close"]');
  step('回到上一个选择，走到普通结局，跨周目进度 2 / 3');

  await page.click('[data-testid="adv-load"]');
  await page.click('[data-testid="adv-load-slot"]');
  await page.waitForSelector('[data-testid="adv-menu"]');
  assert.match((await page.textContent('[data-testid="adv-scene"]')) ?? '', /旧书库的门/);
  assert.match((await page.textContent('[data-testid="adv-text"]')) ?? '', /试了一个星期都没打开/);
  await page.click('[data-testid="adv-backlog"]');
  await page.waitForSelector('[data-testid="adv-backlog-panel"] >> text=你选了：随便看看');
  await shot(page, '21-adv-backlog');
  await page.click('[data-testid="adv-panel-close"]');
  step('读档回到门前那一句，回想里有之前的选择');

  // 检定：选"研究门锁的机关"，引擎掷骰，舞台上单独一步显示结果
  await choose(page, 0, '研究门锁的机关');
  await page.waitForSelector('[data-testid="adv-check"] >> text=难度 12', { timeout: 20_000 });
  await shot(page, '22-adv-check');
  step('带检定的选项：舞台显示掷骰结果');

  // 收集：结局和 CG 画廊跨周目累计
  await page.click('[data-testid="adv-exit"]');
  await page.click('button:has-text("收集")');
  await page.waitForSelector('[data-testid="collection"]');
  assert.equal(await page.textContent('[data-testid="collection-endings"]'), '达成 2 / 3');
  assert.equal(await page.textContent('[data-testid="collection-cgs"]'), '1 / 2');
  assert.equal((await page.$$('[data-testid="collection-cg-locked"]')).length, 1);
  await page.click('[data-testid="collection-cg"]');
  await page.waitForSelector('[data-testid="collection-cg-view"] >> text=潮汐归来');
  await shot(page, '23-collection-cg');
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-testid="collection-cg-view"]', { state: 'detached' });
  await shot(page, '24-collection');
  step('收集：结局 2 / 3，CG 画廊里能看已经解锁的 CG');

  // ── 素材（M4 第 1、2 步）：没配图像模型时用占位图；配好以后每个地点画一张背景，
  // 手写剧本里自己起名的背景（不是地点 id 的）也各画一张：3 个地点 + 5 张剧本背景；
  // 每个角色一张基础立绘加表情差分：沈默、林夕是主要角色各 6 张，老周是其他角色 3 张，一共 8 + 15 张
  // 只数这个世界的请求（前面生成的世界打开过，配好图像模型后它也会开始画）
  const libImages = () => server.imageRequests.filter((r) => /旧书库|阅览室|海堤|书中人/.test(String(r.prompt)));
  const libSprites = () => server.imageRequests.filter((r) => /志愿者工牌|一本旧书|铜钥匙/.test(String(r.prompt)));
  await page.click('[data-testid="tab-assets"]');
  await page.waitForSelector('[data-testid="assets-needs-model"]');
  assert.equal(await page.textContent('[data-testid="assets-progress"]'), '素材 0 / 23');
  await page.click('[data-nav="settings"]');
  await page.click('button:has-text("职责路由")');
  await page.selectOption('[data-testid="role-endpoint-image"]', endpointId);
  await page.fill('[data-testid="role-model-image"]', 'mock-image');
  await page.click('[data-testid="role-save-image"]');
  await page.waitForSelector('text=已保存「图像」');
  await page.click('[data-testid="tab-assets"]');
  await page.waitForSelector('[data-testid="asset-settings-global"] [data-testid="asset-template-background"]');
  await page.waitForSelector('[data-testid="asset-settings-global"] [data-testid="asset-expressions"]');
  await shot(page, '25-asset-settings');
  step('设置里配好图像模型；素材的全局设置');

  await page.click('[data-nav="home"]');
  await page.click('[data-testid="world-card"] >> text=旧书库的约定');
  await page.click('[data-testid="tab-assets"]');
  await page.waitForSelector('[data-testid="assets-progress"] >> text=素材 23 / 23', { timeout: 30_000 });
  await page.waitForFunction(
    () => [...document.querySelectorAll('[data-testid="asset-image"]')].filter((i) => (i as HTMLImageElement).naturalWidth > 0).length === 23,
  );
  assert.equal(libImages().length, 8);
  // 基础立绘是生成的（提示词里有外貌），表情差分拿基础立绘当参考图改图
  assert.equal(libSprites().length, 3);
  assert.equal((await page.$$('[data-testid="asset-character"]')).length, 3);
  assert.equal(await page.locator('[data-testid="asset-character"][data-character="char_zhou"] [data-testid="asset-slot"]').count(), 3);
  assert.equal(await page.locator('[data-testid="asset-review"]').count(), 0);
  await shot(page, '26-assets');
  step('每个地点、剧本里的每张背景，每个角色的立绘和表情差分都画好了，素材页里看得到');

  // 重抽一张：旧的进"之前的图"
  const sea = page.locator('[data-testid="asset-slot"][data-slot="bg/loc_seaside"]');
  await sea.locator('[data-testid="asset-regenerate"]').click();
  await sea.locator('text=之前的图').waitFor();
  await page.waitForSelector('[data-testid="asset-slot"][data-slot="bg/loc_seaside"][data-status="done"]');
  assert.equal(libImages().length, 9);
  // 这个世界的设置：改背景尺寸 → 标成过期，不自动重画 → 点"全部重画"
  await page.click('[data-testid="world-asset-settings-toggle"]');
  await page.fill('[data-testid="asset-size-background"]', '1024x576');
  await page.click('[data-testid="asset-settings-save"]');
  await page.waitForSelector('[data-testid="assets-stale"]');
  assert.equal(libImages().length, 9);
  await page.click('[data-testid="assets-redraw-stale"]');
  await page.waitForSelector('[data-testid="assets-stale"]', { state: 'detached' });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="asset-slot"][data-status="done"]').length === 23);
  assert.deepEqual(
    libImages()
      .slice(9)
      .map((r) => r.size),
    Array(8).fill('1024x576'),
  );
  step('重抽一张；改了这个世界的背景尺寸以后，点"全部重画"才重画');

  // 换成自己的图（系统的选文件对话框换成直接返回一张图）
  const mine = path.join(dataDir, 'mine.png');
  await writeFile(mine, encodePng(32, 18, () => [200, 120, 40, 255]));
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as unknown as typeof dialog.showOpenDialog;
  }, mine);
  const reading = page.locator('[data-testid="asset-slot"][data-slot="bg/loc_reading"]');
  await reading.locator('button:has-text("换成自己的图")').click();
  await reading.locator('[data-testid="asset-unlock"]').waitFor();
  await shot(page, '27-assets-upload');
  step('换成自己的图，自动锁定');

  // 立绘：抠成透明的（角上透明，人物身上不透明）
  const linSrc = await page.getAttribute('[data-testid="asset-slot"][data-slot="sprite/char_lin/neutral"] [data-testid="asset-image"]', 'src');
  const linPng = decodePng(await readFile(path.join(dataDir, 'worlds', ...decodeURIComponent(new URL(linSrc ?? '').pathname).split('/').filter(Boolean))));
  const alphaAt = (x: number, y: number) => linPng.data[(y * linPng.width + x) * 4 + 3];
  assert.deepEqual([alphaAt(0, 0), alphaAt(linPng.width >> 1, linPng.height >> 1)], [0, 255], '立绘的角上应该是透明的，人物身上不透明');
  // 给老周单独多加一个"难过"：只画这一张，用基础立绘改图
  const editsBefore = server.imageRequests.filter((r) => r.edit === true).length;
  const zhou = page.locator('[data-testid="asset-character"][data-character="char_zhou"]');
  await zhou.locator('[data-testid="char-expressions-toggle"]').click();
  await zhou.locator('[data-testid="char-expression"][data-expr="sad"]').click();
  await zhou.locator('[data-testid="char-expressions-save"]').click();
  await page.waitForSelector('[data-testid="asset-slot"][data-slot="sprite/char_zhou/sad"][data-status="done"]', { timeout: 20_000 });
  assert.equal(await page.textContent('[data-testid="assets-progress"]'), '素材 24 / 24');
  assert.equal(libSprites().length, 3, '加表情不重画基础立绘');
  assert.ok(server.imageRequests.filter((r) => r.edit === true).length > editsBefore);
  assert.equal(await zhou.locator('text=之前的图').count(), 0, '老周别的立绘不重画');
  await shot(page, '27b-assets-sprites');
  step('立绘抠成透明；给一个角色多加一个表情，只画这一张');

  // ── BGM（M4 第 3 步）：配好音乐模型，每种情绪生成一首；本地曲库排在前面，曲库里有的情绪用曲库
  /** 在页面里用 <audio> 读一下这个地址，返回时长（读不了就报错）。 */
  const audioDuration = (src: string) =>
    page.evaluate(
      (url) =>
        new Promise<number>((resolve, reject) => {
          const a = new Audio(url);
          a.onloadedmetadata = () => resolve(a.duration);
          a.onerror = () => reject(new Error(`读不了 ${url}`));
        }),
      src,
    );
  // 还没配音乐模型、也没有本地曲库：用内置曲库（公有领域乐谱渲染的 Opus）
  await page.waitForSelector('[data-testid="asset-mood"][data-mood="tense"][data-source="builtin"]');
  const builtinSrc = await page.getAttribute('[data-testid="asset-mood"][data-mood="tense"] [data-testid="asset-mood-audio"]', 'src');
  assert.match(builtinSrc ?? '', /^adv-asset:\/\/builtin\/[\w.-]+\.opus$/);
  assert.ok((await audioDuration(builtinSrc ?? '')) > 60, '内置曲库的曲子应该能放');
  await page.click('[data-nav="settings"]');
  // 「关于」里列出内置曲目和授权
  await page.click('button:has-text("关于")');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="about-builtin-track"]').length === 12);
  assert.match((await page.textContent('[data-testid="about-builtin-bgm"]')) ?? '', /公有领域/);
  await page.locator('[data-testid="about-builtin-bgm"]').scrollIntoViewIfNeeded();
  await shot(page, '27b2-about-bgm');
  await page.click('button:has-text("职责路由")');
  await page.selectOption('[data-testid="role-endpoint-music"]', endpointId);
  await page.fill('[data-testid="role-model-music"]', 'mock-music');
  await page.click('[data-testid="role-save-music"]');
  await page.waitForSelector('text=已保存「音乐」');
  await page.click('[data-nav="home"]');
  await page.click('[data-testid="world-card"] >> text=旧书库的约定');
  await page.click('[data-testid="tab-assets"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="asset-mood"][data-source="model"]').length === 6, null, { timeout: 20_000 });
  assert.equal(await page.textContent('[data-testid="assets-progress"]'), '素材 30 / 30');
  const generated = await page.getAttribute('[data-testid="asset-mood"][data-mood="daily"] [data-testid="asset-mood-audio"]', 'src');
  assert.ok((await audioDuration(generated ?? '')) > 1, '生成的 BGM 应该能放');

  const lib = path.join(dataDir, 'my-music');
  await mkdir(path.join(lib, '紧张'), { recursive: true });
  await writeFile(path.join(lib, '紧张', '追逐.wav'), mockMusic('追逐', 3));
  await page.click('[data-testid="world-asset-settings-toggle"]');
  await page.fill('[data-testid="asset-bgm-library"]', lib);
  await page.click('[data-testid="asset-settings-save"]');
  await page.waitForSelector('[data-testid="asset-mood"][data-mood="tense"][data-source="library"]');
  const fromLib = await page.getAttribute('[data-testid="asset-mood"][data-mood="tense"] [data-testid="asset-mood-audio"]', 'src');
  assert.match(fromLib ?? '', /^adv-asset:\/\/library\//);
  assert.ok((await audioDuration(fromLib ?? '')) > 2, '本地曲库里的曲子应该能放');
  await page.locator('[data-testid="asset-bgm"]').scrollIntoViewIfNeeded();
  await shot(page, '27c-assets-bgm');
  step('没配音乐时放内置曲库；配好音乐模型，每种情绪生成一首；本地曲库里有的情绪改用曲库');

  // 舞台上换成真背景
  await page.click('[data-testid="playthrough"] >> button:has-text("继续")');
  await page.waitForSelector('[data-testid="adv-stage"]');
  await page.waitForFunction(() => {
    const img = document.querySelector('[data-testid="adv-bg-image"]') as HTMLImageElement | null;
    return !!img && img.complete && img.naturalWidth > 0;
  });
  await page.waitForFunction(() => {
    const img = document.querySelector('[data-testid="adv-sprite-image"]') as HTMLImageElement | null;
    return !!img && img.complete && img.naturalWidth > 0;
  });
  // 手写剧本的 bgm 指令认成情绪（reunion → 温馨），放音乐模型生成的那首
  await page.waitForSelector('[data-testid="stage-bgm"][data-src^="adv-asset://world/"]');
  assert.ok(await page.getAttribute('[data-testid="stage-bgm"]', 'data-mood'));
  await shot(page, '28-adv-real-bg');
  step('剧情 ADV 的舞台上换成了画好的背景和立绘，放着 BGM');

  console.log('✓ 端到端冒烟测试通过');
} finally {
  await app.close();
  await server.close();
  await rm(dataDir, { recursive: true, force: true });
}
