import {
  CUSTOM_API_PRESETS,
  CUSTOM_API_VARS,
  CUSTOM_ENCODINGS,
  CUSTOM_METHODS,
  type CustomApi,
  type CustomOperation,
  type CustomRole,
  checkCustomApi,
  customVarsOf,
} from '@auto-adv/schema';
import { useEffect, useState } from 'react';
import { Button, cx, Input, Select, Textarea } from '../components/ui.tsx';

/**
 * 自定义接口的模板编辑（通用 HTTP 适配器）：请求怎么发、结果在响应的哪里、要不要轮询。
 * 图像多一个「改图」请求（表情差分用）。写法见 @auto-adv/schema 的 custom-api.ts。
 */

export type { CustomRole };

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** 刚选「自定义」时的起点：第一个模板（和内置的接口一样的写法）。 */
export function defaultCustomApi(role: CustomRole): CustomApi {
  const first = CUSTOM_API_PRESETS[role][0];
  if (!first) throw new Error(`没有 ${role} 的模板`);
  return clone(first.api);
}

const ENCODING_LABELS: Record<(typeof CUSTOM_ENCODINGS)[number], string> = {
  auto: '自动认',
  base64: 'base64',
  hex: 'hex',
  url: '链接（下载）',
};

const MAIN_LABEL: Record<CustomRole, string> = { image: '文生图请求', cutout: '抠图请求', music: '音乐请求', voice: '语音请求' };

export function CustomApiEditor({
  role,
  value,
  onChange,
}: {
  role: CustomRole;
  value: CustomApi;
  onChange: (v: CustomApi) => void;
}) {
  const problem = checkCustomApi(value, role);
  const mainVars = customVarsOf(role);
  const editVars = [...CUSTOM_API_VARS.common, ...CUSTOM_API_VARS.image, ...CUSTOM_API_VARS.imageEdit];
  return (
    <div className="mt-3 space-y-3 border-t border-line pt-3" data-testid={`custom-api-${role}`}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>从模板开始：</span>
        {CUSTOM_API_PRESETS[role].map((p) => (
          <Button key={p.id} size="sm" variant="ghost" onClick={() => onChange(clone(p.api))} data-testid={`custom-preset-${role}-${p.id}`}>
            {p.label}
          </Button>
        ))}
      </div>
      <OperationEditor title={MAIN_LABEL[role]} op={value.request} vars={mainVars} onChange={(request) => onChange({ ...value, request })} testId={`custom-${role}-request`} />
      {role === 'image' && (
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={!!value.edit}
              onChange={(e) => {
                const preset = CUSTOM_API_PRESETS.image[0]?.api.edit;
                const { edit: _drop, ...rest } = value;
                onChange(e.target.checked && preset ? { ...rest, edit: clone(preset) } : rest);
              }}
              data-testid="custom-image-edit-toggle"
            />
            写「改图」请求（带参考图改表情，画表情差分要用；不写的话在素材设置里关掉表情差分）
          </label>
          {value.edit && (
            <OperationEditor title="改图请求" op={value.edit} vars={editVars} onChange={(edit) => onChange({ ...value, edit })} testId="custom-image-edit" />
          )}
        </div>
      )}
      <div className="rounded-lg bg-bg px-3 py-2 text-xs leading-relaxed text-muted">
        <div>
          地址以 <code>/</code> 开头时接在接入点的 Base URL 后面。模板里用 <code>{'{{占位符}}'}</code>：JSON 请求体里整个字符串只有一个占位符时按原来的类型放（数字、布尔），
          夹在文字里时换成文字；表单（multipart）里值是 <code>{'"{{image}}"'}</code> 的字段上传图片文件，换完是空的字段不发。
        </div>
        <div className="mt-1">
          能用的占位符：<span className="font-mono">{mainVars.join('、')}</span>
          {role === 'image' && (
            <>
              ；改图另外有 <span className="font-mono">{CUSTOM_API_VARS.imageEdit.join('、')}</span>
            </>
          )}
          ；轮询的查询请求里另外有 <span className="font-mono">id</span>。
        </div>
      </div>
      {problem && (
        <div className="text-xs text-err" data-testid={`custom-problem-${role}`}>
          {problem}
        </div>
      )}
    </div>
  );
}

function OperationEditor({
  title,
  op,
  vars,
  onChange,
  testId,
}: {
  title: string;
  op: CustomOperation;
  vars: string[];
  onChange: (op: CustomOperation) => void;
  testId: string;
}) {
  const put = <K extends keyof CustomOperation>(k: K, v: CustomOperation[K]) => onChange({ ...op, [k]: v });
  const poll = op.poll;
  const putPoll = <K extends keyof NonNullable<CustomOperation['poll']>>(k: K, v: NonNullable<CustomOperation['poll']>[K]) => {
    if (poll) onChange({ ...op, poll: { ...poll, [k]: v } });
  };
  const usesJson = op.responseType === 'json' || !!poll;
  return (
    <div className="space-y-2 rounded-lg border border-line p-3" data-testid={testId}>
      <div className="text-xs font-medium text-muted">{title}</div>
      <div className="flex gap-2">
        <Select value={op.method} onChange={(e) => put('method', e.target.value as CustomOperation['method'])} className="w-28 text-xs" title="请求方法">
          {CUSTOM_METHODS.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </Select>
        <Input value={op.url} onChange={(e) => put('url', e.target.value)} placeholder="/images/generations 或完整的 https://…" className="flex-1 font-mono text-xs" data-testid={`${testId}-url`} />
      </div>
      <Row label="请求头">
        <Textarea rows={2} value={op.headers} onChange={(e) => put('headers', e.target.value)} className="font-mono text-xs" spellCheck={false} data-testid={`${testId}-headers`} />
      </Row>
      <Row label="请求体">
        <div className="space-y-1.5">
          <Select value={op.bodyType} onChange={(e) => put('bodyType', e.target.value as CustomOperation['bodyType'])} className="w-48 text-xs" data-testid={`${testId}-body-type`}>
            <option value="json">JSON</option>
            <option value="multipart">表单（multipart，可以传文件）</option>
            <option value="none">没有请求体</option>
          </Select>
          {op.bodyType !== 'none' && (
            <Textarea rows={6} value={op.body} onChange={(e) => put('body', e.target.value)} className="font-mono text-xs" spellCheck={false} data-testid={`${testId}-body`} />
          )}
        </div>
      </Row>
      <Row label="结果">
        <div className="flex flex-wrap gap-2">
          <Select
            value={op.responseType}
            onChange={(e) => put('responseType', e.target.value as CustomOperation['responseType'])}
            className="w-52 text-xs"
            disabled={!!poll}
            title={poll ? '异步任务的结果总是从查询的 JSON 里取' : undefined}
            data-testid={`${testId}-response-type`}
          >
            <option value="json">在 JSON 响应里</option>
            <option value="binary">响应本身就是文件</option>
          </Select>
          {usesJson && (
            <>
              <Input value={op.resultPath} onChange={(e) => put('resultPath', e.target.value)} placeholder="位置，例如 data.0.b64_json" className="min-w-0 flex-1 font-mono text-xs" data-testid={`${testId}-result-path`} />
              <Select value={op.encoding} onChange={(e) => put('encoding', e.target.value as CustomOperation['encoding'])} className="w-36 text-xs" title="结果的编码">
                {CUSTOM_ENCODINGS.map((enc) => (
                  <option key={enc} value={enc}>
                    {ENCODING_LABELS[enc]}
                  </option>
                ))}
              </Select>
            </>
          )}
        </div>
      </Row>
      <Row label="出错">
        <div className="flex gap-2">
          <Input value={op.errorPath} onChange={(e) => put('errorPath', e.target.value)} placeholder="错误信息的位置，例如 error.message" className="flex-1 font-mono text-xs" />
          <Input value={op.errorCodePath} onChange={(e) => put('errorCodePath', e.target.value)} placeholder="错误码的位置（不是 0 就算失败）" className="flex-1 font-mono text-xs" />
        </div>
      </Row>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={!!poll}
          onChange={(e) => {
            const { poll: _drop, ...rest } = op;
            onChange(
              e.target.checked
                ? {
                    ...rest,
                    poll: {
                      idPath: 'id',
                      method: 'GET',
                      url: '/jobs/{{id}}',
                      body: '',
                      statusPath: 'status',
                      done: ['succeeded', 'success', 'completed', 'done'],
                      failed: ['failed', 'error', 'canceled', 'cancelled'],
                      intervalSeconds: 3,
                      maxMinutes: 10,
                    },
                  }
                : rest,
            );
          }}
          data-testid={`${testId}-poll-toggle`}
        />
        异步任务：提交后返回任务 id，再反复查询直到完成
      </label>
      {poll && (
        <div className="space-y-2 rounded-lg bg-bg p-3">
          <Row label="任务 id">
            <Input value={poll.idPath} onChange={(e) => putPoll('idPath', e.target.value)} placeholder="提交的响应里任务 id 的位置，例如 data.task_id" className="font-mono text-xs" data-testid={`${testId}-poll-id`} />
          </Row>
          <Row label="查询">
            <div className="flex gap-2">
              <Select value={poll.method} onChange={(e) => putPoll('method', e.target.value as CustomOperation['method'])} className="w-28 text-xs">
                {CUSTOM_METHODS.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </Select>
              <Input value={poll.url} onChange={(e) => putPoll('url', e.target.value)} placeholder="/tasks/{{id}}" className="flex-1 font-mono text-xs" data-testid={`${testId}-poll-url`} />
            </div>
          </Row>
          {poll.method !== 'GET' && (
            <Row label="查询的请求体">
              <Textarea rows={2} value={poll.body} onChange={(e) => putPoll('body', e.target.value)} placeholder='{"task_id": "{{id}}"}（空着就不带）' className="font-mono text-xs" spellCheck={false} />
            </Row>
          )}
          <Row label="状态">
            <div className="flex flex-wrap gap-2">
              <Input value={poll.statusPath} onChange={(e) => putPoll('statusPath', e.target.value)} placeholder="状态的位置，例如 status" className="w-48 font-mono text-xs" data-testid={`${testId}-poll-status`} />
              <ListInput value={poll.done} onChange={(v) => putPoll('done', v)} label="完成" />
              <ListInput value={poll.failed} onChange={(v) => putPoll('failed', v)} label="失败" />
            </div>
          </Row>
          <Row label="间隔和上限">
            <div className="flex items-center gap-2 text-xs text-muted">
              每
              <NumberInput value={poll.intervalSeconds} onChange={(v) => putPoll('intervalSeconds', v)} min={0.2} max={60} testId={`${testId}-poll-interval`} />
              秒查一次，最多等
              <NumberInput value={poll.maxMinutes} onChange={(v) => putPoll('maxMinutes', v)} min={0.1} max={60} />
              分钟
            </div>
          </Row>
          <div className="text-xs text-faint">完成时结果按上面「结果」的位置从查询的响应里取。</div>
        </div>
      )}
      <div className="text-xs text-faint">
        可以用：<span className="font-mono">{vars.join('、')}</span>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <div className="w-20 shrink-0 pt-2 text-xs text-muted">{label}</div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** 逗号分隔的几个值（完成、失败的状态）。自己留着正在打的文字，只在外面的值变了时同步。 */
function ListInput({ value, onChange, label }: { value: string[]; onChange: (v: string[]) => void; label: string }) {
  const parse = (t: string) =>
    t
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
  const [text, setText] = useState(value.join(', '));
  useEffect(() => {
    if (parse(text).join('\u0000') !== value.join('\u0000')) setText(value.join(', '));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <label className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted">
      {label}
      <Input
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(parse(e.target.value));
        }}
        className="min-w-0 flex-1 font-mono text-xs"
      />
    </label>
  );
}

function NumberInput({
  value,
  onChange,
  min,
  max,
  testId,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  testId?: string;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    if (Number(text) !== value) setText(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <Input
      inputMode="decimal"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value.trim() && Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)));
      }}
      className={cx('h-8 w-16 text-center text-xs')}
      data-testid={testId}
    />
  );
}
