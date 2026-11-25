import type { MoodDef } from '@auto-adv/schema';
import { moodOf } from '../plot/stage.ts';

/**
 * BGM 的情绪（18.7）：导演每一拍多报一个 mood，舞台按它换曲（plot/stage.ts 的 buildTimeline）。不额外调模型。
 */

/** 导演提示词里的"音乐情绪"一节。没有情绪表（BGM 关掉了）时为空。 */
export function moodSection(moods?: readonly MoodDef[]): string {
  if (!moods?.length) return '';
  const lines = moods.map((m) => `- ${m.id}（${m.name}）${m.hint.trim() ? `：${m.hint.trim()}` : ''}`);
  return `# 音乐情绪\nmood 写这一拍整体的气氛，从下面选一个 id。引擎按它换背景音乐，气氛持续几拍才会换曲，所以按这段戏的整体气氛选，不用每拍都变。\n${lines.join('\n')}`;
}

/** 导演写的 mood 对到情绪表里的 id（写了名字、同义词也认）；对不上为 undefined。 */
export function moodOfPlan(raw: string, moods?: readonly MoodDef[]): string | undefined {
  if (!moods?.length) return undefined;
  return moodOf(raw, moods) ?? undefined;
}
