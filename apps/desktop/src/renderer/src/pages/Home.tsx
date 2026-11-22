import type { WorldSummary } from '@auto-adv/engine/api';
import { GENESIS_STEPS } from '@auto-adv/schema';
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, cx, useToast } from '../components/ui.tsx';
import { engine, errorMessage, onConnectionChange } from '../lib/engine.ts';
import { useGenesis } from '../lib/genesis.tsx';
import { useRouter } from '../lib/router.tsx';
import { useSettings } from '../lib/settings.tsx';

export function HomePage() {
  const { navigate } = useRouter();
  const { settings, error: settingsError } = useSettings();
  const genesis = useGenesis();
  const [worlds, setWorlds] = useState<WorldSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const toast = useToast();

  /** 从文件夹导入世界（默认打开自带的示例世界）。 */
  const importWorld = async () => {
    const dir = await window.autoAdv?.pickFolder('选择要导入的世界文件夹（里面有 world.json）');
    if (!dir) return;
    setImporting(true);
    try {
      const w = await engine.call('importWorld', { path: dir });
      toast('ok', `已导入「${w.title}」`);
      navigate({ page: 'world', worldId: w.id });
    } catch (err) {
      toast('err', errorMessage(err));
    } finally {
      setImporting(false);
    }
  };

  const load = useCallback(() => {
    engine
      .call('listWorlds')
      .then((w) => {
        setWorlds(w);
        setError(null);
      })
      .catch((err) => setError(errorMessage(err)));
  }, []);

  useEffect(() => {
    load();
    return onConnectionChange((c) => c && load());
  }, [load]);
  // 有世界生成结束时刷新
  useEffect(load, [genesis.finished]);

  const hasEndpoint = (settings?.endpoints.length ?? 0) > 0;
  const hasProbed = settings?.endpoints.some((e) => Object.keys(e.capabilities).length > 0) ?? false;
  const hasDefaultRole = !!settings?.roles.default;
  const ready = hasEndpoint && hasDefaultRole;

  const steps = [
    {
      done: hasEndpoint,
      title: '添加一个模型接入点',
      desc: 'DeepSeek、通义千问、Kimi、OpenAI、本地 Ollama……任何 OpenAI 兼容接口都可以。',
    },
    {
      done: hasProbed,
      title: '做一次能力探测（推荐）',
      desc: '检查模型支持哪些功能。支持结构化输出的模型，创世会更稳定。',
    },
    {
      done: hasDefaultRole,
      title: '给「默认」职责指定模型',
      desc: '创世、扮演角色、整理记忆等职责没有单独指定时都会用它。',
    },
  ];

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-8 py-10">
        <div className="relative overflow-hidden rounded-2xl border border-line bg-gradient-to-br from-[#1f1b3a] via-panel to-[#2a1630] p-8">
          <div className="absolute -top-16 -right-16 size-64 rounded-full bg-accent/20 blur-3xl" />
          <div className="relative">
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">我的世界</h1>
              <Badge tone="accent">M1 预览版</Badge>
            </div>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted">
              一句话生成一个完整的世界：世界观、角色、地点、设定集和开场。然后走进去，和角色们聊天。
            </p>
            <div className="mt-6 flex items-center gap-3">
              <Button
                variant="primary"
                data-testid="new-world"
                disabled={!ready}
                onClick={() => navigate({ page: 'create' })}
              >
                ＋ 新建世界
              </Button>
              <Button data-testid="import-world" loading={importing} onClick={() => void importWorld()}>
                导入世界
              </Button>
              {!ready && <span className="text-xs text-faint">新建世界要先接好模型（见下方）；导入手写的世界不需要</span>}
            </div>
          </div>
        </div>

        {(!ready || !hasProbed) && (
          <>
            <h2 className="mt-10 mb-3 text-sm font-medium text-muted">开始之前，先把模型接好</h2>
            {settingsError && <p className="mb-3 text-sm text-err">{settingsError}</p>}
            <div className="grid gap-2">
              {steps.map((s, i) => (
                <Card key={s.title} className="flex items-center gap-4 px-5 py-4">
                  <div
                    className={cx(
                      'flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                      s.done ? 'bg-ok/15 text-ok' : 'bg-panel-3 text-muted',
                    )}
                  >
                    {s.done ? '✓' : i + 1}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className={cx('text-sm font-medium', s.done && 'text-muted line-through decoration-faint')}>
                      {s.title}
                    </div>
                    <div className="mt-0.5 text-xs text-muted">{s.desc}</div>
                  </div>
                  {!s.done && (
                    <Button size="sm" onClick={() => navigate({ page: 'settings' })}>
                      去设置
                    </Button>
                  )}
                </Card>
              ))}
            </div>
          </>
        )}

        <h2 className="mt-10 mb-3 text-sm font-medium text-muted">
          世界{worlds && worlds.length > 0 ? `（${worlds.length}）` : ''}
        </h2>
        {error && <p className="mb-3 text-sm text-err">{error}</p>}
        {worlds && worlds.length === 0 && (
          <div className="rounded-xl border border-dashed border-line px-6 py-10 text-center text-sm text-muted">
            还没有世界。点上面的「新建世界」，输入一句话就能开始。
          </div>
        )}
        <div className="grid grid-cols-2 gap-3" data-testid="world-list">
          {worlds?.map((w) => (
            <WorldCard key={w.id} world={w} onOpen={() => navigate({ page: 'world', worldId: w.id })} />
          ))}
        </div>
      </div>
    </div>
  );
}

function WorldCard({ world, onOpen }: { world: WorldSummary; onOpen: () => void }) {
  const { jobs } = useGenesis();
  const job = jobs[world.id];
  const steps = { ...world.steps, ...job?.steps };
  const done = GENESIS_STEPS.filter((s) => steps[s.id]?.status === 'done').length;
  const running = !!job || world.running;
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="world-card"
      className="group flex flex-col rounded-xl border border-line bg-panel p-5 text-left transition-colors hover:border-line-strong hover:bg-panel-2"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="text-base font-semibold tracking-tight group-hover:text-accent-strong">{world.title}</div>
        {running ? (
          <Badge tone="accent">
            生成中 {done}/{GENESIS_STEPS.length}
          </Badge>
        ) : world.status === 'failed' ? (
          <Badge tone="err">生成失败</Badge>
        ) : world.status === 'generating' ? (
          <Badge tone="warn">生成中断</Badge>
        ) : (
          world.genre && <Badge>{world.genre}</Badge>
        )}
      </div>
      <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-muted">{world.logline || '（简介生成中）'}</p>
      <div className="mt-3 text-xs text-faint">
        {world.characterCount > 0 && `${world.characterCount} 个角色 · `}
        {new Date(world.createdAt).toLocaleDateString()}
      </div>
    </button>
  );
}
