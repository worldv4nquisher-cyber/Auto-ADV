import type { CallDetail, CallSummary, UsageSummary } from '@auto-adv/engine/api';
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, cx, Empty, PageHeader, Spinner, useToast } from '../components/ui.tsx';
import { engine, errorMessage } from '../lib/engine.ts';
import { formatCost, formatMs, formatTime, formatTokens, roleName, tagName } from '../lib/format.ts';

const PAGE = 100;

export function LogsPage() {
  const toast = useToast();
  const [items, setItems] = useState<CallSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const load = useCallback(async () => {
    try {
      const [list, sum] = await Promise.all([engine.call('listCalls', { limit: PAGE }), engine.call('usageSummary')]);
      setItems(list.items);
      setTotal(list.total);
      setSummary(sum);
    } catch (err) {
      toast('err', errorMessage(err));
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async () => {
    if (!items) return;
    const list = await engine.call('listCalls', { limit: PAGE, offset: items.length });
    setItems([...items, ...list.items]);
    setTotal(list.total);
  };

  const clear = async () => {
    await engine.call('clearCalls');
    setConfirmClear(false);
    setSelected(null);
    await load();
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="调用日志"
        subtitle="每一次模型调用的完整提示词、输出、用量与花费。调提示词全靠它。"
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={() => void load()}>
              刷新
            </Button>
            {confirmClear ? (
              <>
                <Button size="sm" variant="danger" onClick={() => void clear()}>
                  确认清空
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmClear(false)}>
                  取消
                </Button>
              </>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setConfirmClear(true)} disabled={!total}>
                清空
              </Button>
            )}
          </>
        }
      />
      {summary && summary.calls > 0 && (
        <div className="flex gap-8 border-b border-line px-8 py-3 text-sm">
          <Stat label="调用次数" value={String(summary.calls)} />
          <Stat label="输入 token" value={formatTokens(summary.inputTokens)} />
          <Stat label="输出 token" value={formatTokens(summary.outputTokens)} />
          {summary.costs.map((c) => (
            <Stat key={c.currency} label={c.currency === 'CNY' ? '花费（人民币）' : '花费（美元）'} value={formatCost(c.total, c.currency)} />
          ))}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto">
          {items === null ? (
            <div className="p-8">
              <Spinner />
            </div>
          ) : items.length === 0 ? (
            <div className="p-8">
              <Empty title="还没有调用记录">在调试台发一条消息，或者对接入点做一次能力探测。</Empty>
            </div>
          ) : (
            <table className="w-full text-left text-[13px]" data-testid="logs-table">
              <thead className="sticky top-0 bg-bg text-xs text-faint">
                <tr className="border-b border-line">
                  <th className="py-2 pr-3 pl-8 font-normal">时间</th>
                  <th className="px-3 font-normal">职责</th>
                  <th className="px-3 font-normal">模型</th>
                  <th className="px-3 font-normal">状态</th>
                  <th className="px-3 text-right font-normal whitespace-nowrap">输入 / 输出</th>
                  <th className="px-3 text-right font-normal">花费</th>
                  <th className="px-3 text-right font-normal">耗时</th>
                  <th className="px-3 pr-8 font-normal">内容</th>
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() => setSelected(c.id)}
                    className={cx(
                      'cursor-pointer border-b border-line/50 hover:bg-panel',
                      selected === c.id && 'bg-accent-soft hover:bg-accent-soft',
                    )}
                  >
                    <td className="py-2 pr-3 pl-8 whitespace-nowrap text-muted tabular-nums">{formatTime(c.ts)}</td>
                    <td className="px-3 whitespace-nowrap" title={tagName(c.tag)}>
                      {roleName(c.role)}
                      {c.tag && <span className="ml-1.5 text-xs text-faint">{tagName(c.tag).split(' · ').at(-1)}</span>}
                    </td>
                    <td className="max-w-48 truncate px-3 font-mono text-xs" title={`${c.endpointName} / ${c.model}`}>
                      {c.model}
                    </td>
                    <td className="px-3">
                      <StatusBadge status={c.status} />
                    </td>
                    <td className="px-3 text-right whitespace-nowrap tabular-nums">
                      {c.inputTokens} / {c.outputTokens}
                      {c.estimated && <span className="text-faint">*</span>}
                    </td>
                    <td className="px-3 text-right whitespace-nowrap tabular-nums">{formatCost(c.cost, c.currency)}</td>
                    <td className="px-3 text-right whitespace-nowrap text-muted tabular-nums">{formatMs(c.latencyMs)}</td>
                    <td className="max-w-80 truncate px-3 pr-8 text-muted">{c.error ?? c.preview}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {items && items.length < total && (
            <div className="flex justify-center py-4">
              <Button size="sm" onClick={() => void loadMore()}>
                加载更多（还有 {total - items.length} 条）
              </Button>
            </div>
          )}
          {items && items.some((c) => c.estimated) && (
            <p className="px-8 py-3 text-xs text-faint">* 接口没有返回用量，按字数估算。</p>
          )}
        </div>
        {selected && <CallDetailPanel id={selected} onClose={() => setSelected(null)} />}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-faint">{label}</div>
      <div className="font-medium tabular-nums">{value}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: CallSummary['status'] }) {
  if (status === 'ok') return <Badge tone="ok">成功</Badge>;
  if (status === 'aborted') return <Badge tone="warn">已取消</Badge>;
  return <Badge tone="err">失败</Badge>;
}

function CallDetailPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const [detail, setDetail] = useState<CallDetail | null | undefined>(undefined);
  useEffect(() => {
    setDetail(undefined);
    engine
      .call('getCall', { id })
      .then(setDetail)
      .catch(() => setDetail(null));
  }, [id]);

  return (
    <aside className="flex w-[30rem] shrink-0 flex-col border-l border-line bg-panel" data-testid="log-detail">
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <span className="text-sm font-medium">调用详情</span>
        <Button size="sm" variant="ghost" onClick={onClose}>
          关闭
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4 text-[13px]">
        {detail === undefined && <Spinner />}
        {detail === null && <p className="text-muted">找不到这条记录</p>}
        {detail && (
          <>
            <div className="grid grid-cols-[6rem_1fr] gap-y-1.5">
              <span className="text-faint">职责</span>
              <span>
                {roleName(detail.role)}
                {detail.tag && <span className="ml-2 text-muted">{tagName(detail.tag)}</span>}
              </span>
              <span className="text-faint">接入点</span>
              <span>{detail.endpointName}</span>
              <span className="text-faint">模型</span>
              <span className="font-mono text-xs">{detail.model}</span>
              <span className="text-faint">地址</span>
              <span className="font-mono text-xs break-all">{detail.url}</span>
              <span className="text-faint">状态</span>
              <span className="flex items-center gap-2">
                <StatusBadge status={detail.status} />
                {detail.httpStatus !== null && <span className="text-muted">HTTP {detail.httpStatus}</span>}
                {detail.attempt > 1 && <span className="text-muted">第 {detail.attempt} 次尝试</span>}
              </span>
              <span className="text-faint">用量</span>
              <span>
                输入 {detail.inputTokens}（缓存 {detail.cachedInputTokens}）· 输出 {detail.outputTokens}
                {detail.reasoningTokens > 0 && `（推理 ${detail.reasoningTokens}）`}
                {detail.estimated && ' · 估算'}
              </span>
              <span className="text-faint">花费</span>
              <span>{formatCost(detail.cost, detail.currency)}</span>
              <span className="text-faint">耗时</span>
              <span>
                {formatMs(detail.latencyMs)}
                {detail.ttftMs !== null && ` · 首字 ${formatMs(detail.ttftMs)}`}
              </span>
            </div>
            {detail.error && <Section title="错误" body={detail.error} tone="err" />}
            {detail.reasoning && <Section title="推理内容" body={detail.reasoning} />}
            {detail.responseText && <Section title="输出" body={detail.responseText} />}
            {detail.toolCalls.length > 0 && <Section title="工具调用" body={JSON.stringify(detail.toolCalls, null, 2)} mono />}
            <Section title="请求" body={JSON.stringify(detail.request, null, 2)} mono />
          </>
        )}
      </div>
    </aside>
  );
}

function Section({ title, body, mono, tone }: { title: string; body: string; mono?: boolean; tone?: 'err' }) {
  const toast = useToast();
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs font-medium text-muted">{title}</span>
        <button
          type="button"
          className="text-xs text-faint hover:text-fg"
          onClick={() => {
            void navigator.clipboard.writeText(body).then(() => toast('ok', '已复制'));
          }}
        >
          复制
        </button>
      </div>
      <Card
        className={cx(
          'max-h-96 overflow-auto bg-bg px-3 py-2 leading-relaxed whitespace-pre-wrap',
          mono && 'font-mono text-xs',
          tone === 'err' && 'border-err/40 text-err',
        )}
      >
        {body}
      </Card>
    </div>
  );
}
