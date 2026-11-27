import type { BuiltinTrackInfo, EndpointView, ProbeChunk } from '@auto-adv/engine/api';
import { ENDPOINT_PRESETS, PROBE_STEP_LABELS, type ProbeStep } from '@auto-adv/providers';
import {
  type AssetSettings,
  type Capabilities,
  ComfySettings,
  comfyUsesModel,
  type CustomApi,
  DEFAULT_MOODS,
  type EditorSettings,
  MEDIA_ROLE_APIS,
  MEDIA_ROLE_LABELS,
  type MediaRoleId,
  type MediaRoute,
  ROLE_IDS,
  ROLE_LABELS,
  type RoleId,
  type RoleRoute,
  type VoiceDef,
} from '@auto-adv/schema';
import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, cx, Empty, Field, Input, PageHeader, Select, Spinner, Tabs, Textarea, useToast } from '../components/ui.tsx';
import { engine, errorMessage, isAborted } from '../lib/engine.ts';
import { useSettings } from '../lib/settings.tsx';
import { AssetSettingsForm } from './AssetSettingsForm.tsx';
import { ComfyEditor } from './ComfyEditor.tsx';
import { CustomApiEditor, defaultCustomApi } from './CustomApiEditor.tsx';

type Tab = 'endpoints' | 'roles' | 'assets' | 'editor' | 'about';

export function SettingsPage() {
  const [tab, setTab] = useState<Tab>('endpoints');
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="设置"
        subtitle="接入模型、给引擎里的各个职责分配模型"
        actions={
          <Tabs
            value={tab}
            onChange={setTab}
            items={[
              { value: 'endpoints', label: '模型接入点' },
              { value: 'roles', label: '职责路由' },
              { value: 'assets', label: '素材' },
              { value: 'editor', label: '编辑器' },
              { value: 'about', label: '关于' },
            ]}
          />
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        {tab === 'endpoints' && <EndpointsTab />}
        {tab === 'roles' && <RolesTab />}
        {tab === 'assets' && <AssetsSettingsTab />}
        {tab === 'editor' && <EditorSettingsTab />}
        {tab === 'about' && <AboutTab />}
      </div>
    </div>
  );
}

// ───────────── 接入点 ─────────────

function EndpointsTab() {
  const { settings, error } = useSettings();
  const [editing, setEditing] = useState<EndpointView | 'new' | null>(null);

  if (error) return <p className="text-sm text-err">{error}</p>;
  if (!settings) return <Spinner />;

  if (editing) {
    return <EndpointEditor initial={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />;
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">任何 OpenAI 兼容接口都可以接入。API Key 用系统加密保存，不会写进设置文件和日志。</p>
        <Button variant="primary" onClick={() => setEditing('new')} data-testid="add-endpoint">
          ＋ 添加接入点
        </Button>
      </div>
      {settings.endpoints.length === 0 ? (
        <Empty title="还没有接入点">先添加一个，比如 DeepSeek、通义千问，或者本地运行的 Ollama。</Empty>
      ) : (
        settings.endpoints.map((ep) => <EndpointCard key={ep.id} endpoint={ep} onEdit={() => setEditing(ep)} />)
      )}
    </div>
  );
}

function CapabilityBadges({ caps }: { caps: Capabilities | undefined }) {
  if (!caps) return <Badge>未探测</Badge>;
  const items: [string, boolean][] = [
    ['流式', caps.streaming],
    ['用量', caps.streamUsage],
    ['JSON Schema', caps.jsonSchema],
    ['JSON', caps.jsonObject],
    ['工具调用', caps.tools],
  ];
  return (
    <div className="flex flex-wrap gap-1">
      {items.map(([label, ok]) => (
        <Badge key={label} tone={ok ? 'ok' : 'neutral'} title={ok ? '支持' : '不支持'}>
          {ok ? '✓' : '✕'} {label}
        </Badge>
      ))}
    </div>
  );
}

function EndpointCard({ endpoint, onEdit }: { endpoint: EndpointView; onEdit: () => void }) {
  const { refresh } = useSettings();
  const toast = useToast();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [probing, setProbing] = useState<{ model: string; steps: ProbeChunk[]; ctrl: AbortController } | null>(null);

  const runProbe = async (model: string) => {
    const ctrl = new AbortController();
    setProbing({ model, steps: [], ctrl });
    try {
      await engine.stream(
        'probe',
        { endpointId: endpoint.id, model },
        (chunk) => setProbing((p) => (p ? { ...p, steps: [...p.steps, chunk] } : p)),
        ctrl.signal,
      );
      toast('ok', `${model} 能力探测完成`);
      await refresh();
    } catch (err) {
      if (!isAborted(err)) toast('err', `探测失败：${errorMessage(err)}`);
    } finally {
      setProbing(null);
    }
  };

  const remove = async () => {
    try {
      await engine.call('deleteEndpoint', { id: endpoint.id });
      await refresh();
      toast('ok', `已删除「${endpoint.name}」`);
    } catch (err) {
      toast('err', errorMessage(err));
    }
  };

  return (
    <Card className="overflow-hidden" >
      <div className="flex items-start justify-between gap-4 px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium">{endpoint.name}</span>
            {endpoint.hasKey ? <Badge tone="ok">已保存密钥</Badge> : <Badge>未设置密钥</Badge>}
            <Badge>{endpoint.currency === 'CNY' ? '人民币计价' : '美元计价'}</Badge>
          </div>
          <div className="mt-1 truncate font-mono text-xs text-muted">{endpoint.baseURL}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="ghost" onClick={onEdit}>
            编辑
          </Button>
          {confirmDelete ? (
            <>
              <Button size="sm" variant="danger" onClick={remove}>
                确认删除
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                取消
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>
              删除
            </Button>
          )}
        </div>
      </div>
      <div className="border-t border-line">
        {endpoint.models.length === 0 && (
          <div className="px-5 py-3 text-xs text-muted">还没有模型。点「编辑」添加或从服务拉取模型列表。</div>
        )}
        {endpoint.models.map((model) => {
          const caps = endpoint.capabilities[model];
          const active = probing?.model === model;
          return (
            <div key={model} className="border-b border-line/60 px-5 py-3 last:border-b-0">
              <div className="flex items-center gap-3">
                <div className="w-56 shrink-0 truncate font-mono text-[13px]" title={model}>
                  {model}
                  {endpoint.defaultModel === model && <span className="ml-2 text-xs text-faint">默认</span>}
                </div>
                <div className="min-w-0 flex-1">
                  <CapabilityBadges caps={caps} />
                </div>
                {active ? (
                  <Button size="sm" variant="ghost" onClick={() => probing?.ctrl.abort()}>
                    停止
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => runProbe(model)} disabled={!!probing} data-testid={`probe-${model}`}>
                    {caps ? '重新探测' : '能力探测'}
                  </Button>
                )}
              </div>
              {active && <ProbeProgress steps={probing.steps} />}
              {!active && caps && caps.notes.length > 0 && (
                <ul className="mt-2 space-y-0.5 text-xs text-muted">
                  {caps.notes.map((n) => (
                    <li key={n}>· {n}</li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function ProbeProgress({ steps }: { steps: ProbeChunk[] }) {
  const order = Object.keys(PROBE_STEP_LABELS) as ProbeStep[];
  return (
    <div className="mt-3 grid grid-cols-5 gap-2">
      {order.map((step) => {
        const done = steps.find((s) => s.step === step);
        const running = !done && steps.length === order.indexOf(step);
        return (
          <div
            key={step}
            className={cx(
              'flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-xs',
              done ? (done.ok ? 'border-ok/30 text-ok' : 'border-line text-faint') : 'border-line text-muted',
            )}
          >
            {running ? <Spinner className="size-3" /> : done ? (done.ok ? '✓' : '✕') : '·'}
            <span className="truncate">{PROBE_STEP_LABELS[step]}</span>
          </div>
        );
      })}
    </div>
  );
}

interface PriceDraft {
  input: string;
  output: string;
  cachedInput: string;
}

function EndpointEditor({ initial, onClose }: { initial: EndpointView | null; onClose: () => void }) {
  const { refresh } = useSettings();
  const toast = useToast();
  const [name, setName] = useState(initial?.name ?? '');
  const [baseURL, setBaseURL] = useState(initial?.baseURL ?? '');
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [currency, setCurrency] = useState<'USD' | 'CNY'>(initial?.currency ?? 'CNY');
  const [models, setModels] = useState<string[]>(initial?.models ?? []);
  const [defaultModel, setDefaultModel] = useState(initial?.defaultModel ?? '');
  const [modelInput, setModelInput] = useState('');
  const [remoteModels, setRemoteModels] = useState<string[] | null>(null);
  const [remoteFilter, setRemoteFilter] = useState('');
  const [fetching, setFetching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [prices, setPrices] = useState<Record<string, PriceDraft>>(() => {
    const out: Record<string, PriceDraft> = {};
    for (const [m, p] of Object.entries(initial?.pricing ?? {})) {
      out[m] = { input: String(p.input), output: String(p.output), cachedInput: p.cachedInput === undefined ? '' : String(p.cachedInput) };
    }
    return out;
  });

  const applyPreset = (id: string) => {
    const p = ENDPOINT_PRESETS.find((x) => x.id === id);
    if (!p) return;
    setName(p.name);
    setBaseURL(p.baseURL);
    setCurrency(p.currency);
  };

  const addModel = (m: string) => {
    const v = m.trim();
    if (!v || models.includes(v)) return;
    setModels((list) => [...list, v]);
    if (!defaultModel) setDefaultModel(v);
  };

  const removeModel = (m: string) => {
    setModels((list) => list.filter((x) => x !== m));
    if (defaultModel === m) setDefaultModel('');
  };

  const fetchModels = async () => {
    setFetching(true);
    try {
      const list = await engine.call('fetchModels', {
        endpointId: initial?.id,
        baseURL: baseURL || undefined,
        apiKey: apiKey || undefined,
      });
      setRemoteModels(list);
      if (list.length === 0) toast('info', '服务没有返回任何模型，可以手动填写');
    } catch (err) {
      toast('err', `拉取失败：${errorMessage(err)}`);
    } finally {
      setFetching(false);
    }
  };

  const filteredRemote = useMemo(
    () => (remoteModels ?? []).filter((m) => !models.includes(m) && m.toLowerCase().includes(remoteFilter.toLowerCase())),
    [remoteModels, models, remoteFilter],
  );

  const save = async () => {
    if (!name.trim() || !baseURL.trim()) {
      toast('err', '名称和 Base URL 必填');
      return;
    }
    const pricing: Record<string, { input: number; output: number; cachedInput?: number }> = {};
    for (const m of models) {
      const p = prices[m];
      if (!p || (p.input === '' && p.output === '')) continue;
      const input = Number(p.input || 0);
      const output = Number(p.output || 0);
      if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) {
        toast('err', `「${m}」的价格不是有效数字`);
        return;
      }
      pricing[m] = { input, output, ...(p.cachedInput !== '' ? { cachedInput: Number(p.cachedInput) } : {}) };
    }
    setSaving(true);
    try {
      await engine.call('saveEndpoint', {
        id: initial?.id,
        name,
        baseURL,
        models,
        defaultModel: defaultModel || undefined,
        currency,
        pricing,
        apiKey: clearKey ? null : apiKey || undefined,
      });
      await refresh();
      toast('ok', `已保存「${name}」`);
      onClose();
    } catch (err) {
      toast('err', `保存失败：${errorMessage(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const symbol = currency === 'CNY' ? '¥' : '$';

  return (
    <div className="mx-auto max-w-3xl space-y-5" data-testid="endpoint-editor">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">{initial ? `编辑「${initial.name}」` : '添加接入点'}</h2>
        <Button variant="ghost" size="sm" onClick={onClose}>
          返回
        </Button>
      </div>

      <Card className="space-y-4 p-5">
        {!initial && (
          <Field label="从预设快速填写">
            <Select defaultValue="" onChange={(e) => applyPreset(e.target.value)} data-testid="preset">
              <option value="" disabled>
                选择一个服务…
              </option>
              {ENDPOINT_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <div className="grid grid-cols-2 gap-4">
          <Field label="名称">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：DeepSeek" name="name" />
          </Field>
          <Field label="计价货币">
            <Select value={currency} onChange={(e) => setCurrency(e.target.value as 'USD' | 'CNY')}>
              <option value="CNY">人民币（¥）</option>
              <option value="USD">美元（$）</option>
            </Select>
          </Field>
        </div>
        <Field label="Base URL" hint="通常以 /v1 结尾，例如 https://api.deepseek.com/v1">
          <Input
            value={baseURL}
            onChange={(e) => setBaseURL(e.target.value)}
            placeholder="https://…/v1"
            className="font-mono"
            name="baseURL"
          />
        </Field>
        <Field
          label="API Key"
          hint={initial?.hasKey ? '已保存密钥。留空表示不修改。' : '本地服务（Ollama、LM Studio）可以留空。'}
        >
          <div className="flex gap-2">
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                setClearKey(false);
              }}
              placeholder={initial?.hasKey ? '••••••••（已保存）' : 'sk-…'}
              className="font-mono"
              name="apiKey"
              autoComplete="off"
            />
            {initial?.hasKey && (
              <Button variant={clearKey ? 'danger' : 'ghost'} onClick={() => setClearKey((v) => !v)}>
                {clearKey ? '将删除密钥' : '删除密钥'}
              </Button>
            )}
          </div>
        </Field>
      </Card>

      <Card className="space-y-4 p-5">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium">模型</div>
            <div className="text-xs text-muted">手动填写模型名，或从服务拉取列表。</div>
          </div>
          <Button size="sm" onClick={fetchModels} loading={fetching} disabled={!baseURL} data-testid="fetch-models">
            从服务拉取
          </Button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {models.map((m) => (
            <span key={m} className="inline-flex items-center gap-1 rounded-md bg-panel-3 py-1 pr-1 pl-2 font-mono text-xs">
              {m}
              <button type="button" className="rounded px-1 text-faint hover:text-err" onClick={() => removeModel(m)} aria-label={`移除 ${m}`}>
                ×
              </button>
            </span>
          ))}
          <Input
            value={modelInput}
            onChange={(e) => setModelInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addModel(modelInput);
                setModelInput('');
              }
            }}
            placeholder="输入模型名后回车"
            className="h-7 w-56 font-mono text-xs"
            name="modelInput"
          />
        </div>
        {remoteModels && remoteModels.length > 0 && (
          <div className="rounded-lg border border-line bg-bg p-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-xs text-muted">服务上的模型（{remoteModels.length}），点击添加：</span>
              <Input
                value={remoteFilter}
                onChange={(e) => setRemoteFilter(e.target.value)}
                placeholder="筛选"
                className="ml-auto h-7 w-40 text-xs"
              />
            </div>
            <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
              {filteredRemote.slice(0, 200).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => addModel(m)}
                  className="rounded-md border border-line px-2 py-1 font-mono text-xs text-muted hover:border-accent hover:text-fg"
                >
                  ＋ {m}
                </button>
              ))}
              {filteredRemote.length === 0 && <span className="text-xs text-faint">没有更多可添加的模型</span>}
            </div>
          </div>
        )}
        {models.length > 0 && (
          <Field label="默认模型">
            <Select value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)}>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </Card>

      {models.length > 0 && (
        <Card className="p-5">
          <div className="text-sm font-medium">价格</div>
          <div className="mb-3 text-xs text-muted">单位：{symbol} / 百万 token。用来计算每次调用的花费，留空则不计费。</div>
          <div className="grid grid-cols-[1fr_7rem_7rem_7rem] items-center gap-2 text-xs">
            <span className="text-faint">模型</span>
            <span className="text-faint">输入</span>
            <span className="text-faint">输出</span>
            <span className="text-faint">缓存命中输入</span>
            {models.map((m) => {
              const p = prices[m] ?? { input: '', output: '', cachedInput: '' };
              const set = (k: keyof PriceDraft, v: string) => setPrices((all) => ({ ...all, [m]: { ...p, [k]: v } }));
              return (
                <PriceRow key={m} model={m} price={p} onChange={set} />
              );
            })}
          </div>
        </Card>
      )}

      <div className="flex justify-end gap-2 pb-6">
        <Button variant="ghost" onClick={onClose}>
          取消
        </Button>
        <Button variant="primary" onClick={save} loading={saving} data-testid="save-endpoint">
          保存
        </Button>
      </div>
    </div>
  );
}

function PriceRow({
  model,
  price,
  onChange,
}: {
  model: string;
  price: PriceDraft;
  onChange: (k: keyof PriceDraft, v: string) => void;
}) {
  return (
    <>
      <span className="truncate font-mono text-[13px]" title={model}>
        {model}
      </span>
      <Input inputMode="decimal" value={price.input} onChange={(e) => onChange('input', e.target.value)} placeholder="0" className="h-8" />
      <Input inputMode="decimal" value={price.output} onChange={(e) => onChange('output', e.target.value)} placeholder="0" className="h-8" />
      <Input
        inputMode="decimal"
        value={price.cachedInput}
        onChange={(e) => onChange('cachedInput', e.target.value)}
        placeholder="同输入"
        className="h-8"
      />
    </>
  );
}

// ───────────── 职责路由 ─────────────

function RolesTab() {
  const { settings } = useSettings();
  if (!settings) return <Spinner />;
  if (settings.endpoints.length === 0) {
    return <Empty title="先添加一个模型接入点">职责路由决定引擎里的导演、演员、旁白等各自用哪个模型。</Empty>;
  }
  return (
    <div className="mx-auto max-w-4xl space-y-3">
      <p className="text-sm text-muted">
        每个职责可以用不同的模型：比如导演用最强的模型保证剧情质量，演员用便宜的模型控制成本。没有单独设置的职责使用「默认」。
      </p>
      {ROLE_IDS.map((role) => (
        <RoleRow key={role} role={role} />
      ))}
      <h3 className="pt-4 text-sm font-medium text-muted">素材</h3>
      <MediaRoleRow role="image" />
      <MediaRoleRow role="cutout" />
      <MediaRoleRow role="music" />
      <MediaRoleRow role="voice" />
    </div>
  );
}

/** 接口类型的名字（同一种接口类型在不同职责上是不同的地址）。 */
function apiLabel(role: MediaRoleId, api: MediaRoute['api']): string {
  if (api === 'custom') return '自定义';
  if (api === 'rembg') return 'rembg（/api/remove）';
  if (api === 'minimax') return role === 'voice' ? 'MiniMax（/t2a_v2）' : 'MiniMax（/music_generation）';
  if (api === 'comfyui') return 'ComfyUI';
  return role === 'voice' ? 'OpenAI 风格（/audio/speech）' : 'OpenAI 风格';
}

const MODEL_PLACEHOLDER: Record<MediaRoleId, string> = {
  image: '图像模型名，例如 MiniMax-H3-Image',
  cutout: '模型（可以不填），例如 isnet-anime',
  music: '音乐模型名，例如 music-2.6',
  voice: '语音模型名，例如 speech-2.6-hd',
};

/** 音色表写成文字：一行一个，id｜名字｜描述。 */
const voicesToText = (voices: VoiceDef[] | undefined) => (voices ?? []).map((v) => [v.id, v.name, v.description].join('｜')).join('\n');
const textToVoices = (text: string): VoiceDef[] =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [id = '', name = '', ...rest] = l.split(/[｜|]/).map((x) => x.trim());
      return { id, name, description: rest.join('｜') };
    });

/** 媒体职责的一行：图像（背景、立绘）、抠图（立绘的透明背景选了「抠图服务」时用）、音乐（BGM 的音乐模型来源）。 */
function MediaRoleRow({ role }: { role: MediaRoleId }) {
  const { settings, refresh } = useSettings();
  const toast = useToast();
  const current = settings?.media[role];
  const isImage = role === 'image';
  const isMusic = role === 'music';
  const isVoice = role === 'voice';
  const apis = MEDIA_ROLE_APIS[role];
  const savedApi = current && apis.includes(current.api) ? current.api : (apis[0] ?? 'openai');
  const [endpointId, setEndpointId] = useState(current?.endpointId ?? '');
  const [model, setModel] = useState(current?.model ?? '');
  const [api, setApi] = useState<MediaRoute['api']>(savedApi);
  const [custom, setCustom] = useState<CustomApi | null>(current?.custom ?? null);
  const [comfy, setComfy] = useState<ComfySettings | null>(current?.comfy ?? null);
  const [comfyModels, setComfyModels] = useState<string[]>([]);
  const [showTemplate, setShowTemplate] = useState(false);
  const savedVoices = voicesToText(current?.voices);
  const [voicesText, setVoicesText] = useState(savedVoices);
  const [showVoices, setShowVoices] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ dataUrl: string; latencyMs: number; revisedPrompt: string | null; durationMs?: number | null } | null>(
    null,
  );
  const savedCustom = JSON.stringify(current?.custom ?? null);
  const savedComfy = JSON.stringify(current?.comfy ?? null);
  useEffect(() => {
    setEndpointId(current?.endpointId ?? '');
    setModel(current?.model ?? '');
    setApi(savedApi);
    setCustom(savedCustom === 'null' ? null : (JSON.parse(savedCustom) as CustomApi));
    setComfy(savedComfy === 'null' ? null : (JSON.parse(savedComfy) as ComfySettings));
    setVoicesText(savedVoices);
  }, [current?.endpointId, current?.model, savedApi, savedCustom, savedComfy, savedVoices]);
  const endpoint = settings?.endpoints.find((e) => e.id === endpointId);
  const isCustom = api === 'custom';
  const isComfy = api === 'comfyui';
  // 自定义接口的模板、ComfyUI 的工作流里不用 {{model}} 时模型可以不填
  const needsModel = (isImage || isMusic || isVoice) && !isCustom && !(isComfy && comfy && !comfyUsesModel(comfy));
  const dirty =
    endpointId !== (current?.endpointId ?? '') ||
    model !== (current?.model ?? '') ||
    api !== savedApi ||
    (isCustom && JSON.stringify(custom) !== savedCustom) ||
    (isComfy && JSON.stringify(comfy) !== savedComfy) ||
    (isVoice && voicesText.trim() !== savedVoices.trim());
  const voices = isVoice ? textToVoices(voicesText) : [];
  const route = (): MediaRoute => ({
    endpointId,
    model: model.trim(),
    api,
    ...(custom ? { custom } : {}),
    ...(comfy ? { comfy } : {}),
    ...(voices.length ? { voices } : {}),
  });
  /** 从 ComfyUI 读模型列表（checkpoint 文件名），填进模型的下拉提示；还没填模型时填第一个。 */
  const readComfyModels = async () => {
    if (!endpointId) return;
    setFetching(true);
    try {
      const list = await engine.call('comfyModels', { route: route() });
      setComfyModels(list);
      if (!model.trim() && list[0]) setModel(list[0]);
      toast('ok', list.length ? `ComfyUI 上有 ${list.length} 个模型` : 'ComfyUI 上没有模型（models/checkpoints 是空的）');
    } catch (err) {
      toast('err', errorMessage(err));
    } finally {
      setFetching(false);
    }
  };
  /** 从服务拉取音色表（MiniMax）或者填入 OpenAI 的那一套。 */
  const fetchVoices = async () => {
    if (!endpointId) return;
    setFetching(true);
    try {
      const list = await engine.call('fetchVoices', { route: route() });
      setVoicesText(voicesToText(list));
      setShowVoices(true);
      toast('ok', `拿到 ${list.length} 个音色，保存后生效`);
    } catch (err) {
      toast('err', errorMessage(err));
    } finally {
      setFetching(false);
    }
  };
  const pickApi = (next: MediaRoute['api']) => {
    setApi(next);
    if (next === 'custom') {
      if (!custom) setCustom(defaultCustomApi(role));
      setShowTemplate(true);
    }
    if (next === 'comfyui' && !comfy) setComfy(ComfySettings.parse({}));
  };

  const label = MEDIA_ROLE_LABELS[role];
  const save = async (clear = false) => {
    if (!clear && (!endpointId || (needsModel && !model.trim()))) {
      toast(
        'err',
        isImage ? '请选择接入点并填写图像模型' : isMusic ? '请选择接入点并填写音乐模型' : isVoice ? '请选择接入点并填写语音模型' : '请选择抠图服务的接入点',
      );
      return;
    }
    setSaving(true);
    try {
      await engine.call('setMediaRole', { role, route: clear ? null : route() });
      await refresh();
      toast(
        'ok',
        clear
          ? `已清除「${label.name}」`
          : isImage
            ? '已保存「图像」，打开着的世界会开始画背景和立绘'
            : isMusic
              ? '已保存「音乐」，打开着的世界会给还没有曲子的情绪生成 BGM'
              : isVoice
                ? '已保存「语音」，玩的时候角色的台词会配上声音'
                : `已保存「${label.name}」`,
      );
    } catch (err) {
      toast('err', errorMessage(err));
    } finally {
      setSaving(false);
    }
  };
  const runTest = async () => {
    if (!endpointId || (needsModel && !model.trim())) return;
    setTesting(true);
    setTest(null);
    try {
      if (isMusic) {
        const r = await engine.call('testMusic', { route: route() });
        setTest({ ...r, revisedPrompt: null });
      } else if (isVoice) {
        const r = await engine.call('testVoice', { route: route() });
        setTest({ ...r, revisedPrompt: null });
      } else if (isImage) {
        setTest(await engine.call('testImage', { route: route() }));
      } else {
        const r = await engine.call('testCutout', { route: route() });
        setTest({ ...r, revisedPrompt: null });
      }
    } catch (err) {
      toast('err', errorMessage(err));
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card className="px-5 py-3.5" data-testid={`role-${role}`}>
      {/* 按钮多（ComfyUI）放不下时按钮换到下一行，模型框不至于挤没了 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="w-44 shrink-0">
          <div className="flex items-center gap-2 text-sm font-medium">
            {label.name}
            {!current && (
              <span className="text-xs font-normal text-faint">
                {isImage ? '未设置，用占位图' : isMusic ? '未设置，不生成' : isVoice ? '未设置，不配音' : '未设置'}
              </span>
            )}
          </div>
          <div className="mt-0.5 text-xs leading-snug text-muted">{label.hint}</div>
        </div>
        <Select
          value={endpointId}
          onChange={(e) => setEndpointId(e.target.value)}
          className="w-44"
          data-testid={`role-endpoint-${role}`}
        >
          <option value="">未设置</option>
          {settings?.endpoints.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </Select>
        <Input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder={isComfy ? 'checkpoint 的文件名，可以点「读取模型」' : MODEL_PLACEHOLDER[role]}
          list={`${role}-models`}
          className="min-w-24 flex-1 font-mono text-xs"
          disabled={!endpointId}
          data-testid={`role-model-${role}`}
        />
        <datalist id={`${role}-models`}>
          {(isComfy ? comfyModels : (endpoint?.models ?? [])).map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        <Select
          value={api}
          onChange={(e) => pickApi(e.target.value as MediaRoute['api'])}
          className="w-36"
          title="接口类型"
          data-testid={`role-api-${role}`}
        >
          {apis.map((a) => (
            <option key={a} value={a}>
              {apiLabel(role, a)}
            </option>
          ))}
        </Select>
        <div className="ml-auto flex min-w-44 shrink-0 justify-end gap-1">
          {isCustom && (
            <Button size="sm" variant="ghost" onClick={() => setShowTemplate((v) => !v)} data-testid={`role-template-${role}`}>
              {showTemplate ? '收起' : '模板'}
            </Button>
          )}
          {isComfy && (
            <>
              <Button size="sm" variant="ghost" loading={fetching} disabled={!endpointId} onClick={() => void readComfyModels()} title="从 ComfyUI 读能用的模型" data-testid="role-comfy-models">
                读取模型
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowTemplate((v) => !v)} data-testid="role-comfy-workflows">
                {showTemplate ? '收起' : '工作流'}
              </Button>
            </>
          )}
          {isVoice && (
            <Button size="sm" variant="ghost" onClick={() => setShowVoices((v) => !v)} data-testid="role-voices-toggle">
              音色
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={!endpointId || (needsModel && !model.trim())}
            loading={testing}
            onClick={() => void runTest()}
            title={
              isMusic ? '生成一首试试，会花一首曲子的额度' : isImage ? '画一张小图试试，会花一张图的额度' : isVoice ? '用音色表里的第一个音色念一句' : '抠一张示例图试试'
            }
            data-testid={`role-test-${role}`}
          >
            测试
          </Button>
          {dirty ? (
            <Button size="sm" variant="primary" onClick={() => void save()} loading={saving} data-testid={`role-save-${role}`}>
              保存
            </Button>
          ) : current ? (
            <Button size="sm" variant="ghost" onClick={() => void save(true)} loading={saving}>
              清除
            </Button>
          ) : null}
        </div>
      </div>
      {isCustom && showTemplate && custom && <CustomApiEditor role={role} value={custom} onChange={setCustom} />}
      {isComfy && showTemplate && comfy && <ComfyEditor value={comfy} onChange={setComfy} />}
      {isVoice && showVoices && (
        <div className="mt-3 space-y-2 border-t border-line pt-3" data-testid="role-voices">
          <div className="flex items-center justify-between gap-3 text-xs text-muted">
            <span>
              音色表：一行一个，写成「音色 id｜名字｜描述」。描述里写清性别、年龄和声音特点，分配音色时按它挑。空着的话，OpenAI 风格用它固定的一套，MiniMax
              自动从服务拉取，自定义接口一定要写。
            </span>
            {api !== 'custom' && (
              <Button size="sm" variant="ghost" loading={fetching} disabled={!endpointId} onClick={() => void fetchVoices()} data-testid="role-voices-fetch">
                {api === 'openai' ? '填入 OpenAI 的音色' : '从服务拉取'}
              </Button>
            )}
          </div>
          <Textarea
            rows={8}
            value={voicesText}
            onChange={(e) => setVoicesText(e.target.value)}
            placeholder={'female-shaonv｜少女｜女声，少女，清亮\nmale-qn-jingying｜精英青年｜男声，青年，干练'}
            className="font-mono text-xs"
            spellCheck={false}
            data-testid="role-voices-text"
          />
          <div className="text-xs text-faint">{voices.length ? `${voices.length} 个音色` : '空着'}</div>
        </div>
      )}
      {test && (
        <div className="mt-3 flex items-start gap-3 border-t border-line pt-3 text-xs text-muted">
          {isMusic || isVoice ? (
            <audio src={test.dataUrl} controls className="h-9" data-testid="role-test-audio" />
          ) : (
            <img
              src={test.dataUrl}
              alt="测试图"
              className={cx('size-24 rounded object-cover', !isImage && 'bg-[repeating-conic-gradient(#8884_0_25%,transparent_0_50%)] bg-[length:16px_16px]')}
              data-testid={`role-test-image-${role}`}
            />
          )}
          <div className="space-y-1">
            <div>
              {isMusic || isVoice ? '生成好了' : isImage ? '画好了' : '抠好了'}，用了 {formatMsShort(test.latencyMs)}
              {test.durationMs ? `，${isVoice ? '长' : '曲子长'} ${(test.durationMs / 1000).toFixed(isVoice ? 1 : 0)} 秒` : ''}。
            </div>
            {test.revisedPrompt && <div className="text-faint">服务端改写后的提示词：{test.revisedPrompt}</div>}
          </div>
        </div>
      )}
    </Card>
  );
}

const formatMsShort = (ms: number) => (ms < 1000 ? `${ms} 毫秒` : `${(ms / 1000).toFixed(1)} 秒`);

/** 素材管线的全局设置（18.11）。 */
function AssetsSettingsTab() {
  const { settings, refresh } = useSettings();
  const toast = useToast();
  if (!settings) return <Spinner />;
  const save = async (v: unknown) => {
    await engine.call('saveAssetSettings', { settings: v as AssetSettings });
    await refresh();
    toast('ok', '已保存素材设置');
  };
  return (
    <div className="mx-auto max-w-4xl space-y-3">
      <p className="text-sm text-muted">
        背景、立绘、BGM、语音的默认做法。每个世界的素材页里还可以单独改（只改和这里不一样的项）。图像模型在「职责路由」里配。
      </p>
      <Card className="p-5" data-testid="asset-settings-global">
        <AssetSettingsForm mode="global" global={settings.assets} value={settings.assets} onSave={save} />
      </Card>
    </div>
  );
}

// ───────────── 编辑器（20.11） ─────────────

const EDITOR_DEFAULTS: EditorSettings = { autoLock: true, historyLimit: 20, downstream: 'prompt', rename: 'ask' };

function EditorSettingsTab() {
  const { settings, refresh } = useSettings();
  const toast = useToast();
  const [draft, setDraft] = useState<EditorSettings | null>(null);
  useEffect(() => {
    if (settings) setDraft(settings.editor);
  }, [settings]);
  if (!settings || !draft) return <Spinner />;
  const save = async (v: EditorSettings) => {
    try {
      await engine.call('saveEditorSettings', { settings: v });
      await refresh();
      toast('ok', '已保存编辑器设置');
    } catch (err) {
      toast('err', errorMessage(err));
    }
  };
  const changed = JSON.stringify(draft) !== JSON.stringify(settings.editor);
  return (
    <div className="mx-auto max-w-4xl space-y-3">
      <p className="text-sm text-muted">在世界页里改世界的内容时的做法。</p>
      <Card className="space-y-5 p-5" data-testid="editor-settings">
        <div className="flex items-start justify-between gap-6">
          <div>
            <div className="text-sm font-medium">手改的字段自动锁住</div>
            <p className="mt-1 text-xs leading-relaxed text-faint">
              改过的字段旁边出现一把锁，之后重抽这一步或者这个角色时不会被冲掉。关掉以后要锁哪个自己点。
            </p>
          </div>
          <label className="flex h-9 shrink-0 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.autoLock}
              onChange={(e) => setDraft({ ...draft, autoLock: e.target.checked })}
              data-testid="editor-autolock"
            />
            自动锁住
          </label>
        </div>
        <div className="flex items-start justify-between gap-6">
          <div>
            <div className="text-sm font-medium">每个文件留几个历史版本</div>
            <p className="mt-1 text-xs leading-relaxed text-faint">保存、重新生成、删除之前把原来的存一份，可以对照、退回去。0 不留。</p>
          </div>
          <Input
            type="number"
            min={0}
            max={200}
            className="w-24 shrink-0"
            value={draft.historyLimit}
            onChange={(e) => setDraft({ ...draft, historyLimit: Math.max(0, Math.min(200, Math.round(Number(e.target.value) || 0))) })}
            data-testid="editor-history-limit"
          />
        </div>
        <div className="flex items-start justify-between gap-6">
          <div>
            <div className="text-sm font-medium">上游改了以后</div>
            <p className="mt-1 text-xs leading-relaxed text-faint">
              比如改了角色，剧情图、设定集、开场还是按改之前写的。提示：世界页顶上说一声，点了才重写；自动：马上重写这几步（锁住的保留，会用掉额度）；不管：只在创世步骤里标"过期"。
            </p>
          </div>
          <Select
            className="w-32 shrink-0"
            value={draft.downstream}
            onChange={(e) => setDraft({ ...draft, downstream: e.target.value as EditorSettings['downstream'] })}
            data-testid="editor-downstream"
          >
            <option value="prompt">提示</option>
            <option value="auto">自动重写</option>
            <option value="ignore">不管</option>
          </Select>
        </div>
        <div className="flex items-start justify-between gap-6">
          <div>
            <div className="text-sm font-medium">改名时替换正文里的旧名字</div>
            <p className="mt-1 text-xs leading-relaxed text-faint">
              角色、地点改了名字，世界观、别的角色的经历、剧情图、开场里还写着旧名字。问：列出来让你勾；总是：全部换掉；从不：不换（引用不会断，只是文字里还是旧名字）。
            </p>
          </div>
          <Select
            className="w-32 shrink-0"
            value={draft.rename}
            onChange={(e) => setDraft({ ...draft, rename: e.target.value as EditorSettings['rename'] })}
            data-testid="editor-rename"
          >
            <option value="ask">问我</option>
            <option value="always">总是替换</option>
            <option value="never">从不替换</option>
          </Select>
        </div>
        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button variant="ghost" onClick={() => setDraft(EDITOR_DEFAULTS)} disabled={JSON.stringify(draft) === JSON.stringify(EDITOR_DEFAULTS)}>
            恢复默认
          </Button>
          <Button variant="primary" disabled={!changed} onClick={() => void save(draft)} data-testid="editor-settings-save">
            保存
          </Button>
        </div>
      </Card>
    </div>
  );
}

function RoleRow({ role }: { role: RoleId }) {
  const { settings, refresh } = useSettings();
  const toast = useToast();
  const current = settings?.roles[role];
  const [endpointId, setEndpointId] = useState(current?.endpointId ?? '');
  const [model, setModel] = useState(current?.model ?? '');
  const [temperature, setTemperature] = useState(current?.temperature?.toString() ?? '');
  const [maxTokens, setMaxTokens] = useState(current?.maxTokens?.toString() ?? '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setEndpointId(current?.endpointId ?? '');
    setModel(current?.model ?? '');
    setTemperature(current?.temperature?.toString() ?? '');
    setMaxTokens(current?.maxTokens?.toString() ?? '');
  }, [current?.endpointId, current?.model, current?.temperature, current?.maxTokens]);

  const endpoint = settings?.endpoints.find((e) => e.id === endpointId);
  const dirty =
    endpointId !== (current?.endpointId ?? '') ||
    model !== (current?.model ?? '') ||
    temperature !== (current?.temperature?.toString() ?? '') ||
    maxTokens !== (current?.maxTokens?.toString() ?? '');

  const save = async (clear = false) => {
    let route: RoleRoute | null = null;
    if (!clear) {
      if (!endpointId || !model) {
        toast('err', '请选择接入点和模型');
        return;
      }
      route = { endpointId, model };
      if (temperature !== '') {
        const t = Number(temperature);
        if (!Number.isFinite(t) || t < 0 || t > 2) {
          toast('err', '温度需要是 0 到 2 之间的数字');
          return;
        }
        route.temperature = t;
      }
      if (maxTokens !== '') {
        const n = Number(maxTokens);
        if (!Number.isInteger(n) || n <= 0) {
          toast('err', '输出上限需要是正整数');
          return;
        }
        route.maxTokens = n;
      }
    }
    setSaving(true);
    try {
      await engine.call('setRole', { role, route });
      await refresh();
      toast('ok', clear ? `已清除「${ROLE_LABELS[role].name}」` : `已保存「${ROLE_LABELS[role].name}」`);
    } catch (err) {
      toast('err', errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const label = ROLE_LABELS[role];
  return (
    <Card className="flex items-center gap-4 px-5 py-3.5" >
      <div className="w-44 shrink-0">
        <div className="flex items-center gap-2 text-sm font-medium">
          {label.name}
          {!current && role !== 'default' && <span className="text-xs font-normal text-faint">用默认</span>}
        </div>
        <div className="mt-0.5 text-xs leading-snug text-muted">{label.hint}</div>
      </div>
      <Select
        value={endpointId}
        onChange={(e) => {
          setEndpointId(e.target.value);
          const ep = settings?.endpoints.find((x) => x.id === e.target.value);
          setModel(ep?.defaultModel ?? ep?.models[0] ?? '');
        }}
        className="w-44"
        data-testid={`role-endpoint-${role}`}
      >
        <option value="">未设置</option>
        {settings?.endpoints.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name}
          </option>
        ))}
      </Select>
      {endpoint && endpoint.models.length > 0 ? (
        <Select value={model} onChange={(e) => setModel(e.target.value)} className="min-w-0 flex-1 font-mono text-xs">
          {endpoint.models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </Select>
      ) : (
        <Input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="模型名"
          className="min-w-0 flex-1 font-mono text-xs"
          disabled={!endpointId}
        />
      )}
      <Input
        value={temperature}
        onChange={(e) => setTemperature(e.target.value)}
        placeholder="温度"
        title="temperature，留空用模型默认"
        className="w-16"
        inputMode="decimal"
      />
      <Input
        value={maxTokens}
        onChange={(e) => setMaxTokens(e.target.value)}
        placeholder="上限"
        title="最大输出 token，留空不限制"
        className="w-20"
        inputMode="numeric"
      />
      <div className="flex w-28 justify-end gap-1">
        {dirty ? (
          <Button size="sm" variant="primary" onClick={() => save()} loading={saving} data-testid={`role-save-${role}`}>
            保存
          </Button>
        ) : current ? (
          <Button size="sm" variant="ghost" onClick={() => save(true)} loading={saving}>
            清除
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

// ───────────── 关于 ─────────────

function AboutTab() {
  const { settings } = useSettings();
  const v = window.autoAdv?.versions;
  const rows: [string, string][] = [
    ['数据目录', settings?.dataDir ?? '—'],
    ['密钥保存方式', settings ? (settings.secretsEncrypted ? '系统加密（Windows 上为 DPAPI）' : '明文（当前系统不支持加密）') : '—'],
    ['Electron', v?.electron ?? '—'],
    ['Chromium', v?.chrome ?? '—'],
    ['Node', v?.node ?? '—'],
  ];
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Card className="divide-y divide-line">
        {rows.map(([k, val]) => (
          <div key={k} className="flex gap-4 px-5 py-3 text-sm">
            <span className="w-32 shrink-0 text-muted">{k}</span>
            <span className="min-w-0 font-mono text-[13px] break-all">{val}</span>
          </div>
        ))}
      </Card>
      <BuiltinBgmCard />
    </div>
  );
}

const MOOD_NAMES = new Map(DEFAULT_MOODS.map((m) => [m.id, m.name]));

/** 内置曲库的曲目和授权（18.7）：每首写明乐谱从哪里来、怎么做出来的。 */
function BuiltinBgmCard() {
  const [tracks, setTracks] = useState<BuiltinTrackInfo[] | null>(null);
  useEffect(() => {
    void engine
      .call('builtinBgm')
      .then(setTracks)
      .catch(() => setTracks([]));
  }, []);
  if (!tracks) return null;
  const methods = [...new Set(tracks.map((t) => t.method))];
  return (
    <Card className="px-5 py-4 text-sm" data-testid="about-builtin-bgm">
      <div className="font-medium">内置曲库</div>
      {tracks.length === 0 ? (
        <p className="mt-1 text-muted">这个版本没有带内置曲目。</p>
      ) : (
        <>
          <p className="mt-1 text-muted">
            没配本地曲库和音乐模型时，舞台放这些曲子。作品和乐谱都是公有领域；{methods.length === 1 ? methods[0] : '每首的做法见下面'}。
          </p>
          <ul className="mt-3 divide-y divide-line">
            {tracks.map((t) => (
              <li key={t.file} className="py-2" data-testid="about-builtin-track">
                <div>
                  {t.title}
                  <span className="ml-2 text-muted">{t.composer}</span>
                  <span className="ml-2 text-xs text-muted">· {MOOD_NAMES.get(t.mood) ?? t.mood}</span>
                </div>
                <div className="mt-0.5 text-xs text-muted">
                  {t.license}
                  {methods.length > 1 && <>；{t.method}</>}
                  {/^https?:\/\//.test(t.source) && (
                    <>
                      {' · '}
                      <a href={t.source} target="_blank" rel="noreferrer" className="underline">
                        乐谱
                      </a>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
