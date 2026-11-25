/**
 * 舞台的配音（18.8）：每一句台词换上来时找引擎要这句的语音（有缓存直接用，没有就生成），
 * 生成好之前文本框先等一会儿（最多 HOLD_MAX），开始放了再按语音的长短逐字显示；
 * 同时预取后面几句。换一句、快进、离开舞台时停掉正在放的。回想里可以重播。
 *
 * 谁配音由配音表决定（引擎的 voice/service.ts）：这里按配音表先判断一遍，不配音的句子不发请求、也不等。
 */
import type { VoiceCastView, VoiceLineParams, VoiceLineResult } from '@auto-adv/engine/api';
import type { StageStep } from '@auto-adv/engine/stage';
import { useEffect, useRef, useState } from 'react';
import { assetUrl, useAssetsContext } from '../lib/assets.tsx';
import { engine, errorMessage, onConnectionChange } from '../lib/engine.ts';
import { useSettings } from '../lib/settings.tsx';

/** 语音还没生成好时，文本框最多等这么久就先打字（语音到了再放）。 */
const HOLD_MAX = 2500;
/** 打字比语音稍快一点，留出句尾的停顿。 */
const TYPE_SHARE = 0.85;
const MUTED_KEY = 'auto-adv.voice.muted';

export type VoiceStatus = 'off' | 'loading' | 'playing' | 'ended' | 'error';

/** 舞台上的一步要念的一句；不是台词的步骤为 null。表情取说话人在这一步的立绘表情。 */
export function lineOf(step: StageStep | undefined): VoiceLineParams | null {
  if (step?.kind !== 'text' || !step.text) return null;
  const t = step.text;
  const sp = t.speaker;
  const sprite = sp ? step.view.sprites.find((s) => (sp.characterId ? s.characterId === sp.characterId : s.name === sp.name)) : undefined;
  return {
    speaker: sp ? { characterId: sp.characterId, name: sp.name } : null,
    kind: t.kind,
    text: t.text,
    expr: sprite?.expr ?? null,
  };
}

/** 和引擎一样：只有标点、省略号的台词不念。 */
const speakable = (text: string) => /[\p{L}\p{N}]/u.test(text);

/** 这一句配不配音（和引擎 VoiceService 的判断一致）。 */
export function isVoiced(cast: VoiceCastView | null, line: VoiceLineParams | null): boolean {
  if (!cast?.ready || !line || !speakable(line.text)) return false;
  const sp = line.speaker;
  if (!sp || line.kind === 'narrate') return cast.narrator.enabled && !!cast.narrator.voiceId;
  const c = sp.characterId ? cast.characters.find((x) => x.id === sp.characterId) : undefined;
  if (!c) return !!cast.extra.voiceId;
  return c.enabled && !!c.voiceId;
}

/**
 * 当前世界的配音表。素材设置（语音开关、谁配音）或语音职责变了就重新拿；
 * 语音关着、没配语音职责时不找引擎要（为 null）。第一次拿可能要等文本模型分配音色。
 */
export function useVoiceCast(): VoiceCastView | null {
  const ctx = useAssetsContext();
  const { settings } = useSettings();
  const eff = ctx?.view?.settings.effective;
  const route = settings?.media.voice ?? null;
  const on = !!ctx && !!eff?.enabled.voice && !!route;
  const key = on ? JSON.stringify([ctx.worldId, eff.voice, eff.characters, route]) : '';
  const [cast, setCast] = useState<VoiceCastView | null>(null);
  const [epoch, setEpoch] = useState(0);
  useEffect(() => onConnectionChange((ok) => ok && setEpoch((n) => n + 1)), []);
  useEffect(() => {
    if (!key || !ctx) {
      setCast(null);
      return;
    }
    let alive = true;
    engine
      .call('voiceCast', { worldId: ctx.worldId })
      .then((v) => alive && setCast(v))
      .catch((err) => alive && console.warn('[voice] 读不到配音表：', errorMessage(err)));
    return () => {
      alive = false;
    };
  }, [key, epoch]);
  return key && cast?.worldId === ctx?.worldId ? cast : null;
}

/** 这台电脑上放不放配音（舞台工具栏上的开关）。关掉时也不生成。 */
export function useVoiceMuted(): [boolean, () => void] {
  const [muted, setMuted] = useState(() => {
    try {
      return localStorage.getItem(MUTED_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggle = () => {
    const next = !muted;
    setMuted(next);
    try {
      localStorage.setItem(MUTED_KEY, next ? '1' : '0');
    } catch {
      // 存不了就只在这次生效
    }
  };
  return [muted, toggle];
}

export interface StageVoice {
  /** 这个世界能配音（配音表准备好了）。 */
  available: boolean;
  muted: boolean;
  toggleMute: () => void;
  /** 当前这一句的语音：off 不配音，loading 在生成，playing 在放，ended 放完了，error 出错了。 */
  status: VoiceStatus;
  /** 正在放的这句有多长（按播放倍速算过）；还不知道为 null。 */
  durationMs: number | null;
  /** 先别打字：语音还在生成（最多等 HOLD_MAX）。 */
  hold: boolean;
  error: string | null;
  /** 回想里：这一步配不配音、重播。 */
  voiced: (step: StageStep | undefined) => boolean;
  replay: (step: StageStep | undefined) => void;
}

interface PlayState {
  key: string;
  status: VoiceStatus;
  durationMs: number | null;
  error: string | null;
}

/**
 * 舞台的配音。steps / cursor 是时间线和播到的位置，stepKey 是这一步的标识（和打字机用的一样）。
 * active 为 false 时不配音（快进、即时模式）；rate 是播放倍速（观察模式的倍速）。
 */
export function useStageVoice({
  steps,
  cursor,
  stepKey,
  active,
  rate = 1,
}: {
  steps: StageStep[];
  cursor: number;
  stepKey: string;
  active: boolean;
  rate?: number;
}): StageVoice {
  const ctx = useAssetsContext();
  const worldId = ctx?.worldId ?? null;
  const settings = ctx?.view?.settings.effective.voice;
  const volume = (settings?.volume ?? 80) / 100;
  const prefetch = settings?.prefetch ?? 2;
  const cast = useVoiceCast();
  const [muted, toggleMute] = useVoiceMuted();
  const castKey = cast ? JSON.stringify(cast) : '';
  const cache = useRef(new Map<string, Promise<VoiceLineResult | null>>());
  const audio = useRef<HTMLAudioElement | null>(null);
  const [st, setSt] = useState<PlayState>({ key: '', status: 'off', durationMs: null, error: null });
  const [late, setLate] = useState('');

  const step = steps[cursor];
  const line = lineOf(step);
  const want = active && !muted && !!worldId && isVoiced(cast, line);

  // 配音表变了（换了音色、开关），之前要的语音不能再用
  useEffect(() => cache.current.clear(), [castKey]);

  const request = (l: VoiceLineParams): Promise<VoiceLineResult | null> => {
    const k = JSON.stringify(l);
    let p = cache.current.get(k);
    if (!p && worldId) {
      p = engine.call('voiceLine', { worldId, line: l });
      // 失败的不记住：下次轮到这句时再试一次
      p.catch(() => cache.current.delete(k));
      cache.current.set(k, p);
    }
    return p ?? Promise.resolve(null);
  };

  const stop = () => {
    const el = audio.current;
    audio.current = null;
    el?.pause();
  };

  /** 放一个文件。key 是这一步的标识；回想里重播用 'replay'，不改这一步的状态。 */
  const play = (r: VoiceLineResult, key: string) => {
    if (!worldId) return;
    stop();
    const el = new Audio(assetUrl(worldId, r.file));
    el.volume = volume;
    el.playbackRate = rate;
    audio.current = el;
    const mine = () => audio.current === el;
    const update = (s: Omit<PlayState, 'key'>) => key !== 'replay' && setSt({ key, ...s });
    el.onended = () => {
      if (!mine()) return;
      audio.current = null;
      update({ status: 'ended', durationMs: null, error: null });
    };
    el.onerror = () => {
      if (!mine()) return;
      audio.current = null;
      update({ status: 'error', durationMs: null, error: '放不了这句语音' });
    };
    void el
      .play()
      .then(() => {
        if (!mine()) return;
        const ms = Number.isFinite(el.duration) && el.duration > 0 ? el.duration * 1000 : r.durationMs;
        update({ status: 'playing', durationMs: ms ? ms / rate : null, error: null });
      })
      .catch((err: unknown) => {
        if (!mine()) return;
        audio.current = null;
        update({ status: 'error', durationMs: null, error: errorMessage(err) });
      });
  };

  // 换了一句：停掉上一句，要这一句的语音
  useEffect(() => {
    stop();
    if (!want || !line) {
      setSt({ key: stepKey, status: 'off', durationMs: null, error: null });
      return;
    }
    let alive = true;
    setSt({ key: stepKey, status: 'loading', durationMs: null, error: null });
    const t = setTimeout(() => alive && setLate(stepKey), HOLD_MAX);
    request(line)
      .then((r) => {
        if (!alive) return;
        if (r) play(r, stepKey);
        else setSt({ key: stepKey, status: 'off', durationMs: null, error: null });
      })
      .catch((err: unknown) => {
        if (!alive) return;
        console.warn('[voice] 这句没念成：', errorMessage(err));
        setSt({ key: stepKey, status: 'error', durationMs: null, error: errorMessage(err) });
      });
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [stepKey, want, castKey]);

  // 预取后面几句（新的一拍演出来、步骤变多了也补上）
  useEffect(() => {
    if (!active || muted || !worldId || !cast?.ready) return;
    let n = 0;
    for (let i = cursor + 1; i < steps.length && n < prefetch; i++) {
      const l = lineOf(steps[i]);
      if (!l || !isVoiced(cast, l)) continue;
      n++;
      request(l).catch(() => {});
    }
  }, [stepKey, steps.length, castKey, active, muted, prefetch]);

  // 音量、倍速改了：正在放的跟着变
  useEffect(() => {
    if (audio.current) {
      audio.current.volume = volume;
      audio.current.playbackRate = rate;
    }
  }, [volume, rate]);

  // 离开舞台
  useEffect(() => stop, []);

  const cur: PlayState = st.key === stepKey ? st : { key: stepKey, status: want ? 'loading' : 'off', durationMs: null, error: null };
  return {
    available: !!cast?.ready,
    muted,
    toggleMute: () => {
      if (!muted) stop();
      toggleMute();
    },
    status: cur.status,
    durationMs: cur.durationMs,
    hold: want && cur.status === 'loading' && late !== stepKey,
    error: cur.error,
    voiced: (s) => !!worldId && isVoiced(cast, lineOf(s)),
    replay: (s) => {
      const l = lineOf(s);
      if (!l || !isVoiced(cast, l)) return;
      // 正在放的这一步的语音停掉，算它放完了（不然自动播放会一直等）
      setSt((x) => (x.status === 'playing' || x.status === 'loading' ? { ...x, status: 'ended' } : x));
      request(l)
        .then((r) => r && play(r, 'replay'))
        .catch((err: unknown) => console.warn('[voice] 重播失败：', errorMessage(err)));
    },
  };
}

/** 打字的速度跟着语音走：在语音的长度里打完（不比设置的文字速度快）。cps ≤ 0 是瞬间显示，不变。 */
export function voiceCps(cps: number, len: number, voice: StageVoice): number {
  if (cps <= 0 || !len || voice.status !== 'playing' || !voice.durationMs) return cps;
  return Math.min(cps, Math.max(4, len / ((voice.durationMs * TYPE_SHARE) / 1000)));
}

/** 文本框底下的配音状态：生成中、在放、出错。 */
export function VoiceTag({ p, voice }: { p: string; voice: StageVoice }) {
  const label = { off: '', loading: '🎙…', playing: '🎙', ended: '', error: '🎙✕' }[voice.status];
  return (
    <span
      data-testid={`${p}-voice`}
      data-status={voice.status}
      title={voice.status === 'loading' ? '语音生成中' : voice.status === 'error' ? `这句没念成：${voice.error ?? ''}` : undefined}
      className={voice.status === 'error' ? 'text-err/80' : 'text-white/60'}
    >
      {label}
    </span>
  );
}
