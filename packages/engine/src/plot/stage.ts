/**
 * VN 舞台的播放时间线（M3 第 2 步）：把路径上的事件展开成一步一步的画面。
 * 一步 = 玩家点一下看到的东西：一句台词或旁白、一次停顿、一次检定、进入新一幕的标题卡。
 * 每一步都带着当时完整的画面（背景、立绘、CG、音乐），所以回想、存档定位、快进都只需要一个下标。
 * 纯函数，界面和引擎共用（界面从 @auto-adv/engine/stage 引入，不会把引擎其余部分打包进去）。
 */
import type { PlotGraph, StageCommand } from '@auto-adv/schema';
import type { CheckResult, PlayEvent, Segment, VarChange } from '../api.ts';
import { matchByName } from '../world/render.ts';

type Cast = readonly { id: string; name: string; aliases?: string[] }[];

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
  | { kind: 'scene'; step: number; title: string; chapter: string | null };

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
    if (ev.kind === 'choice') {
      backlog.push({ kind: 'choice', step: steps.length, label: ev.choice?.label ?? '', rewindTo: ev.parentId });
      if (ev.plot?.vars) vars.push(...ev.plot.vars);
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
    if (ev.plot?.vars) vars.push(...ev.plot.vars);
    if (ev.stage) {
      for (const c of ev.stage) run(ev, c);
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
