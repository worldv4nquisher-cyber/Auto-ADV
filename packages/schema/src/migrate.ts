import { isLegacyOutline, LegacyPlotOutline, migratePlotOutline } from './plot.ts';
import { FORMAT_VERSION } from './version.ts';

type Migration = (data: Record<string, unknown>) => Record<string, unknown>;

/**
 * 迁移表：key 是"从哪个版本迁出"。例如 MIGRATIONS[0] 把 v0 的数据升级到 v1。
 * 迁移函数拿到的是任意一个文件的内容，按结构认出自己要改的文件，其他文件原样返回。
 */
const MIGRATIONS: Record<number, Migration> = {
  /** v0 → v1（M3）：plot/outline.json 从"篇章 / 章节 / 节拍"骨架改成剧情图（16.7）。其他文件结构不变。 */
  0: (data) => (isLegacyOutline(data) ? (migratePlotOutline(LegacyPlotOutline.parse(data)) as Record<string, unknown>) : data),
};

/** 把任意旧版本的数据逐步升级到当前版本。不认识的字段原样保留。 */
export function migrate(data: unknown): Record<string, unknown> {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('migrate: 数据必须是一个对象');
  }
  let current = { ...(data as Record<string, unknown>) };
  let version = typeof current.formatVersion === 'number' ? current.formatVersion : 0;
  if (version > FORMAT_VERSION) {
    throw new Error(`这个文件来自更新版本的 Auto-ADV（格式版本 ${version}），请升级应用`);
  }
  while (version < FORMAT_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) throw new Error(`缺少从格式版本 ${version} 升级的迁移函数`);
    current = step(current);
    version += 1;
    current.formatVersion = version;
  }
  return current;
}
