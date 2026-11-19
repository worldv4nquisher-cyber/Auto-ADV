/**
 * 端到端冒烟测试：真正启动 Electron 应用，连一个本地模拟的 OpenAI 兼容服务，走一遍完整流程：
 * 添加接入点 → 拉取模型 → 能力探测 → 设置职责路由 → 调试台对话 → 查看调用日志（M0）
 * → 一键创世 → 开始周目 → 对话 → 重抽 / 切换分支 → 存档 → 继续 → 读档（M1）。
 *
 * 用法：先 `pnpm build`，再 `pnpm e2e`。Linux 无显示环境用 `xvfb-run -a pnpm e2e`。
 * 设置 E2E_SCREENSHOTS=目录 可以保存各步骤截图。
 * 设置 E2E_APP_PATH=打包后的可执行文件 可以测试安装包里的应用（例如 release/win-unpacked/Auto-ADV.exe）。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startMockServer } from '@auto-adv/providers/testing';
import { _electron as electron, type Page } from 'playwright-core';

const appDir = path.resolve(import.meta.dirname, '..');
const shotsDir = process.env.E2E_SCREENSHOTS;
const API_KEY = 'sk-e2e-secret-key';

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
  await page.waitForSelector('[data-testid="start-play"]:not([disabled])');
  await page.waitForSelector('text=雾港谜灯');
  step('一键创世完成：雾港谜灯');
  await page.click('button:has-text("角色") >> nth=0');
  await page.waitForSelector('text=主角（你）');
  await shot(page, '09-world-characters');
  await page.click('button:has-text("概览")');

  // ── 游玩：对话、重抽、分支
  await page.click('[data-testid="start-play"]');
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

  // ── 世界文件夹
  const worlds = await readdir(path.join(dataDir, 'worlds'));
  assert.equal(worlds.length, 1);
  const worldJson = JSON.parse(await readFile(path.join(dataDir, 'worlds', worlds[0] as string, 'world.json'), 'utf8'));
  assert.equal(worldJson.status, 'ready');
  step(`世界文件夹已写入：worlds/${worlds[0]}`);

  console.log('✓ 端到端冒烟测试通过');
} finally {
  await app.close();
  await server.close();
  await rm(dataDir, { recursive: true, force: true });
}
