import type { AssetsView } from '@auto-adv/engine/api';
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { PlaceholderBg } from '../components/placeholder.tsx';
import { engine, isAborted, onConnectionChange } from './engine.ts';

/** 世界里的素材文件的地址（主进程的 adv-asset 协议，只能读世界的 assets/）。 */
export function assetUrl(worldId: string, file: string): string {
  return `adv-asset://world/${encodeURIComponent(worldId)}/${file.split('/').map(encodeURIComponent).join('/')}`;
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
