/**
 * 开玩前的结构检查（docs/ARCHITECTURE.md 16.5）。纯函数：返回必须修的错误和只是提醒的警告。
 * 加载手写剧情图时、创世生成剧情图后、导演续写新幕时都跑一遍；命令行是 `pnpm cli check-plot <世界>`。
 */
import {
  MIGRATED_FROM_OUTLINE,
  PLOT_LIMITS,
  type Condition,
  type PlotGraph,
  type PlotScene,
  type VarEffect,
  type VariableDef,
} from '@auto-adv/schema';
import { type AdvParseResult, walkScript } from './adv.ts';
import { conditionLeaves, describeCondition } from './conditions.ts';

export interface PlotIssue {
  /** 出问题的幕（整体问题为空）。 */
  scene?: string;
  /** 手写剧本里的行号。 */
  line?: number;
  message: string;
}

export interface PlotCheckResult {
  /** 有错误时不能开始 ADV 周目。 */
  ok: boolean;
  errors: PlotIssue[];
  warnings: PlotIssue[];
}

export interface PlotCheckInput {
  graph: PlotGraph;
  variables: readonly VariableDef[];
  /** 已解析的手写剧本：幕 id → 解析结果。 */
  scripts?: ReadonlyMap<string, AdvParseResult>;
  /** 世界里的角色和地点（给了才检查剧本里的说话人、幕的地点和出场角色）。 */
  characters?: readonly { id: string; name: string; aliases?: string[] }[];
  locations?: readonly { id: string }[];
  /**
   * 续写时已有的幕：新幕的条件和出口可以引用它们（不在这张图里，也不检查它们）。
   * 通往已有幕的出口算作能走到结局（已有的剧情图已经检查过了）。
   */
  known?: ReadonlySet<string>;
}

const nonAuto = (s: PlotScene) => s.exits.filter((e) => !e.auto);

/** 从 start 出发、忽略条件只看连线能到达的幕。 */
function reachable(byId: Map<string, PlotScene>, from: string): Set<string> {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const id = stack.pop() as string;
    if (seen.has(id) || !byId.has(id)) continue;
    seen.add(id);
    for (const e of byId.get(id)?.exits ?? []) stack.push(e.to);
  }
  return seen;
}

export function checkPlot(input: PlotCheckInput): PlotCheckResult {
  const { graph, variables } = input;
  const known = input.known ?? new Set<string>();
  const errors: PlotIssue[] = [];
  const warnings: PlotIssue[] = [];
  const err = (message: string, scene?: string, line?: number) =>
    errors.push({ ...(scene ? { scene } : {}), ...(line ? { line } : {}), message });
  const warn = (message: string, scene?: string, line?: number) =>
    warnings.push({ ...(scene ? { scene } : {}), ...(line ? { line } : {}), message });

  // ── 变量定义 ──
  const vars = new Map<string, VariableDef>();
  for (const v of variables) {
    if (vars.has(v.id)) err(`变量 ${v.id} 重复定义`);
    vars.set(v.id, v);
    if (typeof v.initial !== v.type) err(`变量 ${v.id} 的初始值类型和 ${v.type} 不一致`);
    if (v.type !== 'number' && (v.min !== undefined || v.max !== undefined)) warn(`变量 ${v.id} 不是数值，min / max 不起作用`);
    if (v.min !== undefined && v.max !== undefined && v.min > v.max) err(`变量 ${v.id} 的 min 大于 max`);
    const n = v.initial;
    if (typeof n === 'number' && ((v.min !== undefined && n < v.min) || (v.max !== undefined && n > v.max))) {
      err(`变量 ${v.id} 的初始值 ${n} 超出范围`);
    }
  }

  // ── 幕的索引 ──
  const byId = new Map<string, PlotScene>();
  const pointOwner = new Map<string, string>();
  for (const s of graph.scenes) {
    if (byId.has(s.id)) err(`幕 id ${s.id} 重复`, s.id);
    byId.set(s.id, s);
    for (const p of s.points) {
      if (pointOwner.has(p.id)) err(`要点 id ${p.id} 和 ${pointOwner.get(p.id)} 里的重复`, s.id);
      else pointOwner.set(p.id, s.id);
    }
  }
  const sceneNames = new Map(graph.scenes.map((s) => [s.id, s.title || s.id]));
  const chapters = new Set(graph.chapters.map((c) => c.id));
  const endings = graph.scenes.filter((s) => s.ending);

  /** 检查条件引用的变量、幕和值的类型。 */
  const checkCondition = (c: Condition | undefined, where: string, scene: string, line?: number) => {
    for (const leaf of conditionLeaves(c)) {
      if (leaf.kind === 'visited') {
        if (!byId.has(leaf.scene) && !known.has(leaf.scene)) err(`${where}引用了不存在的幕 ${leaf.scene}`, scene, line);
        continue;
      }
      if (leaf.kind === 'check') continue;
      const def = vars.get(leaf.var);
      if (!def) {
        err(`${where}引用了不存在的变量 ${leaf.var}`, scene, line);
        continue;
      }
      if (leaf.kind === 'flag') {
        if (def.type !== 'boolean') err(`${where}用 flag 读了不是布尔值的变量 ${leaf.var}`, scene, line);
        continue;
      }
      const { op, value } = leaf;
      if (typeof value !== def.type) {
        err(`${where}拿 ${JSON.stringify(value)} 和 ${def.type} 类型的变量 ${leaf.var} 比较`, scene, line);
        continue;
      }
      if (def.type !== 'number' && op !== 'eq' && op !== 'ne') {
        err(`${where}对不是数值的变量 ${leaf.var} 用了 ${op}`, scene, line);
        continue;
      }
      if (typeof value === 'number') {
        const { min, max } = def;
        const impossible =
          (op === 'gte' && max !== undefined && value > max) ||
          (op === 'gt' && max !== undefined && value >= max) ||
          (op === 'lte' && min !== undefined && value < min) ||
          (op === 'lt' && min !== undefined && value <= min) ||
          (op === 'eq' && ((max !== undefined && value > max) || (min !== undefined && value < min)));
        if (impossible) {
          const text = describeCondition({ [op]: [leaf.var, value] } as Condition, { vars });
          warn(`${where}的条件「${text}」不可能成立（范围 ${min ?? '-∞'}～${max ?? '∞'}）`, scene, line);
        }
      }
    }
  };

  /** 检定用的变量：要存在、是数值；不是属性类只提醒。 */
  const checkCheckVar = (id: string | undefined, where: string, scene: string, line?: number) => {
    if (!id) return;
    const def = vars.get(id);
    if (!def) err(`${where}用了不存在的变量 ${id}`, scene, line);
    else if (def.type !== 'number') err(`${where}变量 ${id} 不是数值`, scene, line);
    else if (def.category !== 'attribute') warn(`${where}变量 ${id} 不是属性类（category: attribute）`, scene, line);
  };

  const checkEffects = (effects: readonly VarEffect[], where: string, scene: string, line?: number) => {
    for (const e of effects) {
      const def = vars.get(e.var);
      if (!def) err(`${where}修改了不存在的变量 ${e.var}`, scene, line);
      else if (def.type === 'number' ? typeof e.value !== 'number' : e.op !== '=' || typeof e.value !== def.type) {
        err(`${where}给 ${def.type} 类型的变量 ${e.var} 设了 ${e.op}${JSON.stringify(e.value)}`, scene, line);
      }
    }
  };

  // ── 整体 ──
  if (!byId.has(graph.start)) err(`起始幕 ${graph.start} 不存在`);
  if (!endings.length && !known.size) err('剧情图里没有结局幕');
  const migrated = graph._meta.generatedBy === MIGRATED_FROM_OUTLINE;

  // ── 每一幕 ──
  const cast = input.characters ? new Set(input.characters.map((c) => c.id)) : null;
  const places = input.locations ? new Set(input.locations.map((l) => l.id)) : null;
  for (const s of graph.scenes) {
    if (s.points.length > PLOT_LIMITS.points) err(`要点有 ${s.points.length} 条，最多 ${PLOT_LIMITS.points} 条`, s.id);
    if (s.exits.length > PLOT_LIMITS.exits) err(`出口有 ${s.exits.length} 个，最多 ${PLOT_LIMITS.exits} 个`, s.id);
    if (s.minBeats > s.maxBeats) err(`minBeats（${s.minBeats}）大于 maxBeats（${s.maxBeats}）`, s.id);
    if (s.chapter && !chapters.has(s.chapter)) warn(`所属的章 ${s.chapter} 不存在`, s.id);
    if (places && s.location && !places.has(s.location)) warn(`建议地点 ${s.location} 不存在`, s.id);
    if (cast) for (const c of s.cast) if (!cast.has(c)) warn(`建议出场角色 ${c} 不存在`, s.id);

    if (s.ending) {
      if (s.exits.length) err('结局幕不能有出口', s.id);
      if (s.default) err('结局幕不能有 default', s.id);
    } else if (!s.exits.length) {
      err('不是结局，却没有任何出口（死路）', s.id);
    }

    s.exits.forEach((e, i) => {
      const where = `出口 ${i + 1}（→ ${e.to}）`;
      if (!byId.has(e.to) && !known.has(e.to)) err(`${where}指向不存在的幕`, s.id);
      if (e.to === s.id) warn(`${where}指向自己`, s.id);
      checkCondition(e.if, where, s.id);
      checkEffects(e.set, where, s.id);
      if (e.auto && !e.if) warn(`${where}是 auto 出口但没有条件，进入这一幕后马上就会走`, s.id);
      if (e.check) {
        checkCheckVar(e.check.var, `${where}的检定`, s.id);
        // 出口上的检定只在玩家从岔路里选的时候掷
        if (e.auto) warn(`${where}是 auto 出口，上面的检定不会掷骰`, s.id);
        else if (nonAuto(s).length < 2) warn(`${where}上有检定，但这一幕不是岔路：只有一条路时由导演换幕，检定不会掷骰`, s.id);
      }
      if (migrated && !e.if && e.when && byId.get(e.to)?.ending) {
        warn(`${where}的结局条件「${e.when}」是从旧骨架迁移来的文字，只能交给导演判断，建议改成结构化条件`, s.id);
      }
    });

    const fork = nonAuto(s);
    if (fork.length >= 2) {
      fork.forEach((e) => {
        if (!e.label) warn(`岔路出口 → ${e.to} 缺少给玩家看的 label`, s.id);
        if (!e.when && !input.scripts?.has(s.id)) warn(`岔路出口 → ${e.to} 缺少给导演看的 when`, s.id);
      });
    }
    for (let a = 0; a < s.exits.length; a++) {
      for (let b = a + 1; b < s.exits.length; b++) {
        const x = s.exits[a];
        const y = s.exits[b];
        if (x?.if && y?.if && JSON.stringify(x.if) === JSON.stringify(y.if)) {
          warn(`出口 → ${x.to} 和 → ${y.to} 的条件完全相同`, s.id);
        }
      }
    }
    if (s.default) {
      const d = s.exits.find((e) => e.to === s.default && !e.auto);
      if (!d) err(`default（${s.default}）不是本幕的出口`, s.id);
      else if (d.if) err(`default 出口（→ ${s.default}）是兜底，不能带条件`, s.id);
    }
    if (!s.ending && s.exits.length) {
      if (!fork.length) warn('只有 auto 出口，条件一直不成立时会卡在这一幕', s.id);
      else if (fork.every((e) => e.if) && !s.default) warn('所有出口都带条件也没有 default，条件都不成立时会卡在这一幕', s.id);
    }

    // ── 手写剧本 ──
    const parsed = input.scripts?.get(s.id);
    if (s.script && !parsed) err(`找不到手写剧本 plot/scenes/${s.script}`, s.id);
    if (!parsed) continue;
    for (const e of parsed.errors) err(`剧本：${e.message}`, s.id, e.line);
    const targets = new Set(s.exits.map((e) => e.to));
    const points = new Set(s.points.map((p) => p.id));
    const names = input.characters?.flatMap((c) => [c.id, c.id.replace(/^char_/, ''), c.name, ...(c.aliases ?? [])]);
    const speaker = new Set(names ?? []);
    const checkJump = (to: string, line?: number) => {
      if (s.ending) err(`剧本：结局幕没有出口，不能走到 ${to}`, s.id, line);
      else if (!targets.has(to)) err(`剧本：${to} 不是这一幕声明过的出口`, s.id, line);
    };
    walkScript(
      parsed.commands,
      (c) => {
        if (c.op === 'jump') checkJump(c.to, c.line);
        if (c.op === 'set') checkEffects([c.effect], '剧本', s.id, c.line);
        if (c.op === 'if') checkCondition(c.cond, '剧本里的条件', s.id, c.line);
        if (c.op === 'point' && !points.has(c.id)) err(`剧本：要点 ${c.id} 不属于这一幕`, s.id, c.line);
        if (names && (c.op === 'say' || c.op === 'show' || c.op === 'hide' || (c.op === 'think' && c.char))) {
          const who = c.char as string;
          if (!speaker.has(who)) warn(`剧本：角色 ${who} 不在角色表里`, s.id, c.line);
        }
      },
      (o) => {
        if (o.goto) checkJump(o.goto, o.line);
        checkEffects(o.set, `选项「${o.label}」`, s.id, o.line);
        checkCondition(o.if, `选项「${o.label}」`, s.id, o.line);
        checkCheckVar(o.check?.var, `选项「${o.label}」的检定`, s.id, o.line);
      },
    );
  }

  // ── 连通性（忽略条件，只看连线） ──
  if (byId.has(graph.start)) {
    const fromStart = reachable(byId, graph.start);
    for (const s of graph.scenes) if (!fromStart.has(s.id)) err(`从起始幕 ${graph.start} 走不到这一幕`, s.id);
    /** 能走出去：到了结局，或者通往已有的幕（续写）。 */
    const out = (ids: Set<string>) =>
      endings.some((e) => ids.has(e.id)) || [...ids].some((id) => byId.get(id)?.exits.some((e) => known.has(e.to)));
    if ((endings.length || known.size) && !out(fromStart)) err('从起始幕出发走不到任何结局');
    else {
      for (const id of fromStart) {
        const s = byId.get(id) as PlotScene;
        if (s.ending || !s.exits.length) continue;
        if (!out(reachable(byId, id))) err('从这一幕出发走不到任何结局（会在几幕之间绕圈）', id);
      }
    }
  }
  if (graph.scenes.some((s) => nonAuto(s).length >= 2) && endings.length === 1) warn('有岔路却只有一个结局');

  return { ok: errors.length === 0, errors, warnings };
}
