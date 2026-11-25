import { z } from 'zod';
import { domainSchema } from './mailbox.js';
import { secretSettingString } from '../secret-field.js';

/**
 * Spaceship 批量采购域名：粘贴列表 → 报价（可用性 + 价格）→ 管理员确认（复核价格与上限）→ 逐个注册 →
 * 建 Cloudflare zone、改 NS、开 Email Routing + catch-all（指向收件 Worker）→ 加入系统域名列表。
 * 每个域名的进度持久化，cron 续跑；注册结果不明（unknown）的域名永不自动重新注册。
 */
export const DOMAIN_BATCH_STATUSES = ['quoted', 'confirming', 'processing', 'completed', 'expired', 'cancelled'] as const;
export type DomainBatchStatus = (typeof DOMAIN_BATCH_STATUSES)[number];

export const DOMAIN_ITEM_STATUSES = [
  'quoted',
  'skipped',
  'confirmed',
  'registering',
  'registered',
  'zone_created',
  'ns_set',
  'zone_active',
  'routing_ready',
  'domain_added',
  'failed',
  'unknown',
  'cancelled',
] as const;
export type DomainItemStatus = (typeof DOMAIN_ITEM_STATUSES)[number];

/** 已确认、尚未到终态的条目（占用系统域名名额，阻止同名重复采购） */
export const DOMAIN_ITEM_IN_FLIGHT = [
  'confirmed',
  'registering',
  'registered',
  'zone_created',
  'ns_set',
  'zone_active',
  'routing_ready',
  'unknown',
] as const satisfies readonly DomainItemStatus[];

/** 计入 24 小时滚动上限的条目状态；另外 status='failed' 且 failed_step 不在 ('register','poll') 的也计入（已注册成功） */
export const DOMAIN_ITEM_CHARGED_FOR_CAP = [...DOMAIN_ITEM_IN_FLIGHT, 'domain_added'] as const satisfies readonly DomainItemStatus[];

/** 终态：批次内全部条目处于这些状态时批次 completed（unknown 不算终态） */
export const DOMAIN_ITEM_TERMINAL = ['domain_added', 'failed', 'skipped', 'cancelled'] as const satisfies readonly DomainItemStatus[];

export const DOMAIN_ITEM_STEPS = ['register', 'poll', 'zone', 'nameservers', 'routing', 'catch_all', 'domain_add'] as const;
export type DomainItemStep = (typeof DOMAIN_ITEM_STEPS)[number];

/** 报价时被排除的原因 */
export const DOMAIN_SKIP_REASONS = [
  'taken',
  'premium',
  'over_domain_cap',
  'already_listed',
  'hosted',
  'has_history',
  'in_flight',
  'duplicate',
  'not_selected',
  'invalid',
  /** Spaceship 可用性结果：该后缀不支持 */
  'tldNotSupported',
  /** Spaceship 可用性结果：查询出错 */
  'unexpectedError',
  /** 可注册但没有可用的 USD 注册价（价格接口报错、非 USD 或缺少对应年限） */
  'no_price',
] as const;
export type DomainSkipReason = (typeof DOMAIN_SKIP_REASONS)[number];

/** 单次 Spaceship 可用性查询最多域名数 */
export const SPACESHIP_AVAILABILITY_CHUNK = 20;
/** 单次报价最多粘贴的域名数 */
export const MAX_DOMAIN_QUOTE_NAMES = 100;

/** settings.spaceship：apiKey / apiSecret 为密文字段（回显 SECRET_MASK，库内加密）。上限为 0 表示禁止采购 */
export const spaceshipSettingSchema = z.object({
  enabled: z.boolean().default(false),
  /** SECRET */
  apiKey: secretSettingString(256).default(''),
  /** SECRET */
  apiSecret: secretSettingString(256).default(''),
  registrantContactId: z.union([z.literal(''), z.string().regex(/^[A-Za-z0-9]{27,32}$/, '联系人 ID 格式非法')]).default(''),
  years: z.number().int().min(1).max(10).default(1),
  autoRenew: z.boolean().default(false),
  privacyLevel: z.enum(['public', 'high']).default('high'),
  allowPremium: z.boolean().default(false),
  /** 单域名上限（美分，cap basis = max(final, regular) × years） */
  maxDomainCents: z.number().int().min(0).max(1_000_000).default(0),
  maxBatchCents: z.number().int().min(0).max(10_000_000).default(0),
  /** 24 小时滚动上限（按本站采购台账统计） */
  maxDailyCents: z.number().int().min(0).max(10_000_000).default(0),
  maxBatchDomains: z.number().int().min(1).max(MAX_DOMAIN_QUOTE_NAMES).default(20),
  quoteTtlMinutes: z.number().int().min(1).max(60).default(15),
  /** catch-all 目标 Worker；k3s = 'hpc-mail-ingress-20261028'。空 = 用显式配置的 env.worker_name */
  ingressWorkerName: z.union([z.literal(''), z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'Worker 名称非法')]).default(''),
});
export type SpaceshipSetting = z.infer<typeof spaceshipSettingSchema>;

export const domainQuoteRequestSchema = z.object({
  /** 粘贴原文（服务端按空白/逗号/分号拆分，转 A-label、小写、去重）或直接给数组 */
  domains: z.union([z.string().max(20_000), z.array(z.string().max(253)).max(MAX_DOMAIN_QUOTE_NAMES)]),
  /** 缺省用 settings.spaceship.years */
  years: z.number().int().min(1).max(10).optional(),
});
export type DomainQuoteRequest = z.infer<typeof domainQuoteRequestSchema>;

export const domainConfirmRequestSchema = z.object({
  /** 批次中可购买条目的子集 */
  domains: z.array(domainSchema).min(1).max(MAX_DOMAIN_QUOTE_NAMES),
  /** 必须等于所选条目 capBasisCents 之和 */
  expectedTotalCents: z.number().int().min(1),
});
export type DomainConfirmRequest = z.infer<typeof domainConfirmRequestSchema>;

export const domainItemResolveRequestSchema = z.object({ action: z.enum(['mark_registered', 'mark_not_registered']) });
export type DomainItemResolveRequest = z.infer<typeof domainItemResolveRequestSchema>;

const optionalText = (max: number) => z.string().trim().max(max).optional();

/** 注册人联系人（对应 Spaceship PUT /v1/contacts） */
export const registrantContactRequestSchema = z.object({
  firstName: z.string().trim().min(1).max(125),
  lastName: z.string().trim().min(1).max(125),
  organization: optionalText(255),
  email: z.string().trim().min(3).max(255).regex(/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, '邮箱格式非法'),
  address1: z.string().trim().min(1).max(255),
  address2: optionalText(255),
  city: z.string().trim().min(1).max(255),
  stateProvince: optionalText(255),
  postalCode: optionalText(16),
  country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, '国家需为两位代码'),
  phone: z.string().trim().regex(/^\+\d{1,3}\.\d{4,14}$/, '电话格式为 +国家码.号码，例如 +1.4155550100'),
  phoneExt: optionalText(7),
});
export type RegistrantContactRequest = z.infer<typeof registrantContactRequestSchema>;

export const listDomainBatchesQuerySchema = z.object({
  cursor: z.preprocess((v) => (v === '' ? undefined : v), z.string().max(64).optional()),
  limit: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().min(1).max(200).optional()).default(50),
  status: z.preprocess((v) => (v === '' ? undefined : v), z.enum(DOMAIN_BATCH_STATUSES).optional()),
});
export type ListDomainBatchesQuery = z.infer<typeof listDomainBatchesQuerySchema>;

export type DomainItemAction = 'retry' | 'resolve' | 'refresh';

export interface DomainPurchaseItemView {
  id: number;
  batchId: number;
  domain: string;
  status: DomainItemStatus;
  availability: string;
  skipReason: string;
  priceClass: string;
  finalCents: number | null;
  regularCents: number | null;
  capBasisCents: number | null;
  operationId: string | null;
  opStatus: string;
  nameServers: string[];
  zoneStatus: string;
  routingStatus: string;
  lifecycleStatus: string;
  verificationStatus: string;
  suspensions: string[];
  failedStep: string;
  lastError: string;
  errorCode: string;
  vendorOperationId: string;
  /** 当前允许的管理员操作 */
  actions: DomainItemAction[];
  /** 可能已扣费但结果不明 */
  maybeCharged: boolean;
  registeredAt: string | null;
  readyAt: string | null;
  updatedAt: string;
}

export interface DomainPurchaseBatchView {
  id: number;
  status: DomainBatchStatus;
  years: number;
  autoRenew: boolean;
  privacyLevel: 'public' | 'high';
  quoteTotalCents: number;
  confirmedTotalCents: number;
  quoteExpiresAt: string;
  lastError: string;
  createdBy: number;
  confirmedBy: number | null;
  confirmedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  counts: Partial<Record<DomainItemStatus, number>>;
  /** 仅 GET /:id 与报价/确认响应带 */
  items?: DomainPurchaseItemView[];
}

export interface DomainPurchaseStatus {
  enabled: boolean;
  /** apiKey + apiSecret + registrantContactId 均已配置 */
  configured: boolean;
  cloudflareConfigured: boolean;
  ingressWorker: string | null;
  ingressWorkerSource: 'setting' | 'env' | null;
  caps: { maxDomainCents: number; maxBatchCents: number; maxDailyCents: number; maxBatchDomains: number; spentLast24hCents: number };
  systemDomains: { used: number; inFlight: number; max: number };
  purchasingAllowed: boolean;
  /** 不允许采购的原因（面向管理员的中文说明） */
  reasons: string[];
}

export interface SpaceshipCredentialTest {
  ok: true;
  domainCount: number;
}
