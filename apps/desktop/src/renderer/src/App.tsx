import type { PingResult, UsageSummary } from '@auto-adv/engine/api';
import { type ReactNode, useEffect, useState } from 'react';
import { cx } from './components/ui.tsx';
import { engine, onConnectionChange } from './lib/engine.ts';
import { formatCost } from './lib/format.ts';
import { useRouter } from './lib/router.tsx';
import { CreateWorldPage } from './pages/CreateWorld.tsx';
import { HomePage } from './pages/Home.tsx';
import { LogsPage } from './pages/Logs.tsx';
import { PlayPage } from './pages/Play.tsx';
import { PlaygroundPage } from './pages/Playground.tsx';
import { SettingsPage } from './pages/Settings.tsx';
import { WorldPage } from './pages/World.tsx';

/** 侧栏上的一级页面。 */
export type PageId = 'home' | 'playground' | 'logs' | 'settings';

const NAV: { id: PageId; label: string; icon: ReactNode }[] = [
  { id: 'home', label: '世界', icon: <IconGlobe /> },
  { id: 'playground', label: '调试台', icon: <IconChat /> },
  { id: 'logs', label: '调用日志', icon: <IconList /> },
  { id: 'settings', label: '设置', icon: <IconGear /> },
];

export function App() {
  const { route, navigate } = useRouter();
  // 世界相关的页面都算在「世界」下面
  const page: PageId = ['create', 'world', 'play'].includes(route.page) ? 'home' : (route.page as PageId);
  const setPage = (p: PageId) => navigate({ page: p });
  const [ping, setPing] = useState<PingResult | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [usage, setUsage] = useState<UsageSummary | null>(null);

  useEffect(() => {
    const check = () =>
      engine
        .call('ping')
        .then((p) => {
          setPing(p);
          setConnected(true);
        })
        .catch(() => setConnected(false));
    void check();
    return onConnectionChange((c) => {
      setConnected(c);
      if (c) void check();
    });
  }, []);

  useEffect(() => {
    const load = () => engine.call('usageSummary').then(setUsage).catch(() => {});
    void load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="flex h-full">
      <aside className="flex w-56 shrink-0 flex-col border-r border-line bg-panel">
        <div className="px-5 pt-6 pb-5">
          <div className="text-lg font-semibold tracking-tight">
            Auto<span className="text-accent-strong">-ADV</span>
          </div>
          <div className="mt-0.5 text-xs text-faint">全自动视觉小说</div>
        </div>
        <nav className="flex flex-col gap-0.5 px-3">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              data-nav={item.id}
              onClick={() => setPage(item.id)}
              className={cx(
                'flex h-9 items-center gap-2.5 rounded-lg px-3 text-sm transition-colors',
                page === item.id ? 'bg-accent-soft text-fg' : 'text-muted hover:bg-panel-2 hover:text-fg',
              )}
            >
              <span className={cx('size-4', page === item.id ? 'text-accent-strong' : '')}>{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="mt-auto space-y-3 border-t border-line px-5 py-4 text-xs">
          {usage && usage.calls > 0 && (
            <div className="space-y-0.5 text-muted">
              <div>累计调用 {usage.calls} 次</div>
              {usage.costs.map((c) => (
                <div key={c.currency}>花费 {formatCost(c.total, c.currency)}</div>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2 text-faint">
            <span
              className={cx(
                'size-2 rounded-full',
                connected === null ? 'bg-faint' : connected ? 'bg-ok' : 'bg-err',
              )}
            />
            {connected === false ? '引擎未连接' : ping ? `引擎 v${ping.engineVersion}` : '连接中…'}
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-hidden">
        {route.page === 'home' && <HomePage />}
        {route.page === 'create' && <CreateWorldPage />}
        {route.page === 'world' && <WorldPage key={`${route.worldId}:${route.tab ?? ''}`} worldId={route.worldId} initialTab={route.tab} />}
        {route.page === 'play' && (
          <PlayPage key={route.playthroughId} worldId={route.worldId} playthroughId={route.playthroughId} />
        )}
        {route.page === 'playground' && <PlaygroundPage onNavigate={setPage} />}
        {route.page === 'logs' && <LogsPage />}
        {route.page === 'settings' && <SettingsPage />}
      </main>
    </div>
  );
}

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="size-4">
      {children}
    </svg>
  );
}
function IconGlobe() {
  return (
    <Svg>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </Svg>
  );
}
function IconChat() {
  return (
    <Svg>
      <path d="M4 5h16v11H8l-4 4z" />
    </Svg>
  );
}
function IconList() {
  return (
    <Svg>
      <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />
    </Svg>
  );
}
function IconGear() {
  return (
    <Svg>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </Svg>
  );
}
