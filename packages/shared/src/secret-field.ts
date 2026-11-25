import { z } from 'zod';

/** 库内密文前缀（worker 的 secret box：`enc:v1:<kid>:<iv>:<ct>`） */
export const SEALED_SECRET_PREFIX = 'enc:v1:';

/**
 * 密文设置字段：同一个 schema 既校验管理员提交的明文（≤ max 个字符），也要能解析库里的密文
 * （密文比明文长，按前缀放宽到 4096）。否则存量密文过不了 safeParse，整个设置会静默回落默认值。
 */
export function secretSettingString(max: number) {
  return z
    .string()
    .max(4096)
    .refine((value) => value.startsWith(SEALED_SECRET_PREFIX) || value.length <= max, { message: `最多 ${max} 个字符` });
}
