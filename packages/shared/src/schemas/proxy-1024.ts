import { z } from 'zod';
import { secretSettingString } from '../secret-field.js';

/**
 * 1024proxy 采购（控制台私有接口自动化）：quote → 管理员确认（下单，拿到支付链接）→ awaiting_payment →
 * paid → fulfilled。结果不明的下单标 unknown，永不自动重试。上限为 0 表示禁止采购（不是不限）。
 */
export const PROXY1024_PRODUCTS = ['static_isp', 'unlimited_port', 'unlimited_bandwidth', 'residential_flow'] as const;
export type Proxy1024Product = (typeof PROXY1024_PRODUCTS)[number];

export const PROXY_ORDER_STATUSES = [
  'quoted',
  'ordering',
  'awaiting_payment',
  'paid',
  'fulfilled',
  'failed',
  'unknown',
  'expired',
  'cancelled',
  'abandoned',
] as const;
export type ProxyOrderStatus = (typeof PROXY_ORDER_STATUSES)[number];

/** 计入 24 小时滚动上限的订单状态 */
export const PROXY_ORDER_ACTIVE_FOR_CAP = ['ordering', 'awaiting_payment', 'paid', 'fulfilled', 'unknown'] as const satisfies readonly ProxyOrderStatus[];

/**
 * ProxyOrderView.warnings 的取值：
 * - payment_manual：awaiting_payment / unknown，需管理员在 1024 结算页手动支付
 * - maybe_charged：ordering / awaiting_payment / unknown，供应商侧可能已产生订单
 * - actual_exceeds_estimate：实付高于确认时的估价
 * - checkout_url_unreadable：结算链接密文无法解开（换过密钥）
 */
export const PROXY_ORDER_WARNINGS = ['payment_manual', 'maybe_charged', 'actual_exceeds_estimate', 'checkout_url_unreadable'] as const;
export type ProxyOrderWarning = (typeof PROXY_ORDER_WARNINGS)[number];

/** 可同步到库存的产品类型 */
export const PROXY1024_SYNC_KINDS = ['static_isp', 'unlimited_port', 'unlimited_bandwidth'] as const;
export type Proxy1024SyncKind = (typeof PROXY1024_SYNC_KINDS)[number];

/** settings.proxy1024：password / sessionToken 为密文字段（回显 SECRET_MASK，库内加密） */
export const proxy1024SettingSchema = z.object({
  enabled: z.boolean().default(false),
  email: z.string().trim().max(254).default(''),
  /** SECRET */
  password: secretSettingString(256).default(''),
  /** SECRET：控制台会话 zero_sid */
  sessionToken: secretSettingString(512).default(''),
  lang: z.enum(['en', 'zh']).default('en'),
  /** 单笔上限（美分，按未折扣价比较）；0 = 禁止采购 */
  maxOrderCents: z.number().int().min(0).max(10_000_00).default(0),
  /** 24 小时滚动上限（美分）；0 = 禁止采购 */
  maxDailyCents: z.number().int().min(0).max(100_000_00).default(0),
  quoteTtlMinutes: z.number().int().min(1).max(60).default(15),
});
export type Proxy1024Setting = z.infer<typeof proxy1024SettingSchema>;

const skuSchema = z.string().trim().max(64);

export const proxy1024QuoteRequestSchema = z.discriminatedUnion('product', [
  z.object({
    product: z.literal('static_isp'),
    items: z
      .array(z.object({
        country: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,4}$/, '国家/地区代码非法'),
        days: z.union([z.literal(7), z.literal(30), z.literal(90)]),
        count: z.number().int().min(1).max(500),
      }))
      .min(1)
      .max(20),
  }),
  z.object({ product: z.literal('unlimited_port'), sku: skuSchema, quantity: z.number().int().min(1).max(999) }),
  z.object({ product: z.literal('unlimited_bandwidth'), sku: skuSchema, quantity: z.literal(1).default(1) }),
  z.object({ product: z.literal('residential_flow'), sku: skuSchema, quantity: z.number().int().min(1).max(1000) }),
]);
export type Proxy1024QuoteRequest = z.infer<typeof proxy1024QuoteRequestSchema>;

/** 确认下单：expectedCents 必须等于报价单的 estimateCents（防止管理员看到的价格与实际下单不一致） */
export const proxy1024ConfirmRequestSchema = z.object({ expectedCents: z.number().int().min(1) });
export type Proxy1024ConfirmRequest = z.infer<typeof proxy1024ConfirmRequestSchema>;

export const proxy1024ResolveRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('abandon') }),
  z.object({ action: z.literal('attach_order_no'), orderNo: z.string().trim().min(1).max(64) }),
  /** 已付款订单：管理员在库存中核对过代理后手动标记已交付（不调用供应商） */
  z.object({ action: z.literal('mark_fulfilled') }),
]);
export type Proxy1024ResolveRequest = z.infer<typeof proxy1024ResolveRequestSchema>;

/** GET /api/admin/proxy-1024/orders */
export const listProxyOrdersQuerySchema = z.object({
  cursor: z.preprocess((v) => (v === '' ? undefined : v), z.string().max(64).optional()),
  limit: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().min(1).max(200).optional()).default(50),
  status: z.preprocess((v) => (v === '' ? undefined : v), z.enum(PROXY_ORDER_STATUSES).optional()),
});
export type ListProxyOrdersQuery = z.infer<typeof listProxyOrdersQuerySchema>;

/** 人工拖动滑块后提交的位置 */
export const proxy1024LoginRequestSchema = z.object({
  captchaId: z.string().min(1).max(128),
  x: z.number().int().min(0).max(2000),
  y: z.number().int().min(0).max(2000),
});
export type Proxy1024LoginRequest = z.infer<typeof proxy1024LoginRequestSchema>;

export const proxy1024SyncRequestSchema = z.object({
  kinds: z.array(z.enum(PROXY1024_SYNC_KINDS)).min(1).default([...PROXY1024_SYNC_KINDS]),
  orderId: z.number().int().positive().optional(),
});
export type Proxy1024SyncRequest = z.infer<typeof proxy1024SyncRequestSchema>;

export const proxy1024GenerateStickyRequestSchema = z.object({
  /** 已存在的子账号（来自 /sub-users） */
  subUser: z.string().trim().min(1).max(64),
  /** host:port；缺省用 /traffic/server 的第一项 */
  gateway: z.string().trim().max(253).optional(),
  country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, '国家需为两位代码'),
  state: z.string().trim().max(64).optional(),
  city: z.string().trim().max(64).optional(),
  minutes: z.number().int().min(1).max(120).default(30),
  count: z.number().int().min(1).max(500),
  protocol: z.enum(['http', 'socks5']).default('http'),
  maxBindings: z.number().int().min(1).max(1000).default(1),
});
export type Proxy1024GenerateStickyRequest = z.infer<typeof proxy1024GenerateStickyRequestSchema>;

export type Proxy1024SessionState = 'ok' | 'missing' | 'invalid' | 'error' | 'unknown';

export interface Proxy1024Status {
  enabled: boolean;
  configured: boolean;
  session: Proxy1024SessionState;
  email: string;
  balanceCents: number | null;
  checkedAt: string | null;
  lastError: string;
  caps: { maxOrderCents: number; maxDailyCents: number; spentLast24hCents: number };
  purchasingAllowed: boolean;
}

/** 滑块验证码：图片为 data: URI */
export interface Proxy1024Captcha {
  captchaId: string;
  masterImage: string;
  tileImage: string;
  tileWidth: number;
  tileHeight: number;
  initialX: number;
  initialY: number;
}

export interface Proxy1024CatalogueItem {
  product: Proxy1024Product;
  sku: string;
  label: string;
  days: number | null;
  country: string | null;
  unitPriceCents: number;
  minQuantity: number;
  maxQuantity: number;
}

export interface Proxy1024Catalogue {
  items: Proxy1024CatalogueItem[];
  fetchedAt: string;
  source: 'pricing_pages';
}

export interface ProxyOrderView {
  id: number;
  status: ProxyOrderStatus;
  product: Proxy1024Product;
  sku: string;
  quantity: number;
  orderSpec: string;
  estimateCents: number;
  capBasisCents: number;
  actualCents: number | null;
  balanceCentsAtQuote: number | null;
  quoteExpiresAt: string;
  orderNo: string | null;
  /** 仅管理员可见，已解密 */
  checkoutUrl: string | null;
  lastError: string;
  materializedCount: number;
  createdBy: number;
  confirmedBy: number | null;
  confirmedAt: string | null;
  orderedAt: string | null;
  paidAt: string | null;
  checkedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** PROXY_ORDER_WARNINGS 之一 */
  warnings: ProxyOrderWarning[];
}

export interface Proxy1024SubUser {
  username: string;
  title: string;
  trafficBytes: number | null;
}

export interface Proxy1024SyncResult {
  created: number;
  updated: number;
  expired: number;
}
