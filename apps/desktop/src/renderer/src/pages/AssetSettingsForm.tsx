/**
 * 素材设置的表单（18.11），全局设置页和世界的素材页共用。
 * 世界里只保存和全局不一样的项：每一项旁边能"恢复全局"；全局设置里是"恢复默认"。
 * 做到哪类素材就加上哪类的设置：第 1 步背景，第 2 步立绘和表情差分，第 3 步 BGM，第 4 步语音，第 5 步 CG 和时段背景。
 */
import {
  type AssetSettings,
  type AssetSettingsPatch,
  BGM_SOURCE_LABELS,
  BGM_SOURCES,
  type BgmSource,
  type ExpressionDef,
  type MoodDef,
  AssetSettings as SettingsSchema,
  type TimeVariantDef,
} from '@auto-adv/schema';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Button, cx, Input, Select, Textarea } from '../components/ui.tsx';
import { useSettings } from '../lib/settings.tsx';

type Key =
  | 'enabled.background'
  | 'enabled.timeOfDay'
  | 'timeOfDay.mode'
  | 'timeOfDay.variants'
  | 'templates.timeOfDay'
  | 'enabled.cg'
  | 'cg.perScene'
  | 'cg.perChapter'
  | 'cg.reference'
  | 'sizes.cg'
  | 'templates.cg'
  | 'extras.silhouette'
  | 'extras.upgradeAfter'
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
  | 'retries'
  | 'enabled.bgm'
  | 'bgm.sources'
  | 'bgm.libraryDir'
  | 'bgm.classifyLibrary'
  | 'bgm.moods'
  | 'bgm.switchBeats'
  | 'bgm.fadeSeconds'
  | 'bgm.gapSeconds'
  | 'bgm.volume'
  | 'bgm.template'
  | 'musicConcurrency'
  | 'enabled.voice'
  | 'voice.protagonist'
  | 'voice.narrator'
  | 'voice.narratorVoice'
  | 'voice.extraVoice'
  | 'voice.speed'
  | 'voice.volume'
  | 'voice.prefetch'
  | 'voice.emotion'
  | 'voice.emotions'
  | 'voiceConcurrency';

type Value = string | number | boolean | string[] | ExpressionDef[] | MoodDef[] | TimeVariantDef[] | Record<string, string>;

/** 并发和重试是按接入点算的，只在全局设置里。 */
const GLOBAL_ONLY: Key[] = ['imageConcurrency', 'retries', 'musicConcurrency', 'voiceConcurrency'];

const SOURCE_HINTS: Record<BgmSource, string> = {
  library: '你自己的音乐文件夹',
  model: '用「职责路由」里的「音乐」生成，每种情绪一首',
  builtin: '随应用一起的公有领域钢琴曲',
};

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
  const moods = (shown('bgm.moods') as MoodDef[] | undefined) ?? [];

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

  /** 可以有小数的数字（秒、倍数）。 */
  const dec = (k: Key, min: number, max: number, testId?: string, step = 0.5) => (
    <Input
      type="number"
      min={min}
      max={max}
      step={step}
      value={String(shown(k) ?? '')}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (Number.isFinite(n)) put(k, Math.min(max, Math.max(min, n)));
      }}
      className={cx('!w-28', mode === 'world' && !changed(k) && 'text-muted')}
      data-testid={testId}
    />
  );

  /** BGM 的来源：勾上的按顺序找，可以上下调。 */
  const sources = () => {
    const on = ((shown('bgm.sources') as BgmSource[] | undefined) ?? []).filter((x) => BGM_SOURCES.includes(x));
    const all = [...on, ...BGM_SOURCES.filter((x) => !on.includes(x))];
    const move = (i: number, d: number) => {
      const next = [...on];
      const [x] = next.splice(i, 1);
      if (x) next.splice(i + d, 0, x);
      put('bgm.sources', next);
    };
    return (
      <div className="space-y-1" data-testid="asset-bgm-sources">
        {all.map((src) => {
          const i = on.indexOf(src);
          return (
            <div key={src} className="flex items-center gap-2 text-sm" data-testid={`asset-bgm-source-${src}`}>
              <input
                type="checkbox"
                checked={i >= 0}
                onChange={(e) => put('bgm.sources', e.target.checked ? [...on, src] : on.filter((x) => x !== src))}
              />
              <span className={cx('w-6 text-xs text-faint', i < 0 && 'invisible')}>{i + 1}.</span>
              <span className={cx('w-20', i < 0 && 'text-faint')}>{BGM_SOURCE_LABELS[src]}</span>
              <span className="flex-1 text-[11px] text-faint">{SOURCE_HINTS[src]}</span>
              <button type="button" className="px-1 text-xs text-muted disabled:opacity-25" disabled={i <= 0} onClick={() => move(i, -1)} title="往前">
                ↑
              </button>
              <button
                type="button"
                className="px-1 text-xs text-muted disabled:opacity-25"
                disabled={i < 0 || i >= on.length - 1}
                onClick={() => move(i, 1)}
                title="往后"
              >
                ↓
              </button>
            </div>
          );
        })}
      </div>
    );
  };

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

  /** 音色 id：可以直接写，也可以从语音职责的音色表里挑；空着是自动。 */
  const voices = settings?.media.voice?.voices ?? [];
  const voicePick = (k: Key, testId: string) => (
    <>
      <Input
        list="asset-voice-ids"
        value={String(shown(k) ?? '')}
        placeholder="自动"
        onChange={(e) => put(k, e.target.value.trim())}
        className="!w-56 font-mono text-xs"
        data-testid={testId}
      />
      <datalist id="asset-voice-ids">
        {voices.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name || v.id}
          </option>
        ))}
      </datalist>
    </>
  );

  /** 表情 → 情绪：表情表里的每个表情一格，空着不传情绪。 */
  const emotionMap = () => {
    const map = (shown('voice.emotions') as Record<string, string> | undefined) ?? {};
    return (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-1.5" data-testid="asset-voice-emotions">
        {table.map((e) => (
          <label key={e.id} className="flex items-center gap-1.5 text-xs">
            <span className="w-14 shrink-0 truncate text-muted" title={e.id}>
              {e.name}
            </span>
            <Input
              value={map[e.id] ?? ''}
              placeholder="不传"
              onChange={(ev) => {
                const next = { ...map };
                const v = ev.target.value.trim();
                if (v) next[e.id] = v;
                else delete next[e.id];
                put('voice.emotions', next);
              }}
              className="font-mono text-xs"
            />
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
        {row(
          'enabled.timeOfDay',
          '时段背景',
          'AI 演出时，故事时间里出现时段表里的词（深夜、傍晚……），就换成这个地点的黄昏、夜晚版本。第一次用到时才画，画好之前先用白天的那张。',
          toggle('enabled.timeOfDay', '按故事时间换背景', 'asset-toggle-timeOfDay'),
        )}
        {row(
          'timeOfDay.mode',
          '怎么画',
          '改图：拿白天的背景当参考图只改光线和天色，构图和物件不变（服务要支持带参考图改图）。重新画：按地点描述和时段重新画一张。',
          <Select value={String(shown('timeOfDay.mode'))} onChange={(e) => put('timeOfDay.mode', e.target.value)} className="!w-56" data-testid="asset-tod-mode">
            <option value="edit">拿白天的背景改</option>
            <option value="generate">重新画</option>
          </Select>,
        )}
        {row(
          'timeOfDay.variants',
          '时段表',
          '故事时间里有这些词就用这个时段（长的词先比，"入夜前"算黄昏）。描述是画的时候告诉图像模型的光线和天色。白天就是地点本来的背景，不用写。',
          <TimeVariantTable value={(shown('timeOfDay.variants') as TimeVariantDef[] | undefined) ?? []} onChange={(v) => put('timeOfDay.variants', v)} />,
        )}
        {row(
          'templates.timeOfDay',
          '时段背景的模板',
          '「拿白天的背景改」时用，模板里只需要写要改什么；「重新画」用背景的模板。',
          template('templates.timeOfDay', defaults?.templates.timeOfDay, 'asset-template-timeOfDay'),
        )}
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
        {row(
          'extras.silhouette',
          '临时人物',
          'AI 演出时世界里没有的路人、守卫、伙计开口时，用一个按名字换颜色的剪影上台。关掉就只出名字。',
          toggle('extras.silhouette', '用剪影上台', 'asset-extras-silhouette'),
        )}
        {row(
          'extras.upgradeAfter',
          '升级成正式角色',
          '同一个临时人物在一个周目里开口满这么多拍，就让模型补一张角色卡（外貌、性格、说话方式）写进世界，之后画立绘、分配音色。认出是已有角色换了个叫法时，只加一个别称。0 就是不升级。',
          num('extras.upgradeAfter', 0, 20),
        )}
      </Section>

      <Section title="CG">
        {row(
          'enabled.cg',
          'CG',
          '手写剧本里写了的 CG，和 AI 演出时导演标的高光时刻。导演标的画好时这一拍还在播就当场放出来，播完了就进 CG 画廊。',
          toggle('enabled.cg', '生成 CG', 'asset-toggle-cg'),
        )}
        {row('cg.perScene', '每幕最多', 'AI 演出时导演每一幕最多标几张。0 就是不标（手写剧本里的照画）。', num('cg.perScene', 0, 10))}
        {row('cg.perChapter', '每章最多', '没有剧情图的观察模式不按章算，只按"同一个地点连着演的一段"算一幕。', num('cg.perChapter', 0, 50))}
        {row(
          'cg.reference',
          '参考图',
          '拿画面里第一个角色的基础立绘当参考图改图，长相和服装和立绘一致（服务要支持带参考图改图）。关掉就只按文字描述画。',
          toggle('cg.reference', '用立绘当参考图', 'asset-cg-reference'),
        )}
        {row('sizes.cg', 'CG 尺寸', '宽x高，横图。', size('sizes.cg', BG_SIZES, 'asset-size-cg'))}
        {row('templates.cg', 'CG 的模板', placeholders, template('templates.cg', defaults?.templates.cg, 'asset-template-cg'))}
      </Section>

      <Section title="BGM">
        {row('enabled.bgm', 'BGM', '每个世界一套情绪曲目，按导演报告的情绪换曲。关掉之后舞台上不放音乐，也不再生成。', toggle('enabled.bgm', '放 BGM', 'asset-toggle-bgm'))}
        {row('bgm.sources', '来源', '每种情绪按顺序找：第一个有这种情绪的曲子的来源就用它。轮到音乐模型、曲子还没生成好时，先用后面的来源。', sources())}
        {row(
          'bgm.libraryDir',
          '本地曲库',
          '按子文件夹名或文件名对应情绪，例如「紧张/追逐.mp3」「calm_daily.ogg」（情绪的名字、id、同义词都认）。手写剧本里 bgm 指令写的名字和文件名一样时，直接放这个文件。',
          <div className="flex gap-2">
            <Input
              value={String(shown('bgm.libraryDir') ?? '')}
              placeholder="不选"
              onChange={(e) => put('bgm.libraryDir', e.target.value)}
              className="min-w-0 flex-1 font-mono text-xs"
              data-testid="asset-bgm-library"
            />
            {window.autoAdv && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void window.autoAdv?.pickFolder('选择本地曲库的文件夹', 'music').then((dir) => {
                    if (dir) put('bgm.libraryDir', dir);
                  })
                }
              >
                选择…
              </Button>
            )}
          </div>,
        )}
        {row(
          'bgm.classifyLibrary',
          '按文件名挑',
          '文件夹名和文件名都对不上情绪的曲子，让「书记」职责的文本模型按文件名猜一次（每个文件只问一次）。',
          toggle('bgm.classifyLibrary', '对不上的让模型挑', 'asset-bgm-classify'),
        )}
        {row(
          'bgm.moods',
          '情绪表',
          '导演每一拍从这里选一个情绪。说明是给导演看的；描述是用音乐模型生成时告诉它的。同义词用来认手写剧本的 bgm 指令和曲库的文件名（用逗号隔开）。第一个情绪是兜底：认不出来的 bgm 指令放它。',
          <MoodTable value={moods} onChange={(v) => put('bgm.moods', v)} />,
        )}
        {row('bgm.switchBeats', '换曲', '导演报告的情绪连着几拍都一样才换曲，免得来回跳。换幕、换地点时马上换。', num('bgm.switchBeats', 1, 10))}
        {row('bgm.fadeSeconds', '淡入淡出', '换曲时旧的淡出、新的淡入，单位秒。', dec('bgm.fadeSeconds', 0, 10, 'asset-bgm-fade'))}
        {row('bgm.gapSeconds', '曲间停顿', '不循环的曲子（本地曲库、内置曲库）放完以后停几秒再放同一情绪的下一首。', dec('bgm.gapSeconds', 0, 60))}
        {row('bgm.volume', '音量', '0～100。舞台角上的「♫」点一下可以静音。', num('bgm.volume', 0, 100))}
        {row(
          'bgm.template',
          '生成的提示词模板',
          <>
            留空用内置模板。能用的占位符：
            {defaults?.music.placeholders.map((p) => (
              <span key={p.key} className="ml-1" title={p.hint}>
                <code className="rounded bg-panel-2 px-1">{`{${p.key}}`}</code>
              </span>
            ))}
            。世界没写音乐风格时用：{defaults?.music.style}
          </>,
          template('bgm.template', defaults?.music.template, 'asset-template-bgm'),
        )}
        {row('musicConcurrency', '同时生成几首', '同一个音乐接入点同时生成几首，所有世界共用。', num('musicConcurrency', 1, 8))}
      </Section>

      <Section title="语音">
        {row(
          'enabled.voice',
          '语音',
          '用「职责路由」里的「语音」给台词配音，每个角色固定一个音色（世界的素材页能看到、能换）。念过的句子存起来，回想、读档时不用再生成。',
          toggle('enabled.voice', '给台词配音', 'asset-toggle-voice'),
        )}
        {row('voice.protagonist', '主角', '剧情 ADV 里主角是你自己，默认不配。单个角色可以在世界的素材页上开关。', toggle('voice.protagonist', '主角也配音', 'asset-voice-protagonist'))}
        {row('voice.narrator', '旁白', '旁白和没写是谁的心声也念出来。句子多，会多花不少额度。', toggle('voice.narrator', '旁白也配音', 'asset-voice-narrator'))}
        {row('voice.narratorVoice', '旁白的音色', '音色 id。空着自动挑一个：描述里有「旁白」「中性」的优先，其次是没分给角色的。', voicePick('voice.narratorVoice', 'asset-voice-narrator-voice'))}
        {row('voice.extraVoice', '临时人物的音色', '世界里没有的人物（AI 演出时临时出场的路人）用的音色 id。空着自动挑一个没分给主要角色的。', voicePick('voice.extraVoice', 'asset-voice-extra'))}
        {row('voice.speed', '语速', '0.5～2，1 是正常。改了以后念过的句子会重新生成。', dec('voice.speed', 0.5, 2, 'asset-voice-speed', 0.1))}
        {row('voice.volume', '音量', '0～100。舞台工具栏上的「配音」可以在这台电脑上关掉配音。', num('voice.volume', 0, 100))}
        {row('voice.prefetch', '提前生成', '播到一句时提前生成后面几句，点得快也不用等。0 是不提前。', num('voice.prefetch', 0, 5))}
        {row('voice.emotion', '情绪', '按说话人这句的表情传情绪（MiniMax 的 emotion，自定义接口里是 {{emotion}}）。服务不认情绪时自动不传。', toggle('voice.emotion', '按表情传情绪', 'asset-voice-emotion'))}
        {row('voice.emotions', '表情对应的情绪', '空着的表情不传情绪，让服务自己判断。MiniMax 常用的有 happy、sad、angry、fearful、disgusted、surprised、calm。', emotionMap())}
        {row('voiceConcurrency', '同时生成几句', '所有世界共用。', num('voiceConcurrency', 1, 8))}
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

/** 时段表的编辑：id、名字、故事时间里的词、画的时候的光线和天色；可以增删。 */
function TimeVariantTable({ value, onChange }: { value: TimeVariantDef[]; onChange: (v: TimeVariantDef[]) => void }) {
  const update = (i: number, patch: Partial<TimeVariantDef>) => onChange(value.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  const cols = 'grid grid-cols-[5.5rem_4.5rem_1.2fr_1.4fr_2rem] gap-1.5';
  return (
    <div className="space-y-1.5" data-testid="asset-tod-variants">
      <div className={cx(cols, 'text-[11px] text-faint')}>
        <span>id</span>
        <span>名字</span>
        <span>故事时间里的词</span>
        <span>光线和天色</span>
      </div>
      {value.map((v, i) => (
        <div key={i} className={cols} data-testid="asset-tod-row">
          <Input
            value={v.id}
            onChange={(ev) => update(i, { id: ev.target.value.trim().toLowerCase() })}
            className="font-mono text-xs"
            title="小写字母开头，字母、数字、下划线"
          />
          <Input value={v.name} onChange={(ev) => update(i, { name: ev.target.value })} className="text-xs" />
          <Input
            value={v.words.join('，')}
            onChange={(ev) =>
              update(i, {
                words: ev.target.value
                  .split(/[，,、]/)
                  .map((x) => x.trim())
                  .filter(Boolean),
              })
            }
            className="text-xs"
          />
          <Input value={v.prompt} onChange={(ev) => update(i, { prompt: ev.target.value })} className="text-xs" />
          <button type="button" className="text-xs text-faint hover:text-err" title="删掉这个时段" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <Button
        size="sm"
        variant="ghost"
        onClick={() => onChange([...value, { id: `time_${value.length + 1}`, name: '新时段', words: [], prompt: '' }])}
        data-testid="asset-tod-add"
      >
        加一个时段
      </Button>
    </div>
  );
}

/** 情绪表的编辑：id、名字、同义词、给导演看的说明、生成时的描述；可以增删。 */
function MoodTable({ value, onChange }: { value: MoodDef[]; onChange: (v: MoodDef[]) => void }) {
  const update = (i: number, patch: Partial<MoodDef>) => onChange(value.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  const cols = 'grid grid-cols-[5.5rem_4.5rem_1fr_1fr_1fr_2rem] gap-1.5';
  return (
    <div className="space-y-1.5" data-testid="asset-moods">
      <div className={cx(cols, 'text-[11px] text-faint')}>
        <span>id</span>
        <span>名字</span>
        <span>同义词</span>
        <span>给导演看的说明</span>
        <span>生成时的描述</span>
      </div>
      {value.map((m, i) => (
        <div key={i} className={cols} data-testid="asset-mood-row">
          <Input
            value={m.id}
            onChange={(ev) => update(i, { id: ev.target.value.trim().toLowerCase() })}
            className="font-mono text-xs"
            title="小写字母开头，字母、数字、下划线"
          />
          <Input value={m.name} onChange={(ev) => update(i, { name: ev.target.value })} className="text-xs" />
          <Input
            value={m.synonyms.join('，')}
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
          <Input value={m.hint} onChange={(ev) => update(i, { hint: ev.target.value })} className="text-xs" />
          <Input value={m.prompt} onChange={(ev) => update(i, { prompt: ev.target.value })} className="text-xs" />
          <button
            type="button"
            className="text-xs text-faint hover:text-err disabled:opacity-30"
            disabled={value.length <= 1}
            title="删掉这个情绪"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            ✕
          </button>
        </div>
      ))}
      <Button
        size="sm"
        variant="ghost"
        onClick={() => onChange([...value, { id: `mood_${value.length + 1}`, name: '新情绪', synonyms: [], hint: '', prompt: '' }])}
        data-testid="asset-mood-add"
      >
        加一个情绪
      </Button>
    </div>
  );
}
