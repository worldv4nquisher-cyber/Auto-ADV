/**
 * 锁（docs/ARCHITECTURE.md 20.4）：字段路径的读写，重抽以后把锁住的字段原样盖回去，
 * 以及交给模型的"已经定了、原样保留"的内容。只做纯计算。
 */

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 这个字段锁着没有：锁了它自己、它的上一层，或者整个（`*`）。 */
export function isLockedPath(locked: readonly string[], path: string): boolean {
  return locked.includes('*') || locked.some((x) => x === path || path.startsWith(`${x}.`));
}

/** 按 `a.b.c` 读一个字段。 */
export function getAt(v: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((x, k) => (isObject(x) ? x[k] : undefined), v);
}

/** 按 `a.b.c` 写一个字段，返回新对象（沿路复制，不改原来的）；value 为 undefined 时去掉这个字段。 */
export function setAt<T>(v: T, path: string, value: unknown): T {
  const [head, ...rest] = path.split('.') as [string, ...string[]];
  const base: Record<string, unknown> = isObject(v) ? { ...v } : {};
  if (!rest.length) {
    if (value === undefined) delete base[head];
    else base[head] = structuredClone(value);
  } else {
    base[head] = setAt(base[head], rest.join('.'), value);
  }
  return base as T;
}

/**
 * 模型写回来以后，把锁住的字段换回原来的（第 2 节第 4 条"LLM 提议，引擎裁决"）：
 * 模型改没改都不影响结果。整个锁住（`*`）就是原来的样子。
 */
export function applyLocks<T>(fresh: T, old: T | null | undefined, locked: readonly string[]): T {
  if (!old || !locked.length) return fresh;
  if (locked.includes('*')) return structuredClone(old);
  let out = fresh;
  for (const p of locked) out = setAt(out, p, getAt(old, p));
  return out;
}

/** 这些字段是不是全锁了（全锁了这一步就不用调模型）。 */
export function allLocked(locked: readonly string[], fields: readonly string[]): boolean {
  return fields.every((f) => isLockedPath(locked, f));
}

/** 交给模型的一项"已经定了"的内容。 */
export interface FixedItem {
  label: string;
  value: string;
}

/** 字段的值写成给模型看的一行：列表用顿号连起来。 */
export function plain(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) return v.map(plain).filter(Boolean).join('、');
  if (isObject(v)) {
    if (typeof v.text === 'string') return v.text.trim();
    return Object.values(v).map(plain).filter(Boolean).join('；');
  }
  return String(v);
}

/** 按字段表列出锁住的字段（有内容的才列）。fields：[路径, 名称, 自定义的写法]。 */
export function fixedItems(
  value: unknown,
  locked: readonly string[],
  fields: readonly (readonly [string, string, ((v: unknown) => string)?])[],
): FixedItem[] {
  const out: FixedItem[] = [];
  for (const [path, label, fmt] of fields) {
    if (!isLockedPath(locked, path)) continue;
    const v = getAt(value, path);
    const text = fmt ? fmt(v) : plain(v);
    if (text) out.push({ label, value: text });
  }
  return out;
}
