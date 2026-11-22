import { z } from 'zod';

/** 观察模式的设置（每个周目一份）。 */
export const ObserverSettings = z.object({
  /** merged：一次调用写出整拍（省钱）；split：导演、旁白、各个演员分开调用（演员只知道自己该知道的事）。 */
  strategy: z.enum(['merged', 'split']).default('merged'),
  /** protagonist：AI 替主角行动，故事围绕主角；ensemble：群像，导演轮流聚焦不同角色。 */
  focus: z.enum(['protagonist', 'ensemble']).default('protagonist'),
  /** 领先观众最多预生成几拍。观众不看，就不再生成，不花钱。 */
  bufferAhead: z.number().int().min(1).max(50).default(3),
  /** 本周目花费上限（按接入点的币种计；0 表示不限）。没配价格的模型按 token 上限控制。 */
  budgetCost: z.number().min(0).default(0),
  /** 本周目 token 上限（输入 + 输出；0 表示不限）。 */
  budgetTokens: z.number().int().min(0).default(2_000_000),
  /** 连续失败几拍后自动停止。 */
  maxFailures: z.number().int().min(1).max(20).default(3),
  /** 每分钟最多生成几拍（0 表示不限），防止意外的高频调用。 */
  maxBeatsPerMinute: z.number().min(0).default(6),
});
export type ObserverSettings = z.infer<typeof ObserverSettings>;
