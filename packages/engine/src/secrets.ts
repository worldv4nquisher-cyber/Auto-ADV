import path from 'node:path';
import { readJsonFile, SerialQueue, writeFileAtomic } from './util.ts';

/** 密钥存储。API Key 只在这里出现，绝不写进设置文件、世界包或调用日志。 */
export interface SecretStore {
  get(id: string): Promise<string | undefined>;
  set(id: string, value: string): Promise<void>;
  delete(id: string): Promise<void>;
  /** 是否经过系统加密保存。 */
  isEncrypted(): Promise<boolean>;
}

/** 加解密实现。桌面端由主进程的 safeStorage 提供（Windows 上是 DPAPI）。 */
export interface Cipher {
  isAvailable(): Promise<boolean>;
  encrypt(plain: string): Promise<string>;
  decrypt(cipher: string): Promise<string>;
}

interface SecretsFile {
  version: 1;
  entries: Record<string, { encrypted: boolean; value: string }>;
}

/** 保存在 secrets.json 里；有加密能力时加密保存，没有时退回明文并如实报告。 */
export class FileSecretStore implements SecretStore {
  private readonly file: string;
  private readonly cipher: Cipher | null;
  private readonly cache = new Map<string, string>();
  private data: SecretsFile | null = null;
  private readonly queue = new SerialQueue();

  constructor(dir: string, cipher: Cipher | null) {
    this.file = path.join(dir, 'secrets.json');
    this.cipher = cipher;
  }

  private async load(): Promise<SecretsFile> {
    if (this.data) return this.data;
    const raw = (await readJsonFile(this.file)) as SecretsFile | undefined;
    this.data = raw && raw.version === 1 && typeof raw.entries === 'object' ? raw : { version: 1, entries: {} };
    return this.data;
  }

  async isEncrypted(): Promise<boolean> {
    return this.cipher ? this.cipher.isAvailable() : false;
  }

  async get(id: string): Promise<string | undefined> {
    const cached = this.cache.get(id);
    if (cached !== undefined) return cached;
    const entry = (await this.load()).entries[id];
    if (!entry) return undefined;
    let value = entry.value;
    if (entry.encrypted) {
      if (!this.cipher) throw new Error('这个密钥是加密保存的，但当前环境无法解密');
      value = await this.cipher.decrypt(entry.value);
    }
    this.cache.set(id, value);
    return value;
  }

  set(id: string, value: string): Promise<void> {
    return this.queue.run(async () => {
      const data = await this.load();
      const encrypted = await this.isEncrypted();
      data.entries[id] = { encrypted, value: encrypted && this.cipher ? await this.cipher.encrypt(value) : value };
      this.cache.set(id, value);
      await writeFileAtomic(this.file, JSON.stringify(data, null, 2));
    });
  }

  delete(id: string): Promise<void> {
    return this.queue.run(async () => {
      const data = await this.load();
      delete data.entries[id];
      this.cache.delete(id);
      await writeFileAtomic(this.file, JSON.stringify(data, null, 2));
    });
  }
}

/** 只在内存里保存，用于测试。 */
export class MemorySecretStore implements SecretStore {
  private readonly map = new Map<string, string>();
  async get(id: string) {
    return this.map.get(id);
  }
  async set(id: string, value: string) {
    this.map.set(id, value);
  }
  async delete(id: string) {
    this.map.delete(id);
  }
  async isEncrypted() {
    return false;
  }
}

export const endpointKeyId = (endpointId: string) => `endpoint:${endpointId}:apiKey`;
