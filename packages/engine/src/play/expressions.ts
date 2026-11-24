import { DEFAULT_EXPRESSIONS, type ExpressionDef } from '@auto-adv/schema';

/**
 * AI 演出时的表情（18.6）：演员在台词前的括号里先写一个表情，再写动作和神态，
 * 解析时把第一个词对应到表情 id（plot/stage.ts 的 expressionOfLine），舞台换上对应的表情差分。不额外调模型。
 */

const table = (t?: readonly ExpressionDef[]) => (t?.length ? t : DEFAULT_EXPRESSIONS);

/** 演员和编剧提示词里"角色说话"那一条。 */
export function speechRule(example: string, expressions?: readonly ExpressionDef[]): string {
  const names = table(expressions).map((e) => e.name);
  const sample = names.find((n) => n !== names[0]) ?? names[0];
  return `- 角色说话：单独一行，以【角色名】开头，台词前的括号里先写一个表情（从${names.join('、')}里选），再写动作和神态。例如：【${example}】（${sample}，抬起头）你来晚了。`;
}

/** 分演模式里演员的输出格式。 */
export function actorFormat(expressions?: readonly ExpressionDef[]): string {
  const t = table(expressions);
  const names = t.map((e) => e.name);
  const sample = t.find((e) => e.id === 'sad')?.name ?? names[0];
  return `输出格式：一段话，开头的括号里先写一个表情（从${names.join('、')}里选），再写动作和神态，例如：（${sample}，攥紧衣角）……我不知道你在说什么。`;
}
