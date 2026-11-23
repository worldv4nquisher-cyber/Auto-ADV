import { existsSync } from 'node:fs';
import path from 'node:path';
import type { HostContract } from '@auto-adv/engine/api';
import { fromNodePort, serveRpc } from '@auto-adv/engine/rpc';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  MessageChannelMain,
  safeStorage,
  shell,
  type UtilityProcess,
  utilityProcess,
} from 'electron';

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
    env: { ...process.env, AUTO_ADV_DATA_DIR: dataDir() },
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

/** 选一个文件夹（导入世界用），默认打开示例世界所在的文件夹。返回 null 表示取消。 */
ipcMain.handle('dialog:pickFolder', async (event, title: unknown) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const opts: Electron.OpenDialogOptions = {
    title: typeof title === 'string' ? title : '选择文件夹',
    defaultPath: examplesDir(),
    properties: ['openDirectory'],
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
