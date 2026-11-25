/**
 * 世界的跨周目收集（docs/ARCHITECTURE.md 16.8）：结局、CG 画廊、走过的幕。
 * 只增不减：回退、换分支、删周目都不影响。没达成的结局显示为"？？？"，隐藏结局达成前不出现；
 * 没解锁的 CG 也是"？？？"，不告诉出现在哪一幕。
 * CG 画好了用真的图（M4）；AI 演出时导演标的 CG 画好了就进画廊（18.6）。
 */
import type { AssetSlotView, WorldProgress } from '@auto-adv/engine/api';
import { useEffect, useState } from 'react';
import { Badge, Card, cx, Empty, Spinner } from '../components/ui.tsx';
import { CgImage, useAssetsContext } from '../lib/assets.tsx';
import { engine, errorMessage } from '../lib/engine.ts';
import { formatTime } from '../lib/format.ts';

/** 正在全屏看的 CG。 */
interface Viewing {
  id: string;
  caption: string;
}

/** AI 演出时导演标的、已经画好的 CG，新的在前。 */
function aiCgsOf(slots: readonly AssetSlotView[] | undefined): AssetSlotView[] {
  return (slots ?? []).filter((s) => s.kind === 'cg' && s.id.startsWith('cg/ai_') && s.file).sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}

/** 画廊里的一格。 */
function CgThumb({ id, label, onOpen, testId }: { id: string; label: string; onOpen: () => void; testId: string }) {
  return (
    <button type="button" className="group text-left" data-testid={testId} data-cg={id} onClick={onOpen}>
      <div
        className="relative aspect-video overflow-hidden rounded-lg border border-line transition-colors group-hover:border-accent"
        style={{ containerType: 'inline-size' }}
      >
        <CgImage id={id} />
      </div>
      <div className="mt-1 truncate text-xs text-muted">{label}</div>
    </button>
  );
}

const ENDING_KIND: Record<string, string> = { good: '好结局', normal: '普通结局', bad: '坏结局' };

export function CollectionView({ worldId }: { worldId: string }) {
  const [prog, setProg] = useState<WorldProgress | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<Viewing | null>(null);
  const ai = aiCgsOf(useAssetsContext()?.view?.slots);

  useEffect(() => {
    engine
      .call('worldProgress', { worldId })
      .then(setProg)
      .catch((err) => setError(errorMessage(err)));
  }, [worldId]);

  useEffect(() => {
    if (!viewing) return;
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setViewing(null);
    };
    window.addEventListener('keydown', down);
    return () => window.removeEventListener('keydown', down);
  }, [viewing]);

  if (error) return <Empty title="读不到收集进度">{error}</Empty>;
  if (prog === undefined) {
    return (
      <div className="flex justify-center py-10 text-muted">
        <Spinner />
      </div>
    );
  }
  const aiSection = ai.length > 0 && (
    <div className="mt-4" data-testid="collection-ai-cgs">
      <div className="mb-2 text-xs text-muted">AI 演出时画的（{ai.length} 张）</div>
      <div className="grid grid-cols-3 gap-3">
        {ai.map((c) => {
          const id = c.id.slice('cg/'.length);
          return <CgThumb key={id} id={id} label={c.title} testId="collection-ai-cg" onOpen={() => setViewing({ id, caption: c.title })} />;
        })}
      </div>
    </div>
  );
  const viewer = viewing && (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/90"
      data-testid="collection-cg-view"
      onClick={() => setViewing(null)}
    >
      <div className="relative aspect-video overflow-hidden rounded-lg" style={{ width: 'min(90vw, calc(85vh * 16 / 9))', containerType: 'inline-size' }}>
        <CgImage id={viewing.id} />
      </div>
      <div className="text-sm text-white/70">{viewing.caption}</div>
      <div className="text-xs text-white/40">点击任意处或按 Esc 关闭</div>
    </div>
  );
  if (!prog) {
    return ai.length ? (
      <div className="space-y-4" data-testid="collection">
        <Card className="p-5">
          <div className="font-medium">CG 画廊</div>
          {aiSection}
        </Card>
        {viewer}
      </div>
    ) : (
      <Empty title="剧情图还没有生成">结局和 CG 都挂在剧情图上，有了剧情图才有收集。</Empty>
    );
  }

  const endings = prog.endings.filter((e) => !e.hidden || e.reached);
  const unlocked = prog.cgs.filter((c) => c.unlocked).length;

  return (
    <div className="space-y-4" data-testid="collection">
      <Card className="p-5">
        <div className="mb-3 flex items-baseline justify-between">
          <div className="font-medium">结局</div>
          <div className="text-sm text-muted" data-testid="collection-endings">
            达成 {prog.reached} / {prog.total}
          </div>
        </div>
        {endings.length ? (
          <ul className="grid grid-cols-2 gap-2">
            {endings.map((e) => (
              <li
                key={e.id}
                className={cx(
                  'flex items-center gap-2 rounded-lg border px-3 py-2 text-sm',
                  e.reached ? 'border-accent/40' : 'border-line text-faint',
                )}
                data-testid="collection-ending"
              >
                {e.reached ? (
                  <>
                    <Badge tone={e.kind === 'good' ? 'ok' : e.kind === 'bad' ? 'err' : 'neutral'}>
                      {ENDING_KIND[e.kind]}
                      {e.hidden ? ' · 隐藏' : ''}
                    </Badge>
                    <span className="min-w-0 flex-1 truncate">{e.title}</span>
                    {e.firstAt && <span className="text-xs text-faint">{formatTime(e.firstAt)}</span>}
                  </>
                ) : (
                  <span>？？？</span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-faint">剧情图里没有结局。</p>
        )}
      </Card>

      <Card className="p-5">
        <div className="mb-3 flex items-baseline justify-between">
          <div className="font-medium">CG 画廊</div>
          <div className="text-sm text-muted" data-testid="collection-cgs">
            {unlocked} / {prog.cgs.length}
          </div>
        </div>
        {prog.cgs.length ? (
          <div className="grid grid-cols-3 gap-3">
            {prog.cgs.map((c) =>
              c.unlocked ? (
                <CgThumb
                  key={c.id}
                  id={c.id}
                  label={c.scene ?? c.id}
                  testId="collection-cg"
                  onOpen={() => setViewing({ id: c.id, caption: `${c.scene ?? c.id}${c.firstAt ? ` · 第一次看到：${formatTime(c.firstAt)}` : ''}` })}
                />
              ) : (
                <div key={c.id} data-testid="collection-cg-locked">
                  <div className="flex aspect-video items-center justify-center rounded-lg border border-dashed border-line bg-panel-2 text-faint">
                    ？？？
                  </div>
                  <div className="mt-1 text-xs text-faint">还没看到</div>
                </div>
              ),
            )}
          </div>
        ) : (
          !ai.length && <p className="text-sm text-faint">这个世界的剧本里没有 CG。</p>
        )}
        {aiSection}
      </Card>

      <Card className="flex items-baseline justify-between p-5">
        <div className="font-medium">走过的幕</div>
        <div className="text-sm text-muted" data-testid="collection-scenes">
          {prog.scenes.visited} / {prog.scenes.total}
        </div>
      </Card>

      {viewer}
    </div>
  );
}
