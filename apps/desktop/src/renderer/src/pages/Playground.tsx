import type { ChatTarget, PlaygroundResult } from '@auto-adv/engine/api';
import type { ChatMessage } from '@auto-adv/providers';
import { ROLE_IDS, ROLE_LABELS, type RoleId } from '@auto-adv/schema';
import { useEffect, useRef, useState } from 'react';
import type { PageId } from '../App.tsx';
import { Button, cx, Empty, Field, Input, PageHeader, Select, Spinner, Textarea } from '../components/ui.tsx';
import { engine, errorMessage, isAborted } from '../lib/engine.ts';
import { formatCost, formatMs } from '../lib/format.ts';
import { useSettings } from '../lib/settings.tsx';

interface Turn {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  result?: PlaygroundResult;
  error?: string;
  stopped?: boolean;
  pending?: boolean;
}

let nextId = 1;

export function PlaygroundPage({ onNavigate }: { onNavigate: (p: PageId) => void }) {
  const { settings } = useSettings();
  const [mode, setMode] = useState<'role' | 'endpoint'>('role');
  const [role, setRole] = useState<RoleId>('default');
  const [endpointId, setEndpointId] = useState('');
  const [model, setModel] = useState('');
  const [system, setSystem] = useState('你是一位擅长写视觉小说的作家，文笔细腻，善于描写人物情绪。');
  const [temperature, setTemperature] = useState('0.8');
  const [maxTokens, setMaxTokens] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [ctrl, setCtrl] = useState<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!settings || endpointId) return;
    const first = settings.endpoints[0];
    if (first) {
      setEndpointId(first.id);
      setModel(first.defaultModel ?? first.models[0] ?? '');
    }
  }, [settings, endpointId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns]);

  const endpoint = settings?.endpoints.find((e) => e.id === endpointId);
  const routeFor = (r: RoleId) => settings?.roles[r] ?? settings?.roles.default;
  const route = routeFor(role);
  const routeEndpoint = settings?.endpoints.find((e) => e.id === route?.endpointId);

  const send = async () => {
    const text = input.trim();
    if (!text || ctrl) return;
    const target: ChatTarget = mode === 'role' ? { role } : { endpointId, model };
    const history: ChatMessage[] = [];
    if (system.trim()) history.push({ role: 'system', content: system.trim() });
    for (const t of turns) {
      if (t.error && !t.content) continue;
      history.push({ role: t.role, content: t.content });
    }
    history.push({ role: 'user', content: text });

    const assistantId = nextId++;
    setTurns((ts) => [
      ...ts,
      { id: nextId++, role: 'user', content: text },
      { id: assistantId, role: 'assistant', content: '', reasoning: '', pending: true },
    ]);
    setInput('');
    const c = new AbortController();
    setCtrl(c);
    const patch = (fn: (t: Turn) => Turn) => setTurns((ts) => ts.map((t) => (t.id === assistantId ? fn(t) : t)));
    try {
      const result = await engine.stream(
        'chat',
        {
          target,
          messages: history,
          temperature: temperature === '' ? undefined : Number(temperature),
          maxTokens: maxTokens === '' ? undefined : Number.parseInt(maxTokens, 10),
        },
        (e) => {
          if (e.type === 'text') patch((t) => ({ ...t, content: t.content + e.delta }));
          if (e.type === 'reasoning') patch((t) => ({ ...t, reasoning: (t.reasoning ?? '') + e.delta }));
        },
        c.signal,
      );
      patch((t) => ({ ...t, pending: false, result, content: result.text, reasoning: result.reasoning }));
    } catch (err) {
      if (isAborted(err)) patch((t) => ({ ...t, pending: false, stopped: true }));
      else patch((t) => ({ ...t, pending: false, error: errorMessage(err) }));
    } finally {
      setCtrl(null);
    }
  };

  const noEndpoints = settings && settings.endpoints.length === 0;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="调试台"
        subtitle="直接和模型对话，检查连通性、流式输出、用量与花费"
        actions={
          <Button variant="ghost" size="sm" onClick={() => setTurns([])} disabled={!turns.length || !!ctrl}>
            清空对话
          </Button>
        }
      />
      <div className="flex min-h-0 flex-1">
        <aside className="w-72 shrink-0 space-y-4 overflow-y-auto border-r border-line px-5 py-5">
          <Field label="调用方式">
            <Select value={mode} onChange={(e) => setMode(e.target.value as 'role' | 'endpoint')} data-testid="pg-mode">
              <option value="role">按职责路由</option>
              <option value="endpoint">直接指定模型</option>
            </Select>
          </Field>
          {mode === 'role' ? (
            <Field
              label="职责"
              hint={
                route ? (
                  <span className="font-mono">
                    → {routeEndpoint?.name ?? '?'} / {route.model}
                  </span>
                ) : (
                  <span className="text-warn">还没有配置，到 设置 → 职责路由</span>
                )
              }
            >
              <Select value={role} onChange={(e) => setRole(e.target.value as RoleId)}>
                {ROLE_IDS.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r].name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <>
              <Field label="接入点">
                <Select
                  value={endpointId}
                  onChange={(e) => {
                    setEndpointId(e.target.value);
                    const ep = settings?.endpoints.find((x) => x.id === e.target.value);
                    setModel(ep?.defaultModel ?? ep?.models[0] ?? '');
                  }}
                >
                  {settings?.endpoints.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="模型">
                {endpoint && endpoint.models.length > 0 ? (
                  <Select value={model} onChange={(e) => setModel(e.target.value)} className="font-mono text-xs">
                    {endpoint.models.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input value={model} onChange={(e) => setModel(e.target.value)} className="font-mono text-xs" />
                )}
              </Field>
            </>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="温度">
              <Input value={temperature} onChange={(e) => setTemperature(e.target.value)} inputMode="decimal" placeholder="默认" />
            </Field>
            <Field label="输出上限">
              <Input value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} inputMode="numeric" placeholder="不限" />
            </Field>
          </div>
          <Field label="系统提示词">
            <Textarea value={system} onChange={(e) => setSystem(e.target.value)} rows={7} className="text-[13px]" />
          </Field>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-8 py-6" data-testid="pg-transcript">
            {noEndpoints ? (
              <Empty title="还没有可用的模型">
                <Button size="sm" variant="primary" className="mt-3" onClick={() => onNavigate('settings')}>
                  去添加接入点
                </Button>
              </Empty>
            ) : turns.length === 0 ? (
              <Empty title="说点什么吧">比如：「写一段雨夜里两个人在车站重逢的开场，200 字以内。」</Empty>
            ) : (
              <div className="mx-auto max-w-3xl space-y-5">
                {turns.map((t) => (
                  <TurnView key={t.id} turn={t} />
                ))}
              </div>
            )}
          </div>
          <div className="border-t border-line px-8 py-4">
            <div className="mx-auto flex max-w-3xl items-end gap-2">
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void send();
                  }
                }}
                rows={2}
                placeholder="Enter 发送，Shift+Enter 换行"
                className="resize-none"
                data-testid="pg-input"
              />
              {ctrl ? (
                <Button onClick={() => ctrl.abort()} className="h-[60px] w-20">
                  停止
                </Button>
              ) : (
                <Button
                  variant="primary"
                  onClick={() => void send()}
                  disabled={!input.trim() || !!noEndpoints}
                  className="h-[60px] w-20"
                  data-testid="pg-send"
                >
                  发送
                </Button>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function TurnView({ turn }: { turn: Turn }) {
  if (turn.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-md bg-accent/20 px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap">
          {turn.content}
        </div>
      </div>
    );
  }
  const r = turn.result;
  return (
    <div className="space-y-1.5" data-testid="pg-assistant">
      {turn.reasoning && (
        <details className="rounded-lg border border-line bg-panel px-3 py-2 text-xs text-muted" open={turn.pending && !turn.content}>
          <summary className="cursor-pointer select-none">推理过程</summary>
          <div className="mt-2 leading-relaxed whitespace-pre-wrap">{turn.reasoning}</div>
        </details>
      )}
      <div
        className={cx(
          'rounded-2xl rounded-bl-md border border-line bg-panel px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap',
          turn.error && 'border-err/40',
        )}
      >
        {turn.content}
        {turn.pending && !turn.content && <Spinner className="text-muted" />}
        {turn.pending && turn.content && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-accent align-middle" />}
        {turn.error && <div className="text-err">{turn.error}</div>}
        {turn.stopped && <div className="mt-1 text-xs text-faint">（已停止）</div>}
      </div>
      {r && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 px-1 text-[11px] text-faint" data-testid="pg-meta">
          <span className="font-mono">
            {r.endpointName} / {r.model}
          </span>
          <span>
            输入 {r.usage.inputTokens} · 输出 {r.usage.outputTokens}
            {r.usage.cachedInputTokens > 0 && ` · 缓存 ${r.usage.cachedInputTokens}`}
            {r.usage.estimated && '（估算）'}
          </span>
          <span>花费 {formatCost(r.cost, r.currency)}</span>
          {r.ttftMs !== null && <span>首字 {formatMs(r.ttftMs)}</span>}
          <span>总耗时 {formatMs(r.latencyMs)}</span>
        </div>
      )}
    </div>
  );
}
