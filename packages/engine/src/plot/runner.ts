/**
 * 剧情 ADV 模式的一步（不调模型的部分）：播放手写剧本、处理选项和检定、按规则换幕。
 * 纯函数：给定当前进度和玩家的行动，返回要写进事件树的新事件；落库由 session.ts 负责。
 * 没有手写剧本的幕交给 AI 演出（AdvWorld.ai 为 true 时）：这里只记下玩家的行动和检定，返回 ai 请求，
 * 由调用方调模型演出这一拍（play/adv.ts）。没有 AI 时（命令行、没配模型）用一句占位旁白代替，方便先把剧情图走通。
 */
import type {
  ChoiceOption,
  Condition,
  PlayMode,
  PlotExit,
  PlotGraph,
  PlotScene,
  ScriptCommand,
  StageCommand,
  VarEffect,
  VariableDef,
} from '@auto-adv/schema';
import type { DriftChoice, PlayEvent, PlotMark, PlotMenu, Segment } from '../api.ts';
import type { UnlockKind } from '../play/db.ts';
import { type ConditionContext, describeCondition, evalCondition } from './conditions.ts';
import { rollCheck } from './dice.ts';
import { cloneState, type PlotState, reducePlot, sceneById } from './progress.ts';
import { resolveSpeaker } from './stage.ts';
import { choosableExits, decideTransition, exitCheckId } from './transition.ts';
import { applyEffects, mergeChanges, type VarChange, type VarValues } from './vars.ts';

// ───────────── 编译：Script IR → 线性指令 ─────────────

/** 剧本编译成的线性指令。pc 就是数组下标，所以"播到哪里"只用一个整数记在事件上。 */
export type Op =
  | { k: 'stage'; cmd: StageCommand }
  | { k: 'set'; effect: VarEffect; line?: number }
  | { k: 'point'; id: string; line?: number }
  | { k: 'jump'; to: string; line?: number }
  | { k: 'menu'; options: { opt: ChoiceOption; body: number }[]; line?: number }
  | { k: 'br'; cond: Condition; else: number }
  | { k: 'go'; to: number };

export interface Program {
  ops: Op[];
}

export function compileScript(commands: readonly ScriptCommand[]): Program {
  const ops: Op[] = [];
  const emit = (list: readonly ScriptCommand[]) => {
    for (const c of list) {
      switch (c.op) {
        case 'set':
          ops.push({ k: 'set', effect: c.effect, line: c.line });
          break;
        case 'point':
          ops.push({ k: 'point', id: c.id, line: c.line });
          break;
        case 'jump':
          ops.push({ k: 'jump', to: c.to, line: c.line });
          break;
        case 'if': {
          const br = { k: 'br' as const, cond: c.cond, else: -1 };
          ops.push(br);
          emit(c.then);
          const go = { k: 'go' as const, to: -1 };
          ops.push(go);
          br.else = ops.length;
          emit(c.else);
          go.to = ops.length;
          break;
        }
        case 'choice': {
          const menu = { k: 'menu' as const, options: [] as { opt: ChoiceOption; body: number }[], line: c.line };
          ops.push(menu);
          const exits: { k: 'go'; to: number }[] = [];
          for (const opt of c.options) {
            const body = ops.length;
            emit(opt.body);
            if (opt.goto) ops.push({ k: 'jump', to: opt.goto, line: opt.line });
            else {
              const go = { k: 'go' as const, to: -1 };
              ops.push(go);
              exits.push(go);
            }
            menu.options.push({ opt, body });
          }
          for (const go of exits) go.to = ops.length;
          break;
        }
        default: {
          const { line: _line, ...cmd } = c;
          ops.push({ k: 'stage', cmd: cmd as StageCommand });
        }
      }
    }
  };
  emit(commands);
  return { ops };
}

// ───────────── 一步 ─────────────

export interface AdvWorld {
  graph: PlotGraph;
  variables: readonly VariableDef[];
  /** 幕 id → 编译好的手写剧本。 */
  programs: ReadonlyMap<string, Program>;
  characters: readonly { id: string; name: string; aliases?: string[] }[];
  mode: PlayMode;
  /** 没有手写剧本的幕交给 AI 演出（返回 ai 请求）；false 时用占位旁白。 */
  ai?: boolean;
}

/**
 * continue：往下演；choose：选第 index 项；input：剧情 ADV 里的自由行动（只在 AI 演出的幕里可以用）；
 * drift：跑偏时的选择（16.6）。
 */
export type AdvAction =
  | { kind: 'continue' }
  | { kind: 'choose'; index: number }
  | { kind: 'input'; text: string }
  | { kind: 'drift'; choice: DriftChoice };

/** 接下来这一拍要由 AI 演出。 */
export interface AiRequest {
  /** 这一拍有没有玩家行动（ADV 的岔路只能由玩家决定）。 */
  playerAction: boolean;
  /** 玩家的行动：选了哪一项，或者输入了什么。 */
  action?: { kind: 'choice' | 'input'; text: string };
}

/** 还没写进事件树的事件（id / parentId / createdAt 由落库的一方补上）。 */
export type EventDraft = Omit<PlayEvent, 'id' | 'parentId' | 'createdAt'>;

export interface StepResult {
  events: EventDraft[];
  /** 这一步解锁的东西（16.8）：event 是 events 里的下标。 */
  unlocks: { event: number; kind: UnlockKind; id: string }[];
  /** 接下来这一拍要由 AI 演出（events 已经写进去之后的进度是 state）。 */
  ai?: AiRequest;
  /** 玩家选了"就这样走"：要由调用方调模型把跑偏的这一段写成新的一幕（play/adv.ts 的 runAdvDetour）。 */
  detour?: boolean;
  /** 把 events 折叠进去之后的进度。 */
  state: PlotState;
}

/** 玩家的行动不合法（比如选了锁住的选项）。 */
export class AdvError extends Error {}

/** 剧本最多连续执行这么多条指令（防止写错的剧本卡死）。 */
const MAX_OPS = 10_000;

/** 这一幕由 AI 演出：没有手写剧本，而且调用方能调模型。 */
export const aiScene = (w: AdvWorld, s: PlotState) => !!w.ai && !!s.scene && !w.programs.has(s.scene.id);

export function conditionContext(s: PlotState, vars: VarValues = s.vars): ConditionContext {
  return { vars, visited: new Set(s.visited), check: s.lastCheck?.outcome ?? null };
}

/** 舞台指令转成文本段落（拼上下文、预览和命令行都用它）。 */
export function stageToSegments(stage: readonly StageCommand[], cast: AdvWorld['characters']): Segment[] {
  const out: Segment[] = [];
  for (const c of stage) {
    if (c.op === 'say') out.push({ kind: 'line', ...resolveSpeaker(c.char, cast), text: c.text });
    else if (c.op === 'narrate') out.push({ kind: 'narration', text: c.text });
    else if (c.op === 'think') {
      if (c.char) out.push({ kind: 'line', ...resolveSpeaker(c.char, cast), text: `（${c.text}）` });
      else out.push({ kind: 'narration', text: `（${c.text}）` });
    }
  }
  return out;
}

function scriptMenu(op: Extract<Op, { k: 'menu' }>, ctx: ConditionContext, variables: readonly VariableDef[]): PlotMenu {
  const vars = new Map(variables.map((v) => [v.id, v]));
  return {
    source: 'script',
    options: op.options.map(({ opt }) => {
      const enabled = evalCondition(opt.if, ctx);
      return {
        label: opt.label,
        enabled,
        ...(enabled ? {} : { lockedBy: describeCondition(opt.if, { vars }) }),
        ...(opt.check ? { check: { ...(opt.check.var ? { var: opt.check.var } : {}), dc: opt.check.dc } } : {}),
      };
    }),
  };
}

/** 演一拍：从 pc 开始播剧本，直到弹出选项、走出口或播完；然后按规则判断换幕。 */
function playBeat(
  w: AdvWorld,
  s: PlotState,
  start: number,
  pre: readonly VarEffect[],
  playerAction: boolean,
): { draft: EventDraft; unlocks: { kind: UnlockKind; id: string }[] } {
  const scene = s.scene as PlotScene;
  const firstBeat = s.sceneBeats === 0;
  let vars = s.vars;
  const changes: VarChange[][] = [];
  const notes: string[] = [];
  const points: string[] = [];
  const stage: StageCommand[] = [];
  const apply = (effects: readonly VarEffect[]) => {
    if (!effects.length) return;
    const r = applyEffects(w.variables, vars, effects, { source: 'author' });
    vars = r.values;
    changes.push(r.changes);
    notes.push(...r.notes);
  };
  apply(pre);

  const program = w.programs.get(scene.id);
  let stop: 'menu' | 'jump' | 'end' = 'end';
  let pc = start;
  let jumpTo: string | undefined;
  if (program && pc >= 0) {
    let steps = 0;
    while (pc < program.ops.length) {
      if (++steps > MAX_OPS) {
        notes.push('剧本执行的指令太多，已停止');
        break;
      }
      const op = program.ops[pc] as Op;
      if (op.k === 'menu') {
        stop = 'menu';
        break;
      }
      if (op.k === 'jump') {
        stop = 'jump';
        jumpTo = op.to;
        break;
      }
      pc += 1;
      if (op.k === 'stage') stage.push(op.cmd);
      else if (op.k === 'set') apply([op.effect]);
      else if (op.k === 'point') {
        if (!scene.points.some((p) => p.id === op.id)) notes.push(`要点 ${op.id} 不属于这一幕，已忽略`);
        else if (!points.includes(op.id) && !s.points.has(op.id)) points.push(op.id);
      } else if (op.k === 'br') {
        if (!evalCondition(op.cond, conditionContext(s, vars))) pc = op.else;
      } else if (op.k === 'go') pc = op.to;
    }
  } else if (!program && firstBeat) {
    const text = scene.ending
      ? scene.ending.text || scene.title
      : `（这一幕还没有手写剧本，之后由 AI 演出：${scene.what || scene.title || scene.id}）`;
    stage.push({ op: 'narrate', text });
  }

  const mark: PlotMark = { scene: scene.id, pc: stop === 'menu' ? pc : -1 };
  if (firstBeat && scene.ending) mark.ending = scene.id;
  const ctx = conditionContext(s, vars);
  if (stop === 'menu') mark.menu = scriptMenu(program?.ops[pc] as Extract<Op, { k: 'menu' }>, ctx, w.variables);

  if (scene.ending) {
    if (stop === 'jump') notes.push(`结局幕没有出口，不能走到 ${jumpTo}`);
    if (stop !== 'menu') mark.finished = true;
  } else {
    const t = decideTransition({
      scene,
      mode: w.mode,
      beats: s.sceneBeats + 1,
      ctx,
      variables: w.variables,
      lookup: (id) => sceneById(s, id),
      // 剧本 jump 被驳回时当作播完，按"演完了"的规则找路
      report: { by: 'script', done: stop !== 'menu', ...(jumpTo ? { exit: jumpTo } : {}), playerAction },
    });
    notes.push(...t.notes);
    if (t.exit) {
      apply(t.exit.def.set);
      mark.exit = { to: t.exit.to, by: t.exit.by };
      delete mark.menu; // auto 出口优先于剧本里的选项
    } else if (t.menu && stop !== 'menu') mark.menu = t.menu;
  }

  const merged = mergeChanges(...changes);
  if (points.length) mark.points = points;
  if (merged.length) mark.vars = merged;
  if (notes.length) mark.notes = notes;

  const unlocks: { kind: UnlockKind; id: string }[] = [];
  if (firstBeat) unlocks.push({ kind: 'scene', id: scene.id });
  if (mark.ending) unlocks.push({ kind: 'ending', id: mark.ending });

  return {
    draft: {
      kind: 'script',
      stage,
      segments: stageToSegments(stage, w.characters),
      plot: mark,
    },
    unlocks,
  };
}

export function stepAdv(
  w: AdvWorld,
  state: PlotState,
  action: AdvAction,
  seed: { playthroughId: string; headId: string },
): StepResult {
  const s = cloneState(state);
  const events: EventDraft[] = [];
  const unlocks: StepResult['unlocks'] = [];
  const push = (draft: EventDraft, u: { kind: UnlockKind; id: string }[] = [], parentId: string | null = null) => {
    for (const x of u) unlocks.push({ event: events.length, ...x });
    events.push(draft);
    reducePlot(s, { ...draft, id: '', parentId, createdAt: 0 } as PlayEvent);
  };
  const done = (ai?: AiRequest): StepResult => ({ events, unlocks, state: s, ...(ai ? { ai } : {}) });
  /** 演下一拍：AI 演出的幕交给调用方，手写剧本的幕（或者没有 AI 时）在这里播。 */
  const beat = (start: number, pre: readonly VarEffect[], playerAction: boolean, act?: AiRequest['action']) => {
    if (aiScene(w, s)) return done({ playerAction, ...(act ? { action: act } : {}) });
    const b = playBeat(w, s, start, pre, playerAction);
    push(b.draft, b.unlocks);
    return done();
  };
  const scene = s.scene;
  if (!scene) throw new AdvError('当前所在的幕在剧情图里找不到了');
  if (s.finished) throw new AdvError('剧情已经结束了');

  if (action.kind === 'drift') {
    const c = action.choice;
    if (c === 'resume') {
      if (!s.paused) throw new AdvError('剧情图没有暂停');
    } else if (!s.driftAsk) throw new AdvError('现在没有跑偏，不用处理');
    if (c === 'detour') {
      if (!aiScene(w, s)) throw new AdvError('"就这样走"要由 AI 把这一段写成新的一幕，先在设置里配好模型');
      return { events, unlocks, state: s, detour: true };
    }
    push({ kind: 'drift', drift: c }, [], seed.headId);
    return done();
  }
  if (s.driftAsk) throw new AdvError('这几拍离开了当前这一幕，请先决定怎么处理');

  /** 出口上的检定（16.4）：选了这条路就掷，结果记在换幕之后，下一幕的第一拍按结果演。种子用选项事件的父事件。 */
  const rollExit = (from: PlotScene, exit: PlotExit, label: string, parentId: string | null) => {
    if (!exit.check) return;
    const mod = exit.check.var ? s.vars[exit.check.var] : 0;
    const check = rollCheck(
      { ...exit.check, label: exit.check.label || label, id: exitCheckId(from, exit) },
      typeof mod === 'number' ? mod : 0,
      { playthroughId: seed.playthroughId, parentId },
    );
    push({ kind: 'check', check });
  };

  /** 选项已经记下：（要检定且还没掷就先掷骰）演出选完之后的一拍。 */
  const afterChoice = () => {
    const pending = s.pendingChoice;
    if (!pending) throw new AdvError('找不到刚才选的选项');
    if (pending.source === 'exits') {
      // 岔路：已经换到新的幕，出口上有检定就先掷，再在新的幕里演出选择的结果
      const from = sceneById(s, s.visited.at(-2) ?? '');
      const exit = from ? choosableExits(from)[pending.index] : undefined;
      if (from && exit && !pending.rolled) rollExit(from, exit, pending.label, pending.parentId);
      return beat(s.pc ?? 0, [], false, { kind: 'choice', text: pending.label });
    }
    if (pending.source === 'ai') {
      // AI 给的选项：检定在选的时候已经掷过；选完之后的一拍由 AI 演（选项带着出口、新的幕是手写剧本时播剧本）
      return beat(s.pc ?? 0, [], true, { kind: 'choice', text: pending.label });
    }
    const op = w.programs.get(scene.id)?.ops[s.pc ?? -1];
    const entry = op?.k === 'menu' ? op.options[pending.index] : undefined;
    if (!entry) throw new AdvError('找不到刚才选的选项');
    const spec = entry.opt.check;
    if (spec && !pending.rolled) {
      const mod = spec.var ? s.vars[spec.var] : 0;
      const id = spec.id ?? `${scene.id}:${entry.opt.line ?? pending.index}`;
      // 种子用这一行动的父事件（选项事件接在它后面），重抽、回退再选同一项结果都不变
      const check = rollCheck({ ...spec, id }, typeof mod === 'number' ? mod : 0, {
        playthroughId: seed.playthroughId,
        parentId: pending.parentId,
      });
      push({ kind: 'check', check });
    }
    const b = playBeat(w, s, entry.body, entry.opt.set, true);
    push(b.draft, b.unlocks);
    return done();
  };

  if (action.kind === 'input') {
    const text = action.text.trim();
    if (!text) throw new AdvError('请输入你想做的事');
    if (!aiScene(w, s)) throw new AdvError('这一幕是手写剧本，只能用选项推进');
    push({ kind: 'player', text }, [], seed.headId);
    return done({ playerAction: true, action: { kind: 'input', text } });
  }

  if (action.kind === 'continue') {
    if (s.menu) throw new AdvError('请先做出选择');
    // 选项或输入已经记下、之后的内容还没演（上次中途失败，或者回退到了选项事件上）：接着演
    if (s.pendingChoice) return afterChoice();
    if (s.pendingInput !== null) {
      if (!aiScene(w, s)) throw new AdvError('这一幕是手写剧本，只能用选项推进');
      return done({ playerAction: true, action: { kind: 'input', text: s.pendingInput } });
    }
    if (!aiScene(w, s) && s.pc === -1) throw new AdvError('这一幕演完了，但没有可以走的出口');
    return beat(s.pc ?? 0, [], false);
  }

  const menu = s.menu;
  if (!menu) throw new AdvError('现在没有可以选的选项');
  const shown = menu.options[action.index];
  if (!shown) throw new AdvError(`没有第 ${action.index + 1} 个选项`);
  if (!shown.enabled) throw new AdvError(`「${shown.label}」现在选不了`);
  const ctx = conditionContext(s);
  const choice = { index: action.index, label: shown.label };

  if (menu.source === 'exits') {
    const exit = choosableExits(scene)[action.index];
    if (!exit || !evalCondition(exit.if, ctx)) throw new AdvError(`「${shown.label}」现在选不了`);
    const r = applyEffects(w.variables, s.vars, exit.set, { source: 'author' });
    const plot = { scene: scene.id, exit: { to: exit.to, by: 'choice' as const } };
    if (r.changes.length) Object.assign(plot, { vars: r.changes });
    if (r.notes.length) Object.assign(plot, { notes: r.notes });
    push({ kind: 'choice', choice, plot }, [], seed.headId);
    if (!s.scene) throw new AdvError(`出口指向的幕 ${exit.to} 不存在`);
    return afterChoice();
  }

  if (menu.source === 'ai') {
    const plot: PlotMark = { scene: scene.id };
    let exit: PlotExit | undefined;
    if (shown.exit) {
      // 选项带着出口：岔路由玩家的选择决定，选完就换幕，下一拍在新的幕里演出选择的结果
      exit = choosableExits(scene).find((x) => x.to === shown.exit);
      if (!exit || !evalCondition(exit.if, ctx)) throw new AdvError(`「${shown.label}」现在选不了`);
      const r = applyEffects(w.variables, s.vars, exit.set, { source: 'author' });
      plot.exit = { to: exit.to, by: 'choice' };
      if (r.changes.length) plot.vars = r.changes;
      if (r.notes.length) plot.notes = r.notes;
    }
    push({ kind: 'choice', choice, plot }, [], seed.headId);
    // 出口上写了检定就用作者写的（aiMenu 已经把它放到选项上显示），否则用 AI 给的
    const spec = exit?.check ? null : shown.check;
    if (exit?.check) rollExit(scene, exit, shown.label, seed.headId);
    if (spec) {
      const mod = spec.var ? s.vars[spec.var] : 0;
      const id = `${scene.id}:ai:${action.index}`;
      const check = rollCheck(
        { ...(spec.var ? { var: spec.var } : {}), dc: spec.dc, label: spec.label || shown.label, id },
        typeof mod === 'number' ? mod : 0,
        { playthroughId: seed.playthroughId, parentId: seed.headId },
      );
      push({ kind: 'check', check });
    }
    if (!s.scene) throw new AdvError(`出口指向的幕 ${shown.exit} 不存在`);
    return afterChoice();
  }

  const op = w.programs.get(scene.id)?.ops[s.pc ?? -1];
  const entry = op?.k === 'menu' ? op.options[action.index] : undefined;
  if (!entry) throw new AdvError('找不到这个选项');
  if (!evalCondition(entry.opt.if, ctx)) throw new AdvError(`「${shown.label}」现在选不了`);
  push({ kind: 'choice', choice, plot: { scene: scene.id } }, [], seed.headId);
  return afterChoice();
}
