/**
 * 素材设置的表单（18.11），全局设置页和世界的素材页共用。
 * 世界里只保存和全局不一样的项：每一项旁边能"恢复全局"；全局设置里是"恢复默认"。
 * 做到哪类素材就加上哪类的设置：第 1 步背景，第 2 步立绘和表情差分。
 */
import { type AssetSettings, type AssetSettingsPatch, type ExpressionDef, AssetSettings as SettingsSchema } from '@auto-adv/schema';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Button, cx, Input, Select, Textarea } from '../components/ui.tsx';
import { useSettings } from '../lib/settings.tsx';

type Key =
  | 'enabled.background'
  | 'enabled.sprite'
  | 'enabled.expression'
  | 'imageCap'
  | 'capAction'
  | 'sizes.background'
  | 'sizes.sprite'
  | 'artStyle'
  | 'templates.background'
  | 'templates.sprite'
  | 'templates.expression'
  | 'transparency'
  | 'keyColor'
  | 'spriteProtagonist'
  | 'spriteSets.main'
  | 'spriteSets.other'
  | 'expressions'
  | 'imageConcurrency'
  | 'retries';

type Value = string | number | boolean | string[] | ExpressionDef[];

/** 并发和重试是按接入点算的，只在全局设置里。 */
const GLOBAL_ONLY: Key[] = ['imageConcurrency', 'retries'];

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

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const BG_SIZES = ['1536x1024', '1792x1024', '1920x1080', '1280x720', '1024x576'];
const SPRITE_SIZES = ['1024x1536', '832x1248', '768x1152', '1024x1024'];

const TRANSPARENCY: { value: AssetSettings['transparency']; label: string; hint: string }[] = [
  { value: 'auto', label: '自动', hint: '向服务要透明图，同时让它画纯色底；返回的图带透明就直接用，不带就用内置抠图。' },
  { value: 'native', label: '直接要透明图', hint: '服务支持透明输出时用（比如 OpenAI 的 gpt-image）。' },
  { value: 'key', label: '纯色底 + 内置抠图', hint: '不依赖任何服务。纯色底越干净抠得越好。' },
  { value: 'service', label: '纯色底 + 抠图服务', hint: '先在「职责路由」里配好「抠图」（例如本地的 rembg）。' },
  { value: 'none', label: '不抠', hint: '立绘带着底色上台。' },
];

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

  const base = (mode === 'world' ? global : (defaults?.settings ?? global)) as unknown as Record<string, unknown>;
  const shown = (k: Key) => get(draft, k) ?? get(base, k);
  const changed = (k: Key) => (mode === 'world' ? get(draft, k) !== undefined : !same(get(draft, k), get(base, k)));
  const reset = (k: Key) => setDraft((d) => (mode === 'world' ? set(d, k, undefined) : set(d, k, get(base, k))));
  const put = (k: Key, v: Value) => setDraft((d) => set(d, k, v));
  const dirty = useMemo(() => JSON.stringify(draft) !== valueKey, [draft, valueKey]);
  const table = (shown('expressions') as ExpressionDef[] | undefined) ?? [];

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
    (mode === 'global' || !GLOBAL_ONLY.includes(k)) && (
      <div className="grid grid-cols-[9rem_1fr] items-start gap-3" data-testid={`asset-setting-${k}`}>
        <div className="pt-2">
          <div className="text-xs font-medium text-muted">{label}</div>
          {changed(k) && (
            <button type="button" className="mt-0.5 text-[11px] text-accent-strong hover:underline" onClick={() => reset(k)}>
              {mode === 'world' ? '恢复全局' : '恢复默认'}
            </button>
          )}
        </div>
        <div className="min-w-0 space-y-1">
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
      className={cx('!w-28', mode === 'world' && !changed(k) && 'text-muted')}
    />
  );

  const toggle = (k: Key, text: string, testId: string) => (
    <label className="flex h-9 items-center gap-2 text-sm">
      <input type="checkbox" checked={shown(k) !== false} onChange={(e) => put(k, e.target.checked)} data-testid={testId} />
      {text}
    </label>
  );

  const size = (k: Key, presets: string[], testId: string) => (
    <>
      <Input
        list={`asset-size-${k}`}
        value={String(shown(k) ?? '')}
        onChange={(e) => put(k, e.target.value.trim())}
        className="!w-40 font-mono text-xs"
        data-testid={testId}
      />
      <datalist id={`asset-size-${k}`}>
        {presets.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </>
  );

  const template = (k: Key, fallback: string | undefined, testId: string) => (
    <Textarea
      rows={5}
      value={String(shown(k) ?? '')}
      placeholder={fallback}
      onChange={(e) => put(k, e.target.value)}
      className="font-mono text-xs"
      data-testid={testId}
    />
  );

  /** 主要角色 / 其他角色画哪些表情：表情表里的每一项一个勾。 */
  const exprSet = (k: Key, testId: string) => {
    const picked = new Set((shown(k) as string[] | undefined) ?? []);
    return (
      <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1.5" data-testid={testId}>
        {table.map((e) => (
          <label key={e.id} className="flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              checked={e.id === 'neutral' || picked.has(e.id)}
              disabled={e.id === 'neutral'}
              onChange={(ev) => {
                const next = new Set(picked);
                if (ev.target.checked) next.add(e.id);
                else next.delete(e.id);
                put(
                  k,
                  table.map((x) => x.id).filter((id) => next.has(id)),
                );
              }}
            />
            {e.name}
          </label>
        ))}
      </div>
    );
  };

  const placeholders = (
    <>
      留空用内置模板（见输入框里的灰字）。能用的占位符：
      {defaults?.placeholders.map((p) => (
        <span key={p.key} className="ml-1" title={p.hint}>
          <code className="rounded bg-panel-2 px-1">{`{${p.key}}`}</code>
        </span>
      ))}
      。一行里的占位符全是空的，这一行整个去掉。
    </>
  );

  return (
    <div className="space-y-6">
      <Section title="通用">
        {row('imageCap', '图片上限', '每个世界最多画多少张图，重抽、抠图没过重画的也算。', num('imageCap', 1, 100000))}
        {row(
          'capAction',
          '到了上限',
          null,
          <Select value={String(shown('capAction'))} onChange={(e) => put('capAction', e.target.value)} className="!w-56">
            <option value="ask">停下来，等我在素材页上确认</option>
            <option value="stop">直接停，不再生成</option>
          </Select>,
        )}
        {row(
          'artStyle',
          mode === 'world' ? '画风' : '默认画风',
          mode === 'world' ? '世界简报里写了画风时以简报为准，这里是简报没写时用的。' : '世界没写画风时用。留空用内置的默认画风。',
          <Textarea rows={2} value={String(shown('artStyle') ?? '')} placeholder={defaults?.artStyle} onChange={(e) => put('artStyle', e.target.value)} className="text-xs" />,
        )}
        {row('imageConcurrency', '同时画几张', '同一个图像接入点同时画几张，所有世界共用。', num('imageConcurrency', 1, 16))}
        {row('retries', '失败重试', '一张图失败后重试几次（限流和服务端出错才重试，被拒绝的不重试）。', num('retries', 0, 10))}
      </Section>

      <Section title="背景">
        {row('enabled.background', '背景', '关掉之后不再生成新的背景，已经画好的照样用。', toggle('enabled.background', '生成背景', 'asset-toggle-background'))}
        {row(
          'sizes.background',
          '背景尺寸',
          '宽x高。服务不支持这个尺寸时会报错，换成它支持的尺寸（OpenAI 是 1536x1024）。',
          size('sizes.background', BG_SIZES, 'asset-size-background'),
        )}
        {row('templates.background', '背景的提示词模板', placeholders, template('templates.background', defaults?.templates.background, 'asset-template-background'))}
      </Section>

      <Section title="立绘">
        {row(
          'enabled.sprite',
          '立绘',
          '每个角色先画一张平静的基础立绘。关掉之后不再画新的，已经画好的照样用。',
          toggle('enabled.sprite', '生成基础立绘', 'asset-toggle-sprite'),
        )}
        {row(
          'enabled.expression',
          '表情差分',
          '拿基础立绘当参考图改表情，脸、发型、服装不变。',
          toggle('enabled.expression', '生成表情差分', 'asset-toggle-expression'),
        )}
        {row(
          'spriteProtagonist',
          '主角',
          '观察模式的舞台上主角也出场；剧情 ADV 里不给主角出立绘，只玩剧情 ADV 可以关掉，每个世界省 6 张。',
          toggle('spriteProtagonist', '主角也画立绘', 'asset-toggle-protagonist'),
        )}
        {row('sizes.sprite', '立绘尺寸', '宽x高，竖图。', size('sizes.sprite', SPRITE_SIZES, 'asset-size-sprite'))}
        {row(
          'transparency',
          '透明背景',
          TRANSPARENCY.find((t) => t.value === shown('transparency'))?.hint,
          <Select value={String(shown('transparency'))} onChange={(e) => put('transparency', e.target.value)} className="!w-56" data-testid="asset-transparency">
            {TRANSPARENCY.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>,
        )}
        {row(
          'keyColor',
          '纯色底的颜色',
          '自动：默认白色，外貌里有白衣、白发、银发这类词时换成绿色。',
          <Select value={String(shown('keyColor'))} onChange={(e) => put('keyColor', e.target.value)} className="!w-56">
            <option value="auto">自动</option>
            <option value="white">白色</option>
            <option value="green">绿色</option>
          </Select>,
        )}
        {row(
          'expressions',
          '表情表',
          '名字是给演员看的：AI 演出时台词前的括号里先写一个表情。同义词也认（用逗号隔开）。描述是画表情差分时告诉图像模型的。',
          <ExpressionTable value={table} onChange={(v) => put('expressions', v)} />,
        )}
        {row('spriteSets.main', '主要角色画哪些', '配角、主角这类 npc 以外的角色。平静就是基础立绘，总要画。', exprSet('spriteSets.main', 'asset-set-main'))}
        {row('spriteSets.other', '其他角色画哪些', '路人、店主这类 npc。手写剧本里用到的表情另外加上。', exprSet('spriteSets.other', 'asset-set-other'))}
        {row('templates.sprite', '基础立绘的模板', placeholders, template('templates.sprite', defaults?.templates.sprite, 'asset-template-sprite'))}
        {row(
          'templates.expression',
          '表情差分的模板',
          '表情差分是带参考图改图，模板里只需要写要改什么。',
          template('templates.expression', defaults?.templates.expression, 'asset-template-expression'),
        )}
      </Section>

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

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <h4 className="border-b border-line pb-1 text-xs font-semibold tracking-wide text-muted">{title}</h4>
      {children}
    </section>
  );
}

/** 表情表的编辑：id、名字、同义词、画图时的描述；可以增删。 */
function ExpressionTable({ value, onChange }: { value: ExpressionDef[]; onChange: (v: ExpressionDef[]) => void }) {
  const update = (i: number, patch: Partial<ExpressionDef>) => onChange(value.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  return (
    <div className="space-y-1.5" data-testid="asset-expressions">
      <div className="grid grid-cols-[6rem_5rem_1fr_1.4fr_2rem] gap-1.5 text-[11px] text-faint">
        <span>id</span>
        <span>名字</span>
        <span>同义词</span>
        <span>画图时的描述</span>
      </div>
      {value.map((e, i) => (
        <div key={i} className="grid grid-cols-[6rem_5rem_1fr_1.4fr_2rem] gap-1.5" data-testid="asset-expression-row">
          <Input
            value={e.id}
            disabled={e.id === 'neutral'}
            onChange={(ev) => update(i, { id: ev.target.value.trim().toLowerCase() })}
            className="font-mono text-xs"
            title={e.id === 'neutral' ? '平静是基础立绘，id 不能改' : '小写字母开头，字母、数字、下划线'}
          />
          <Input value={e.name} onChange={(ev) => update(i, { name: ev.target.value })} className="text-xs" />
          <Input
            value={e.synonyms.join('，')}
            onChange={(ev) =>
              update(i, {
                synonyms: ev.target.value
                  .split(/[，,、]/)
                  .map((x) => x.trim())
                  .filter(Boolean),
              })
            }
            className="text-xs"
          />
          <Input value={e.prompt} onChange={(ev) => update(i, { prompt: ev.target.value })} className="text-xs" />
          <button
            type="button"
            className="text-xs text-faint hover:text-err disabled:opacity-30"
            disabled={e.id === 'neutral'}
            title="删掉这个表情"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            ✕
          </button>
        </div>
      ))}
      <Button
        size="sm"
        variant="ghost"
        onClick={() => onChange([...value, { id: `expr_${value.length + 1}`, name: '新表情', synonyms: [], prompt: '' }])}
        data-testid="asset-expression-add"
      >
        加一个表情
      </Button>
    </div>
  );
}
