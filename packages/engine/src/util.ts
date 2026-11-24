import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * 原子写文件：先写临时文件再改名，避免写到一半崩溃留下坏文件。
 * Windows 上改名偶尔会被杀毒软件等占用导致 EPERM，稍等重试几次。
 */
export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, data, typeof data === 'string' ? 'utf8' : undefined);
  for (let i = 0; ; i++) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (i < 5 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
        await new Promise((r) => setTimeout(r, 50 * (i + 1)));
        continue;
      }
      await fs.rm(tmp, { force: true });
      throw err;
    }
  }
}

export async function readJsonFile(file: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/** 把"回调式产出 + 最终 Promise"转换成 async generator。 */
export async function* fromCallback<T, R>(run: (emit: (item: T) => void) => Promise<R>): AsyncGenerator<T, R, void> {
  const queue: T[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  let result: R | undefined;
  let error: unknown;
  let failed = false;

  run((item) => {
    queue.push(item);
    wake?.();
  }).then(
    (r) => {
      result = r;
      finished = true;
      wake?.();
    },
    (e: unknown) => {
      error = e;
      failed = true;
      finished = true;
      wake?.();
    },
  );

  while (true) {
    if (queue.length) {
      yield queue.shift() as T;
      continue;
    }
    if (finished) break;
    await new Promise<void>((r) => {
      wake = r;
    });
    wake = null;
  }
  if (failed) throw error;
  return result as R;
}

/** 生成短 id，例如 ep_k3j9x2a1 */
export function shortId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

/** 一个简单的串行队列，保证写文件按顺序进行。 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => {});
    return next;
  }
}
