/** 防崩坏：重复检测、停滞检测、事件卡池。都是纯函数。 */

/** 文本的字符二元组集合（中文按字，忽略标点和空白）。 */
function bigrams(text: string): Set<string> {
  const chars = [...text.replace(/[\s\p{P}\p{S}]/gu, '')];
  const out = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i++) out.add(`${chars[i]}${chars[i + 1]}`);
  return out;
}

/** 两段文本的相似度（二元组的重叠系数，0～1）。比 Jaccard 对长短不一的文本更敏感。 */
export function similarity(a: string, b: string): number {
  const x = bigrams(a);
  const y = bigrams(b);
  if (!x.size || !y.size) return 0;
  let common = 0;
  for (const g of x) if (y.has(g)) common++;
  return common / Math.min(x.size, y.size);
}

/** 最新一段和之前若干段的最高相似度。 */
export function maxSimilarity(latest: string, previous: string[]): number {
  return previous.reduce((m, p) => Math.max(m, similarity(latest, p)), 0);
}

export const QUALITY = {
  /** 相似度超过这个值视为重复。 */
  repetition: 0.55,
  /** 连续这么多拍没有推进骨架、也没有换场景，视为停滞。 */
  stagnantBeats: 4,
  /** 比较最近几拍。 */
  window: 6,
};

/** 事件卡：剧情停滞或重复时，导演必须用一张卡打破僵局。 */
export const EVENT_CARDS = [
  '不速之客：一个意想不到的人突然出现，带来消息或麻烦',
  '意外发现：有人发现了一件关键物品或线索',
  '天有不测：天气或环境突变，迫使所有人改变计划',
  '旧事重提：一段被刻意回避的过去被人提起',
  '误会爆发：一个误会在最糟糕的时刻被引爆',
  '秘密泄露：某个角色的秘密被第三人知道了',
  '危机降临：迫在眉睫的危险，必须马上应对',
  '时间跳跃：时间直接跳到几小时或几天后，期间发生了一些事',
  '两难抉择：某个角色必须在两件重要的事之间做出选择',
  '背叛：有人做了出乎意料、辜负他人信任的事',
  '求助：有人带着急切的请求找上门',
  '失去：一件重要的东西丢了、坏了或被偷了',
  '心意：某个角色说出了一直藏在心里的话',
  '对峙：两个有矛盾的角色被迫正面交锋',
  '转场：故事转移到一个新的地点',
  '小插曲：一段轻松的小事，让紧张的关系缓和或升温',
  '传言：一个真假难辨的传言开始流传',
  '期限：出现了一个必须在期限前完成的目标',
  '闯入：有人闯入了不该进入的地方',
  '回忆：某个角色陷入回忆，揭示了他的动机',
  '信物：一件信物把两个角色联系在一起',
  '第三方介入：一股新的势力介入当前的冲突',
  '意外受伤：有人受了伤或病倒了',
  '好消息背后：一个看似的好消息暗藏陷阱',
] as const;

/** 抽一张最近没用过的卡。 */
export function drawCard(recentlyUsed: string[], random = Math.random): string {
  const fresh = EVENT_CARDS.filter((c) => !recentlyUsed.includes(c));
  const pool = fresh.length ? fresh : [...EVENT_CARDS];
  return pool[Math.floor(random() * pool.length)] as string;
}
