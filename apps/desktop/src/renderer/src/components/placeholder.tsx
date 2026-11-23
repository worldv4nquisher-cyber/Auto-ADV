/**
 * VN 舞台的占位素材：素材生成（M4）之前，背景、立绘、CG 都用这里按 id 算出来的图形代替。
 * 同一个 id 永远是同一个样子，这样换背景、换人一眼就能看出来。
 */
import { cx } from './ui.tsx';

/** 字符串 → 0～359 的色相。 */
export function hueOf(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return h % 360;
}

export function PlaceholderBg({ id, className, label = true }: { id: string; className?: string; label?: boolean }) {
  const h = hueOf(id);
  return (
    <div
      className={cx('absolute inset-0 overflow-hidden', className)}
      style={{
        background: `radial-gradient(120% 80% at 30% 20%, hsl(${h} 45% 34% / .9), transparent 60%),
          radial-gradient(90% 70% at 85% 90%, hsl(${(h + 50) % 360} 50% 26% / .9), transparent 70%),
          linear-gradient(170deg, hsl(${h} 35% 18%), hsl(${(h + 30) % 360} 40% 8%))`,
      }}
    >
      {/* 地平线和远景，免得画面太空 */}
      <div
        className="absolute inset-x-0 bottom-0 h-[38%]"
        style={{ background: `linear-gradient(180deg, transparent, hsl(${(h + 20) % 360} 30% 6% / .85))` }}
      />
      <div
        className="absolute inset-x-[-10%] bottom-[24%] h-px opacity-40"
        style={{ background: `linear-gradient(90deg, transparent, hsl(${h} 60% 80%), transparent)` }}
      />
      {label && (
        <span className="absolute top-[3%] left-[2%] rounded bg-black/35 px-[0.6em] py-[0.2em] font-mono text-[max(10px,0.85cqw)] text-white/55">
          背景 · {id}
        </span>
      )}
    </div>
  );
}

/** 立绘：按角色颜色着色的剪影，下面写名字和表情。 */
export function PlaceholderSprite({ name, expr, color, dim }: { name: string; expr: string; color: string; dim?: boolean }) {
  const gid = `g${hueOf(name + color)}`;
  return (
    <div className={cx('flex h-full flex-col items-center transition-[filter] duration-300', dim && 'brightness-[.6] saturate-[.7]')}>
      <svg viewBox="0 0 200 420" className="h-full w-auto drop-shadow-[0_0_24px_rgba(0,0,0,.45)]" aria-hidden>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity=".95" />
            <stop offset="1" stopColor={color} stopOpacity=".35" />
          </linearGradient>
        </defs>
        <ellipse cx="100" cy="88" rx="50" ry="58" fill={`url(#${gid})`} />
        <path d="M100 150c-58 0-92 38-98 100L0 420h200l-2-170c-6-62-40-100-98-100z" fill={`url(#${gid})`} />
        <path d="M60 170c14 22 66 22 80 0" stroke="rgba(255,255,255,.35)" strokeWidth="3" fill="none" />
      </svg>
      <div className="absolute top-[24%] flex flex-col items-center gap-[0.3em] text-center">
        <span className="rounded bg-black/45 px-[0.6em] py-[0.15em] text-[max(11px,1.1cqw)] font-medium text-white/90">{name}</span>
        <span className="rounded bg-black/30 px-[0.5em] font-mono text-[max(10px,0.8cqw)] text-white/60">{expr}</span>
      </div>
    </div>
  );
}

/** CG：盖住整个舞台的一幅"画"。 */
export function PlaceholderCg({ id }: { id: string }) {
  const h = hueOf(id);
  return (
    <div
      className="absolute inset-0 flex items-center justify-center"
      style={{
        background: `conic-gradient(from ${h}deg at 50% 60%, hsl(${h} 60% 30%), hsl(${(h + 90) % 360} 55% 22%), hsl(${(h + 200) % 360} 50% 26%), hsl(${h} 60% 30%))`,
      }}
    >
      <div className="absolute inset-[4%] rounded-[1cqw] border border-white/20" />
      <div className="flex flex-col items-center gap-[0.4em] text-white/70">
        <span className="text-[max(12px,1.2cqw)] tracking-[0.4em]">CG</span>
        <span className="font-mono text-[max(11px,1cqw)]">{id}</span>
      </div>
    </div>
  );
}
