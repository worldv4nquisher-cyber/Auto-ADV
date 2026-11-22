/**
 * 剧情 ADV 模式的一步（不调模型的部分）：播放手写剧本、处理选项和检定、按规则换幕。
 * 纯函数：给定当前进度和玩家的行动，返回要写进事件树的新事件；落库由 session.ts 负责。
 * 没有手写剧本的幕在 M3 第 3 步交给 AI 演出；在那之前用一句占位旁白代替，方便先把剧情图走通。
 */
import type {
  ChoiceOption,
  Condition,
  PlayMode,
  PlotGraph,
  PlotScene,
  ScriptCommand,
  StageCommand,
  VarEffect,
  VariableDef,
} from '@auto-adv/schema';
import type { PlayEvent, PlotMark, PlotMenu, Segment } from '../api.ts';
import type { UnlockKind } from '../play/db.ts';
import { matchByName } from '../world/render.ts';
import { type ConditionContext, describeCondition, evalCondition } from './conditions.ts';
import { rollCheck } from './dice.ts';
import { type PlotState, reducePlot } from './progress.ts';
import { choosableExits, decideTransition } from './transition.ts';
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
}

export type AdvAction = { kind: 'continue' } | { kind: 'choose'; index: number };

/** 还没写进事件树的事件（id / parentId / createdAt 由落库的一方补上）。 */
export type EventDraft = Omit<PlayEvent, 'id' | 'parentId' | 'createdAt'>;

export interface StepResult {
  events: EventDraft[];
  /** 这一步解锁的东西（16.8）：event 是 events 里的下标。 */
  unlocks: { event: number; kind: UnlockKind; id: string }[];
}

/** 玩家的行动不合法（比如选了锁住的选项）。 */
export class AdvError extends Error {}

/** 剧本最多连续执行这么多条指令（防止写错的剧本卡死）。 */
const MAX_OPS = 10_000;

export function cloneState(s: PlotState): PlotState {
  return {
    ...s,
    pendingChoice: s.pendingChoice && { ...s.pendingChoice },
    points: new Set(s.points),
    visited: [...s.visited],
    vars: { ...s.vars },
    notes: [...s.notes],
  };
}

export function conditionContext(s: PlotState, vars: VarValues = s.vars): ConditionContext {
  return { vars, visited: new Set(s.visited), check: s.lastCheck?.outcome ?? null };
}

/** 说话人：角色 id、去掉 char_ 前缀的 id、名字或别称都可以；都对不上就是临时人物。 */
export function resolveSpeaker(token: string, cast: AdvWorld['characters']): { characterId: string | null; name: string } {
  const c =
    cast.find((x) => x.id === token || x.id === `char_${token}`) ??
    matchByName(token, [...cast]);
  return c ? { characterId: c.id, name: c.name } : { characterId: null, name: token };
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
      lookup: (id) => w.graph.scenes.find((x) => x.id === id),
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
  for (const c of stage) if (c.op === 'cg') unlocks.push({ kind: 'cg', id: c.id });

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
    reducePlot(w.graph, s, { ...draft, id: '', parentId, createdAt: 0 } as PlayEvent);
  };
  const scene = s.scene;
  if (!scene) throw new AdvError('当前所在的幕在剧情图里找不到了');
  if (s.finished) throw new AdvError('剧情已经结束了');

  /** 剧本里的选项已经记下：（要检定且还没掷就先掷骰）演出选完之后的一拍。 */
  const afterChoice = () => {
    const pending = s.pendingChoice;
    const op = w.programs.get(scene.id)?.ops[s.pc ?? -1];
    const entry = pending && op?.k === 'menu' ? op.options[pending.index] : undefined;
    if (!pending || !entry) throw new AdvError('找不到刚才选的选项');
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
    const beat = playBeat(w, s, entry.body, entry.opt.set, true);
    push(beat.draft, beat.unlocks);
    return { events, unlocks };
  };

  if (action.kind === 'continue') {
    if (s.menu) throw new AdvError('请先做出选择');
    // 选项已经记下、选完之后的内容还没演（上次中途失败，或者回退到了选项事件上）：接着演
    if (s.pendingChoice) return afterChoice();
    if (s.pc === -1) throw new AdvError('这一幕演完了，但没有可以走的出口');
    const beat = playBeat(w, s, s.pc ?? 0, [], false);
    push(beat.draft, beat.unlocks);
    return { events, unlocks };
  }

  const menu = s.menu;
  if (!menu) throw new AdvError('现在没有可以选的选项');
  const shown = menu.options[action.index];
  if (!shown) throw new AdvError(`没有第 ${action.index + 1} 个选项`);
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
    const beat = playBeat(w, s, 0, [], false);
    push(beat.draft, beat.unlocks);
    return { events, unlocks };
  }

  const op = w.programs.get(scene.id)?.ops[s.pc ?? -1];
  const entry = op?.k === 'menu' ? op.options[action.index] : undefined;
  if (!entry) throw new AdvError('找不到这个选项');
  if (!evalCondition(entry.opt.if, ctx)) throw new AdvError(`「${shown.label}」现在选不了`);
  push({ kind: 'choice', choice, plot: { scene: scene.id } }, [], seed.headId);
  return afterChoice();
}
