/**
 * 数值裁决（docs/ARCHITECTURE.md 16.4）：变量存在、类型、范围，以及模型提出的变化每拍的上限。
 */
import type { Scalar, VarEffect, VariableDef } from '@auto-adv/schema';

export type VarValues = Record<string, Scalar>;

export interface VarChange {
  var: string;
  from: Scalar;
  to: Scalar;
}

/** 关系类数值的默认每拍上限。 */
export const RELATIONSHIP_PER_BEAT = { normal: 5, burst: 12 } as const;

export function initialValues(defs: readonly VariableDef[]): VarValues {
  return Object.fromEntries(defs.map((d) => [d.id, d.initial]));
}

/** 这个变量每拍的变化上限；null 表示不限（只受 min / max 约束）。 */
export function perBeatLimit(def: VariableDef): { normal: number; burst: number } | null {
  if (def.perBeat) return def.perBeat;
  if (def.type === 'number' && def.category === 'relationship') return RELATIONSHIP_PER_BEAT;
  return null;
}

function clampRange(def: VariableDef, n: number): number {
  let x = n;
  if (def.min !== undefined) x = Math.max(def.min, x);
  if (def.max !== undefined) x = Math.min(def.max, x);
  return x;
}

const signed = (n: number) => (n >= 0 ? `+${n}` : String(n));
const nameOf = (def: VariableDef) => `「${def.label || def.id}」`;

export interface ApplyOptions {
  /**
   * author：剧本作者写死的效果（手写剧本的 set、出口 / 选项上声明的效果），只检查范围；
   * model：模型提出的变化，同一个变量一拍里的合计变化不能超过上限。
   */
  source: 'author' | 'model';
  /** 这一拍演到了当前幕的要点或检定成功：允许用 burst 上限。 */
  burst?: boolean;
}

export interface ApplyResult {
  values: VarValues;
  /** 实际发生的变化（每个变量一条，from 是这批变化之前的值）。 */
  changes: VarChange[];
  /** 被驳回或截断的理由，写进这一拍的记录，下一拍反馈给导演。 */
  notes: string[];
}

/** 把一批变化应用到当前值上。不合法的丢掉，超出上限或范围的截断，理由写进 notes。 */
export function applyEffects(
  defs: readonly VariableDef[],
  values: Readonly<VarValues>,
  effects: readonly VarEffect[],
  opts: ApplyOptions,
): ApplyResult {
  const byId = new Map(defs.map((d) => [d.id, d]));
  const next: VarValues = { ...values };
  const notes: string[] = [];
  const touched: string[] = [];

  for (const e of effects) {
    const def = byId.get(e.var);
    if (!def) {
      notes.push(`变量 ${e.var} 不存在，已忽略`);
      continue;
    }
    const cur = next[def.id] ?? def.initial;
    let target: Scalar;
    if (def.type === 'number') {
      if (typeof e.value !== 'number') {
        notes.push(`${nameOf(def)}是数值，不能设成 ${JSON.stringify(e.value)}`);
        continue;
      }
      const base = typeof cur === 'number' ? cur : Number(def.initial);
      target = e.op === '+' ? base + e.value : e.op === '-' ? base - e.value : e.value;
    } else {
      if (e.op !== '=') {
        notes.push(`${nameOf(def)}不是数值，只能直接赋值`);
        continue;
      }
      if (typeof e.value !== def.type) {
        notes.push(`${nameOf(def)}的类型是 ${def.type}，不能设成 ${JSON.stringify(e.value)}`);
        continue;
      }
      target = e.value;
    }
    next[def.id] = target;
    if (!touched.includes(def.id)) touched.push(def.id);
  }

  const changes: VarChange[] = [];
  for (const id of touched) {
    const def = byId.get(id) as VariableDef;
    const from = values[id] ?? def.initial;
    let to = next[id] as Scalar;
    if (def.type === 'number' && typeof to === 'number' && typeof from === 'number') {
      const limit = opts.source === 'model' ? perBeatLimit(def) : null;
      if (limit) {
        const max = opts.burst ? limit.burst : limit.normal;
        const delta = to - from;
        if (Math.abs(delta) > max) {
          const capped = Math.sign(delta) * max;
          notes.push(`${nameOf(def)}一拍最多变化 ±${max}，提议的 ${signed(delta)} 截成 ${signed(capped)}`);
          to = from + capped;
        }
      }
      const ranged = clampRange(def, to);
      if (ranged !== to) {
        notes.push(`${nameOf(def)}超出范围 ${def.min ?? '-∞'}～${def.max ?? '∞'}，截到 ${ranged}`);
        to = ranged;
      }
    }
    next[id] = to;
    if (to !== from) changes.push({ var: id, from, to });
  }
  return { values: next, changes, notes };
}

/** 合并同一拍里先后几批变化：每个变量保留最早的 from 和最后的 to。 */
export function mergeChanges(...batches: VarChange[][]): VarChange[] {
  const out = new Map<string, VarChange>();
  for (const c of batches.flat()) {
    const prev = out.get(c.var);
    out.set(c.var, { var: c.var, from: prev ? prev.from : c.from, to: c.to });
  }
  return [...out.values()].filter((c) => c.from !== c.to);
}
