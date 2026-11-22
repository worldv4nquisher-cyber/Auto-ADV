/**
 * 换幕由引擎决定（docs/ARCHITECTURE.md 16.2）。每拍结束后按顺序判断：
 * 1. auto 出口条件成立就直接走（回复被截断时不走）；
 * 2. 剧本 / 导演 / 玩家请求的出口：必须是当前幕声明过的、条件成立的；导演的请求还要演满 minBeats；
 *    ADV 模式的岔路只能由玩家决定，没有玩家行动时导演提出的岔路一律驳回，弹出选项；
 * 3. 说"演完了"但没指定出口：只有一条路就走，岔路在 ADV 模式弹出选项；
 * 4. 演满 maxBeats 还没走（只对 AI 演出）：只有一条路或有 default 就走过去；ADV 的岔路弹出选项，观察模式要求导演下一拍选一条；
 * 5. 结局幕没有出口，由调用方处理。
 */
import type { PlayMode, PlotExit, PlotScene, VariableDef } from '@auto-adv/schema';
import type { ExitReason, PlotMenu } from '../api.ts';
import { type ConditionContext, describeCondition, evalCondition } from './conditions.ts';

export interface BeatReport {
  /** 谁提出的：script 剧本作者（不受 minBeats / maxBeats 限制）、director 导演（模型）、player 玩家。 */
  by: 'script' | 'director' | 'player';
  /** 这一幕演完了。 */
  done: boolean;
  /** 请求走的出口（目标幕 id）。 */
  exit?: string;
  /** 这一拍有没有玩家行动（选项或输入）。 */
  playerAction: boolean;
  /** 回复被截断了（截断时 auto 出口不走）。 */
  truncated?: boolean;
}

export interface Transition {
  exit?: { to: string; by: ExitReason; def: PlotExit };
  /** ADV 模式：停在这里，让玩家从岔路里选。 */
  menu?: PlotMenu;
  /** 观察模式：导演下一拍必须选一条路。 */
  mustChoose?: boolean;
  /** 被驳回的请求和理由。 */
  notes: string[];
}

export interface TransitionInput {
  scene: PlotScene;
  mode: PlayMode;
  /** 算上这一拍，当前幕已经演了几拍。 */
  beats: number;
  ctx: ConditionContext;
  report: BeatReport;
  variables?: readonly VariableDef[];
  /** 按 id 找幕（菜单里显示目标幕的标题、隐藏结局没解锁时显示为"？？？"）。 */
  lookup?: (id: string) => PlotScene | undefined;
}

/** 不是 auto 的出口：岔路选项从这里来。两个以上就是岔路。 */
export const choosableExits = (s: PlotScene) => s.exits.filter((e) => !e.auto);

/** 岔路的选项菜单：顺序和 choosableExits 一致，锁住的也显示出来（通往隐藏结局的锁住时显示为"？？？"）。 */
export function exitMenu(
  scene: PlotScene,
  ctx: ConditionContext,
  names: { variables?: readonly VariableDef[]; lookup?: (id: string) => PlotScene | undefined } = {},
): PlotMenu {
  const vars = new Map((names.variables ?? []).map((v) => [v.id, v]));
  return {
    source: 'exits',
    options: choosableExits(scene).map((e) => {
      const enabled = evalCondition(e.if, ctx);
      const target = names.lookup?.(e.to);
      if (!enabled && target?.ending?.hidden) return { label: '？？？', enabled };
      return {
        label: e.label || target?.title || e.to,
        enabled,
        ...(enabled ? {} : { lockedBy: describeCondition(e.if, { vars }) }),
      };
    }),
  };
}

export function decideTransition(p: TransitionInput): Transition {
  const { scene, ctx, report } = p;
  const notes: string[] = [];
  const open = (e: PlotExit) => evalCondition(e.if, ctx);
  const choosable = choosableExits(scene);
  const fork = choosable.length >= 2;
  const adv = p.mode === 'adv';
  const menu = () => ({ menu: exitMenu(scene, ctx, { variables: p.variables, lookup: p.lookup }), notes });
  if (scene.ending) return { notes };

  // 1. auto 出口
  if (!report.truncated) {
    const auto = scene.exits.find((e) => e.auto && open(e));
    if (auto) return { exit: { to: auto.to, by: 'auto', def: auto }, notes };
  }

  // 2. 请求走某个出口
  if (report.exit) {
    const e = choosable.find((x) => x.to === report.exit);
    const reason = !e
      ? `${report.exit} 不是这一幕可以选的出口`
      : !open(e)
        ? `去 ${report.exit} 的条件不成立`
        : report.by === 'director' && p.beats < scene.minBeats
          ? `这一幕至少要演 ${scene.minBeats} 拍，现在才 ${p.beats} 拍`
          : report.by === 'director' && adv && fork && !report.playerAction
            ? '岔路只能由玩家决定'
            : null;
    if (!e || reason) {
      notes.push(`不能走到 ${report.exit}：${reason}`);
      // 导演替玩家选了岔路：场面停在要做选择的地方
      if (e && reason === '岔路只能由玩家决定') return menu();
    } else return { exit: { to: e.to, by: report.by === 'player' ? 'choice' : report.by, def: e }, notes };
  }

  // 3. 演完了
  const minOk = report.by !== 'director' || p.beats >= scene.minBeats;
  if (report.done && !minOk) notes.push(`这一幕至少要演 ${scene.minBeats} 拍，现在才 ${p.beats} 拍，先不算演完`);
  const maxed = report.by !== 'script' && p.beats >= scene.maxBeats;
  if ((report.done && minOk) || maxed) {
    const viaDefault = maxed && !(report.done && minOk);
    if (!fork) {
      const only = choosable[0];
      if (only && open(only)) return { exit: { to: only.to, by: viaDefault ? 'default' : 'single', def: only }, notes };
      if (only) notes.push(`唯一的出口（→ ${only.to}）条件不成立`);
      return { notes };
    }
    if (adv) return menu();
    // 观察模式：演满了就走 default；只是说演完了没选路，让导演下一拍选
    const d = scene.default ? choosable.find((x) => x.to === scene.default && open(x)) : undefined;
    if (viaDefault && d) return { exit: { to: d.to, by: 'default', def: d }, notes };
    return { mustChoose: true, notes };
  }
  return { notes };
}
