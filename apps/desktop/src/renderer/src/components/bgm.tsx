import { useEffect, useRef, useState } from 'react';
import { type BgmChoice, useBgmChoice } from '../lib/assets.tsx';

/**
 * 舞台的 BGM（18.7）：换曲时淡出淡入；能循环的曲子（音乐模型生成的）循环放，
 * 不能循环的（内置曲库、本地曲库）放完淡出、停几秒，再放同一情绪的下一首。
 */

const MUTED_KEY = 'auto-adv.bgm.muted';
const STEP_MS = 50;

type Track = BgmChoice['tracks'][number];

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTED_KEY) === '1';
  } catch {
    return false;
  }
}

/** 管两条音轨：换曲时旧的淡出、新的淡入。 */
class Deck {
  private cur: HTMLAudioElement | null = null;
  private list: Track[] = [];
  private index = 0;
  private gapTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly fades = new Map<HTMLAudioElement, ReturnType<typeof setInterval>>();
  volume = 0.6;
  fadeMs = 2000;
  gapMs = 3000;
  onTrack: (t: Track | null) => void = () => {};

  /** 换一组曲子。正在放的曲子还在新的一组里就接着放（比如生成好了一首新的，等这首放完再轮到它）。 */
  play(list: Track[]) {
    const playing = this.cur ? this.list[this.index] : undefined;
    const keep = playing ? list.findIndex((t) => t.url === playing.url) : -1;
    this.list = list;
    if (keep >= 0) {
      this.index = keep;
      if (this.cur) this.cur.loop = list[keep]?.loop ?? false;
      return;
    }
    this.clearGap();
    this.fadeOut();
    this.index = 0;
    this.start();
  }

  stop() {
    this.clearGap();
    this.list = [];
    this.fadeOut();
    this.onTrack(null);
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.cur && !this.fades.has(this.cur)) this.cur.volume = v;
  }

  dispose() {
    this.clearGap();
    for (const [el, t] of this.fades) {
      clearInterval(t);
      el.pause();
    }
    this.fades.clear();
    this.cur?.pause();
    this.cur = null;
  }

  private start() {
    const t = this.list[this.index];
    if (!t) {
      this.cur = null;
      this.onTrack(null);
      return;
    }
    const el = new Audio(t.url);
    el.loop = t.loop;
    el.volume = 0;
    el.onended = () => {
      if (this.cur !== el) return;
      // 不循环的曲子放完了：停几秒，放下一首
      this.cur = null;
      this.gapTimer = setTimeout(() => {
        this.gapTimer = null;
        if (!this.list.length) return;
        this.index = (this.index + 1) % this.list.length;
        this.start();
      }, this.gapMs);
    };
    el.onerror = () => {
      if (this.cur === el) console.warn('[bgm] 放不了这首：', t.url);
    };
    this.cur = el;
    void el.play().catch(() => {
      // 没有声卡、文件坏了：不影响游玩
    });
    this.fade(el, this.volume);
    this.onTrack(t);
  }

  private fadeOut() {
    const el = this.cur;
    this.cur = null;
    if (el) this.fade(el, 0, () => el.pause());
  }

  private fade(el: HTMLAudioElement, to: number, done?: () => void) {
    const old = this.fades.get(el);
    if (old) clearInterval(old);
    const from = el.volume;
    const steps = Math.max(1, Math.round(this.fadeMs / STEP_MS));
    let i = 0;
    if (this.fadeMs <= 0) {
      el.volume = to;
      done?.();
      return;
    }
    const timer = setInterval(() => {
      i += 1;
      el.volume = Math.min(1, Math.max(0, from + ((to - from) * i) / steps));
      if (i >= steps) {
        clearInterval(timer);
        this.fades.delete(el);
        done?.();
      }
    }, STEP_MS);
    this.fades.set(el, timer);
  }

  private clearGap() {
    if (this.gapTimer) clearTimeout(this.gapTimer);
    this.gapTimer = null;
  }
}

export interface StageBgmState {
  id: string | null;
  choice: BgmChoice | null;
  /** 正在放的曲子。 */
  track: Track | null;
  muted: boolean;
  toggleMute: () => void;
}

/**
 * 按舞台上的 bgm 放曲子。id 是这一步画面里的 bgm（情绪 id 或者手写剧本里写的 id）。
 * 在页面上调用（不要放进会隐藏的层里，隐藏文本框时音乐不停）；没有素材上下文（AssetsProvider）时什么都不放。
 */
export function useStageBgm(id: string | null): StageBgmState {
  const { choice, settings } = useBgmChoice(id);
  const deck = useRef<Deck | null>(null);
  const [track, setTrack] = useState<Track | null>(null);
  const [muted, setMuted] = useState(readMuted);
  deck.current ??= new Deck();

  useEffect(() => {
    const d = deck.current;
    if (d) d.onTrack = setTrack;
    return () => d?.dispose();
  }, []);

  useEffect(() => {
    const d = deck.current;
    if (!d || !settings) return;
    d.fadeMs = settings.fadeSeconds * 1000;
    d.gapMs = settings.gapSeconds * 1000;
    d.setVolume(muted ? 0 : settings.volume / 100);
  }, [settings?.fadeSeconds, settings?.gapSeconds, settings?.volume, muted]);

  // 曲子一样就不打断（素材推送很频繁，每次都会给一份新的列表）
  const key = choice ? choice.tracks.map((t) => `${t.url}#${t.loop ? 1 : 0}`).join('|') : '';
  useEffect(() => {
    const d = deck.current;
    if (!d) return;
    if (!choice || !choice.tracks.length) d.stop();
    else d.play(choice.tracks);
  }, [key]);

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    try {
      localStorage.setItem(MUTED_KEY, next ? '1' : '0');
    } catch {
      // 存不了就只在这次生效
    }
  };
  return { id, choice, track, muted, toggleMute };
}

/** 舞台角上的"正在放什么"，点一下静音。 */
export function BgmTag({ bgm, className }: { bgm: StageBgmState; className?: string }) {
  const { id, choice, track, muted } = bgm;
  if (!id) return null;
  const label = choice ? (track ? `${choice.name} · ${track.title}` : choice.tracks.length ? choice.name : `${choice.name}（还没有曲子）`) : id;
  return (
    <button
      type="button"
      data-testid="stage-bgm"
      data-bgm={id}
      data-mood={choice?.mood ?? ''}
      data-src={track?.url ?? ''}
      title={muted ? '点一下打开音乐' : '点一下静音'}
      className={className}
      onClick={(e) => {
        e.stopPropagation();
        bgm.toggleMute();
      }}
    >
      {muted ? '🔇' : '♫'} {label}
    </button>
  );
}
