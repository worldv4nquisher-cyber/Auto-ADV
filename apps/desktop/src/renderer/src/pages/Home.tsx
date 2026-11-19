import type { PageId } from '../App.tsx';
import { Badge, Button, Card, cx } from '../components/ui.tsx';
import { useSettings } from '../lib/settings.tsx';

export function HomePage({ onNavigate }: { onNavigate: (p: PageId) => void }) {
  const { settings, error } = useSettings();
  const hasEndpoint = (settings?.endpoints.length ?? 0) > 0;
  const hasProbed = settings?.endpoints.some((e) => Object.keys(e.capabilities).length > 0) ?? false;
  const hasDefaultRole = !!settings?.roles.default;

  const steps = [
    {
      done: hasEndpoint,
      title: '添加一个模型接入点',
      desc: 'DeepSeek、通义千问、Kimi、OpenAI、本地 Ollama……任何 OpenAI 兼容接口都可以。',
      action: () => onNavigate('settings'),
      label: '去添加',
    },
    {
      done: hasProbed,
      title: '做一次能力探测',
      desc: '自动检查模型支持哪些功能（流式、结构化输出、工具调用），引擎会据此选择调用方式。',
      action: () => onNavigate('settings'),
      label: '去探测',
    },
    {
      done: hasDefaultRole,
      title: '给「默认」职责指定模型',
      desc: '导演、演员、旁白等职责没有单独指定时都会用它。',
      action: () => onNavigate('settings'),
      label: '去设置',
    },
    {
      done: false,
      title: '在调试台试一句',
      desc: '看看流式输出、token 用量和花费是否正常。',
      action: () => onNavigate('playground'),
      label: '打开调试台',
    },
  ];

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-8 py-10">
        <div className="relative overflow-hidden rounded-2xl border border-line bg-gradient-to-br from-[#1f1b3a] via-panel to-[#2a1630] p-8">
          <div className="absolute -top-16 -right-16 size-64 rounded-full bg-accent/20 blur-3xl" />
          <div className="relative">
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">我的世界</h1>
              <Badge tone="accent">M0 预览版</Badge>
            </div>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted">
              一句话生成一个完整的世界：世界观、角色、设定集、剧情、立绘与音乐。然后和角色聊天、按剧情游玩，或者只当观众，看 AI 们自己把故事演下去。
            </p>
            <div className="mt-6 flex items-center gap-3">
              <Button variant="primary" disabled title="一键创世将在 M1 开放">
                ＋ 新建世界
              </Button>
              <span className="text-xs text-faint">一键创世将在下一个版本（M1）开放</span>
            </div>
          </div>
        </div>

        <h2 className="mt-10 mb-3 text-sm font-medium text-muted">开始之前，先把模型接好</h2>
        {error && <p className="mb-3 text-sm text-err">{error}</p>}
        <div className="grid gap-2">
          {steps.map((s, i) => (
            <Card key={s.title} className="flex items-center gap-4 px-5 py-4">
              <div
                className={cx(
                  'flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                  s.done ? 'bg-ok/15 text-ok' : 'bg-panel-3 text-muted',
                )}
              >
                {s.done ? '✓' : i + 1}
              </div>
              <div className="min-w-0 flex-1">
                <div className={cx('text-sm font-medium', s.done && 'text-muted line-through decoration-faint')}>{s.title}</div>
                <div className="mt-0.5 text-xs text-muted">{s.desc}</div>
              </div>
              {!s.done && (
                <Button size="sm" onClick={s.action}>
                  {s.label}
                </Button>
              )}
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
