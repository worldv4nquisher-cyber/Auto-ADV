import {
  type ButtonHTMLAttributes,
  type ComponentProps,
  createContext,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const buttonStyles: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-white hover:bg-accent-strong shadow-[0_0_0_1px_#ffffff10_inset]',
  secondary: 'bg-panel-2 text-fg border border-line hover:border-line-strong hover:bg-panel-3',
  ghost: 'text-muted hover:text-fg hover:bg-panel-2',
  danger: 'text-err hover:bg-err/10 border border-transparent hover:border-err/30',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  loading,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' | 'md'; loading?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-9 px-3.5 text-sm',
        buttonStyles[variant],
        className,
      )}
      {...rest}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

const fieldBase =
  'w-full rounded-lg border border-line bg-bg px-3 text-sm text-fg placeholder:text-faint outline-none transition-colors focus:border-accent disabled:opacity-60';

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx(fieldBase, 'h-9', className)} {...rest} />;
}

export function Textarea({ className, ...rest }: ComponentProps<'textarea'>) {
  return <textarea className={cx(fieldBase, 'py-2 leading-relaxed', className)} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx(fieldBase, 'h-9 cursor-pointer pr-8', className)} {...rest}>
      {children}
    </select>
  );
}

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cx('flex flex-col gap-1.5', className)}>
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="text-xs text-faint">{hint}</span>}
    </label>
  );
}

export function Card({ children, className, ...rest }: HTMLAttributes<HTMLDivElement> & { 'data-testid'?: string }) {
  return (
    <div className={cx('rounded-xl border border-line bg-panel', className)} {...rest}>
      {children}
    </div>
  );
}

type BadgeTone = 'neutral' | 'ok' | 'warn' | 'err' | 'accent';
const badgeTones: Record<BadgeTone, string> = {
  neutral: 'bg-panel-3 text-muted',
  ok: 'bg-ok/12 text-ok',
  warn: 'bg-warn/12 text-warn',
  err: 'bg-err/12 text-err',
  accent: 'bg-accent-soft text-accent-strong',
};

export function Badge({ tone = 'neutral', children, title }: { tone?: BadgeTone; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={cx('inline-flex h-5 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium whitespace-nowrap', badgeTones[tone])}
    >
      {children}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cx('inline-block size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent', className)}
    />
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-4 border-b border-line px-8 pt-7 pb-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line px-6 py-12 text-center">
      <div className="text-sm font-medium">{title}</div>
      {children && <div className="max-w-md text-sm text-muted">{children}</div>}
    </div>
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  items,
}: {
  value: T;
  onChange: (v: T) => void;
  items: { value: T; label: ReactNode }[];
}) {
  return (
    <div className="flex gap-1 rounded-lg bg-panel-2 p-1">
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          data-testid={`tab-${it.value}`}
          onClick={() => onChange(it.value)}
          className={cx(
            'h-7 rounded-md px-3 text-sm transition-colors',
            value === it.value ? 'bg-panel-3 text-fg shadow-sm' : 'text-muted hover:text-fg',
          )}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

// ───────────── 提示条 ─────────────

interface Toast {
  id: number;
  tone: 'ok' | 'err' | 'info';
  text: string;
}

const ToastContext = createContext<(tone: Toast['tone'], text: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((tone: Toast['tone'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, tone, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'err' ? 7000 : 3000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed right-5 bottom-5 z-50 flex w-96 flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cx(
              'pointer-events-auto rounded-lg border px-4 py-3 text-sm shadow-lg backdrop-blur',
              t.tone === 'err' && 'border-err/40 bg-[#2a1618]/95 text-[#fecaca]',
              t.tone === 'ok' && 'border-ok/30 bg-[#11261f]/95 text-[#bbf7d0]',
              t.tone === 'info' && 'border-line bg-panel-2/95',
            )}
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

/** 需要点两次的危险操作（不用系统弹窗，避免打断）。 */
export function ConfirmButton({
  onConfirm,
  children,
  confirmText = '确认？',
  size = 'sm',
  variant = 'danger',
  disabled,
  title,
  testId,
}: {
  onConfirm: () => void;
  children: ReactNode;
  confirmText?: string;
  size?: 'sm' | 'md';
  variant?: ButtonVariant;
  disabled?: boolean;
  title?: string;
  testId?: string;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <Button
      size={size}
      variant={armed ? 'danger' : variant}
      disabled={disabled}
      title={title}
      data-testid={testId}
      className={armed ? 'border-err/40 bg-err/10' : undefined}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else setArmed(true);
      }}
    >
      {armed ? confirmText : children}
    </Button>
  );
}

/** 极简 Markdown：标题、列表、段落、粗体。世界观正文够用了。 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const inline = (s: string) =>
    s.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
      part.startsWith('**') && part.endsWith('**') ? (
        <strong key={i} className="font-semibold text-fg">
          {part.slice(2, -2)}
        </strong>
      ) : (
        part
      ),
    );
  const flush = () => {
    if (!list.length) return;
    const items = list;
    list = [];
    blocks.push(
      <ul key={`l${blocks.length}`} className="list-disc space-y-1 pl-5">
        {items.map((it, i) => (
          <li key={i}>{inline(it)}</li>
        ))}
      </ul>,
    );
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const li = /^[-*•]\s+(.*)$/.exec(line) ?? /^\d+[.、]\s*(.*)$/.exec(line);
    if (li) {
      list.push(li[1] ?? '');
      continue;
    }
    flush();
    if (!line) continue;
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push(
        <h3 key={blocks.length} className="mt-5 mb-1 text-sm font-semibold text-fg first:mt-0">
          {h[2]}
        </h3>,
      );
    } else {
      blocks.push(<p key={blocks.length}>{inline(line)}</p>);
    }
  }
  flush();
  return <div className={cx('space-y-2 text-sm leading-relaxed text-muted', className)}>{blocks}</div>;
}
