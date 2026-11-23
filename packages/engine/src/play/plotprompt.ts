/**
 * 剧情图给导演看的部分（观察模式和剧情 ADV 共用）。
 * 看不到的就不给模型（16.2）：只给当前幕和它打开的出口（目标幕的标题和一句话梗概），
 * 条件不成立的出口、auto 出口、还没到的幕都不出现。
 */
import type { PlotScene, VariableDef } from '@auto-adv/schema';
import { OUTCOME_LABELS, type CheckResult } from '../plot/dice.ts';
import { sceneById, type PlotState } from '../plot/progress.ts';
import { conditionContext } from '../plot/runner.ts';
import { choosableExits } from '../plot/transition.ts';
import { evalCondition } from '../plot/conditions.ts';
import { perBeatLimit } from '../plot/vars.ts';
import type { WorldData } from '../world/store.ts';

/** 当前幕打开的、可以选的出口。 */
export function openExits(plot: PlotState) {
  const scene = plot.scene;
  if (!scene) return [];
  const ctx = conditionContext(plot);
  return choosableExits(scene).filter((e) => evalCondition(e.if, ctx));
}

const ENDING_KIND: Record<string, string> = { good: '好结局', normal: '普通结局', bad: '坏结局' };

/** 当前幕已经演满了（还没走出去就要求导演选路）。 */
export const sceneMaxed = (plot: PlotState) => !!plot.scene && !plot.scene.ending && plot.sceneBeats >= plot.scene.maxBeats;

export function plotSection(world: Pick<WorldData, 'variables'>, plot: PlotState, mode: 'observer' | 'adv'): string {
  const scene = plot.scene as PlotScene;
  const g = plot.graph;
  const chapter = scene.chapter ? g.chapters.find((c) => c.id === scene.chapter) : undefined;
  const out: string[] = ['# 剧情图'];
  if (g.premise) out.push(`核心：${g.premise}`);
  out.push(`## 当前这一幕：[${scene.id}] ${scene.title || scene.id}${chapter ? `（${chapter.title || chapter.id}）` : ''}`);
  if (scene.what) out.push(scene.what);

  if (scene.ending) {
    out.push(
      `这是结局幕（${ENDING_KIND[scene.ending.kind] ?? scene.ending.kind}）。这一拍把结局完整地写出来，给故事一个收尾。${
        scene.ending.text ? `\n收场要求：${scene.ending.text}` : ''
      }`,
    );
  } else {
    if (scene.points.length) {
      out.push(
        `要点（[x] 是已经演到的；这一拍演到了哪个，就把它的 id 写进 points）：\n${scene.points
          .map((p) => `- [${plot.points.has(p.id) ? 'x' : ' '}] ${p.id}：${p.text}`)
          .join('\n')}`,
      );
    }
    if (scene.done) out.push(`演完的标准：${scene.done}`);
    out.push(`这一幕已经演了 ${plot.sceneBeats} 拍（至少 ${scene.minBeats} 拍，最多 ${scene.maxBeats} 拍）。`);
    const exits = openExits(plot);
    if (exits.length) {
      const fork = exits.length >= 2;
      const lines = exits.map((e) => {
        const t = sceneById(plot, e.to);
        const extra = [fork && e.label ? `选项：${e.label}` : '', e.when ? `条件：${e.when}` : ''].filter(Boolean).join('；');
        return `- ${e.to}「${t?.title || e.to}」${t?.what ? `：${t.what}` : ''}${extra ? `（${extra}）` : ''}`;
      });
      out.push(`## 出口（这一幕演完后去哪里）\n${lines.join('\n')}`);
      if (mode === 'adv' && fork) {
        out.push('这是岔路，走哪条路由玩家决定：不要自己替玩家选路。可以在给玩家的选项里带上 exit（目标幕 id），让玩家选。');
      }
    } else out.push('## 出口\n（现在没有打开的出口，继续演这一幕）');
    if (sceneMaxed(plot)) out.push('这一幕已经演满了：这一拍要用故事里自然发生的事把场面过渡出去，并在 exit 里选一条路。');
    if (plot.offTrack >= 2) {
      out.push('最近几拍偏离了这一幕：这一拍要用故事里自然发生的事（来人、变故、消息、时间到了）把场面带回这一幕。');
    }
  }

  const vars = varsSection(world.variables, plot);
  if (vars) out.push(vars);
  if (g.threads.length) out.push(`## 伏笔\n${g.threads.map((t) => `- ${t.text}${t.payoff ? `（回收：${t.payoff}）` : ''}`).join('\n')}`);
  if (plot.notes.length) out.push(`## 上一拍被引擎驳回或截断的内容\n${plot.notes.map((n) => `- ${n}`).join('\n')}`);
  return out.join('\n');
}

export function varsSection(variables: readonly VariableDef[], plot: PlotState): string {
  const shown = variables.map((v) => {
    const cur = plot.vars[v.id] ?? v.initial;
    const range = v.type === 'number' && (v.min !== undefined || v.max !== undefined) ? `，范围 ${v.min ?? '-∞'}～${v.max ?? '∞'}` : '';
    const lim = perBeatLimit(v);
    const cap = lim ? `，每拍最多变 ±${lim.normal}（演到要点或检定成功的那一拍 ±${lim.burst}）` : '';
    const kind = v.category === 'attribute' ? '，属性：检定时的修正值' : '';
    return `- ${v.id}（${v.label}）：${JSON.stringify(cur)}${range}${cap}${kind}`;
  });
  if (!shown.length) return '';
  return `## 数值（剧情里发生了影响它们的事，就在 set 里提出变化；引擎会核对上限）\n${shown.join('\n')}`;
}

/** 检定结果怎么交给演出的一方：先说结果，再要求写出过程。 */
export function checkInstruction(c: CheckResult): string {
  const how =
    c.outcome === 'crit'
      ? '大成功：写出出乎意料的好结果'
      : c.outcome === 'success'
        ? '成功：写出成功的过程'
        : c.outcome === 'narrow'
          ? '险胜：做到了，但要付出代价，把代价写出来'
          : '失败：写出失败的过程和后果';
  return `［检定］${c.label}：掷出 ${c.roll}${c.modifier ? `${c.modifier > 0 ? '+' : ''}${c.modifier}` : ''}，难度 ${c.dc}，${OUTCOME_LABELS[c.outcome]}。${how}。`;
}

/** 演员和旁白看到的剧情图：只有当前幕的梗概和要点（结局幕给收场要求）。 */
export function sceneBrief(plot: PlotState | null): string {
  const s = plot?.scene;
  if (!s) return '';
  if (s.ending) return `［结局］${s.title || s.id}：${s.ending.text || s.what}。这一拍把结局写出来。`;
  const pending = s.points.filter((p) => !plot?.points.has(p.id)).map((p) => p.text);
  return `［这一幕］${s.title || s.id}：${s.what}${pending.length ? `\n［还没演到的要点］${pending.join('；')}` : ''}`;
}
