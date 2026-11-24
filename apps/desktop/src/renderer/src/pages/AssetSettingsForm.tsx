/**
 * 素材设置的表单（18.11），全局设置页和世界的素材页共用。
 * 世界里只保存和全局不一样的项：每一项旁边能"恢复全局"；全局设置里是"恢复默认"。
 * M4 第 1 步只有背景用得上的几项，后面几步做到哪类素材就加上哪类的设置。
 */
import { type AssetSettings, type AssetSettingsPatch, AssetSettings as SettingsSchema } from '@auto-adv/schema';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Button, cx, Input, Select, Textarea } from '../components/ui.tsx';
import { useSettings } from '../lib/settings.tsx';

type Key =
  | 'enabled.background'
  | 'imageCap'
  | 'capAction'
  | 'sizes.background'
  | 'artStyle'
  | 'templates.background'
  | 'imageConcurrency'
  | 'retries';

type Value = string | number | boolean;

/** 世界里可以改的项（并发和重试是按接入点算的，只在全局设置里）。 */
const WORLD_KEYS: Key[] = ['enabled.background', 'imageCap', 'capAction', 'sizes.background', 'artStyle', 'templates.background'];
const GLOBAL_KEYS: Key[] = [...WORLD_KEYS, 'imageConcurrency', 'retries'];

function get(s: Record<string, unknown>, key: Key): Value | undefined {
  const [a, b] = key.split('.') as [string, string | undefined];
  const v = b ? (s[a] as Record<string, unknown> | undefined)?.[b] : s[a];
  return v as Value | undefined;
}

function set<T extends Record<string, unknown>>(s: T, key: Key, v: Value | undefined): T {
  const [a, b] = key.split('.') as [string, string | undefined];
  const next: Record<string, unknown> = { ...s };
  if (b) {
    const inner = { ...((next[a] as Record<string, unknown> | undefined) ?? {}) };
    if (v === undefined) delete inner[b];
    else inner[b] = v;
    if (Object.keys(inner).length) next[a] = inner;
    else delete next[a];
  } else if (v === undefined) {
    delete next[a];
  } else {
    next[a] = v;
  }
  return next as T;
}

const SIZE_PRESETS = ['1536x1024', '1792x1024', '1920x1080', '1280x720', '1024x576'];

export function AssetSettingsForm({
  mode,
  global,
  value,
  onSave,
}: {
  mode: 'global' | 'world';
  global: AssetSettings;
  value: AssetSettings | AssetSettingsPatch;
  onSave: (v: AssetSettings | AssetSettingsPatch) => Promise<void>;
}) {
  const { settings } = useSettings();
  const defaults = settings?.assetDefaults;
  const [draft, setDraft] = useState<Record<string, unknown>>(value as Record<string, unknown>);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 素材页每画好一张都会推一次新的状态：内容没变就不要冲掉正在改的表单
  const valueKey = JSON.stringify(value);
  useEffect(() => setDraft(JSON.parse(valueKey) as Record<string, unknown>), [valueKey]);

  const keys = mode === 'world' ? WORLD_KEYS : GLOBAL_KEYS;
  const base = (mode === 'world' ? global : (defaults?.settings ?? global)) as unknown as Record<string, unknown>;
  const shown = (k: Key) => get(draft, k) ?? get(base, k);
  const changed = (k: Key) => (mode === 'world' ? get(draft, k) !== undefined : get(draft, k) !== get(base, k));
  const reset = (k: Key) => setDraft((d) => (mode === 'world' ? set(d, k, undefined) : set(d, k, get(base, k))));
  const put = (k: Key, v: Value) => setDraft((d) => set(d, k, v));
  const dirty = useMemo(() => JSON.stringify(draft) !== valueKey, [draft, valueKey]);

  const save = async () => {
    setError(null);
    if (mode === 'global') {
      const r = SettingsSchema.safeParse(draft);
      if (!r.success) {
        setError(r.error.issues[0]?.message ?? '设置不合法');
        return;
      }
    }
    setSaving(true);
    try {
      await onSave(draft as AssetSettings | AssetSettingsPatch);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const row = (k: Key, label: string, hint: ReactNode, input: ReactNode) =>
    keys.includes(k) && (
      <div className="grid grid-cols-[9rem_1fr] items-start gap-3" data-testid={`asset-setting-${k}`}>
        <div className="pt-2">
          <div className="text-xs font-medium text-muted">{label}</div>
          {changed(k) && (
            <button type="button" className="mt-0.5 text-[11px] text-accent-strong hover:underline" onClick={() => reset(k)}>
              {mode === 'world' ? '恢复全局' : '恢复默认'}
            </button>
          )}
        </div>
        <div className="space-y-1">
          {input}
          {hint && <div className="text-[11px] leading-snug text-faint">{hint}</div>}
        </div>
      </div>
    );

  const num = (k: Key, min: number, max: number) => (
    <Input
      type="number"
      min={min}
      max={max}
      value={String(shown(k) ?? '')}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (Number.isInteger(n)) put(k, Math.min(max, Math.max(min, n)));
      }}
      className={cx('w-28', mode === 'world' && !changed(k) && 'text-muted')}
    />
  );

  return (
    <div className="space-y-4">
      {row(
        'enabled.background',
        '背景',
        '关掉之后不再生成新的背景，已经画好的照样用。立绘、BGM、语音的开关在后面几步做上。',
        <label className="flex h-9 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={shown('enabled.background') !== false}
            onChange={(e) => put('enabled.background', e.target.checked)}
            data-testid="asset-toggle-background"
          />
          生成背景
        </label>,
      )}
      {row('imageCap', '图片上限', '每个世界最多画多少张图，重抽也算。', num('imageCap', 1, 100000))}
      {row(
        'capAction',
        '到了上限',
        null,
        <Select value={String(shown('capAction'))} onChange={(e) => put('capAction', e.target.value)} className="w-56">
          <option value="ask">停下来，等我在素材页上确认</option>
          <option value="stop">直接停，不再生成</option>
        </Select>,
      )}
      {row(
        'sizes.background',
        '背景尺寸',
        '宽x高。服务不支持这个尺寸时会报错，换成它支持的尺寸（OpenAI 是 1536x1024）。',
        <>
          <Input
            list="asset-size-presets"
            value={String(shown('sizes.background') ?? '')}
            onChange={(e) => put('sizes.background', e.target.value.trim())}
            className="w-40 font-mono text-xs"
            data-testid="asset-size-background"
          />
          <datalist id="asset-size-presets">
            {SIZE_PRESETS.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </>,
      )}
      {row(
        'artStyle',
        mode === 'world' ? '画风' : '默认画风',
        mode === 'world'
          ? '世界简报里写了画风时以简报为准，这里是简报没写时用的。'
          : '世界没写画风时用。留空用内置的默认画风。',
        <Textarea
          rows={2}
          value={String(shown('artStyle') ?? '')}
          placeholder={defaults?.artStyle}
          onChange={(e) => put('artStyle', e.target.value)}
          className="text-xs"
        />,
      )}
      {row(
        'templates.background',
        '背景的提示词模板',
        <>
          留空用内置模板（见输入框里的灰字）。能用的占位符：
          {defaults?.placeholders.map((p) => (
            <span key={p.key} className="ml-1" title={p.hint}>
              <code className="rounded bg-panel-2 px-1">{`{${p.key}}`}</code>
            </span>
          ))}
          。一行里的占位符全是空的，这一行整个去掉。
        </>,
        <Textarea
          rows={5}
          value={String(shown('templates.background') ?? '')}
          placeholder={defaults?.templates.background}
          onChange={(e) => put('templates.background', e.target.value)}
          className="font-mono text-xs"
          data-testid="asset-template-background"
        />,
      )}
      {row('imageConcurrency', '同时画几张', '同一个图像接入点同时画几张，所有世界共用。', num('imageConcurrency', 1, 16))}
      {row('retries', '失败重试', '一张图失败后重试几次（限流和服务端出错才重试，被拒绝的不重试）。', num('retries', 0, 10))}
      <div className="flex items-center gap-3">
        <Button variant="primary" size="sm" disabled={!dirty} loading={saving} onClick={() => void save()} data-testid="asset-settings-save">
          保存
        </Button>
        {dirty && (
          <Button size="sm" variant="ghost" onClick={() => setDraft(JSON.parse(valueKey) as Record<string, unknown>)}>
            撤销修改
          </Button>
        )}
        {error && <span className="text-xs text-err">{error}</span>}
        <span className="ml-auto text-[11px] text-faint">改了设置不会自动重画，素材页会列出过期的图，点了才重画。</span>
      </div>
    </div>
  );
}
