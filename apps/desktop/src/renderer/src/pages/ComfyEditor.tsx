import {
  COMFY_PURPOSE_LABELS,
  COMFY_PURPOSES,
  COMFY_VAR_HINTS,
  COMFY_VARS,
  type ComfyPurpose,
  type ComfySettings,
  checkComfy,
  DEFAULT_COMFY_EDIT,
  DEFAULT_COMFY_GENERATE,
} from '@auto-adv/schema';
import { useState } from 'react';
import { Button, Input, Textarea } from '../components/ui.tsx';

/**
 * 本地生图（ComfyUI）的工作流编辑：文生图、改图两个通用的工作流（留空用内置的），每种用途还能单独换；
 * 反向提示词、改图的重绘幅度、查询间隔。写法见 @auto-adv/schema 的 comfy.ts。
 */

const pretty = (v: unknown) => JSON.stringify(v, null, 2);
const BUILTIN = { generate: pretty(DEFAULT_COMFY_GENERATE), edit: pretty(DEFAULT_COMFY_EDIT) };

/** 文字和内置的一样（不管缩进）就当成没改，存成空的，以后内置工作流更新了也跟着更新。 */
const sameJson = (a: string, b: string) => {
  try {
    return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
  } catch {
    return false;
  }
};

export function ComfyEditor({ value, onChange }: { value: ComfySettings; onChange: (v: ComfySettings) => void }) {
  const problem = checkComfy(value);
  const [showPurposes, setShowPurposes] = useState(COMFY_PURPOSES.some((p) => value.purposes[p]?.trim()));
  const workflow = (k: 'generate' | 'edit', title: string, hint: string) => (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-xs font-medium text-muted">
        {title}
        <span className="font-normal text-faint">{value[k].trim() ? '（自己的）' : '（内置）'}</span>
        {value[k].trim() && (
          <button type="button" className="text-[11px] text-accent-strong hover:underline" onClick={() => onChange({ ...value, [k]: '' })} data-testid={`comfy-${k}-reset`}>
            恢复内置
          </button>
        )}
      </div>
      <Textarea
        rows={8}
        value={value[k].trim() ? value[k] : BUILTIN[k]}
        onChange={(e) => onChange({ ...value, [k]: sameJson(e.target.value, BUILTIN[k]) ? '' : e.target.value })}
        className="font-mono text-xs"
        spellCheck={false}
        data-testid={`comfy-${k}`}
      />
      <div className="text-[11px] text-faint">{hint}</div>
    </div>
  );
  const setPurpose = (p: ComfyPurpose, text: string) => {
    const purposes = { ...value.purposes };
    if (text.trim()) purposes[p] = text;
    else delete purposes[p];
    onChange({ ...value, purposes });
  };
  const num = (k: 'denoise' | 'pollSeconds', min: number, max: number, step: number) => (
    <Input
      type="number"
      min={min}
      max={max}
      step={step}
      value={String(value[k])}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (Number.isFinite(n)) onChange({ ...value, [k]: Math.min(max, Math.max(min, n)) });
      }}
      className="!w-24"
      data-testid={`comfy-${k}`}
    />
  );

  return (
    <div className="mt-3 space-y-3 border-t border-line pt-3" data-testid="comfy-editor">
      <div className="rounded-lg bg-bg px-3 py-2 text-xs leading-relaxed text-muted">
        <div>
          工作流是 ComfyUI 里「导出（API 格式）」得到的 JSON（要先在设置里打开开发者模式）。要引擎填的地方写成占位符，整个字符串只有一个占位符时按原来的类型放（
          <code>{'"{{width}}"'}</code> 会变成数字）。内置的两个只用 ComfyUI 自带的节点，模型是职责路由里填的 checkpoint。
        </div>
        <div className="mt-1">
          占位符：
          {COMFY_VARS.map((v) => (
            <span key={v} className="ml-1" title={COMFY_VAR_HINTS[v]}>
              <code className="rounded bg-panel-2 px-1">{`{{${v}}}`}</code>
            </span>
          ))}
        </div>
        <div className="mt-1">素材设置里的提示词模板默认是中文的；用只认英文的模型时，可以在素材设置里把模板改成英文。</div>
      </div>
      {workflow('generate', '文生图工作流', '背景、基础立绘、不带参考图的 CG 用它。')}
      {workflow('edit', '改图工作流', '表情差分、带参考图的 CG、改光线的时段背景用它，要有 {{image}}（引擎先把参考图上传到 ComfyUI）。')}
      <div className="space-y-2">
        <button type="button" className="text-xs text-accent-strong hover:underline" onClick={() => setShowPurposes((v) => !v)} data-testid="comfy-purposes-toggle">
          {showPurposes ? '收起' : '按用途换工作流'}
        </button>
        {showPurposes && (
          <div className="space-y-2" data-testid="comfy-purposes">
            <div className="text-[11px] text-faint">
              某种素材想用别的工作流（例如立绘接去背景的节点、CG 换个模型）就贴在这里：写了 {'{{image}}'} 的用在要参考图的时候，没写的用在文生图的时候，空着用上面的。
            </div>
            {COMFY_PURPOSES.map((p) => (
              <div key={p} className="grid grid-cols-[5rem_1fr] items-start gap-2">
                <div className="pt-2 text-xs text-muted">{COMFY_PURPOSE_LABELS[p]}</div>
                <Textarea
                  rows={value.purposes[p]?.trim() ? 6 : 1}
                  value={value.purposes[p] ?? ''}
                  placeholder="空着用通用的工作流"
                  onChange={(e) => setPurpose(p, e.target.value)}
                  className="font-mono text-xs"
                  spellCheck={false}
                  data-testid={`comfy-purpose-${p}`}
                />
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="grid grid-cols-[7rem_1fr] items-start gap-x-3 gap-y-2 text-xs">
        <div className="pt-2 text-muted">反向提示词</div>
        <div className="space-y-1">
          <Textarea rows={2} value={value.negative} onChange={(e) => onChange({ ...value, negative: e.target.value })} className="text-xs" data-testid="comfy-negative" />
          <div className="text-[11px] text-faint">填进 {'{{negative}}'}。</div>
        </div>
        <div className="pt-2 text-muted">重绘幅度</div>
        <div className="space-y-1">
          {num('denoise', 0, 1, 0.05)}
          <div className="text-[11px] text-faint">改图时填进 {'{{denoise}}'}：0～1，越大越不像参考图。表情差分想保住长相就小一点。</div>
        </div>
        <div className="pt-2 text-muted">查询间隔</div>
        <div className="space-y-1">
          {num('pollSeconds', 0.1, 30, 0.5)}
          <div className="text-[11px] text-faint">秒。提交以后隔多久问一次画好没有。</div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" onClick={() => onChange({ ...value, generate: '', edit: '', purposes: {} })} data-testid="comfy-reset-all">
          工作流全部恢复内置
        </Button>
      </div>
      {problem && (
        <div className="text-xs text-err" data-testid="comfy-problem">
          {problem}
        </div>
      )}
    </div>
  );
}
