import { z } from 'zod';
import { LOCAL_PART_REGEX, MAX_BATCH_CLAIM } from '../constants.js';
import type { ErrorCode } from '../envelope.js';

export const localPartSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(LOCAL_PART_REGEX, '前缀需为 1-64 位小写字母/数字，中间可含 . _ + -');

export const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, '域名格式非法')
  .refine((v) => v.split('.').every((label) => label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)), '域名标签需为 1-63 位，不能以连字符开头或结尾');

export const claimMailboxRequestSchema = z.object({
  localPart: localPartSchema,
  domain: domainSchema,
});
export type ClaimMailboxRequest = z.infer<typeof claimMailboxRequestSchema>;

/** 批量认领 / 批量可用性检查：按给出的顺序逐个处理 */
export const batchMailboxRequestSchema = z.object({
  items: z.array(claimMailboxRequestSchema).min(1).max(MAX_BATCH_CLAIM),
});
export type BatchMailboxRequest = z.infer<typeof batchMailboxRequestSchema>;

/**
 * 随机后缀分配（GET /api/mailboxes/random-plan）：只返回为当前用户分好的后缀，不认领。
 * uniform：在参与随机的可认领域名里等概率选；claude：按后缀的 Claude 封号数、再按账号数均衡分配。
 */
export const CLAIM_PLAN_STRATEGIES = ['uniform', 'claude'] as const;
export type ClaimPlanStrategy = (typeof CLAIM_PLAN_STRATEGIES)[number];

export const claimPlanQuerySchema = z.object({
  count: z.coerce.number().int().min(1).max(MAX_BATCH_CLAIM),
  strategy: z.enum(CLAIM_PLAN_STRATEGIES),
});
export type ClaimPlanQuery = z.infer<typeof claimPlanQuerySchema>;

export interface ClaimPlanItem {
  domain: string;
  /** 该后缀上收到过 Claude 封号信的地址数（根据历史来信统计） */
  suspended: number;
}

export interface ClaimPlan {
  strategy: ClaimPlanStrategy;
  /** 按分配顺序排列，长度不超过 count */
  items: ClaimPlanItem[];
  /** 参与随机且当前用户可认领的域名（单个地址重新随机时从中选） */
  pool: string[];
  /** 没能分配的个数 */
  shortfall: number;
  /** shortfall 的原因：quota 额度不足；no_candidates 没有可用的后缀 */
  reason: 'quota' | 'no_candidates' | null;
}

export const updateMailboxRequestSchema = z.object({
  displayName: z.string().trim().max(64),
});
export type UpdateMailboxRequest = z.infer<typeof updateMailboxRequestSchema>;

/** 管理员强制过户；expectedOwnerId 来自最新的全站邮箱列表。 */
export const transferMailboxRequestSchema = z.object({
  userId: z.number().int().positive(),
  expectedOwnerId: z.number().int().positive(),
});
export type TransferMailboxRequest = z.infer<typeof transferMailboxRequestSchema>;

export interface Mailbox {
  id: number;
  address: string;
  domain: string;
  userId: number;
  /** 仅 admin ?all=1 场景返回 */
  ownerUsername?: string;
  displayName: string;
  messageCount: number;
  createdAt: string;
}

/**
 * 不可认领原因：taken 已被占用；reserved 系统保留前缀；quota 达到个人认领上限；
 * domain_limit 达到该域名的每人上限；domain_unavailable 域名不存在或未对当前用户开放。
 */
export type MailboxUnavailableReason = 'taken' | 'reserved' | 'quota' | 'domain_limit' | 'domain_unavailable';

export interface MailboxAvailability {
  address: string;
  available: boolean;
  /** available=false 时说明原因 */
  reason?: MailboxUnavailableReason;
}

/**
 * 批量认领结果：按请求顺序逐个认领，与单个认领同一套规则。
 * 被占用的跳过并继续；其他错误立即停止，已认领的保留。
 */
export interface BatchClaimMailboxResult {
  claimed: Mailbox[];
  /** 因已被占用而跳过的地址，保持请求顺序 */
  taken: ClaimMailboxRequest[];
  /** 停止后没有尝试的地址（含触发停止的那一个），保持请求顺序；全部尝试过时为空 */
  notAttempted: ClaimMailboxRequest[];
  /** 停止原因；null 表示全部尝试过 */
  stoppedBy: { code: ErrorCode; message: string } | null;
}

export interface MailboxTransferResult {
  mailbox: Mailbox;
  previousUserId: number;
  transferred: boolean;
  revokedShares: number;
}

/** 所有者或管理员替换邮箱共享名单。空数组表示全部撤销。 */
export const replaceMailboxSharesRequestSchema = z.object({
  mailboxId: z.number().int().positive(),
  userIds: z.array(z.number().int().positive()).max(100),
  expectedOwnerId: z.number().int().positive().optional(),
});
export type ReplaceMailboxSharesRequest = z.infer<typeof replaceMailboxSharesRequestSchema>;

export interface MailboxShareGrantee {
  userId: number;
  username: string;
  grantedAt: string;
  status: 'active' | 'disabled';
}

/** 所有者或管理员视角：邮箱及其共享名单 */
export interface MailboxShareGrant {
  mailboxId: number;
  address: string;
  domain: string;
  displayName: string;
  ownerUserId: number;
  ownerUsername: string;
  grantees: MailboxShareGrantee[];
}

/** 被分享人视角：只读可见的邮箱，不能当发件身份 */
export interface SharedMailboxView {
  mailboxId: number;
  address: string;
  domain: string;
  displayName: string;
  ownerUsername: string;
}
