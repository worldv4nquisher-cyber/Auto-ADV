import type { Character, PlotScene } from '@auto-adv/schema';
import { z } from 'zod';
import type { BeatCg, PlayEvent, SceneState } from '../api.ts';
import { list, text } from '../genesis/specs.ts';
import { shortId } from '../util.ts';
import { matchByName } from '../world/render.ts';

/**
 * AI 演出时的 CG（18.6）：导演可以在一拍的安排里标一个"高光时刻"（画面描述和画面里的角色），
 * 引擎按设置限制每幕、每章最多几张。导演安排好就交给素材管线去画，不等演出；舞台在这一拍中间那句话上放出来。
 */

/** 导演安排里的 CG（可选）。 */
export const CgProposal = z
  .object({ title: text.default(''), description: text.default(''), cast: list })
  .nullable()
  .catch(null)
  .default(null);
export type CgProposal = z.infer<typeof CgProposal>;

/** 每幕、每章最多几张（素材设置里的 cg.perScene、cg.perChapter）。 */
export interface CgRules {
  perScene: number;
  perChapter: number;
}

/** 导演安排好一拍（还没演出）时交给素材管线的东西：这一拍的 CG、地点和故事时间（时段背景用）。 */
export interface PlannedBeat {
  playthroughId: string;
  cg: BeatCg | null;
  scene: SceneState;
  time: string | null;
  /** 剧情图上的哪一幕（没有剧情图为 null）。 */
  sceneId: string | null;
}

/**
 * 这一拍还能标几张 CG：有剧情图时按幕和章数路径上已经标过的；没有剧情图时（自由的观察模式）按"同一个地点连着演的这一段"算一幕，
 * 不限每章。只数导演标的，手写剧本里的 CG 不算。
 */
export function cgLeft(
  path: readonly PlayEvent[],
  scenes: readonly Pick<PlotScene, 'id' | 'chapter'>[] | null,
  sceneId: string | null,
  rules: CgRules,
): number {
  const marked = path.filter((e) => e.kind === 'ai' && e.beat?.cg);
  if (scenes && sceneId) {
    const chapter = scenes.find((s) => s.id === sceneId)?.chapter;
    const inScene = marked.filter((e) => e.plot?.scene === sceneId).length;
    let left = rules.perScene - inScene;
    if (chapter) {
      const ids = new Set(scenes.filter((s) => s.chapter === chapter).map((s) => s.id));
      left = Math.min(left, rules.perChapter - marked.filter((e) => e.plot && ids.has(e.plot.scene)).length);
    }
    return Math.max(0, left);
  }
  // 没有剧情图：从最后一次换地点算起
  let location: string | null = null;
  let since = 0;
  for (const e of path) {
    if (e.scene && e.scene.locationId !== location) {
      location = e.scene.locationId;
      since = 0;
    }
    if (e.kind === 'ai' && e.beat?.cg) since += 1;
  }
  return Math.max(0, rules.perScene - since);
}

/** 导演提示词里的"CG"一节。这一拍不能标（关掉了、没配图像模型、到了上限）时为空。 */
export function cgSection(left: number): string {
  if (left <= 0) return '';
  return `# CG（可选）
这一拍如果是整段故事里特别值得画成一张插画的高光时刻（重逢、告白、真相揭开、决定性的一幕），在 cg 里写：
{"title": "4～10 字的标题", "description": "画面描述（40～120 字）：这一刻画面里正在发生什么，人物的动作、表情和位置，环境和光线；按一张静止的画来写，不写对白", "cast": ["画面里的角色名（只能用「角色」里的名字）"]}
这一幕最多还能标 ${left} 张，宁缺毋滥；普通的拍写 null。`;
}

/** 导演写的 CG 转成这一拍的 CG：没写画面描述、已经到了上限时为 null。画面里的角色只认世界里有的。 */
export function cgOfPlan(raw: CgProposal, characters: readonly Character[], left: number): BeatCg | null {
  if (left <= 0 || !raw) return null;
  const description = raw.description.trim();
  if (!description) return null;
  const cast = [...new Set(raw.cast.flatMap((n) => matchByName(n, [...characters])?.id ?? []))];
  return { id: shortId('ai'), title: raw.title.trim() || [...description].slice(0, 10).join(''), description, cast };
}
