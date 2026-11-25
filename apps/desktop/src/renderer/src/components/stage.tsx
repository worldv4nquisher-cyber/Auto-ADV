/**
 * VN 舞台的共用部件：剧情 ADV（pages/Adv.tsx）和观察模式的舞台看法（pages/ObserveStage.tsx）都用它们。
 * 画面由 @auto-adv/engine/stage 的时间线给出（每一步带着完整画面），这里只负责画出来。
 * testId 前缀 p 区分两个页面（adv-text / observe-text ……）。
 */
import type { StageStep, StageText, StageView, Timeline } from '@auto-adv/engine/stage';
import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import { BgImage, useAssetsContext, useSpriteUrl } from '../lib/assets.tsx';
import { useRouter } from '../lib/router.tsx';
import { PlaceholderCg, PlaceholderSprite } from './placeholder.tsx';
import { Button, cx } from './ui.tsx';

export const OUTCOME = { crit: '大成功', success: '成功', narrow: '险胜', fail: '失败' } as const;

const LONG = Number.MAX_SAFE_INTEGER;

/** 这一步要逐字显示的字数（不是文字的步骤为 0）。 */
export const textLength = (step: StageStep | undefined) => (step?.kind === 'text' ? [...(step.text?.text ?? '')].length : 0);

/**
 * 打字机：stepKey 换了就从头逐字显示，cps 是每秒几个字。instant 或 cps ≤ 0 时直接显示完整；
 * 已经打完的一步回来时不再重打。complete() 跳过打字；forget() 忘掉打完的记录（读档后重新打）。
 */
export function useTyping(stepKey: string, len: number, cps: number, instant: boolean) {
  // 打到第几个字，连同是哪一步的：换了一步、effect 还没跑的那一次渲染也不会把上一步的"打完了"算到这一步上
  const [st, setSt] = useState({ key: '', n: LONG });
  const doneKey = useRef('');
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const skip = instant || cps <= 0;
  useEffect(() => {
    if (!len) return;
    if (skip || doneKey.current === stepKey) {
      doneKey.current = stepKey;
      setSt({ key: stepKey, n: LONG });
      return;
    }
    setSt({ key: stepKey, n: 0 });
    let i = 0;
    const t = setInterval(() => {
      i += 1;
      setSt({ key: stepKey, n: i });
      if (i >= len) {
        clearInterval(t);
        doneKey.current = stepKey;
      }
    }, 1000 / cps);
    timer.current = t;
    return () => clearInterval(t);
  }, [stepKey, skip, cps]);
  const shown = st.key === stepKey ? st.n : skip || doneKey.current === stepKey ? LONG : 0;
  return {
    shown,
    typed: !len || shown >= len,
    complete: () => {
      if (timer.current) clearInterval(timer.current);
      doneKey.current = stepKey;
      setSt({ key: stepKey, n: LONG });
    },
    forget: () => {
      doneKey.current = '';
    },
  };
}

/** 一次性特效：震动。 */
export function useShake(stageRef: RefObject<HTMLDivElement | null>, step: StageStep | undefined, stepKey: string) {
  useEffect(() => {
    if (step?.cues?.some((c) => c.op === 'effect' && c.id === 'shake')) stageRef.current?.classList.add('stage-shake');
    const el = stageRef.current;
    const t = setTimeout(() => el?.classList.remove('stage-shake'), 500);
    return () => clearTimeout(t);
  }, [stepKey]);
}

/** 背景、立绘、CG 和闪白。 */
export function StageLayers({
  p,
  stage,
  step,
  stepKey,
  tint,
  dimAll,
}: {
  p: string;
  stage: StageView;
  step: StageStep | undefined;
  stepKey: string;
  tint: (id: string | null, name: string) => string;
  /** 所有立绘都暗下去（弹出选项时）。 */
  dimAll?: boolean;
}) {
  const speaker = step?.text?.speaker ?? null;
  return (
    <>
      {stage.bg ? (
        <div key={stage.bg.id} className={cx('absolute inset-0', stage.bg.transition !== 'none' && 'stage-fade')} data-testid={`${p}-bg`} data-bg={stage.bg.id}>
          <BgImage id={stage.bg.id} testId={`${p}-bg-image`} />
        </div>
      ) : (
        <div className="absolute inset-0 bg-[#07080c]" />
      )}
      {stage.sprites.map((s) => (
        <div
          key={s.key}
          data-testid={`${p}-sprite`}
          data-char={s.characterId ?? s.name}
          data-x={s.x}
          className="stage-rise absolute bottom-0 h-[86%] transition-[left] duration-500"
          style={{ left: `${s.x}%`, transform: 'translateX(-50%)' }}
        >
          <SpriteImage
            p={p}
            characterId={s.characterId}
            name={s.name}
            expr={s.expr}
            color={tint(s.characterId, s.name)}
            dim={dimAll || (!!speaker && step?.text?.kind === 'say' && speaker.characterId !== s.characterId)}
          />
        </div>
      ))}
      {stage.cg && (
        <div key={stage.cg} className="stage-fade absolute inset-0" data-testid={`${p}-cg`}>
          <PlaceholderCg id={stage.cg} />
        </div>
      )}
      {step?.cues?.some((c) => c.op === 'effect' && c.id === 'flash') && (
        <div key={`flash${stepKey}`} className="stage-flash pointer-events-none absolute inset-0 bg-white" />
      )}
    </>
  );
}

/** 立绘：画好了用真的图（表情还没画好先用平静的），没有就用占位的剪影（18.6）。 */
function SpriteImage({
  p,
  characterId,
  name,
  expr,
  color,
  dim,
}: {
  p: string;
  characterId: string | null;
  name: string;
  expr: string;
  color: string;
  dim: boolean;
}) {
  const url = useSpriteUrl(characterId, expr);
  if (!url) return <PlaceholderSprite name={name} expr={expr} color={color} dim={dim} />;
  return (
    <img
      key={url}
      src={url}
      alt={name}
      draggable={false}
      data-testid={`${p}-sprite-image`}
      data-expr={expr}
      className={cx(
        'stage-fade h-full w-auto max-w-none object-contain object-bottom drop-shadow-[0_0_18px_rgba(0,0,0,.35)] transition-[filter] duration-300 select-none',
        dim && 'brightness-[.6] saturate-[.7]',
      )}
    />
  );
}

/** 音效、语音、视频、特效的提示（素材还没有）。 */
/** 舞台顶部的素材进度（18.3）："素材 12 / 30"，点开是世界页的素材标签。画完了就不显示。 */
export function AssetProgress({ p }: { p: string }) {
  const ctx = useAssetsContext();
  const { navigate } = useRouter();
  const v = ctx?.view;
  if (!ctx || !v || v.counts.total === 0) return null;
  const { done, total, failed } = v.counts;
  if (done >= total && !v.state.working) return null;
  const note = v.state.needsModel ? '没配图像模型' : v.state.cap.reached ? '到了图片上限' : v.state.paused ? '已暂停' : failed ? `${failed} 张失败` : '';
  return (
    <button
      type="button"
      data-testid={`${p}-assets`}
      className="pointer-events-auto rounded bg-black/40 px-[0.7em] py-[0.25em] text-white/70 hover:bg-black/60 hover:text-white"
      title="打开素材页"
      onClick={(e) => {
        e.stopPropagation();
        navigate({ page: 'world', worldId: ctx.worldId, tab: 'assets' });
      }}
    >
      素材 {done} / {total}
      {note && <span className="ml-[0.5em] text-white/50">{note}</span>}
    </button>
  );
}

export function CueTags({ step, stepKey }: { step: StageStep | undefined; stepKey: string }) {
  return (
    <>
      {step?.cues
        ?.filter((c) => !(c.op === 'effect' && (c.id === 'shake' || c.id === 'flash')))
        .map((c, i) => (
          <span key={`${stepKey}${i}`} className="stage-float rounded bg-black/50 px-[0.7em] py-[0.2em] text-white/70">
            {{ sfx: '♪ 音效', voice: '🎙 语音', video: '▶ 视频', effect: '✦ 特效' }[c.op]}：{c.id}
          </span>
        ))}
    </>
  );
}

/** 进入新一幕的标题卡。 */
export function StageCard({ p, step, stepKey }: { p: string; step: StageStep | undefined; stepKey: string }) {
  if (step?.kind !== 'card' || !step.card) return null;
  return (
    <div key={stepKey} className="stage-fade-fast absolute inset-0 flex flex-col items-center justify-center gap-[1.2cqw] bg-black/92">
      {step.card.chapter && <div className="text-[max(12px,1.3cqw)] tracking-[0.5em] text-white/55">{step.card.chapter}</div>}
      <div className="text-[max(20px,3cqw)] font-semibold tracking-[0.2em]" data-testid={`${p}-card`}>
        {step.card.title}
      </div>
    </div>
  );
}

/** 检定结果。 */
export function StageCheck({
  p,
  step,
  stepKey,
  varLabel,
}: {
  p: string;
  step: StageStep | undefined;
  stepKey: string;
  varLabel: (id: string) => string;
}) {
  if (step?.kind !== 'check' || !step.check) return null;
  const c = step.check;
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/45">
      <div
        key={stepKey}
        className="stage-fade-fast flex min-w-[34%] flex-col items-center gap-[0.6cqw] rounded-[1cqw] border border-white/15 bg-[#11131b]/90 px-[3cqw] py-[2cqw] text-center"
        data-testid={`${p}-check`}
      >
        <div className="text-[max(12px,1.2cqw)] text-white/60">🎲 检定 · {c.label}</div>
        <div className="text-[max(28px,5cqw)] leading-none font-semibold">{c.total}</div>
        <div className="text-[max(11px,1cqw)] text-white/55">
          d20 = {c.roll}
          {c.var ? ` ${c.modifier >= 0 ? '+' : '-'} ${Math.abs(c.modifier)}（${varLabel(c.var)}）` : ''}
          ，难度 {c.dc}
        </div>
        <div
          className={cx(
            'mt-[0.4cqw] text-[max(14px,1.8cqw)] font-semibold',
            c.outcome === 'fail' ? 'text-err' : c.outcome === 'crit' ? 'text-warn' : 'text-ok',
          )}
        >
          {OUTCOME[c.outcome]}
        </div>
      </div>
    </div>
  );
}

/** 文本框：名字牌、逐字显示的文字、底下一行（左边状态、右边工具栏）。 */
export function StageTextBox({
  p,
  text,
  shown,
  typed,
  tint,
  extra,
  status,
  toolbar,
}: {
  p: string;
  /** 要显示的文字；为 null 时文本框里只有 extra。 */
  text: StageText | null;
  shown: number;
  typed: boolean;
  tint: (id: string | null, name: string) => string;
  /** 文字后面附加的内容（占位、错误、生成进度）。 */
  extra?: ReactNode;
  status?: ReactNode;
  toolbar: ReactNode;
}) {
  const speaker = text?.speaker ?? null;
  return (
    <div className="absolute inset-x-[3%] bottom-[3%] h-[27%]">
      {speaker && (
        <div
          className="absolute -top-[1.1em] left-[2.5%] z-10 rounded-[0.4em] px-[0.9em] py-[0.25em] text-[max(12px,1.35cqw)] font-semibold shadow"
          style={{ background: tint(speaker.characterId, speaker.name), color: '#11131b' }}
          data-testid={`${p}-name`}
        >
          {speaker.name}
        </div>
      )}
      <div className="flex h-full flex-col rounded-[1cqw] border border-white/12 bg-[#0b0d14]/78 px-[2.6%] pt-[2.2%] pb-[1.2%] backdrop-blur-sm">
        <div
          className={cx(
            'flex-1 overflow-hidden text-[max(14px,1.65cqw)] leading-[1.75]',
            text?.kind === 'narrate' && 'text-white/88',
            text?.kind === 'think' && 'text-[#c7c2ff]/90',
          )}
          data-testid={`${p}-text`}
        >
          {text && (
            <>
              {text.kind === 'think' ? '（' : text.kind === 'say' ? '「' : ''}
              {[...text.text].slice(0, shown).join('')}
              {typed && (text.kind === 'think' ? '）' : text.kind === 'say' ? '」' : '')}
            </>
          )}
          {extra}
        </div>
        <div className="flex items-center justify-between text-[max(11px,0.95cqw)] text-white/55">
          <span className="flex items-center gap-2">{status}</span>
          {toolbar}
        </div>
      </div>
    </div>
  );
}

export function ToolButton({
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

/** 盖在舞台上的面板。点面板外面不关（免得误触继续剧情），用右上角或 Esc 关。 */
export function Overlay({
  p,
  title,
  children,
  onClose,
  testId,
}: {
  p: string;
  title: string;
  children: ReactNode;
  onClose: () => void;
  testId: string;
}) {
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
        <Button variant="ghost" size="sm" onClick={onClose} data-testid={`${p}-panel-close`}>
          关闭
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">{children}</div>
    </div>
  );
}

/** 回想：播过的台词、选择、检定、换幕，以及观众留下的导演指令和悄悄话。 */
export function Backlog({
  p,
  timeline,
  cursor,
  colorOf,
  busy,
  onRewind,
}: {
  p: string;
  timeline: Timeline;
  cursor: number;
  colorOf: (id: string | null, name: string) => string | undefined;
  busy: boolean;
  /** 选择旁边的"回到这里重新选"；不给就不显示。 */
  onRewind?: (eventId: string) => void;
}) {
  const end = useRef<HTMLDivElement>(null);
  // 新版 Chromium 的 scrollIntoView 返回 Promise，不能直接当作 effect 的返回值（React 会把它当清理函数调用）
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, []);
  // 播到最后一步时，记在最后一步之后的东西（刚做的选择、跑偏时的选择）也显示出来
  const entries = timeline.backlog.filter((b) => b.step <= cursor || cursor >= timeline.steps.length - 1);
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
        if (b.kind === 'note') {
          return (
            <div key={i} className="rounded-lg border border-dashed border-line-strong px-3 py-1.5 text-sm text-muted" data-testid={`${p}-backlog-note`}>
              <span className="mr-2 text-xs text-accent-strong">{b.label}</span>
              {b.text}
            </div>
          );
        }
        if (b.kind === 'choice') {
          return (
            <div key={i} className="flex items-center justify-between gap-3 rounded-lg border border-accent/25 bg-accent-soft px-3 py-1.5 text-sm">
              <span>▶ 你选了：{b.label}</span>
              {b.rewindTo && onRewind && (
                <Button size="sm" variant="ghost" disabled={busy} data-testid={`${p}-rewind`} onClick={() => onRewind(b.rewindTo as string)}>
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
