/**
 * 剧情 ADV 的 VN 舞台（M3 第 2、3 步）：背景、立绘站位、文本框、回想、自动播放、快进、存读档。
 * 素材还没有生成（M4），背景、立绘、CG 都用占位图。
 *
 * 舞台本身不保存状态：引擎给出事件路径，plot/stage.ts 把它展开成一步一步的画面，这里只记"播到第几步"。
 * 播到最后一步时再找引擎要下一拍：手写剧本不调模型，立刻返回；没有剧本的幕由 AI 演出（流式返回进度），
 * 这时除了选项还可以直接输入想做的事。
 */
import type { DriftChoice, PlayChunk, PlayView, SaveInfo, WorldDetail } from '@auto-adv/engine/api';
import { foldPlot } from '@auto-adv/engine/progress';
import { buildTimeline, findStep, type StageStep, type StageView, type Timeline } from '@auto-adv/engine/stage';
import { useEffect, useMemo, useRef, useState } from 'react';
import { PlaceholderCg } from '../components/placeholder.tsx';
import { BgmTag, useStageBgm } from '../components/bgm.tsx';
import { BgImage, useBgmRules } from '../lib/assets.tsx';
import {
  AssetProgress,
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
import { useColorOf } from '../components/story.tsx';
import { Button, ConfirmButton, cx, Input, Select, Spinner, useToast } from '../components/ui.tsx';
import { engine, errorMessage, isAborted } from '../lib/engine.ts';
import { formatTime } from '../lib/format.ts';
import { useRouter } from '../lib/router.tsx';

const ENDING_KIND = { good: '好结局', normal: '普通结局', bad: '坏结局' } as const;
const PHASE_TEXT: Record<string, string> = {
  thinking: '导演正在安排这一拍…',
  writing: '演员们正在演出…',
  memory: '书记正在整理前情提要…',
  detour: '导演正在把这一段写成新的一幕…',
};

/** 跑偏时的四个选择（16.6）。 */
const DRIFT_OPTIONS: { choice: DriftChoice; label: string; hint: string }[] = [
  { choice: 'pull', label: '拉回来', hint: '下一拍用故事里发生的事，把场面带回这一幕' },
  { choice: 'detour', label: '就这样走', hint: '把这一段写成新的一幕，演完再接回主线' },
  { choice: 'pause', label: '暂停剧情图', hint: '之后跟着你的行动自由推进，随时可以恢复' },
  { choice: 'ignore', label: '不用管', hint: '这一幕里不再提醒' },
];

const SPEED_KEY = 'auto-adv:adv-text-speed';
const AUTO_KEY = 'auto-adv:adv-auto-delay';
const posKey = (pt: string) => `auto-adv:adv-pos:${pt}`;
const TEXT_SPEEDS = [
  { value: 20, label: '慢' },
  { value: 45, label: '中' },
  { value: 90, label: '快' },
  { value: 0, label: '瞬间' },
];
const AUTO_DELAYS = [
  { value: 0.6, label: '短' },
  { value: 1.2, label: '中' },
  { value: 2.4, label: '长' },
];

/** localStorage 可能不可用（隐私模式等），读写都包一层。 */
function readStore<T>(key: string, ok: (v: unknown) => v is T, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const v: unknown = JSON.parse(raw);
    return ok(v) ? v : fallback;
  } catch {
    return fallback;
  }
}
function writeStore(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // 忽略：只是记住偏好
  }
}
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPos = (v: unknown): v is { eventId: string; index: number } =>
  typeof v === 'object' && v !== null && typeof (v as { eventId?: unknown }).eventId === 'string' && isNum((v as { index?: unknown }).index);

/** 打开周目时从哪一步开始：上次看到的地方；没有记录就从最后一个事件的第一步开始。 */
function initialCursor(t: Timeline, pt: string): number {
  const saved = readStore(posKey(pt), isPos, null);
  if (saved && t.steps.some((s) => s.eventId === saved.eventId)) return findStep(t, saved);
  const last = t.steps.at(-1)?.eventId;
  return t.steps.findIndex((s) => s.eventId === last);
}

type Mode = 'normal' | 'auto' | 'skip';
type Panel = 'backlog' | 'save' | 'load' | 'settings' | 'ending' | null;

export function AdvPage({ world, initial, onBack }: { world: WorldDetail; initial: PlayView; onBack: () => void }) {
  const toast = useToast();
  const { navigate } = useRouter();
  const colorOf = useColorOf(world);
  const tint = (id: string | null, name: string) => colorOf(id, name) ?? '#a194ff';
  const ref = { worldId: initial.playthrough.worldId, playthroughId: initial.playthrough.id };
  // 导演每一拍报告的情绪：舞台按它换 BGM（18.7）
  const bgmRules = useBgmRules();
  /** 时间线用这个周目的剧情图（含跑偏时插进来的幕）出标题卡。 */
  const timelineOf = (path: PlayView['path']) =>
    buildTimeline(path, {
      characters: world.characters,
      graph: world.graph ? foldPlot(world.graph, world.variables, path).graph : null,
      ...(bgmRules ? { bgm: bgmRules } : {}),
    });

  const [view, setView] = useState(initial);
  const timeline = useMemo(() => timelineOf(view.path), [view.path, world, bgmRules]);
  const graph = useMemo(() => (world.graph ? foldPlot(world.graph, world.variables, view.path).graph : null), [view.path, world]);
  const [cursor, setCursor] = useState(() => initialCursor(timelineOf(initial.path), initial.playthrough.id));
  const [mode, setMode] = useState<Mode>('normal');
  const [ctrl, setCtrl] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  /** AI 演出时的进度（导演 / 演出 / 整理前情提要）。 */
  const [phase, setPhase] = useState<string | null>(null);
  const [action, setAction] = useState('');
  const controller = useRef<AbortController | null>(null);
  const [speed, setSpeed] = useState(() => readStore(SPEED_KEY, isNum, 45));
  const [autoDelay, setAutoDelay] = useState(() => readStore(AUTO_KEY, isNum, 1.2));
  const stageRef = useRef<HTMLDivElement>(null);
  const reported = useRef(new Set<string>());

  const steps = timeline.steps;
  const step: StageStep | undefined = steps[cursor];
  const stepKey = step ? `${cursor}:${step.eventId}:${step.index}` : `${cursor}`;
  const textLen = textLength(step);
  const adv = view.adv;
  const atEnd = cursor >= steps.length - 1;
  const skipping = mode === 'skip' || ctrl;
  // 打字机效果
  const typing = useTyping(stepKey, textLen, speed, skipping);
  const { shown, typed } = typing;
  /** 跑偏了（16.6）：先问玩家怎么处理，回答之前不弹选项。 */
  const driftOpen = !!adv?.drift.ask && atEnd && typed && !busy;
  const menuOpen = !!adv?.menu && !adv.drift.ask && atEnd && typed && !busy;
  const stage: StageView = step?.view ?? timeline.end;
  const bgm = useStageBgm(stage.bgm);

  // 记住看到哪里了（下次打开周目从这里继续）
  useEffect(() => {
    if (step) writeStore(posKey(ref.playthroughId), { eventId: step.eventId, index: step.index });
  }, [stepKey]);

  // CG 第一次显示时记跨周目解锁
  useEffect(() => {
    const cg = step?.cgShown;
    if (!step || !cg) return;
    const k = `${step.eventId}|${cg}`;
    if (reported.current.has(k)) return;
    reported.current.add(k);
    engine
      .call('advShown', { ...ref, eventId: step.eventId, cg })
      .then(async (r) => {
        if (!r.unlocked) return;
        toast('ok', `解锁了一张 CG：${cg}`);
        setView(await engine.call('getPlaythrough', ref));
      })
      .catch(() => {});
  }, [stepKey]);

  // 特效：震动
  useShake(stageRef, step, stepKey);

  /** 换一个新的 PlayView，place 算出舞台停在哪一步。 */
  const call = async (fn: (signal: AbortSignal) => Promise<PlayView>, place: (t: Timeline) => number): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    const ac = new AbortController();
    controller.current = ac;
    try {
      const v = await fn(ac.signal);
      const t = timelineOf(v.path);
      setView(v);
      setCursor(place(t));
      return true;
    } catch (err) {
      if (!isAborted(err)) toast('err', errorMessage(err));
      setMode('normal');
      return false;
    } finally {
      if (controller.current === ac) controller.current = null;
      setBusy(false);
      setPhase(null);
    }
  };
  const onChunk = (c: PlayChunk) => {
    if (c.type === 'phase') setPhase(c.phase);
  };
  /** 往下演、选选项、自由输入、跑偏时的选择：AI 演出的幕会流式返回进度。新内容从第一条新步骤开始播。 */
  const act = (
    method: 'advNext' | 'advChoose' | 'advInput' | 'advDrift',
    extra: { index?: number; text?: string; choice?: DriftChoice } = {},
  ) => {
    const len = steps.length;
    const place = (t: Timeline) => Math.min(len, t.steps.length - 1);
    if (method === 'advDrift') {
      return call((sig) => engine.stream('advDrift', { ...ref, choice: extra.choice ?? 'pull' }, onChunk, sig), place);
    }
    if (method === 'advChoose') return call((sig) => engine.stream('advChoose', { ...ref, index: extra.index ?? 0 }, onChunk, sig), place);
    if (method === 'advInput') return call((sig) => engine.stream('advInput', { ...ref, text: extra.text ?? '' }, onChunk, sig), place);
    return call((sig) => engine.stream('advNext', ref, onChunk, sig), place);
  };

  const complete = typing.complete;

  const advance = () => {
    if (busy || panel) return;
    if (!typed) return complete();
    if (cursor < steps.length - 1) return setCursor(cursor + 1);
    if (!adv || adv.menu || adv.drift.ask) return;
    if (adv.finished) {
      setMode('normal');
      setPanel('ending');
      return;
    }
    if (adv.error || adv.stuck) {
      setMode('normal');
      return;
    }
    void act('advNext');
  };

  // 开场是空的（世界没有开场、第一幕由 AI 演出）：直接要第一拍
  const kicked = useRef(false);
  useEffect(() => {
    if (kicked.current || steps.length || !adv || adv.menu || adv.finished || adv.error) return;
    kicked.current = true;
    advance();
  }, [steps.length]);

  // 选项刚弹出来的一小会儿不接受点击：连点推进剧情时不会误选
  const menuAt = useRef(0);
  useEffect(() => {
    if (menuOpen) menuAt.current = Date.now();
  }, [menuOpen]);

  const choose = (index: number) => {
    if (!menuOpen || Date.now() - menuAt.current < 400) return;
    void act('advChoose', { index });
  };

  /** 跑偏时的选择。"就这样走"会插进新的一幕，下一拍在新的一幕里演。 */
  const answerDrift = async (choice: DriftChoice) => {
    if (busy) return;
    const ok = await act('advDrift', { choice });
    if (!ok || choice !== 'detour') return;
    const v = await engine.call('getPlaythrough', ref);
    if (v.adv?.scene) toast('ok', `插进了新的一幕「${v.adv.scene.title}」，演完再接回主线`);
  };

  /** AI 演出的幕里可以不选选项，直接输入想做的事。 */
  const inputOpen =
    !!adv?.aiScene && !adv.needsModel && !adv.finished && !adv.error && !adv.drift.ask && atEnd && typed && !busy;
  const submitAction = () => {
    const text = action.trim();
    if (!text || !inputOpen) return;
    void act('advInput', { text }).then((ok) => ok && setAction(''));
  };

  /**
   * 重抽 AI 演的最后一拍：舞台停在这一拍上时可以重抽，原来的一拍留作分支。
   * 玩家的选择和检定不变，从新的一拍的第一步开始播。
   */
  const last = view.path.at(-1);
  const canRegenerate = last?.kind === 'ai' && !!last.plot && !adv?.needsModel && !busy && (step?.eventId === last.id || atEnd);
  const regenerate = async () => {
    if (!canRegenerate) return;
    setMode('normal');
    const place = (t: Timeline) => {
      const id = t.steps.at(-1)?.eventId;
      const i = t.steps.findIndex((s) => s.eventId === id);
      return i >= 0 ? i : t.steps.length - 1;
    };
    await call((sig) => engine.stream('advRegenerate', ref, onChunk, sig), place);
  };

  /** 回到某个选项之前重新选（之后的内容保留为分支）。 */
  const rewindTo = async (eventId: string) => {
    if (await call(() => engine.call('rewind', { ...ref, eventId }), (t) => t.steps.length - 1)) {
      setMode('normal');
      setPanel(null);
    }
  };

  // 自动播放、快进、停顿、标题卡
  useEffect(() => {
    if (panel || busy || hidden) return;
    if (atEnd && typed && (adv?.menu || adv?.error || adv?.stuck || adv?.drift.ask)) {
      if (mode === 'skip') setMode('normal'); // 快进到选项就停下
      return;
    }
    let delay: number | null = null;
    if (step?.kind === 'card') delay = skipping ? 60 : 1800;
    else if (step?.kind === 'wait') delay = skipping ? 0 : (step.seconds ?? 1) * 1000;
    else if (skipping) delay = 40;
    else if (mode === 'auto' && typed) delay = step?.kind === 'text' ? autoDelay * 1000 + textLen * 45 : 1500;
    if (delay === null) return;
    const t = setTimeout(advance, delay);
    return () => clearTimeout(t);
  });

  // 键盘：空格 / 回车继续，按住 Ctrl 快进，A 自动，H 隐藏文本框，PageUp 回想，数字键选选项
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'Control') return setCtrl(true);
      if (e.key === 'Escape') {
        if (panel) setPanel(null);
        else setHidden(false);
        return;
      }
      if (panel) return;
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        if (hidden) setHidden(false);
        else if (!menuOpen && !driftOpen) advance();
      } else if (e.key === 'PageUp') setPanel('backlog');
      else if (e.key === 'a' || e.key === 'A') setMode((m) => (m === 'auto' ? 'normal' : 'auto'));
      else if (e.key === 'h' || e.key === 'H') setHidden((h) => !h);
      else if (menuOpen && /^[1-9]$/.test(e.key)) {
        const i = Number(e.key) - 1;
        if (adv?.menu?.options[i]?.enabled) choose(i);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Control') setCtrl(false);
    };
    const blur = () => setCtrl(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  });

  // 顶部显示的是舞台播到的这一步的幕和数值，不是引擎已经算到的地方（选完之后的一拍是一起算出来的，不能提前剧透）
  const sceneNow = useMemo(() => {
    const sc = step?.scene ? graph?.scenes.find((x) => x.id === step.scene) : undefined;
    if (!sc) return adv?.scene ?? null;
    const ch = sc.chapter ? graph?.chapters.find((c) => c.id === sc.chapter) : undefined;
    return { id: sc.id, title: sc.title || sc.id, chapter: ch ? ch.title || ch.id : null };
  }, [step?.scene, adv?.scene, graph]);
  const varsNow = useMemo(() => {
    const v: Record<string, unknown> = { ...adv?.vars };
    for (let i = steps.length - 1; i > cursor; i--) {
      for (const c of [...(steps[i]?.vars ?? [])].reverse()) v[c.var] = c.from;
    }
    return v;
  }, [adv?.vars, steps, cursor]);
  const visibleVars = world.variables.filter((v) => v.visible && v.id in varsNow);
  const varLabel = (id: string) => world.variables.find((v) => v.id === id)?.label || id;
  const varShown = (id: string) => world.variables.find((v) => v.id === id)?.visible ?? false;
  const lastChoice = timeline.backlog.findLast((b) => b.kind === 'choice' && b.step <= cursor + 1);
  const textVisible = !hidden && step?.kind === 'text';

  const actionForm = (
    <form
      className="flex w-[52%] gap-[0.6cqw]"
      data-testid="adv-input"
      onClick={(e) => e.stopPropagation()}
      onSubmit={(e) => {
        e.preventDefault();
        submitAction();
      }}
    >
      <input
        value={action}
        onChange={(e) => setAction(e.target.value)}
        maxLength={200}
        placeholder={menuOpen ? '或者，直接写下你想做的事…' : '写下你想做的事，或者点击画面继续…'}
        className="min-w-0 flex-1 rounded-[0.6cqw] border border-white/15 bg-[#10121a]/85 px-[1.2cqw] py-[0.6cqw] text-[max(12px,1.25cqw)] text-white placeholder:text-white/35 focus:border-accent focus:outline-none"
      />
      <button
        type="submit"
        disabled={!action.trim()}
        className="rounded-[0.6cqw] border border-white/15 bg-[#2a2550]/90 px-[1.4cqw] text-[max(12px,1.25cqw)] disabled:opacity-40"
      >
        行动
      </button>
    </form>
  );

  const toolbar = (
    <div className="flex items-center gap-[0.2em]" onClick={(e) => e.stopPropagation()}>
      <ToolButton testId="adv-backlog" onClick={() => setPanel('backlog')}>
        回想
      </ToolButton>
      <ToolButton testId="adv-auto" active={mode === 'auto'} onClick={() => setMode(mode === 'auto' ? 'normal' : 'auto')}>
        自动
      </ToolButton>
      <ToolButton testId="adv-skip" active={skipping} onClick={() => setMode(mode === 'skip' ? 'normal' : 'skip')}>
        快进
      </ToolButton>
      {canRegenerate && (
        <ToolButton testId="adv-regenerate" onClick={() => void regenerate()}>
          重抽
        </ToolButton>
      )}
      <ToolButton testId="adv-save" onClick={() => setPanel('save')}>
        存档
      </ToolButton>
      <ToolButton testId="adv-load" onClick={() => setPanel('load')}>
        读档
      </ToolButton>
      <ToolButton testId="adv-settings" onClick={() => setPanel('settings')}>
        设置
      </ToolButton>
      <ToolButton testId="adv-hide" onClick={() => setHidden(true)}>
        隐藏
      </ToolButton>
      <ToolButton testId="adv-exit" onClick={onBack}>
        退出
      </ToolButton>
    </div>
  );

  return (
    <div className="flex h-full items-center justify-center bg-black" style={{ containerType: 'size' }}>
      <div
        ref={stageRef}
        data-testid="adv-stage"
        data-step={cursor}
        data-kind={step?.kind ?? 'none'}
        data-busy={busy ? '1' : '0'}
        className="relative cursor-default overflow-hidden bg-black text-white select-none"
        style={{ width: 'min(100cqw, calc(100cqh * 16 / 9))', aspectRatio: '16 / 9', containerType: 'inline-size' }}
        onClick={() => (hidden ? setHidden(false) : menuOpen || driftOpen || (inputOpen && action.trim()) ? undefined : advance())}
        onContextMenu={(e) => {
          e.preventDefault();
          setHidden((h) => !h);
        }}
        onWheel={(e) => {
          if (e.deltaY < 0 && !panel) setPanel('backlog');
        }}
      >
        <StageLayers p="adv" stage={stage} step={step} stepKey={stepKey} tint={tint} dimAll={menuOpen || driftOpen} />

        {/* 顶部：所在的幕、音乐、数值 */}
        {!hidden && (
          <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-4 p-[1.4%] text-[max(11px,0.95cqw)]">
            <div className="flex flex-col items-start gap-[0.4em]">
              {sceneNow && (
                <span className="rounded bg-black/40 px-[0.7em] py-[0.25em] text-white/75" data-testid="adv-scene">
                  {sceneNow.chapter ? `${sceneNow.chapter} · ` : ''}
                  {sceneNow.title}
                </span>
              )}
              <AssetProgress p="adv" />
              {adv?.drift.paused && (
                <span className="pointer-events-auto flex items-center gap-[0.6em] rounded bg-warn/20 px-[0.7em] py-[0.25em] text-warn" data-testid="adv-paused">
                  剧情图已暂停，按你的行动自由推进
                  <button
                    type="button"
                    data-testid="adv-resume"
                    disabled={busy}
                    className="rounded border border-warn/40 px-[0.5em] hover:bg-warn/20 disabled:opacity-40"
                    onClick={(e) => {
                      e.stopPropagation();
                      void answerDrift('resume');
                    }}
                  >
                    恢复剧情图
                  </button>
                </span>
              )}
              {stage.bg && <span className="rounded bg-black/30 px-[0.7em] py-[0.15em] font-mono text-[0.85em] text-white/45">背景 · {stage.bg.id}</span>}
              <CueTags step={step} stepKey={stepKey} />
            </div>
            <div className="flex flex-col items-end gap-[0.4em]">
              <div className="flex flex-wrap justify-end gap-[0.4em]">
                <BgmTag bgm={bgm} className="pointer-events-auto rounded bg-black/40 px-[0.7em] py-[0.25em] text-white/60 hover:text-white/85" />
                {visibleVars.map((v) => (
                  <span key={v.id} className="rounded bg-black/40 px-[0.7em] py-[0.25em] text-white/80" data-testid="adv-var">
                    {v.label || v.id} {formatValue(varsNow[v.id])}
                  </span>
                ))}
              </div>
              {step?.vars
                ?.filter((c) => varShown(c.var))
                .map((c) => (
                  <span
                    key={`${stepKey}${c.var}`}
                    className="stage-float rounded bg-accent/80 px-[0.8em] py-[0.25em] font-medium text-white"
                  >
                    {varLabel(c.var)} {delta(c.from, c.to)}
                  </span>
                ))}
            </div>
          </div>
        )}

        {/* 进入新的一幕：标题卡；检定 */}
        <StageCard p="adv" step={step} stepKey={stepKey} />
        <StageCheck p="adv" step={step} stepKey={stepKey} varLabel={varLabel} />

        {/* 选项 */}
        {menuOpen && adv?.menu && !hidden && (
          // 容器不接点击：顶部的"恢复剧情图"按钮不会被盖住
          <div
            className="pointer-events-none absolute inset-x-0 top-0 bottom-[30%] flex flex-col items-center justify-center gap-[0.9cqw] [&>*]:pointer-events-auto"
            data-testid="adv-menu"
          >
            {adv.menu.source === 'exits' && <div className="text-[max(12px,1.2cqw)] text-white/70">接下来去哪里？</div>}
            {adv.menu.options.map((o, i) => (
              <button
                key={`${o.label}${i}`}
                type="button"
                data-testid={`adv-option-${i}`}
                disabled={!o.enabled || busy}
                onClick={(e) => {
                  e.stopPropagation();
                  choose(i);
                }}
                className={cx(
                  'w-[52%] rounded-[0.6cqw] border px-[1.6cqw] py-[0.8cqw] text-[max(13px,1.45cqw)] transition-colors',
                  o.enabled
                    ? 'border-white/20 bg-[#10121a]/90 backdrop-blur-sm hover:border-accent hover:bg-[#2a2550]/95'
                    : 'cursor-not-allowed border-white/10 bg-[#10121a]/75 text-white/40 backdrop-blur-sm',
                )}
              >
                <span>{o.label}</span>
                {o.check && (
                  <span className="ml-[0.8em] text-[0.75em] text-warn/90">
                    🎲 {o.check.var ? `${varLabel(o.check.var)} · ` : ''}难度 {o.check.dc}
                  </span>
                )}
                {!o.enabled && o.lockedBy && <span className="mt-[0.2em] block text-[0.7em] text-white/35">🔒 需要：{o.lockedBy}</span>}
              </button>
            ))}
            {inputOpen && actionForm}
          </div>
        )}
        {/* 跑偏：问玩家怎么处理 */}
        {driftOpen && !hidden && (
          <div
            className="pointer-events-none absolute inset-x-0 top-0 bottom-[30%] flex flex-col items-center justify-center gap-[0.8cqw] [&>*]:pointer-events-auto"
            data-testid="adv-drift"
          >
            <div className="text-center">
              <div className="text-[max(13px,1.4cqw)] text-white/90">
                这几拍离开了「{sceneNow?.title ?? adv?.scene?.title ?? '这一幕'}」要讲的事
              </div>
              <div className="mt-[0.3em] text-[max(11px,1.05cqw)] text-white/55">要怎么办？</div>
            </div>
            <div className="grid w-[60%] grid-cols-2 gap-[0.8cqw]">
              {DRIFT_OPTIONS.map((o) => {
                const disabled = busy || (o.choice === 'detour' && !adv?.drift.detour);
                return (
                  <button
                    key={o.choice}
                    type="button"
                    data-testid={`adv-drift-${o.choice}`}
                    disabled={disabled}
                    onClick={() => void answerDrift(o.choice)}
                    className="rounded-[0.6cqw] border border-white/20 bg-[#10121a]/90 px-[1.4cqw] py-[0.8cqw] text-left backdrop-blur-sm transition-colors hover:border-accent hover:bg-[#2a2550]/95 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <div className="text-[max(13px,1.35cqw)]">{o.label}</div>
                    <div className="mt-[0.2em] text-[max(10px,0.95cqw)] text-white/50">{o.hint}</div>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {inputOpen && !menuOpen && !hidden && (
          <div className="absolute inset-x-0 bottom-[32%] flex justify-center" data-testid="adv-actions">
            {actionForm}
          </div>
        )}

        {/* 文本框 */}
        {!hidden && step?.kind !== 'card' && (
          <StageTextBox
            p="adv"
            text={textVisible ? (step?.text ?? null) : null}
            shown={shown}
            typed={typed}
            tint={tint}
            extra={
              <>
                {!step && !adv?.menu && <span className="text-white/50">（还没有内容）</span>}
                {!step && busy && <span className="text-white/50">{PHASE_TEXT[phase ?? ''] ?? '准备中…'}</span>}
                {atEnd && typed && adv?.stuck && <span className="text-err">✕ {adv.stuck}</span>}
                {atEnd && typed && adv?.error && <span className="text-err">✕ {adv.error}</span>}
              </>
            }
            status={
              <>
                {busy && <Spinner className="size-3" />}
                {busy && phase && <span data-testid="adv-phase">{PHASE_TEXT[phase] ?? phase}</span>}
                {adv?.needsModel && atEnd && !busy && (
                  <button
                    type="button"
                    className="text-warn underline-offset-2 hover:underline"
                    data-testid="adv-needs-model"
                    onClick={(e) => {
                      e.stopPropagation();
                      navigate({ page: 'settings' });
                    }}
                  >
                    没配模型，这一幕先用占位旁白 · 去设置
                  </button>
                )}
                {mode === 'auto' && <span className="text-accent-strong">自动</span>}
                {skipping && <span className="text-warn">快进中</span>}
                {typed && !menuOpen && !driftOpen && !busy && step && <span className="stage-blink text-white/70">▼</span>}
              </>
            }
            toolbar={toolbar}
          />
        )}

        {/* 面板 */}
        {panel === 'backlog' && (
          <Overlay p="adv" title="回想" onClose={() => setPanel(null)} testId="adv-backlog-panel">
            <Backlog
              p="adv"
              timeline={timeline}
              cursor={cursor}
              colorOf={colorOf}
              busy={busy}
              onRewind={(id) => void rewindTo(id)}
            />
          </Overlay>
        )}
        {(panel === 'save' || panel === 'load') && (
          <Overlay p="adv" title={panel === 'save' ? '存档' : '读档'} onClose={() => setPanel(null)} testId="adv-saves-panel">
            <Saves
              mode={panel}
              saves={view.saves}
              busy={busy}
              onSave={(name) =>
                void call(
                  () => engine.call('saveSlot', { ...ref, name, ...(step ? { at: { eventId: step.eventId, index: step.index } } : {}) }),
                  () => cursor,
                ).then((ok) => ok && toast('ok', '已存档'))
              }
              onLoad={(s) =>
                void call(() => engine.call('loadSave', { ...ref, saveId: s.id }), (t) => findStep(t, s.at)).then((ok) => {
                  if (!ok) return;
                  typing.forget();
                  setMode('normal');
                  setPanel(null);
                })
              }
              onDelete={(s) => void call(() => engine.call('deleteSave', { ...ref, saveId: s.id }), () => cursor)}
            />
          </Overlay>
        )}
        {panel === 'settings' && (
          <Overlay p="adv" title="设置" onClose={() => setPanel(null)} testId="adv-settings-panel">
            <div className="grid max-w-md grid-cols-2 gap-4 text-sm">
              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-muted">文字速度</span>
                <Select
                  value={speed}
                  onChange={(e) => {
                    setSpeed(Number(e.target.value));
                    writeStore(SPEED_KEY, Number(e.target.value));
                  }}
                >
                  {TEXT_SPEEDS.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-muted">自动播放的停顿</span>
                <Select
                  value={autoDelay}
                  onChange={(e) => {
                    setAutoDelay(Number(e.target.value));
                    writeStore(AUTO_KEY, Number(e.target.value));
                  }}
                >
                  {AUTO_DELAYS.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </Select>
              </label>
              <p className="col-span-2 text-xs leading-relaxed text-faint">
                空格 / 回车 / 点击：继续 · 按住 Ctrl：快进（到选项停下） · A：自动 · H 或右键：隐藏文本框 · PageUp 或滚轮向上：回想 ·
                数字键：选选项 · Esc：关闭面板
              </p>
            </div>
          </Overlay>
        )}
        {panel === 'ending' && adv && (
          <Overlay p="adv" title="周目结束" onClose={() => setPanel(null)} testId="adv-ending">
            <div className="space-y-5 text-sm">
              {adv.ending && (
                <div className="flex flex-col items-center gap-2 py-4 text-center">
                  <div className={cx('text-xs tracking-[0.3em]', adv.ending.kind === 'good' ? 'text-ok' : adv.ending.kind === 'bad' ? 'text-err' : 'text-muted')}>
                    {ENDING_KIND[adv.ending.kind]}
                    {adv.ending.hidden ? ' · 隐藏结局' : ''}
                  </div>
                  <div className="text-2xl font-semibold" data-testid="adv-ending-title">
                    {adv.ending.title}
                  </div>
                </div>
              )}
              <div className="grid grid-cols-3 gap-3 text-center">
                <Stat label="结局" value={`${adv.progress.reached} / ${adv.progress.total}`} testId="adv-progress-endings" />
                <Stat label="CG" value={`${adv.progress.cgs.unlocked.length} / ${adv.progress.cgs.total}`} />
                <Stat label="走过的幕" value={`${adv.progress.scenes.visited} / ${adv.progress.scenes.total}`} />
              </div>
              <div className="flex flex-wrap justify-center gap-2">
                {adv.progress.endings
                  .filter((e) => !e.hidden || e.reached)
                  .map((e) => (
                    <span
                      key={e.id}
                      className={cx('rounded-md border px-2 py-1 text-xs', e.reached ? 'border-accent/50 text-fg' : 'border-line text-faint')}
                    >
                      {e.reached ? e.title : '？？？'}
                    </span>
                  ))}
              </div>
              <div className="flex justify-center gap-2 pt-2">
                {lastChoice?.kind === 'choice' && lastChoice.rewindTo && (
                  <Button data-testid="adv-ending-rewind" onClick={() => void rewindTo(lastChoice.rewindTo as string)}>
                    回到上一个选择
                  </Button>
                )}
                <Button
                  onClick={() =>
                    void engine
                      .call('startPlaythrough', { worldId: ref.worldId, mode: 'adv' })
                      .then((v) => navigate({ page: 'play', worldId: ref.worldId, playthroughId: v.playthrough.id }))
                      .catch((err) => toast('err', errorMessage(err)))
                  }
                >
                  再玩一次
                </Button>
                <Button data-testid="adv-ending-collection" onClick={() => navigate({ page: 'world', worldId: ref.worldId, tab: 'collection' })}>
                  结局和 CG
                </Button>
                <Button variant="primary" onClick={onBack}>
                  返回世界
                </Button>
              </div>
            </div>
          </Overlay>
        )}
      </div>
    </div>
  );
}

function formatValue(v: unknown): string {
  if (typeof v === 'boolean') return v ? '是' : '否';
  return v === undefined ? '—' : String(v);
}

function delta(from: unknown, to: unknown): string {
  if (typeof from === 'number' && typeof to === 'number') return `${to >= from ? '+' : '-'}${Math.abs(to - from)}`;
  return `→ ${formatValue(to)}`;
}

function Stat({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel-2 px-3 py-2">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-0.5 text-lg font-semibold" data-testid={testId}>
        {value}
      </div>
    </div>
  );
}

function Saves({
  mode,
  saves,
  busy,
  onSave,
  onLoad,
  onDelete,
}: {
  mode: 'save' | 'load';
  saves: SaveInfo[];
  busy: boolean;
  onSave: (name: string) => void;
  onLoad: (s: SaveInfo) => void;
  onDelete: (s: SaveInfo) => void;
}) {
  const [name, setName] = useState('');
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      {mode === 'save' && (
        <div className="flex gap-2">
          <Input placeholder="存档名（可以不填）" value={name} onChange={(e) => setName(e.target.value)} data-testid="adv-save-name" />
          <Button
            variant="primary"
            className="shrink-0"
            disabled={busy}
            data-testid="adv-save-confirm"
            onClick={() => {
              onSave(name);
              setName('');
            }}
          >
            存到新存档位
          </Button>
        </div>
      )}
      {saves.length === 0 && <p className="text-sm text-faint">还没有存档。</p>}
      <div className="grid grid-cols-2 gap-3">
        {saves.map((s) => (
          <div key={s.id} className="flex gap-3 rounded-xl border border-line bg-panel p-3" data-testid="adv-save-slot">
            <div className="relative aspect-video w-36 shrink-0 overflow-hidden rounded-md bg-black" style={{ containerType: 'inline-size' }}>
              {s.thumb?.bg && <BgImage id={s.thumb.bg} />}
              {s.thumb?.cg && <PlaceholderCg id={s.thumb.cg} />}
              {s.thumb && !s.thumb.cg && s.thumb.chars.length > 0 && (
                <div className="absolute inset-x-0 bottom-1 flex justify-center gap-1">
                  {s.thumb.chars.map((c) => (
                    <span key={c} className="size-3 rounded-full bg-white/60" />
                  ))}
                </div>
              )}
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium">{s.name}</span>
                <span className="shrink-0 text-[11px] text-faint">{formatTime(s.createdAt)}</span>
              </div>
              {s.thumb?.scene && <div className="text-xs text-muted">{s.thumb.scene}</div>}
              <p className="mt-1 line-clamp-2 text-xs text-faint">{s.preview}</p>
              {mode === 'load' && (
                <div className="mt-auto flex gap-1.5 pt-2">
                  <Button size="sm" variant="primary" disabled={busy} data-testid="adv-load-slot" onClick={() => onLoad(s)}>
                    读取
                  </Button>
                  <ConfirmButton onConfirm={() => onDelete(s)}>删除</ConfirmButton>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
