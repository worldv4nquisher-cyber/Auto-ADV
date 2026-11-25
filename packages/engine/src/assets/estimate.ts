import type { AssetSettings } from '@auto-adv/schema';

/**
 * 创世前的素材用量估算（6.5、18.3）：按创世的选项和素材设置估算一个新世界要画多少张图、生成几首曲子、每拍念多少字。
 * 创世还没跑，地点数、幕数都是按创世提示词里的规模估的，所以给的是范围。纯函数。
 */

export type Range = [number, number];

export interface AssetEstimate {
  /** 没配图像模型：不画图，全是占位图。 */
  imageReady: boolean;
  images: {
    backgrounds: Range;
    sprites: Range;
    /** 每个周目：手写剧本没有，导演按每幕、每章的上限标。 */
    cgs: Range;
    /** 时段背景：用到了才画，最多是地点数 × 时段数。 */
    timeOfDay: Range;
    /** 开局就画的（背景 + 立绘）。 */
    upfront: Range;
    /** 每个世界的上限（算上重抽）。 */
    cap: number;
  };
  /** 用音乐模型生成的曲子数；不用音乐模型时为 0，note 说明用什么。 */
  music: { tracks: number; note: string };
  /** 每一拍大约念多少字；没配语音或者关掉了为 null。 */
  voice: { perBeat: Range } | null;
}

/** 创世提示词里的规模（genesis/prompts.ts）：地点 4～6 个；中等长度的剧情图 8～12 幕、2～3 章。 */
const LOCATIONS: Range = [4, 6];
const SCENES: Range = [8, 12];
const CHAPTERS: Range = [2, 3];

export function estimateAssets(
  o: { characterCount?: number | undefined },
  s: AssetSettings,
  ready: { image: boolean; music: boolean; voice: boolean },
): AssetEstimate {
  const others = Math.max(1, Math.min(8, o.characterCount ?? 3));
  const drawn = others + (s.spriteProtagonist ? 1 : 0);
  const per = (set: readonly string[]) => (s.enabled.expression ? new Set(['neutral', ...set]).size : 1);
  const sprites: Range = s.enabled.sprite ? [drawn * Math.min(per(s.spriteSets.other), per(s.spriteSets.main)), drawn * per(s.spriteSets.main)] : [0, 0];
  const backgrounds: Range = s.enabled.background ? LOCATIONS : [0, 0];
  const cgOn = s.enabled.cg && s.cg.perScene > 0;
  const cgs: Range = cgOn
    ? [Math.min(s.cg.perScene * SCENES[0], s.cg.perChapter * CHAPTERS[0]), Math.min(s.cg.perScene * SCENES[1], s.cg.perChapter * CHAPTERS[1])]
    : [0, 0];
  const timeOfDay: Range = s.enabled.background && s.enabled.timeOfDay ? [0, LOCATIONS[1] * s.timeOfDay.variants.length] : [0, 0];

  // 音乐模型排在内置曲库前面才会生成（本地曲库有的情绪也不生成，所以是"最多"）
  const order = s.bgm.sources;
  const model = order.indexOf('model');
  const builtin = order.indexOf('builtin');
  let music: AssetEstimate['music'];
  if (!s.enabled.bgm) music = { tracks: 0, note: 'BGM 关掉了' };
  else if (model < 0) music = { tracks: 0, note: '来源里没有音乐模型，用曲库' };
  else if (!ready.music) music = { tracks: 0, note: '没配音乐模型，用内置曲库' };
  else if (builtin >= 0 && builtin < model) music = { tracks: 0, note: '内置曲库排在音乐模型前面，先用内置曲库' };
  else music = { tracks: s.bgm.moods.length, note: order.indexOf('library') >= 0 && order.indexOf('library') < model && s.bgm.libraryDir ? '本地曲库里有的情绪不生成' : '' };

  // 剧情 ADV 一拍 150～350 字，台词大约占一半；旁白也配就差不多全念
  const voice = s.enabled.voice && ready.voice ? { perBeat: (s.voice.narrator ? [150, 350] : [70, 180]) as Range } : null;

  const imageReady = ready.image;
  const zero: Range = [0, 0];
  return {
    imageReady,
    images: {
      backgrounds: imageReady ? backgrounds : zero,
      sprites: imageReady ? sprites : zero,
      cgs: imageReady ? cgs : zero,
      timeOfDay: imageReady ? timeOfDay : zero,
      upfront: imageReady ? [backgrounds[0] + sprites[0], backgrounds[1] + sprites[1]] : zero,
      cap: s.imageCap,
    },
    music,
    voice,
  };
}
