import { contextBridge, ipcRenderer } from 'electron';

// MessagePort 不能通过 contextBridge 传递，按 Electron 推荐的方式用 window.postMessage 转交给页面
ipcRenderer.on('engine:port', (event) => {
  window.postMessage({ type: 'auto-adv:engine-port' }, '*', event.ports);
});
ipcRenderer.on('engine:restarted', () => {
  window.postMessage({ type: 'auto-adv:engine-restarted' }, '*');
});

const bridge = {
  connectEngine: () => ipcRenderer.send('engine:connect'),
  /** 选一个文件夹；取消时为 null。 */
  pickFolder: (title?: string): Promise<string | null> => ipcRenderer.invoke('dialog:pickFolder', title),
  /** 选一张图片（PNG、JPEG、WebP）；取消时为 null。 */
  pickImage: (title?: string): Promise<string | null> => ipcRenderer.invoke('dialog:pickImage', title),
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
};

export type AutoAdvBridge = typeof bridge;

contextBridge.exposeInMainWorld('autoAdv', bridge);
