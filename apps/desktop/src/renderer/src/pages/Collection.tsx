/**
 * 世界的跨周目收集（docs/ARCHITECTURE.md 16.8）：结局、CG 画廊、走过的幕。
 * 只增不减：回退、换分支、删周目都不影响。没达成的结局显示为"？？？"，隐藏结局达成前不出现；
 * 没解锁的 CG 也是"？？？"，不告诉出现在哪一幕。
 */
import type { WorldProgress } from '@auto-adv/engine/api';
import { useEffect, useState } from 'react';
import { PlaceholderCg } from '../components/placeholder.tsx';
import { Badge, Card, cx, Empty, Spinner } from '../components/ui.tsx';
import { engine, errorMessage } from '../lib/engine.ts';
import { formatTime } from '../lib/format.ts';

const ENDING_KIND: Record<string, string> = { good: '好结局', normal: '普通结局', bad: '坏结局' };

export function CollectionView({ worldId }: { worldId: string }) {
  const [prog, setProg] = useState<WorldProgress | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  /** 正在全屏看的 CG。 */
  const [viewing, setViewing] = useState<WorldProgress['cgs'][number] | null>(null);

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
  if (!prog) return <Empty title="剧情图还没有生成">结局和 CG 都挂在剧情图上，有了剧情图才有收集。</Empty>;

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
                <button
                  key={c.id}
                  type="button"
                  className="group text-left"
                  data-testid="collection-cg"
                  onClick={() => setViewing(c)}
                >
                  <div
                    className="relative aspect-video overflow-hidden rounded-lg border border-line transition-colors group-hover:border-accent"
                    style={{ containerType: 'inline-size' }}
                  >
                    <PlaceholderCg id={c.id} />
                  </div>
                  <div className="mt-1 truncate text-xs text-muted">{c.scene ?? c.id}</div>
                </button>
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
          <p className="text-sm text-faint">这个世界的剧本里没有 CG。</p>
        )}
      </Card>

      <Card className="flex items-baseline justify-between p-5">
        <div className="font-medium">走过的幕</div>
        <div className="text-sm text-muted" data-testid="collection-scenes">
          {prog.scenes.visited} / {prog.scenes.total}
        </div>
      </Card>

      {viewing && (
        <div
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/90"
          data-testid="collection-cg-view"
          onClick={() => setViewing(null)}
        >
          <div
            className="relative aspect-video overflow-hidden rounded-lg"
            style={{ width: 'min(90vw, calc(85vh * 16 / 9))', containerType: 'inline-size' }}
          >
            <PlaceholderCg id={viewing.id} />
          </div>
          <div className="text-sm text-white/70">
            {viewing.scene ?? viewing.id}
            {viewing.firstAt ? ` · 第一次看到：${formatTime(viewing.firstAt)}` : ''}
          </div>
          <div className="text-xs text-white/40">点击任意处或按 Esc 关闭</div>
        </div>
      )}
    </div>
  );
}
