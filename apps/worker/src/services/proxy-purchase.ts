import {
  PROXY_ORDER_ACTIVE_FOR_CAP,
  formatCents,
  type CursorPage,
  type ListProxyOrdersQuery,
  type Proxy1024Captcha,
  type Proxy1024Catalogue,
  type Proxy1024ConfirmRequest,
  type Proxy1024GenerateStickyRequest,
  type Proxy1024LoginRequest,
  type Proxy1024Product,
  type Proxy1024QuoteRequest,
  type Proxy1024ResolveRequest,
  type Proxy1024SessionState,
  type Proxy1024Status,
  type Proxy1024SubUser,
  type Proxy1024SyncKind,
  type Proxy1024SyncRequest,
  type Proxy1024SyncResult,
  type ProxyOrderStatus,
  type ProxyOrderView,
  type ProxyOrderWarning,
  type Settings,
} from '@hpc-mail/shared';
import { AppError } from '../lib/errors.js';
import { decodeCursor, encodeCursor } from '../lib/pagination.js';
import { openSecret, sealSecret } from '../lib/secret-box.js';
import type { AuthUser, Env } from '../types.js';
import { logAdminAction } from './audit.js';
import {
  Proxy1024Error,
  createProxy1024Client,
  parseVendorTime,
  type Proxy1024CatalogueEntry,
  type Proxy1024Client,
  type Proxy1024PurchaseRecord,
  type Unlimited1024Row,
} from './proxy1024-client.js';
import { upsertProviderProxies, type ProviderProxyRow } from './proxy-inventory.js';
import { getSettingsFresh, readVendorSecrets, writeVendorSecret } from './setting.js';

/**
 * 1024proxy 采购（DESIGN §5.3 / §6）：quote → 管理员确认（= 下单，拿到结账链接）→ awaiting_payment →（管理员在 1024 结账页
 * 手动付款）→ paid → fulfilled。
 *
 * 金额安全：
 * - 功能开关 + 会话 token + 两个上限 > 0 才允许采购；上限 0 = 禁止。
 * - 确认必须回显报价金额；确认时重新读价格与余额，涨价/余额不足一律不下单。
 * - 单笔与 24 小时滚动上限在同一条 CAS UPDATE 里判定，并发确认只有一个能进入 ordering。
 * - order* 每个订单最多调用一次；结果不明 → unknown，永不自动重试，只能由只读对账或管理员带证据处理。
 * - 余额支付与钱包充值永不自动化（D6）。
 */

type Actor = Pick<AuthUser, 'id' | 'username'>;
const SYSTEM_ACTOR: Actor = { id: 0, username: 'system' };
const PROVIDER = '1024proxy';
const ORDERING_LEASE_MS = 120_000;
const RECONCILE_LEASE_MS = 60_000;
const DAY_MS = 86_400_000;
const CATALOGUE_TTL_MS = 10 * 60_000;
const UNPAID_FLAG_MS = 7 * DAY_MS;
const RECONCILE_INTERVAL_MS = 4 * 60_000;
/**
 * 无限端口/带宽订单本地识别到付款后超过它仍未识别到服务器：cron 不再自动整账户同步，等管理员核对后标记已交付（供应商称 2 分钟内部署）。
 * 按 updated_at 计（进入 paid 时写入本地时间，之后的对账/提示不改它）；不按供应商 pay_time（时区未核实，且付款可能早于本地发现）。
 */
const MATERIALISE_GIVE_UP_MS = DAY_MS;
/** 付款后超过它仍未识别到服务器就在订单上提示管理员核对 */
const MATERIALISE_WARN_MS = 30 * 60_000;
const SERVER_PRODUCTS_SQL = "('unlimited_port', 'unlimited_bandwidth')";
const SYNC_PAGE_SIZE = 100;
const SYNC_MAX_PAGES = 20;
const CAP_STATUS_SQL = PROXY_ORDER_ACTIVE_FOR_CAP.map((s) => `'${s}'`).join(', ');

/** 外部依赖注入（测试用）；生产默认真实客户端 + Date.now */
export interface Proxy1024Deps {
  client?: Proxy1024Client;
  fetch?: typeof fetch;
  now?: () => number;
}

/** 客户端节流间隔与超时；测试可调小 */
export const proxy1024Runtime = { minIntervalMs: 300, timeoutMs: 14_000 };

interface Config {
  settings: Settings['proxy1024'];
  password: string;
  sessionToken: string;
}

async function loadConfig(env: Env): Promise<Config> {
  return readVendorSecrets(env, 'proxy1024');
}

function clientFor(config: Config, deps: Proxy1024Deps, token = config.sessionToken): Proxy1024Client {
  return deps.client ?? createProxy1024Client({
    token, lang: config.settings.lang, fetch: deps.fetch, minIntervalMs: proxy1024Runtime.minIntervalMs, timeoutMs: proxy1024Runtime.timeoutMs,
  });
}

function nowOf(deps: Proxy1024Deps): number {
  return deps.now ? deps.now() : Date.now();
}

function requireEnabled(config: Config): void {
  if (!config.settings.enabled) throw new AppError('not_configured', '1024proxy 采购未启用');
}

function requireSession(config: Config): void {
  requireEnabled(config);
  if (!config.sessionToken) throw new AppError('not_configured', '1024proxy 会话未配置：请粘贴会话 token 或登录');
}

function requirePurchasing(config: Config): void {
  requireSession(config);
  if (config.settings.maxOrderCents <= 0 || config.settings.maxDailyCents <= 0) {
    throw new AppError('not_configured', '采购上限未配置（单笔与 24 小时上限都必须大于 0）');
  }
}

// ───────────────────────────── integration_status ─────────────────────────────

interface IntegrationRow { state: string; detail: string; balance_cents: number | null; checked_at: number | null }

async function readIntegration(env: Env): Promise<IntegrationRow | null> {
  return env.db.prepare("SELECT state, detail, balance_cents, checked_at FROM integration_status WHERE provider = 'proxy1024'").first<IntegrationRow>();
}

async function writeIntegration(env: Env, state: Proxy1024SessionState, detail: string, balanceCents: number | null, now: number): Promise<void> {
  const previous = await readIntegration(env);
  await env.db.prepare(`INSERT INTO integration_status (provider, state, detail, balance_cents, checked_at) VALUES ('proxy1024', ?, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET state = excluded.state, detail = excluded.detail,
        balance_cents = COALESCE(excluded.balance_cents, integration_status.balance_cents), checked_at = excluded.checked_at`)
    .bind(state, detail.slice(0, 500), balanceCents, now).run();
  if (state === 'invalid' && previous?.state !== 'invalid') {
    await logAdminAction(env, SYSTEM_ACTOR, 'proxy_1024.session_invalid', 'proxy1024');
  }
}

/** 供应商错误 → AppError；会话失效顺带把集成状态标 invalid */
async function vendorFailure(env: Env, error: unknown, now: number): Promise<AppError> {
  if (error instanceof AppError) return error;
  if (error instanceof Proxy1024Error) {
    switch (error.kind) {
      case 'session_invalid':
        await writeIntegration(env, 'invalid', '会话已失效', null, now);
        return new AppError('upstream_failed', '1024proxy 会话已失效，请重新登录或更新会话 token');
      case 'captcha_image_required':
        return new AppError('upstream_failed', '请先在 1024proxy 官网登录一次后再试');
      case 'rejected':
        return new AppError('upstream_failed', `1024proxy：${error.vendorMessage || error.message}`);
      case 'rate_limited':
        return new AppError('rate_limited', '1024proxy 限流，请稍后再试');
      default:
        return new AppError('upstream_failed', error.message);
    }
  }
  console.error('1024proxy 调用异常:', error instanceof Error ? error.message : String(error));
  return new AppError('upstream_failed', '1024proxy 调用失败');
}

async function spentLast24h(env: Env, now: number): Promise<number> {
  const row = await env.db.prepare(`SELECT COALESCE(SUM(COALESCE(actual_cents, cap_basis_cents)), 0) AS spent FROM proxy_orders
      WHERE status IN (${CAP_STATUS_SQL}) AND confirmed_at >= ?`).bind(now - DAY_MS).first<{ spent: unknown }>();
  return Number(row?.spent ?? 0);
}

// ───────────────────────────── 状态 / 登录 ─────────────────────────────

export async function proxy1024Status(env: Env, opts: { live?: boolean } = {}, deps: Proxy1024Deps = {}): Promise<Proxy1024Status> {
  const now = nowOf(deps);
  let config: Config;
  let configError = '';
  try {
    config = await loadConfig(env);
  } catch (e) {
    // 密文无法解密（换了密钥）：按未配置展示，提示重新填写
    config = { settings: (await getSettingsFresh(env)).proxy1024, password: '', sessionToken: '' };
    configError = e instanceof Error ? e.message : String(e);
  }
  const { settings } = config;
  if (opts.live && settings.enabled && config.sessionToken) {
    try {
      const member = await clientFor(config, deps).getMember();
      await writeIntegration(env, 'ok', member.email, member.balanceCents, now);
    } catch (e) {
      if (e instanceof Proxy1024Error && e.kind === 'session_invalid') await writeIntegration(env, 'invalid', '会话已失效', null, now);
      else await writeIntegration(env, 'error', e instanceof Error ? e.message : '1024proxy 调用失败', null, now);
    }
  }
  const [row, spent] = await Promise.all([readIntegration(env), spentLast24h(env, now)]);
  const configured = Boolean(config.sessionToken);
  const session: Proxy1024SessionState = !configured ? 'missing' : ((row?.state as Proxy1024SessionState | undefined) ?? 'unknown');
  return {
    enabled: settings.enabled,
    configured,
    session,
    email: session === 'ok' ? (row?.detail || settings.email) : settings.email,
    balanceCents: row?.balance_cents === null || row?.balance_cents === undefined ? null : Number(row.balance_cents),
    checkedAt: row?.checked_at ? new Date(Number(row.checked_at)).toISOString() : null,
    lastError: configError || (session !== 'ok' && row ? row.detail : ''),
    caps: { maxOrderCents: settings.maxOrderCents, maxDailyCents: settings.maxDailyCents, spentLast24hCents: spent },
    purchasingAllowed: settings.enabled && configured && session === 'ok' && settings.maxOrderCents > 0 && settings.maxDailyCents > 0,
  };
}

/** 邮箱+密码登录第一步：取滑块验证码（管理员在后台拖动，人工完成；不做自动破解） */
export async function startProxy1024Login(env: Env, _actor: Actor, deps: Proxy1024Deps = {}): Promise<Proxy1024Captcha> {
  const config = await loadConfig(env);
  requireEnabled(config);
  if (!config.settings.email || !config.password) throw new AppError('not_configured', '请先在配置里填写 1024proxy 账号邮箱和密码');
  try {
    return await clientFor(config, deps, '').getSlideCaptcha();
  } catch (e) {
    throw await vendorFailure(env, e, nowOf(deps));
  }
}

export async function completeProxy1024Login(env: Env, actor: Actor, req: Proxy1024LoginRequest, ip = '', deps: Proxy1024Deps = {}): Promise<Proxy1024Status> {
  const config = await loadConfig(env);
  requireEnabled(config);
  if (!config.settings.email || !config.password) throw new AppError('not_configured', '请先在配置里填写 1024proxy 账号邮箱和密码');
  const now = nowOf(deps);
  let token: string;
  try {
    ({ token } = await clientFor(config, deps, '').signin({ email: config.settings.email, password: config.password, captchaId: req.captchaId, x: req.x, y: req.y }));
  } catch (e) {
    throw await vendorFailure(env, e, now);
  }
  await writeVendorSecret(env, 'proxy1024', 'sessionToken', token);
  try {
    const member = await clientFor(config, deps, token).getMember();
    await writeIntegration(env, 'ok', member.email || config.settings.email, member.balanceCents, now);
  } catch {
    await writeIntegration(env, 'ok', config.settings.email, null, now);
  }
  await logAdminAction(env, actor, 'proxy_1024.login', 'proxy1024', config.settings.email, ip);
  return proxy1024Status(env, {}, deps);
}

// ───────────────────────────── 目录 / 定价 ─────────────────────────────

let catalogueCache: { items: Proxy1024CatalogueEntry[]; fetchedAt: number } | null = null;

/** 测试用：清空进程内目录缓存 */
export function resetProxy1024CatalogueCache(): void {
  catalogueCache = null;
}

async function loadCatalogue(client: Proxy1024Client, now: number, bypassCache: boolean): Promise<{ items: Proxy1024CatalogueEntry[]; fetchedAt: number }> {
  if (!bypassCache && catalogueCache && catalogueCache.fetchedAt + CATALOGUE_TTL_MS > now) return catalogueCache;
  const items = await client.fetchCatalogue();
  catalogueCache = { items, fetchedAt: now };
  return catalogueCache;
}

export async function getProxy1024Catalogue(env: Env, deps: Proxy1024Deps = {}): Promise<Proxy1024Catalogue> {
  const config = await loadConfig(env);
  requireEnabled(config);
  const now = nowOf(deps);
  try {
    const { items, fetchedAt } = await loadCatalogue(clientFor(config, deps), now, false);
    return {
      items: items.map(({ capUnitCents: _cap, ...item }) => item),
      fetchedAt: new Date(fetchedAt).toISOString(),
      source: 'pricing_pages',
    };
  } catch (e) {
    throw await vendorFailure(env, e, now);
  }
}

interface PricedOrder {
  product: Proxy1024Product;
  sku: string;
  quantity: number;
  orderSpec: string;
  estimateCents: number;
  capBasisCents: number;
}

/** 静态 ISP 客户端批量折扣（P§3）：1–10 ×0.95，11–40 ×0.90，41–100 ×0.85，101+ ×0.80（服务端为准） */
function staticDiscountPercent(count: number): number {
  if (count <= 10) return 95;
  if (count <= 40) return 90;
  if (count <= 100) return 85;
  return 80;
}

type PriceInput =
  | { product: 'static_isp'; items: { country: string; days: number; count: number }[] }
  | { product: Exclude<Proxy1024Product, 'static_isp'>; sku: string; quantity: number };

function priceOrder(catalogue: Proxy1024CatalogueEntry[], input: PriceInput): PricedOrder {
  if (input.product === 'static_isp') {
    const seen = new Set<string>();
    let list = 0;
    let cap = 0;
    let count = 0;
    for (const item of input.items) {
      const key = `${item.country}-${item.days}`;
      if (seen.has(key)) throw new AppError('validation_failed', `重复的国家/时长：${key}`);
      seen.add(key);
      const entry = catalogue.find((e) => e.product === 'static_isp' && e.country === item.country && e.days === item.days);
      if (!entry) throw new AppError('validation_failed', `1024proxy 未提供 ${item.country} ${item.days} 天的静态 ISP`);
      list += entry.unitPriceCents * item.count;
      cap += entry.capUnitCents * item.count;
      count += item.count;
    }
    return {
      product: 'static_isp', sku: '', quantity: count,
      orderSpec: input.items.map((i) => `${i.country}-${i.days}-${i.count}`).join(','),
      estimateCents: Math.max(1, Math.ceil((list * staticDiscountPercent(count)) / 100)),
      capBasisCents: Math.max(cap, list),
    };
  }
  const entry = catalogue.find((e) => e.product === input.product && e.sku === input.sku);
  if (!entry) throw new AppError('validation_failed', `1024proxy 目录中没有 ${input.sku}`);
  if (input.quantity < entry.minQuantity || input.quantity > entry.maxQuantity) {
    throw new AppError('validation_failed', `${input.sku} 的数量需在 ${entry.minQuantity}-${entry.maxQuantity} 之间`);
  }
  return {
    product: input.product, sku: input.sku, quantity: input.quantity, orderSpec: '',
    estimateCents: entry.unitPriceCents * input.quantity,
    capBasisCents: Math.max(entry.capUnitCents, entry.unitPriceCents) * input.quantity,
  };
}

function parseOrderSpec(spec: string): { country: string; days: number; count: number }[] {
  return spec.split(',').filter(Boolean).map((part) => {
    const m = /^([A-Z0-9]{2,4})-(\d+)-(\d+)$/.exec(part);
    if (!m) throw new AppError('internal', `订单规格非法：${part}`);
    return { country: m[1]!, days: Number(m[2]), count: Number(m[3]) };
  });
}

function priceInputOfRow(row: OrderRow): PriceInput {
  return row.product === 'static_isp'
    ? { product: 'static_isp', items: parseOrderSpec(row.order_spec) }
    : { product: row.product as Exclude<Proxy1024Product, 'static_isp'>, sku: row.sku, quantity: Number(row.quantity) };
}

// ───────────────────────────── 订单行 / 视图 ─────────────────────────────

interface OrderRow {
  id: number;
  status: ProxyOrderStatus;
  product: Proxy1024Product;
  sku: string;
  quantity: number;
  order_spec: string;
  estimate_cents: number;
  cap_basis_cents: number;
  actual_cents: number | null;
  balance_cents_at_quote: number | null;
  quote_expires_at: number;
  order_no: string | null;
  checkout_url_enc: string;
  lease_until: number | null;
  last_error: string;
  materialized_count: number;
  created_by: number;
  confirmed_by: number | null;
  confirmed_at: number | null;
  ordered_at: number | null;
  paid_at: number | null;
  checked_at: number | null;
  updated_at: number;
  created_at: number;
}

const n = (v: unknown) => Number(v ?? 0);
const nn = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const isoOrNull = (v: unknown) => (v === null || v === undefined ? null : new Date(Number(v)).toISOString());

async function loadOrder(env: Env, id: number): Promise<OrderRow> {
  const row = await env.db.prepare('SELECT * FROM proxy_orders WHERE id = ?').bind(id).first<OrderRow>();
  if (!row) throw new AppError('not_found', '订单不存在');
  return row;
}

async function toOrderView(env: Env, row: OrderRow): Promise<ProxyOrderView> {
  const warnings: ProxyOrderWarning[] = [];
  let checkoutUrl: string | null = null;
  if (row.checkout_url_enc) {
    try {
      checkoutUrl = await openSecret(env, row.checkout_url_enc);
    } catch {
      warnings.push('checkout_url_unreadable');
    }
  }
  if (row.status === 'awaiting_payment' || row.status === 'unknown') warnings.push('payment_manual');
  if (row.status === 'unknown' || row.status === 'awaiting_payment' || row.status === 'ordering') warnings.push('maybe_charged');
  if (row.actual_cents !== null && n(row.actual_cents) > n(row.estimate_cents)) warnings.push('actual_exceeds_estimate');
  return {
    id: n(row.id),
    status: row.status,
    product: row.product,
    sku: row.sku,
    quantity: n(row.quantity),
    orderSpec: row.order_spec,
    estimateCents: n(row.estimate_cents),
    capBasisCents: n(row.cap_basis_cents),
    actualCents: nn(row.actual_cents),
    balanceCentsAtQuote: nn(row.balance_cents_at_quote),
    quoteExpiresAt: new Date(n(row.quote_expires_at)).toISOString(),
    orderNo: row.order_no ?? null,
    checkoutUrl,
    lastError: row.last_error,
    materializedCount: n(row.materialized_count),
    createdBy: n(row.created_by),
    confirmedBy: nn(row.confirmed_by),
    confirmedAt: isoOrNull(row.confirmed_at),
    orderedAt: isoOrNull(row.ordered_at),
    paidAt: isoOrNull(row.paid_at),
    checkedAt: isoOrNull(row.checked_at),
    createdAt: new Date(n(row.created_at)).toISOString(),
    updatedAt: new Date(n(row.updated_at)).toISOString(),
    warnings,
  };
}

export async function getProxyOrder(env: Env, id: number): Promise<ProxyOrderView> {
  return toOrderView(env, await loadOrder(env, id));
}

export async function listProxyOrders(env: Env, q: Partial<ListProxyOrdersQuery>): Promise<CursorPage<ProxyOrderView>> {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const where: string[] = [];
  const params: unknown[] = [];
  const cursor = decodeCursor(q.cursor);
  if (q.cursor && cursor === null) throw new AppError('validation_failed', '游标非法');
  if (cursor !== null) { where.push('id < ?'); params.push(cursor); }
  if (q.status) { where.push('status = ?'); params.push(q.status); }
  const { results } = await env.db.prepare(`SELECT * FROM proxy_orders${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`)
    .bind(...params, limit + 1).all<OrderRow>();
  const rows = results.slice(0, limit);
  return {
    items: await Promise.all(rows.map((r) => toOrderView(env, r))),
    nextCursor: results.length > limit ? encodeCursor(n(rows[rows.length - 1]!.id)) : null,
  };
}

// ───────────────────────────── 报价 / 确认 ─────────────────────────────

export async function quoteProxyOrder(env: Env, actor: Actor, req: Proxy1024QuoteRequest, ip = '', deps: Proxy1024Deps = {}): Promise<ProxyOrderView> {
  const config = await loadConfig(env);
  requirePurchasing(config);
  const now = nowOf(deps);
  const client = clientFor(config, deps);
  let catalogue: Proxy1024CatalogueEntry[];
  try {
    catalogue = (await loadCatalogue(client, now, false)).items;
  } catch (e) {
    throw await vendorFailure(env, e, now);
  }
  const priced = priceOrder(catalogue, req.product === 'static_isp'
    ? { product: 'static_isp', items: req.items }
    : { product: req.product, sku: req.sku, quantity: req.quantity });
  const { maxOrderCents, maxDailyCents, quoteTtlMinutes } = config.settings;
  if (priced.capBasisCents > maxOrderCents) {
    throw new AppError('validation_failed', `报价上限基准 ${formatCents(priced.capBasisCents)} 超过单笔上限 ${formatCents(maxOrderCents)}`);
  }
  const spent = await spentLast24h(env, now);
  if (priced.capBasisCents + spent > maxDailyCents) {
    throw new AppError('validation_failed', `24 小时内已用 ${formatCents(spent)}，本单将超过 24 小时上限 ${formatCents(maxDailyCents)}`);
  }
  let balance: number | null = null;
  try {
    const member = await client.getMember();
    balance = member.balanceCents;
    await writeIntegration(env, 'ok', member.email, member.balanceCents, now);
  } catch (e) {
    // 会话失效直接报错；余额暂时读不到不影响报价（确认时会再读）
    if (e instanceof Proxy1024Error && e.kind === 'session_invalid') throw await vendorFailure(env, e, now);
  }
  const inserted = await env.db.prepare(`INSERT INTO proxy_orders (status, product, sku, quantity, order_spec, estimate_cents, cap_basis_cents,
        balance_cents_at_quote, quote_expires_at, created_by, updated_at, created_at)
      VALUES ('quoted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .bind(priced.product, priced.sku, priced.quantity, priced.orderSpec, priced.estimateCents, priced.capBasisCents, balance,
      now + quoteTtlMinutes * 60_000, actor.id, now, now)
    .first<{ id: number }>();
  if (!inserted) throw new AppError('internal', '报价创建失败');
  await logAdminAction(env, actor, 'proxy_1024.quote', `proxy_order:${inserted.id}`,
    `${priced.product} ${priced.sku || priced.orderSpec} qty=${priced.quantity} estimate=${priced.estimateCents} cap=${priced.capBasisCents}`, ip);
  return getProxyOrder(env, n(inserted.id));
}

async function expireQuote(env: Env, id: number, now: number): Promise<void> {
  await env.db.prepare("UPDATE proxy_orders SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'quoted' AND quote_expires_at <= ?")
    .bind(now, id, now).run();
}

/**
 * 确认 = 下单（一个管理员动作）。顺序：校验 → 重新读价格/余额 → CAS（含上限）进入 ordering → createOrder 一次 → 写结果。
 * createOrder 结果不明 → unknown（永不重试）。
 */
export async function confirmProxyOrder(env: Env, actor: Actor, id: number, req: Proxy1024ConfirmRequest, ip = '', deps: Proxy1024Deps = {}): Promise<ProxyOrderView> {
  const config = await loadConfig(env);
  requirePurchasing(config);
  const now = nowOf(deps);
  const row = await loadOrder(env, id);
  if (row.status !== 'quoted') throw new AppError('conflict', `订单当前状态为 ${row.status}，不能确认`);
  if (n(row.quote_expires_at) <= now) {
    await expireQuote(env, id, now);
    throw new AppError('conflict', '报价已过期，请重新报价');
  }
  if (req.expectedCents !== n(row.estimate_cents)) throw new AppError('conflict', '确认金额与报价不一致，请刷新后重新确认');

  const client = clientFor(config, deps);
  // 1) 重新读价格（绕过缓存）与余额：任何一项读不到都不下单
  let fresh: PricedOrder;
  let balance: number | null;
  try {
    fresh = priceOrder((await loadCatalogue(client, now, true)).items, priceInputOfRow(row));
    const member = await client.getMember();
    balance = member.balanceCents;
    await writeIntegration(env, 'ok', member.email, member.balanceCents, now);
  } catch (e) {
    if (e instanceof AppError && e.code === 'validation_failed') {
      throw new AppError('conflict', `价格已变化：${e.message}，请重新报价`);
    }
    throw await vendorFailure(env, e, now);
  }
  if (fresh.estimateCents > n(row.estimate_cents) || fresh.capBasisCents > n(row.cap_basis_cents)) {
    await env.db.prepare(`UPDATE proxy_orders SET estimate_cents = ?, cap_basis_cents = ?, balance_cents_at_quote = ?, quote_expires_at = ?, updated_at = ?
        WHERE id = ? AND status = 'quoted'`)
      .bind(fresh.estimateCents, fresh.capBasisCents, balance, now + config.settings.quoteTtlMinutes * 60_000, now, id).run();
    throw new AppError('conflict', `价格已变化（${formatCents(n(row.estimate_cents))} → ${formatCents(fresh.estimateCents)}），请重新确认`);
  }
  if (balance !== null && balance < n(row.estimate_cents)) {
    throw new AppError('conflict', `余额不足（${formatCents(balance)}），请先在 1024proxy 手动充值`);
  }

  // 2) CAS：状态、报价有效期、金额仍是管理员确认的那一份（并发确认可能已按新价格改写报价）、单笔与 24 小时上限同一条语句判定
  const claimed = await env.db.prepare(`UPDATE proxy_orders SET status = 'ordering', confirmed_by = ?1, confirmed_at = ?2, lease_until = ?3, updated_at = ?2
      WHERE id = ?4 AND status = 'quoted' AND quote_expires_at > ?2 AND cap_basis_cents <= ?5
        AND estimate_cents = ?8 AND cap_basis_cents = ?9
        AND cap_basis_cents + (SELECT COALESCE(SUM(COALESCE(o.actual_cents, o.cap_basis_cents)), 0) FROM proxy_orders o
          WHERE o.status IN (${CAP_STATUS_SQL}) AND o.confirmed_at >= ?6) <= ?7
      RETURNING id`)
    .bind(actor.id, now, now + ORDERING_LEASE_MS, id, config.settings.maxOrderCents, now - DAY_MS, config.settings.maxDailyCents,
      req.expectedCents, n(row.cap_basis_cents))
    .first<{ id: number }>();
  if (!claimed) {
    const current = await loadOrder(env, id);
    if (current.status !== 'quoted') throw new AppError('conflict', '订单已被确认或状态已变化');
    if (n(current.estimate_cents) !== req.expectedCents || n(current.cap_basis_cents) !== n(row.cap_basis_cents)) {
      throw new AppError('conflict', `价格已变化（${formatCents(req.expectedCents)} → ${formatCents(n(current.estimate_cents))}），请刷新后重新确认`);
    }
    if (n(current.quote_expires_at) <= now) {
      await expireQuote(env, id, now);
      throw new AppError('conflict', '报价已过期，请重新报价');
    }
    if (n(current.cap_basis_cents) > config.settings.maxOrderCents) {
      throw new AppError('validation_failed', `超过单笔上限 ${formatCents(config.settings.maxOrderCents)}`);
    }
    throw new AppError('validation_failed', `超过 24 小时采购上限 ${formatCents(config.settings.maxDailyCents)}`);
  }
  const detail = `${row.product} ${row.sku || row.order_spec} qty=${row.quantity} cents=${row.estimate_cents}`;
  await logAdminAction(env, actor, 'proxy_1024.order_confirm', `proxy_order:${id}`, detail, ip);

  // 3) 唯一一次下单调用
  let outcome: { kind: 'created'; checkoutUrl: string; orderNo: string | null } | { kind: 'failed' | 'unknown'; message: string; session?: boolean };
  try {
    const created = await client.createOrder({ product: row.product, sku: row.sku, quantity: n(row.quantity), orderSpec: row.order_spec });
    outcome = { kind: 'created', checkoutUrl: created.checkoutUrl, orderNo: created.orderNo };
  } catch (e) {
    if (e instanceof Proxy1024Error && e.kind === 'rejected') outcome = { kind: 'failed', message: `1024proxy 拒绝下单：${e.vendorMessage || e.message}` };
    else if (e instanceof Proxy1024Error && e.kind === 'session_invalid') outcome = { kind: 'failed', message: '1024proxy 会话已失效，未下单', session: true };
    else outcome = { kind: 'unknown', message: `下单结果不明：${e instanceof Error ? e.message : String(e)}` };
  }

  const done = Date.now();
  if (outcome.kind === 'created') {
    let sealed = '';
    try {
      sealed = await sealSecret(env, outcome.checkoutUrl);
    } catch (e) {
      console.error('结账链接加密失败:', e instanceof Error ? e.message : String(e));
    }
    const write = (orderNo: string | null) => env.db.prepare(`UPDATE proxy_orders SET status = 'awaiting_payment', order_no = ?, checkout_url_enc = ?, ordered_at = ?,
        lease_until = NULL, last_error = '', updated_at = ? WHERE id = ? AND status IN ('ordering', 'unknown') RETURNING id`)
      .bind(orderNo, sealed, done, done, id).first();
    try {
      await write(outcome.orderNo);
    } catch {
      // order_no 与已有行冲突（极少见）：先不记订单号，交给对账
      await write(null);
    }
    await logAdminAction(env, actor, 'proxy_1024.order_created', `proxy_order:${id}`, `${detail} order_no=${outcome.orderNo ?? ''}`, ip);
  } else if (outcome.kind === 'failed') {
    await env.db.prepare(`UPDATE proxy_orders SET status = 'failed', lease_until = NULL, last_error = ?, updated_at = ? WHERE id = ? AND status = 'ordering'`)
      .bind(outcome.message.slice(0, 500), done, id).run();
    if (outcome.session) await writeIntegration(env, 'invalid', '会话已失效', null, done);
    await logAdminAction(env, actor, 'proxy_1024.order_failed', `proxy_order:${id}`, `${detail} ${outcome.message}`.slice(0, 500), ip);
  } else {
    await env.db.prepare(`UPDATE proxy_orders SET status = 'unknown', lease_until = NULL, last_error = ?, updated_at = ? WHERE id = ? AND status = 'ordering'`)
      .bind(outcome.message.slice(0, 500), done, id).run();
    await logAdminAction(env, actor, 'proxy_1024.order_unknown', `proxy_order:${id}`, detail, ip);
  }
  return getProxyOrder(env, id);
}

export async function cancelProxyOrder(env: Env, actor: Actor, id: number, ip = ''): Promise<ProxyOrderView> {
  const now = Date.now();
  const updated = await env.db.prepare("UPDATE proxy_orders SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'quoted' RETURNING id")
    .bind(now, id).first();
  if (!updated) {
    const row = await loadOrder(env, id);
    throw new AppError('conflict', `订单当前状态为 ${row.status}，只能取消未确认的报价`);
  }
  await logAdminAction(env, actor, 'proxy_1024.order_cancel', `proxy_order:${id}`, 'cancel', ip);
  return getProxyOrder(env, id);
}

/**
 * 管理员处理 awaiting_payment / unknown：
 * - abandon：放弃跟踪（不调用供应商）；
 * - attach_order_no：必须在 1024 购买记录里查到该订单号（实时证据）才挂上。
 */
export async function resolveProxyOrder(env: Env, actor: Actor, id: number, req: Proxy1024ResolveRequest, ip = '', deps: Proxy1024Deps = {}): Promise<ProxyOrderView> {
  const row = await loadOrder(env, id);
  const now = nowOf(deps);
  if (req.action === 'mark_fulfilled') {
    // 只改本地状态、不调用供应商：管理员已在库存里核对到该订单的代理（或确认无需再同步）
    const updated = await env.db.prepare(`UPDATE proxy_orders SET status = 'fulfilled', lease_until = NULL, last_error = '', updated_at = ?
        WHERE id = ? AND status = 'paid' AND COALESCE(lease_until, 0) < ? RETURNING id`).bind(now, id, now).first();
    if (!updated) throw new AppError('conflict', row.status === 'paid' ? '订单正在对账中，请稍后再试' : `订单当前状态为 ${row.status}，只有已付款的订单可以标记已交付`);
    await logAdminAction(env, actor, 'proxy_1024.order_resolve', `proxy_order:${id}`, 'mark_fulfilled', ip);
    return getProxyOrder(env, id);
  }
  if (req.action === 'abandon') {
    const updated = await env.db.prepare(`UPDATE proxy_orders SET status = 'abandoned', lease_until = NULL, updated_at = ? WHERE id = ? AND status IN ('awaiting_payment', 'unknown') RETURNING id`)
      .bind(now, id).first();
    if (!updated) throw new AppError('conflict', `订单当前状态为 ${row.status}，不能放弃`);
    await logAdminAction(env, actor, 'proxy_1024.order_resolve', `proxy_order:${id}`, 'abandon', ip);
    return getProxyOrder(env, id);
  }
  if (row.status !== 'unknown' && row.status !== 'awaiting_payment') {
    throw new AppError('conflict', `订单当前状态为 ${row.status}，不能关联订单号`);
  }
  if (row.order_no === req.orderNo) throw new AppError('conflict', '订单已关联该订单号');
  const config = await loadConfig(env);
  requireSession(config);
  const taken = await env.db.prepare('SELECT id FROM proxy_orders WHERE order_no = ? AND id <> ?').bind(req.orderNo, id).first();
  if (taken) throw new AppError('conflict', '该订单号已关联到其他订单');
  let record: Proxy1024PurchaseRecord | undefined;
  try {
    const client = clientFor(config, deps);
    // 已有订单号（下单响应里解析出来的，UNVERIFIED）只有在消费记录里查不到时才允许替换
    if (row.order_no) {
      const { items } = await client.getPurchaseRecords({ orderNo: row.order_no, page: 1, limit: 10 });
      if (items.some((r) => r.orderNo === row.order_no)) {
        throw new AppError('conflict', `当前订单号 ${row.order_no} 已在 1024proxy 消费记录中确认，不能替换`);
      }
    }
    const { items } = await client.getPurchaseRecords({ orderNo: req.orderNo, page: 1, limit: 10 });
    record = items.find((r) => r.orderNo === req.orderNo);
  } catch (e) {
    throw await vendorFailure(env, e, now);
  }
  if (!record) throw new AppError('conflict', '1024proxy 购买记录中找不到该订单号');
  const expected = row.status;
  const attached = await env.db.prepare(`UPDATE proxy_orders SET order_no = ?, status = 'awaiting_payment', lease_until = NULL, last_error = '', ordered_at = COALESCE(ordered_at, ?), updated_at = ?
      WHERE id = ? AND status = ? AND COALESCE(order_no, '') = ? RETURNING id`).bind(req.orderNo, now, now, id, expected, row.order_no ?? '').first();
  if (!attached) throw new AppError('conflict', '订单状态已变化，请刷新');
  await logAdminAction(env, actor, 'proxy_1024.order_resolve', `proxy_order:${id}`,
    `attach_order_no ${req.orderNo}${row.order_no ? ` replaces ${row.order_no}` : ''}`, ip);
  await applyRecord(env, { ...(await loadOrder(env, id)) }, record, now);
  return getProxyOrder(env, id);
}

// ───────────────────────────── 对账 / 交付 ─────────────────────────────

/** 预算：单次 cron 的供应商调用次数与截止时间；超出时抛 transient（状态不变，下次再来） */
interface Budget { calls: number; deadline: number }

function budgeted(client: Proxy1024Client, budget: Budget): Proxy1024Client {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (budget.calls <= 0 || Date.now() > budget.deadline) throw new Proxy1024Error('transient', '本轮对账预算已用完');
        budget.calls--;
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

function vendorDay(ms: number): string {
  // 供应商时区未知（UNVERIFIED）：按 UTC+8 取日期，查询窗口前后各放宽一天
  return new Date(ms + 8 * 3_600_000).toISOString().slice(0, 10);
}

/** 把购买记录的支付状态落到订单上（只按 expected status 守卫写入） */
async function applyRecord(env: Env, row: OrderRow, record: Proxy1024PurchaseRecord, now: number): Promise<void> {
  const target = `proxy_order:${row.id}`;
  if (record.payStatus === 'paid') {
    const paidAt = parseVendorTime(record.payTime) ?? now;
    const updated = await env.db.prepare(`UPDATE proxy_orders SET status = 'paid', actual_cents = ?, paid_at = ?, last_error = '', checked_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('awaiting_payment', 'unknown') RETURNING id`)
      .bind(record.trueCents, paidAt, now, now, row.id).first();
    if (updated) {
      await logAdminAction(env, SYSTEM_ACTOR, 'proxy_1024.order_paid', target, `actual=${record.trueCents ?? 'unknown'}`);
      if (record.trueCents !== null && record.trueCents > n(row.cap_basis_cents)) {
        await logAdminAction(env, SYSTEM_ACTOR, 'proxy_1024.order_overcharge', target, `actual=${record.trueCents} cap_basis=${row.cap_basis_cents}`);
      }
    }
  } else if (record.payStatus === 'refunded') {
    await env.db.prepare(`UPDATE proxy_orders SET status = 'abandoned', last_error = '1024proxy 已退款', checked_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('awaiting_payment', 'unknown', 'paid')`).bind(now, now, row.id).run();
  } else if (row.status === 'unknown') {
    await env.db.prepare(`UPDATE proxy_orders SET status = 'awaiting_payment', last_error = '', ordered_at = COALESCE(ordered_at, confirmed_at), checked_at = ?, updated_at = ?
        WHERE id = ? AND status = 'unknown'`).bind(now, now, row.id).run();
  }
}

/** 无订单号时按 金额 ±1 美分 + 时间窗 唯一匹配（UNVERIFIED：记录 name 格式未知，不参与匹配） */
async function matchRecord(env: Env, client: Proxy1024Client, row: OrderRow): Promise<Proxy1024PurchaseRecord | null> {
  const confirmedAt = n(row.confirmed_at ?? row.created_at);
  const { items } = await client.getPurchaseRecords({ page: 1, limit: 50, start: vendorDay(confirmedAt - DAY_MS), end: vendorDay(confirmedAt + DAY_MS) });
  const numbers = items.map((r) => r.orderNo).filter(Boolean);
  const attached = new Set<string>();
  if (numbers.length) {
    const { results } = await env.db.prepare('SELECT order_no FROM proxy_orders WHERE order_no IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(numbers)).all<{ order_no: string }>();
    for (const r of results) attached.add(r.order_no);
  }
  const candidates = items.filter((r) => {
    if (!r.orderNo || attached.has(r.orderNo) || r.trueCents === null) return false;
    if (Math.abs(r.trueCents - n(row.estimate_cents)) > 1) return false;
    const at = parseVendorTime(r.payTime);
    return at === null || (at >= confirmedAt - 10 * 60_000 && at <= confirmedAt + UNPAID_FLAG_MS);
  });
  return candidates.length === 1 ? candidates[0]! : null;
}

/** 对一笔订单做一次只读对账（加租约，多副本只有一个在跑）。返回是否处理了该订单。 */
async function reconcileOrder(env: Env, client: Proxy1024Client, id: number, now: number): Promise<boolean> {
  const row = await env.db.prepare(`UPDATE proxy_orders SET lease_until = ?1 WHERE id = ?2 AND status IN ('awaiting_payment', 'unknown', 'paid')
      AND COALESCE(lease_until, 0) < ?3 RETURNING *`).bind(now + RECONCILE_LEASE_MS, id, now).first<OrderRow>();
  if (!row) return false;
  try {
    if (row.status === 'awaiting_payment' || row.status === 'unknown') {
      let record: Proxy1024PurchaseRecord | null = null;
      if (row.order_no) {
        const { items } = await client.getPurchaseRecords({ orderNo: row.order_no, page: 1, limit: 10 });
        record = items.find((r) => r.orderNo === row.order_no) ?? null;
      } else {
        record = await matchRecord(env, client, row);
        if (record) {
          try {
            const attached = await env.db.prepare(`UPDATE proxy_orders SET order_no = ?, updated_at = ? WHERE id = ? AND status = ? AND order_no IS NULL RETURNING id`)
              .bind(record.orderNo, now, row.id, row.status).first();
            if (!attached) record = null;
            else await logAdminAction(env, SYSTEM_ACTOR, 'proxy_1024.order_resolve', `proxy_order:${row.id}`, `matched order_no ${record.orderNo}`);
          } catch {
            record = null;
          }
        }
      }
      if (record) await applyRecord(env, row, record, now);
      else if (row.status === 'awaiting_payment' && row.ordered_at !== null && now - n(row.ordered_at) > UNPAID_FLAG_MS) {
        await env.db.prepare("UPDATE proxy_orders SET last_error = '未支付超过 7 天' WHERE id = ? AND status = 'awaiting_payment'").bind(row.id).run();
      }
    }
    const current = await loadOrder(env, n(row.id));
    if (current.status === 'paid') await materialiseOrder(env, client, current, now);
  } finally {
    await env.db.prepare('UPDATE proxy_orders SET lease_until = NULL, checked_at = ? WHERE id = ? AND status <> \'ordering\'').bind(now, row.id).run();
  }
  return true;
}

/** 已付款订单交付：无限端口/带宽同步服务器；住宅流量是额度（直接 fulfilled）；静态 ISP 等管理员分配 */
async function materialiseOrder(env: Env, client: Proxy1024Client, row: OrderRow, now: number): Promise<void> {
  if (row.product === 'residential_flow') {
    await env.db.prepare("UPDATE proxy_orders SET status = 'fulfilled', updated_at = ? WHERE id = ? AND status = 'paid'").bind(now, row.id).run();
    return;
  }
  if (row.product === 'static_isp') return;
  const result = await syncKind(env, client, row.product, n(row.id), now);
  const adopted = await adoptUnlinked(env, row, row.product);
  if (result.created + adopted > 0) {
    await markMaterialised(env, n(row.id), result.created + adopted, now);
  } else if (now - n(row.updated_at) > MATERIALISE_WARN_MS) {
    // 付款满 24 小时后 cron 不再为它整账户同步（见 runProxy1024Cron），管理员可手动刷新/同步或标记已交付
    await env.db.prepare(`UPDATE proxy_orders SET last_error = ? WHERE id = ? AND status = 'paid'`)
      .bind('付款后仍未识别到该订单的新服务器（可能已被其他订单或整账户同步认领）；24 小时后停止自动同步，请在库存中核对后标记已交付', row.id).run();
  }
}

/**
 * 认领「下单之后才入库、尚未关联订单」的同产品代理（管理员先做了不带订单的整账户同步时，服务器已入库，
 * 对账时 created = 0）。按入库时间判断，不按供应商时间（UNVERIFIED：服务器列表没有可靠的创建时间字段）。
 */
async function adoptUnlinked(env: Env, row: OrderRow, product: string): Promise<number> {
  const since = row.ordered_at ?? row.confirmed_at;
  if (since === null || since === undefined) return 0;
  const { results } = await env.db.prepare(`UPDATE proxies SET order_id = ?1 WHERE provider = ?2 AND product = ?3 AND order_id IS NULL
      AND created_at >= ?4 RETURNING id`).bind(row.id, PROVIDER, product, n(since)).all<{ id: number }>();
  return results.length;
}

async function markMaterialised(env: Env, orderId: number, created: number, now: number): Promise<void> {
  await env.db.prepare(`UPDATE proxy_orders SET materialized_count = materialized_count + ?, status = CASE WHEN status = 'paid' THEN 'fulfilled' ELSE status END, updated_at = ?
      WHERE id = ? AND status IN ('paid', 'fulfilled')`).bind(created, now, orderId).run();
}

function hostPortOf(row: Unlimited1024Row): { host: string; port: number } | null {
  const domain = row.domain.trim().toLowerCase();
  const m = /^([a-z0-9.-]+):(\d{1,5})$/.exec(domain);
  if (m) return { host: m[1]!, port: Number(m[2]) };
  const host = domain || row.ip.trim().toLowerCase();
  if (!host || !row.port) return null;
  return { host, port: row.port };
}

async function syncKind(env: Env, client: Proxy1024Client, kind: Proxy1024SyncKind, orderId: number | null, now: number): Promise<Proxy1024SyncResult> {
  const rows: ProviderProxyRow[] = [];
  for (let page = 1; page <= SYNC_MAX_PAGES; page++) {
    if (kind === 'static_isp') {
      const { items, total } = await client.listStaticIps({ page, size: SYNC_PAGE_SIZE });
      for (const ip of items) {
        if (!ip.id || !ip.ip || !ip.port) continue;
        rows.push({
          provider: PROVIDER, providerRef: `static:${ip.id}`, protocol: 'http', host: ip.ip, port: ip.port, username: ip.username,
          password: ip.password, product: 'static_isp', country: /^[A-Z]{2}$/.test(ip.country) ? ip.country : '', region: ip.region,
          city: ip.city, expiresAt: ip.expiresAt,
        });
      }
      if (items.length < SYNC_PAGE_SIZE || page * SYNC_PAGE_SIZE >= total) break;
    } else {
      const list = kind === 'unlimited_port' ? client.listPortServers.bind(client) : client.listBandwidthServers.bind(client);
      const { items, total } = await list({ page, pageSize: SYNC_PAGE_SIZE });
      for (const server of items) {
        const endpoint = hostPortOf(server);
        if (!server.id || server.isDemo || !endpoint) continue;
        rows.push({
          provider: PROVIDER, providerRef: `${kind === 'unlimited_port' ? 'port' : 'bw'}:${server.id}`, protocol: 'http',
          host: endpoint.host, port: endpoint.port, username: server.username, password: server.password, product: kind,
          country: '', region: server.region, city: '', expiresAt: server.expiresAt,
        });
      }
      if (items.length < SYNC_PAGE_SIZE || page * SYNC_PAGE_SIZE >= total) break;
    }
  }
  const { created, updated } = await upsertProviderProxies(env, rows, orderId);
  return { created, updated, expired: rows.filter((r) => r.expiresAt !== null && r.expiresAt <= now).length };
}

export async function refreshProxyOrder(env: Env, _actor: Actor, id: number, deps: Proxy1024Deps = {}): Promise<ProxyOrderView> {
  const config = await loadConfig(env);
  requireSession(config);
  const now = nowOf(deps);
  const row = await loadOrder(env, id);
  if (row.status === 'ordering') {
    await recoverOrdering(env, now);
    return getProxyOrder(env, id);
  }
  if (!['awaiting_payment', 'unknown', 'paid'].includes(row.status)) return toOrderView(env, row);
  try {
    const handled = await reconcileOrder(env, clientFor(config, deps), id, now);
    if (!handled) throw new AppError('conflict', '订单正在对账中，请稍后再试');
  } catch (e) {
    throw await vendorFailure(env, e, now);
  }
  return getProxyOrder(env, id);
}

// ───────────────────────────── 库存同步 / 静态分配 / 粘性会话 ─────────────────────────────

export async function syncProxy1024Inventory(env: Env, actor: Actor, req: Proxy1024SyncRequest, ip = '', deps: Proxy1024Deps = {}): Promise<Proxy1024SyncResult> {
  const config = await loadConfig(env);
  requireSession(config);
  const now = nowOf(deps);
  let order: OrderRow | null = null;
  if (req.orderId) {
    order = await loadOrder(env, req.orderId);
    if (order.status !== 'paid' && order.status !== 'fulfilled') throw new AppError('conflict', '只能为已付款的订单同步库存');
  }
  const client = clientFor(config, deps);
  const total: Proxy1024SyncResult = { created: 0, updated: 0, expired: 0 };
  try {
    for (const kind of [...new Set(req.kinds)]) {
      const r = await syncKind(env, client, kind, req.orderId ?? null, now);
      total.created += r.created;
      total.updated += r.updated;
      total.expired += r.expired;
    }
  } catch (e) {
    throw await vendorFailure(env, e, now);
  }
  if (order && req.orderId) {
    const adopted = order.product !== 'residential_flow' && req.kinds.includes(order.product as Proxy1024SyncKind)
      ? await adoptUnlinked(env, order, order.product) : 0;
    if (total.created + adopted > 0) await markMaterialised(env, req.orderId, total.created + adopted, now);
  }
  await logAdminAction(env, actor, 'proxy_1024.sync', 'proxy1024', `kinds=${req.kinds.join(',')} created=${total.created} updated=${total.updated} expired=${total.expired}${req.orderId ? ` order=${req.orderId}` : ''}`, ip);
  return total;
}

const ALLOCATE_MARK = '[allocate]';

/**
 * UNVERIFIED（P§11 #8）：静态 ISP 付款后从余额分配具体 IP。每个订单只允许尝试一次（结果不明时不重复分配，
 * 改由管理员同步库存或在 1024 控制台核对）。分配消耗的是已付费的 IP 余额，不产生新扣款。
 */
export async function allocateStaticForOrder(env: Env, actor: Actor, orderId: number, ip = '', deps: Proxy1024Deps = {}): Promise<Proxy1024SyncResult> {
  const config = await loadConfig(env);
  requireSession(config);
  const now = nowOf(deps);
  const claimed = await env.db.prepare(`UPDATE proxy_orders SET lease_until = ?, last_error = ?, updated_at = ?
      WHERE id = ? AND status = 'paid' AND product = 'static_isp' AND materialized_count = 0
        AND last_error NOT LIKE '[allocate]%' AND COALESCE(lease_until, 0) < ? RETURNING *`)
    .bind(now + 5 * 60_000, `${ALLOCATE_MARK} 分配中`, now, orderId, now).first<OrderRow>();
  if (!claimed) {
    const row = await loadOrder(env, orderId);
    if (row.product !== 'static_isp') throw new AppError('conflict', '只有静态 ISP 订单需要分配');
    if (row.status !== 'paid') throw new AppError('conflict', `订单当前状态为 ${row.status}，不能分配`);
    throw new AppError('conflict', '该订单已尝试过分配，请改用「同步库存」核对');
  }
  const client = clientFor(config, deps);
  const items = parseOrderSpec(claimed.order_spec);
  let allocated = 0;
  let error = '';
  try {
    for (const item of items) {
      if (item.days !== 7 && item.days !== 30 && item.days !== 90) throw new AppError('internal', `不支持的时长 ${item.days}`);
      const inventory = await client.listStaticInventory({ code: item.country });
      const ids = inventory.slice(0, item.count).map((r) => r.id);
      if (ids.length < item.count) throw new Proxy1024Error('rejected', `${item.country} 可分配 IP 不足（${ids.length}/${item.count}）`);
      await client.allocateStaticIps({ code: item.country, ids, day: item.days });
      allocated += ids.length;
    }
  } catch (e) {
    error = e instanceof Proxy1024Error && e.kind === 'unknown' ? '分配结果不明，请同步库存核对' : (e instanceof Error ? e.message : String(e));
  }
  let result: Proxy1024SyncResult = { created: 0, updated: 0, expired: 0 };
  if (!error || allocated > 0) {
    try {
      result = await syncKind(env, client, 'static_isp', orderId, now);
    } catch (e) {
      error ||= `分配后同步失败：${e instanceof Error ? e.message : String(e)}`;
    }
  }
  if (result.created > 0) await markMaterialised(env, orderId, result.created, now);
  await env.db.prepare('UPDATE proxy_orders SET lease_until = NULL, last_error = ?, updated_at = ? WHERE id = ?')
    .bind(`${ALLOCATE_MARK} ${error || `已分配 ${allocated} 个`}`.slice(0, 500), Date.now(), orderId).run();
  await logAdminAction(env, actor, 'proxy_1024.allocate', 'proxy1024', `order=${orderId} allocated=${allocated} created=${result.created}${error ? ` error=${error}` : ''}`.slice(0, 500), ip);
  if (error && result.created === 0) throw new AppError('upstream_failed', error);
  return result;
}

export async function listProxy1024SubUsers(env: Env, deps: Proxy1024Deps = {}): Promise<Proxy1024SubUser[]> {
  const config = await loadConfig(env);
  requireSession(config);
  try {
    return await clientFor(config, deps).listSubUsers();
  } catch (e) {
    throw await vendorFailure(env, e, nowOf(deps));
  }
}

/** 1024 前端 El(n) 的字母表（P§7.1）：去掉易混字符 */
const SID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz123456789';

export function randomSid(length = 8): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let sid = '';
  for (const b of bytes) sid += SID_ALPHABET[b % SID_ALPHABET.length];
  return sid;
}

/** `{user}-region-{CC}[-st-{State}][-city-{City}]-sid-{8}-t-{minutes}`（P§7.1） */
export function stickyUsername(i: { subUser: string; country: string; state?: string; city?: string; sid: string; minutes: number }): string {
  return `${i.subUser}-region-${i.country}${i.state ? `-st-${i.state}` : ''}${i.city ? `-city-${i.city}` : ''}-sid-${i.sid}-t-${i.minutes}`;
}

/** 生成动态住宅粘性会话代理（不采购）：每个 sid 一行库存 */
export async function generateStickyProxies(env: Env, actor: Actor, req: Proxy1024GenerateStickyRequest, ip = '', deps: Proxy1024Deps = {}): Promise<{ created: number }> {
  const config = await loadConfig(env);
  requireSession(config);
  const now = nowOf(deps);
  if (/[-\s]/.test(req.subUser)) throw new AppError('validation_failed', '子账号名不能含 - 或空白');
  if (req.state && req.state.includes('-')) throw new AppError('validation_failed', '州名不能含 -');
  if (req.city && req.city.includes('-')) throw new AppError('validation_failed', '城市名不能含 -');
  const client = clientFor(config, deps);
  let password: string;
  let gateway: string;
  try {
    password = await client.getSubUserPassword(req.subUser);
    gateway = req.gateway || (await client.listTrafficGateways())[0]?.hostname || '';
  } catch (e) {
    throw await vendorFailure(env, e, now);
  }
  const m = /^([a-z0-9.-]+):(\d{1,5})$/i.exec(gateway.trim());
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 65535) throw new AppError('validation_failed', `网关需为 host:port（${gateway || '未取到网关'}）`);
  const rows: ProviderProxyRow[] = [];
  for (let i = 0; i < req.count; i++) {
    const sid = randomSid();
    rows.push({
      provider: PROVIDER, providerRef: `sub:${req.subUser}:sid:${sid}`, protocol: req.protocol, host: m[1]!.toLowerCase(), port: Number(m[2]),
      username: stickyUsername({ subUser: req.subUser, country: req.country, state: req.state, city: req.city, sid, minutes: req.minutes }),
      password, product: 'residential_sticky', country: req.country, region: req.state ?? '', city: req.city ?? '', expiresAt: null,
      maxBindings: req.maxBindings, label: `${req.subUser} ${req.country}${req.city ? ` ${req.city}` : ''}`.slice(0, 100),
    });
  }
  const { created } = await upsertProviderProxies(env, rows, null);
  await logAdminAction(env, actor, 'proxy_1024.generate', 'proxy1024', `sub=${req.subUser} country=${req.country} created=${created}`, ip);
  return { created };
}

// ───────────────────────────── cron ─────────────────────────────

/** ordering 且租约已过（进程在下单途中中断）→ unknown，永不重试 */
async function recoverOrdering(env: Env, now: number): Promise<number> {
  const { results } = await env.db.prepare(`UPDATE proxy_orders SET status = 'unknown', lease_until = NULL, last_error = '下单结果不明（进程中断），请在 1024proxy 核对', updated_at = ?
      WHERE status = 'ordering' AND COALESCE(lease_until, 0) < ? RETURNING id`).bind(now, now).all<{ id: number }>();
  for (const r of results) await logAdminAction(env, SYSTEM_ACTOR, 'proxy_1024.order_unknown', `proxy_order:${r.id}`, 'lease expired');
  return results.length;
}

/**
 * cron：过期报价 → expired；ordering 租约过期 → unknown；对账 awaiting_payment/unknown/paid（≤ 20 单、≤ 20 次供应商调用、30 秒截止）。
 * 未启用或会话失效时不调用供应商。永不调用 createOrder。
 */
export async function runProxy1024Cron(env: Env, opts: { now?: number; client?: Proxy1024Client; deadlineMs?: number; fetch?: typeof fetch } = {}): Promise<number> {
  const now = opts.now ?? Date.now();
  const [expired, recovered] = await Promise.all([
    env.db.prepare("UPDATE proxy_orders SET status = 'expired', updated_at = ? WHERE status = 'quoted' AND quote_expires_at <= ? RETURNING id").bind(now, now).all(),
    recoverOrdering(env, now),
  ]);
  let touched = expired.results.length + recovered;
  let config: Config;
  try {
    config = await loadConfig(env);
  } catch {
    return touched;
  }
  if (!config.settings.enabled || !config.sessionToken) return touched;
  const integration = await readIntegration(env);
  if (integration?.state === 'invalid') return touched;
  const { results } = await env.db.prepare(`SELECT id FROM proxy_orders WHERE status IN ('awaiting_payment', 'unknown', 'paid')
      AND COALESCE(lease_until, 0) < ? AND COALESCE(checked_at, 0) <= ?
      AND NOT (status = 'paid' AND product IN ${SERVER_PRODUCTS_SQL} AND updated_at < ?)
      ORDER BY COALESCE(checked_at, 0), id LIMIT 20`)
    .bind(now, now - RECONCILE_INTERVAL_MS, now - MATERIALISE_GIVE_UP_MS).all<{ id: number }>();
  if (!results.length) return touched;
  const budget: Budget = { calls: 20, deadline: Date.now() + (opts.deadlineMs ?? 30_000) };
  const client = budgeted(clientFor(config, { client: opts.client, fetch: opts.fetch }), budget);
  for (const { id } of results) {
    if (budget.calls <= 0 || Date.now() > budget.deadline) break;
    try {
      if (await reconcileOrder(env, client, n(id), now)) touched++;
    } catch (e) {
      if (e instanceof Proxy1024Error && e.kind === 'session_invalid') {
        await writeIntegration(env, 'invalid', '会话已失效', null, now);
        break;
      }
      console.error(`1024 订单 ${id} 对账失败:`, e instanceof Error ? e.message : String(e));
    }
  }
  return touched;
}
