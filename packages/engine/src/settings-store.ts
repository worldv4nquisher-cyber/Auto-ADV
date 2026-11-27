import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AppSettings, migrate } from '@auto-adv/schema';
import { readJsonFile, SerialQueue, writeFileAtomic } from './util.ts';

/** settings.json 的读写。文件损坏时备份后用默认设置启动，不让应用起不来。 */
export class SettingsStore {
  private readonly file: string;
  private current: AppSettings | null = null;
  private readonly queue = new SerialQueue();
  /** 启动时如果发现文件损坏，这里记录备份位置。 */
  recoveredFrom: string | null = null;

  constructor(dir: string) {
    this.file = path.join(dir, 'settings.json');
  }

  async get(): Promise<AppSettings> {
    if (this.current) return this.current;
    let raw: unknown;
    try {
      raw = await readJsonFile(this.file);
      this.current = AppSettings.parse(raw === undefined ? {} : migrate(raw));
    } catch (err) {
      const backup = `${this.file}.corrupt-${Date.now()}`;
      await fs.copyFile(this.file, backup).catch(() => {});
      this.recoveredFrom = backup;
      console.error(`[settings] settings.json 无法读取，已备份到 ${backup}：`, err);
      this.current = AppSettings.parse({});
    }
    return this.current;
  }

  /** 已经读进来的设置（还没读过时为 null），给不能等的地方用。 */
  peek(): AppSettings | null {
    return this.current;
  }

  /** 基于最新设置做修改并保存。修改函数返回新设置。 */
  update(mutator: (s: AppSettings) => AppSettings): Promise<AppSettings> {
    return this.queue.run(async () => {
      const next = AppSettings.parse(mutator(structuredClone(await this.get())));
      await writeFileAtomic(this.file, JSON.stringify(next, null, 2));
      this.current = next;
      return next;
    });
  }
}
