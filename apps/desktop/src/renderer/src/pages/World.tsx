import type { PlaythroughInfo, WorldDetail } from '@auto-adv/engine/api';
import { type Character, GENESIS_STEPS, type GenesisStepId } from '@auto-adv/schema';
import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  ConfirmButton,
  cx,
  Empty,
  Markdown,
  PageHeader,
  Spinner,
  Tabs,
  useToast,
} from '../components/ui.tsx';
import { engine, errorMessage } from '../lib/engine.ts';
import { formatTime } from '../lib/format.ts';
import { useGenesis } from '../lib/genesis.tsx';
import { useRouter } from '../lib/router.tsx';

type Tab = 'overview' | 'characters' | 'locations' | 'lore' | 'opening';

export function WorldPage({ worldId }: { worldId: string }) {
  const { navigate } = useRouter();
  const genesis = useGenesis();
  const toast = useToast();
  const [world, setWorld] = useState<WorldDetail | null>(null);
  const [plays, setPlays] = useState<PlaythroughInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [starting, setStarting] = useState(false);
  const job = genesis.jobs[worldId];

  const load = useCallback(async () => {
    try {
      const w = await engine.call('getWorld', { id: worldId });
      setWorld(w);
      setPlays(w.summary.status === 'ready' ? await engine.call('listPlaythroughs', { worldId }) : []);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [worldId]);

  useEffect(() => {
    void load();
  }, [load, genesis.finished]);

  // 生成过程中，每完成一步就刷新一次内容
  const doneCount = GENESIS_STEPS.filter((s) => job?.steps[s.id]?.status === 'done').length;
  useEffect(() => {
    if (job) void load();
  }, [doneCount, load, job]);

  if (error) {
    return (
      <div className="p-8">
        <Empty title="打不开这个世界">{error}</Empty>
        <Button className="mt-4" onClick={() => navigate({ page: 'home' })}>
          返回
        </Button>
      </div>
    );
  }
  if (!world) {
    return (
      <div className="flex h-full items-center justify-center text-muted">
        <Spinner />
      </div>
    );
  }

  const steps = { ...world.summary.steps, ...job?.steps };
  const running = !!job || world.summary.running;
  const ready = world.summary.status === 'ready' && !running;
  const protagonist = world.characters.find((c) => c.role === 'protagonist');

  const start = async () => {
    setStarting(true);
    try {
      const v = await engine.call('startPlaythrough', { worldId });
      navigate({ page: 'play', worldId, playthroughId: v.playthrough.id });
    } catch (err) {
      toast('err', errorMessage(err));
      setStarting(false);
    }
  };

  const remove = async () => {
    try {
      genesis.cancel(worldId);
      await engine.call('deleteWorld', { id: worldId });
      toast('ok', `已删除「${world.manifest.title}」`);
      navigate({ page: 'home' });
    } catch (err) {
      toast('err', errorMessage(err));
    }
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={world.manifest.title}
        subtitle={world.manifest.logline || (running ? '正在生成……' : '')}
        actions={
          <>
            <Button variant="ghost" onClick={() => navigate({ page: 'home' })}>
              返回
            </Button>
            <ConfirmButton size="md" variant="ghost" onConfirm={remove} confirmText="确认删除？" testId="delete-world">
              删除世界
            </ConfirmButton>
            <Button variant="primary" data-testid="start-play" disabled={!ready} loading={starting} onClick={start}>
              开始新周目
            </Button>
          </>
        }
      />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-6xl grid-cols-[1fr_300px] gap-6 px-8 py-6">
          <div className="min-w-0 space-y-4">
            <Tabs
              value={tab}
              onChange={setTab}
              items={[
                { value: 'overview', label: '概览' },
                { value: 'characters', label: `角色 ${world.characters.length || ''}` },
                { value: 'locations', label: `地点 ${world.locations.length || ''}` },
                { value: 'lore', label: `设定集 ${world.lore.length || ''}` },
                { value: 'opening', label: '开场' },
              ]}
            />
            {tab === 'overview' && <Overview world={world} />}
            {tab === 'characters' && (
              <div className="grid gap-3">
                {world.characters.length === 0 && <Empty title="角色还没有生成" />}
                {world.characters.map((c) => (
                  <CharacterCard key={c.id} c={c} all={world.characters} />
                ))}
              </div>
            )}
            {tab === 'locations' && (
              <div className="grid grid-cols-2 gap-3">
                {world.locations.length === 0 && <Empty title="地点还没有生成" />}
                {world.locations.map((l) => (
                  <Card key={l.id} className="p-4">
                    <div className="font-medium">{l.name}</div>
                    <p className="mt-1.5 text-sm leading-relaxed text-muted">{l.description}</p>
                    {l.connections.length > 0 && (
                      <div className="mt-2 text-xs text-faint">
                        通往：
                        {l.connections.map((id) => world.locations.find((x) => x.id === id)?.name ?? id).join('、')}
                      </div>
                    )}
                  </Card>
                ))}
              </div>
            )}
            {tab === 'lore' && (
              <div className="grid gap-2">
                {world.lore.length === 0 && <Empty title="设定集还没有生成" />}
                {world.lore.map((e) => (
                  <Card key={e.id} className="p-4">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{e.title}</span>
                      <Badge>{e.category}</Badge>
                      {e.activation === 'always' && <Badge tone="accent">常驻</Badge>}
                    </div>
                    <p className="mt-1.5 text-sm leading-relaxed text-muted">{e.content}</p>
                    {e.activation === 'keyword' && (
                      <div className="mt-2 text-xs text-faint">触发词：{e.keys.join('、')}</div>
                    )}
                  </Card>
                ))}
              </div>
            )}
            {tab === 'opening' && (
              <Card className="p-5">
                {!world.opening ? (
                  <Empty title="开场还没有生成" />
                ) : (
                  <div className="space-y-3 text-sm leading-relaxed">
                    <div className="text-xs text-faint">
                      地点：{world.locations.find((l) => l.id === world.opening?.locationId)?.name ?? '未指定'} · 在场：
                      {world.opening.presentCharacterIds
                        .map((id) => world.characters.find((c) => c.id === id)?.name ?? id)
                        .join('、')}
                    </div>
                    <Markdown text={world.opening.narration} className="text-fg" />
                    {world.opening.lines.map((l, i) => (
                      <p key={`${l.characterId}${i}`}>
                        <span className="font-medium text-accent-strong">
                          {world.characters.find((c) => c.id === l.characterId)?.name}
                        </span>
                        ：{l.text}
                      </p>
                    ))}
                  </div>
                )}
              </Card>
            )}
          </div>

          <div className="space-y-4">
            {world.summary.status === 'ready' && (
              <Card className="p-4">
                <div className="mb-3 text-xs font-medium text-muted">周目</div>
                {plays.length === 0 && <p className="text-sm text-faint">还没有开始过。点右上角「开始新周目」。</p>}
                <div className="space-y-2">
                  {plays.map((p) => (
                    <div key={p.id} className="rounded-lg border border-line p-3" data-testid="playthrough">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium">{p.title}</span>
                        <span className="text-xs text-faint">{formatTime(p.updatedAt)}</span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-muted">{p.preview}</p>
                      <div className="mt-2 flex gap-1.5">
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={() => navigate({ page: 'play', worldId, playthroughId: p.id })}
                        >
                          继续
                        </Button>
                        <ConfirmButton
                          onConfirm={() =>
                            engine
                              .call('deletePlaythrough', { worldId, playthroughId: p.id })
                              .then(load, (err) => toast('err', errorMessage(err)))
                          }
                        >
                          删除
                        </ConfirmButton>
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            <Card className="p-4" data-testid="genesis-steps">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-xs font-medium text-muted">创世步骤</span>
                {running ? (
                  <Button size="sm" variant="ghost" onClick={() => genesis.cancel(worldId)}>
                    停止
                  </Button>
                ) : (
                  world.summary.status !== 'ready' && (
                    <Button size="sm" variant="primary" data-testid="resume-genesis" onClick={() => genesis.run(worldId)}>
                      {world.summary.status === 'failed' ? '重试失败的步骤' : '继续生成'}
                    </Button>
                  )
                )}
              </div>
              <ul className="space-y-1">
                {GENESIS_STEPS.map((s) => {
                  const st = steps[s.id];
                  const chars = job?.progress[s.id];
                  return (
                    <li key={s.id} className="group" data-step={s.id} data-status={st?.status ?? 'pending'}>
                      <div className="flex h-8 items-center gap-2 text-sm">
                        <StepIcon status={st?.status} />
                        <span className={cx(st?.status === 'done' ? 'text-fg' : 'text-muted')}>{s.name}</span>
                        {st?.status === 'running' && chars ? (
                          <span className="text-xs text-faint">{chars} 字</span>
                        ) : null}
                        {st?.status === 'done' && !running && (
                          <ConfirmButton
                            variant="ghost"
                            confirmText="连同下游一起重抽？"
                            title="重新生成这一步，依赖它的步骤也会一起重新生成"
                            onConfirm={() => genesis.run(worldId, s.id as GenesisStepId)}
                          >
                            <span className="opacity-0 transition-opacity group-hover:opacity-100">重抽</span>
                          </ConfirmButton>
                        )}
                      </div>
                      {st?.status === 'failed' && st.error && (
                        <p className="mb-1 ml-6 text-xs leading-relaxed break-all text-err">{st.error}</p>
                      )}
                    </li>
                  );
                })}
              </ul>
              {ready && protagonist && (
                <p className="mt-3 border-t border-line pt-3 text-xs leading-relaxed text-faint">
                  你将扮演：<span className="text-muted">{protagonist.name}</span>
                </p>
              )}
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}

function StepIcon({ status }: { status: string | undefined }) {
  if (status === 'running') return <Spinner className="text-accent-strong" />;
  return (
    <span
      className={cx(
        'flex size-3.5 items-center justify-center text-xs',
        status === 'done' && 'text-ok',
        status === 'failed' && 'text-err',
        (!status || status === 'pending') && 'text-faint',
      )}
    >
      {status === 'done' ? '✓' : status === 'failed' ? '✕' : '○'}
    </span>
  );
}

function Overview({ world }: { world: WorldDetail }) {
  const b = world.brief;
  return (
    <div className="space-y-4">
      {b && (
        <Card className="grid grid-cols-2 gap-x-6 gap-y-3 p-5 text-sm">
          <Info label="题材" value={b.genre} />
          <Info label="基调" value={b.tone} />
          <Info label="时代" value={b.era} />
          <Info label="主题" value={b.themes.join('、')} />
          {world.style?.prose.description && (
            <Info label="文风" value={world.style.prose.description} className="col-span-2" />
          )}
        </Card>
      )}
      <Card className="p-5">
        {world.worldview ? <Markdown text={world.worldview} /> : <Empty title="世界观还没有生成" />}
      </Card>
      {world.manifest.models.length > 0 && (
        <p className="text-xs text-faint">生成所用模型：{world.manifest.models.join('、')}</p>
      )}
    </div>
  );
}

function Info({ label, value, className }: { label: string; value: string; className?: string }) {
  if (!value) return null;
  return (
    <div className={className}>
      <div className="text-xs text-faint">{label}</div>
      <div className="mt-0.5 leading-relaxed">{value}</div>
    </div>
  );
}

const ROLE_NAMES: Record<string, string> = {
  protagonist: '主角（你）',
  heroine: '女主角',
  hero: '男主角',
  rival: '对手',
  antagonist: '反派',
  mentor: '导师',
  npc: '配角',
};

function CharacterCard({ c, all }: { c: Character; all: Character[] }) {
  return (
    <Card className="p-5">
      <div className="flex items-center gap-2">
        <span className="text-base font-semibold">{c.name}</span>
        <Badge tone={c.role === 'protagonist' ? 'accent' : 'neutral'}>{ROLE_NAMES[c.role] ?? c.role}</Badge>
        <span className="text-xs text-faint">{[c.gender, c.age].filter(Boolean).join(' · ')}</span>
      </div>
      {c.summary && <p className="mt-1.5 text-sm text-muted">{c.summary}</p>}
      <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2.5 text-sm">
        <Info label="外貌" value={c.appearance.text} />
        <Info label="性格" value={c.personality.traits.join('、')} />
        <Info label="说话方式" value={c.speech.style} />
        <Info label="目标" value={c.goals.map((g) => g.text).join('；')} />
        <Info label="经历" value={c.background} className="col-span-2" />
        {c.speech.examples.length > 0 && (
          <Info label="台词" value={c.speech.examples.map((e) => `「${e}」`).join(' ')} className="col-span-2" />
        )}
        {c.relationships.length > 0 && (
          <Info
            label="关系"
            value={c.relationships
              .map((r) => `${all.find((x) => x.id === r.to)?.name ?? r.to}：${r.type}`)
              .join('；')}
            className="col-span-2"
          />
        )}
        {c.secrets.length > 0 && (
          <details className="col-span-2 text-sm">
            <summary className="cursor-pointer text-xs text-faint select-none">秘密（剧透）</summary>
            <p className="mt-1 text-muted">{c.secrets.map((s) => s.text).join('；')}</p>
          </details>
        )}
      </div>
    </Card>
  );
}
