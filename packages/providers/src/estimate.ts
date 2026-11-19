import type { ChatMessage } from './types.ts';

const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/g;

/**
 * 粗略估算 token 数：中日韩字符约 1 字 1 token，其他约 4 字符 1 token。
 * 只在接口不返回用量时使用，结果会标记为估算。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(CJK)?.length ?? 0;
  const rest = text.length - cjk;
  return Math.ceil(cjk + rest / 4);
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  // 每条消息约有 4 个 token 的格式开销
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);
}
