/**
 * 素材页（18.3）：世界的每个素材槽、生成进度，重抽、锁定、改提示词、换成自己的图；这个世界的素材设置（18.11）。
 * 立绘按角色分组，每个角色可以单独选要画哪些表情（18.5）。BGM 按情绪列出现在放什么、从哪个来源来（18.7）。
 */
import type { AssetAction, AssetSlotView, AssetsControl, AssetsView, MoodPlaylist } from '@auto-adv/engine/api';
import { type AssetSettings, type AssetSettingsPatch, BGM_SOURCE_LABELS, BGM_SOURCES, type BgmSource } from '@auto-adv/schema';
import { type ReactNode, useEffect, useState } from 'react';
import { hueOf, PlaceholderBg, PlaceholderSprite } from '../components/placeholder.tsx';
import { Badge, Button, Card, ConfirmButton, cx, Empty, Spinner, Textarea, useToast } from '../components/ui.tsx';
import { assetUrl, bgmUrl, useAssetsContext } from '../lib/assets.tsx';
import { engine, errorMessage } from '../lib/engine.ts';
import { useRouter } from '../lib/router.tsx';
import { AssetSettingsForm } from './AssetSettingsForm.tsx';

const STATUS: Record<AssetSlotView['status'], { text: string; tone: 'neutral' | 'ok' | 'warn' | 'err' | 'accent' }> = {
  pending: { text: '待生成', tone: 'neutral' },
  running: { text: '生成中', tone: 'accent' },
  done: { text: '完成', tone: 'ok' },
  stale: { text: '过期', tone: 'warn' },
  failed: { text: '失败', tone: 'err' },
  disabled: { text: '已关闭', tone: 'neutral' },
};

const KIND_TITLE: Record<AssetSlotView['kind'], string> = { background: '背景', sprite: '立绘', cg: 'CG', bgm: 'BGM' };

export function AssetsTab({ worldId }: { worldId: string }) {
  const ctx = useAssetsContext();
  const view = ctx?.view ?? null;
  const toast = useToast();
  const { navigate } = useRouter();
  const [viewing, setViewing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (!view) return <Spinner />;

  const control = async (action: AssetsControl) => {
    setBusy(action);
    try {
      await engine.call('assetsControl', { worldId, action });
    } catch (err) {
      toast('err', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const { counts, state } = view;
  const staleParams = view.slots.filter((s) => s.status === 'stale' && s.staleBy === 'params' && !s.requested).length;
  const groups = (['background', 'sprite', 'cg', 'bgm'] as const)
    .map((k) => ({ kind: k, slots: view.slots.filter((s) => s.kind === k) }))
    .filter((g) => g.slots.length > 0);

  return (
    <div className="space-y-4" data-testid="assets-tab">
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="text-sm font-medium" data-testid="assets-progress">
            素材 {counts.done} / {counts.total}
          </span>
          {counts.running > 0 && (
            <span className="flex items-center gap-1.5 text-xs text-accent-strong">
              <Spinner /> 正在生成 {counts.running} 个
            </span>
          )}
          {counts.failed > 0 && <span className="text-xs text-err">{counts.failed} 张失败</span>}
          <span className="text-xs text-faint">
            已经画了 {state.cap.used} 张，上限 {state.cap.limit} 张（算上重抽）
          </span>
          <div className="ml-auto flex gap-2">
            {state.paused ? (
              <Button size="sm" variant="primary" loading={busy === 'resume'} onClick={() => void control('resume')} data-testid="assets-resume">
                继续生成
              </Button>
            ) : (
              <Button size="sm" loading={busy === 'pause'} onClick={() => void control('pause')} data-testid="assets-pause">
                暂停生成
              </Button>
            )}
          </div>
        </div>
        {state.needsModel && (
          <Notice tone="warn" testId="assets-needs-model">
            还没有配图像模型，舞台上先用占位图。
            <button type="button" className="ml-1 underline" onClick={() => navigate({ page: 'settings' })}>
              到设置里配一个
            </button>
          </Notice>
        )}
        {state.cap.reached && (
          <Notice tone="warn" testId="assets-cap">
            已经画了 {state.cap.used} 张，到了这个世界的上限，{state.cap.action === 'ask' ? '先停下来等你确认' : '不再生成'}。
            <Button size="sm" className="ml-2" loading={busy === 'raiseCap'} onClick={() => void control('raiseCap')} data-testid="assets-raise-cap">
              再画 20 张
            </Button>
          </Notice>
        )}
        {staleParams > 0 && (
          <Notice tone="warn" testId="assets-stale">
            有 {staleParams} 张素材的提示词或设置改过了，还在用原来的图。
            <Button size="sm" className="ml-2" loading={busy === 'redrawStale'} onClick={() => void control('redrawStale')} data-testid="assets-redraw-stale">
              全部重画
            </Button>
          </Notice>
        )}
        {view.orphans.length > 0 && (
          <Notice tone="neutral">
            有 {view.orphans.length} 个素材已经用不上了（比如删掉的地点），文件还留着。
            <ConfirmButton size="sm" variant="ghost" onConfirm={() => void control('cleanOrphans')} confirmText="确认删除文件？">
              清理
            </ConfirmButton>
          </Notice>
        )}
      </Card>

      {groups.length === 0 && <Empty title="这个世界还没有要画的素材">创世生成地点、角色之后，这里会列出背景和立绘。</Empty>}
      {groups.map((g) =>
        g.kind === 'bgm' ? (
          <BgmSection key={g.kind} worldId={worldId} slots={g.slots} view={view} onControl={control} busy={busy} />
        ) : g.kind === 'sprite' ? (
          <section key={g.kind} className="space-y-3">
            <h3 className="text-sm font-medium text-muted">{KIND_TITLE[g.kind]}</h3>
            {byCharacter(g.slots).map(([charId, slots]) => (
              <CharacterSprites key={charId} worldId={worldId} characterId={charId} slots={slots} view={view} onView={setViewing} />
            ))}
          </section>
        ) : (
          <section key={g.kind} className="space-y-2">
            <h3 className="text-sm font-medium text-muted">{KIND_TITLE[g.kind]}</h3>
            <div className="grid grid-cols-2 gap-3">
              {g.slots.map((s) => (
                <SlotCard key={s.id} worldId={worldId} slot={s} view={view} onView={setViewing} />
              ))}
            </div>
          </section>
        ),
      )}

      <WorldAssetSettings worldId={worldId} view={view} />

      {viewing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-8" onClick={() => setViewing(null)} data-testid="asset-viewer">
          <img src={assetUrl(worldId, viewing)} alt="" className="max-h-full max-w-full rounded-lg object-contain" style={CHECKER} />
          <EscToClose onClose={() => setViewing(null)} />
        </div>
      )}
    </div>
  );
}

/** 透明的地方显示成棋盘格，一眼能看出抠干净没有。 */
const CHECKER = { background: 'repeating-conic-gradient(#3a3a40 0 25%, #2a2a2f 0 50%) 50% / 16px 16px' };

/** 立绘按角色分组，保持清单里的顺序。 */
function byCharacter(slots: AssetSlotView[]): [string, AssetSlotView[]][] {
  const out = new Map<string, AssetSlotView[]>();
  for (const s of slots) {
    const id = s.characterId ?? s.id.split('/')[1] ?? s.id;
    const list = out.get(id) ?? [];
    list.push(s);
    out.set(id, list);
  }
  return [...out];
}

/** 一个角色的立绘：基础立绘和表情差分，加上这个角色画哪些表情。 */
function CharacterSprites({
  worldId,
  characterId,
  slots,
  view,
  onView,
}: {
  worldId: string;
  characterId: string;
  slots: AssetSlotView[];
  view: AssetsView;
  onView: (file: string) => void;
}) {
  const name = slots[0]?.title.split(' · ')[0] ?? characterId;
  const review = slots.filter((s) => s.review).length;
  const [editing, setEditing] = useState(false);
  return (
    <div className="space-y-2" data-testid="asset-character" data-character={characterId}>
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">{name}</span>
        <span className="text-xs text-faint">{slots.length} 张</span>
        {review > 0 && <Badge tone="warn">{review} 张要看一下</Badge>}
        <button type="button" className="ml-auto text-xs text-accent-strong hover:underline" onClick={() => setEditing((e) => !e)} data-testid="char-expressions-toggle">
          {editing ? '收起' : '画哪些表情'}
        </button>
      </div>
      {editing && <CharacterExpressions worldId={worldId} characterId={characterId} current={slots.map((s) => s.expression ?? 'neutral')} view={view} />}
      <div className="grid grid-cols-3 gap-3">
        {slots.map((s) => (
          <SlotCard key={s.id} worldId={worldId} slot={s} view={view} onView={onView} />
        ))}
      </div>
    </div>
  );
}

/** 这个角色单独选表情（存在这个世界的素材设置里）；不选就按角色类型（主要角色 / 其他角色）的表情组。 */
function CharacterExpressions({ worldId, characterId, current, view }: { worldId: string; characterId: string; current: string[]; view: AssetsView }) {
  const toast = useToast();
  const own = view.settings.world.characters?.[characterId]?.expressions;
  const [picked, setPicked] = useState<string[]>(own ?? current);
  const [busy, setBusy] = useState(false);
  const table = view.settings.effective.expressions;
  const save = async (list: string[] | null) => {
    setBusy(true);
    try {
      const characters = { ...view.settings.world.characters };
      if (list) characters[characterId] = { ...characters[characterId], expressions: list };
      else delete characters[characterId];
      const { characters: _old, ...rest } = view.settings.world;
      await engine.call('saveWorldAssetSettings', {
        worldId,
        patch: Object.keys(characters).length ? { ...rest, characters } : rest,
      });
      if (!list) setPicked(current.filter((e) => e !== 'neutral'));
      toast('ok', list ? '已保存，缺的表情会接着画' : '已恢复成按角色类型');
    } catch (err) {
      toast('err', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((e) => e !== id) : [...p, id]));
  return (
    <div className="space-y-2 rounded-lg bg-panel-2 p-3" data-testid="char-expressions">
      <p className="text-xs text-faint">
        基础立绘（{table.find((e) => e.id === 'neutral')?.name ?? '平静'}）一定会画。去掉的表情不再画，已经画好的图留在文件里；
        AI 写到没画的表情时用基础立绘。{own ? '现在是这个角色单独选的。' : '现在按角色类型的表情组。'}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {table.map((e) => {
          const on = e.id === 'neutral' || picked.includes(e.id);
          return (
            <button
              key={e.id}
              type="button"
              disabled={e.id === 'neutral'}
              onClick={() => toggle(e.id)}
              data-testid="char-expression"
              data-expr={e.id}
              data-on={on}
              className={cx(
                'rounded-full border px-2.5 py-0.5 text-xs',
                on ? 'border-accent bg-accent/15 text-accent-strong' : 'border-line text-muted hover:border-accent',
                e.id === 'neutral' && 'opacity-70',
              )}
            >
              {e.name}
            </button>
          );
        })}
      </div>
      <div className="flex gap-1.5">
        <Button size="sm" variant="primary" loading={busy} onClick={() => void save(['neutral', ...picked.filter((e) => e !== 'neutral')])} data-testid="char-expressions-save">
          保存
        </Button>
        {own && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void save(null)}>
            恢复按角色类型
          </Button>
        )}
      </div>
    </div>
  );
}

function EscToClose({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose]);
  return null;
}

function Notice({ tone, children, testId }: { tone: 'warn' | 'neutral'; children: ReactNode; testId?: string }) {
  return (
    <div
      data-testid={testId}
      className={cx(
        'flex flex-wrap items-center rounded-lg px-3 py-2 text-xs',
        tone === 'warn' ? 'bg-warn/10 text-warn' : 'bg-panel-2 text-muted',
      )}
    >
      {children}
    </div>
  );
}

function SlotCard({
  worldId,
  slot,
  view,
  onView,
}: {
  worldId: string;
  slot: AssetSlotView;
  view: AssetsView;
  onView: (file: string) => void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [prompt, setPrompt] = useState(slot.prompt);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (!editing) setPrompt(slot.prompt);
  }, [slot.prompt, editing]);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      toast('err', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  const act = (action: AssetAction, file?: string) =>
    run(action, () => engine.call('assetAction', { worldId, slotId: slot.id, action, ...(file ? { file } : {}) }));
  const savePrompt = (redraw: boolean, value: string | null = prompt) =>
    run(redraw ? 'prompt-redraw' : 'prompt', async () => {
      await engine.call('assetSetPrompt', { worldId, slotId: slot.id, prompt: value, redraw });
      setEditing(false);
    });
  const upload = () =>
    run('upload', async () => {
      const file = await window.autoAdv.pickImage('换成自己的图');
      if (file) await engine.call('assetUpload', { worldId, slotId: slot.id, path: file });
    });

  const st = STATUS[slot.status];
  const canDraw = !view.state.needsModel && !slot.locked;
  const sprite = slot.kind === 'sprite';
  return (
    <Card className="overflow-hidden" data-testid="asset-slot" data-slot={slot.id} data-status={slot.status}>
      <button
        type="button"
        className={cx('relative block w-full overflow-hidden', sprite ? 'aspect-[2/3]' : 'aspect-video bg-black')}
        style={{ containerType: 'inline-size', ...(sprite ? CHECKER : {}) }}
        onClick={() => slot.file && onView(slot.file)}
        disabled={!slot.file}
        title={slot.file ? '查看大图' : undefined}
      >
        {slot.file ? (
          <img
            src={assetUrl(worldId, slot.file)}
            alt=""
            className={cx('absolute inset-0 h-full w-full', sprite ? 'object-contain' : 'object-cover')}
            data-testid="asset-image"
          />
        ) : sprite ? (
          <span className="absolute inset-0 flex justify-center pt-[8%] opacity-60">
            <PlaceholderSprite name={slot.title.split(' · ')[0] ?? ''} expr={slot.expression ?? 'neutral'} color={`hsl(${hueOf(slot.characterId ?? slot.id)} 45% 60%)`} />
          </span>
        ) : (
          <PlaceholderBg id={slot.id.replace(/^bg\//, '')} label={false} />
        )}
        {slot.status === 'running' && (
          <span className="absolute inset-0 flex items-center justify-center bg-black/40">
            <Spinner />
          </span>
        )}
      </button>
      <div className="space-y-2 p-3">
        <div className="flex items-center gap-2">
          <span className="min-w-0 truncate text-sm font-medium">{sprite ? (slot.title.split(' · ')[1] ?? slot.title) : slot.title}</span>
          <Badge tone={st.tone}>{slot.requested && slot.status !== 'running' ? '排队中' : st.text}</Badge>
          {slot.locked && <Badge tone="accent">锁定</Badge>}
          {slot.source === 'uploaded' && <Badge>自己的图</Badge>}
          {slot.review && (
            <Badge tone="warn" title={slot.review}>
              要看一下
            </Badge>
          )}
          {slot.upstreamChanged && (
            <Badge tone="warn" title="锁定之后提示词或设置改过，这张图是按原来的参数画的">
              参数改过
            </Badge>
          )}
        </div>
        {slot.subtitle && <p className="line-clamp-2 text-xs text-faint">{slot.subtitle}</p>}
        {slot.status === 'stale' && slot.staleBy === 'params' && !slot.requested && (
          <p className="text-xs text-warn">提示词或设置改过了，还在用原来的图。</p>
        )}
        {slot.error && slot.status === 'failed' && <p className="text-xs break-all text-err">{slot.error}</p>}
        {slot.review && (
          <p className="text-xs text-warn" data-testid="asset-review">
            抠图没过检查（{slot.review}），现在用的是没抠的原图。可以重抽、换成自己的图，或者在设置里换一种透明背景的做法。
          </p>
        )}
        <div className="flex flex-wrap gap-1.5">
          {slot.status === 'stale' && !slot.requested && (
            <Button size="sm" variant="primary" disabled={!canDraw} loading={busy === 'redraw'} onClick={() => void act('redraw')} data-testid="asset-redraw">
              重画
            </Button>
          )}
          {slot.status === 'failed' && (
            <Button size="sm" variant="primary" disabled={!canDraw} loading={busy === 'retry'} onClick={() => void act('retry')} data-testid="asset-retry">
              重试
            </Button>
          )}
          <Button
            size="sm"
            disabled={!canDraw || slot.status === 'disabled'}
            title={slot.locked ? '先解锁' : undefined}
            loading={busy === 'regenerate'}
            onClick={() => void act('regenerate')}
            data-testid="asset-regenerate"
          >
            重抽
          </Button>
          {slot.locked ? (
            <Button size="sm" variant="ghost" loading={busy === 'unlock'} onClick={() => void act('unlock')} data-testid="asset-unlock">
              解锁
            </Button>
          ) : (
            <Button size="sm" variant="ghost" disabled={!slot.file} loading={busy === 'lock'} onClick={() => void act('lock')} data-testid="asset-lock">
              锁定
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setEditing((e) => !e)} data-testid="asset-edit-prompt">
            提示词
          </Button>
          <Button size="sm" variant="ghost" loading={busy === 'upload'} onClick={() => void upload()}>
            换成自己的图
          </Button>
        </div>
        {editing && (
          <div className="space-y-2">
            <Textarea rows={6} value={prompt} onChange={(e) => setPrompt(e.target.value)} className="text-xs" data-testid="asset-prompt" />
            {slot.revisedPrompt && (
              <details className="text-xs text-faint">
                <summary className="cursor-pointer">服务端改写后的提示词</summary>
                <p className="mt-1 whitespace-pre-wrap">{slot.revisedPrompt}</p>
              </details>
            )}
            <div className="flex flex-wrap gap-1.5">
              <Button
                size="sm"
                variant="primary"
                disabled={!canDraw || !prompt.trim()}
                loading={busy === 'prompt-redraw'}
                onClick={() => void savePrompt(true)}
                data-testid="asset-prompt-redraw"
              >
                保存并重画
              </Button>
              <Button size="sm" disabled={!prompt.trim()} loading={busy === 'prompt'} onClick={() => void savePrompt(false)}>
                只保存
              </Button>
              {slot.promptEdited && (
                <Button size="sm" variant="ghost" onClick={() => void savePrompt(false, null)}>
                  恢复模板拼出来的
                </Button>
              )}
              <span className="ml-auto self-center text-[11px] text-faint">尺寸 {slot.size}</span>
            </div>
          </div>
        )}
        {slot.history.length > 0 && (
          <div className="flex items-center gap-1.5 overflow-x-auto pt-1">
            <span className="shrink-0 text-[11px] text-faint">之前的图</span>
            {slot.history.map((h) => (
              <button
                key={h.file}
                type="button"
                title="换回这张（会锁定）"
                className={cx(
                  'relative shrink-0 overflow-hidden rounded border border-line hover:border-accent',
                  sprite ? 'aspect-[2/3] w-10' : 'aspect-video w-14',
                )}
                style={sprite ? CHECKER : undefined}
                onClick={() => void act('use', h.file)}
              >
                <img src={assetUrl(worldId, h.file)} alt="" className={cx('absolute inset-0 h-full w-full', sprite ? 'object-contain' : 'object-cover')} />
              </button>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

const SOURCE_TEXT: Record<MoodPlaylist['source'] & string, string> = { ...BGM_SOURCE_LABELS, uploaded: '自己的文件' };

/** BGM：每个情绪现在放什么、从哪个来源来；本地曲库的情况。 */
function BgmSection({
  worldId,
  slots,
  view,
  onControl,
  busy,
}: {
  worldId: string;
  slots: AssetSlotView[];
  view: AssetsView;
  onControl: (a: AssetsControl) => Promise<void>;
  busy: string | null;
}) {
  const { navigate } = useRouter();
  const eff = view.settings.effective;
  const lib = view.bgm.library;
  const matched = lib?.tracks.filter((t) => t.mood).length ?? 0;
  const usesModel = eff.bgm.sources.includes('model') || Object.values(eff.bgm.pins).includes('model');
  return (
    <section className="space-y-2" data-testid="asset-bgm">
      <h3 className="text-sm font-medium text-muted">BGM</h3>
      <Card className="space-y-1.5 p-3 text-xs text-muted">
        <div>
          来源顺序：{eff.bgm.sources.map((x) => BGM_SOURCE_LABELS[x]).join(' → ') || '都关掉了'}
          {!eff.enabled.bgm && <span className="ml-2 text-warn">BGM 在设置里关掉了，舞台上不放音乐。</span>}
        </div>
        {lib ? (
          <div className="flex flex-wrap items-center gap-x-2" data-testid="asset-bgm-library-info">
            <span>
              本地曲库 <code className="rounded bg-panel-2 px-1">{lib.dir}</code>：
              {lib.error ? <span className="text-err">{lib.error}</span> : `${lib.tracks.length} 首，认出情绪的 ${matched} 首`}
              {lib.truncated && '（文件太多，只读了前 2000 个）'}
              {lib.classifying && '，正在让模型按文件名挑…'}
            </span>
            <Button size="sm" variant="ghost" loading={busy === 'rescanLibrary'} onClick={() => void onControl('rescanLibrary')} data-testid="asset-bgm-rescan">
              重新扫描
            </Button>
          </div>
        ) : (
          <div>没有选本地曲库（在下面「这个世界的素材设置」或者全局设置的 BGM 里选）。</div>
        )}
        <div>内置曲库：{view.bgm.builtinCount ? `${view.bgm.builtinCount} 首` : '还没有曲子'}</div>
        {usesModel && view.bgm.needsModel && (
          <div className="text-warn" data-testid="asset-bgm-needs-model">
            还没有配音乐模型，「音乐模型」这个来源先跳过。
            <button type="button" className="ml-1 underline" onClick={() => navigate({ page: 'settings' })}>
              到设置里配一个
            </button>
          </div>
        )}
      </Card>
      <div className="space-y-2">
        {view.bgm.playlists.map((p) => (
          <MoodRow key={p.mood} worldId={worldId} playlist={p} slot={slots.find((s) => s.mood === p.mood)} view={view} />
        ))}
      </div>
    </section>
  );
}

/** 一个情绪：现在的曲子（可以试听）、指定来源、音乐模型生成的那首的操作。 */
function MoodRow({ worldId, playlist: p, slot, view }: { worldId: string; playlist: MoodPlaylist; slot: AssetSlotView | undefined; view: AssetsView }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [pick, setPick] = useState(0);
  const pin = view.settings.effective.bgm.pins[p.mood] ?? '';
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      toast('err', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  const act = (action: AssetAction, file?: string) =>
    slot && run(action, () => engine.call('assetAction', { worldId, slotId: slot.id, action, ...(file ? { file } : {}) }));
  const upload = () =>
    slot &&
    run('upload', async () => {
      const file = await window.autoAdv.pickAudio('换成自己的音频文件');
      if (file) await engine.call('assetUpload', { worldId, slotId: slot.id, path: file });
    });
  const setPin = (value: BgmSource | '') =>
    run('pin', async () => {
      const world = view.settings.world;
      const pins = { ...world.bgm?.pins };
      if (value) pins[p.mood] = value;
      else delete pins[p.mood];
      const { pins: _old, ...bgmRest } = world.bgm ?? {};
      const bgm = Object.keys(pins).length ? { ...bgmRest, pins } : bgmRest;
      const { bgm: _b, ...rest } = world;
      await engine.call('saveWorldAssetSettings', { worldId, patch: Object.keys(bgm).length ? { ...rest, bgm } : rest });
    });
  const track = p.tracks[Math.min(pick, p.tracks.length - 1)];
  const st = slot ? STATUS[slot.status] : null;
  const generating = slot && (slot.status === 'running' || (slot.requested && slot.status !== 'done'));
  return (
    <Card className="space-y-2 p-3" data-testid="asset-mood" data-mood={p.mood} data-source={p.source ?? ''}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{p.name}</span>
        <code className="text-[11px] text-faint">{p.mood}</code>
        <Badge tone={p.source ? 'ok' : 'neutral'}>{p.source ? SOURCE_TEXT[p.source] : '没有曲子'}</Badge>
        {p.wantsModel && (
          <Badge tone="accent">{generating ? '音乐模型生成中' : '等音乐模型生成'}{p.tracks.length ? '，先用这个' : ''}</Badge>
        )}
        {slot?.locked && <Badge tone="accent">锁定</Badge>}
        {slot && slot.status === 'failed' && <Badge tone="err">生成失败</Badge>}
        <label className="ml-auto flex items-center gap-1.5 text-xs text-muted">
          来源
          <select
            value={pin}
            disabled={busy === 'pin'}
            onChange={(e) => void setPin(e.target.value as BgmSource | '')}
            className="rounded border border-line bg-panel px-1.5 py-0.5 text-xs"
            data-testid="asset-mood-pin"
          >
            <option value="">按顺序</option>
            {BGM_SOURCES.map((x) => (
              <option key={x} value={x}>
                只用{BGM_SOURCE_LABELS[x]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {slot?.subtitle && <p className="text-xs text-faint">{slot.subtitle}</p>}
      {p.tracks.length > 0 && track && (
        <div className="flex flex-wrap items-center gap-2">
          {p.tracks.length > 1 ? (
            <select
              value={pick}
              onChange={(e) => setPick(Number(e.target.value))}
              className="max-w-64 rounded border border-line bg-panel px-1.5 py-0.5 text-xs"
              data-testid="asset-mood-track"
            >
              {p.tracks.map((t, i) => (
                <option key={`${t.ref.kind}:${t.ref.path}`} value={i}>
                  {t.title}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-xs" data-testid="asset-mood-track">
              {track.title}
            </span>
          )}
          <audio key={bgmUrl(worldId, track)} src={bgmUrl(worldId, track)} controls preload="none" className="h-8" data-testid="asset-mood-audio" />
          {track.credit && <span className="text-[11px] text-faint">{track.credit}</span>}
        </div>
      )}
      {slot?.error && slot.status === 'failed' && <p className="text-xs break-all text-err">{slot.error}</p>}
      {slot && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-faint">音乐模型的这首：{st?.text}</span>
          {slot.status === 'failed' && (
            <Button size="sm" variant="primary" disabled={view.bgm.needsModel} loading={busy === 'retry'} onClick={() => void act('retry')}>
              重试
            </Button>
          )}
          <Button
            size="sm"
            disabled={view.bgm.needsModel || slot.locked}
            title={view.bgm.needsModel ? '先在设置里配音乐模型' : slot.locked ? '先解锁' : '用音乐模型生成一首新的'}
            loading={busy === 'regenerate'}
            onClick={() => void act('regenerate')}
            data-testid="asset-mood-regenerate"
          >
            {slot.file ? '重新生成' : '生成'}
          </Button>
          {slot.locked ? (
            <Button size="sm" variant="ghost" loading={busy === 'unlock'} onClick={() => void act('unlock')}>
              解锁
            </Button>
          ) : (
            <Button size="sm" variant="ghost" disabled={!slot.file} loading={busy === 'lock'} onClick={() => void act('lock')}>
              锁定
            </Button>
          )}
          <Button size="sm" variant="ghost" loading={busy === 'upload'} onClick={() => void upload()} data-testid="asset-mood-upload">
            换成自己的文件
          </Button>
          {slot.history.map((h, i) => (
            <Button key={h.file} size="sm" variant="ghost" title={h.file} onClick={() => void act('use', h.file)}>
              换回之前的{slot.history.length > 1 ? ` ${i + 1}` : ''}
            </Button>
          ))}
        </div>
      )}
    </Card>
  );
}

/** 这个世界的素材设置：只保存和全局不一样的项。 */
function WorldAssetSettings({ worldId, view }: { worldId: string; view: AssetsView }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const save = async (patch: AssetSettingsPatch | AssetSettings) => {
    try {
      await engine.call('saveWorldAssetSettings', { worldId, patch: patch as AssetSettingsPatch });
      toast('ok', '已保存这个世界的素材设置');
    } catch (err) {
      toast('err', errorMessage(err));
    }
  };
  const overridden = Object.keys(view.settings.world).length;
  return (
    <Card className="p-4">
      <button type="button" className="flex w-full items-center gap-2 text-left" onClick={() => setOpen((o) => !o)} data-testid="world-asset-settings-toggle">
        <span className="text-sm font-medium">这个世界的素材设置</span>
        <span className="text-xs text-faint">{overridden ? `改了 ${overridden} 项，其余跟着全局设置` : '全部跟着全局设置'}</span>
        <span className="ml-auto text-xs text-muted">{open ? '收起' : '展开'}</span>
      </button>
      {open && (
        <div className="mt-4">
          <AssetSettingsForm mode="world" global={view.settings.global} value={view.settings.world} onSave={save} />
        </div>
      )}
    </Card>
  );
}
