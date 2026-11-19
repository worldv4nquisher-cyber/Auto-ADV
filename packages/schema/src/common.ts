import { z } from 'zod';

/** 实体 id：小写字母开头，只含小写字母、数字、下划线，例如 char_lin、lore_aether_tide。 */
export const Id = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, 'id 只能包含小写字母、数字和下划线，且以字母开头');

/**
 * 每个可生成实体都带的元信息。
 * locked：用户锁定的字段路径（如 "appearance.text"），重抽时不覆盖，并作为约束传给生成器。
 */
export const EntityMeta = z.object({
  locked: z.array(z.string()).default([]),
  generatedBy: z.string().optional(),
  updatedAt: z.string().optional(),
});

/** 谁知道这条信息："public" 或角色 id 列表。信息不对称的基础。 */
export const KnownBy = z.union([z.literal('public'), z.array(Id)]);
