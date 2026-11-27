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
 *   → 每个角色的基础立绘和表情差分画好、抠成透明 → 给一个角色多加一个表情 → 舞台上换成真立绘（M4 第 2 步）
 *   → BGM：内置曲库、音乐模型、本地曲库（M4 第 3 步）→ 图像职责改成自定义接口
 *   → 配音：语音职责、拉取音色表 → 素材页的配音表（试听、换音色锁定、重新分配）→ 舞台上念台词、回想里重播、缓存（M4 第 4 步）
 * → 世界编辑器：改角色（自动加锁）、没保存先问、历史版本、加角色、删地点连引用、关掉自动锁、JSON 视图（M5 第 1 步）。
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
  await shot(page, 'zz-adv-stuck');
  const where = await page.textContent('[data-testid="adv-stage"]').catch(() => '');
  throw new Error(`点了 ${max} 次还没有${what === 'menu' ? '出现选项' : what === 'drift' ? '出现跑偏的提示' : '到结局'}（舞台上：${where?.slice(0, 200)}）`);
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

/** 等测试进程这边的条件成立（例如模拟服务收到了请求）。 */
async function until(cond: () => boolean, what: string, timeout = 20_000) {
  const end = Date.now() + timeout;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`等不到：${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
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
  // 每个角色一张基础立绘加表情差分：沈默、林夕是主要角色各 6 张，老周是其他角色 3 张，一共 8 + 15 张；
  // 剧本里的 2 张 CG（第 5 步）拿林夕的基础立绘当参考图改图
  // 只数这个世界的请求（前面生成的世界打开过，配好图像模型后它也会开始画）
  const isCg = (r: Record<string, unknown>) => String(r.prompt).includes('事件 CG');
  const libImages = () => server.imageRequests.filter((r) => /旧书库|阅览室|海堤|书中人/.test(String(r.prompt)) && !isCg(r));
  const libSprites = () => server.imageRequests.filter((r) => /志愿者工牌|一本旧书|铜钥匙/.test(String(r.prompt)) && !isCg(r));
  const libCgs = () => server.imageRequests.filter((r) => isCg(r) && /潮水漫过了堤岸|文字组成的海/.test(String(r.prompt)));
  await page.click('[data-testid="tab-assets"]');
  await page.waitForSelector('[data-testid="assets-needs-model"]');
  assert.equal(await page.textContent('[data-testid="assets-progress"]'), '素材 0 / 25');
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
  await page.waitForSelector('[data-testid="assets-progress"] >> text=素材 25 / 25', { timeout: 30_000 });
  await page.waitForFunction(
    () => [...document.querySelectorAll('[data-testid="asset-image"]')].filter((i) => (i as HTMLImageElement).naturalWidth > 0).length === 25,
  );
  assert.equal(libImages().length, 8);
  // 基础立绘是生成的（提示词里有外貌），表情差分拿基础立绘当参考图改图
  assert.equal(libSprites().length, 3);
  // 剧本里的 CG：拿林夕的基础立绘当参考图
  assert.equal(libCgs().length, 2);
  assert.ok(libCgs().every((r) => r.edit === true));
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
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="asset-slot"][data-status="done"]').length === 25);
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
  assert.equal(await page.textContent('[data-testid="assets-progress"]'), '素材 26 / 26');
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
  assert.equal(await page.textContent('[data-testid="assets-progress"]'), '素材 32 / 32');
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

  // ── 自定义接口（通用 HTTP 适配器）：图像职责改成自定义，从「异步任务」模板开始，测试画一张
  await page.click('[data-nav="settings"]');
  await page.click('button:has-text("职责路由")');
  await page.selectOption('[data-testid="role-api-image"]', 'custom');
  await page.waitForSelector('[data-testid="custom-api-image"]');
  // 起点是 OpenAI 风格的模板（和内置接口一样的写法）
  assert.equal(await page.inputValue('[data-testid="custom-image-request-url"]'), '/images/generations');
  await page.click('[data-testid="custom-preset-image-async"]');
  assert.equal(await page.inputValue('[data-testid="custom-image-request-poll-url"]'), '/jobs/{{id}}');
  await page.fill('[data-testid="custom-image-request-url"]', '/jobs?x={{oops}}');
  await page.waitForSelector('[data-testid="custom-problem-image"] >> text={{oops}}');
  await page.fill('[data-testid="custom-image-request-url"]', '/jobs');
  await page.waitForSelector('[data-testid="custom-problem-image"]', { state: 'detached' });
  await page.fill('[data-testid="custom-image-request-poll-interval"]', '0.2');
  const jobsBefore = server.jobRequests.length;
  await page.click('[data-testid="role-test-image"]');
  await page.waitForFunction(() => {
    const img = document.querySelector('[data-testid="role-test-image-image"]') as HTMLImageElement | null;
    return !!img && img.complete && img.naturalWidth > 0;
  }, null, { timeout: 20_000 });
  assert.equal(server.jobRequests.length, jobsBefore + 1);
  assert.equal(server.jobRequests.at(-1)?.model, 'mock-image');
  await page.locator('[data-testid="role-image"]').scrollIntoViewIfNeeded();
  await shot(page, '29-custom-api');
  await page.click('[data-testid="role-save-image"]');
  // 存好以后「保存」按钮消失（前面的「已保存」提示可能还在，不能拿它判断）
  await page.waitForSelector('[data-testid="role-save-image"]', { state: 'detached' });
  const saved = JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8')) as {
    media: { image?: { api: string; custom?: { request: { url: string; poll?: { intervalSeconds: number } } } } };
  };
  assert.equal(saved.media.image?.api, 'custom');
  assert.equal(saved.media.image?.custom?.request.url, '/jobs');
  assert.equal(saved.media.image?.custom?.request.poll?.intervalSeconds, 0.2);
  // 自定义接口的调用日志里看不到密钥
  for (const f of (await readdir(dataDir)).filter((n) => n.startsWith('logs.db'))) {
    assert.ok(!(await readFile(path.join(dataDir, f))).includes(API_KEY), `调用日志（${f}）里不能有密钥`);
  }
  step('图像职责改成自定义接口：从模板开始改，写错的占位符马上提示，测试画一张，保存');

  // ── 配音（M4 第 4 步）：语音职责用 MiniMax 风格的接口，音色表从服务拉取，试念一句
  const voiceRole = page.locator('[data-testid="role-voice"]');
  await page.selectOption('[data-testid="role-endpoint-voice"]', endpointId);
  await page.fill('[data-testid="role-model-voice"]', 'mock-speech');
  await page.selectOption('[data-testid="role-api-voice"]', 'minimax');
  await page.click('[data-testid="role-voices-toggle"]');
  await page.click('[data-testid="role-voices-fetch"]');
  await page.waitForFunction(() =>
    (document.querySelector('[data-testid="role-voices-text"]') as HTMLTextAreaElement | null)?.value.includes('mock_girl_bright｜明亮少女'),
  );
  const speechBefore = server.speechRequests.length;
  await page.click('[data-testid="role-test-voice"]');
  await voiceRole.locator('[data-testid="role-test-audio"]').waitFor();
  assert.equal(server.speechRequests.length, speechBefore + 1);
  assert.equal(server.speechRequests.at(-1)?.api, 'minimax');
  assert.equal(server.speechRequests.at(-1)?.model, 'mock-speech');
  await voiceRole.scrollIntoViewIfNeeded();
  await shot(page, '30-voice-role');
  await page.click('[data-testid="role-save-voice"]');
  await page.waitForSelector('[data-testid="role-save-voice"]', { state: 'detached' });
  step('语音职责：MiniMax 风格的接口，从服务拉取音色表，试念一句，保存');

  // 素材页的配音表：第一次打开时由文本模型分配音色（女角色用女声，主要角色不重复），主角默认不配
  await page.click('[data-nav="home"]');
  await page.click('[data-testid="world-card"] >> text=旧书库的约定');
  await page.click('[data-testid="tab-assets"]');
  const voiceRow = (id: string) => `[data-testid="voice-row"][data-char="${id}"]`;
  await page.waitForSelector(`${voiceRow('char_lin')}[data-voice="mock_girl_bright"]`, { timeout: 30_000 });
  const zhouVoice = await page.getAttribute(voiceRow('char_zhou'), 'data-voice');
  const shenVoice = await page.getAttribute(voiceRow('char_01'), 'data-voice');
  assert.ok(zhouVoice && !zhouVoice.startsWith('mock_girl'), `老周应该是男声，分到的是 ${zhouVoice}`);
  assert.notEqual(shenVoice, 'mock_girl_bright');
  assert.equal(await page.isChecked(`${voiceRow('char_01')} [data-testid="voice-enabled"]`), false, '主角默认不配音');
  assert.equal(await page.isChecked(`${voiceRow('char_lin')} [data-testid="voice-enabled"]`), true);
  // 试听：用这个角色的音色念一句
  const beforePreview = server.speechRequests.length;
  await page.click(`${voiceRow('char_lin')} [data-testid="voice-preview"]`);
  await until(() => server.speechRequests.length === beforePreview + 1, '试听的请求');
  assert.equal((server.speechRequests.at(-1)?.voice_setting as { voice_id?: string } | undefined)?.voice_id, 'mock_girl_bright');
  // 换音色：锁定，重新分配时不会被改掉
  const pick = zhouVoice === 'mock_elder' ? 'mock_man_deep' : 'mock_elder';
  await page.selectOption(`${voiceRow('char_zhou')} [data-testid="voice-select"]`, pick);
  await page.waitForSelector(`${voiceRow('char_zhou')}[data-voice="${pick}"] >> text=🔒`);
  await page.click('[data-testid="voice-recast"]');
  await page.click('[data-testid="voice-recast"]');
  await page.waitForSelector('text=重新分配好了');
  assert.equal(await page.getAttribute(voiceRow('char_zhou'), 'data-voice'), pick);
  const worldDirs = await readdir(path.join(dataDir, 'worlds'));
  const castFile = (
    await Promise.all(
      worldDirs.map((d) =>
        readFile(path.join(dataDir, 'worlds', d, 'assets', 'voices.json'), 'utf8').then(
          (t) => ({ d, t }),
          () => null,
        ),
      ),
    )
  ).find((x) => x?.t.includes('char_zhou'));
  assert.ok(castFile, '配音表应该存在世界的 assets/voices.json 里');
  const cast = JSON.parse(castFile.t) as { characters: Record<string, { voiceId: string; locked: boolean }> };
  assert.deepEqual(cast.characters.char_zhou, { voiceId: pick, locked: true });
  await page.locator('[data-testid="asset-voice"]').scrollIntoViewIfNeeded();
  await shot(page, '31-assets-voice');
  step('素材页的配音表：按性别分配音色、主角默认不配、试听、换音色后锁定、重新分配不改锁定的');

  // 舞台上：读档回到门前林夕那一句，念出来（MiniMax 的 voice_setting 用林夕的音色）
  await page.click('[data-testid="playthrough"] >> button:has-text("继续")');
  await page.waitForSelector('[data-testid="adv-stage"]');
  await page.click('[data-testid="adv-load"]');
  await page.click('[data-testid="adv-load-slot"]');
  await page.waitForSelector('[data-testid="adv-text"] >> text=试了一个星期都没打开');
  await page.waitForSelector('[data-testid="adv-voice"][data-status="playing"], [data-testid="adv-voice"][data-status="ended"]', { state: 'attached', timeout: 20_000 });
  const spoken = server.speechRequests.filter((r) => String(r.text).includes('试了一个星期都没打开'));
  assert.equal(spoken.length, 1, '这一句应该只生成一次');
  assert.equal((spoken[0]?.voice_setting as { voice_id?: string } | undefined)?.voice_id, 'mock_girl_bright');
  await page.waitForSelector('[data-testid="adv-voice-toggle"]');
  await shot(page, '32-adv-voice');
  await page.waitForSelector('[data-testid="adv-voice"][data-status="ended"]', { state: 'attached', timeout: 20_000 });
  // 回想里重播：之前的台词第一次重播时生成，再点一次用缓存
  await page.click('[data-testid="adv-backlog"]');
  const replay = page.locator('[data-testid="adv-backlog-voice"]').first();
  await replay.waitFor();
  const beforeReplay = server.speechRequests.length;
  await replay.click();
  await until(() => server.speechRequests.length === beforeReplay + 1, '回想里重播的请求');
  await page.waitForTimeout(300);
  await replay.click();
  await page.waitForTimeout(500);
  assert.equal(server.speechRequests.length, beforeReplay + 1, '重播同一句不再生成');
  await shot(page, '33-adv-backlog-voice');
  await page.click('[data-testid="adv-panel-close"]');
  // 退出再进来：念过的句子从世界的缓存里拿，不再请求
  await page.click('[data-testid="adv-exit"]');
  await page.click('[data-testid="playthrough"] >> button:has-text("继续")');
  await page.waitForSelector('[data-testid="adv-text"] >> text=试了一个星期都没打开');
  await page.waitForSelector('[data-testid="adv-voice"][data-status="playing"], [data-testid="adv-voice"][data-status="ended"]', { state: 'attached', timeout: 20_000 });
  assert.equal(server.speechRequests.filter((r) => String(r.text).includes('试了一个星期都没打开')).length, 1, '念过的句子用缓存');
  const voiceFiles = await readdir(path.join(dataDir, 'worlds', castFile.d, 'assets', 'voice'));
  assert.ok(voiceFiles.length >= 3, `assets/voice 里应该有念过的句子，现在有 ${voiceFiles.length} 个`);
  // 工具栏的「配音」关掉：这台电脑上不念
  await page.click('[data-testid="adv-voice-toggle"]');
  await page.waitForSelector('[data-testid="adv-voice"][data-status="off"]', { state: 'attached' });
  await page.click('[data-testid="adv-voice-toggle"]');
  step('舞台上念台词（读档后的那一句），回想里能重播，念过的句子存在世界里，工具栏能关掉配音');

  // ── M4 第 5 步：CG、时段背景、临时人物、创世前的用量估算
  // 带参考图的 CG、改光线的时段背景要「改图」：自定义接口勾上改图请求（从 OpenAI 风格的写法开始）
  await page.click('[data-nav="settings"]');
  await page.click('button:has-text("职责路由")');
  await page.click('[data-testid="role-template-image"]');
  await page.check('[data-testid="custom-image-edit-toggle"]');
  assert.equal(await page.inputValue('[data-testid="custom-image-edit-url"]'), '/images/edits');
  await page.click('[data-testid="role-save-image"]');
  await page.waitForSelector('[data-testid="role-save-image"]', { state: 'detached' });
  await page.click('[data-testid="tab-assets"]');
  const globalForm = page.locator('[data-testid="asset-settings-global"]');
  await globalForm.locator('[data-testid="asset-tod-variants"]').waitFor();
  await globalForm.locator('[data-testid="asset-extras-silhouette"]').waitFor();
  await globalForm.locator('[data-testid="asset-toggle-cg"]').scrollIntoViewIfNeeded();
  await shot(page, '34-asset-settings-cg');
  step('素材设置里有 CG（每幕、每章最多几张、参考图）、时段背景（时段表）、临时人物');

  // 用量估算是可选的：默认关着，新建世界页上不显示；打开、填上单价（每张图 0.2 元、每一万字语音 2 元）
  await page.click('[data-nav="home"]');
  await page.click('[data-testid="new-world"]');
  await page.waitForSelector('[data-testid="create-world"]');
  await page.waitForTimeout(300);
  assert.equal(await page.$('[data-testid="usage-estimate"]'), null, '估算没打开时不显示');
  await page.click('[data-nav="settings"]');
  await page.click('[data-testid="tab-assets"]');
  await globalForm.locator('[data-testid="asset-estimate-enabled"]').check();
  await globalForm.locator('[data-testid="asset-estimate-image"]').fill('0.2');
  await globalForm.locator('[data-testid="asset-estimate-voice"]').fill('2');
  await globalForm.locator('[data-testid="asset-estimate-voice"]').scrollIntoViewIfNeeded();
  await shot(page, '34b-asset-settings-estimate');
  await globalForm.locator('[data-testid="asset-settings-save"]').click();
  await page.waitForSelector('text=已保存素材设置');

  // 新建世界页：按素材设置估算用量（4 个角色 × 3～6 张立绘，加 4～6 张背景），按单价折成钱
  await page.click('[data-nav="home"]');
  await page.click('[data-testid="new-world"]');
  await page.waitForSelector('[data-testid="usage-images"] >> text=开局画 16～30 张');
  assert.match((await page.textContent('[data-testid="usage-cost"]')) ?? '', /开局约 ¥3\.20～¥6\.00/);
  assert.match((await page.textContent('[data-testid="usage-voice"]')) ?? '', /每拍约 70～180 字[\s\S]*每 100 拍约 ¥1\.40～¥3\.60/);
  await shot(page, '35-create-estimate');
  step('用量估算在设置里打开、填上单价以后，新建世界前估算素材用量和花费：开局画多少张、CG 和时段背景、音乐、每拍念多少字');

  // 生成的世界开一个新的剧情 ADV 周目：导演标的 CG 画好就在舞台上出来，回想里能看大图
  await page.click('button:has-text("返回")');
  await page.click('[data-testid="world-card"] >> text=雾港谜灯');
  let fogWorld = '';
  for (const d of await readdir(path.join(dataDir, 'worlds'))) {
    const m = JSON.parse(await readFile(path.join(dataDir, 'worlds', d, 'world.json'), 'utf8')) as { title: string };
    if (m.title === '雾港谜灯') fogWorld = d;
  }
  assert.ok(fogWorld, '找不到雾港谜灯的世界文件夹');
  await page.click('[data-testid="start-play"]');
  await page.click('[data-testid="mode-adv"]');
  await page.click('[data-testid="start-confirm"]');
  await page.waitForSelector('[data-testid="adv-stage"]');
  await advUntil(page, 'menu');
  await page.waitForSelector('[data-testid="adv-cg"][data-ready="true"]', { timeout: 60_000 });
  await page.waitForFunction(() => {
    const img = document.querySelector('[data-testid="adv-cg-image"]') as HTMLImageElement | null;
    return !!img && img.complete && img.naturalWidth > 0;
  });
  await shot(page, '36-adv-ai-cg');
  await page.click('[data-testid="adv-backlog"]');
  await page.click('[data-testid="adv-backlog-cg-open"]');
  await page.waitForSelector('[data-testid="adv-cg-view"] >> text=灯塔下的约定');
  await shot(page, '37-adv-backlog-cg');
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-testid="adv-cg-view"]', { state: 'detached' });
  await page.click('[data-testid="adv-panel-close"]');
  step('导演标的 CG 画好就在舞台上放出来，回想里能看大图');

  // 临时人物：码头老板开口时剪影上台；故事时间到了夜里换成夜晚的背景；码头老板开口满 3 拍升级成正式角色
  // 不选岔路，一直在这一幕里输入行动（选了会一路演到结局）
  const askOwner = async () => {
    await page.fill('[data-testid="adv-input"] input', '去问码头老板');
    await page.press('[data-testid="adv-input"] input', 'Enter');
    await page.waitForSelector('[data-testid="adv-text"] >> text=你决定：去问码头老板', { timeout: 60_000 });
    await advUntil(page, 'menu');
  };
  await askOwner();
  await page.waitForSelector('[data-testid="adv-text"] >> text=这几天雾大');
  await page.waitForSelector('[data-testid="adv-sprite"][data-char="码头老板"] [data-testid="stage-silhouette"]');
  await shot(page, '38-adv-extra');
  let night = false;
  for (let i = 0; i < 4 && !night; i++) {
    await askOwner();
    night = ((await page.getAttribute('[data-testid="adv-bg"]', 'data-bg')) ?? '').endsWith('@night');
  }
  assert.ok(night, '故事时间到了夜里，背景应该换成夜晚的');
  await page.waitForFunction(
    () => ((document.querySelector('[data-testid="adv-bg-image"]') as HTMLImageElement | null)?.src ?? '').includes('%40night'),
    null,
    { timeout: 30_000 },
  );
  await shot(page, '39-adv-night');
  step('临时人物用剪影上台；故事时间到了夜里，背景换成拿白天那张改出来的夜晚版本');
  // 开口满 3 拍：写进世界成了正式角色，舞台上不再是剪影
  const ownerFile = async () => {
    const dirs = await readdir(path.join(dataDir, 'worlds', fogWorld, 'characters'));
    for (const d of dirs) {
      const c = JSON.parse(await readFile(path.join(dataDir, 'worlds', fogWorld, 'characters', d, 'character.json'), 'utf8')) as { id: string; name: string };
      if (c.name === '码头老板') return c.id;
    }
    return null;
  };
  // 升级在后台写角色卡，等一会儿；还没满 3 拍就再问一次
  const upgraded = async () => {
    for (let i = 0; i < 60; i++) {
      const id = await ownerFile();
      if (id) return id;
      await page.waitForTimeout(50);
    }
    return null;
  };
  let ownerId = await upgraded();
  for (let i = 0; i < 3 && !ownerId; i++) {
    await askOwner();
    ownerId = await upgraded();
  }
  assert.ok(ownerId, '码头老板应该升级成了正式角色');
  await askOwner();
  await page.waitForSelector(`[data-testid="adv-sprite"][data-char="${ownerId}"]`);
  assert.equal(await page.$('[data-testid="stage-silhouette"]'), null);
  step('临时人物开口满 3 拍，升级成正式角色（写进世界），舞台上认得出他');

  // 收集里有导演标的 CG；素材页里有这张 CG 和夜晚的背景
  await page.click('[data-testid="adv-exit"]');
  await page.click('button:has-text("收集")');
  await page.waitForSelector('[data-testid="collection-ai-cg"]');
  await shot(page, '40-collection-ai-cg');
  await page.click('[data-testid="tab-assets"]');
  await page.waitForSelector('[data-testid="asset-slot"][data-slot^="cg/ai_"][data-status="done"]');
  await page.waitForSelector('[data-testid="asset-slot"][data-slot$="@night"][data-status="done"]');
  await page.waitForSelector(`[data-testid="asset-character"][data-character="${ownerId}"]`);
  await page.locator('[data-testid="asset-slot"][data-slot^="cg/ai_"]').first().scrollIntoViewIfNeeded();
  await shot(page, '41-assets-cg');
  step('收集里有导演标的 CG；素材页里有这张 CG、夜晚的背景和升级后的码头老板的立绘');

  // ── M4 第 6 步：本地生图（ComfyUI）。接入点从预设添加（地址换成假的 ComfyUI），图像职责选 ComfyUI
  await page.click('[data-nav="settings"]');
  await page.click('[data-testid="add-endpoint"]');
  await page.selectOption('[data-testid="preset"]', 'comfyui');
  assert.equal(await page.inputValue('input[name="baseURL"]'), 'http://127.0.0.1:8188');
  await page.fill('input[name="baseURL"]', server.comfyURL);
  await page.click('[data-testid="save-endpoint"]');
  await page.waitForSelector('text=已保存「ComfyUI（本地生图）」');
  await page.click('button:has-text("职责路由")');
  const comfyId = await page.$eval('[data-testid="role-endpoint-image"] option:last-child', (o) => (o as HTMLOptionElement).value);
  await page.selectOption('[data-testid="role-endpoint-image"]', comfyId);
  await page.selectOption('[data-testid="role-api-image"]', 'comfyui');
  await page.fill('[data-testid="role-model-image"]', '');
  // 读取模型：从 ComfyUI 的 /object_info 读 checkpoint，还没填模型时填第一个
  await page.click('[data-testid="role-comfy-models"]');
  await page.waitForFunction(() => (document.querySelector('[data-testid="role-model-image"]') as HTMLInputElement).value === 'mock-sdxl.safetensors');
  // 工作流：内置的文生图、改图两个；写错的占位符马上提示，恢复内置
  await page.click('[data-testid="role-comfy-workflows"]');
  assert.match(await page.inputValue('[data-testid="comfy-edit"]'), /"LoadImage"[\s\S]*\{\{image\}\}/);
  await page.fill('[data-testid="comfy-generate"]', '{"1": {"class_type": "KSampler", "inputs": {"text": "{{prompt}}", "steps": "{{steps}}"}}}');
  await page.waitForSelector('[data-testid="comfy-problem"] >> text={{steps}}');
  await page.click('[data-testid="comfy-generate-reset"]');
  await page.waitForSelector('[data-testid="comfy-problem"]', { state: 'detached' });
  await page.fill('[data-testid="comfy-pollSeconds"]', '0.1');
  const comfyBefore = server.comfyRequests.length;
  await page.click('[data-testid="role-test-image"]');
  await page.waitForFunction(() => {
    const img = document.querySelector('[data-testid="role-test-image-image"]') as HTMLImageElement | null;
    return !!img && img.complete && img.naturalWidth > 0;
  }, null, { timeout: 20_000 });
  assert.equal(server.comfyRequests.length, comfyBefore + 1);
  assert.equal(server.comfyRequests.at(-1)?.model, 'mock-sdxl.safetensors');
  await page.locator('[data-testid="role-image"]').scrollIntoViewIfNeeded();
  await shot(page, '42-comfy-role');
  await page.click('[data-testid="role-save-image"]');
  await page.waitForSelector('[data-testid="role-save-image"]', { state: 'detached' });
  const savedComfy = JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8')) as {
    media: { image?: { api: string; model: string; comfy?: { generate: string; pollSeconds: number } } };
  };
  assert.deepEqual(
    { api: savedComfy.media.image?.api, model: savedComfy.media.image?.model, generate: savedComfy.media.image?.comfy?.generate, poll: savedComfy.media.image?.comfy?.pollSeconds },
    { api: 'comfyui', model: 'mock-sdxl.safetensors', generate: '', poll: 0.1 },
  );
  step('图像职责换成本地的 ComfyUI：从预设加接入点、读取模型、看内置的工作流、写错马上提示、测试画一张、保存');

  // 素材页里重抽一张背景、一张表情差分：都走 ComfyUI，表情差分先把基础立绘上传过去再改图
  await page.click('[data-nav="home"]');
  await page.click('[data-testid="world-card"] >> text=旧书库的约定');
  await page.click('[data-testid="tab-assets"]');
  for (const slotId of ['bg/loc_seaside', 'sprite/char_lin/smile']) {
    const n = server.comfyRequests.length;
    const target = page.locator(`[data-testid="asset-slot"][data-slot="${slotId}"]`);
    await target.scrollIntoViewIfNeeded();
    await target.locator('[data-testid="asset-regenerate"]').click();
    await until(() => server.comfyRequests.length > n, `ComfyUI 收到 ${slotId} 的工作流`);
    await page.waitForSelector(`[data-testid="asset-slot"][data-slot="${slotId}"][data-status="done"]`, { timeout: 20_000 });
  }
  const [bgReq, smileReq] = server.comfyRequests.slice(-2);
  assert.equal(bgReq?.image, null);
  assert.ok(smileReq?.image && server.comfyUploads.includes(smileReq.image), '表情差分要先上传基础立绘');
  await page.locator('[data-testid="asset-slot"][data-slot="sprite/char_lin/smile"]').scrollIntoViewIfNeeded();
  await shot(page, '43-assets-comfy');
  step('素材页重抽背景和表情差分都走 ComfyUI：背景用文生图工作流，表情差分上传基础立绘后用改图工作流');

  // ── M5 第 1 步：世界编辑器（还在「旧书库的约定」）
  const libDir = path.join(dataDir, 'worlds', 'old_library');
  const libJson = async (rel: string) => JSON.parse(await readFile(path.join(libDir, rel), 'utf8'));
  await page.click('[data-testid="tab-characters"]');
  const linForm = '[data-testid="editing-character:char_lin"]';
  await page.hover('[data-panel="character:char_lin"]');
  await page.click('[data-testid="edit-character:char_lin"]');
  await page.fill(`${linForm} [data-testid="field-summary"]`, '在旧书库里找一本不存在的书。');
  // 改过的字段旁边的锁：保存时会自动锁上
  assert.equal(await page.getAttribute(`${linForm} [data-testid="lock-summary"]`, 'data-state'), 'pending');
  await shot(page, '44-editor-character');
  // 没保存就切标签：先问
  await page.click('[data-testid="tab-locations"]');
  await page.waitForSelector('[data-testid="unsaved-dialog"]');
  await page.click('[data-testid="unsaved-dialog"] >> text=接着改');
  await page.click(`${linForm} [data-testid="save-edit"]`);
  await page.waitForSelector('[data-panel="character:char_lin"] >> text=在旧书库里找一本不存在的书。');
  assert.deepEqual((await libJson('characters/char_lin/character.json'))._meta.locked, ['summary']);
  await page.hover('[data-panel="character:char_lin"]');
  await page.click('[data-testid="history-character:char_lin"]');
  await page.click('[data-testid="history-item"] >> nth=0');
  await page.waitForSelector('[data-testid="history-dialog"] pre');
  await shot(page, '45-editor-history');
  await page.click('[data-testid="history-dialog"] >> text=关闭');
  step('世界编辑器：改角色的简介，改过的字段自动锁住；没保存就切标签先问；历史里有改之前的版本');

  // 加一个角色：分配 id，填了的字段锁住，素材页里马上有他的立绘槽
  await page.click('[data-testid="add-character"]');
  const newForm = '[data-testid="editing-character-new"]';
  await page.fill(`${newForm} [data-testid="field-name"]`, '守夜人');
  await page.fill(`${newForm} [data-testid="field-summary"]`, '夜里看管旧书库的人');
  await page.click(`${newForm} [data-testid="save-edit"]`);
  await page.waitForSelector('[data-panel="character:char_02"] >> text=守夜人');
  assert.deepEqual((await libJson('characters/char_02/character.json'))._meta.locked, ['name', 'summary']);
  await page.click('[data-testid="tab-assets"]');
  await page.waitForSelector('[data-testid="asset-character"][data-character="char_02"]');
  step('加一个角色「守夜人」：写进世界，素材页里有了他的立绘');

  // 删一个地点：先列出用到它的地方（剧情图的幕），一起去掉
  await page.click('[data-testid="tab-locations"]');
  await page.hover('[data-panel="location:loc_seaside"]');
  await page.click('[data-testid="edit-location:loc_seaside"]');
  await page.click('[data-testid="editing-location:loc_seaside"] [data-testid="delete-entity"]');
  await page.waitForSelector('[data-testid="delete-dialog"] >> text=剧情图');
  await shot(page, '46-editor-delete');
  await page.click('[data-testid="delete-confirm"]');
  await page.waitForSelector('text=已删除「海堤」');
  const outlineAfter = (await libJson('plot/outline.json')) as { scenes: { location?: string }[] };
  assert.ok(!outlineAfter.scenes.some((x) => x.location === 'loc_seaside'), '剧情图里不该再有海堤');
  assert.equal((await readdir(path.join(libDir, '.history', 'locations', 'loc_seaside.json'))).length, 1);
  step('删掉地点「海堤」：列出剧情图里用到它的幕，一起去掉；删掉的文件留在历史里');

  // 设置里关掉自动锁；在 JSON 里改世界的简介，保存后不加锁
  await page.click('[data-nav="settings"]');
  await page.click('[data-testid="tab-editor"]');
  await page.uncheck('[data-testid="editor-autolock"]');
  await page.click('[data-testid="editor-settings-save"]');
  await page.waitForSelector('text=已保存编辑器设置');
  assert.equal(JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8')).editor.autoLock, false);
  await page.click('[data-nav="home"]');
  await page.click('[data-testid="world-card"] >> text=旧书库的约定');
  await page.hover('[data-panel="manifest"]');
  await page.click('[data-testid="edit-manifest"]');
  await page.click('[data-testid="toggle-json"]');
  const manifestJson = JSON.parse(await page.inputValue('[data-testid="json-editor"]')) as Record<string, unknown>;
  await page.fill('[data-testid="json-editor"]', JSON.stringify({ ...manifestJson, logline: '改过的简介' }, null, 2));
  await page.click('[data-testid="save-edit"]');
  await page.waitForSelector('[data-panel="manifest"] >> text=改过的简介');
  const libManifest = await libJson('world.json');
  assert.equal(libManifest.logline, '改过的简介');
  assert.deepEqual(libManifest.locked, []);
  step('设置里关掉自动锁；在 JSON 里改世界的简介，保存后不加锁');

  console.log('✓ 端到端冒烟测试通过');
} finally {
  await app.close();
  await server.close();
  await rm(dataDir, { recursive: true, force: true });
}
