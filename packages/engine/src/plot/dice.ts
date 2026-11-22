/**
 * 检定由引擎掷骰（docs/ARCHITECTURE.md 16.4）。骰子跟剧情位置绑定：
 * 种子 = 哈希（周目 id + 这一行动的父事件 id + 检定 id）。重抽、回退后再选同一项，结果都不变。
 */
import type { CheckSpec } from '@auto-adv/schema';
import type { CheckOutcome } from './conditions.ts';

/** 写进事件树的一次检定结果。 */
export interface CheckResult {
  id: string;
  label: string;
  var?: string;
  dc: number;
  /** d20 的点数。 */
  roll: number;
  modifier: number;
  total: number;
  outcome: CheckOutcome;
}

/** cyrb53：小而均匀的字符串哈希（不用于安全场景）。 */
function hash53(str: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export function d20(seed: string): number {
  return 1 + (hash53(seed) % 20);
}

/** 四档：掷出 20 大成功；掷出 1 总是失败；总值达到 dc 成功；只差 1～2 点险胜（做到了但有代价）；其余失败。 */
export function outcomeOf(roll: number, total: number, dc: number): CheckOutcome {
  if (roll === 20) return 'crit';
  if (roll === 1) return 'fail';
  if (total >= dc) return 'success';
  if (dc - total <= 2) return 'narrow';
  return 'fail';
}

export function rollCheck(
  spec: CheckSpec & { id: string },
  modifier: number,
  seed: { playthroughId: string; parentId: string | null },
): CheckResult {
  const roll = d20(`${seed.playthroughId}|${seed.parentId ?? ''}|${spec.id}`);
  const total = roll + modifier;
  return {
    id: spec.id,
    label: spec.label,
    ...(spec.var ? { var: spec.var } : {}),
    dc: spec.dc,
    roll,
    modifier,
    total,
    outcome: outcomeOf(roll, total, spec.dc),
  };
}

export const OUTCOME_LABELS: Record<CheckOutcome, string> = {
  crit: '大成功',
  success: '成功',
  narrow: '险胜',
  fail: '失败',
};
