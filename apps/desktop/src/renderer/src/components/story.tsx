import type { PathEvent, Segment, WorldDetail } from '@auto-adv/engine/api';
import { segmentsToText } from '@auto-adv/engine/script';
import { type ReactNode, useCallback, useState } from 'react';
import { Button, ConfirmButton, Textarea } from './ui.tsx';

/** 故事内容的显示组件（自由对话和观察模式共用）。 */

export const PALETTE = ['#a194ff', '#f472b6', '#34d399', '#fbbf24', '#60a5fa', '#fb923c', '#22d3ee', '#e879f9'];

/** 角色的颜色：按角色在世界里的顺序取色，没有对应角色时按名字散列。 */
export function useColorOf(world: WorldDetail | null) {
  return useCallback(
    (characterId: string | null, name: string) => {
      const i = world?.characters.findIndex((c) => c.id === characterId) ?? -1;
      if (i >= 0) return PALETTE[i % PALETTE.length];
      let h = 0;
      for (const ch of name) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
      return PALETTE[h % PALETTE.length];
    },
    [world],
  );
}

// ───────────── 事件 ─────────────

export function Segments({ segs, colorOf }: { segs: Segment[]; colorOf: (id: string | null, name: string) => string | undefined }) {
  return (
    <div className="space-y-2.5">
      {segs.map((s, i) =>
        !s ? null : s.kind === 'narration' ? (
          <p key={i} className="text-[15px] leading-7 text-muted">
            {s.text}
          </p>
        ) : (
          <div key={i} className="border-l-2 pl-3" style={{ borderColor: colorOf(s.characterId, s.name) }}>
            <div className="text-xs font-medium" style={{ color: colorOf(s.characterId, s.name) }}>
              {s.name}
            </div>
            <p className="text-[15px] leading-7">{s.text}</p>
          </div>
        ),
      )}
    </div>
  );
}

export function EventBlock({
  e,
  world,
  isLast,
  busy,
  protagonistName,
  colorOf,
  onRegenerate,
  onSwitch,
  onRewind,
  onDelete,
  onEdit,
  onResend,
}: {
  e: PathEvent;
  world: WorldDetail;
  isLast: boolean;
  busy: boolean;
  protagonistName: string;
  colorOf: (id: string | null, name: string) => string | undefined;
  onRegenerate?: () => void;
  onSwitch?: (id: string) => void;
  onRewind?: () => void;
  onDelete?: () => void;
  onEdit?: (text: string) => void;
  onResend?: (text: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const tools = !busy && !!onSwitch;

  const pager =
    e.siblingIds.length > 1 && onSwitch ? (
      <span className="inline-flex items-center gap-0.5 text-xs text-faint" data-testid="pager">
        <ToolButton
          disabled={busy || e.siblingIndex === 0}
          onClick={() => onSwitch(e.siblingIds[e.siblingIndex - 1] as string)}
          testId="pager-prev"
        >
          ‹
        </ToolButton>
        <span data-testid="pager-label">
          {e.siblingIndex + 1}/{e.siblingIds.length}
        </span>
        <ToolButton
          disabled={busy || e.siblingIndex === e.siblingIds.length - 1}
          onClick={() => onSwitch(e.siblingIds[e.siblingIndex + 1] as string)}
          testId="pager-next"
        >
          ›
        </ToolButton>
      </span>
    ) : null;

  const actions = (items: ReactNode) =>
    (tools || pager) && (
      <div className="mt-1.5 flex h-6 items-center gap-1">
        {pager}
        {tools && <span className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">{items}</span>}
      </div>
    );

  if (e.kind === 'scene') {
    const loc = world.locations.find((l) => l.id === e.scene?.locationId)?.name ?? '未指定地点';
    const names = (e.scene?.presentCharacterIds ?? [])
      .map((id) => world.characters.find((c) => c.id === id)?.name)
      .filter(Boolean);
    return (
      <div className="group flex items-center gap-3 text-xs text-faint" data-testid="play-event" data-kind="scene">
        <span className="h-px flex-1 bg-line" />
        场景：{loc} · 在场：{names.join('、') || '无'}
        {tools && (
          <span className="opacity-0 group-hover:opacity-100">
            <ConfirmButton variant="ghost" onConfirm={() => onDelete?.()}>
              删除
            </ConfirmButton>
          </span>
        )}
        <span className="h-px flex-1 bg-line" />
      </div>
    );
  }

  if (e.kind === 'directive' || e.kind === 'whisper') {
    const who = world.characters.find((c) => c.id === e.characterId)?.name ?? '？';
    return (
      <div
        className="group flex items-start gap-2 rounded-lg border border-dashed border-line px-3 py-2 text-xs"
        data-testid="play-event"
        data-kind={e.kind}
      >
        <span className="shrink-0 font-medium text-accent-strong">
          {e.kind === 'directive' ? '导演指令' : `悄悄对${who}说`}
        </span>
        <span className="min-w-0 flex-1 whitespace-pre-wrap text-muted">{e.text}</span>
        {tools && (
          <span className="opacity-0 group-hover:opacity-100">
            <ConfirmButton variant="ghost" onConfirm={() => onDelete?.()} title="删除这条和之后的全部内容">
              删除
            </ConfirmButton>
          </span>
        )}
      </div>
    );
  }

  if (e.kind === 'player') {
    const speaker = world.characters.find((c) => c.id === e.characterId)?.name ?? protagonistName;
    return (
      <div className="group flex flex-col items-end" data-testid="play-event" data-kind="player">
        <div className="mb-1 text-xs text-faint">{speaker}</div>
        {editing !== null ? (
          <EditBox
            value={editing}
            onCancel={() => setEditing(null)}
            onSave={(t) => {
              setEditing(null);
              onResend?.(t);
            }}
            saveLabel="重新发送"
          />
        ) : (
          <div className="max-w-[85%] rounded-2xl rounded-tr-md bg-accent-soft px-4 py-2.5 text-[15px] leading-7 whitespace-pre-wrap">
            {e.text}
          </div>
        )}
        {actions(
          <>
            <ToolButton onClick={() => setEditing(e.text ?? '')}>编辑后重发</ToolButton>
            {!isLast && <ToolButton onClick={() => onRewind?.()}>回到这里</ToolButton>}
            <ConfirmButton variant="ghost" onConfirm={() => onDelete?.()} title="删除这一句和之后的全部内容">
              删除
            </ConfirmButton>
          </>,
        )}
      </div>
    );
  }

  return (
    <div className="group" data-testid="play-event" data-kind={e.kind}>
      {editing !== null ? (
        <EditBox
          value={editing}
          onCancel={() => setEditing(null)}
          onSave={(t) => {
            setEditing(null);
            onEdit?.(t);
          }}
          hint="格式：旁白直接写；台词写成 【角色名】台词"
        />
      ) : (
        <Segments segs={e.segments ?? []} colorOf={colorOf} />
      )}
      {e.edited && editing === null && <div className="mt-1 text-[11px] text-faint">（已编辑）</div>}
      {actions(
        <>
          {e.kind === 'ai' && (
            <ToolButton onClick={() => onRegenerate?.()} testId="regenerate">
              重抽
            </ToolButton>
          )}
          <ToolButton onClick={() => setEditing(segmentsToText(e.segments ?? []))}>编辑</ToolButton>
          {!isLast && (
            <ToolButton onClick={() => onRewind?.()} testId="rewind">
              回到这里
            </ToolButton>
          )}
          {e.kind === 'ai' && (
            <ConfirmButton variant="ghost" onConfirm={() => onDelete?.()} title="删除这条回复和之后的全部内容">
              删除
            </ConfirmButton>
          )}
        </>,
      )}
    </div>
  );
}

export function ToolButton({
  children,
  onClick,
  disabled,
  testId,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
      className="h-6 rounded-md px-1.5 text-xs text-faint transition-colors hover:bg-panel-2 hover:text-fg disabled:opacity-30"
    >
      {children}
    </button>
  );
}

function EditBox({
  value,
  onSave,
  onCancel,
  saveLabel = '保存',
  hint,
}: {
  value: string;
  onSave: (text: string) => void;
  onCancel: () => void;
  saveLabel?: string;
  hint?: string;
}) {
  const [text, setText] = useState(value);
  return (
    <div className="w-full space-y-2">
      <Textarea rows={Math.min(12, Math.max(3, text.split('\n').length + 1))} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
      <div className="flex items-center gap-2">
        <Button size="sm" variant="primary" disabled={!text.trim()} onClick={() => onSave(text)}>
          {saveLabel}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          取消
        </Button>
        {hint && <span className="text-xs text-faint">{hint}</span>}
      </div>
    </div>
  );
}

