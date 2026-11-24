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
  auto?: { protagonistId: string | null };
}

const emptyView = (): StageView => ({ bg: null, sprites: [], cg: null, bgm: null });
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
      for (const c of stageFromSegments(segs, { characters: opts.characters, before: view, scene: place, protagonistId: opts.auto.protagonistId }))
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
    const stage =
      ev.stage ??
      (opts.auto && ev.segments
        ? stageFromSegments(ev.segments, { characters: opts.characters, before: view, scene: place, protagonistId: opts.auto.protagonistId })
        : undefined);
    if (stage) {
      for (const c of stage) run(ev, c);
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
}

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
  if (loc && o.before.bg?.id !== loc) {
    out.push({ op: 'bg', id: loc });
    shown = [];
  }
  const present = o.scene.presentCharacterIds.filter((id) => id !== o.protagonistId);
  for (const id of shown) {
    if (!present.includes(id) && o.characters.some((c) => c.id === id)) out.push({ op: 'hide', char: id });
  }
  shown = shown.filter((id) => present.includes(id) || !o.characters.some((c) => c.id === id));
  const enter = (id: string) => {
    if (shown.includes(id) || shown.length >= MAX_SPRITES) return;
    out.push({ op: 'show', char: id });
    shown.push(id);
  };
  for (const id of present.slice(0, 3)) enter(id);
  for (const s of segments) {
    if (s.kind === 'narration') {
      out.push({ op: 'narrate', text: s.text });
      continue;
    }
    if (s.characterId && s.characterId !== o.protagonistId) enter(s.characterId);
    out.push({ op: 'say', char: s.characterId ?? s.name, text: s.text });
  }
  return out;
}
