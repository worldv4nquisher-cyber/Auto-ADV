/**
 * VN 舞台的播放时间线（M3 第 2 步，第 4 步起观察模式也用它）：把路径上的事件展开成一步一步的画面。
 * 一步 = 玩家点一下看到的东西：一句台词或旁白、一次停顿、一次检定、进入新一幕的标题卡。
 * 每一步都带着当时完整的画面（背景、立绘、CG、音乐），所以回想、存档定位、快进都只需要一个下标。
 * 纯函数，界面和引擎共用（界面从 @auto-adv/engine/stage 引入，不会把引擎其余部分打包进去）。
 */
import type { PlotGraph, StageCommand } from '@auto-adv/schema';
import type { CheckResult, DriftChoice, PlayEvent, SceneState, Segment, VarChange } from '../api.ts';
import { matchByName } from '../world/render.ts';

type Cast = readonly { id: string; name: string; aliases?: string[] }[];

/** 剧情 ADV 跑偏时的选择（16.6）显示成的文字。 */
export const DRIFT_LABELS: Record<DriftChoice, string> = {
  pull: '拉回来',
  detour: '就这样走',
  pause: '暂停剧情图',
  resume: '恢复剧情图',
  ignore: '不用管',
};

/** 说话人：角色 id、去掉 char_ 前缀的 id、名字或别称都可以；都对不上就是临时人物。 */
export function resolveSpeaker(token: string, cast: Cast): { characterId: string | null; name: string } {
  const c = cast.find((x) => x.id === token || x.id === `char_${token}`) ?? matchByName(token, [...cast]);
  return c ? { characterId: c.id, name: c.name } : { characterId: null, name: token };
}

/** 表情表里认表情用到的部分（和 @auto-adv/schema 的 ExpressionDef 一样）。 */
export interface ExpressionLike {
  id: string;
  name: string;
  synonyms: readonly string[];
}

/**
 * 台词开头括号里的第一个词对应哪个表情（18.6）：先按名字、id、同义词完全对上，
 * 再看第一个词里有没有包含这些词（"笑了一下"认成微笑，"愣了一下"认成惊讶）。对不上返回 null，保持上一个表情。
 */
export function expressionOfLine(text: string, table: readonly ExpressionLike[]): string | null {
  const m = /^\s*[（(]([^（）()]{1,40})[）)]/.exec(text);
  const first = m?.[1]?.split(/[，,、；;。！!？?\s]/)[0]?.trim();
  if (!first) return null;
  const lower = first.toLowerCase();
  for (const e of table) if (e.name === first || e.id === lower || e.synonyms.includes(first)) return e.id;
  const words = table
    .flatMap((e) => [e.name, ...e.synonyms].map((w) => ({ w, id: e.id })))
    .filter((x) => x.w)
    .sort((a, b) => b.w.length - a.w.length);
  return words.find((x) => first.includes(x.w))?.id ?? null;
}

/** 情绪表里认情绪用到的部分（和 @auto-adv/schema 的 MoodDef 一样）。 */
export interface MoodLike {
  id: string;
  name: string;
  synonyms: readonly string[];
}

/**
 * 一个词对应哪个情绪（18.7）：导演报告的 mood、手写剧本里 bgm 指令的 id、本地曲库的文件夹名和文件名都用它认。
 * 先按 id、名字、同义词完全对上，再看里面有没有这些词：英文按单词比（calm_daily 认成日常，"03 Suspense" 认成紧张），
 * 中文按包含比（"紧张的追逐" 认成紧张）。长的词先比。对不上为 null。
 */
export function moodOf(token: string, moods: readonly MoodLike[]): string | null {
  const t = token.trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  for (const m of moods) if (m.id === lower || m.name === t || m.synonyms.some((w) => w.toLowerCase() === lower)) return m.id;
  const words = new Set(lower.split(/[^a-z0-9]+/).filter(Boolean));
  const candidates = moods
    .flatMap((m) => [m.id, m.name, ...m.synonyms].map((w) => ({ w: w.trim().toLowerCase(), id: m.id })))
    .filter((x) => x.w)
    .sort((a, b) => b.w.length - a.w.length);
  for (const c of candidates) {
    if (/^[a-z0-9_]+$/.test(c.w) ? c.w.split('_').every((p) => words.has(p)) : lower.includes(c.w)) return c.id;
  }
  return null;
}

/** 时段表里认时段用到的部分（和 @auto-adv/schema 的 TimeVariantDef 一样）。 */
export interface TimeVariantLike {
  id: string;
  words: readonly string[];
}

/**
 * 故事时间（导演报告的 time，例如"当晚十点""傍晚"）对应哪个时段（18.4）：时段表里的词出现在时间里就算，长的词先比
 * （"入夜前"是黄昏，不是夜晚）。对不上就是 null，用地点本来的背景。
 */
export function variantOfTime(time: string | null | undefined, variants: readonly TimeVariantLike[]): string | null {
  const t = time?.trim().toLowerCase();
  if (!t) return null;
  const words = variants
    .flatMap((v) => v.words.map((w) => ({ w: w.trim().toLowerCase(), id: v.id })))
    .filter((x) => x.w)
    .sort((a, b) => b.w.length - a.w.length);
  return words.find((x) => t.includes(x.w))?.id ?? null;
}

/** 时段背景的 id：<地点 id>@<时段 id>；没有时段就是地点 id 本身。 */
export const bgVariantId = (locationId: string, variant: string | null | undefined) => (variant ? `${locationId}@${variant}` : locationId);

/** 背景 id 去掉时段：舞台上的 bg id 可能带着 @时段，比较地点时用它。 */
export const baseBgId = (id: string | null | undefined) => (id ? (id.split('@')[0] ?? id) : null);

/** 立绘站位：舞台宽度的百分比（立绘中心）。 */
export const SPRITE_POSITIONS: Record<string, number> = {
  farleft: 14,
  left: 28,
  center: 50,
  right: 72,
  farright: 86,
};
/** 没写站位时，新上场的立绘依次放到这些位置里空着的一个。 */
const AUTO_SLOTS = ['center', 'left', 'right', 'farleft', 'farright'] as const;

/** 站位：left / center / right / farleft / farright，也可以直接写百分比（如 40 或 40%）。认不出来时为 null。 */
export function spriteX(pos: string | undefined): number | null {
  if (!pos) return null;
  const p = pos.trim().toLowerCase().replace(/[-_\s]/g, '');
  if (p in SPRITE_POSITIONS) return SPRITE_POSITIONS[p] as number;
  const n = /^(\d{1,3})%?$/.exec(p);
  if (n) return Math.min(95, Math.max(5, Number(n[1])));
  return null;
}

export interface StageSprite {
  /** 剧本里写的角色记号（同一个角色的 show / hide 靠它对应）。 */
  key: string;
  characterId: string | null;
  name: string;
  expr: string;
  /** 站位（百分比）。 */
  x: number;
}

/** 某一步的完整画面。 */
export interface StageView {
  bg: { id: string; transition?: string } | null;
  sprites: StageSprite[];
  /** 全屏 CG，盖在背景和立绘上面；下一个 bg 指令时清掉。 */
  cg: string | null;
  bgm: string | null;
}

export interface StageText {
  kind: 'say' | 'narrate' | 'think';
  /** 说话人；旁白和没写角色的心声为 null。 */
  speaker: { characterId: string | null; name: string } | null;
  text: string;
}

/** 一次性的表现：音效、语音、视频、特效。素材还没有，界面先显示一个提示。 */
export interface StageCue {
  op: 'sfx' | 'voice' | 'video' | 'effect';
  id: string;
}

export interface StageStep {
  /** 这一步属于哪个事件。 */
  eventId: string;
  /** 在这个事件里是第几步（从 0 开始；存档用 eventId + index 定位）。标题卡是 -1。 */
  index: number;
  /**
   * text：台词、旁白、心声，点一下继续；pause：画面有变化但没有文字（例如只放了一张 CG），点一下继续；
   * wait：停顿几秒自动继续；check：检定结果；card：进入新一幕的标题卡。
   */
  kind: 'text' | 'pause' | 'wait' | 'check' | 'card';
  /** 这一步所在的幕（剧情图上的 id；没有剧情图进度的事件为 null）。 */
  scene: string | null;
  view: StageView;
  text?: StageText;
  seconds?: number;
  check?: CheckResult;
  card?: { title: string; chapter: string | null };
  /** 这一步开始时触发的音效、特效等。 */
  cues?: StageCue[];
  /** 这一步第一次显示的 CG（用来记跨周目解锁）。 */
  cgShown?: string;
  /** 这一步对应的数值变化（事件上记的，裁决之后的结果）。 */
  vars?: VarChange[];
}

/** 回想里的一条。step 是它出现的那一步：播放到这一步（含）之后才显示。 */
export type BacklogEntry =
  | { kind: 'text'; step: number; text: StageText }
  | {
      kind: 'choice';
      step: number;
      label: string;
      /** 回到做这个选择之前（选项所在的那一拍），可以重新选。 */
      rewindTo: string | null;
    }
  | { kind: 'check'; step: number; check: CheckResult }
  | { kind: 'scene'; step: number; title: string; chapter: string | null }
  /** AI 演出时导演标的 CG（18.6）：画好了回想里点开能看。 */
  | { kind: 'cg'; step: number; id: string; title: string }
  /** 不上舞台、只进回想的东西：观察模式里观众的导演指令和悄悄话，剧情 ADV 里跑偏时的选择。 */
  | { kind: 'note'; step: number; label: string; text: string };

export interface Timeline {
  steps: StageStep[];
  backlog: BacklogEntry[];
  /** 路径末尾的画面（一步都没有时用它）。 */
  end: StageView;
}

export interface TimelineOptions {
  characters: Cast;
  /** 用来给新的一幕出标题卡；不给就不出。 */
  graph?: Pick<PlotGraph, 'scenes' | 'chapters'> | null;
  /**
   * 没有舞台指令的事件（观察模式的拍、开场、接管角色时说的话）按事件上记的地点和在场角色自动排出舞台：
   * 换地点时换背景，在场的人上场，开口的人先上场再说话（stageFromSegments）。导演指令和悄悄话进回想。
   * 不给时这些事件只按文本段落播放（剧情 ADV 的事件都带着舞台指令）。
   * protagonistId：不出立绘的角色（剧情 ADV 里玩家扮演的主角）；观察模式里观众不是主角，为 null。
   */
  auto?: { protagonistId: string | null; expressions?: readonly ExpressionLike[]; extras?: boolean };
  /**
   * 按导演每一拍报告的情绪换曲（18.7）：情绪变了、而且连着 switchBeats 拍都是这个情绪才换，免得来回跳；
   * 换幕（或者换地点）、还没有曲子的时候马上换。手写剧本里的 bgm 指令照旧。不给就只认 bgm 指令。
   */
  bgm?: { moods: readonly MoodLike[]; switchBeats: number };
  /**
   * 时段背景（18.4）：AI 演出的拍（和观察模式里自动排舞台的事件）按导演报告的故事时间用背景变体（bg <地点>@<时段>），
   * 时间变了、地点没变时只换背景，不清场。手写剧本的背景照写的来。不给就不换。
   */
  timeOfDay?: { variants: readonly TimeVariantLike[] };
}

const emptyView = (): StageView => ({ bg: null, sprites: [], cg: null, bgm: null });
const isTextCommand = (c: StageCommand) => c.op === 'say' || c.op === 'narrate' || c.op === 'think';
const snapshot = (v: StageView): StageView => ({ ...v, sprites: v.sprites.map((s) => ({ ...s })) });

function segmentText(seg: Segment): StageText {
  if (seg.kind === 'narration') return { kind: 'narrate', speaker: null, text: seg.text };
  return { kind: 'say', speaker: { characterId: seg.characterId, name: seg.name }, text: seg.text };
}

/** 把路径展开成时间线。 */
export function buildTimeline(path: readonly PlayEvent[], opts: TimelineOptions): Timeline {
  const steps: StageStep[] = [];
  const backlog: BacklogEntry[] = [];
  const view = emptyView();
  let scene: string | null = null;
  let chapter: string | null = null;
  // 还没落到某一步上的东西：挂到下一步
  let cues: StageCue[] = [];
  let vars: VarChange[] = [];
  let cgShown: string | null = null;

  let lastEvent: string | null = null;
  let index = 0;
  /** 当前的地点和在场角色（自动排舞台用）。 */
  let place: SceneState = { locationId: null, presentCharacterIds: [] };
  const nameOf = (id: string | undefined) => (id ? resolveSpeaker(id, opts.characters).name : '');

  const push = (ev: PlayEvent, step: Omit<StageStep, 'eventId' | 'index' | 'view' | 'scene'>) => {
    // 标题卡不占序号：出不出标题卡（给没给剧情图）不影响存档位置
    if (step.kind !== 'card') {
      index = ev.id === lastEvent ? index + 1 : 0;
      lastEvent = ev.id;
    }
    const s: StageStep = { eventId: ev.id, index: step.kind === 'card' ? -1 : index, scene, view: snapshot(view), ...step };
    if (cues.length) s.cues = cues;
    if (vars.length) s.vars = vars;
    if (cgShown) s.cgShown = cgShown;
    cues = [];
    vars = [];
    cgShown = null;
    steps.push(s);
    if (s.text) backlog.push({ kind: 'text', step: steps.length - 1, text: s.text });
  };

  const show = (c: Extract<StageCommand, { op: 'show' }>) => {
    const who = resolveSpeaker(c.char, opts.characters);
    const cur = view.sprites.find((s) => s.key === c.char || (who.characterId && s.characterId === who.characterId));
    const x =
      spriteX(c.pos) ??
      cur?.x ??
      SPRITE_POSITIONS[AUTO_SLOTS.find((p) => !view.sprites.some((s) => Math.abs(s.x - (SPRITE_POSITIONS[p] as number)) < 8)) ?? 'center'] ??
      50;
    if (cur) {
      cur.expr = c.expr ?? cur.expr;
      cur.x = x;
    } else {
      view.sprites.push({ key: c.char, ...who, expr: c.expr ?? 'neutral', x });
    }
  };

  const hide = (token: string) => {
    const who = resolveSpeaker(token, opts.characters);
    view.sprites = view.sprites.filter((s) => s.key !== token && !(who.characterId && s.characterId === who.characterId));
  };

  const run = (ev: PlayEvent, c: StageCommand) => {
    switch (c.op) {
      case 'bg':
        // 和 Ren'Py 的 scene 一样：换背景时清场（立绘和 CG 都撤下）
        view.bg = { id: c.id, ...(c.transition ? { transition: c.transition } : {}) };
        view.sprites = [];
        view.cg = null;
        break;
      case 'show':
        show(c);
        break;
      case 'hide':
        hide(c.char);
        break;
      case 'bgm':
        view.bgm = c.id;
        break;
      case 'cg':
        view.cg = c.id;
        cgShown = c.id;
        break;
      case 'sfx':
      case 'voice':
      case 'video':
        cues.push({ op: c.op, id: c.id });
        break;
      case 'effect':
        cues.push({ op: 'effect', id: c.name });
        break;
      case 'wait':
        push(ev, { kind: 'wait', seconds: c.seconds });
        break;
      case 'say':
        push(ev, { kind: 'text', text: { kind: 'say', speaker: resolveSpeaker(c.char, opts.characters), text: c.text } });
        break;
      case 'narrate':
        push(ev, { kind: 'text', text: { kind: 'narrate', speaker: null, text: c.text } });
        break;
      case 'think':
        push(ev, {
          kind: 'text',
          text: { kind: 'think', speaker: c.char ? resolveSpeaker(c.char, opts.characters) : null, text: c.text },
        });
        break;
    }
  };

  /** 导演报告的故事时间（时段背景用）。 */
  let time: string | null = null;
  /** AI 演出的舞台指令换成时段背景：换到地点的背景用变体；没换地点、时段变了，只换背景不清场。 */
  const withTimeOfDay = (stage: StageCommand[], variants: readonly TimeVariantLike[]): StageCommand[] => {
    const loc = place.locationId;
    if (!loc) return stage;
    const id = bgVariantId(loc, variantOfTime(time, variants));
    const out = stage.map((c) => (c.op === 'bg' && c.id === loc ? { ...c, id } : c));
    if (!out.some((c) => c.op === 'bg') && view.bg && baseBgId(view.bg.id) === loc && view.bg.id !== id) {
      view.bg = { id, transition: 'fade' };
    }
    return out;
  };

  /** 导演报告了、但还没持续够拍数的新情绪；上一个报告情绪的拍在哪个地点。 */
  let pendingMood: { mood: string; beats: number } | null = null;
  let moodPlace: string | null | undefined;
  const followMood = (mood: string, changed: boolean) => {
    const b = opts.bgm;
    if (!b || !b.moods.some((m) => m.id === mood)) return;
    const current = view.bgm ? moodOf(view.bgm, b.moods) : null;
    if (current === mood) {
      pendingMood = null;
      return;
    }
    const beats = pendingMood?.mood === mood ? pendingMood.beats + 1 : 1;
    if (!view.bgm || changed || beats >= b.switchBeats) {
      view.bgm = mood;
      pendingMood = null;
    } else {
      pendingMood = { mood, beats };
    }
  };

  for (const ev of path) {
    if (ev.scene) place = ev.scene;
    if (opts.auto && (ev.kind === 'directive' || ev.kind === 'whisper')) {
      const label = ev.kind === 'directive' ? '导演指令' : `对${nameOf(ev.characterId)}的悄悄话`;
      backlog.push({ kind: 'note', step: steps.length, label, text: ev.text ?? '' });
      continue;
    }
    // 观察模式里接管角色说的话、换场景：和 AI 演的拍一样上舞台
    if (opts.auto && ((ev.kind === 'player' && ev.characterId) || ev.kind === 'scene')) {
      const segs: Segment[] =
        ev.kind === 'player' && ev.characterId
          ? [{ kind: 'line', characterId: ev.characterId, name: nameOf(ev.characterId), text: ev.text ?? '' }]
          : [];
      for (const c of stageFromSegments(segs, { characters: opts.characters, before: view, scene: place, ...opts.auto }))
        run(ev, c);
      continue;
    }
    if (ev.kind === 'drift') {
      const text = `${DRIFT_LABELS[ev.drift ?? 'pull']}${ev.drift === 'detour' && ev.text ? `：插进新的一幕「${ev.text}」` : ''}`;
      backlog.push({ kind: 'note', step: steps.length, label: '剧情图', text });
      continue;
    }
    if (ev.kind === 'choice') {
      backlog.push({ kind: 'choice', step: steps.length, label: ev.choice?.label ?? '', rewindTo: ev.parentId });
      if (ev.plot?.vars) vars.push(...ev.plot.vars);
      continue;
    }
    // 剧情 ADV 里玩家的自由输入：和选项一样记进回想，可以回到输入之前
    if (ev.kind === 'player') {
      backlog.push({ kind: 'choice', step: steps.length, label: `「${ev.text ?? ''}」`, rewindTo: ev.parentId });
      continue;
    }
    if (ev.kind === 'check' && ev.check) {
      push(ev, { kind: 'check', check: ev.check });
      backlog.push({ kind: 'check', step: steps.length - 1, check: ev.check });
      continue;
    }
    // 导演报告的情绪：换幕、换地点时马上换曲，否则要持续够拍数
    if (ev.beat?.mood) {
      const moved = moodPlace !== undefined && place.locationId !== moodPlace;
      moodPlace = place.locationId;
      followMood(ev.beat.mood, moved || (!!ev.plot && ev.plot.scene !== scene));
    }
    if (ev.plot && ev.plot.scene !== scene) {
      scene = ev.plot.scene;
      const sc = opts.graph?.scenes.find((s) => s.id === scene);
      if (sc && opts.graph) {
        const ch = sc.chapter && sc.chapter !== chapter ? opts.graph.chapters.find((c) => c.id === sc.chapter) : undefined;
        chapter = sc.chapter ?? chapter;
        const card = { title: sc.title || sc.id, chapter: ch ? ch.title || ch.id : null };
        push(ev, { kind: 'card', card });
        backlog.push({ kind: 'scene', step: steps.length - 1, ...card });
      }
    }
    // 导演安排里的检定和这一拍记在同一个事件上：先出检定结果，再演
    if (ev.check) {
      push(ev, { kind: 'check', check: ev.check });
      backlog.push({ kind: 'check', step: steps.length - 1, check: ev.check });
    }
    if (ev.plot?.vars) vars.push(...ev.plot.vars);
    if (ev.kind === 'ai' && ev.beat?.time) time = ev.beat.time;
    const auto = !ev.stage && opts.auto && ev.segments ? opts.auto : null;
    let stage = ev.stage ?? (auto && ev.segments ? stageFromSegments(ev.segments, { characters: opts.characters, before: view, scene: place, ...auto }) : undefined);
    if (stage && opts.timeOfDay && (ev.kind === 'ai' || !!auto)) stage = withTimeOfDay(stage, opts.timeOfDay.variants);
    if (stage) {
      // 导演标的 CG：放在这一拍中间那句话上，这一拍演完撤下（画好之前界面上不显示，18.6）
      const aiCg = ev.kind === 'ai' ? ev.beat?.cg : undefined;
      const lines = aiCg ? stage.filter(isTextCommand).length : 0;
      let line = 0;
      for (const c of stage) {
        if (aiCg && isTextCommand(c)) {
          if (line === Math.floor(lines / 2)) {
            view.cg = aiCg.id;
            backlog.push({ kind: 'cg', step: steps.length, id: aiCg.id, title: aiCg.title });
          }
          line += 1;
        }
        run(ev, c);
      }
      if (aiCg && view.cg === aiCg.id) view.cg = null;
      // 只放了 CG、后面没有文字：停一下让玩家看到
      if (cgShown) push(ev, { kind: 'pause' });
    } else {
      for (const seg of ev.segments ?? []) push(ev, { kind: 'text', text: segmentText(seg) });
    }
  }
  return { steps, backlog, end: snapshot(view) };
}

/**
 * 存档位置 → 步骤下标。找不到这一步（剧本被改过）时取这个事件里不超过它的最后一步，
 * 这个事件一步都没有时取最后一步。
 */
export function findStep(t: Timeline, at: { eventId: string; index: number } | undefined): number {
  if (!at) return t.steps.length - 1;
  let first = -1;
  let best = -1;
  t.steps.forEach((s, i) => {
    if (s.eventId !== at.eventId) return;
    if (first < 0) first = i;
    if (s.index <= at.index) best = i;
  });
  if (best >= 0) return best;
  return first >= 0 ? first : t.steps.length - 1;
}

/** 一步的文字（存档预览和回想用）。 */
export function stepText(s: StageStep | undefined): string {
  if (!s) return '';
  if (s.text) return s.text.speaker ? `${s.text.speaker.name}：${s.text.text}` : s.text.text;
  if (s.card) return s.card.chapter ? `${s.card.chapter} · ${s.card.title}` : s.card.title;
  if (s.check) return `检定「${s.check.label}」`;
  return '';
}

// ───────────── AI 演出的一拍 → 舞台指令 ─────────────

export interface SegmentsToStageOptions {
  characters: Cast;
  /** 这一拍之前的画面（时间线末尾）。 */
  before: StageView;
  /** 这一拍的地点和在场角色。 */
  scene: { locationId: string | null; presentCharacterIds: readonly string[] };
  /** 主角（玩家）：VN 里一般不给主角立绘，主角说话只出名字牌。 */
  protagonistId: string | null;
  /** 表情表：台词前括号里的第一个词是表情时换上对应的表情差分。不给就不换表情。 */
  expressions?: readonly ExpressionLike[];
  /** 临时人物（世界里没有的路人、守卫……）开口时上台（界面上是剪影，18.5），这一拍不开口就下台。不给就不上台。 */
  extras?: boolean;
}

/** 不是一个具体的人的"说话人"：一群人、画外音一类，不上台。 */
const NOT_A_PERSON = /^(众人|大家|所有人|一群人|人群|众|两人|二人|三人|几人|旁白|画外音|声音|广播|电话|系统|[？?…]+)$/;

/** 临时人物的名字能不能上台、能不能升级成正式角色：一个具体的人，名字不太长。 */
export const isExtraName = (name: string) => {
  const n = name.trim();
  return !!n && [...n].length <= 8 && !NOT_A_PERSON.test(n);
};

/** 同时在台上的立绘最多几个。 */
const MAX_SPRITES = 4;

/**
 * AI 演出的台词和旁白（Segment）转成舞台指令：换地点时换背景（同时清场），在场的角色上场、离场的下场，
 * 开口的角色没在台上就先上场。背景 id 用地点 id，立绘用角色 id（素材以后按 id 找）。
 */
export function stageFromSegments(segments: readonly Segment[], o: SegmentsToStageOptions): StageCommand[] {
  const out: StageCommand[] = [];
  const loc = o.scene.locationId;
  let shown: string[] = o.before.sprites.map((s) => s.characterId ?? s.key);
  const face = new Map(o.before.sprites.map((s) => [s.characterId ?? s.key, s.expr]));
  if (loc && baseBgId(o.before.bg?.id) !== loc) {
    out.push({ op: 'bg', id: loc });
    shown = [];
    face.clear();
  }
  const present = o.scene.presentCharacterIds.filter((id) => id !== o.protagonistId);
  // 这一拍开口的临时人物
  const extras = new Set(
    o.extras ? segments.flatMap((s) => (s.kind === 'line' && !s.characterId && isExtraName(s.name) ? [s.name] : [])) : [],
  );
  const known = (id: string) => o.characters.some((c) => c.id === id);
  // 角色不在场了下台；临时人物这一拍不开口就下台
  const leaves = (id: string) => (known(id) ? !present.includes(id) : !!o.extras && !extras.has(id));
  for (const id of shown) if (leaves(id)) out.push({ op: 'hide', char: id });
  shown = shown.filter((id) => !leaves(id));
  const enter = (id: string, expr?: string) => {
    if (shown.includes(id) || shown.length >= MAX_SPRITES) return;
    out.push({ op: 'show', char: id, ...(expr ? { expr } : {}) });
    shown.push(id);
    face.set(id, expr ?? 'neutral');
  };
  for (const id of present.slice(0, 3)) enter(id);
  for (const s of segments) {
    if (s.kind === 'narration') {
      out.push({ op: 'narrate', text: s.text });
      continue;
    }
    if (!s.characterId && extras.has(s.name)) enter(s.name);
    if (s.characterId && s.characterId !== o.protagonistId) {
      const expr = o.expressions ? expressionOfLine(s.text, o.expressions) : null;
      if (!shown.includes(s.characterId)) enter(s.characterId, expr ?? undefined);
      else if (expr && face.get(s.characterId) !== expr) {
        // 换表情：同一个立绘，只换表情
        out.push({ op: 'show', char: s.characterId, expr });
        face.set(s.characterId, expr);
      }
    }
    out.push({ op: 'say', char: s.characterId ?? s.name, text: s.text });
  }
  return out;
}
