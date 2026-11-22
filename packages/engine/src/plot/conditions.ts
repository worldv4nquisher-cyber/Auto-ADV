/**
 * 声明式条件的求值（docs/ARCHITECTURE.md 16.3）。纯函数，不经过模型，也不执行任何代码。
 */
import { COMPARE_OPS, type CompareOp, type Condition, type Scalar, type VariableDef } from '@auto-adv/schema';

/** 检定的四档结果（16.4）。大成功、成功、险胜都算"通过"。 */
export type CheckOutcome = 'crit' | 'success' | 'narrow' | 'fail';

export const isPass = (o: CheckOutcome) => o !== 'fail';

export interface ConditionContext {
  vars: Readonly<Record<string, Scalar>>;
  /** 当前路径上走过的幕（含当前幕）。 */
  visited: ReadonlySet<string>;
  /** 这一幕最近一次检定的结果；这一幕还没检定过为 null。 */
  check: CheckOutcome | null;
}

function compare(op: CompareOp, a: Scalar | undefined, b: Scalar): boolean {
  if (a === undefined) return false;
  if (typeof a === 'number' && typeof b === 'number') {
    switch (op) {
      case 'eq':
        return a === b;
      case 'ne':
        return a !== b;
      case 'gt':
        return a > b;
      case 'gte':
        return a >= b;
      case 'lt':
        return a < b;
      case 'lte':
        return a <= b;
    }
  }
  // 字符串和布尔值只能比较相等；类型对不上算"不成立"
  if (typeof a !== typeof b) return false;
  if (op === 'eq') return a === b;
  if (op === 'ne') return a !== b;
  return false;
}

/** 求值。没有条件（undefined）算成立；读到不存在的变量算不成立。 */
export function evalCondition(c: Condition | undefined, ctx: ConditionContext): boolean {
  if (!c) return true;
  if ('all' in c) return c.all.every((x) => evalCondition(x, ctx));
  if ('any' in c) return c.any.some((x) => evalCondition(x, ctx));
  if ('not' in c) return !evalCondition(c.not, ctx);
  if ('flag' in c) return ctx.vars[c.flag] === true;
  if ('visited' in c) return ctx.visited.has(c.visited);
  if ('check' in c) return ctx.check !== null && (c.check === 'pass') === isPass(ctx.check);
  for (const op of COMPARE_OPS) {
    if (op in c) {
      const [v, value] = (c as Record<CompareOp, [string, Scalar]>)[op];
      return compare(op, ctx.vars[v], value);
    }
  }
  return false;
}

/** 条件里的每一个"叶子"（比较、标记、走过、检定），结构检查用。 */
export type ConditionLeaf =
  | { kind: 'compare'; op: CompareOp; var: string; value: Scalar }
  | { kind: 'flag'; var: string }
  | { kind: 'visited'; scene: string }
  | { kind: 'check'; value: 'pass' | 'fail' };

export function conditionLeaves(c: Condition | undefined): ConditionLeaf[] {
  if (!c) return [];
  if ('all' in c) return c.all.flatMap(conditionLeaves);
  if ('any' in c) return c.any.flatMap(conditionLeaves);
  if ('not' in c) return conditionLeaves(c.not);
  if ('flag' in c) return [{ kind: 'flag', var: c.flag }];
  if ('visited' in c) return [{ kind: 'visited', scene: c.visited }];
  if ('check' in c) return [{ kind: 'check', value: c.check }];
  for (const op of COMPARE_OPS) {
    if (op in c) {
      const [v, value] = (c as Record<CompareOp, [string, Scalar]>)[op];
      return [{ kind: 'compare', op, var: v, value }];
    }
  }
  return [];
}

const OP_TEXT: Record<CompareOp, string> = { eq: '=', ne: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤' };

/** 把条件写成人能读的一句话（命令行和锁住的选项用）。 */
export function describeCondition(
  c: Condition | undefined,
  names: { vars?: ReadonlyMap<string, VariableDef>; scenes?: ReadonlyMap<string, string> } = {},
  nested = false,
): string {
  if (!c) return '无条件';
  const v = (id: string) => names.vars?.get(id)?.label || id;
  const join = (xs: Condition[], sep: string) => {
    if (xs.length === 1) return describeCondition(xs[0], names, nested);
    const text = xs.map((x) => describeCondition(x, names, true)).join(sep);
    return nested ? `（${text}）` : text;
  };
  if ('all' in c) return c.all.length ? join(c.all, ' 且 ') : '总是成立';
  if ('any' in c) return c.any.length ? join(c.any, ' 或 ') : '永不成立';
  if ('not' in c) return `并非${describeCondition(c.not, names, true)}`;
  if ('flag' in c) return v(c.flag);
  if ('visited' in c) return `走过「${names.scenes?.get(c.visited) || c.visited}」`;
  if ('check' in c) return c.check === 'pass' ? '检定通过' : '检定失败';
  for (const op of COMPARE_OPS) {
    if (op in c) {
      const [id, value] = (c as Record<CompareOp, [string, Scalar]>)[op];
      return `${v(id)} ${OP_TEXT[op]} ${String(value)}`;
    }
  }
  return '？';
}
