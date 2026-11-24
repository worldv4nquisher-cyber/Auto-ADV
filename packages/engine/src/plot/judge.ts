/**
 * AI 演出的一拍怎么落到剧情图上（docs/ARCHITECTURE.md 16.2、16.4）：导演报告演到了哪些要点、这一幕是否演完、
 * 想走哪个出口、提议哪些数值变化，引擎逐条核对，合法的才记下，不合法的带着理由写进 notes，下一拍反馈给导演。
 * 纯函数，观察模式和剧情 ADV 共用。
 */
import { type CheckSpec, type PlayMode, type PlotScene, type Scalar, type VarEffect, type VariableDef, VarId } from '@auto-adv/schema';
import type { PlotAppend, PlotMark, PlotMenu } from '../api.ts';
import type { UnlockKind } from '../play/db.ts';
import { describeCondition, evalCondition } from './conditions.ts';
import { type CheckResult, rollCheck } from './dice.ts';
import { inAppendedScene, type PlotState, sceneById } from './progress.ts';
import { conditionContext } from './runner.ts';
import { choosableExits, decideTransition, exitCheckShown } from './transition.ts';
import { applyEffects, mergeChanges } from './vars.ts';

/** 导演对这一拍剧情进度的报告（模型的原始输出，还没核对）。 */
export interface DirectorReport {
  /** 这一拍演到的要点 id。 */
  points: readonly string[];
  /** 这一幕演完了。 */
  sceneDone: boolean;
  /** 想走的出口（目标幕 id），不走为空。 */
  exit: string;
  /** 这一拍偏离了当前幕。 */
  offTrack: boolean;
  /** 提议的数值变化。 */
  set: readonly { var: string; op: string; value: unknown }[];
}

export interface JudgeInput {
  /** 这一拍之前的进度（玩家的选项、输入、检定已经折叠进去了）。 */
  state: PlotState;
  variables: readonly VariableDef[];
  mode: PlayMode;
  report: DirectorReport;
  /** 这一拍有没有玩家行动（ADV 的岔路只能由玩家决定）。 */
  playerAction: boolean;
  /** 这一拍的检定（导演安排里的，或者玩家选项上的），成功时数值变化可以用突破上限。 */
  check: CheckResult | null;
  /** 回复被截断了（截断时 auto 出口不走）。 */
  truncated?: boolean;
  /** 续写：这一拍开始前追加的章和幕（state 里已经接上了）。 */
  append?: PlotAppend;
}

/** 剧情 ADV：连续几拍偏离当前幕就问玩家怎么处理（16.6）。 */
export const DRIFT_ASK_AFTER = 2;

export interface Judged {
  mark: PlotMark;
  /** 这一拍解锁的东西（16.8）。 */
  unlocks: { kind: UnlockKind; id: string }[];
}

/** 模型提议的一条数值变化转成 VarEffect；格式不对返回理由。 */
function toEffect(raw: { var: string; op: string; value: unknown }): VarEffect | string {
  const id = VarId.safeParse(String(raw.var ?? '').trim());
  if (!id.success) return `变量 ${raw.var} 的写法不对`;
  const op = raw.op === '+' || raw.op === '-' || raw.op === '=' ? raw.op : '=';
  let value = raw.value as Scalar;
  if (typeof value === 'string' && /^[+-]?\d+(\.\d+)?$/.test(value.trim())) value = Number(value);
  if (typeof value === 'string' && (value === 'true' || value === 'false')) value = value === 'true';
  if (typeof value !== 'number' && typeof value !== 'boolean' && typeof value !== 'string') return `变量 ${raw.var} 的值写法不对`;
  // "+-3" 之类：负数加法换成减法
  if (op === '+' && typeof value === 'number' && value < 0) return { var: id.data, op: '-', value: -value };
  return { var: id.data, op, value };
}

export function judgeBeat(p: JudgeInput): Judged {
  const s = p.state;
  const scene = s.scene as PlotScene;
  const firstBeat = s.sceneBeats === 0;
  const notes: string[] = [];

  // 剧情图暂停中（剧情 ADV）：只核对数值，不推进剧情图
  const paused = p.mode === 'adv' && s.paused && !scene.ending;

  // 要点：只能是当前幕的、还没演到过的。模型偶尔把 sc_01_1 写成 sc01_1：只在当前幕里按去掉符号后的写法对一下
  const own = new Set(scene.points.map((x) => x.id));
  const loose = (id: string) => id.toLowerCase().replace(/[^a-z0-9]/g, '');
  const points: string[] = [];
  for (const raw of paused ? [] : p.report.points) {
    const id = own.has(raw.trim()) ? raw.trim() : (scene.points.find((x) => loose(x.id) === loose(raw))?.id ?? raw.trim());
    if (!id) continue;
    if (!own.has(id)) notes.push(`要点 ${id} 不属于当前这一幕，不能跳着演`);
    else if (s.points.has(id)) notes.push(`要点 ${id} 之前已经演到过了`);
    else if (!points.includes(id)) points.push(id);
  }

  // 数值：模型提议，每拍有上限；演到了要点或检定成功才能用突破上限
  const effects: VarEffect[] = [];
  for (const raw of p.report.set) {
    const e = toEffect(raw);
    if (typeof e === 'string') notes.push(e);
    else effects.push(e);
  }
  const burst = points.length > 0 || p.check?.outcome === 'success' || p.check?.outcome === 'crit';
  const applied = applyEffects(p.variables, s.vars, effects, { source: 'model', burst });
  notes.push(...applied.notes);
  let vars = applied.values;
  let changes = applied.changes;

  const mark: PlotMark = { scene: scene.id };
  if (p.append) mark.append = p.append;
  if (p.report.offTrack && !scene.ending && !paused) mark.offTrack = true;
  const unlocks: Judged['unlocks'] = [];
  if (firstBeat && !paused) unlocks.push({ kind: 'scene', id: scene.id });

  if (paused) {
    mark.paused = true;
  } else if (scene.ending) {
    // 结局幕：第一拍把结局写出来，这一拍提交时就算达成结局
    mark.ending = scene.id;
    mark.finished = true;
    if (firstBeat) unlocks.push({ kind: 'ending', id: scene.id });
  } else {
    const ctx = { ...conditionContext(s, vars), check: (p.check ?? s.lastCheck)?.outcome ?? null };
    const t = decideTransition({
      scene,
      mode: p.mode,
      beats: s.sceneBeats + 1,
      ctx,
      variables: p.variables,
      lookup: (id) => sceneById(s, id),
      report: {
        by: 'director',
        done: p.report.sceneDone,
        ...(p.report.exit.trim() ? { exit: p.report.exit.trim() } : {}),
        playerAction: p.playerAction,
        truncated: p.truncated,
      },
    });
    notes.push(...t.notes);
    if (t.mustChoose) notes.push('这一幕已经演完了，下一拍必须从出口里选一条路走');
    if (t.exit) {
      const r = applyEffects(p.variables, vars, t.exit.def.set, { source: 'author' });
      vars = r.values;
      notes.push(...r.notes);
      changes = mergeChanges(changes, r.changes);
      mark.exit = { to: t.exit.to, by: t.exit.by };
    } else if (t.menu) mark.menu = t.menu;
    // 剧情 ADV：连续偏离、这一拍又没换幕也没到岔路，就停下来问玩家（玩家选过"不用管"的这一幕不再问；
    // 跑偏时插进来的幕本来就在剧情图外，最多演 4 拍就接回去，也不再问）
    if (
      p.mode === 'adv' &&
      mark.offTrack &&
      !mark.exit &&
      !mark.menu &&
      !s.driftIgnored &&
      !inAppendedScene(s) &&
      s.offTrack + 1 >= DRIFT_ASK_AFTER
    ) {
      mark.askDrift = true;
    }
  }

  if (points.length) mark.points = points;
  if (changes.length) mark.vars = changes;
  if (notes.length) mark.notes = notes;
  return { mark, unlocks };
}

// ───────────── 检定 ─────────────

/** 模型提议的检定：变量必须是数值（最好是属性类），难度截到 5～30。不合格返回理由。 */
export function checkSpecOf(
  raw: { var?: string; dc?: unknown; label?: string } | null | undefined,
  variables: readonly VariableDef[],
): { spec: CheckSpec | null; note?: string } {
  if (!raw) return { spec: null };
  const dc = Math.round(Number(raw.dc));
  if (!Number.isFinite(dc) || dc <= 0) return { spec: null, note: '检定没有写难度，已忽略' };
  const v = raw.var?.trim();
  let varId: string | undefined;
  if (v) {
    const def = variables.find((x) => x.id === v);
    if (!def || def.type !== 'number') return { spec: null, note: `检定用的变量 ${v} 不存在或不是数值，已忽略` };
    varId = def.id;
  }
  return { spec: { ...(varId ? { var: varId } : {}), dc: Math.min(30, Math.max(5, dc)), label: (raw.label ?? '').trim() || '检定' } };
}

/** 掷骰：修正值是变量的当前值。 */
export function rollFor(
  spec: CheckSpec,
  id: string,
  s: PlotState,
  seed: { playthroughId: string; parentId: string | null },
): CheckResult {
  const mod = spec.var ? s.vars[spec.var] : 0;
  return rollCheck({ ...spec, id }, typeof mod === 'number' ? mod : 0, seed);
}

// ───────────── ADV：AI 给玩家的选项 ─────────────

export interface OptionProposal {
  label: string;
  exit?: string;
  check?: { var?: string; dc?: unknown; label?: string } | null;
}

/**
 * 核对 AI 给玩家的选项：文字不能空、不能重复，最多 4 个；
 * 带出口的必须是当前幕可以选的出口（条件不成立的显示为锁住）；检定按 checkSpecOf 核对。
 */
export function aiMenu(
  s: PlotState,
  raw: readonly OptionProposal[],
  variables: readonly VariableDef[],
): { menu: PlotMenu | null; notes: string[] } {
  const scene = s.scene as PlotScene;
  const notes: string[] = [];
  const ctx = conditionContext(s);
  const vars = new Map(variables.map((v) => [v.id, v]));
  const exits = choosableExits(scene);
  const options: PlotMenu['options'] = [];
  for (const o of raw) {
    const label = o.label.trim();
    if (!label || options.some((x) => x.label === label)) continue;
    if (options.length >= 4) break;
    const opt: PlotMenu['options'][number] = { label, enabled: true };
    // 剧情图暂停中不换幕：选项上的出口不要
    let to = s.paused ? '' : o.exit?.trim();
    if (to && s.sceneBeats < scene.minBeats) {
      // 选项是导演提的，和导演换幕一样要演满最少拍数（s 已经算上了这一拍）
      notes.push(`这一幕至少要演 ${scene.minBeats} 拍，现在才 ${s.sceneBeats} 拍：选项「${label}」先不带出口`);
      to = '';
    }
    if (to) {
      const e = exits.find((x) => x.to === to);
      if (!e) notes.push(`选项「${label}」要去的 ${to} 不是这一幕的出口，改成留在这一幕`);
      else {
        if (!evalCondition(e.if, ctx) && sceneById(s, e.to)?.ending?.hidden) {
          // 通往隐藏结局、条件还不成立：不出现在菜单里（锁住的原因会剧透）
          notes.push(`选项「${label}」通往的结局现在还走不了，已去掉`);
          continue;
        }
        opt.exit = e.to;
        if (!evalCondition(e.if, ctx)) {
          opt.enabled = false;
          opt.lockedBy = describeCondition(e.if, { vars });
        }
        // 出口上写了检定（作者的决定）：选项上显示它，AI 给的检定不要
        if (e.check) opt.check = exitCheckShown(e.check);
      }
    }
    if (!opt.check) {
      const c = checkSpecOf(o.check, variables);
      if (c.note) notes.push(`选项「${label}」：${c.note}`);
      if (c.spec) opt.check = { ...(c.spec.var ? { var: c.spec.var } : {}), dc: c.spec.dc, label: c.spec.label };
    }
    options.push(opt);
  }
  if (options.length && !options.some((o) => o.enabled)) {
    notes.push('选项全都锁住了，已去掉');
    return { menu: null, notes };
  }
  return { menu: options.length ? { source: 'ai', options } : null, notes };
}
