/**
 * 素材页（18.3）：世界的每个素材槽、生成进度，重抽、锁定、改提示词、换成自己的图；这个世界的素材设置（18.11）。
 */
import type { AssetAction, AssetSlotView, AssetsControl, AssetsView } from '@auto-adv/engine/api';
import type { AssetSettings, AssetSettingsPatch } from '@auto-adv/schema';
import { type ReactNode, useEffect, useState } from 'react';
import { PlaceholderBg } from '../components/placeholder.tsx';
import { Badge, Button, Card, ConfirmButton, cx, Empty, Spinner, Textarea, useToast } from '../components/ui.tsx';
import { assetUrl, useAssetsContext } from '../lib/assets.tsx';
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
              <Spinner /> 正在画 {counts.running} 张
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
      {groups.map((g) => (
        <section key={g.kind} className="space-y-2">
          <h3 className="text-sm font-medium text-muted">{KIND_TITLE[g.kind]}</h3>
          <div className="grid grid-cols-2 gap-3">
            {g.slots.map((s) => (
              <SlotCard key={s.id} worldId={worldId} slot={s} view={view} onView={setViewing} />
            ))}
          </div>
        </section>
      ))}

      <WorldAssetSettings worldId={worldId} view={view} />

      {viewing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-8" onClick={() => setViewing(null)} data-testid="asset-viewer">
          <img src={assetUrl(worldId, viewing)} alt="" className="max-h-full max-w-full rounded-lg object-contain" />
          <EscToClose onClose={() => setViewing(null)} />
        </div>
      )}
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
  return (
    <Card className="overflow-hidden" data-testid="asset-slot" data-slot={slot.id} data-status={slot.status}>
      <button
        type="button"
        className="relative block aspect-video w-full overflow-hidden bg-black"
        style={{ containerType: 'inline-size' }}
        onClick={() => slot.file && onView(slot.file)}
        disabled={!slot.file}
        title={slot.file ? '查看大图' : undefined}
      >
        {slot.file ? (
          <img src={assetUrl(worldId, slot.file)} alt="" className="absolute inset-0 h-full w-full object-cover" data-testid="asset-image" />
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
          <span className="min-w-0 truncate text-sm font-medium">{slot.title}</span>
          <Badge tone={st.tone}>{slot.requested && slot.status !== 'running' ? '排队中' : st.text}</Badge>
          {slot.locked && <Badge tone="accent">锁定</Badge>}
          {slot.source === 'uploaded' && <Badge>自己的图</Badge>}
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
                className="relative aspect-video w-14 shrink-0 overflow-hidden rounded border border-line hover:border-accent"
                onClick={() => void act('use', h.file)}
              >
                <img src={assetUrl(worldId, h.file)} alt="" className="absolute inset-0 h-full w-full object-cover" />
              </button>
            ))}
          </div>
        )}
      </div>
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
