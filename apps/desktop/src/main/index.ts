import { createReadStream, existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import type { HostContract } from '@auto-adv/engine/api';
import { fromNodePort, serveRpc } from '@auto-adv/engine/rpc';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  MessageChannelMain,
  protocol,
  safeStorage,
  shell,
  type UtilityProcess,
  utilityProcess,
} from 'electron';

/**
 * 素材文件通过 adv-asset 协议给界面读（要在 app ready 之前注册）：
 * - adv-asset://world/<世界 id>/assets/...：世界目录下 assets/ 里的文件（背景、立绘、生成的 BGM）；
 * - adv-asset://library/<世界 id>/<相对路径>：这个世界用的本地曲库（世界设置里选的，没选就是全局设置里的）里的音频文件；
 * - adv-asset://builtin/<文件名>：内置曲库里的音频文件。
 */
protocol.registerSchemesAsPrivileged([
  { scheme: 'adv-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const AUDIO_FILE = /\.(mp3|ogg|opus|oga|wav|flac|m4a|aac)$/i;
const notFound = () => new Response('not found', { status: 404 });

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
};

/**
 * 读一个本地文件，支持 Range 请求：<audio> 靠它拿到曲子的时长、能拖动进度（整份返回时时长是 Infinity，
 * 也拖不动）。
 */
async function serveFile(file: string, req: Request): Promise<Response> {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) return notFound();
  const size = stat.size;
  const headers: Record<string, string> = { 'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Accept-Ranges': 'bytes' };
  let start = 0;
  let end = size - 1;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range')?.trim() ?? '');
  const ranged = !!m && !!(m[1] || m[2]);
  if (m && ranged) {
    if (m[1]) {
      start = Number(m[1]);
      if (m[2]) end = Math.min(Number(m[2]), size - 1);
    } else {
      start = Math.max(0, size - Number(m[2])); // bytes=-N：最后 N 个字节
    }
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = String(size ? end - start + 1 : 0);
  const body = size ? (Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream<Uint8Array>) : null;
  return new Response(body as unknown as BodyInit | null, { status: ranged ? 206 : 200, headers });
}

/** 读一个 JSON 文件里的字段；文件不在、格式不对都当作没有。 */
async function readJsonField(file: string, pick: (v: unknown) => unknown): Promise<string> {
  try {
    const v = pick(JSON.parse(await fs.readFile(file, 'utf8')));
    return typeof v === 'string' ? v.trim() : '';
  } catch {
    return '';
  }
}

const libraryDirOf = (v: unknown) => (v as { bgm?: { libraryDir?: unknown } } | undefined)?.bgm?.libraryDir;

/** 这个世界用的本地曲库：世界设置里选了就用它，否则用全局设置里的。 */
async function libraryRoot(worldId: string): Promise<string> {
  const own = await readJsonField(path.join(dataDir(), 'worlds', worldId, 'assets', 'settings.json'), libraryDirOf);
  if (own) return path.resolve(own);
  const global = await readJsonField(path.join(dataDir(), 'settings.json'), (v) => libraryDirOf((v as { assets?: unknown } | undefined)?.assets));
  return global ? path.resolve(global) : '';
}

function serveAssets(): void {
  protocol.handle('adv-asset', async (req) => {
    const url = new URL(req.url);
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (url.host === 'builtin') {
      const root = builtinBgmDir();
      const name = parts.join('/');
      if (!root || !/^[\w.-]+$/.test(name) || !AUDIO_FILE.test(name)) return notFound();
      return serveFile(path.join(root, name), req);
    }
    const [worldId = '', ...rest] = parts;
    if (!/^[a-z0-9_]{1,64}$/.test(worldId)) return notFound();
    if (url.host === 'library') {
      // 只能读曲库文件夹里的音频文件
      const root = await libraryRoot(worldId);
      if (!root || !rest.length || !AUDIO_FILE.test(rest.at(-1) ?? '')) return notFound();
      const file = path.resolve(root, ...rest);
      if (!file.startsWith(root + path.sep)) return notFound();
      return serveFile(file, req);
    }
    if (url.host !== 'world' || rest[0] !== 'assets') return notFound();
    const root = path.join(dataDir(), 'worlds', worldId, 'assets');
    const file = path.resolve(root, ...rest.slice(1));
    if (!file.startsWith(root + path.sep)) return notFound();
    return serveFile(file, req);
  });
}

let engine: UtilityProcess | null = null;
let quitting = false;
let restarts = 0;

/** 用户数据目录。可用环境变量 AUTO_ADV_DATA_DIR 覆盖（测试和便携模式用）。 */
function dataDir(): string {
  return process.env.AUTO_ADV_DATA_DIR ?? path.join(app.getPath('userData'), 'data');
}

/** 主进程提供给引擎的能力：用系统钥匙串加解密（Windows 上是 DPAPI）。 */
const hostHandlers = {
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: ({ plain }: { plain: string }) => safeStorage.encryptString(plain).toString('base64'),
  decrypt: ({ cipher }: { cipher: string }) => safeStorage.decryptString(Buffer.from(cipher, 'base64')),
};

function startEngine(): UtilityProcess {
  const child = utilityProcess.fork(path.join(__dirname, 'engine.js'), [], {
    serviceName: 'Auto-ADV Engine',
    env: { ...process.env, AUTO_ADV_DATA_DIR: dataDir(), AUTO_ADV_BUILTIN_BGM: builtinBgmDir() ?? '' },
    stdio: 'inherit',
  });
  const { port1, port2 } = new MessageChannelMain();
  serveRpc<HostContract>(fromNodePort(port1), hostHandlers);
  child.postMessage({ type: 'host-port' }, [port2]);

  child.once('spawn', () => {
    // 稳定运行一段时间后清零重启计数
    setTimeout(() => {
      if (engine === child) restarts = 0;
    }, 30_000);
  });

  child.once('exit', (code) => {
    if (quitting || engine !== child) return;
    engine = null;
    console.error(`[main] 引擎进程退出（code=${code}）`);
    if (restarts >= 3) {
      console.error('[main] 引擎连续崩溃，不再自动重启');
      return;
    }
    restarts++;
    setTimeout(() => {
      engine = startEngine();
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engine:restarted');
    }, 500 * restarts);
  });
  return child;
}

/** 自带的示例世界：安装包里在 resources/examples，开发时在仓库的 examples/worlds。 */
function examplesDir(): string | undefined {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'examples')]
    : [path.resolve(app.getAppPath(), '../../examples/worlds'), path.resolve(process.cwd(), '../../examples/worlds')];
  return candidates.find((d) => existsSync(d));
}

/**
 * 内置曲库（18.7）：安装包里在 resources/bgm，开发时在仓库的 resources/bgm。
 * 环境变量 AUTO_ADV_BUILTIN_BGM 可以指定别的文件夹（测试用）。
 */
function builtinBgmDir(): string | undefined {
  const own = process.env.AUTO_ADV_BUILTIN_BGM;
  if (own) return path.resolve(own);
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'bgm')]
    : [path.resolve(app.getAppPath(), '../../resources/bgm'), path.resolve(process.cwd(), '../../resources/bgm')];
  return candidates.find((d) => existsSync(d));
}

/** 选一个文件夹（导入世界、本地曲库用），默认打开示例世界所在的文件夹。返回 null 表示取消。 */
ipcMain.handle('dialog:pickFolder', async (event, title: unknown, purpose: unknown) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const opts: Electron.OpenDialogOptions = {
    title: typeof title === 'string' ? title : '选择文件夹',
    ...(purpose === 'music' ? { defaultPath: app.getPath('music') } : { defaultPath: examplesDir() }),
    properties: ['openDirectory'],
  };
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  return r.canceled ? null : (r.filePaths[0] ?? null);
});

/** 选一张图片（换成自己的素材用）。返回 null 表示取消。 */
ipcMain.handle('dialog:pickImage', async (event, title: unknown) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const opts: Electron.OpenDialogOptions = {
    title: typeof title === 'string' ? title : '选择图片',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  };
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  return r.canceled ? null : (r.filePaths[0] ?? null);
});

/** 选一个音频文件（换成自己的 BGM 用）。返回 null 表示取消。 */
ipcMain.handle('dialog:pickAudio', async (event, title: unknown) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const opts: Electron.OpenDialogOptions = {
    title: typeof title === 'string' ? title : '选择音频文件',
    properties: ['openFile'],
    filters: [{ name: '音频', extensions: ['mp3', 'ogg', 'opus', 'wav', 'flac', 'm4a'] }],
  };
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  return r.canceled ? null : (r.filePaths[0] ?? null);
});

/** 界面请求连接引擎：建一条新的 MessageChannel，两端分别交给引擎和界面，之后它们直接通信。 */
ipcMain.on('engine:connect', (event) => {
  if (!engine) return;
  const { port1, port2 } = new MessageChannelMain();
  engine.postMessage({ type: 'client-port' }, [port1]);
  event.sender.postMessage('engine:port', null, [port2]);
});

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'Auto-ADV',
    backgroundColor: '#0e1016',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

if (!app.requestSingleInstanceLock()) {
  // 同时开两个会争抢同一份数据文件
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.setAppUserModelId('com.autoadv.app');

  void app.whenReady().then(() => {
    serveAssets();
    engine = startEngine();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => {
    quitting = true;
    engine?.kill();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
