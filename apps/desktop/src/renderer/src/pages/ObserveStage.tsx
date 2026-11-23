/**
 * 观察模式的舞台看法（M3 第 4 步）：把观察模式的故事放到和剧情 ADV 同一个 VN 舞台上自动播放。
 * 事件路径用 buildTimeline 的 auto 选项展开：AI 的拍按地点和在场角色自动排出背景和立绘，进入新的一幕出标题卡，
 * 导演安排里的检定单独一步，导演指令和悄悄话只进回想。
 *
 * 播到哪里由父组件的 shown（第几个事件正在播）记着，两种看法共用：舞台每往后走到一个新事件就 onRead 报给父组件，
 * 父组件因为别的操作（跳到最新、回退、重抽、接管）改了 shown，舞台就跳到那个事件的第一步。
 * 已经看到最新时停在最后一句上（打开周目、回到舞台看法时能看到画面），暂停或出错的提示盖在舞台上方。
 */
import type { PathEvent, WorldDetail } from '@auto-adv/engine/api';
import { foldPlot } from '@auto-adv/engine/progress';
import { buildTimeline, type StageView } from '@auto-adv/engine/stage';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import {
  Backlog,
  CueTags,
  Overlay,
  StageCard,
  StageCheck,
  StageLayers,
  StageTextBox,
  textLength,
  ToolButton,
  useShake,
  useTyping,
} from '../components/stage.tsx';
import { Spinner } from '../components/ui.tsx';

/** 1 倍速下的节奏（和文本看法一致）：打字速度（字/秒）、每句读完后的停顿（基础 + 每字），换一拍时多停一会儿。 */
const CPS = 30;
const HOLD_BASE = 500;
const HOLD_PER_CHAR = 70;
const GAP = 600;

export function ObserveStage({
  world,
  path,
  shown,
  onRead,
  playing,
  speed,
  colorOf,
  phaseText,
  waiting,
  onShowText,
}: {
  world: WorldDetail;
  path: PathEvent[];
  /** 第几个事件正在播（之前的都看完了）；等于 path.length 表示已经看到最新。 */
  shown: number;
  /** 舞台走到了第 k 个事件（k = path.length 表示看完了全部）。 */
  onRead: (k: number) => void;
  /** 自动往下播。暂停时也可以点舞台自己往下看。 */
  playing: boolean;
  /** 倍速；0 表示即时（不打字、不停顿）。 */
  speed: number;
  colorOf: (id: string | null, name: string) => string | undefined;
  /** 正在生成下一拍时的进度文字。 */
  phaseText: string | null;
  /** 看到最新、又没有在生成时盖在舞台上的内容（已暂停、限速、出错）。 */
  waiting: ReactNode;
  onShowText: () => void;
}) {
  const tint = (id: string | null, name: string) => colorOf(id, name) ?? '#a194ff';
  // 剧情图加上这个周目续写出来的幕：新的一幕出标题卡
  const graph = useMemo(() => (world.graph ? foldPlot(world.graph, world.variables, path).graph : null), [world, path]);
  const timeline = useMemo(
    () => buildTimeline(path, { characters: world.characters, graph, auto: { protagonistId: null } }),
    [path, world.characters, graph],
  );
  const steps = timeline.steps;
  const eventIndex = useMemo(() => new Map(path.map((e, i) => [e.id, i])), [path]);
  /** 第 k 个事件（或之后）的第一步；后面没有新的步骤了就停在最后一步上。 */
  const stepOf = (k: number) => {
    const i = steps.findIndex((s) => (eventIndex.get(s.eventId) ?? -1) >= k);
    return i < 0 ? Math.max(0, steps.length - 1) : i;
  };

  const [cursor, setCursor] = useState(() => stepOf(shown));
  const [panel, setPanel] = useState<'backlog' | null>(null);
  const [hidden, setHidden] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const reported = useRef(shown);

  // 父组件改了播放位置（跳到最新、回退、重抽、接管）：跳过去
  useEffect(() => {
    if (shown === reported.current) return;
    reported.current = shown;
    setCursor(stepOf(shown));
  }, [shown]);

  // 往后走到新的事件上：报给父组件（之前的事件算看完了）。舞台自己只会往后走，往回跳都是父组件让的
  const waitingForMore = cursor >= steps.length;
  useEffect(() => {
    const k = waitingForMore ? path.length : (eventIndex.get(steps[cursor]?.eventId ?? '') ?? path.length);
    if (k <= reported.current) return;
    reported.current = k;
    onRead(k);
  }, [cursor, steps.length, path.length]);
  const atLast = cursor >= steps.length - 1;

  // 看到最新时停在最后一步上（文字已经打完），新内容来了接着播
  const shownIdx = Math.min(cursor, steps.length - 1);
  const step = steps[shownIdx];
  const stepKey = step ? `${shownIdx}:${step.eventId}:${step.index}` : 'none';
  const textLen = textLength(step);
  const { shown: typedChars, typed, complete } = useTyping(stepKey, textLen, CPS * speed, speed === 0);
  const stage: StageView = step?.view ?? timeline.end;
  useShake(stageRef, step, stepKey);

  const advance = () => {
    if (panel) return;
    if (!typed) return complete();
    if (cursor < steps.length) setCursor(cursor + 1);
  };

  // 自动播放
  useEffect(() => {
    if (!playing || panel || hidden || waitingForMore || !typed || !step) return;
    const next = steps[cursor + 1];
    const gap = next && next.eventId !== step.eventId ? GAP : 0;
    const base =
      step.kind === 'text'
        ? HOLD_BASE + textLen * HOLD_PER_CHAR
        : step.kind === 'card'
          ? 1800
          : step.kind === 'check'
            ? 2200
            : step.kind === 'wait'
              ? (step.seconds ?? 1) * 1000
              : 1500;
    const t = setTimeout(() => setCursor((c) => c + 1), speed === 0 ? 0 : (base + gap) / speed);
    return () => clearTimeout(t);
  }, [playing, panel, hidden, waitingForMore, typed, stepKey, cursor, speed]);

  // 键盘：空格 / 回车往下看，PageUp 回想，H 隐藏文本框，Esc 关闭
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'Escape') {
        if (panel) setPanel(null);
        else setHidden(false);
        return;
      }
      if (panel) return;
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        if (hidden) setHidden(false);
        else advance();
      } else if (e.key === 'PageUp') setPanel('backlog');
      else if (e.key === 'h' || e.key === 'H') setHidden((h) => !h);
    };
    window.addEventListener('keydown', down);
    return () => window.removeEventListener('keydown', down);
  });

  const sceneTitle = (() => {
    const sc = step?.scene ? graph?.scenes.find((x) => x.id === step.scene) : undefined;
    if (!sc) return null;
    const ch = sc.chapter ? graph?.chapters.find((c) => c.id === sc.chapter) : undefined;
    return `${ch ? `${ch.title || ch.id} · ` : ''}${sc.title || sc.id}`;
  })();
  const place = world.locations.find((l) => l.id === stage.bg?.id)?.name;
  const varLabel = (id: string) => world.variables.find((v) => v.id === id)?.label || id;
  const textVisible = !hidden && step?.kind === 'text';

  const toolbar = (
    <div className="flex items-center gap-[0.2em]" onClick={(e) => e.stopPropagation()}>
      <ToolButton testId="observe-backlog" onClick={() => setPanel('backlog')}>
        回想
      </ToolButton>
      <ToolButton testId="observe-hide" onClick={() => setHidden(true)}>
        隐藏
      </ToolButton>
      <ToolButton testId="observe-to-text" onClick={onShowText}>
        文本
      </ToolButton>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-black" style={{ containerType: 'size' }}>
      <div
        ref={stageRef}
        data-testid="observe-stage"
        data-step={cursor}
        data-kind={waitingForMore ? 'waiting' : (step?.kind ?? 'none')}
        className="relative cursor-default overflow-hidden bg-black text-white select-none"
        style={{ width: 'min(100cqw, calc(100cqh * 16 / 9))', aspectRatio: '16 / 9', containerType: 'inline-size' }}
        onClick={() => (hidden ? setHidden(false) : advance())}
        onContextMenu={(e) => {
          e.preventDefault();
          setHidden((h) => !h);
        }}
        onWheel={(e) => {
          if (e.deltaY < 0 && !panel) setPanel('backlog');
        }}
      >
        <StageLayers p="observe" stage={stage} step={step} stepKey={stepKey} tint={tint} />

        {!hidden && (
          <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-4 p-[1.4%] text-[max(11px,0.95cqw)]">
            <div className="flex flex-col items-start gap-[0.4em]">
              {sceneTitle && (
                <span className="rounded bg-black/40 px-[0.7em] py-[0.25em] text-white/75" data-testid="observe-scene-tag">
                  {sceneTitle}
                </span>
              )}
              {place && <span className="rounded bg-black/30 px-[0.7em] py-[0.15em] text-white/55">{place}</span>}
              <CueTags step={step} stepKey={stepKey} />
            </div>
          </div>
        )}

        <StageCard p="observe" step={waitingForMore ? undefined : step} stepKey={stepKey} />
        <StageCheck p="observe" step={waitingForMore ? undefined : step} stepKey={stepKey} varLabel={varLabel} />

        {atLast && !phaseText && waiting && !hidden && !panel && (
          <div className="absolute inset-x-0 top-[22%] flex justify-center" onClick={(e) => e.stopPropagation()}>
            <div className="w-[62%] text-fg">{waiting}</div>
          </div>
        )}

        {!hidden && (waitingForMore || step?.kind !== 'card') && (
          <StageTextBox
            p="observe"
            text={textVisible ? (step?.text ?? null) : null}
            shown={typedChars}
            typed={typed}
            tint={tint}
            extra={!step && <span className="text-white/50">{phaseText ?? '（还没有内容）'}</span>}
            status={
              <>
                {waitingForMore && phaseText && (
                  <>
                    <Spinner className="size-3" />
                    <span data-testid="observe-phase">{phaseText}</span>
                  </>
                )}
                {!waitingForMore && typed && <span className="stage-blink text-white/70">▼</span>}
              </>
            }
            toolbar={toolbar}
          />
        )}

        {panel === 'backlog' && (
          <Overlay p="observe" title="回想" onClose={() => setPanel(null)} testId="observe-backlog-panel">
            <Backlog p="observe" timeline={timeline} cursor={shownIdx} colorOf={colorOf} busy={false} />
          </Overlay>
        )}
      </div>
    </div>
  );
}
