import type {
  ObserverChunk,
  ObserverStatus,
  PathEvent,
  PlayEvent,
  PlayView,
  SceneState,
  Segment,
  WorldDetail,
} from '@auto-adv/engine/api';
import type { ObserverSettings, PlotOutline } from '@auto-adv/schema';
import { type KeyboardEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { EventBlock, Segments, useColorOf } from '../components/story.tsx';
import { Badge, Button, Card, cx, Field, Input, Markdown, Select, Spinner, Textarea, useToast } from '../components/ui.tsx';
import { engine, errorMessage, isAborted } from '../lib/engine.ts';
import { formatCost, formatTokens } from '../lib/format.ts';

// ───────────── 自动播放的节奏 ─────────────

/** 打字速度（字/秒）、每段读完后的停顿（基础 + 每字），都按 1 倍速算。 */
const CPS = 30;
const HOLD_BASE = 500;
const HOLD_PER_CHAR = 70;
/** 一拍结束到下一拍开始的间隔。 */
const GAP = 600;
const SPEEDS = [
  { value: 0.5, label: '0.5×' },
  { value: 1, label: '1×' },
  { value: 1.5, label: '1.5×' },
  { value: 2, label: '2×' },
  { value: 3, label: '3×' },
  { value: 0, label: '即时' },
];
const SPEED_KEY = 'auto-adv:observer-speed';

function loadSpeed(): number {
  try {
    const v = Number(localStorage.getItem(SPEED_KEY));
    return SPEEDS.some((s) => s.value === v) && localStorage.getItem(SPEED_KEY) !== null ? v : 1;
  } catch {
    return 1;
  }
}

/** 一拍里每段的出现时间、打完时间、读完时间（毫秒，1 倍速）。 */
function timeline(segs: Segment[]) {
  let t = 0;
  return segs.map((s) => {
    const len = [...s.text].length;
    const start = t;
    const typeEnd = start + (len * 1000) / CPS;
    t = typeEnd + HOLD_BASE + len * HOLD_PER_CHAR;
    return { start, typeEnd, end: t, len };
  });
}

const durationOf = (segs: Segment[]) => timeline(segs).at(-1)?.end ?? 0;

/** 播放到 clock 毫秒时能看到的内容。 */
function visibleAt(segs: Segment[], clock: number): Segment[] {
  const tl = timeline(segs);
  return segs.flatMap((s, i) => {
    const t = tl[i];
    if (!t || clock < t.start) return [];
    const n = Math.min(t.len, Math.floor(((clock - t.start) * CPS) / 1000));
    return [{ ...s, text: [...s.text].slice(0, n).join('') }];
  });
}

const PHASE_TEXT: Record<string, string> = {
  arc: '剧情骨架演完了，导演正在构思新的篇章…',
  director: '导演正在安排下一拍…',
  writer: '演员们正在演出…',
  narrator: '旁白正在描写…',
  memory: '书记正在整理前情提要…',
};

const ACTIVITY_TEXT: Record<ObserverStatus['activity'], string> = {
  idle: '已暂停',
  generating: '生成中',
  buffered: '已缓冲',
  throttled: '限速等待',
  backoff: '出错重试',
};

const STOP_TEXT: Record<NonNullable<ObserverStatus['stopReason']>, string> = {
  budget: '已达到预算上限，自动停下了',
  errors: '连续失败，自动停下了',
  takeover: '你接管了角色，自动演出已暂停',
};

interface Live {
  phase: string | null;
  name?: string;
  segs: Segment[];
}

/** 读者看到的进度（不剧透还没播到的部分）。 */
function storyAt(world: WorldDetail, seen: PlayEvent[]) {
  const done = new Set(seen.flatMap((e) => e.beat?.done ?? []));
  const acts: PlotOutline['acts'] = [...(world.plot?.acts ?? []), ...seen.flatMap((e) => (e.beat?.arc ? [e.beat.arc] : []))];
  const chapters = acts.flatMap((a) => a.chapters);
  const chapter = chapters.find((ch) => ch.beats.some((b) => !done.has(b.id))) ?? null;
  let scene: SceneState = { locationId: null, presentCharacterIds: [] };
  let time: string | null = null;
  for (const e of seen) {
    if (e.scene) scene = e.scene;
    if (e.beat?.time) time = e.beat.time;
  }
  const total = chapters.reduce((n, ch) => n + ch.beats.length, 0);
  return { done, chapter, chapters, scene, time, total };
}

export function ObservePage({ world, initial, onBack }: { world: WorldDetail; initial: PlayView; onBack: () => void }) {
  const toast = useToast();
  const colorOf = useColorOf(world);
  const ref = useMemo(
    () => ({ worldId: initial.playthrough.worldId, playthroughId: initial.playthrough.id }),
    [initial.playthrough.worldId, initial.playthrough.id],
  );
  const readIndex = (v: PlayView) => Math.max(1, v.path.findIndex((e) => e.id === v.observer?.readId) + 1);

  const [view, setView] = useState(initial);
  const [status, setStatus] = useState<ObserverStatus | null>(initial.observer);
  const [live, setLive] = useState<Live | null>(null);
  /** 已经完整播完的事件数；第 shown 个事件正在播放。 */
  const [shown, setShown] = useState(() => readIndex(initial));
  const [clock, setClock] = useState(0);
  const [playing, setPlaying] = useState(!!initial.observer?.running);
  const [speed, setSpeed] = useState(loadSpeed);
  const [busy, setBusy] = useState<null | { kind: 'regenerate'; baseLen: number } | { kind: 'send'; text: string; segs: Segment[] }>(null);
  const [input, setInput] = useState('');
  const [target, setTarget] = useState<string>('director');
  const viewRef = useRef(view);
  viewRef.current = view;
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const controller = useRef<AbortController | null>(null);

  const controlled = world.characters.find((c) => c.id === view.playthrough.controlledId) ?? null;
  const settings = view.playthrough.observer as ObserverSettings;

  const refresh = useCallback(async () => {
    try {
      const v = await engine.call('getPlaythrough', ref);
      setView(v);
      setStatus(v.observer);
      return v;
    } catch (err) {
      toast('err', errorMessage(err));
      return null;
    }
  }, [ref, toast]);

  // 订阅实时进度
  useEffect(() => {
    const ac = new AbortController();
    const onChunk = (c: ObserverChunk) => {
      if (c.type === 'status') setStatus(c.status);
      else if (c.type === 'beat-start') setLive({ phase: null, segs: [] });
      else if (c.type === 'phase') setLive((l) => ({ segs: l?.segs ?? [], phase: c.phase, name: c.name }));
      else if (c.type === 'seg') {
        setLive((l) => {
          const segs = [...(l?.segs ?? [])];
          segs[c.index] = c.seg;
          return { phase: l?.phase ?? null, name: l?.name, segs };
        });
      } else if (c.type === 'event') {
        if (c.event.kind === 'ai') setLive(null);
        const v = viewRef.current;
        if (v.path.some((e) => e.id === c.event.id)) return;
        if (v.path.at(-1)?.id === c.event.parentId) setView({ ...v, path: [...v.path, c.event] });
        else void refresh();
      }
    };
    engine.stream('observerWatch', ref, onChunk, ac.signal).catch((err) => {
      if (!isAborted(err)) toast('err', errorMessage(err));
    });
    return () => {
      ac.abort();
      controller.current?.abort();
    };
  }, [ref, refresh, toast]);

  // ───── 自动播放 ─────

  const current: PathEvent | undefined = busy?.kind === 'regenerate' ? undefined : view.path[shown];
  const total = current?.segments?.length ? durationOf(current.segments) : 0;
  const finished = clock >= total;

  const advance = useCallback(() => {
    const e = viewRef.current.path[shown];
    setShown(shown + 1);
    setClock(0);
    if (e) engine.call('observerRead', { ...ref, eventId: e.id }).then(setStatus, () => {});
  }, [ref, shown]);

  useEffect(() => {
    if (!playing || !current || busy) return;
    if (speed === 0 || total === 0 || finished) {
      const t = setTimeout(advance, speed === 0 || total === 0 ? 0 : GAP / speed);
      return () => clearTimeout(t);
    }
    // 按真实流逝的时间推进（窗口在后台时计时器会被节流，但进度不会变慢）
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      setClock((c) => c + (now - last) * speed);
      last = now;
    }, 50);
    return () => clearInterval(timer);
  }, [playing, current, busy, speed, total, finished, advance]);

  // 内容变化时，如果本来就在底部，就跟着滚到底
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  const setSpeedSaved = (v: number) => {
    setSpeed(v);
    try {
      localStorage.setItem(SPEED_KEY, String(v));
    } catch {
      // 存不了就算了
    }
  };

  // ───── 操作 ─────

  const control = async (action: 'play' | 'pause') => {
    setPlaying(action === 'play');
    try {
      const v = await engine.call('observerControl', { ...ref, action });
      setView(v);
      setStatus(v.observer);
    } catch (err) {
      toast('err', errorMessage(err));
    }
  };

  /** 跳过正在播放的内容，直接看到最新。 */
  const skipToEnd = () => {
    const v = viewRef.current;
    setShown(v.path.length);
    setClock(0);
    const head = v.path.at(-1);
    if (head) engine.call('observerRead', { ...ref, eventId: head.id }).then(setStatus, () => {});
  };

  /** 会让自动演出停下的分支操作。 */
  const navigateTree = async (fn: () => Promise<PlayView>) => {
    try {
      const v = await fn();
      setView(v);
      setStatus(v.observer);
      setShown(readIndex(v));
      setClock(0);
      setPlaying(false);
      setLive(null);
    } catch (err) {
      toast('err', errorMessage(err));
    }
  };

  const regenerate = async (e: PathEvent) => {
    if (busy) return;
    const baseLen = view.path.findIndex((x) => x.id === e.id);
    const ac = new AbortController();
    controller.current = ac;
    setBusy({ kind: 'regenerate', baseLen });
    setLive({ phase: null, segs: [] });
    stick.current = true;
    try {
      const v = await engine.stream('regenerate', { ...ref, eventId: e.id }, () => {}, ac.signal);
      setView(v);
      setStatus(v.observer);
      setShown(baseLen);
      setClock(0);
      setPlaying(true);
    } catch (err) {
      if (!isAborted(err)) toast('err', errorMessage(err));
      void refresh();
    } finally {
      controller.current = null;
      setBusy(null);
      setLive(null);
    }
  };

  /** 接管角色时以他的身份说话。 */
  const sendAs = async (text: string) => {
    if (busy) return;
    const ac = new AbortController();
    controller.current = ac;
    setInput('');
    setBusy({ kind: 'send', text, segs: [] });
    stick.current = true;
    try {
      const v = await engine.stream(
        'send',
        { ...ref, text },
        (c) => {
          if (c.type !== 'seg') return;
          setBusy((b) => {
            if (b?.kind !== 'send') return b;
            const segs = [...b.segs];
            segs[c.index] = c.seg;
            return { ...b, segs };
          });
        },
        ac.signal,
      );
      setView(v);
      setStatus(v.observer);
      setShown(v.path.length);
      setClock(0);
    } catch (err) {
      if (!isAborted(err)) toast('err', errorMessage(err));
      const v = await refresh();
      if (v) setShown(v.path.length);
    } finally {
      controller.current = null;
      setBusy(null);
    }
  };

  const takeover = async (characterId: string | null) => {
    try {
      const v = await engine.call('takeover', { ...ref, characterId });
      setView(v);
      setStatus(v.observer);
      if (characterId) {
        setShown(v.path.length);
        setClock(0);
        setPlaying(false);
        setTarget('director');
        inputRef.current?.focus();
      } else {
        setPlaying(!!v.observer?.running);
      }
    } catch (err) {
      toast('err', errorMessage(err));
    }
  };

  const submit = async () => {
    const text = input.trim();
    if (!text) return;
    if (controlled) return sendAs(text);
    try {
      const v =
        target === 'director'
          ? await engine.call('directive', { ...ref, text })
          : await engine.call('whisper', { ...ref, characterId: target, text });
      setInput('');
      setView(v);
      setStatus(v.observer);
      const ahead = v.observer?.ahead ?? 0;
      if (v.observer?.queued) toast('ok', '正在生成这一拍，会在下一拍开始前生效');
      else if (ahead > 0) toast('ok', `已记下，会在已经生成好的 ${ahead} 拍之后生效`);
    } catch (err) {
      toast('err', errorMessage(err));
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  // ───── 渲染 ─────

  const baseLen = busy?.kind === 'regenerate' ? busy.baseLen : shown;
  const seen = view.path.slice(0, baseLen);
  const story = storyAt(world, seen);
  const caughtUp = !busy && shown >= view.path.length;
  const isPlaying = playing && (!!status?.running || !caughtUp);
  const lastBeat = [...seen].reverse().find((e) => e.beat);
  const generating = status?.activity === 'generating' || busy?.kind === 'regenerate';

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-6">
          <Button size="sm" variant="ghost" onClick={onBack}>
            ‹ {world.manifest.title}
          </Button>
          <span className="text-sm text-faint">{view.playthrough.title}</span>
          <Badge tone="accent">观察模式</Badge>
          <div className="ml-auto flex items-center gap-2">
            <StatusPill status={status} />
            <div className="w-24 shrink-0">
              <Select
                className="h-8 text-xs"
                value={String(speed)}
                onChange={(e) => setSpeedSaved(Number(e.target.value))}
                title="播放速度"
                data-testid="observe-speed"
              >
                {SPEEDS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </div>
            {!caughtUp && (
              <Button size="sm" variant="ghost" className="shrink-0 whitespace-nowrap" onClick={skipToEnd} title="跳过正在播放的内容，直接看最新">
                跳到最新
              </Button>
            )}
            <Button
              size="sm"
              variant={isPlaying ? 'secondary' : 'primary'}
              className="w-20 shrink-0 whitespace-nowrap"
              data-testid="observe-toggle"
              disabled={!!busy || !!controlled}
              onClick={() => control(isPlaying ? 'pause' : 'play')}
            >
              {isPlaying ? '❚❚ 暂停' : '▶ 播放'}
            </Button>
          </div>
        </div>

        <div
          ref={scroller}
          className="flex-1 overflow-y-auto"
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
          }}
        >
          <div className="mx-auto max-w-3xl space-y-5 px-8 py-8" data-testid="play-log">
            {seen.map((e, i) => (
              <EventBlock
                key={e.id}
                e={e}
                world={world}
                isLast={i === seen.length - 1}
                busy={!!busy}
                protagonistName={controlled?.name ?? '你'}
                colorOf={colorOf}
                onRegenerate={() => regenerate(e)}
                onSwitch={(id) => navigateTree(() => engine.call('switchBranch', { ...ref, eventId: id }))}
                onRewind={() => navigateTree(() => engine.call('rewind', { ...ref, eventId: e.id }))}
                onDelete={() => navigateTree(() => engine.call('deleteBranch', { ...ref, eventId: e.id }))}
                onEdit={(text) => navigateTree(() => engine.call('editEvent', { ...ref, eventId: e.id, text }))}
              />
            ))}
            {current?.segments?.length ? (
              // 正在播放的一拍：点一下直接显示完整内容
              <div
                className="cursor-pointer"
                data-testid="observe-current"
                onClick={() => setClock(total)}
                title="点击直接显示这一拍"
              >
                <Segments segs={visibleAt(current.segments, speed === 0 ? total : clock)} colorOf={colorOf} />
              </div>
            ) : null}
            {busy?.kind === 'send' && (
              <div data-testid="play-streaming" className="space-y-4">
                <div className="flex flex-col items-end">
                  <div className="mb-1 text-xs text-faint">{controlled?.name}</div>
                  <div className="max-w-[85%] rounded-2xl rounded-tr-md bg-accent-soft px-4 py-2.5 text-[15px] leading-7 whitespace-pre-wrap">
                    {busy.text}
                  </div>
                </div>
                <Segments segs={busy.segs} colorOf={colorOf} />
                {!busy.segs.length && (
                  <div className="flex items-center gap-2 text-sm text-faint">
                    <Spinner /> 思考中…
                  </div>
                )}
              </div>
            )}
            {(caughtUp || busy?.kind === 'regenerate') && !controlled && (
              <LiveArea
                status={status}
                live={live}
                generating={!!generating}
                instant={speed === 0}
                colorOf={colorOf}
                onPlay={() => control('play')}
              />
            )}
          </div>
        </div>

        <div className="shrink-0 border-t border-line px-8 py-4">
          <div className="mx-auto max-w-3xl">
            {controlled ? (
              <div className="mb-2 flex items-center gap-2 text-xs text-muted">
                <span>
                  你正在扮演 <span className="font-medium text-fg">{controlled.name}</span>，其他角色由 AI 回应。
                </span>
                <Button size="sm" variant="ghost" data-testid="handback" onClick={() => takeover(null)}>
                  交还给 AI，继续自动演出
                </Button>
              </div>
            ) : (
              <div className="mb-2 flex items-center gap-2 text-xs text-muted">
                <span>对</span>
                <div className="w-40 shrink-0">
                  <Select className="h-7 text-xs" value={target} onChange={(e) => setTarget(e.target.value)} data-testid="note-target">
                    <option value="director">导演（下指令）</option>
                    {world.characters.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}（悄悄话）
                      </option>
                    ))}
                  </Select>
                </div>
                <span className="min-w-0 truncate text-faint">
                  {target === 'director' ? '导演会在下一拍尽量照办' : '只有他自己听得到，像心里的声音'}
                  {status && status.ahead > 0 ? `；已经生成好的 ${status.ahead} 拍之后生效` : ''}
                </span>
              </div>
            )}
            <div className="flex items-end gap-2">
              <Textarea
                ref={inputRef}
                data-testid="observe-input"
                rows={2}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKey}
                placeholder={
                  controlled
                    ? `以${controlled.name}的身份说话或行动……（Enter 发送）`
                    : target === 'director'
                      ? '例如：让两个人吵起来 / 时间跳到第二天早上 / 让一个新角色登场……'
                      : '例如：你其实一直在怀疑他……'
                }
                className="min-h-[60px] resize-none"
              />
              {busy ? (
                <Button className="h-[60px] w-20" onClick={() => controller.current?.abort()}>
                  停止
                </Button>
              ) : (
                <Button
                  variant="primary"
                  className="h-[60px] w-20"
                  data-testid="observe-send"
                  disabled={!input.trim()}
                  onClick={() => void submit()}
                >
                  {controlled ? '发送' : target === 'director' ? '下指令' : '说'}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>

      <aside className="flex w-80 shrink-0 flex-col gap-4 overflow-y-auto border-l border-line bg-panel/50 p-4">
        <PlotCard story={story} />
        <SceneCard world={world} scene={story.scene} time={story.time} />
        {lastBeat?.beat && <DirectorNotes world={world} e={lastBeat} story={story} />}
        <CastCard
          world={world}
          present={story.scene.presentCharacterIds}
          controlledId={view.playthrough.controlledId}
          disabled={!!busy}
          onWhisper={(id) => {
            setTarget(id);
            inputRef.current?.focus();
          }}
          onTakeover={takeover}
        />
        <BudgetCard view={view} status={status} />
        <SettingsCard
          settings={settings}
          onSave={async (next) => {
            try {
              const v = await engine.call('observerSettings', { ...ref, settings: next });
              setView(v);
              setStatus(v.observer);
              toast('ok', '设置已保存');
            } catch (err) {
              toast('err', errorMessage(err));
            }
          }}
        />
        <Card className={cx('p-4', !view.memory && 'opacity-70')}>
          <div className="mb-2 text-xs font-medium text-muted">前情提要</div>
          {view.memory ? (
            <Markdown text={view.memory.text} className="text-xs" />
          ) : (
            <p className="text-xs leading-relaxed text-faint">故事变长后，书记会把较早的内容整理成前情提要，并记下每个角色各自知道的事。</p>
          )}
        </Card>
      </aside>
    </div>
  );
}

// ───────────── 组件 ─────────────

function StatusPill({ status }: { status: ObserverStatus | null }) {
  if (!status) return null;
  const tone =
    status.activity === 'generating'
      ? 'text-accent-strong'
      : status.activity === 'backoff' || status.stopReason === 'errors'
        ? 'text-err'
        : status.stopReason === 'budget'
          ? 'text-warn'
          : 'text-faint';
  return (
    <span
      className={cx('flex shrink-0 items-center gap-1.5 text-xs whitespace-nowrap', tone)}
      data-testid="observe-status"
      data-activity={status.activity}
    >
      {status.activity === 'generating' && <Spinner />}
      {status.stopReason && !status.running ? { budget: '预算用完', errors: '已出错停下', takeover: '接管中' }[status.stopReason] : ACTIVITY_TEXT[status.activity]}
      {status.ahead > 0 && <span className="text-faint">· 缓冲 {status.ahead} 拍</span>}
    </span>
  );
}

function LiveArea({
  status,
  live,
  generating,
  instant,
  colorOf,
  onPlay,
}: {
  status: ObserverStatus | null;
  live: Live | null;
  generating: boolean;
  instant: boolean;
  colorOf: (id: string | null, name: string) => string | undefined;
  onPlay: () => void;
}) {
  if (generating) {
    const text = live?.phase === 'actor' ? `${live.name ?? '演员'}正在想怎么接…` : (PHASE_TEXT[live?.phase ?? ''] ?? '准备下一拍…');
    return (
      <div data-testid="observe-live">
        {instant && live?.segs.length ? <Segments segs={live.segs} colorOf={colorOf} /> : null}
        <div className="mt-2 flex items-center gap-2 text-sm text-faint">
          <Spinner /> {text}
        </div>
      </div>
    );
  }
  if (!status) return null;
  if (status.activity === 'throttled') {
    return <p className="text-sm text-faint">达到每分钟的生成上限，稍后自动继续。</p>;
  }
  if (status.activity === 'backoff') {
    return <p className="text-sm text-err">这一拍生成失败（第 {status.failures} 次），稍后自动重试：{status.lastError}</p>;
  }
  if (!status.running) {
    const reason = status.stopReason ? STOP_TEXT[status.stopReason] : null;
    return (
      <Card className="flex items-center gap-3 p-4 text-sm" data-testid="observe-stopped">
        <div className="min-w-0 flex-1">
          <div className={cx(status.stopReason === 'errors' ? 'text-err' : 'text-muted')}>{reason ?? '自动演出已暂停。'}</div>
          {status.stopReason === 'errors' && status.lastError && (
            <div className="mt-1 text-xs break-all text-faint">{status.lastError}</div>
          )}
          {status.stopReason === 'budget' && <div className="mt-1 text-xs text-faint">可以在右侧「设置」里提高预算后继续。</div>}
        </div>
        {status.stopReason !== 'takeover' && (
          <Button variant="primary" onClick={onPlay} data-testid="observe-play">
            ▶ {status.stopReason ? '重新开始' : '开始自动演出'}
          </Button>
        )}
      </Card>
    );
  }
  return null;
}

function PlotCard({ story }: { story: ReturnType<typeof storyAt> }) {
  const ch = story.chapter;
  return (
    <Card className="p-4" data-testid="observe-plot">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-muted">剧情进度</span>
        {story.total > 0 && (
          <span className="text-[11px] text-faint">
            {story.done.size}/{story.total} 个节拍
          </span>
        )}
      </div>
      {story.total > 0 && (
        <div className="mb-3 h-1 overflow-hidden rounded bg-panel-2">
          <div className="h-full bg-accent" style={{ width: `${Math.round((story.done.size / story.total) * 100)}%` }} />
        </div>
      )}
      {ch ? (
        <>
          <div className="text-sm font-medium">{ch.title || '当前章节'}</div>
          <p className="mt-0.5 text-xs leading-relaxed text-muted">{ch.goal}</p>
          <ul className="mt-2 space-y-1">
            {ch.beats.map((b) => (
              <li key={b.id} className={cx('flex gap-1.5 text-xs', story.done.has(b.id) ? 'text-faint line-through' : 'text-muted')}>
                <span className="shrink-0">{story.done.has(b.id) ? '✓' : '○'}</span>
                {b.text}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-xs text-faint">{story.total ? '骨架全部演完，导演会续写新的篇章。' : '这个世界没有剧情骨架，导演会自由发挥。'}</p>
      )}
    </Card>
  );
}

function SceneCard({ world, scene, time }: { world: WorldDetail; scene: SceneState; time: string | null }) {
  const loc = world.locations.find((l) => l.id === scene.locationId);
  return (
    <Card className="p-4">
      <div className="mb-2 text-xs font-medium text-muted">场景</div>
      <div className="text-sm font-medium">{loc?.name ?? '未指定地点'}</div>
      {time && <div className="mt-0.5 text-xs text-accent-strong">{time}</div>}
      {loc?.description && <p className="mt-1 text-xs leading-relaxed text-muted">{loc.description}</p>}
    </Card>
  );
}

function DirectorNotes({ world, e, story }: { world: WorldDetail; e: PlayEvent; story: ReturnType<typeof storyAt> }) {
  const b = e.beat;
  if (!b) return null;
  const name = (id: string) => world.characters.find((c) => c.id === id)?.name ?? id;
  const beatText = (id: string) => story.chapters.flatMap((c) => c.beats).find((x) => x.id === id)?.text ?? id;
  return (
    <Card className="p-4" data-testid="director-notes">
      <details>
        <summary className="cursor-pointer text-xs font-medium text-muted select-none">导演笔记（上一拍）</summary>
        <div className="mt-2 space-y-1.5 text-xs leading-relaxed text-muted">
          <p>{b.plan}</p>
          {b.arc && <p className="text-accent-strong">续写了新篇章：{b.arc.title}</p>}
          {b.card && <p>事件卡：{b.card}</p>}
          {b.done?.map((id) => (
            <p key={id} className="text-ok">
              ✓ {beatText(id)}
            </p>
          ))}
          {b.reveals?.map((r) => (
            <p key={r.characterId}>
              秘密揭开：{name(r.characterId)}的秘密被{r.to.map(name).join('、')}知道了
            </p>
          ))}
          {b.rejected?.length ? <p className="text-faint">驳回：{b.rejected.join('；')}</p> : null}
          <p className="text-faint">
            {b.strategy === 'split' ? '分演模式' : '合并模式'}
            {b.similarity !== undefined ? ` · 与之前的相似度 ${b.similarity}` : ''}
          </p>
        </div>
      </details>
    </Card>
  );
}

function CastCard({
  world,
  present,
  controlledId,
  disabled,
  onWhisper,
  onTakeover,
}: {
  world: WorldDetail;
  present: string[];
  controlledId: string | null;
  disabled: boolean;
  onWhisper: (id: string) => void;
  onTakeover: (id: string | null) => void;
}) {
  return (
    <Card className="p-4" data-testid="observe-cast">
      <div className="mb-2 text-xs font-medium text-muted">角色</div>
      <ul className="space-y-1.5">
        {world.characters.map((c) => (
          <li key={c.id} className="group flex items-center gap-2 text-sm">
            <span className={cx('size-1.5 shrink-0 rounded-full', present.includes(c.id) ? 'bg-ok' : 'bg-line-strong')} />
            <span className={cx('min-w-0 flex-1 truncate', present.includes(c.id) ? 'text-fg' : 'text-faint')}>{c.name}</span>
            {controlledId === c.id ? (
              <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onTakeover(null)}>
                交还
              </Button>
            ) : (
              <span className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onWhisper(c.id)}>
                  悄悄话
                </Button>
                <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onTakeover(c.id)} data-testid="takeover">
                  接管
                </Button>
              </span>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] leading-relaxed text-faint">绿点是当前在场的角色。接管后由你来演这个角色，自动演出会暂停。</p>
    </Card>
  );
}

function BudgetCard({ view, status }: { view: PlayView; status: ObserverStatus | null }) {
  const s = view.playthrough.observer;
  const u = view.playthrough.usage;
  const tokens = status?.budget.tokens ?? u.inputTokens + u.outputTokens;
  const currencies = Object.keys(u.costs);
  const cost = status?.budget.cost ?? 0;
  const pct = s?.budgetTokens ? Math.min(100, Math.round((tokens / s.budgetTokens) * 100)) : 0;
  return (
    <Card className="p-4" data-testid="observe-budget">
      <div className="mb-2 text-xs font-medium text-muted">用量与预算</div>
      <div className="flex items-baseline justify-between text-sm">
        <span>{formatTokens(tokens)} tokens</span>
        {s?.budgetTokens ? <span className="text-xs text-faint">上限 {formatTokens(s.budgetTokens)}</span> : null}
      </div>
      {s?.budgetTokens ? (
        <div className="mt-1.5 h-1 overflow-hidden rounded bg-panel-2">
          <div className={cx('h-full', pct >= 90 ? 'bg-warn' : 'bg-accent')} style={{ width: `${pct}%` }} />
        </div>
      ) : null}
      <div className="mt-2 text-xs text-faint">
        {status?.budget.calls ?? u.calls} 次调用
        {currencies.length ? ` · 花费 ${formatCost(cost, currencies[0] ?? 'CNY')}` : ''}
        {s?.budgetCost ? `（上限 ${formatCost(s.budgetCost, currencies[0] ?? 'CNY')}）` : ''}
      </div>
    </Card>
  );
}

function SettingsCard({ settings, onSave }: { settings: ObserverSettings; onSave: (s: Partial<ObserverSettings>) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(settings);
  useEffect(() => setDraft(settings), [settings]);
  const num = (v: string) => (v.trim() === '' ? 0 : Number(v));
  return (
    <Card className="p-4" data-testid="observe-settings">
      <button type="button" className="flex w-full items-center justify-between text-xs font-medium text-muted" onClick={() => setOpen(!open)}>
        设置
        <span className="font-normal text-faint">{open ? '收起' : '展开'}</span>
      </button>
      {open && (
        <div className="mt-3 space-y-3">
          <Field label="演出方式">
            <Select value={draft.strategy} onChange={(e) => setDraft({ ...draft, strategy: e.target.value as ObserverSettings['strategy'] })}>
              <option value="merged">合并：一次写出整拍（快、省）</option>
              <option value="split">分演：每个角色单独演（信息不对称更真实）</option>
            </Select>
          </Field>
          <Field label="视角">
            <Select value={draft.focus} onChange={(e) => setDraft({ ...draft, focus: e.target.value as ObserverSettings['focus'] })}>
              <option value="protagonist">围绕主角</option>
              <option value="ensemble">群像</option>
            </Select>
          </Field>
          <Field label="预生成几拍" hint="领先你的阅读进度多少拍；看得慢时会停下等你">
            <Input type="number" min={1} max={50} value={draft.bufferAhead} onChange={(e) => setDraft({ ...draft, bufferAhead: num(e.target.value) })} />
          </Field>
          <Field label="token 预算" hint="这个周目累计用到这么多就自动停下，0 表示不限">
            <Input type="number" min={0} step={100000} value={draft.budgetTokens} onChange={(e) => setDraft({ ...draft, budgetTokens: num(e.target.value) })} />
          </Field>
          <Field label="花费预算" hint="需要在接入点里填了价格才能统计，0 表示不限">
            <Input type="number" min={0} step={0.5} value={draft.budgetCost} onChange={(e) => setDraft({ ...draft, budgetCost: num(e.target.value) })} />
          </Field>
          <Field label="每分钟最多几拍" hint="0 表示不限">
            <Input type="number" min={0} value={draft.maxBeatsPerMinute} onChange={(e) => setDraft({ ...draft, maxBeatsPerMinute: num(e.target.value) })} />
          </Field>
          <Field label="连续失败几次后停下">
            <Input type="number" min={1} max={20} value={draft.maxFailures} onChange={(e) => setDraft({ ...draft, maxFailures: num(e.target.value) })} />
          </Field>
          <Button size="sm" variant="primary" onClick={() => void onSave(draft)}>
            保存
          </Button>
        </div>
      )}
    </Card>
  );
}
