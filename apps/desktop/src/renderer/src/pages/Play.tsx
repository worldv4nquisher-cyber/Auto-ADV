import type { PathEvent, PlayChunk, PlayView, SceneState, Segment, WorldDetail } from '@auto-adv/engine/api';
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { EventBlock, Segments, useColorOf } from '../components/story.tsx';
import { Button, Card, ConfirmButton, cx, Input, Markdown, Select, Spinner, Textarea, useToast } from '../components/ui.tsx';
import { engine, errorMessage, isAborted } from '../lib/engine.ts';
import { formatTime } from '../lib/format.ts';
import { useRouter } from '../lib/router.tsx';
import { AdvPage } from './Adv.tsx';
import { ObservePage } from './Observe.tsx';

interface Streaming {
  /** 显示到哪个事件为止（含），之后是正在生成的内容。 */
  baseLen: number;
  player: PathEvent | null;
  segs: Segment[];
  phase: Extract<PlayChunk, { type: 'phase' }>['phase'] | null;
}

const PHASE_TEXT = { memory: '正在整理前情提要…', thinking: '思考中…', writing: '', detour: '正在整理剧情图…' } as const;

export function PlayPage({ worldId, playthroughId }: { worldId: string; playthroughId: string }) {
  const { navigate } = useRouter();
  const toast = useToast();
  const ref = { worldId, playthroughId };
  const [world, setWorld] = useState<WorldDetail | null>(null);
  const [view, setView] = useState<PlayView | null>(null);
  const [streaming, setStreaming] = useState<Streaming | null>(null);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    Promise.all([engine.call('getWorld', { id: worldId }), engine.call('getPlaythrough', { worldId, playthroughId })])
      .then(([w, v]) => {
        setWorld(w);
        setView(v);
      })
      .catch((err) => setError(errorMessage(err)));
    return () => controller.current?.abort();
  }, [worldId, playthroughId]);

  // 内容变化时，如果本来就在底部，就跟着滚到底
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  const colorOf = useColorOf(world);

  /** 调用一个会改变周目的操作，统一处理错误。 */
  const act = async (fn: () => Promise<PlayView>) => {
    try {
      setView(await fn());
    } catch (err) {
      toast('err', errorMessage(err));
    }
  };

  const runStream = async (
    baseLen: number,
    start: (onChunk: (c: PlayChunk) => void, signal: AbortSignal) => Promise<PlayView>,
  ) => {
    const ac = new AbortController();
    controller.current = ac;
    stick.current = true;
    setStreaming({ baseLen, player: null, segs: [], phase: null });
    try {
      const v = await start((c) => {
        setStreaming((s) => {
          if (!s) return s;
          if (c.type === 'phase') return { ...s, phase: c.phase };
          if (c.type === 'player') return { ...s, player: c.event };
          const segs = [...s.segs];
          segs[c.index] = c.seg;
          return { ...s, segs };
        });
      }, ac.signal);
      setView(v);
    } catch (err) {
      if (!isAborted(err)) toast('err', errorMessage(err));
      // 玩家的话可能已经保存了，重新拉一次
      engine.call('getPlaythrough', ref).then(setView, () => {});
    } finally {
      controller.current = null;
      setStreaming(null);
    }
  };

  const send = (text: string, parentId?: string) => {
    if (!view || streaming) return;
    const baseLen = parentId ? view.path.findIndex((e) => e.id === parentId) + 1 : view.path.length;
    setInput('');
    void runStream(baseLen, (onChunk, signal) =>
      engine.stream('send', { ...ref, text, parentId }, onChunk, signal),
    );
  };

  const regenerate = (e: PathEvent) => {
    if (!view || streaming) return;
    const baseLen = view.path.findIndex((x) => x.id === e.id);
    void runStream(baseLen, (onChunk, signal) => engine.stream('regenerate', { ...ref, eventId: e.id }, onChunk, signal));
  };

  if (error) {
    return (
      <div className="p-8 text-sm text-err">
        {error}
        <Button className="ml-3" onClick={() => navigate({ page: 'world', worldId })}>
          返回
        </Button>
      </div>
    );
  }
  if (!world || !view) {
    return (
      <div className="flex h-full items-center justify-center text-muted">
        <Spinner />
      </div>
    );
  }

  if (view.playthrough.mode === 'adv') {
    return <AdvPage world={world} initial={view} onBack={() => navigate({ page: 'world', worldId })} />;
  }
  if (view.playthrough.mode === 'observer') {
    return <ObservePage world={world} initial={view} onBack={() => navigate({ page: 'world', worldId })} />;
  }

  const protagonist = world.characters.find((c) => c.id === view.playthrough.protagonistId);
  const shown = streaming ? view.path.slice(0, streaming.baseLen) : view.path;
  const busy = !!streaming;

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send(input.trim());
    }
  };

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-6">
          <Button size="sm" variant="ghost" onClick={() => navigate({ page: 'world', worldId })}>
            ‹ {world.manifest.title}
          </Button>
          <span className="text-sm text-faint">{view.playthrough.title}</span>
          {protagonist && <span className="ml-auto text-xs text-faint">你扮演：{protagonist.name}</span>}
        </div>

        <div
          ref={scroller}
          className="flex-1 overflow-y-auto"
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
          }}
        >
          <div className="mx-auto max-w-3xl space-y-5 px-8 py-8" data-testid="play-log">
            {shown.map((e, i) => (
              <EventBlock
                key={e.id}
                e={e}
                world={world}
                isLast={i === shown.length - 1 && !streaming}
                busy={busy}
                protagonistName={protagonist?.name ?? '你'}
                colorOf={colorOf}
                onRegenerate={() => regenerate(e)}
                onSwitch={(id) => act(() => engine.call('switchBranch', { ...ref, eventId: id }))}
                onRewind={() => act(() => engine.call('rewind', { ...ref, eventId: e.id }))}
                onDelete={() => act(() => engine.call('deleteBranch', { ...ref, eventId: e.id }))}
                onEdit={(text) => act(() => engine.call('editEvent', { ...ref, eventId: e.id, text }))}
                onResend={(text) => send(text, e.parentId ?? undefined)}
              />
            ))}
            {streaming?.player && (
              <EventBlock
                e={streaming.player}
                world={world}
                isLast={false}
                busy
                protagonistName={protagonist?.name ?? '你'}
                colorOf={colorOf}
              />
            )}
            {streaming && (
              <div data-testid="play-streaming">
                <Segments segs={streaming.segs} colorOf={colorOf} />
                {(streaming.phase !== 'writing' || !streaming.segs.length) && (
                  <div className="mt-2 flex items-center gap-2 text-sm text-faint">
                    <Spinner /> {streaming.phase ? PHASE_TEXT[streaming.phase] || '…' : '…'}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="shrink-0 border-t border-line px-8 py-4">
          <div className="mx-auto flex max-w-3xl items-end gap-2">
            <Textarea
              data-testid="play-input"
              rows={2}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKey}
              placeholder={`以${protagonist?.name ?? '主角'}的身份说话或行动……（Enter 发送，Shift+Enter 换行；留空直接发送 = 让角色们继续）`}
              className="min-h-[60px] resize-none"
            />
            {busy ? (
              <Button className="h-[60px] w-20" onClick={() => controller.current?.abort()}>
                停止
              </Button>
            ) : (
              <Button
                variant="primary"
                className="h-[60px] w-20"
                data-testid="play-send"
                onClick={() => send(input.trim())}
              >
                {input.trim() ? '发送' : '继续'}
              </Button>
            )}
          </div>
        </div>
      </div>

      <SidePanel
        world={world}
        view={view}
        busy={busy}
        onScene={(s) => act(() => engine.call('setScene', { ...ref, ...s }))}
        onSave={(name) => act(() => engine.call('saveSlot', { ...ref, name }))}
        onLoad={(saveId) => act(() => engine.call('loadSave', { ...ref, saveId }))}
        onDeleteSave={(saveId) => act(() => engine.call('deleteSave', { ...ref, saveId }))}
      />
    </div>
  );
}

// ───────────── 侧栏 ─────────────

function SidePanel({
  world,
  view,
  busy,
  onScene,
  onSave,
  onLoad,
  onDeleteSave,
}: {
  world: WorldDetail;
  view: PlayView;
  busy: boolean;
  onScene: (s: SceneState) => void;
  onSave: (name: string) => void;
  onLoad: (saveId: string) => void;
  onDeleteSave: (saveId: string) => void;
}) {
  const [editScene, setEditScene] = useState<SceneState | null>(null);
  const [saveName, setSaveName] = useState('');
  const others = world.characters.filter((c) => c.id !== view.playthrough.protagonistId);
  const loc = world.locations.find((l) => l.id === view.scene.locationId);

  return (
    <aside className="flex w-80 shrink-0 flex-col gap-4 overflow-y-auto border-l border-line bg-panel/50 p-4">
      <Card className="p-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-medium text-muted">场景</span>
          {!editScene && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditScene(view.scene)}>
              调整
            </Button>
          )}
        </div>
        {!editScene ? (
          <>
            <div className="text-sm font-medium">{loc?.name ?? '未指定地点'}</div>
            {loc?.description && <p className="mt-1 text-xs leading-relaxed text-muted">{loc.description}</p>}
            <div className="mt-2 text-xs text-faint">
              在场：
              {view.scene.presentCharacterIds
                .map((id) => world.characters.find((c) => c.id === id)?.name)
                .filter(Boolean)
                .join('、') || '无'}
            </div>
          </>
        ) : (
          <div className="space-y-3">
            <Select
              value={editScene.locationId ?? ''}
              onChange={(e) => setEditScene({ ...editScene, locationId: e.target.value || null })}
            >
              <option value="">未指定</option>
              {world.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
            <div className="space-y-1">
              {others.map((c) => (
                <label key={c.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={editScene.presentCharacterIds.includes(c.id)}
                    onChange={(e) =>
                      setEditScene({
                        ...editScene,
                        presentCharacterIds: e.target.checked
                          ? [...editScene.presentCharacterIds, c.id]
                          : editScene.presentCharacterIds.filter((x) => x !== c.id),
                      })
                    }
                  />
                  {c.name}
                </label>
              ))}
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  onScene(editScene);
                  setEditScene(null);
                }}
              >
                切换场景
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditScene(null)}>
                取消
              </Button>
            </div>
          </div>
        )}
      </Card>

      <Card className="p-4">
        <div className="mb-2 text-xs font-medium text-muted">存档</div>
        <div className="flex gap-2">
          <Input
            className="h-8"
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            placeholder="存档名（可留空）"
          />
          <Button
            size="sm"
            className="h-8 shrink-0 whitespace-nowrap"
            data-testid="save-slot"
            disabled={busy}
            onClick={() => {
              onSave(saveName);
              setSaveName('');
            }}
          >
            保存
          </Button>
        </div>
        <div className="mt-3 space-y-2">
          {view.saves.length === 0 && <p className="text-xs text-faint">存档只记录位置，不占空间，可以随便存。</p>}
          {view.saves.map((s) => (
            <div key={s.id} className="rounded-lg border border-line p-2.5" data-testid="save">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm">{s.name}</span>
                <span className="shrink-0 text-[11px] text-faint">{formatTime(s.createdAt)}</span>
              </div>
              <p className="mt-0.5 line-clamp-2 text-xs text-muted">{s.preview}</p>
              <div className="mt-1.5 flex gap-1">
                <Button size="sm" disabled={busy} onClick={() => onLoad(s.id)} data-testid="load-save">
                  读取
                </Button>
                <ConfirmButton variant="ghost" onConfirm={() => onDeleteSave(s.id)}>
                  删除
                </ConfirmButton>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card className={cx('p-4', !view.memory && 'opacity-70')}>
        <div className="mb-2 text-xs font-medium text-muted">前情提要</div>
        {view.memory ? (
          <>
            <Markdown text={view.memory.text} className="text-xs" />
            <p className="mt-2 text-[11px] text-faint">已整理前 {view.memory.coveredEvents} 条内容</p>
          </>
        ) : (
          <p className="text-xs leading-relaxed text-faint">对话变长后，书记会自动把较早的内容整理成前情提要，让角色记得发生过什么。</p>
        )}
      </Card>
    </aside>
  );
}
