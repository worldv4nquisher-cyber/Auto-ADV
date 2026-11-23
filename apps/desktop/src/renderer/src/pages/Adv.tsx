/**
 * 剧情 ADV 的 VN 舞台（M3 第 2、3 步）：背景、立绘站位、文本框、回想、自动播放、快进、存读档。
 * 素材还没有生成（M4），背景、立绘、CG 都用占位图。
 *
 * 舞台本身不保存状态：引擎给出事件路径，plot/stage.ts 把它展开成一步一步的画面，这里只记"播到第几步"。
 * 播到最后一步时再找引擎要下一拍：手写剧本不调模型，立刻返回；没有剧本的幕由 AI 演出（流式返回进度），
 * 这时除了选项还可以直接输入想做的事。
 */
import type { PlayChunk, PlayView, SaveInfo, WorldDetail } from '@auto-adv/engine/api';
import { buildTimeline, findStep, type StageStep, type StageView, type Timeline } from '@auto-adv/engine/stage';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { PlaceholderBg, PlaceholderCg, PlaceholderSprite } from '../components/placeholder.tsx';
import { useColorOf } from '../components/story.tsx';
import { Button, ConfirmButton, cx, Input, Select, Spinner, useToast } from '../components/ui.tsx';
import { engine, errorMessage, isAborted } from '../lib/engine.ts';
import { formatTime } from '../lib/format.ts';
import { useRouter } from '../lib/router.tsx';

const OUTCOME = { crit: '大成功', success: '成功', narrow: '险胜', fail: '失败' } as const;
const ENDING_KIND = { good: '好结局', normal: '普通结局', bad: '坏结局' } as const;
const PHASE_TEXT: Record<string, string> = {
  thinking: '导演正在安排这一拍…',
  writing: '演员们正在演出…',
  memory: '书记正在整理前情提要…',
};

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
const LONG = Number.MAX_SAFE_INTEGER;

export function AdvPage({ world, initial, onBack }: { world: WorldDetail; initial: PlayView; onBack: () => void }) {
  const toast = useToast();
  const { navigate } = useRouter();
  const colorOf = useColorOf(world);
  const tint = (id: string | null, name: string) => colorOf(id, name) ?? '#a194ff';
  const ref = { worldId: initial.playthrough.worldId, playthroughId: initial.playthrough.id };
  const opts = useMemo(() => ({ characters: world.characters, graph: world.graph }), [world]);

  const [view, setView] = useState(initial);
  const timeline = useMemo(() => buildTimeline(view.path, opts), [view.path, opts]);
  const [cursor, setCursor] = useState(() => initialCursor(buildTimeline(initial.path, opts), initial.playthrough.id));
  const [shown, setShown] = useState(LONG);
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
  const typedKey = useRef('');
  const typer = useRef<ReturnType<typeof setInterval> | null>(null);
  const reported = useRef(new Set<string>());

  const steps = timeline.steps;
  const step: StageStep | undefined = steps[cursor];
  const stepKey = step ? `${cursor}:${step.eventId}:${step.index}` : `${cursor}`;
  const textLen = useMemo(() => [...(step?.text?.text ?? '')].length, [step?.text?.text]);
  const typed = step?.kind !== 'text' || shown >= textLen;
  const adv = view.adv;
  const atEnd = cursor >= steps.length - 1;
  const skipping = mode === 'skip' || ctrl;
  const menuOpen = !!adv?.menu && atEnd && typed && !busy;
  const stage: StageView = step?.view ?? timeline.end;

  // 记住看到哪里了（下次打开周目从这里继续）
  useEffect(() => {
    if (step) writeStore(posKey(ref.playthroughId), { eventId: step.eventId, index: step.index });
  }, [stepKey]);

  // 打字机效果
  useEffect(() => {
    if (!step || step.kind !== 'text') return;
    if (skipping || speed <= 0 || typedKey.current === stepKey) {
      typedKey.current = stepKey;
      setShown(LONG);
      return;
    }
    setShown(0);
    let i = 0;
    const t = setInterval(() => {
      i += 1;
      setShown(i);
      if (i >= textLen) {
        clearInterval(t);
        typedKey.current = stepKey;
      }
    }, 1000 / speed);
    typer.current = t;
    return () => clearInterval(t);
  }, [stepKey, skipping, speed]);

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
  useEffect(() => {
    if (step?.cues?.some((c) => c.op === 'effect' && c.id === 'shake')) stageRef.current?.classList.add('stage-shake');
    const el = stageRef.current;
    const t = setTimeout(() => el?.classList.remove('stage-shake'), 500);
    return () => clearTimeout(t);
  }, [stepKey]);

  // 离开页面时取消还在生成的一拍
  useEffect(() => () => controller.current?.abort(), []);

  /** 换一个新的 PlayView，place 算出舞台停在哪一步。 */
  const call = async (fn: (signal: AbortSignal) => Promise<PlayView>, place: (t: Timeline) => number): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    const ac = new AbortController();
    controller.current = ac;
    try {
      const v = await fn(ac.signal);
      const t = buildTimeline(v.path, opts);
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
  /** 往下演、选选项、自由输入：AI 演出的幕会流式返回进度。新内容从第一条新步骤开始播。 */
  const act = (method: 'advNext' | 'advChoose' | 'advInput', extra: { index?: number; text?: string } = {}) => {
    const len = steps.length;
    const place = (t: Timeline) => Math.min(len, t.steps.length - 1);
    if (method === 'advChoose') return call((sig) => engine.stream('advChoose', { ...ref, index: extra.index ?? 0 }, onChunk, sig), place);
    if (method === 'advInput') return call((sig) => engine.stream('advInput', { ...ref, text: extra.text ?? '' }, onChunk, sig), place);
    return call((sig) => engine.stream('advNext', ref, onChunk, sig), place);
  };

  const complete = () => {
    if (typer.current) clearInterval(typer.current);
    typedKey.current = stepKey;
    setShown(LONG);
  };

  const advance = () => {
    if (busy || panel) return;
    if (!typed) return complete();
    if (cursor < steps.length - 1) return setCursor(cursor + 1);
    if (!adv || adv.menu) return;
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

  /** AI 演出的幕里可以不选选项，直接输入想做的事。 */
  const inputOpen = !!adv?.aiScene && !adv.needsModel && !adv.finished && !adv.error && atEnd && typed && !busy;
  const submitAction = () => {
    const text = action.trim();
    if (!text || !inputOpen) return;
    void act('advInput', { text }).then((ok) => ok && setAction(''));
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
    if (atEnd && typed && (adv?.menu || adv?.error || adv?.stuck)) {
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
        else if (!menuOpen) advance();
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

  const speaker = step?.text?.speaker ?? null;
  // 顶部显示的是舞台播到的这一步的幕和数值，不是引擎已经算到的地方（选完之后的一拍是一起算出来的，不能提前剧透）
  const sceneNow = useMemo(() => {
    const sc = step?.scene ? world.graph?.scenes.find((x) => x.id === step.scene) : undefined;
    if (!sc) return adv?.scene ?? null;
    const ch = sc.chapter ? world.graph?.chapters.find((c) => c.id === sc.chapter) : undefined;
    return { id: sc.id, title: sc.title || sc.id, chapter: ch ? ch.title || ch.id : null };
  }, [step?.scene, adv?.scene, world.graph]);
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
        onClick={() => (hidden ? setHidden(false) : menuOpen || (inputOpen && action.trim()) ? undefined : advance())}
        onContextMenu={(e) => {
          e.preventDefault();
          setHidden((h) => !h);
        }}
        onWheel={(e) => {
          if (e.deltaY < 0 && !panel) setPanel('backlog');
        }}
      >
        {/* 背景 */}
        {stage.bg ? (
          <div key={stage.bg.id} className={cx('absolute inset-0', stage.bg.transition !== 'none' && 'stage-fade')} data-testid="adv-bg" data-bg={stage.bg.id}>
            <PlaceholderBg id={stage.bg.id} label={false} />
          </div>
        ) : (
          <div className="absolute inset-0 bg-[#07080c]" />
        )}

        {/* 立绘 */}
        {stage.sprites.map((s) => (
          <div
            key={s.key}
            data-testid="adv-sprite"
            data-char={s.characterId ?? s.name}
            data-x={s.x}
            className="stage-rise absolute bottom-0 h-[86%] transition-[left] duration-500"
            style={{ left: `${s.x}%`, transform: 'translateX(-50%)' }}
          >
            <PlaceholderSprite
              name={s.name}
              expr={s.expr}
              color={tint(s.characterId, s.name)}
              dim={menuOpen || (!!speaker && step?.text?.kind === 'say' && speaker.characterId !== s.characterId)}
            />
          </div>
        ))}

        {/* CG */}
        {stage.cg && (
          <div key={stage.cg} className="stage-fade absolute inset-0" data-testid="adv-cg">
            <PlaceholderCg id={stage.cg} />
          </div>
        )}

        {/* 一次性的表现：闪白、音效等的提示 */}
        {step?.cues?.some((c) => c.op === 'effect' && c.id === 'flash') && (
          <div key={`flash${stepKey}`} className="stage-flash pointer-events-none absolute inset-0 bg-white" />
        )}

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
              {stage.bg && <span className="rounded bg-black/30 px-[0.7em] py-[0.15em] font-mono text-[0.85em] text-white/45">背景 · {stage.bg.id}</span>}
              {step?.cues
                ?.filter((c) => !(c.op === 'effect' && (c.id === 'shake' || c.id === 'flash')))
                .map((c, i) => (
                  <span key={`${stepKey}${i}`} className="stage-float rounded bg-black/50 px-[0.7em] py-[0.2em] text-white/70">
                    {{ sfx: '♪ 音效', voice: '🎙 语音', video: '▶ 视频', effect: '✦ 特效' }[c.op]}：{c.id}
                  </span>
                ))}
            </div>
            <div className="flex flex-col items-end gap-[0.4em]">
              <div className="flex flex-wrap justify-end gap-[0.4em]">
                {stage.bgm && <span className="rounded bg-black/40 px-[0.7em] py-[0.25em] text-white/60">♫ {stage.bgm}</span>}
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

        {/* 进入新的一幕：标题卡 */}
        {step?.kind === 'card' && step.card && (
          <div key={stepKey} className="stage-fade-fast absolute inset-0 flex flex-col items-center justify-center gap-[1.2cqw] bg-black/92">
            {step.card.chapter && <div className="text-[max(12px,1.3cqw)] tracking-[0.5em] text-white/55">{step.card.chapter}</div>}
            <div className="text-[max(20px,3cqw)] font-semibold tracking-[0.2em]" data-testid="adv-card">
              {step.card.title}
            </div>
          </div>
        )}

        {/* 检定 */}
        {step?.kind === 'check' && step.check && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/45">
            <div key={stepKey} className="stage-fade-fast flex min-w-[34%] flex-col items-center gap-[0.6cqw] rounded-[1cqw] border border-white/15 bg-[#11131b]/90 px-[3cqw] py-[2cqw] text-center" data-testid="adv-check">
              <div className="text-[max(12px,1.2cqw)] text-white/60">🎲 检定 · {step.check.label}</div>
              <div className="text-[max(28px,5cqw)] leading-none font-semibold">{step.check.total}</div>
              <div className="text-[max(11px,1cqw)] text-white/55">
                d20 = {step.check.roll}
                {step.check.var ? ` ${step.check.modifier >= 0 ? '+' : '-'} ${Math.abs(step.check.modifier)}（${varLabel(step.check.var)}）` : ''}
                ，难度 {step.check.dc}
              </div>
              <div
                className={cx(
                  'mt-[0.4cqw] text-[max(14px,1.8cqw)] font-semibold',
                  step.check.outcome === 'fail' ? 'text-err' : step.check.outcome === 'crit' ? 'text-warn' : 'text-ok',
                )}
              >
                {OUTCOME[step.check.outcome]}
              </div>
            </div>
          </div>
        )}

        {/* 选项 */}
        {menuOpen && adv?.menu && !hidden && (
          <div className="absolute inset-x-0 top-0 bottom-[30%] flex flex-col items-center justify-center gap-[0.9cqw]" data-testid="adv-menu">
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
        {inputOpen && !menuOpen && !hidden && (
          <div className="absolute inset-x-0 bottom-[32%] flex justify-center" data-testid="adv-actions">
            {actionForm}
          </div>
        )}

        {/* 文本框 */}
        {!hidden && step?.kind !== 'card' && (
          <div className="absolute inset-x-[3%] bottom-[3%] h-[27%]">
            {textVisible && speaker && (
              <div
                className="absolute -top-[1.1em] left-[2.5%] z-10 rounded-[0.4em] px-[0.9em] py-[0.25em] text-[max(12px,1.35cqw)] font-semibold shadow"
                style={{ background: tint(speaker.characterId, speaker.name), color: '#11131b' }}
                data-testid="adv-name"
              >
                {speaker.name}
              </div>
            )}
            <div className="flex h-full flex-col rounded-[1cqw] border border-white/12 bg-[#0b0d14]/78 px-[2.6%] pt-[2.2%] pb-[1.2%] backdrop-blur-sm">
              <div
                className={cx(
                  'flex-1 overflow-hidden text-[max(14px,1.65cqw)] leading-[1.75]',
                  step?.text?.kind === 'narrate' && 'text-white/88',
                  step?.text?.kind === 'think' && 'text-[#c7c2ff]/90',
                )}
                data-testid="adv-text"
              >
                {textVisible && step?.text && (
                  <>
                    {step.text.kind === 'think' ? '（' : step.text.kind === 'say' ? '「' : ''}
                    {[...step.text.text].slice(0, shown).join('')}
                    {typed && (step.text.kind === 'think' ? '）' : step.text.kind === 'say' ? '」' : '')}
                  </>
                )}
                {!step && !adv?.menu && <span className="text-white/50">（还没有内容）</span>}
                {!step && busy && <span className="text-white/50">{PHASE_TEXT[phase ?? ''] ?? '准备中…'}</span>}
                {atEnd && typed && adv?.stuck && <span className="text-err">✕ {adv.stuck}</span>}
                {atEnd && typed && adv?.error && <span className="text-err">✕ {adv.error}</span>}
              </div>
              <div className="flex items-center justify-between text-[max(11px,0.95cqw)] text-white/55">
                <span className="flex items-center gap-2">
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
                  {typed && !menuOpen && !busy && step && <span className="stage-blink text-white/70">▼</span>}
                </span>
                {toolbar}
              </div>
            </div>
          </div>
        )}

        {/* 面板 */}
        {panel === 'backlog' && (
          <Overlay title="回想" onClose={() => setPanel(null)} testId="adv-backlog-panel">
            <Backlog
              timeline={timeline}
              cursor={cursor}
              colorOf={colorOf}
              busy={busy}
              onRewind={(id) => void rewindTo(id)}
            />
          </Overlay>
        )}
        {(panel === 'save' || panel === 'load') && (
          <Overlay title={panel === 'save' ? '存档' : '读档'} onClose={() => setPanel(null)} testId="adv-saves-panel">
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
                  typedKey.current = '';
                  setMode('normal');
                  setPanel(null);
                })
              }
              onDelete={(s) => void call(() => engine.call('deleteSave', { ...ref, saveId: s.id }), () => cursor)}
            />
          </Overlay>
        )}
        {panel === 'settings' && (
          <Overlay title="设置" onClose={() => setPanel(null)} testId="adv-settings-panel">
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
          <Overlay title="周目结束" onClose={() => setPanel(null)} testId="adv-ending">
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

function ToolButton({
  children,
  onClick,
  active,
  testId,
}: {
  children: ReactNode;
  onClick: () => void;
  active?: boolean;
  testId: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className={cx('rounded px-[0.55em] py-[0.15em] transition-colors hover:bg-white/10 hover:text-white', active && 'bg-white/15 text-white')}
    >
      {children}
    </button>
  );
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

/** 盖在舞台上的面板。点面板外面不关（免得误触继续剧情），用右上角或 Esc 关。 */
function Overlay({ title, children, onClose, testId }: { title: string; children: ReactNode; onClose: () => void; testId: string }) {
  return (
    <div
      className="absolute inset-0 z-20 flex flex-col bg-[#0b0d14]/94 text-fg backdrop-blur"
      data-testid={testId}
      onClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between border-b border-line px-6 py-3">
        <div className="text-base font-semibold">{title}</div>
        <Button variant="ghost" size="sm" onClick={onClose} data-testid="adv-panel-close">
          关闭
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">{children}</div>
    </div>
  );
}

function Backlog({
  timeline,
  cursor,
  colorOf,
  busy,
  onRewind,
}: {
  timeline: Timeline;
  cursor: number;
  colorOf: (id: string | null, name: string) => string | undefined;
  busy: boolean;
  onRewind: (eventId: string) => void;
}) {
  const end = useRef<HTMLDivElement>(null);
  // 新版 Chromium 的 scrollIntoView 返回 Promise，不能直接当作 effect 的返回值（React 会把它当清理函数调用）
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, []);
  const entries = timeline.backlog.filter((b) => b.step <= cursor);
  if (!entries.length) return <p className="text-sm text-faint">还没有内容。</p>;
  return (
    <div className="mx-auto max-w-3xl space-y-3 text-[15px] leading-7">
      {entries.map((b, i) => {
        if (b.kind === 'scene') {
          return (
            <div key={i} className="pt-3 text-center text-xs tracking-[0.3em] text-faint">
              {b.chapter ? `${b.chapter} · ` : ''}
              {b.title}
            </div>
          );
        }
        if (b.kind === 'check') {
          return (
            <p key={i} className="text-sm text-muted">
              🎲 检定「{b.check.label}」：{b.check.total}（难度 {b.check.dc}）→ {OUTCOME[b.check.outcome]}
            </p>
          );
        }
        if (b.kind === 'choice') {
          return (
            <div key={i} className="flex items-center justify-between gap-3 rounded-lg border border-accent/25 bg-accent-soft px-3 py-1.5 text-sm">
              <span>▶ 你选了：{b.label}</span>
              {b.rewindTo && (
                <Button size="sm" variant="ghost" disabled={busy} data-testid="adv-rewind" onClick={() => onRewind(b.rewindTo as string)}>
                  回到这里重新选
                </Button>
              )}
            </div>
          );
        }
        const t = b.text;
        return (
          <div key={i}>
            {t.speaker && (
              <div className="text-xs font-medium" style={{ color: colorOf(t.speaker.characterId, t.speaker.name) }}>
                {t.speaker.name}
              </div>
            )}
            <p className={cx(t.kind === 'narrate' && 'text-muted', t.kind === 'think' && 'text-[#c7c2ff]/90')}>
              {t.kind === 'think' ? `（${t.text}）` : t.kind === 'say' ? `「${t.text}」` : t.text}
            </p>
          </div>
        );
      })}
      <div ref={end} />
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
              {s.thumb?.bg && <PlaceholderBg id={s.thumb.bg} label={false} />}
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
