/**
 * 世界编辑器（M5 第 1 步，docs/ARCHITECTURE.md 20.5）：世界页每个标签的阅读视图和编辑表单。
 * 每块内容一个 EditPanel：点「编辑」进表单，能切到 JSON、看历史版本；字段旁边的锁表示重抽时不会被覆盖，
 * 手改过的字段保存时自动锁住（设置里可以关），点一下锁能解开。
 */
import type {
  DeletedEntity,
  EntityKind,
  HistoryEntry,
  RenameHit,
  RevKey,
  SaveWorldPartParams,
  SaveWorldPartResult,
  WorldDetail,
  WorldIssue,
  WorldPartKey,
  WorldRef,
} from '@auto-adv/engine/api';
import {
  Character,
  Location,
  LoreEntry,
  StoryOpening,
  StyleGuide,
  type VariableDef,
  WorldBrief,
} from '@auto-adv/schema';
import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { BgImage } from '../lib/assets.tsx';
import { engine, errorMessage, isAborted } from '../lib/engine.ts';
import { formatTime } from '../lib/format.ts';
import { useSettings } from '../lib/settings.tsx';
import { Badge, Button, Card, cx, Empty, Field, Input, Markdown, Select, Spinner, Textarea, useToast } from '../components/ui.tsx';

// ───────────── 上下文 ─────────────

interface EditCtx {
  world: WorldDetail;
  /** 保存成功后换上引擎返回的最新世界。 */
  onSaved: (w: WorldDetail) => void;
  /** 有没保存的修改：离开标签前要问。 */
  setDirty: (id: string, dirty: boolean) => void;
}

const EditContext = createContext<EditCtx | null>(null);

export function EditProvider({ value, children }: { value: EditCtx; children: ReactNode }) {
  return <EditContext.Provider value={value}>{children}</EditContext.Provider>;
}

function useEdit(): EditCtx {
  const ctx = useContext(EditContext);
  if (!ctx) throw new Error('EditProvider 缺失');
  return ctx;
}

/** 保存一块内容。 */
async function savePart(p: SaveWorldPartParams, onSaved: (w: WorldDetail) => void): Promise<SaveWorldPartResult> {
  const r = await engine.call('saveWorldPart', p);
  onSaved(r.world);
  return r;
}

/** 编辑中的这块内容：给字段旁边的「AI 重写」用（20.4"一个字段"）。 */
interface PanelCtx {
  /** 这块内容的键；新建的只有类型（`character:`）。 */
  partKey: RevKey;
  draft: unknown;
  setDraft: (v: unknown) => void;
  /** AI 写进来的字段：保存时不当成手改的，不自动锁。 */
  markAi: (path: string) => void;
}

const PanelContext = createContext<PanelCtx | null>(null);

function setPath<T>(v: T, path: string, value: unknown): T {
  const [head, ...rest] = path.split('.') as [string, ...string[]];
  const base = { ...(v as Record<string, unknown>) };
  base[head] = rest.length ? setPath(base[head], rest.join('.'), value) : value;
  return base as T;
}

// ───────────── 小工具 ─────────────

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function getPath(v: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((x, k) => (x && typeof x === 'object' ? (x as Record<string, unknown>)[k] : undefined), v);
}

const splitList = (s: string) =>
  s
    .split(/[、，,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
const splitLines = (s: string) =>
  s
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);

/** 用顿号分隔的一串词。自己留着原文，免得打字时光标乱跳。 */
function ListInput({ value, onChange, placeholder, testId }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; testId?: string }) {
  const [text, setText] = useState(value.join('、'));
  const last = useRef(value);
  useEffect(() => {
    if (!same(value, last.current) && !same(value, splitList(text))) setText(value.join('、'));
    last.current = value;
  }, [value, text]);
  return (
    <Input
      value={text}
      placeholder={placeholder ?? '用顿号分开'}
      data-testid={testId}
      onChange={(e) => {
        setText(e.target.value);
        onChange(splitList(e.target.value));
      }}
      onBlur={() => setText(splitList(text).join('、'))}
    />
  );
}

/** 一行一条。 */
function LinesInput({ value, onChange, rows = 3, testId }: { value: string[]; onChange: (v: string[]) => void; rows?: number; testId?: string }) {
  const [text, setText] = useState(value.join('\n'));
  const last = useRef(value);
  useEffect(() => {
    if (!same(value, last.current) && !same(value, splitLines(text))) setText(value.join('\n'));
    last.current = value;
  }, [value, text]);
  return (
    <Textarea
      rows={rows}
      value={text}
      data-testid={testId}
      placeholder="一行一条"
      onChange={(e) => {
        setText(e.target.value);
        onChange(splitLines(e.target.value));
      }}
    />
  );
}

function LockIcon({ open }: { open?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d={open ? 'M5.5 7V4.8a2.5 2.5 0 0 1 4.9-.6' : 'M5.5 7V4.8a2.5 2.5 0 0 1 5 0V7'} />
    </svg>
  );
}

// ───────────── 锁 ─────────────

interface LockApi {
  /** 现在是不是锁着（含"保存时会自动锁上"）。 */
  state: (path: string) => 'locked' | 'pending' | 'open';
  toggle: (path: string) => void;
}

/** 带锁的字段：标签旁边一把锁，锁着的重抽时不会被覆盖（20.4）。 */
function LField({
  label,
  path,
  lock,
  hint,
  className,
  ai,
  children,
}: {
  label: string;
  path?: string;
  lock?: LockApi;
  hint?: ReactNode;
  className?: string;
  /** 旁边放一个「AI 重写」：只重写这一个字段，写进表单，看过再存。 */
  ai?: boolean;
  children: ReactNode;
}) {
  const st = path && lock ? lock.state(path) : null;
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-medium text-muted">{label}</span>
        {ai && path && <RewriteButton path={path} label={label} />}
        {st && path && lock && (
          <button
            type="button"
            data-testid={`lock-${path}`}
            data-state={st}
            onClick={() => lock.toggle(path)}
            title={
              st === 'locked'
                ? '锁着：重抽时不会被覆盖。点一下解开'
                : st === 'pending'
                  ? '改过了，保存时会自动锁住。点一下不锁'
                  : '没锁：重抽时会重新写。点一下锁住'
            }
            className={cx(
              'flex size-4 items-center justify-center rounded transition-colors',
              st === 'locked' && 'text-accent-strong',
              st === 'pending' && 'text-accent-strong/60',
              st === 'open' && 'text-faint/60 hover:text-muted',
            )}
          >
            <LockIcon open={st === 'open'} />
          </button>
        )}
      </div>
      {children}
      {hint && <span className="text-xs text-faint">{hint}</span>}
    </div>
  );
}

/** 只重写一个字段（20.4）：可以附一句要求；写好的放进表单，不直接保存。 */
function RewriteButton({ path, label }: { path: string; label: string }) {
  const { world } = useEdit();
  const panel = useContext(PanelContext);
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [chars, setChars] = useState<number | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  if (!panel) return null;
  const run = async () => {
    ctrl.current = new AbortController();
    setChars(0);
    try {
      const r = await engine.stream(
        'rewriteField',
        { worldId: world.manifest.id, key: panel.partKey, path, data: panel.draft, ...(note.trim() ? { note: note.trim() } : {}) },
        (c) => setChars(c.chars),
        ctrl.current.signal,
      );
      panel.setDraft(setPath(panel.draft, path, r.text));
      panel.markAi(path);
      setOpen(false);
      setNote('');
    } catch (err) {
      if (!isAborted(err)) toast('err', errorMessage(err));
    } finally {
      setChars(null);
    }
  };
  return (
    <span className="relative">
      <button
        type="button"
        data-testid={`rewrite-${path}`}
        onClick={() => setOpen(!open)}
        title="让 AI 只重写这一项，写好放进表单，看过再保存"
        className="rounded px-1 text-[11px] text-faint transition-colors hover:bg-panel-2 hover:text-accent-strong"
      >
        AI 重写
      </button>
      {open && (
        <div className="absolute top-5 left-0 z-30 w-72 rounded-lg border border-line bg-panel p-3 shadow-lg" data-testid="rewrite-popover">
          <div className="mb-2 text-xs text-muted">重写「{label}」</div>
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="要求（可以不写），比如：再阴暗一点" data-testid="rewrite-note" autoFocus />
          <div className="mt-2 flex items-center justify-end gap-2">
            {chars !== null && <span className="mr-auto text-xs text-faint">正在写…… {chars} 字</span>}
            <Button size="sm" variant="ghost" onClick={() => (chars !== null ? ctrl.current?.abort() : setOpen(false))}>
              {chars !== null ? '停止' : '取消'}
            </Button>
            <Button size="sm" variant="primary" loading={chars !== null} onClick={() => void run()} data-testid="rewrite-go">
              重写
            </Button>
          </div>
        </div>
      )}
    </span>
  );
}

// ───────────── 编辑面板 ─────────────

interface PanelProps<T> {
  /** 唯一的 id，也用在 testid 上（edit-<id>）。 */
  id: string;
  title?: ReactNode;
  value: T;
  /** 现在的锁（实体的 _meta.locked，或者世界的 locked 里和这块有关的）。 */
  locked: string[];
  /** 历史版本的键；新建的没有。 */
  historyKey?: WorldPartKey;
  /** 新建：一打开就在编辑，取消就扔掉。 */
  isNew?: boolean;
  onDiscard?: () => void;
  view: ReactNode;
  form: (draft: T, set: (t: T) => void, lock: LockApi) => ReactNode;
  save: (draft: T, locks: { locked: string[]; unlocked: string[] }) => Promise<void>;
  /** 编辑时右上角多出来的按钮（删除）。 */
  actions?: ReactNode;
  className?: string;
  /** 只在编辑时加的样式（比如在网格里占满一行）。 */
  editClassName?: string;
  /** 这块内容的键（给「AI 重写」用）；新建的写类型加冒号。 */
  partKey?: RevKey;
  /** 「整个锁住」时的锁：实体是 `*`，世界观是 `worldview`……不给就没有这个按钮。 */
  wholeLock?: string[];
  /** 「重抽」：只重写这一个实体（20.4）。 */
  reroll?: { kind: EntityKind; id: string; name: string };
}

export function EditPanel<T>({ id, title, value, locked, historyKey, isNew, onDiscard, view, form, save, actions, className, editClassName, partKey, wholeLock, reroll }: PanelProps<T>) {
  const { world, setDirty, onSaved } = useEdit();
  const { settings } = useSettings();
  const autoLock = settings?.editor.autoLock ?? true;
  const toast = useToast();
  const [editing, setEditing] = useState(!!isNew);
  const [draft, setDraft] = useState<T>(value);
  const [locks, setLocks] = useState<string[]>(locked);
  const [unlocked, setUnlocked] = useState<Set<string>>(new Set());
  const [json, setJson] = useState<string | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState(false);
  const [rerolling, setRerolling] = useState(false);
  const fullyLocked = !!wholeLock && (locked.includes('*') || wholeLock.every((x) => locked.includes(x)));
  const toggleWhole = async () => {
    if (!wholeLock) return;
    try {
      await save(value, { locked: fullyLocked ? [] : wholeLock, unlocked: [] });
      toast('ok', fullyLocked ? '解开了，重抽时会重新写' : '整个锁住了，重抽时原样留下');
    } catch (err) {
      toast('err', errorMessage(err));
    }
  };

  const begin = (from: T = value) => {
    setDraft(from);
    setLocks(locked);
    setUnlocked(new Set());
    setJson(null);
    setJsonError(null);
    setEditing(true);
  };
  const dirty = editing && (isNew || !same(draft, value) || !same(locks, locked) || json !== null);
  useEffect(() => {
    setDirty(id, !!dirty);
    return () => setDirty(id, false);
  }, [dirty, id, setDirty]);

  const lockApi: LockApi = {
    state: (path) => {
      if (locks.includes('*') || locks.some((x) => x === path || path.startsWith(`${x}.`))) return 'locked';
      const changed = isNew ? !same(getPath(draft, path) ?? '', '') : !same(getPath(draft, path), getPath(value, path));
      return autoLock && changed && !unlocked.has(path) ? 'pending' : 'open';
    },
    toggle: (path) => {
      const st = lockApi.state(path);
      if (st === 'locked') {
        setLocks(locks.includes('*') ? [] : locks.filter((x) => !(x === path || path.startsWith(`${x}.`))));
        setUnlocked(new Set([...unlocked, path]));
      } else if (st === 'pending') {
        setUnlocked(new Set([...unlocked, path]));
      } else {
        setLocks([...locks, path]);
        const u = new Set(unlocked);
        u.delete(path);
        setUnlocked(u);
      }
    },
  };

  const parseJson = (): T | null => {
    if (json === null) return draft;
    try {
      const v = JSON.parse(json) as T;
      setJsonError(null);
      return v;
    } catch (err) {
      setJsonError(`JSON 写得不对：${(err as Error).message}`);
      return null;
    }
  };

  const doSave = async () => {
    const data = parseJson();
    if (data === null) return;
    setSaving(true);
    try {
      await save(data, { locked: locks, unlocked: [...unlocked] });
      setEditing(false);
      setJson(null);
      if (isNew) onDiscard?.();
      toast('ok', '已保存');
    } catch (err) {
      if (!(err instanceof Cancelled)) toast('err', errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    setEditing(false);
    setJson(null);
    if (isNew) onDiscard?.();
  };

  if (!editing) {
    return (
      <div className={cx('group relative', className)} data-panel={id}>
        {view}
        {world.editable && (
          <div className="absolute top-3 right-3 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            {wholeLock && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void toggleWhole()}
                data-testid={`lockall-${id}`}
                data-state={fullyLocked ? 'locked' : 'open'}
                title={fullyLocked ? '整个锁着：重抽时原样留下。点一下解开' : '整个锁住：重抽这一步时原样留下'}
              >
                <LockIcon open={!fullyLocked} />
                {fullyLocked ? '解锁' : '锁住'}
              </Button>
            )}
            {reroll && (
              <Button
                size="sm"
                variant="ghost"
                disabled={fullyLocked || locked.includes('*')}
                title={locked.includes('*') ? '整个锁住了，先解锁再重抽' : '只重写这一个，锁住的字段留着'}
                onClick={() => setRerolling(true)}
                data-testid={`reroll-${id}`}
              >
                重抽
              </Button>
            )}
            {historyKey && (
              <Button size="sm" variant="ghost" onClick={() => setHistory(true)} data-testid={`history-${id}`}>
                历史
              </Button>
            )}
            <Button size="sm" onClick={() => begin()} data-testid={`edit-${id}`}>
              编辑
            </Button>
          </div>
        )}
        {history && historyKey && (
          <HistoryDialog
            historyKey={historyKey}
            onClose={() => setHistory(false)}
            onPick={(data) => {
              setHistory(false);
              begin(data as T);
            }}
          />
        )}
        {rerolling && reroll && (
          <RerollDialog
            title={`重抽「${reroll.name}」`}
            detail={
              <>
                只重写这一个，id 不变，剧情图和素材里的引用都不断。重写之前的版本进历史，不满意可以退回去。
                {locked.length > 0 && <span className="text-accent-strong">锁住的 {locked.length} 项原样留下。</span>}
              </>
            }
            onClose={() => setRerolling(false)}
            run={async (note, onChars, signal) => {
              const w = await engine.stream(
                'rerollEntity',
                { worldId: world.manifest.id, kind: reroll.kind, id: reroll.id, ...(note ? { note } : {}) },
                (c) => onChars(c.chars),
                signal,
              );
              onSaved(w);
              toast('ok', `重写好了「${reroll.name}」`);
            }}
          />
        )}
      </div>
    );
  }

  return (
    <Card className={cx('p-5', className, editClassName)} data-testid={`editing-${id}`} data-panel={id}>
      <div className="mb-4 flex items-center gap-2">
        <div className="min-w-0 flex-1 text-sm font-medium">{title}</div>
        {actions}
        <Button
          size="sm"
          variant="ghost"
          data-testid="toggle-json"
          onClick={() => {
            if (json === null) setJson(JSON.stringify(draft, null, 2));
            else {
              const v = parseJson();
              if (v !== null) {
                setDraft(v);
                setJson(null);
              }
            }
          }}
        >
          {json === null ? 'JSON' : '表单'}
        </Button>
      </div>
      {json === null ? (
        <PanelContext.Provider
          value={{
            partKey: partKey ?? ((historyKey ?? 'manifest') as RevKey),
            draft,
            setDraft: (v) => setDraft(v as T),
            markAi: (path) => {
              if (lockApi.state(path) !== 'locked') setUnlocked((u) => new Set([...u, path]));
            },
          }}
        >
          <div className="space-y-4">{form(draft, setDraft, lockApi)}</div>
        </PanelContext.Provider>
      ) : (
        <div className="space-y-2">
          <Textarea
            rows={18}
            className="font-mono text-xs"
            value={json}
            spellCheck={false}
            data-testid="json-editor"
            onChange={(e) => setJson(e.target.value)}
          />
          <p className="text-xs text-faint">直接改源文件。保存时按格式校验，不合格的不会存进去。锁在 `_meta.locked` 里。</p>
        </div>
      )}
      {jsonError && <p className="mt-2 text-xs text-err">{jsonError}</p>}
      <div className="mt-5 flex items-center justify-end gap-2 border-t border-line pt-4">
        {autoLock && <span className="mr-auto text-xs text-faint">改过的字段保存时自动锁住，之后重抽不会冲掉</span>}
        <Button variant="ghost" onClick={cancel} data-testid="cancel-edit">
          取消
        </Button>
        <Button variant="primary" loading={saving} onClick={() => void doSave()} data-testid="save-edit">
          保存
        </Button>
      </div>
    </Card>
  );
}

const REASON_TEXT: Record<HistoryEntry['reason'], string> = { edit: '你改之前', genesis: '重新生成之前', delete: '删掉之前' };

function HistoryDialog({ historyKey, onClose, onPick }: { historyKey: WorldPartKey; onClose: () => void; onPick: (data: unknown) => void }) {
  const { world } = useEdit();
  const toast = useToast();
  const [items, setItems] = useState<HistoryEntry[] | null>(null);
  const [sel, setSel] = useState<{ name: string; text: string; data: unknown } | null>(null);
  useEffect(() => {
    engine.call('worldHistory', { worldId: world.manifest.id, key: historyKey }).then(setItems, (err) => toast('err', errorMessage(err)));
  }, [world.manifest.id, historyKey, toast]);
  const open = async (name: string) => {
    try {
      const r = await engine.call('worldHistoryRead', { worldId: world.manifest.id, key: historyKey, name });
      setSel({ name, ...r });
    } catch (err) {
      toast('err', errorMessage(err));
    }
  };
  return (
    <Modal onClose={onClose} testId="history-dialog" wide>
      <div className="mb-4 text-base font-semibold">历史版本</div>
      <div className="grid grid-cols-[200px_1fr] gap-4">
        <div className="max-h-[60vh] space-y-1 overflow-y-auto">
          {items === null && <Spinner />}
          {items?.length === 0 && <p className="text-sm text-faint">还没有历史版本。保存、重抽之前会把原来的存下来。</p>}
          {items?.map((h) => (
            <button
              key={h.name}
              type="button"
              data-testid="history-item"
              onClick={() => void open(h.name)}
              className={cx(
                'block w-full rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors',
                sel?.name === h.name ? 'bg-accent-soft text-fg' : 'text-muted hover:bg-panel-2',
              )}
            >
              <div>{formatTime(Date.parse(h.at))}</div>
              <div className="text-faint">{REASON_TEXT[h.reason]}</div>
            </button>
          ))}
        </div>
        <div className="min-w-0">
          {sel ? (
            <pre className="max-h-[60vh] overflow-auto rounded-lg bg-bg p-3 text-xs leading-relaxed whitespace-pre-wrap text-muted">{sel.text}</pre>
          ) : (
            <p className="text-sm text-faint">点左边的一个版本看内容。</p>
          )}
        </div>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          关闭
        </Button>
        {sel && sel.data === null && <span className="mr-auto self-center text-xs text-warn">这个版本的格式读不懂，只能看</span>}
        <Button variant="primary" disabled={!sel || sel.data === null} onClick={() => sel && onPick(sel.data)} data-testid="history-restore">
          用这个版本（先看一下再保存）
        </Button>
      </div>
    </Modal>
  );
}

export function Modal({ children, onClose, testId, wide }: { children: ReactNode; onClose: () => void; testId?: string; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-6" onClick={onClose}>
      <Card className={cx('w-full p-6', wide ? 'max-w-3xl' : 'max-w-lg')} onClick={(e) => e.stopPropagation()} data-testid={testId}>
        {children}
      </Card>
    </div>
  );
}

/**
 * 重抽的对话框（20.4）：可以附一句说明。run 给了就在这里等它写完（显示字数、能停）；
 * 没给就是交给后台（创世步骤），点了就关。
 */
export function RerollDialog({
  title,
  detail,
  extra,
  onClose,
  run,
  onConfirm,
  testId = 'reroll-dialog',
}: {
  title: string;
  detail: ReactNode;
  extra?: ReactNode;
  onClose: () => void;
  run?: (note: string, onChars: (n: number) => void, signal: AbortSignal) => Promise<void>;
  onConfirm?: (note: string) => void;
  testId?: string;
}) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [chars, setChars] = useState<number | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  const go = async () => {
    if (!run) {
      onConfirm?.(note.trim());
      onClose();
      return;
    }
    ctrl.current = new AbortController();
    setChars(0);
    try {
      await run(note.trim(), setChars, ctrl.current.signal);
      onClose();
    } catch (err) {
      if (!isAborted(err)) toast('err', errorMessage(err));
      setChars(null);
    }
  };
  return (
    <Modal onClose={() => chars === null && onClose()} testId={testId}>
      <div className="mb-2 text-base font-semibold">{title}</div>
      <p className="text-sm leading-relaxed text-muted">{detail}</p>
      <Field label="这次的要求（可以不写）" className="mt-4">
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="比如：反派再狠一点、更像个老水手" data-testid="reroll-note" autoFocus />
      </Field>
      {extra}
      <div className="mt-5 flex items-center justify-end gap-2">
        {chars !== null && (
          <span className="mr-auto flex items-center gap-2 text-xs text-faint">
            <Spinner className="size-3" />
            正在重写…… {chars} 字
          </span>
        )}
        <Button variant="ghost" onClick={() => (chars !== null ? ctrl.current?.abort() : onClose())}>
          {chars !== null ? '停止' : '取消'}
        </Button>
        <Button variant="primary" loading={chars !== null} onClick={() => void go()} data-testid="reroll-confirm">
          重抽
        </Button>
      </div>
    </Modal>
  );
}

// ───────────── 改名（20.4"改名"） ─────────────

/**
 * 改名时正文里还写着旧名字的地方：勾上的换成新名字。按设置"问我"时，保存前弹出来。
 * 返回要换的组（'all' 全换，[] 不换），关掉对话框是 null（不保存，接着改）。
 */
function RenameDialog({ from, to, hits, onDone }: { from: string; to: string; hits: RenameHit[]; onDone: (groups: string[] | 'all' | null) => void }) {
  const [picked, setPicked] = useState(() => new Set(hits.map((h) => h.group)));
  const total = hits.reduce((n, h) => n + h.count, 0);
  return (
    <Modal onClose={() => onDone(null)} testId="rename-dialog" wide>
      <div className="mb-2 text-base font-semibold">
        「{from}」改成「{to}」：正文里还有 {total} 处旧名字
      </div>
      <p className="text-sm text-muted">勾上的换成新名字。不换也不会断（引用用的是 id），只是文字里还是旧名字，下游会标成过期。</p>
      <ul className="mt-4 max-h-[50vh] space-y-1.5 overflow-y-auto">
        {hits.map((h) => (
          <li key={h.group}>
            <label className="flex items-start gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-panel-2" data-testid="rename-hit" data-group={h.group}>
              <input
                type="checkbox"
                className="mt-1"
                checked={picked.has(h.group)}
                onChange={(e) => {
                  const next = new Set(picked);
                  if (e.target.checked) next.add(h.group);
                  else next.delete(h.group);
                  setPicked(next);
                }}
              />
              <span className="min-w-0">
                <span className="text-fg">{h.label}</span>
                <span className="ml-1.5 text-xs text-faint">{h.count} 处</span>
                <span className="block truncate text-xs text-muted">{h.preview}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={() => onDone([])} data-testid="rename-none">
          不替换
        </Button>
        {picked.size < hits.length && (
          <Button onClick={() => onDone([...picked])} data-testid="rename-selected" disabled={!picked.size}>
            只换勾上的
          </Button>
        )}
        <Button variant="primary" onClick={() => onDone('all')} data-testid="rename-all">
          全部替换
        </Button>
      </div>
    </Modal>
  );
}

/** 保存角色、地点时处理改名：按设置问不问、换哪些。返回 null 表示不保存（关掉了对话框）。 */
function useRename(kind: 'character' | 'location', id: string, oldName: string) {
  const { world } = useEdit();
  const { settings } = useSettings();
  const [ask, setAsk] = useState<{ to: string; hits: RenameHit[]; resolve: (g: string[] | 'all' | null) => void } | null>(null);
  const resolveGroups = async (to: string, draft: unknown): Promise<{ groups: string[] | 'all' } | undefined | null> => {
    const mode = settings?.editor.rename ?? 'ask';
    if (!oldName || to.trim() === oldName || mode !== 'ask') return undefined;
    const hits = await engine.call('renameHits', { worldId: world.manifest.id, kind, id, to: to.trim(), draft });
    if (!hits.length) return undefined;
    const groups = await new Promise<string[] | 'all' | null>((resolve) => setAsk({ to: to.trim(), hits, resolve }));
    setAsk(null);
    return groups === null ? null : { groups };
  };
  const dialog = ask && <RenameDialog from={oldName} to={ask.to} hits={ask.hits} onDone={ask.resolve} />;
  return { resolveGroups, dialog };
}

/** 保存被取消了（改名对话框关掉了）：表单留着接着改。 */
class Cancelled extends Error {
  constructor() {
    super('没有保存');
  }
}

// ───────────── 最近删掉的 ─────────────

const KIND_TEXT: Record<EntityKind, string> = { character: '角色', location: '地点', lore: '设定' };

/** 删掉的（或者重抽时被换掉的）角色、地点、设定，从历史里找回来。 */
function DeletedButton({ kind }: { kind: EntityKind }) {
  const { world, onSaved } = useEdit();
  const toast = useToast();
  const [items, setItems] = useState<DeletedEntity[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const open = async () => {
    try {
      setItems((await engine.call('deletedEntities', { worldId: world.manifest.id })).filter((x) => x.kind === kind));
    } catch (err) {
      toast('err', errorMessage(err));
    }
  };
  const restore = async (x: DeletedEntity) => {
    setBusy(x.id);
    try {
      const r = await engine.call('restoreDeleted', { worldId: world.manifest.id, kind, id: x.id, name: x.name });
      onSaved(r.world);
      toast('ok', `找回了「${x.title}」`);
      setItems((all) => all?.filter((y) => y.id !== x.id) ?? null);
    } catch (err) {
      toast('err', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => void open()} data-testid="deleted-list">
        最近删掉的
      </Button>
      {items && (
        <Modal onClose={() => setItems(null)} testId="deleted-dialog">
          <div className="mb-2 text-base font-semibold">最近删掉的{KIND_TEXT[kind]}</div>
          <p className="text-sm text-muted">删掉的和重抽时被换掉的都在这里。找回来以后，删的时候一起去掉的引用不会回来。</p>
          <ul className="mt-4 max-h-[50vh] space-y-1.5 overflow-y-auto">
            {items.length === 0 && <li className="text-sm text-faint">没有。</li>}
            {items.map((x) => (
              <li key={x.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-panel-2" data-testid="deleted-item" data-id={x.id}>
                <span className="min-w-0 flex-1 truncate">{x.title}</span>
                <span className="text-xs text-faint">{formatTime(Date.parse(x.at))}</span>
                <Button size="sm" disabled={!x.restorable || !world.editable} loading={busy === x.id} onClick={() => void restore(x)} data-testid={`restore-${x.id}`}>
                  找回
                </Button>
              </li>
            ))}
          </ul>
          <div className="mt-5 flex justify-end">
            <Button variant="ghost" onClick={() => setItems(null)}>
              关闭
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}

// ───────────── 删除（20.5"删除"） ─────────────

function DeleteButton({ kind, id, name, onDeleted }: { kind: EntityKind; id: string; name: string; onDeleted?: () => void }) {
  const { world, onSaved } = useEdit();
  const toast = useToast();
  const [refs, setRefs] = useState<WorldRef[] | null>(null);
  const [busy, setBusy] = useState(false);
  const ask = async () => {
    try {
      setRefs(await engine.call('worldReferences', { worldId: world.manifest.id, kind, id }));
    } catch (err) {
      toast('err', errorMessage(err));
    }
  };
  const run = async (removeRefs: boolean) => {
    setBusy(true);
    try {
      onSaved(await engine.call('deleteWorldPart', { worldId: world.manifest.id, kind, id, removeRefs }));
      toast('ok', `已删除「${name}」`);
      setRefs(null);
      onDeleted?.();
    } catch (err) {
      toast('err', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const removable = refs?.filter((r) => r.removable) ?? [];
  const manual = refs?.filter((r) => !r.removable) ?? [];
  return (
    <>
      <Button size="sm" variant="danger" onClick={() => void ask()} data-testid="delete-entity">
        删除
      </Button>
      {refs && (
        <Modal onClose={() => setRefs(null)} testId="delete-dialog">
          <div className="mb-3 text-base font-semibold">删除「{name}」？</div>
          {refs.length === 0 ? (
            <p className="text-sm text-muted">别处没有用到它。删掉的内容留在历史版本里。</p>
          ) : (
            <div className="space-y-2 text-sm">
              <p className="text-muted">这些地方用到了它：</p>
              <ul className="space-y-1 text-xs">
                {refs.map((r) => (
                  <li key={`${r.key}${r.field}`} className={r.removable ? 'text-muted' : 'text-warn'}>
                    · {r.label}
                  </li>
                ))}
              </ul>
              {manual.length > 0 && <p className="text-xs text-faint">手写剧本里的要自己改，不会自动去掉。</p>}
            </div>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRefs(null)}>
              取消
            </Button>
            {removable.length > 0 && (
              <Button loading={busy} onClick={() => void run(false)} data-testid="delete-keep-refs">
                只删它
              </Button>
            )}
            <Button variant="danger" loading={busy} onClick={() => void run(removable.length > 0)} data-testid="delete-confirm">
              {removable.length > 0 ? '连这些引用一起删' : '删除'}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}

// ───────────── 概览：世界名、简报、风格 ─────────────

const RATING = { all: '全年龄', teen: '青少年', mature: '成人' } as const;
const LENGTH = { short: '短篇', medium: '中篇', long: '长篇', endless: '不设上限' } as const;
const MODE = { chat: '自由对话', adv: '剧情 ADV', observer: '观察模式' } as const;
const POV = { first: '第一人称', second: '第二人称', third: '第三人称' } as const;

function Info({ label, value, className }: { label: string; value: string; className?: string }) {
  if (!value) return null;
  return (
    <div className={className}>
      <div className="text-xs text-faint">{label}</div>
      <div className="mt-0.5 leading-relaxed">{value}</div>
    </div>
  );
}

export function OverviewTab() {
  const { world, onSaved } = useEdit();
  const wid = world.manifest.id;
  const m = world.manifest;
  const b = world.brief ?? WorldBrief.parse({ genre: '', tone: '' });
  const st = world.style ?? StyleGuide.parse({});
  return (
    <div className="space-y-4">
      <EditPanel
        id="manifest"
        title="世界名和简介"
        value={{ title: m.title, logline: m.logline }}
        locked={m.locked.filter((x) => x === 'title' || x === 'logline')}
        partKey="manifest"
        wholeLock={['title', 'logline']}
        view={
          <Card className="p-5 text-sm">
            <div className="text-base font-semibold">{m.title}</div>
            <p className="mt-1 text-muted">{m.logline || '（没有一句话简介）'}</p>
          </Card>
        }
        form={(d, set, lock) => (
          <>
            <LField label="世界名" path="title" lock={lock}>
              <Input value={d.title} onChange={(e) => set({ ...d, title: e.target.value })} data-testid="field-title" />
            </LField>
            <LField label="一句话简介" path="logline" lock={lock} ai>
              <Input value={d.logline} onChange={(e) => set({ ...d, logline: e.target.value })} data-testid="field-logline" />
            </LField>
          </>
        )}
        save={async (d, locks) => {
          const other = m.locked.filter((x) => x !== 'title' && x !== 'logline');
          await savePart(
            { worldId: wid, part: 'manifest', base: world.revs.manifest, data: { ...d, locked: [...other, ...locks.locked] }, unlocked: locks.unlocked },
            onSaved,
          );
        }}
      />
      <EditPanel
        id="brief"
        title="世界简报"
        value={b}
        locked={b._meta.locked}
        historyKey={world.brief ? 'brief' : undefined}
        wholeLock={world.brief ? ['*'] : undefined}
        view={
          <Card className="grid grid-cols-2 gap-x-6 gap-y-3 p-5 text-sm">
            {!world.brief && <p className="col-span-2 text-faint">还没有世界简报。</p>}
            <Info label="题材" value={b.genre} />
            <Info label="基调" value={b.tone} />
            <Info label="时代" value={b.era} />
            <Info label="主题" value={b.themes.join('、')} />
            {world.brief && <Info label="分级 · 篇幅" value={`${RATING[b.rating]} · ${LENGTH[b.length]}`} />}
          </Card>
        }
        form={(d, set, lock) => (
          <div className="grid grid-cols-2 gap-4">
            <LField label="题材" path="genre" lock={lock}>
              <Input value={d.genre} onChange={(e) => set({ ...d, genre: e.target.value })} data-testid="field-genre" />
            </LField>
            <LField label="基调" path="tone" lock={lock}>
              <Input value={d.tone} onChange={(e) => set({ ...d, tone: e.target.value })} data-testid="field-tone" />
            </LField>
            <LField label="时代" path="era" lock={lock}>
              <Input value={d.era} onChange={(e) => set({ ...d, era: e.target.value })} />
            </LField>
            <LField label="主题" path="themes" lock={lock}>
              <ListInput value={d.themes} onChange={(v) => set({ ...d, themes: v })} />
            </LField>
            <LField label="一句话梗概" path="logline" lock={lock} className="col-span-2">
              <Input value={d.logline} onChange={(e) => set({ ...d, logline: e.target.value })} />
            </LField>
            <LField label="内容分级" path="rating" lock={lock}>
              <Select value={d.rating} onChange={(e) => set({ ...d, rating: e.target.value as WorldBrief['rating'] })}>
                {Object.entries(RATING).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </LField>
            <LField label="篇幅" path="length" lock={lock}>
              <Select value={d.length} onChange={(e) => set({ ...d, length: e.target.value as WorldBrief['length'] })}>
                {Object.entries(LENGTH).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </LField>
            <LField label="默认游玩模式" path="defaultMode" lock={lock}>
              <Select value={d.defaultMode} onChange={(e) => set({ ...d, defaultMode: e.target.value as WorldBrief['defaultMode'] })}>
                {Object.entries(MODE).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </LField>
          </div>
        )}
        save={async (d, locks) => {
          await savePart(
            { worldId: wid, part: 'brief', base: world.revs.brief, data: { ...d, _meta: { ...d._meta, locked: locks.locked } }, unlocked: locks.unlocked },
            onSaved,
          );
        }}
      />
      <EditPanel
        id="style"
        title="风格"
        value={st}
        locked={st._meta.locked}
        historyKey={world.style ? 'style' : undefined}
        partKey="style"
        wholeLock={world.style ? ['*'] : undefined}
        view={
          <Card className="grid grid-cols-2 gap-x-6 gap-y-3 p-5 text-sm">
            {!world.style && <p className="col-span-2 text-faint">还没有风格指南。</p>}
            <Info label="文风" value={st.prose.description} className="col-span-2" />
            <Info label="画风" value={st.art.prompt} className="col-span-2" />
            <Info label="音乐" value={st.music.description} className="col-span-2" />
          </Card>
        }
        form={(d, set, lock) => (
          <div className="grid grid-cols-2 gap-4">
            <LField label="叙述人称" path="prose.pov" lock={lock}>
              <Select value={d.prose.pov} onChange={(e) => set({ ...d, prose: { ...d.prose, pov: e.target.value as StyleGuide['prose']['pov'] } })}>
                {Object.entries(POV).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </LField>
            <div />
            <LField label="文风" path="prose.description" lock={lock} className="col-span-2" ai>
              <Textarea rows={2} value={d.prose.description} onChange={(e) => set({ ...d, prose: { ...d.prose, description: e.target.value } })} />
            </LField>
            <LField label="文风例句" path="prose.samples" lock={lock} className="col-span-2">
              <LinesInput value={d.prose.samples} onChange={(v) => set({ ...d, prose: { ...d.prose, samples: v } })} />
            </LField>
            <LField label="画风提示词" path="art.prompt" lock={lock} className="col-span-2" ai hint="所有图片的提示词都带上它；改了以后素材页里的图会标成过期，点了才重画">
              <Textarea rows={2} value={d.art.prompt} onChange={(e) => set({ ...d, art: { ...d.art, prompt: e.target.value } })} data-testid="field-art-prompt" />
            </LField>
            <LField label="反向提示词" path="art.negative" lock={lock} className="col-span-2">
              <Input value={d.art.negative} onChange={(e) => set({ ...d, art: { ...d.art, negative: e.target.value } })} />
            </LField>
            <LField label="音乐风格" path="music.description" lock={lock} className="col-span-2" ai>
              <Input value={d.music.description} onChange={(e) => set({ ...d, music: { description: e.target.value } })} />
            </LField>
          </div>
        )}
        save={async (d, locks) => {
          await savePart(
            { worldId: wid, part: 'style', base: world.revs.style, data: { ...d, _meta: { ...d._meta, locked: locks.locked } }, unlocked: locks.unlocked },
            onSaved,
          );
        }}
      />
      {world.manifest.models.length > 0 && <p className="text-xs text-faint">生成所用模型：{world.manifest.models.join('、')}</p>}
    </div>
  );
}

// ───────────── 世界观 ─────────────

export function WorldviewTab() {
  const { world, onSaved } = useEdit();
  const locked = world.manifest.locked.includes('worldview');
  return (
    <EditPanel
      id="worldview"
      title="世界观"
      value={world.worldview}
      locked={locked ? ['worldview'] : []}
      historyKey={world.worldview ? 'worldview' : undefined}
      wholeLock={world.worldview ? ['worldview'] : undefined}
      view={<Card className="p-5">{world.worldview ? <Markdown text={world.worldview} /> : <Empty title="世界观还没有写" />}</Card>}
      form={(d, set, lock) => (
        <LField label="正文（Markdown）" path="worldview" lock={lock}>
          <div className="grid grid-cols-2 gap-4">
            <Textarea rows={22} value={d} onChange={(e) => set(e.target.value)} className="font-mono text-xs" data-testid="field-worldview" />
            <div className="max-h-[34rem] overflow-y-auto rounded-lg border border-line p-4">
              <Markdown text={d} />
            </div>
          </div>
        </LField>
      )}
      save={async (d, locks) => {
        const want = locks.locked.includes('worldview');
        await savePart(
          {
            worldId: world.manifest.id,
            part: 'worldview',
            base: world.revs.worldview,
            data: d,
            unlocked: locks.unlocked,
            ...(want !== locked ? { lock: want } : {}),
          },
          onSaved,
        );
      }}
    />
  );
}

// ───────────── 角色 ─────────────

export const ROLE_NAMES: Record<string, string> = {
  protagonist: '主角（你）',
  heroine: '女主角',
  hero: '男主角',
  rival: '对手',
  antagonist: '反派',
  mentor: '导师',
  npc: '配角',
};

const newCharacter = (): Character => ({ ...Character.parse({ id: 'new', name: '-' }), name: '' });

export function CharactersTab() {
  const { world } = useEdit();
  const [adding, setAdding] = useState(0);
  return (
    <div className="grid gap-3">
      {world.editable && (
        <div className="flex justify-end gap-1">
          <DeletedButton kind="character" />
          <Button size="sm" onClick={() => setAdding(adding + 1)} disabled={adding > 0} data-testid="add-character">
            添加角色
          </Button>
        </div>
      )}
      {adding > 0 && <CharacterPanel key={`new${adding}`} c={newCharacter()} isNew onDiscard={() => setAdding(0)} />}
      {world.characters.length === 0 && adding === 0 && <Empty title="还没有角色" />}
      {world.characters.map((c) => (
        <CharacterPanel key={c.id} c={c} />
      ))}
    </div>
  );
}

function CharacterPanel({ c, isNew, onDiscard }: { c: Character; isNew?: boolean; onDiscard?: () => void }) {
  const { world, onSaved } = useEdit();
  const toast = useToast();
  const others = world.characters.filter((x) => x.id !== c.id);
  const key = `character:${c.id}` as const;
  const rn = useRename('character', c.id, isNew ? '' : c.name);
  return (
    <>
    {rn.dialog}
    <EditPanel
      id={isNew ? 'character-new' : key}
      title={isNew ? '新角色' : c.name}
      value={c}
      locked={c._meta.locked}
      historyKey={isNew ? undefined : key}
      partKey={isNew ? 'character:' : key}
      wholeLock={isNew ? undefined : ['*']}
      reroll={isNew ? undefined : { kind: 'character', id: c.id, name: c.name }}
      isNew={isNew}
      onDiscard={onDiscard}
      actions={!isNew && <DeleteButton kind="character" id={c.id} name={c.name} />}
      view={<CharacterCard c={c} all={world.characters} />}
      form={(d, set, lock) => (
        <div className="grid grid-cols-2 gap-4">
          <LField label="名字" path="name" lock={lock}>
            <Input value={d.name} onChange={(e) => set({ ...d, name: e.target.value })} data-testid="field-name" />
          </LField>
          <LField label="别称" path="aliases" lock={lock}>
            <ListInput value={d.aliases} onChange={(v) => set({ ...d, aliases: v })} />
          </LField>
          <LField label="定位" path="role" lock={lock}>
            <Select value={d.role} onChange={(e) => set({ ...d, role: e.target.value as Character['role'] })} data-testid="field-role">
              {Object.entries(ROLE_NAMES).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </LField>
          <div className="grid grid-cols-2 gap-4">
            <LField label="性别" path="gender" lock={lock}>
              <Input value={d.gender} onChange={(e) => set({ ...d, gender: e.target.value })} />
            </LField>
            <LField label="年龄" path="age" lock={lock}>
              <Input value={d.age} onChange={(e) => set({ ...d, age: e.target.value })} />
            </LField>
          </div>
          <LField label="一句话简介" path="summary" lock={lock} className="col-span-2" ai>
            <Input value={d.summary} onChange={(e) => set({ ...d, summary: e.target.value })} data-testid="field-summary" />
          </LField>
          <LField label="外貌" path="appearance.text" lock={lock} className="col-span-2" ai>
            <Textarea rows={2} value={d.appearance.text} onChange={(e) => set({ ...d, appearance: { ...d.appearance, text: e.target.value } })} data-testid="field-appearance" />
          </LField>
          <LField label="画图用的外貌提示词" path="appearance.imagePrompt" lock={lock} className="col-span-2" ai hint="改了以后这个角色的立绘会标成过期，在素材页点了才重画">
            <Input value={d.appearance.imagePrompt} onChange={(e) => set({ ...d, appearance: { ...d.appearance, imagePrompt: e.target.value } })} />
          </LField>
          <LField label="性格特点" path="personality.traits" lock={lock}>
            <ListInput value={d.personality.traits} onChange={(v) => set({ ...d, personality: { ...d.personality, traits: v } })} />
          </LField>
          <LField label="价值观" path="personality.values" lock={lock}>
            <ListInput value={d.personality.values} onChange={(v) => set({ ...d, personality: { ...d.personality, values: v } })} />
          </LField>
          <LField label="害怕的" path="personality.fears" lock={lock}>
            <ListInput value={d.personality.fears} onChange={(v) => set({ ...d, personality: { ...d.personality, fears: v } })} />
          </LField>
          <LField label="说话方式" path="speech.style" lock={lock} ai>
            <Input value={d.speech.style} onChange={(e) => set({ ...d, speech: { ...d.speech, style: e.target.value } })} />
          </LField>
          <LField label="台词例句" path="speech.examples" lock={lock} className="col-span-2">
            <LinesInput value={d.speech.examples} onChange={(v) => set({ ...d, speech: { ...d.speech, examples: v } })} />
          </LField>
          <LField label="经历" path="background" lock={lock} className="col-span-2" ai>
            <Textarea rows={3} value={d.background} onChange={(e) => set({ ...d, background: e.target.value })} data-testid="field-background" />
          </LField>
          <LField label="目标" path="goals" lock={lock} className="col-span-2">
            <Rows
              items={d.goals}
              onChange={(goals) => set({ ...d, goals })}
              blank={{ text: '', priority: 1, public: true }}
              render={(g, up) => (
                <>
                  <Input value={g.text} onChange={(e) => up({ ...g, text: e.target.value })} placeholder="想做到什么" />
                  <label className="flex shrink-0 items-center gap-1 text-xs text-muted">
                    <input type="checkbox" checked={!g.public} onChange={(e) => up({ ...g, public: !e.target.checked })} />
                    不公开
                  </label>
                </>
              )}
            />
          </LField>
          <LField label="秘密" path="secrets" lock={lock} className="col-span-2" hint="知情人之外的角色不会知道（信息不对称）">
            <Rows
              items={d.secrets}
              onChange={(secrets) => set({ ...d, secrets })}
              blank={{ id: `secret_${d.secrets.length + 1}`, text: '', knownBy: isNew ? [] : [c.id] }}
              render={(s, up) => (
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <Input value={s.text} onChange={(e) => up({ ...s, text: e.target.value })} placeholder="秘密" />
                  <KnownByPicker value={s.knownBy} onChange={(knownBy) => up({ ...s, knownBy })} owner={c.id} />
                </div>
              )}
            />
          </LField>
          <LField label="关系" path="relationships" lock={lock} className="col-span-2">
            <Rows
              items={d.relationships}
              onChange={(relationships) => set({ ...d, relationships })}
              blank={{ to: others[0]?.id ?? '', type: '', affinity: 0 }}
              render={(r, up) => (
                <>
                  <Select value={r.to} onChange={(e) => up({ ...r, to: e.target.value })} className="w-36">
                    {!others.some((o) => o.id === r.to) && <option value={r.to}>{r.to || '（选一个角色）'}</option>}
                    {others.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </Select>
                  <Input value={r.type} onChange={(e) => up({ ...r, type: e.target.value })} placeholder="什么关系" />
                  <Input
                    type="number"
                    min={-100}
                    max={100}
                    className="w-20"
                    title="好感（-100～100）"
                    value={r.affinity}
                    onChange={(e) => up({ ...r, affinity: Math.max(-100, Math.min(100, Number(e.target.value) || 0)) })}
                  />
                </>
              )}
            />
          </LField>
          <LField label="表情" path="expressions" lock={lock} hint="表情 id，用顿号分开；画哪些表情由素材设置决定">
            <ListInput value={d.expressions} onChange={(v) => set({ ...d, expressions: v })} />
          </LField>
        </div>
      )}
      save={async (d, locks) => {
        const { id: _id, ...rest } = d;
        const rename = isNew ? undefined : await rn.resolveGroups(d.name, rest);
        if (rename === null) throw new Cancelled();
        const r = await savePart(
          {
            worldId: world.manifest.id,
            part: 'character',
            base: isNew ? null : world.revs[key],
            data: { ...(isNew ? rest : d), _meta: { ...d._meta, locked: locks.locked } },
            unlocked: locks.unlocked,
            ...(rename ? { rename } : {}),
          },
          onSaved,
        );
        if (r.renamed) toast('ok', `正文里的旧名字换了 ${r.renamed} 处`);
      }}
    />
    </>
  );
}

/** 可以加减的一组行。 */
function Rows<T>({ items, onChange, blank, render }: { items: T[]; onChange: (v: T[]) => void; blank: T; render: (item: T, update: (v: T) => void) => ReactNode }) {
  return (
    <div className="space-y-2">
      {items.map((it, i) => (
        <div key={i} className="flex items-start gap-2">
          {render(it, (v) => onChange(items.map((x, j) => (j === i ? v : x))))}
          <Button size="sm" variant="ghost" className="mt-1 shrink-0" onClick={() => onChange(items.filter((_, j) => j !== i))} title="去掉这一行">
            ✕
          </Button>
        </div>
      ))}
      <Button size="sm" variant="ghost" onClick={() => onChange([...items, structuredClone(blank)])} data-testid="add-row">
        ＋ 加一条
      </Button>
    </div>
  );
}

/** 谁知道：公开，或者勾选几个角色。owner 是秘密的主人，自己总是知道，不列出来。 */
function KnownByPicker({ value, onChange, owner }: { value: 'public' | string[]; onChange: (v: 'public' | string[]) => void; owner?: string }) {
  const { world } = useEdit();
  const chars = world.characters.filter((c) => c.id !== owner);
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <button
        type="button"
        onClick={() => onChange(value === 'public' ? (owner ? [owner] : []) : 'public')}
        className={cx('rounded-md px-2 py-0.5', value === 'public' ? 'bg-accent-soft text-accent-strong' : 'bg-panel-2 text-muted')}
      >
        公开
      </button>
      {value !== 'public' &&
        chars.map((c) => {
          const on = value.includes(c.id);
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => onChange(on ? value.filter((x) => x !== c.id) : [...value, c.id])}
              className={cx('rounded-md px-2 py-0.5', on ? 'bg-accent-soft text-accent-strong' : 'bg-panel-2 text-faint')}
            >
              {c.name || c.id}
            </button>
          );
        })}
    </div>
  );
}

/** 从一组里多选（地点连着的地点、开场的在场角色）。 */
function Chips({ options, value, onChange, testId }: { options: { id: string; name: string }[]; value: string[]; onChange: (v: string[]) => void; testId?: string }) {
  return (
    <div className="flex flex-wrap gap-1.5 text-xs" data-testid={testId}>
      {options.length === 0 && <span className="text-faint">（没有可选的）</span>}
      {options.map((o) => {
        const on = value.includes(o.id);
        return (
          <button
            key={o.id}
            type="button"
            data-id={o.id}
            onClick={() => onChange(on ? value.filter((x) => x !== o.id) : [...value, o.id])}
            className={cx('rounded-md px-2 py-0.5', on ? 'bg-accent-soft text-accent-strong' : 'bg-panel-2 text-faint hover:text-muted')}
          >
            {o.name}
          </button>
        );
      })}
    </div>
  );
}

export function CharacterCard({ c, all }: { c: Character; all: Character[] }) {
  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 pr-28">
        <span className="text-base font-semibold">{c.name}</span>
        <Badge tone={c.role === 'protagonist' ? 'accent' : 'neutral'}>{ROLE_NAMES[c.role] ?? c.role}</Badge>
        <span className="text-xs text-faint">{[c.gender, c.age].filter(Boolean).join(' · ')}</span>
        {c._meta.locked.length > 0 && (
          <span className="text-faint" title={`锁着的：${c._meta.locked.join('、')}`}>
            <LockIcon />
          </span>
        )}
      </div>
      {c.summary && <p className="mt-1.5 text-sm text-muted">{c.summary}</p>}
      <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2.5 text-sm">
        <Info label="外貌" value={c.appearance.text} />
        <Info label="性格" value={c.personality.traits.join('、')} />
        <Info label="说话方式" value={c.speech.style} />
        <Info label="目标" value={c.goals.map((g) => g.text).join('；')} />
        <Info label="经历" value={c.background} className="col-span-2" />
        {c.speech.examples.length > 0 && <Info label="台词" value={c.speech.examples.map((e) => `「${e}」`).join(' ')} className="col-span-2" />}
        {c.relationships.length > 0 && (
          <Info
            label="关系"
            value={c.relationships.map((r) => `${all.find((x) => x.id === r.to)?.name ?? r.to}：${r.type}`).join('；')}
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

// ───────────── 地点 ─────────────

const newLocation = (): Location => ({ ...Location.parse({ id: 'new', name: '-' }), name: '' });

export function LocationsTab() {
  const { world } = useEdit();
  const [adding, setAdding] = useState(0);
  return (
    <div className="space-y-3">
      {world.editable && (
        <div className="flex justify-end gap-1">
          <DeletedButton kind="location" />
          <Button size="sm" onClick={() => setAdding(adding + 1)} disabled={adding > 0} data-testid="add-location">
            添加地点
          </Button>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        {adding > 0 && <LocationPanel key={`new${adding}`} l={newLocation()} isNew onDiscard={() => setAdding(0)} />}
        {world.locations.length === 0 && adding === 0 && <Empty title="还没有地点" />}
        {world.locations.map((l) => (
          <LocationPanel key={l.id} l={l} />
        ))}
      </div>
    </div>
  );
}

function LocationPanel({ l, isNew, onDiscard }: { l: Location; isNew?: boolean; onDiscard?: () => void }) {
  const { world, onSaved } = useEdit();
  const toast = useToast();
  const key = `location:${l.id}` as const;
  const rn = useRename('location', l.id, isNew ? '' : l.name);
  return (
    <>
    {rn.dialog}
    <EditPanel
      id={isNew ? 'location-new' : key}
      title={isNew ? '新地点' : l.name}
      value={l}
      locked={l._meta.locked}
      historyKey={isNew ? undefined : key}
      partKey={isNew ? 'location:' : key}
      wholeLock={isNew ? undefined : ['*']}
      reroll={isNew ? undefined : { kind: 'location', id: l.id, name: l.name }}
      isNew={isNew}
      onDiscard={onDiscard}
      editClassName="col-span-2"
      actions={!isNew && <DeleteButton kind="location" id={l.id} name={l.name} />}
      view={
        <Card className="overflow-hidden">
          <div className="relative aspect-video w-full overflow-hidden bg-black" style={{ containerType: 'inline-size' }}>
            <BgImage id={l.id} />
          </div>
          <div className="p-4">
            <div className="font-medium">{l.name}</div>
            <p className="mt-1.5 text-sm leading-relaxed text-muted">{l.description}</p>
            {l.connections.length > 0 && (
              <div className="mt-2 text-xs text-faint">通往：{l.connections.map((id) => world.locations.find((x) => x.id === id)?.name ?? id).join('、')}</div>
            )}
          </div>
        </Card>
      }
      form={(d, set, lock) => (
        <>
          <LField label="名字" path="name" lock={lock}>
            <Input value={d.name} onChange={(e) => set({ ...d, name: e.target.value })} data-testid="field-name" />
          </LField>
          <LField label="描述" path="description" lock={lock} ai hint="背景图按它画；改了以后背景会标成过期，在素材页点了才重画">
            <Textarea rows={4} value={d.description} onChange={(e) => set({ ...d, description: e.target.value })} data-testid="field-description" />
          </LField>
          <LField label="连着哪些地点" path="connections" lock={lock}>
            <Chips
              options={world.locations.filter((x) => x.id !== l.id)}
              value={d.connections}
              onChange={(connections) => set({ ...d, connections })}
            />
          </LField>
        </>
      )}
      save={async (d, locks) => {
        const { id: _id, ...rest } = d;
        const rename = isNew ? undefined : await rn.resolveGroups(d.name, rest);
        if (rename === null) throw new Cancelled();
        const r = await savePart(
          {
            worldId: world.manifest.id,
            part: 'location',
            base: isNew ? null : world.revs[key],
            data: { ...(isNew ? rest : d), _meta: { ...d._meta, locked: locks.locked } },
            unlocked: locks.unlocked,
            ...(rename ? { rename } : {}),
          },
          onSaved,
        );
        if (r.renamed) toast('ok', `正文里的旧名字换了 ${r.renamed} 处`);
      }}
    />
    </>
  );
}

// ───────────── 设定集 ─────────────

const ACTIVATION = { always: '总是', keyword: '关键词', semantic: '语义' } as const;
const newLore = (): LoreEntry => ({ ...LoreEntry.parse({ id: 'new', title: '-', content: '' }), title: '' });

export function LoreTab() {
  const { world } = useEdit();
  const [adding, setAdding] = useState(0);
  return (
    <div className="grid gap-2">
      {world.editable && (
        <div className="flex justify-end gap-1">
          <DeletedButton kind="lore" />
          <Button size="sm" onClick={() => setAdding(adding + 1)} disabled={adding > 0} data-testid="add-lore">
            添加设定
          </Button>
        </div>
      )}
      {adding > 0 && <LorePanel key={`new${adding}`} e={newLore()} isNew onDiscard={() => setAdding(0)} />}
      {world.lore.length === 0 && adding === 0 && <Empty title="设定集是空的" />}
      {world.lore.map((e) => (
        <LorePanel key={e.id} e={e} />
      ))}
    </div>
  );
}

function scopeLabel(world: WorldDetail, scope: string): string {
  const m = /^(character|location):(.+)$/.exec(scope);
  if (!m) return '全局';
  const name = m[1] === 'character' ? world.characters.find((c) => c.id === m[2])?.name : world.locations.find((l) => l.id === m[2])?.name;
  return `只对${m[1] === 'character' ? '角色' : '地点'}「${name ?? m[2]}」`;
}

function LorePanel({ e, isNew, onDiscard }: { e: LoreEntry; isNew?: boolean; onDiscard?: () => void }) {
  const { world, onSaved } = useEdit();
  const key = `lore:${e.id}` as const;
  return (
    <EditPanel
      id={isNew ? 'lore-new' : key}
      title={isNew ? '新设定' : e.title}
      value={e}
      locked={e._meta.locked}
      historyKey={isNew ? undefined : key}
      partKey={isNew ? 'lore:' : key}
      wholeLock={isNew ? undefined : ['*']}
      reroll={isNew ? undefined : { kind: 'lore', id: e.id, name: e.title }}
      isNew={isNew}
      onDiscard={onDiscard}
      actions={!isNew && <DeleteButton kind="lore" id={e.id} name={e.title} />}
      view={
        <Card className="p-4">
          <div className="flex items-center gap-2 pr-28">
            <span className="font-medium">{e.title}</span>
            <Badge>{e.category}</Badge>
            {e.activation === 'always' && <Badge tone="accent">常驻</Badge>}
            {e.scope !== 'global' && <Badge>{scopeLabel(world, e.scope)}</Badge>}
          </div>
          <p className="mt-1.5 text-sm leading-relaxed text-muted">{e.content}</p>
          {e.activation === 'keyword' && <div className="mt-2 text-xs text-faint">触发词：{e.keys.join('、')}</div>}
        </Card>
      }
      form={(d, set, lock) => (
        <div className="grid grid-cols-2 gap-4">
          <LField label="标题" path="title" lock={lock}>
            <Input value={d.title} onChange={(ev) => set({ ...d, title: ev.target.value })} data-testid="field-title" />
          </LField>
          <LField label="分类" path="category" lock={lock}>
            <Input value={d.category} onChange={(ev) => set({ ...d, category: ev.target.value })} />
          </LField>
          <LField label="正文" path="content" lock={lock} className="col-span-2" ai>
            <Textarea rows={4} value={d.content} onChange={(ev) => set({ ...d, content: ev.target.value })} data-testid="field-content" />
          </LField>
          <LField label="触发方式" path="activation" lock={lock}>
            <Select value={d.activation} onChange={(ev) => set({ ...d, activation: ev.target.value as LoreEntry['activation'] })}>
              {Object.entries(ACTIVATION).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </LField>
          <LField label="关键词" path="keys" lock={lock} hint="对话里出现这些词时带上这条设定">
            <ListInput value={d.keys} onChange={(keys) => set({ ...d, keys })} testId="field-keys" />
          </LField>
          <LField label="范围" path="scope" lock={lock}>
            <Select value={d.scope} onChange={(ev) => set({ ...d, scope: ev.target.value })}>
              <option value="global">全局</option>
              {!/^(global|character:.+|location:.+)$/.test(d.scope) && <option value={d.scope}>{d.scope}</option>}
              {world.characters.map((c) => (
                <option key={c.id} value={`character:${c.id}`}>
                  角色：{c.name}
                </option>
              ))}
              {world.locations.map((l) => (
                <option key={l.id} value={`location:${l.id}`}>
                  地点：{l.name}
                </option>
              ))}
            </Select>
          </LField>
          <LField label="优先级" path="priority" lock={lock} hint="0～100，放不下时先带高的">
            <Input type="number" value={d.priority} onChange={(ev) => set({ ...d, priority: Math.round(Number(ev.target.value) || 0) })} />
          </LField>
          <LField label="谁知道" path="knownBy" lock={lock} className="col-span-2">
            <KnownByPicker value={d.knownBy} onChange={(knownBy) => set({ ...d, knownBy })} />
          </LField>
        </div>
      )}
      save={async (d, locks) => {
        const { id: _id, ...rest } = d;
        await savePart(
          {
            worldId: world.manifest.id,
            part: 'lore',
            base: isNew ? null : world.revs[key],
            data: { ...(isNew ? rest : d), _meta: { ...d._meta, locked: locks.locked } },
            unlocked: locks.unlocked,
          },
          onSaved,
        );
      }}
    />
  );
}

// ───────────── 数值 ─────────────

const VAR_TYPE = { number: '数值', boolean: '开关', string: '文字' } as const;
const VAR_CATEGORY = { relationship: '关系', attribute: '属性', other: '其他' } as const;

const VAR_GRID = 'grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_92px_minmax(0,0.8fr)_64px_64px_92px] items-center gap-1.5';

function initialOf(type: VariableDef['type'], raw: VariableDef['initial']): VariableDef['initial'] {
  if (type === 'number') return Number(raw) || 0;
  if (type === 'boolean') return raw === true || raw === 'true';
  return String(raw ?? '');
}

export function VariablesTab() {
  const { world, onSaved } = useEdit();
  const locked = world.manifest.locked.includes('variables');
  const used = useMemo(() => {
    // 剧情图里用到的变量（条件、效果、检定）：粗略地按 id 出现在剧情图里算
    const text = JSON.stringify(world.graph ?? {});
    return new Set(world.variables.filter((v) => text.includes(`"${v.id}"`)).map((v) => v.id));
  }, [world.graph, world.variables]);
  return (
    <EditPanel
      id="variables"
      title="数值"
      value={world.variables}
      locked={locked ? ['variables'] : []}
      historyKey={world.variables.length ? 'variables' : undefined}
      wholeLock={['variables']}
      view={
        <Card className="p-5">
          {world.variables.length === 0 ? (
            <Empty title="没有数值">好感度、线索、金钱这类数值和开关。剧情图的条件和检定会用到。</Empty>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-faint">
                <tr>
                  <th className="pb-2 font-normal">id</th>
                  <th className="pb-2 font-normal">名字</th>
                  <th className="pb-2 font-normal">类型</th>
                  <th className="pb-2 font-normal">初始值</th>
                  <th className="pb-2 font-normal">范围</th>
                  <th className="pb-2 font-normal">类别</th>
                </tr>
              </thead>
              <tbody>
                {world.variables.map((v) => (
                  <tr key={v.id} className="border-t border-line">
                    <td className="py-1.5 font-mono text-xs">
                      {v.id}
                      {used.has(v.id) && <span className="ml-1 text-faint" title="剧情图里用到了">·</span>}
                    </td>
                    <td className="py-1.5">{v.label}</td>
                    <td className="py-1.5 text-muted">{VAR_TYPE[v.type]}</td>
                    <td className="py-1.5 text-muted">{String(v.initial)}</td>
                    <td className="py-1.5 text-muted">{v.min !== undefined || v.max !== undefined ? `${v.min ?? ''}～${v.max ?? ''}` : ''}</td>
                    <td className="py-1.5 text-muted">{VAR_CATEGORY[v.category]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      }
      form={(d, set, lock) => (
        <LField label="数值表" path="variables" lock={lock} hint="删掉剧情图里用到的变量，剧情图检查会报错，要在剧情图里一起改">
          <div className={cx(VAR_GRID, 'pr-10 text-xs text-faint')}>
            <span>id</span>
            <span>名字</span>
            <span>类型</span>
            <span>初始值</span>
            <span>最小</span>
            <span>最大</span>
            <span>类别</span>
          </div>
          <Rows
            items={d}
            onChange={set}
            blank={{ id: `var_${d.length + 1}`, label: '', type: 'number', initial: 0, visible: true, category: 'other' }}
            render={(v, up) => (
              <div className={cx(VAR_GRID, 'flex-1')}>
                <Input className="font-mono text-xs" value={v.id} onChange={(e) => up({ ...v, id: e.target.value })} placeholder="id" title="小写字母开头，可以用点分组" />
                <Input value={v.label} onChange={(e) => up({ ...v, label: e.target.value })} placeholder="名字" />
                <Select value={v.type} onChange={(e) => { const type = e.target.value as VariableDef['type']; up({ ...v, type, initial: initialOf(type, v.initial), ...(type === 'number' ? {} : { min: undefined, max: undefined }) }); }}>
                  {Object.entries(VAR_TYPE).map(([k, t]) => (
                    <option key={k} value={k}>
                      {t}
                    </option>
                  ))}
                </Select>
                {v.type === 'boolean' ? (
                  <Select value={String(v.initial)} onChange={(e) => up({ ...v, initial: e.target.value === 'true' })}>
                    <option value="false">关</option>
                    <option value="true">开</option>
                  </Select>
                ) : (
                  <Input value={String(v.initial)} onChange={(e) => up({ ...v, initial: initialOf(v.type, e.target.value) })} placeholder="初始值" />
                )}
                <Input type="number" disabled={v.type !== 'number'} value={v.min ?? ''} onChange={(e) => up({ ...v, min: e.target.value === '' ? undefined : Number(e.target.value) })} placeholder="最小" />
                <Input type="number" disabled={v.type !== 'number'} value={v.max ?? ''} onChange={(e) => up({ ...v, max: e.target.value === '' ? undefined : Number(e.target.value) })} placeholder="最大" />
                <Select value={v.category} onChange={(e) => up({ ...v, category: e.target.value as VariableDef['category'] })}>
                  {Object.entries(VAR_CATEGORY).map(([k, t]) => (
                    <option key={k} value={k}>
                      {t}
                    </option>
                  ))}
                </Select>
              </div>
            )}
          />
        </LField>
      )}
      save={async (d, locks) => {
        const want = locks.locked.includes('variables');
        await savePart(
          {
            worldId: world.manifest.id,
            part: 'variables',
            base: world.revs.variables,
            data: d.map((v) => JSON.parse(JSON.stringify(v)) as VariableDef),
            unlocked: locks.unlocked,
            ...(want !== locked ? { lock: want } : {}),
          },
          onSaved,
        );
      }}
    />
  );
}

// ───────────── 开场 ─────────────

export function OpeningTab() {
  const { world, onSaved } = useEdit();
  const o = world.opening ?? StoryOpening.parse({ narration: '' });
  const nameOf = (id: string) => world.characters.find((c) => c.id === id)?.name ?? id;
  return (
    <EditPanel
      id="opening"
      title="开场"
      value={o}
      locked={o._meta.locked}
      historyKey={world.opening ? 'opening' : undefined}
      partKey="opening"
      wholeLock={world.opening ? ['*'] : undefined}
      view={
        <Card className="p-5">
          {!world.opening ? (
            <Empty title="还没有开场" />
          ) : (
            <div className="space-y-3 text-sm leading-relaxed">
              <div className="text-xs text-faint">
                地点：{world.locations.find((l) => l.id === o.locationId)?.name ?? '未指定'} · 在场：{o.presentCharacterIds.map(nameOf).join('、')}
              </div>
              <Markdown text={o.narration} className="text-fg" />
              {o.lines.map((l, i) => (
                <p key={`${l.characterId}${i}`}>
                  <span className="font-medium text-accent-strong">{nameOf(l.characterId)}</span>：{l.text}
                </p>
              ))}
            </div>
          )}
        </Card>
      }
      form={(d, set, lock) => (
        <>
          <div className="grid grid-cols-2 gap-4">
            <LField label="地点" path="locationId" lock={lock}>
              <Select
                value={d.locationId ?? ''}
                onChange={(e) => {
                  const { locationId: _x, ...rest } = d;
                  set(e.target.value ? { ...rest, locationId: e.target.value } : rest);
                }}
                data-testid="field-opening-location"
              >
                <option value="">（不指定）</option>
                {world.locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </LField>
            <LField label="在场角色" path="presentCharacterIds" lock={lock}>
              <Chips options={world.characters} value={d.presentCharacterIds} onChange={(presentCharacterIds) => set({ ...d, presentCharacterIds })} testId="field-opening-present" />
            </LField>
          </div>
          <LField label="旁白" path="narration" lock={lock} ai>
            <Textarea rows={5} value={d.narration} onChange={(e) => set({ ...d, narration: e.target.value })} data-testid="field-narration" />
          </LField>
          <LField label="开场台词" path="lines" lock={lock}>
            <Rows
              items={d.lines}
              onChange={(lines) => set({ ...d, lines })}
              blank={{ characterId: d.presentCharacterIds[0] ?? world.characters[0]?.id ?? '', text: '' }}
              render={(l, up) => (
                <>
                  <Select value={l.characterId} onChange={(e) => up({ ...l, characterId: e.target.value })} className="w-32">
                    {world.characters.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                  <Input value={l.text} onChange={(e) => up({ ...l, text: e.target.value })} placeholder="台词" />
                </>
              )}
            />
          </LField>
        </>
      )}
      save={async (d, locks) => {
        await savePart(
          {
            worldId: world.manifest.id,
            part: 'opening',
            base: world.opening ? world.revs.opening : null,
            data: { ...d, _meta: { ...d._meta, locked: locks.locked } },
            unlocked: locks.unlocked,
          },
          onSaved,
        );
      }}
    />
  );
}

// ───────────── 问题面板 ─────────────

/** 内容键对应的标签页。 */
export function tabOfKey(key: string): 'overview' | 'worldview' | 'characters' | 'locations' | 'lore' | 'variables' | 'opening' | 'plot' {
  if (key.startsWith('character:')) return 'characters';
  if (key.startsWith('location:')) return 'locations';
  if (key.startsWith('lore:')) return 'lore';
  if (key === 'worldview' || key === 'variables' || key === 'opening' || key === 'plot') return key;
  return 'overview';
}

export function IssuesCard({ issues, world, onJump }: { issues: WorldIssue[]; world: WorldDetail; onJump: (key: string) => void }) {
  if (!issues.length) return null;
  const where = (key: string) => {
    const [kind, id] = key.split(':');
    if (kind === 'character') return world.characters.find((c) => c.id === id)?.name ?? id;
    if (kind === 'location') return world.locations.find((l) => l.id === id)?.name ?? id;
    if (kind === 'lore') return world.lore.find((e) => e.id === id)?.title ?? id;
    return { opening: '开场', brief: '简报', worldview: '世界观', variables: '数值', plot: '剧情图', style: '风格', manifest: '世界名' }[key] ?? key;
  };
  return (
    <Card className="p-4" data-testid="world-issues">
      <div className="mb-2 text-xs font-medium text-muted">检查（{issues.length} 个提醒）</div>
      <ul className="space-y-1.5">
        {issues.slice(0, 12).map((i, n) => (
          <li key={n}>
            <button type="button" onClick={() => onJump(i.key)} className="text-left text-xs leading-relaxed text-warn/90 hover:text-warn">
              <span className="text-muted">{where(i.key)}：</span>
              {i.message}
            </button>
          </li>
        ))}
      </ul>
      {issues.length > 12 && <div className="mt-1 text-xs text-faint">……还有 {issues.length - 12} 条</div>}
    </Card>
  );
}
