import type { EndpointView, ProbeChunk } from '@auto-adv/engine/api';
import { ENDPOINT_PRESETS, PROBE_STEP_LABELS, type ProbeStep } from '@auto-adv/providers';
import { type AssetSettings, type Capabilities, MEDIA_ROLE_LABELS, ROLE_IDS, ROLE_LABELS, type RoleId, type RoleRoute } from '@auto-adv/schema';
import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, cx, Empty, Field, Input, PageHeader, Select, Spinner, Tabs, useToast } from '../components/ui.tsx';
import { engine, errorMessage, isAborted } from '../lib/engine.ts';
import { useSettings } from '../lib/settings.tsx';
import { AssetSettingsForm } from './AssetSettingsForm.tsx';

type Tab = 'endpoints' | 'roles' | 'assets' | 'about';

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
              { value: 'about', label: '关于' },
            ]}
          />
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        {tab === 'endpoints' && <EndpointsTab />}
        {tab === 'roles' && <RolesTab />}
        {tab === 'assets' && <AssetsSettingsTab />}
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
      <ImageRoleRow />
    </div>
  );
}

/** 图像职责：接入点、模型（不会退回「默认」的文本模型）。可以画一张小图试试，会花一张图的额度。 */
function ImageRoleRow() {
  const { settings, refresh } = useSettings();
  const toast = useToast();
  const current = settings?.media.image;
  const [endpointId, setEndpointId] = useState(current?.endpointId ?? '');
  const [model, setModel] = useState(current?.model ?? '');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ dataUrl: string; latencyMs: number; revisedPrompt: string | null } | null>(null);
  useEffect(() => {
    setEndpointId(current?.endpointId ?? '');
    setModel(current?.model ?? '');
  }, [current?.endpointId, current?.model]);
  const endpoint = settings?.endpoints.find((e) => e.id === endpointId);
  const dirty = endpointId !== (current?.endpointId ?? '') || model !== (current?.model ?? '');

  const save = async (clear = false) => {
    if (!clear && (!endpointId || !model.trim())) {
      toast('err', '请选择接入点并填写图像模型');
      return;
    }
    setSaving(true);
    try {
      await engine.call('setMediaRole', { role: 'image', route: clear ? null : { endpointId, model: model.trim(), api: 'openai' } });
      await refresh();
      toast('ok', clear ? '已清除「图像」' : '已保存「图像」，打开着的世界会开始画背景');
    } catch (err) {
      toast('err', errorMessage(err));
    } finally {
      setSaving(false);
    }
  };
  const runTest = async () => {
    if (!endpointId || !model.trim()) return;
    setTesting(true);
    setTest(null);
    try {
      setTest(await engine.call('testImage', { route: { endpointId, model: model.trim(), api: 'openai' } }));
    } catch (err) {
      toast('err', errorMessage(err));
    } finally {
      setTesting(false);
    }
  };

  const label = MEDIA_ROLE_LABELS.image;
  return (
    <Card className="px-5 py-3.5" data-testid="role-image">
      <div className="flex items-center gap-4">
        <div className="w-44 shrink-0">
          <div className="flex items-center gap-2 text-sm font-medium">
            {label.name}
            {!current && <span className="text-xs font-normal text-faint">未设置，用占位图</span>}
          </div>
          <div className="mt-0.5 text-xs leading-snug text-muted">{label.hint}</div>
        </div>
        <Select
          value={endpointId}
          onChange={(e) => setEndpointId(e.target.value)}
          className="w-44"
          data-testid="role-endpoint-image"
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
          placeholder="图像模型名，例如 MiniMax-H3-Image"
          list="image-models"
          className="min-w-0 flex-1 font-mono text-xs"
          disabled={!endpointId}
          data-testid="role-model-image"
        />
        <datalist id="image-models">
          {endpoint?.models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        <Select value="openai" onChange={() => {}} className="w-36" title="接口类型">
          <option value="openai">OpenAI 风格</option>
        </Select>
        <div className="flex w-40 justify-end gap-1">
          <Button size="sm" variant="ghost" disabled={!endpointId || !model.trim()} loading={testing} onClick={() => void runTest()} title="画一张小图试试，会花一张图的额度">
            测试
          </Button>
          {dirty ? (
            <Button size="sm" variant="primary" onClick={() => void save()} loading={saving} data-testid="role-save-image">
              保存
            </Button>
          ) : current ? (
            <Button size="sm" variant="ghost" onClick={() => void save(true)} loading={saving}>
              清除
            </Button>
          ) : null}
        </div>
      </div>
      {test && (
        <div className="mt-3 flex items-start gap-3 border-t border-line pt-3 text-xs text-muted">
          <img src={test.dataUrl} alt="测试图" className="size-24 rounded object-cover" />
          <div className="space-y-1">
            <div>画好了，用了 {formatMsShort(test.latencyMs)}。</div>
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
    <Card className="mx-auto max-w-3xl divide-y divide-line">
      {rows.map(([k, val]) => (
        <div key={k} className="flex gap-4 px-5 py-3 text-sm">
          <span className="w-32 shrink-0 text-muted">{k}</span>
          <span className="min-w-0 font-mono text-[13px] break-all">{val}</span>
        </div>
      ))}
    </Card>
  );
}
