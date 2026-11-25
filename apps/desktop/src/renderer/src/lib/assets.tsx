import type { AssetsView, BgmTrack } from '@auto-adv/engine/api';
import { moodOf } from '@auto-adv/engine/stage';
import type { BgmSettings, ExpressionDef, MoodDef } from '@auto-adv/schema';
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { PlaceholderBg } from '../components/placeholder.tsx';
import { engine, isAborted, onConnectionChange } from './engine.ts';

/** 世界里的素材文件的地址（主进程的 adv-asset 协议，只能读世界的 assets/）。 */
export function assetUrl(worldId: string, file: string): string {
  return `adv-asset://world/${encodeURIComponent(worldId)}/${file.split('/').map(encodeURIComponent).join('/')}`;
}

/** BGM 曲子的地址：世界里的文件、本地曲库里的文件、内置曲库里的文件（主进程按世界的设置找曲库文件夹）。 */
export function bgmUrl(worldId: string, t: BgmTrack): string {
  const rel = t.ref.path.split('/').map(encodeURIComponent).join('/');
  if (t.ref.kind === 'world') return assetUrl(worldId, t.ref.path);
  if (t.ref.kind === 'library') return `adv-asset://library/${encodeURIComponent(worldId)}/${rel}`;
  return `adv-asset://builtin/${rel}`;
}

/** 订阅一个世界的素材：先拿到当前状态，之后每次变化都会更新。引擎重启后自动重新订阅。 */
export function useAssets(worldId: string | null): AssetsView | null {
  const [view, setView] = useState<AssetsView | null>(null);
  const [epoch, setEpoch] = useState(0);
  useEffect(() => onConnectionChange((ok) => ok && setEpoch((n) => n + 1)), []);
  useEffect(() => {
    if (!worldId) return;
    const ctrl = new AbortController();
    void engine
      .stream('assetsWatch', { worldId }, (c) => setView(c.view), ctrl.signal)
      .catch((err) => {
        if (!isAborted(err) && !ctrl.signal.aborted) console.error('[assets] 订阅失败：', err);
      });
    return () => ctrl.abort();
  }, [worldId, epoch]);
  return view && view.worldId === worldId ? view : null;
}

interface AssetsState {
  worldId: string;
  view: AssetsView | null;
  /** 槽 id → 文件地址。 */
  urls: Map<string, string>;
}

const AssetsContext = createContext<AssetsState | null>(null);

/** 舞台和存档缩略图用：在这里面按槽 id 找素材文件。 */
export function AssetsProvider({ worldId, children }: { worldId: string; children: ReactNode }) {
  const view = useAssets(worldId);
  const urls = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of view?.slots ?? []) if (s.file) m.set(s.id, assetUrl(worldId, s.file));
    return m;
  }, [view, worldId]);
  return <AssetsContext.Provider value={{ worldId, view, urls }}>{children}</AssetsContext.Provider>;
}

export function useAssetsContext() {
  return useContext(AssetsContext);
}

/** 某个槽现在的文件地址；还没画好就是 null。 */
export function useAssetUrl(slotId: string): string | null {
  return useContext(AssetsContext)?.urls.get(slotId) ?? null;
}

/** 背景：画好了用真的图，没有就用占位图（18.6）。id 是地点 id。 */
export function BgImage({ id, testId }: { id: string; testId?: string }) {
  const url = useAssetUrl(`bg/${id}`);
  if (!url) return <PlaceholderBg id={id} label={false} />;
  return (
    <img
      src={url}
      alt=""
      draggable={false}
      data-testid={testId}
      className="absolute inset-0 h-full w-full object-cover select-none"
    />
  );
}

/** 立绘的文件地址：这个表情还没画好时先用基础立绘（平静），都没有就是 null（18.6）。 */
export function useSpriteUrl(characterId: string | null, expr: string): string | null {
  const urls = useContext(AssetsContext)?.urls;
  if (!urls || !characterId) return null;
  return urls.get(`sprite/${characterId}/${expr}`) ?? urls.get(`sprite/${characterId}/neutral`) ?? null;
}

/** 这个世界的表情表（观察模式的舞台按它从台词前的括号里认表情）。内容不变时引用也不变，免得舞台每次推送都重算。 */
export function useExpressionTable(): ExpressionDef[] | null {
  const table = useContext(AssetsContext)?.view?.settings.effective.expressions;
  const key = table ? JSON.stringify(table) : '';
  return useMemo(() => (key ? (JSON.parse(key) as ExpressionDef[]) : null), [key]);
}

/** 这个世界的情绪表和换曲规则（舞台按导演报告的情绪换曲，18.7）。内容不变时引用也不变。BGM 关掉了为 null。 */
export function useBgmRules(): { moods: MoodDef[]; switchBeats: number } | null {
  const eff = useContext(AssetsContext)?.view?.settings.effective;
  const key = eff?.enabled.bgm ? JSON.stringify([eff.bgm.moods, eff.bgm.switchBeats]) : '';
  return useMemo(() => {
    if (!key) return null;
    const [moods, switchBeats] = JSON.parse(key) as [MoodDef[], number];
    return { moods, switchBeats };
  }, [key]);
}

export interface BgmChoice {
  /** 舞台上 bgm 的 id（情绪 id，或者手写剧本里写的 id）。 */
  id: string;
  /** 认成了哪个情绪；按文件名直接找到曲子时为 null。 */
  mood: string | null;
  name: string;
  tracks: { url: string; title: string; loop: boolean }[];
}

/**
 * 舞台上的 bgm id 放哪些曲子：手写剧本里写的 id 先按文件名找本地曲库和内置曲库，
 * 再按情绪表认（认不出来用第一个情绪）；情绪 id 就是这个情绪现在的曲子（18.7）。
 */
export function useBgmChoice(id: string | null): { choice: BgmChoice | null; settings: BgmSettings | null } {
  const ctx = useContext(AssetsContext);
  const view = ctx?.view;
  const settings = view?.settings.effective.enabled.bgm ? view.settings.effective.bgm : null;
  const choice = useMemo(() => {
    if (!id || !view || !ctx || !settings) return null;
    const named = view.bgm.named[id.toLowerCase()];
    if (named && !settings.moods.some((m) => m.id === id)) {
      return { id, mood: null, name: named.title, tracks: [{ url: bgmUrl(ctx.worldId, named), title: named.title, loop: named.loop }] };
    }
    const mood = moodOf(id, settings.moods) ?? settings.moods[0]?.id ?? null;
    const list = view.bgm.playlists.find((p) => p.mood === mood);
    if (!mood || !list) return null;
    return { id, mood, name: list.name, tracks: list.tracks.map((t) => ({ url: bgmUrl(ctx.worldId, t), title: t.title, loop: t.loop })) };
  }, [id, view, ctx, settings]);
  return { choice, settings };
}
