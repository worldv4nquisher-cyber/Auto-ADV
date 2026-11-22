import { ROLE_LABELS, type RoleId } from '@auto-adv/schema';

export function formatCost(cost: number | null | undefined, currency: string): string {
  if (cost === null || cost === undefined) return '—';
  const symbol = currency === 'CNY' ? '¥' : '$';
  if (cost === 0) return `${symbol}0`;
  if (cost < 0.0001) return `<${symbol}0.0001`;
  return `${symbol}${cost < 1 ? cost.toFixed(4) : cost.toFixed(2)}`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  if (d.toDateString() === today.toDateString()) return time;
  return `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

const EXTRA_ROLE_NAMES: Record<string, string> = {
  playground: '调试台',
  probe: '能力探测',
};

const TAG_NAMES: Record<string, string> = {
  'genesis.brief': '创世 · 简报',
  'genesis.worldview': '创世 · 世界观',
  'genesis.cast': '创世 · 角色',
  'genesis.locations': '创世 · 地点',
  'genesis.plot': '创世 · 剧情骨架',
  'genesis.lore': '创世 · 设定集',
  'genesis.opening': '创世 · 开场',
  'play.reply': '对话 · 回复',
  'play.memory': '对话 · 前情提要',
  'observer.director': '观察 · 导演',
  'observer.writer': '观察 · 演出',
  'observer.narrator': '观察 · 旁白',
  'observer.actor': '观察 · 演员',
  'observer.arc': '观察 · 续写篇章',
};

/** 调用用途的显示名。 */
export function tagName(tag: string | null): string {
  if (!tag) return '';
  return TAG_NAMES[tag] ?? tag;
}

export function roleName(role: string): string {
  return ROLE_LABELS[role as RoleId]?.name ?? EXTRA_ROLE_NAMES[role] ?? role;
}
