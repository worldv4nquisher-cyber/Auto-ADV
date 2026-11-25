/**
 * M4 第 3 步：BGM 的情绪、来源顺序、本地曲库、换曲规则（docs/ARCHITECTURE.md 18.7）。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AssetIndex, BgmSettings, DEFAULT_MOODS } from '@auto-adv/schema';
import { afterEach, describe, expect, it } from 'vitest';
import type { PlayEvent } from '../src/api.ts';
import { type BuiltinTrackDef, libraryMoodOf, loadBuiltin, resolveBgm, scanLibrary } from '../src/assets/bgm.ts';
import { moodOfPlan, moodSection } from '../src/play/moods.ts';
import { buildTimeline, moodOf } from '../src/plot/stage.ts';

const tmp: string[] = [];
afterEach(async () => {
  for (const d of tmp.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('认情绪', () => {
  it('id、名字、同义词完全对上；英文按单词、中文按包含；长的词先比；对不上为 null', () => {
    const cases: [string, string | null][] = [
      ['tense', 'tense'],
      ['紧张', 'tense'],
      ['Mystery', 'tense'],
      ['calm_daily', 'daily'],
      ['reunion', 'warm'],
      ['03 - Suspense Theme', 'tense'],
      ['final_battle', 'climax'],
      ['紧张的追逐', 'tense'],
      ['离别之歌', 'sad'],
      ['opening', 'theme'],
      ['top', null],
      ['track01', null],
      ['', null],
    ];
    for (const [token, want] of cases) expect(moodOf(token, DEFAULT_MOODS), token).toBe(want);
  });

  it('导演写的 mood：写名字也认；对不上、没给情绪表都是 undefined', () => {
    expect(moodOfPlan('温馨', DEFAULT_MOODS)).toBe('warm');
    expect(moodOfPlan('climax', DEFAULT_MOODS)).toBe('climax');
    expect(moodOfPlan('随便', DEFAULT_MOODS)).toBeUndefined();
    expect(moodOfPlan('tense', undefined)).toBeUndefined();
    const section = moodSection(DEFAULT_MOODS);
    expect(section).toContain('# 音乐情绪');
    expect(section).toContain('- tense（紧张）：悬疑、调查、对峙、危险逼近');
    expect(moodSection([])).toBe('');
  });
});

describe('本地曲库', () => {
  it('子文件夹名（从里往外）先认，再认文件名', () => {
    expect(libraryMoodOf('紧张/a.mp3', DEFAULT_MOODS)).toEqual({ mood: 'tense', by: 'folder' });
    expect(libraryMoodOf('悲伤/rain/03.ogg', DEFAULT_MOODS)).toEqual({ mood: 'sad', by: 'folder' });
    expect(libraryMoodOf('BGM/daily_walk.ogg', DEFAULT_MOODS)).toEqual({ mood: 'daily', by: 'name' });
    expect(libraryMoodOf('misc/track01.mp3', DEFAULT_MOODS)).toEqual({ mood: null, by: null });
  });

  it('扫文件夹：只认音频文件，跳过隐藏文件，最多三层；文件夹不在时报原因', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'auto-adv-lib-'));
    tmp.push(dir);
    const files = ['紧张/追逐.mp3', '紧张/cover.jpg', 'calm_daily.ogg', '.hidden.mp3', 'a/b/c/深.flac', 'a/b/c/d/太深.mp3', 'track01.wav'];
    for (const f of files) {
      await mkdir(path.dirname(path.join(dir, f)), { recursive: true });
      await writeFile(path.join(dir, f), 'x');
    }
    const scan = await scanLibrary(dir, DEFAULT_MOODS);
    expect(scan.error).toBeNull();
    expect(scan.tracks.map((t) => [t.rel, t.mood])).toEqual([
      ['a/b/c/深.flac', null],
      ['calm_daily.ogg', 'daily'],
      ['track01.wav', null],
      ['紧张/追逐.mp3', 'tense'],
    ]);
    const missing = await scanLibrary(path.join(dir, 'nope'), DEFAULT_MOODS);
    expect(missing).toMatchObject({ tracks: [], error: '文件夹不存在' });
  });

  it('内置曲库：读清单，去掉文件不在的；没有清单就是空的', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'auto-adv-builtin-'));
    tmp.push(dir);
    const track = (file: string, mood: string): BuiltinTrackDef => ({
      file,
      title: file,
      composer: '萨蒂',
      mood,
      source: 'https://example.org/score',
      method: '用公有领域乐谱渲染',
      license: '作品：公有领域',
    });
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ tracks: [track('a.ogg', 'daily'), track('missing.ogg', 'sad')] }));
    await writeFile(path.join(dir, 'a.ogg'), 'x');
    expect((await loadBuiltin(dir)).map((t) => t.file)).toEqual(['a.ogg']);
    expect(await loadBuiltin(path.join(dir, 'nope'))).toEqual([]);
    expect(await loadBuiltin(undefined)).toEqual([]);
  });
});

describe('每个情绪放什么', () => {
  const builtin: BuiltinTrackDef[] = ['daily', 'tense', 'sad'].map((mood) => ({
    file: `${mood}.ogg`,
    title: mood,
    composer: '作曲家',
    mood,
    source: '',
    method: '渲染',
    license: '公有领域',
  }));
  const library = [
    { rel: '紧张/追逐.mp3', name: '追逐', mood: 'tense', by: 'folder' as const },
    { rel: 'track01.wav', name: 'track01', mood: null, by: null },
  ];
  const index = AssetIndex.parse({
    slots: {
      'bgm/daily': { id: 'bgm/daily', file: 'assets/bgm/daily-abc.mp3', source: 'generated' },
      'bgm/theme': { id: 'bgm/theme', file: 'assets/uploads/bgm-theme-1.mp3', source: 'uploaded', locked: true },
    },
  });
  const get = (list: ReturnType<typeof resolveBgm>, mood: string) => list.find((p) => p.mood === mood);

  it('按顺序找第一个有曲子的来源；轮到音乐模型、还没生成好时先用后面的来源；自己的文件最优先', () => {
    const list = resolveBgm({ settings: BgmSettings.parse({}), index, library, builtin, modelReady: true });
    expect(get(list, 'theme')).toMatchObject({ source: 'uploaded', wantsModel: false, tracks: [{ ref: { kind: 'world', path: 'assets/uploads/bgm-theme-1.mp3' } }] });
    expect(get(list, 'tense')).toMatchObject({ source: 'library', wantsModel: false, tracks: [{ ref: { kind: 'library', path: '紧张/追逐.mp3' }, loop: false }] });
    expect(get(list, 'daily')).toMatchObject({ source: 'model', wantsModel: false, tracks: [{ ref: { kind: 'world', path: 'assets/bgm/daily-abc.mp3' }, loop: true }] });
    expect(get(list, 'sad')).toMatchObject({ source: 'builtin', wantsModel: true, tracks: [{ ref: { kind: 'builtin', path: 'sad.ogg' } }] });
    expect(get(list, 'warm')).toMatchObject({ source: null, wantsModel: true, tracks: [] });
  });

  it('没配音乐模型就不等它；关掉的来源跳过；单个情绪可以指定来源', () => {
    const off = resolveBgm({ settings: BgmSettings.parse({}), index, library, builtin, modelReady: false });
    expect(get(off, 'warm')).toMatchObject({ source: null, wantsModel: false });
    const order = resolveBgm({
      settings: BgmSettings.parse({ sources: ['builtin', 'library'], pins: { daily: 'library', sad: 'model' } }),
      index,
      library,
      builtin,
      modelReady: true,
    });
    expect(get(order, 'tense')?.source).toBe('builtin');
    // 指定了本地曲库、曲库里没有日常的曲子：一首都没有，也不去用别的来源
    expect(get(order, 'daily')).toMatchObject({ source: null, tracks: [] });
    expect(get(order, 'sad')).toMatchObject({ source: null, wantsModel: true });
  });
});

describe('换曲规则', () => {
  let n = 0;
  const ev = (over: Partial<PlayEvent>): PlayEvent => ({
    id: `e${++n}`,
    parentId: null,
    kind: 'ai',
    createdAt: n,
    segments: [{ kind: 'narration', text: `第 ${n} 拍` }],
    ...over,
  });
  const beat = (mood: string, over: Partial<PlayEvent> = {}) =>
    ev({ beat: { plan: '', strategy: 'merged', mood }, scene: { locationId: 'loc_a', presentCharacterIds: [] }, ...over });
  const bgmOf = (path: PlayEvent[], switchBeats = 2) =>
    buildTimeline(path, { characters: [], bgm: { moods: DEFAULT_MOODS, switchBeats } }).steps.map((s) => s.view.bgm);

  it('第一拍马上放；新的情绪连着两拍才换，中间回到原来的情绪就不换', () => {
    expect(bgmOf([beat('daily'), beat('tense'), beat('daily'), beat('tense'), beat('tense'), beat('tense')])).toEqual([
      'daily',
      'daily',
      'daily',
      'daily',
      'tense',
      'tense',
    ]);
    expect(bgmOf([beat('daily'), beat('tense')], 1)).toEqual(['daily', 'tense']);
  });

  it('换幕、换地点时马上换', () => {
    const plot = (scene: string) => ({ scene, points: [], vars: [] }) as unknown as PlayEvent['plot'];
    expect(bgmOf([beat('daily', { plot: plot('sc_1') }), beat('tense', { plot: plot('sc_2') })])).toEqual(['daily', 'tense']);
    expect(bgmOf([beat('daily'), beat('sad', { scene: { locationId: 'loc_b', presentCharacterIds: [] } })])).toEqual(['daily', 'sad']);
  });

  it('手写剧本的 bgm 指令照旧；它认成的情绪和导演报告的一样就不换', () => {
    const script = ev({ kind: 'script', stage: [{ op: 'bgm', id: 'mystery' }, { op: 'narrate', text: '剧本' }] });
    expect(bgmOf([script, beat('tense'), beat('tense'), beat('warm'), beat('warm')])).toEqual(['mystery', 'mystery', 'mystery', 'mystery', 'warm']);
  });

  it('没给换曲规则、情绪表里没有的情绪：不换', () => {
    const path = [beat('daily'), beat('tense')];
    expect(buildTimeline(path, { characters: [] }).steps.map((s) => s.view.bgm)).toEqual([null, null]);
    expect(bgmOf([beat('rock'), beat('rock')])).toEqual([null, null]);
  });
});
