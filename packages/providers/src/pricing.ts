import type { ModelPricing } from '@auto-adv/schema';
import type { Usage } from './types.ts';

/** 按每百万 token 价格计算一次调用的费用；没有价格时返回 null。 */
export function computeCost(usage: Usage, pricing: ModelPricing | undefined): number | null {
  if (!pricing) return null;
  const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const uncached = usage.inputTokens - cached;
  const cachedPrice = pricing.cachedInput ?? pricing.input;
  const cost = (uncached * pricing.input + cached * cachedPrice + usage.outputTokens * pricing.output) / 1_000_000;
  return Math.round(cost * 1e8) / 1e8;
}
