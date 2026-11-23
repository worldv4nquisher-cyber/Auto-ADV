import type { PlaythroughInfo, PlotCheckResult, StartPlaythroughParams, WorldDetail } from '@auto-adv/engine/api';
import { type Character, GENESIS_STEPS, type GenesisStepId, type ObserverSettings } from '@auto-adv/schema';
import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  ConfirmButton,
  cx,
  Empty,
  Field,
  Input,
  Markdown,
  PageHeader,
  Select,
  Spinner,
  Tabs,
  useToast,
} from '../components/ui.tsx';
import { engine, errorMessage } from '../lib/engine.ts';
import { formatTime, formatTokens } from '../lib/format.ts';
import { useGenesis } from '../lib/genesis.tsx';
import { useRouter } from '../lib/router.tsx';

type Tab = 'overview' | 'characters' | 'locations' | 'plot' | 'lore' | 'opening';

export function WorldPage({ worldId }: { worldId: string }) {
  const { navigate } = useRouter();
  const genesis = useGenesis();
  const toast = useToast();
  const [world, setWorld] = useState<WorldDetail | null>(null);
  const [plays, setPlays] = useState<PlaythroughInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [starting, setStarting] = useState(false);
  const [dialog, setDialog] = useState(false);
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

  // 手写的世界（比如导入的示例）没有创世步骤，不能"继续生成"
  const handmade = Object.keys(world.summary.steps).length === 0 && !running;
  const incomplete = !handmade && GENESIS_STEPS.some((s) => steps[s.id]?.status !== 'done');

  const start = async (p: Omit<StartPlaythroughParams, 'worldId'>) => {
    setStarting(true);
    try {
      const v = await engine.call('startPlaythrough', { worldId, ...p });
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
            <Button variant="primary" data-testid="start-play" disabled={!ready} loading={starting} onClick={() => setDialog(true)}>
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
                { value: 'plot', label: '剧情图' },
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
            {tab === 'plot' &&
              (world.graph ? (
                <GraphView world={world} />
              ) : (
                <Empty title="剧情图还没有生成">观察模式和剧情 ADV 都按剧情图一幕一幕推进故事。</Empty>
              ))}
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
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate text-sm font-medium">{p.title}</span>
                          {p.mode === 'observer' && <Badge tone="accent">观察</Badge>}
                          {p.mode === 'adv' && <Badge tone="ok">剧情 ADV</Badge>}
                        </span>
                        <span className="shrink-0 text-xs text-faint">{formatTime(p.updatedAt)}</span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-muted">{p.preview}</p>
                      {p.usage.calls > 0 && (
                        <p className="mt-1 text-[11px] text-faint">
                          已用 {formatTokens(p.usage.inputTokens + p.usage.outputTokens)} tokens · {p.usage.calls} 次调用
                        </p>
                      )}
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

            {handmade && (
              <Card className="p-4 text-xs leading-relaxed text-muted">
                这是一个手写的世界（不是一键创世生成的）。
                {world.graph && <PlotCheckSummary check={world.plotCheck} className="mt-2" />}
              </Card>
            )}
            {!handmade && (
            <Card className="p-4" data-testid="genesis-steps">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-xs font-medium text-muted">创世步骤</span>
                {running ? (
                  <Button size="sm" variant="ghost" onClick={() => genesis.cancel(worldId)}>
                    停止
                  </Button>
                ) : (
                  incomplete && (
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
              {ready && incomplete && (
                <p className="mt-3 border-t border-line pt-3 text-xs leading-relaxed text-faint">
                  这个世界是旧版本生成的，缺少剧情图。点「继续生成」补上，观察模式和剧情 ADV 会按它推进故事；已有的内容不会变。
                </p>
              )}
              {ready && protagonist && (
                <p className="mt-3 border-t border-line pt-3 text-xs leading-relaxed text-faint">
                  主角：<span className="text-muted">{protagonist.name}</span>（自由对话里由你扮演）
                </p>
              )}
            </Card>
            )}
          </div>
        </div>
      </div>
      {dialog && (
        <StartDialog
          hasPlot={!!world.graph}
          hasOpening={!!world.opening}
          plotCheck={world.graph ? world.plotCheck : null}
          starting={starting}
          onCancel={() => setDialog(false)}
          onStart={(p) => void start(p)}
        />
      )}
    </div>
  );
}

const DEFAULT_OBSERVER: Pick<ObserverSettings, 'strategy' | 'focus' | 'budgetTokens'> = {
  strategy: 'merged',
  focus: 'protagonist',
  budgetTokens: 2_000_000,
};

type StartMode = 'chat' | 'observer' | 'adv';

function StartDialog({
  hasPlot,
  hasOpening,
  plotCheck,
  starting,
  onCancel,
  onStart,
}: {
  hasPlot: boolean;
  hasOpening: boolean;
  /** 剧情图的结构检查；没有剧情图为 null。 */
  plotCheck: PlotCheckResult | null;
  starting: boolean;
  onCancel: () => void;
  onStart: (p: Omit<StartPlaythroughParams, 'worldId'>) => void;
}) {
  const advOk = !!plotCheck?.ok;
  const [mode, setMode] = useState<StartMode>(!hasOpening && advOk ? 'adv' : 'chat');
  const [obs, setObs] = useState(DEFAULT_OBSERVER);
  const blocked = (m: StartMode) => (m === 'adv' ? !advOk : !hasOpening);
  const option = (value: StartMode, title: string, desc: string) => (
    <button
      type="button"
      data-testid={`mode-${value}`}
      disabled={blocked(value)}
      onClick={() => setMode(value)}
      className={cx(
        'flex-1 rounded-xl border p-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        mode === value ? 'border-accent bg-accent-soft' : 'border-line hover:border-line-strong',
      )}
    >
      <div className="text-sm font-medium">{title}</div>
      <p className="mt-1 text-xs leading-relaxed text-muted">{desc}</p>
    </button>
  );
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-6" onClick={onCancel}>
      <Card className="w-full max-w-lg p-6" onClick={(e) => e.stopPropagation()} data-testid="start-dialog">
        <div className="mb-4 text-base font-semibold">开始新周目</div>
        <div className="flex gap-3">
          {option('chat', '自由对话', '你扮演主角，和角色们你一言我一语地推进故事。')}
          {option('observer', '观察模式', 'AI 们自己演，故事自动展开。你可以随时下导演指令、对角色说悄悄话，或者接管一个角色。')}
          {option('adv', '剧情 ADV', '按剧情图推进，在岔路做选择、掷骰检定，走向不同的结局。')}
        </div>
        {mode === 'adv' && (
          <p className="mt-4 text-xs leading-relaxed text-muted">
            有手写剧本的幕照剧本播放；没有剧本的幕由 AI 演出，每一拍给你几个选项，你也可以直接输入想做的事（需要先在设置里配好模型）。背景、立绘和 CG 先用占位图。
          </p>
        )}
        {plotCheck && !plotCheck.ok && (
          <p className="mt-4 text-xs leading-relaxed text-warn">
            剧情图没有通过结构检查，暂时不能玩剧情 ADV：{plotCheck.errors[0]?.message}
            {plotCheck.errors.length > 1 ? `（共 ${plotCheck.errors.length} 个问题）` : ''}
          </p>
        )}
        {!hasOpening && <p className="mt-4 text-xs leading-relaxed text-faint">这个世界没有开场，只能玩剧情 ADV。</p>}
        {mode === 'observer' && (
          <div className="mt-5 grid grid-cols-2 gap-4">
            <Field label="演出方式">
              <Select value={obs.strategy} onChange={(e) => setObs({ ...obs, strategy: e.target.value as ObserverSettings['strategy'] })}>
                <option value="merged">合并（快、省）</option>
                <option value="split">分演（每个角色单独演）</option>
              </Select>
            </Field>
            <Field label="视角">
              <Select value={obs.focus} onChange={(e) => setObs({ ...obs, focus: e.target.value as ObserverSettings['focus'] })}>
                <option value="protagonist">围绕主角</option>
                <option value="ensemble">群像</option>
              </Select>
            </Field>
            <Field label="token 预算" hint={`用到 ${formatTokens(obs.budgetTokens)} 自动停下，0 表示不限`} className="col-span-2">
              <Input
                type="number"
                min={0}
                step={100000}
                value={obs.budgetTokens}
                onChange={(e) => setObs({ ...obs, budgetTokens: Number(e.target.value || 0) })}
              />
            </Field>
            {!hasPlot && (
              <p className="col-span-2 text-xs leading-relaxed text-warn">
                这个世界还没有剧情图，导演只能自由发挥。建议先在「创世步骤」里点「继续生成」补上。
              </p>
            )}
          </div>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            取消
          </Button>
          <Button
            variant="primary"
            data-testid="start-confirm"
            loading={starting}
            disabled={blocked(mode)}
            onClick={() => onStart(mode === 'observer' ? { mode, observer: obs } : { mode })}
          >
            {mode === 'observer' ? '开始观看' : '开始'}
          </Button>
        </div>
      </Card>
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

function PlotCheckSummary({ check, className }: { check: PlotCheckResult | null; className?: string }) {
  if (!check) return null;
  const issues = [...check.errors.map((e) => ({ ...e, err: true })), ...check.warnings.map((w) => ({ ...w, err: false }))];
  return (
    <div className={cx('space-y-1', className)} data-testid="plot-check">
      <div className={cx('font-medium', check.ok ? (check.warnings.length ? 'text-warn' : 'text-ok') : 'text-err')}>
        {check.ok
          ? `剧情图检查通过${check.warnings.length ? `（${check.warnings.length} 个警告）` : ''}`
          : `剧情图有 ${check.errors.length} 个错误，修好之前不能玩剧情 ADV`}
      </div>
      {issues.slice(0, 8).map((i, n) => (
        <div key={n} className={cx('break-all', i.err ? 'text-err/90' : 'text-warn/90')}>
          {i.scene ? `${i.scene}${i.line ? `:${i.line}` : ''} ` : ''}
          {i.message}
        </div>
      ))}
      {issues.length > 8 && <div className="text-faint">……还有 {issues.length - 8} 条</div>}
    </div>
  );
}

const ENDING_KIND = { good: '好结局', normal: '普通结局', bad: '坏结局' } as const;

/** 剧情图：按章列出每一幕的要点、出口和结局。 */
function GraphView({ world }: { world: WorldDetail }) {
  const g = world.graph;
  if (!g) return null;
  const titleOf = (id: string) => g.scenes.find((s) => s.id === id)?.title || id;
  const groups = [
    ...g.chapters.map((c) => ({ id: c.id, title: c.title || c.id, scenes: g.scenes.filter((s) => s.chapter === c.id) })),
    { id: '', title: g.chapters.length ? '其他' : '', scenes: g.scenes.filter((s) => !s.chapter || !g.chapters.some((c) => c.id === s.chapter)) },
  ].filter((x) => x.scenes.length);
  return (
    <div className="space-y-4">
      {g.premise && (
        <Card className="p-5 text-sm leading-relaxed">
          <div className="mb-1 text-xs text-faint">核心</div>
          {g.premise}
        </Card>
      )}
      <Card className="p-4 text-xs">
        <PlotCheckSummary check={world.plotCheck} />
      </Card>
      {groups.map((grp) => (
        <Card key={grp.id || 'rest'} className="p-5">
          {grp.title && <div className="mb-3 font-medium">{grp.title}</div>}
          <div className="space-y-4">
            {grp.scenes.map((sc) => (
              <div key={sc.id} data-scene={sc.id}>
                <div className="flex items-center gap-2 text-sm font-medium">
                  <span className="font-mono text-xs text-faint">{sc.id}</span>
                  {sc.title}
                  {g.start === sc.id && <Badge tone="accent">起点</Badge>}
                  {sc.ending && (
                    <Badge tone={sc.ending.kind === 'good' ? 'ok' : sc.ending.kind === 'bad' ? 'err' : 'neutral'}>
                      {ENDING_KIND[sc.ending.kind]}
                      {sc.ending.hidden ? ' · 隐藏' : ''}
                    </Badge>
                  )}
                </div>
                {sc.what && <p className="mt-0.5 text-xs text-muted">{sc.what}</p>}
                {sc.points.length > 0 && (
                  <ul className="mt-1.5 space-y-1">
                    {sc.points.map((p) => (
                      <li key={p.id} className="flex gap-2 text-sm text-muted">
                        <span className="text-faint">·</span>
                        {p.text}
                      </li>
                    ))}
                  </ul>
                )}
                {sc.exits.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {sc.exits.map((e) => (
                      <span key={e.to} className="rounded-md bg-panel-2 px-2 py-0.5 text-xs text-muted">
                        → {titleOf(e.to)}
                        {e.label ? `（${e.label}）` : ''}
                        {e.auto ? ' · 自动' : ''}
                        {sc.default === e.to ? ' · 默认' : ''}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}
