import {
  DOMAIN_ITEM_CHARGED_FOR_CAP, DOMAIN_ITEM_IN_FLIGHT, DOMAIN_ITEM_TERMINAL, MAX_DOMAIN_QUOTE_NAMES, MAX_SYSTEM_DOMAINS, domainSchema,
  type CursorPage, type DomainConfirmRequest, type DomainItemAction, type DomainItemResolveRequest, type DomainItemStatus,
  type DomainItemStep, type DomainPurchaseBatchView, type DomainPurchaseItemView, type DomainPurchaseStatus, type DomainQuoteRequest,
  type ListDomainBatchesQuery, type RegistrantContactRequest, type Settings, type SpaceshipCredentialTest, SECRET_MASK,
} from '@hpc-mail/shared';
import { and, asc, desc, eq, lt } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { domainPurchaseBatches, domainPurchaseItems } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import { decodeCursor, encodeCursor } from '../lib/pagination.js';
import { openSecret } from '../lib/secret-box.js';
import type { AuthUser, Env, ExecCtx } from '../types.js';
import { logAdminAction } from './audit.js';
import {
  CloudflareApiError, catchAllTargetsWorker, cloudflareCredentials, countZones, createZone, enableRouting, findZone, getCatchAll,
  getRouting, getZone, isTransientCloudflareError, putCatchAll, requestActivationCheck, type CloudflareCredentials,
} from './cloudflare.js';
import { bumpCounter, minuteWindow } from './rate-counter.js';
import { getSettingsFresh, updateSettings } from './setting.js';
import { SpaceshipError, createSpaceshipClient, type SpaceshipClient, type SsAvailability, type SsPrice } from './spaceship-client.js';

/**
 * Spaceship 批量采购域名（docs/integrations/DESIGN.md §5.5）。
 *
 * 报价 → 管理员确认（复核可用性/价格、单域名/单批/24 小时上限、系统域名名额、报价有效期）→
 * cron 逐个推进：注册（唯一花钱的一步，CAS 后最多 POST 一次）→ 轮询异步操作 → 建 Cloudflare zone →
 * 在 Spaceship 改 NS → zone 生效 → Email Routing + catch-all 指向收件 Worker → 加入 settings.domains.list。
 * 注册结果不明一律记 unknown，只靠只读核对或管理员带实时证据的裁决推进，绝不自动重新注册。
 */

type ItemRow = typeof domainPurchaseItems.$inferSelect;
type BatchRow = typeof domainPurchaseBatches.$inferSelect;
type Actor = Pick<AuthUser, 'id' | 'username'>;
type SpaceshipSettings = Settings['spaceship'];

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const SYSTEM_ACTOR = { id: 0, username: 'system' };
/** 确认中批次的租约；确认只做只读调用，过期后 cron 退回 quoted */
const CONFIRM_LEASE_MS = 120 * SECOND;
/** 非花钱步骤的行租约 */
const STEP_LEASE_MS = 120 * SECOND;
/** 注册租约：过期仍无操作号 → unknown */
const REGISTER_LEASE_MS = 300 * SECOND;
const RETRY_DELAY_MS = 5 * MINUTE;
const UNKNOWN_RECHECK_MS = 30 * MINUTE;
const OP_PENDING_WARN_MS = DAY;
/** 从 Spaceship 设置 NS 起算的生效期限（管理员重试 nameservers 会重新设置并重新计时） */
const NS_TIMEOUT_MS = 7 * DAY;
/** 已确认条目的有效期：超过仍未发起注册即作废（不扣费），需重新报价 */
const CONFIRMED_MAX_AGE_MS = DAY;
/** ns_set 期间每 12 次核对（约 1 小时）请求一次 Cloudflare 复查 */
const ACTIVATION_CHECK_EVERY = 12;
/** 账户级异步操作查询 60 次 / 300 秒，留余量给管理员刷新与多副本 */
const POLL_LIMIT_PER_5_MIN = 50;
/** 报价/确认时 429 的 Retry-After 不超过它就等一次 */
const MAX_INLINE_RETRY_AFTER_SEC = 5;
const REFRESH_MIN_INTERVAL_MS = 60 * SECOND;
const CRON_DUE_LIMIT = 30;
const CRON_DEADLINE_MS = 60 * SECOND;

/** failed_step → 管理员重试时回到的状态；register / poll 不可重试（需重新报价） */
const RETRY_TARGET: Partial<Record<DomainItemStep, DomainItemStatus>> = {
  zone: 'registered',
  nameservers: 'zone_created',
  routing: 'zone_active',
  catch_all: 'zone_active',
  domain_add: 'routing_ready',
};

/** 常量状态表拼成 SQL 字面量列表（只用于共享常量，不接受外部输入） */
const sqlList = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ');
const IN_FLIGHT_SQL = sqlList(DOMAIN_ITEM_IN_FLIGHT);
const TERMINAL_SQL = sqlList(DOMAIN_ITEM_TERMINAL);
const CHARGED_SQL = sqlList(DOMAIN_ITEM_CHARGED_FOR_CAP);
/**
 * 24 小时台账：窗口内确认的批次、或窗口内才发起注册的条目（确认较早、延后注册的也算进注册当时的窗口），
 * 取计费状态的条目，加上注册成功后才失败的条目。
 */
const ledgerSql = (since: string) => `SELECT COALESCE(SUM(i.cap_basis_cents), 0) FROM domain_purchase_items i
  JOIN domain_purchase_batches b ON b.id = i.batch_id
  WHERE (b.confirmed_at >= ${since} OR i.register_attempted_at >= ${since})
    AND (i.status IN (${CHARGED_SQL}) OR (i.status = 'failed' AND i.failed_step NOT IN ('register', 'poll')))`;

export interface DomainPurchaseDeps {
  spaceship: SpaceshipClient;
  cf: CloudflareCredentials | null;
  now: () => number;
  /** 报价/确认遇到短 Retry-After 时的等待（测试注入） */
  sleep?: (ms: number) => Promise<void>;
  /** 注册联系人；缺省时直读设置 */
  registrantContactId?: string;
}

export interface DomainCronBudget {
  registers: number;
  polls: number;
  zoneCreates: number;
  deadline: number;
}

type AdvanceResult = 'advanced' | 'waiting' | 'skipped' | 'failed';

// ---------------------------------------------------------------------------
// 配置与依赖

interface Config {
  all: Settings;
  settings: SpaceshipSettings;
  apiKey: string;
  apiSecret: string;
}

async function loadConfig(env: Env): Promise<Config> {
  const all = await getSettingsFresh(env);
  const settings = all.spaceship;
  const [apiKey, apiSecret] = await Promise.all([openSecret(env, settings.apiKey), openSecret(env, settings.apiSecret)]);
  return { all, settings, apiKey, apiSecret };
}

function ingressWorker(env: Env, settings: SpaceshipSettings): { name: string; source: 'setting' | 'env' } | null {
  if (settings.ingressWorkerName) return { name: settings.ingressWorkerName, source: 'setting' };
  const fromEnv = env.worker_name?.trim();
  return fromEnv ? { name: fromEnv, source: 'env' } : null;
}

/** catch-all 指向收件 Worker 的 Cloudflare 凭据（D10）；不用 cloudflareCredentials 的 'hpc-cloud-mail' 兜底 */
export function domainPurchaseCloudflare(env: Env, settings: SpaceshipSettings): { creds: CloudflareCredentials; source: 'setting' | 'env' } | null {
  const base = cloudflareCredentials(env);
  const ingress = ingressWorker(env, settings);
  if (!base || !ingress) return null;
  return { creds: { ...base, workerName: ingress.name }, source: ingress.source };
}

function buildDeps(env: Env, cfg: Config, partial: Partial<DomainPurchaseDeps> = {}): DomainPurchaseDeps {
  return {
    spaceship: partial.spaceship ?? createSpaceshipClient({ apiKey: cfg.apiKey, apiSecret: cfg.apiSecret }),
    cf: partial.cf !== undefined ? partial.cf : (domainPurchaseCloudflare(env, cfg.settings)?.creds ?? null),
    now: partial.now ?? Date.now,
    sleep: partial.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    registrantContactId: partial.registrantContactId ?? cfg.settings.registrantContactId,
  };
}

const capsSet = (s: SpaceshipSettings) => s.maxDomainCents > 0 && s.maxBatchCents > 0 && s.maxDailyCents > 0;

/** 不允许采购的原因（空 = 可以采购） */
function purchaseReasons(env: Env, cfg: Config): string[] {
  const s = cfg.settings;
  const reasons: string[] = [];
  if (!s.enabled) reasons.push('未启用域名采购');
  if (!cfg.apiKey || !cfg.apiSecret) reasons.push('未配置 Spaceship API Key / Secret');
  if (!s.registrantContactId) reasons.push('未设置注册联系人');
  if (!cloudflareCredentials(env)) reasons.push('服务器未配置 Cloudflare 凭据（CF_API_TOKEN / CF_ACCOUNT_ID）');
  if (!ingressWorker(env, s)) reasons.push('未配置收件 Worker 名称（spaceship.ingressWorkerName 或 CF_EMAIL_WORKER_NAME）');
  if (!capsSet(s)) reasons.push('单域名 / 单批 / 24 小时上限未设置（0 表示禁止采购）');
  return reasons;
}

function requireQuotable(cfg: Config): void {
  if (!cfg.settings.enabled) throw new AppError('not_configured', '未启用域名采购');
  if (!cfg.apiKey || !cfg.apiSecret) throw new AppError('not_configured', '未配置 Spaceship API Key / Secret');
  if (!capsSet(cfg.settings)) throw new AppError('not_configured', '单域名 / 单批 / 24 小时上限未设置（0 表示禁止采购）');
}

function requireCredentials(cfg: Config): void {
  if (!cfg.apiKey || !cfg.apiSecret) throw new AppError('not_configured', '未配置 Spaceship API Key / Secret');
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}

/** 供应商错误转成接口错误（信息只含供应商返回的原因，不含凭据） */
function toAppError(error: unknown): Error {
  if (error instanceof AppError) return error;
  if (error instanceof SpaceshipError) {
    if (error.outcome === 'rate_limited') return new AppError('rate_limited', 'Spaceship 限流，请稍后再试');
    if (error.status === 401 || error.status === 403) return new AppError('upstream_failed', `Spaceship 拒绝了凭据或权限不足：${error.message}`);
    if (error.outcome === 'rejected' || error.outcome === 'not_found') return new AppError('upstream_failed', error.message);
    return new AppError('upstream_failed', `Spaceship 暂时不可用：${error.message}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

/** 管理员同步调用：短 Retry-After 的 429 等一次再试，其余错误转接口错误 */
async function vendor<T>(deps: DomainPurchaseDeps, task: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await task();
    } catch (error) {
      const wait = error instanceof SpaceshipError && error.outcome === 'rate_limited' ? (error.retryAfterSec ?? 1) : null;
      if (attempt === 0 && wait !== null && wait <= MAX_INLINE_RETRY_AFTER_SEC) {
        await deps.sleep!(Math.max(wait, 1) * SECOND);
        continue;
      }
      throw toAppError(error);
    }
  }
}

// ---------------------------------------------------------------------------
// 视图

const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null);
const MAYBE_CHARGED: readonly DomainItemStatus[] = ['registering', 'unknown'];

function itemActions(row: ItemRow): DomainItemAction[] {
  const actions: DomainItemAction[] = [];
  if (row.status === 'failed' && RETRY_TARGET[row.failedStep as DomainItemStep]) actions.push('retry');
  if (row.status === 'unknown') actions.push('resolve');
  if ((DOMAIN_ITEM_IN_FLIGHT as readonly string[]).includes(row.status) && row.status !== 'confirmed') actions.push('refresh');
  return actions;
}

export function toItemView(row: ItemRow): DomainPurchaseItemView {
  return {
    id: row.id, batchId: row.batchId, domain: row.domain, status: row.status, availability: row.availability,
    skipReason: row.skipReason, priceClass: row.priceClass, finalCents: row.finalCents, regularCents: row.regularCents,
    capBasisCents: row.capBasisCents, operationId: row.operationId, opStatus: row.opStatus, nameServers: row.nameServers ?? [],
    zoneStatus: row.zoneStatus, routingStatus: row.routingStatus, lifecycleStatus: row.lifecycleStatus,
    verificationStatus: row.verificationStatus, suspensions: row.suspensions ?? [], failedStep: row.failedStep, lastError: row.lastError,
    errorCode: row.errorCode, vendorOperationId: row.vendorOperationId, actions: itemActions(row),
    maybeCharged: MAYBE_CHARGED.includes(row.status), registeredAt: iso(row.registeredAt), readyAt: iso(row.readyAt),
    updatedAt: iso(row.updatedAt)!,
  };
}

function toBatchView(row: BatchRow, counts: Partial<Record<DomainItemStatus, number>>, items?: ItemRow[]): DomainPurchaseBatchView {
  return {
    id: row.id, status: row.status, years: row.years, autoRenew: Boolean(row.autoRenew), privacyLevel: row.privacyLevel,
    quoteTotalCents: row.quoteTotalCents, confirmedTotalCents: row.confirmedTotalCents, quoteExpiresAt: iso(row.quoteExpiresAt)!,
    lastError: row.lastError, createdBy: row.createdBy, confirmedBy: row.confirmedBy, confirmedAt: iso(row.confirmedAt),
    completedAt: iso(row.completedAt), createdAt: iso(row.createdAt)!, counts,
    ...(items ? { items: items.map(toItemView) } : {}),
  };
}

function countItems(items: readonly Pick<ItemRow, 'status'>[]): Partial<Record<DomainItemStatus, number>> {
  const counts: Partial<Record<DomainItemStatus, number>> = {};
  for (const item of items) counts[item.status] = (counts[item.status] ?? 0) + 1;
  return counts;
}

async function loadItem(env: Env, id: number): Promise<ItemRow> {
  const row = await createDb(env).select().from(domainPurchaseItems).where(eq(domainPurchaseItems.id, id)).get();
  if (!row) throw new AppError('not_found', '采购条目不存在');
  return row;
}

export async function getDomainBatch(env: Env, id: number): Promise<DomainPurchaseBatchView> {
  const db = createDb(env);
  const [batch, items] = await Promise.all([
    db.select().from(domainPurchaseBatches).where(eq(domainPurchaseBatches.id, id)).get(),
    db.select().from(domainPurchaseItems).where(eq(domainPurchaseItems.batchId, id)).orderBy(asc(domainPurchaseItems.id)).all(),
  ]);
  if (!batch) throw new AppError('not_found', '采购批次不存在');
  return toBatchView(batch, countItems(items), items);
}

export async function listDomainBatches(env: Env, q: ListDomainBatchesQuery): Promise<CursorPage<DomainPurchaseBatchView>> {
  const db = createDb(env);
  const cursor = decodeCursor(q.cursor);
  const limit = q.limit ?? 50;
  const conditions = [
    ...(cursor ? [lt(domainPurchaseBatches.id, cursor)] : []),
    ...(q.status ? [eq(domainPurchaseBatches.status, q.status)] : []),
  ];
  const rows = await db.select().from(domainPurchaseBatches).where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(domainPurchaseBatches.id)).limit(limit + 1).all();
  const page = rows.slice(0, limit);
  const counts = new Map<number, Partial<Record<DomainItemStatus, number>>>();
  if (page.length) {
    const grouped = await env.db.prepare(`SELECT batch_id, status, COUNT(*) AS n FROM domain_purchase_items
      WHERE batch_id IN (SELECT value FROM json_each(?)) GROUP BY batch_id, status`)
      .bind(JSON.stringify(page.map((row) => row.id))).all<{ batch_id: number; status: DomainItemStatus; n: number }>();
    for (const row of grouped.results) {
      const entry = counts.get(Number(row.batch_id)) ?? {};
      entry[row.status] = Number(row.n);
      counts.set(Number(row.batch_id), entry);
    }
  }
  return {
    items: page.map((row) => toBatchView(row, counts.get(row.id) ?? {})),
    nextCursor: rows.length > limit && page.length ? encodeCursor(page[page.length - 1]!.id) : null,
  };
}

async function spentLast24h(env: Env, now: number): Promise<number> {
  const row = await env.db.prepare(`SELECT (${ledgerSql('?1')}) AS spent`).bind(now - DAY).first<{ spent: number | string }>();
  return Number(row?.spent ?? 0);
}

async function inFlightCount(env: Env): Promise<number> {
  const row = await env.db.prepare(`SELECT COUNT(*) AS n FROM domain_purchase_items WHERE status IN (${IN_FLIGHT_SQL})`).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export async function domainPurchaseStatus(env: Env): Promise<DomainPurchaseStatus> {
  const cfg = await loadConfig(env);
  const s = cfg.settings;
  const now = Date.now();
  const [spent, inFlight] = await Promise.all([spentLast24h(env, now), inFlightCount(env)]);
  const ingress = ingressWorker(env, s);
  const reasons = purchaseReasons(env, cfg);
  return {
    enabled: s.enabled,
    configured: Boolean(cfg.apiKey && cfg.apiSecret && s.registrantContactId),
    cloudflareConfigured: cloudflareCredentials(env) !== null,
    ingressWorker: ingress?.name ?? null,
    ingressWorkerSource: ingress?.source ?? null,
    caps: { maxDomainCents: s.maxDomainCents, maxBatchCents: s.maxBatchCents, maxDailyCents: s.maxDailyCents, maxBatchDomains: s.maxBatchDomains, spentLast24hCents: spent },
    systemDomains: { used: cfg.all.domains.list.length, inFlight, max: MAX_SYSTEM_DOMAINS },
    purchasingAllowed: reasons.length === 0,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// 报价

interface Evaluation {
  status: 'quoted' | 'skipped';
  availability: string;
  skipReason: string;
  priceClass: string;
  finalCents: number | null;
  regularCents: number | null;
  capBasisCents: number | null;
}

/** 可用性 + 价格 + 设置 → 是否可买。cap basis = max(final, regular)（促销可能失效，按高者算上限） */
function evaluate(result: SsAvailability['result'], price: SsPrice | undefined, s: SpaceshipSettings): Evaluation {
  const priced = price
    ? { priceClass: price.priceClass, finalCents: price.finalCents, regularCents: price.regularCents, capBasisCents: Math.max(price.finalCents, price.regularCents) }
    : { priceClass: '', finalCents: null, regularCents: null, capBasisCents: null };
  const skip = (skipReason: string): Evaluation => ({ status: 'skipped', availability: result, skipReason, ...priced });
  if (result !== 'available') return skip(result === 'taken' ? 'taken' : result === 'invalidDomainName' ? 'invalid' : result);
  if (!price) return skip('no_price');
  if (price.priceClass !== 'standard' && !s.allowPremium) return skip('premium');
  if (priced.capBasisCents! > s.maxDomainCents) return skip('over_domain_cap');
  return { status: 'quoted', availability: result, skipReason: '', ...priced };
}

/** 可用性 + 价格（只给可用的域名询价） */
async function lookupVendor(deps: DomainPurchaseDeps, names: string[], years: number, s: SpaceshipSettings): Promise<Map<string, Evaluation>> {
  const out = new Map<string, Evaluation>();
  if (!names.length) return out;
  const availability = await vendor(deps, () => deps.spaceship.checkAvailability(names));
  const result = new Map(availability.map((a) => [a.domain, a.result]));
  const available = names.filter((name) => result.get(name) === 'available');
  const prices = new Map<string, SsPrice>();
  if (available.length) {
    for (const price of await vendor(deps, () => deps.spaceship.queryPricing(available, years))) prices.set(price.domain, price);
  }
  for (const name of names) out.set(name, evaluate(result.get(name) ?? 'unexpectedError', prices.get(name), s));
  return out;
}

/** 粘贴原文 → A-label 小写域名；含路径/端口/用户信息或不合规的记为 invalid */
function normalizeDomain(raw: string): string | null {
  let value = raw.trim().toLowerCase().replace(/\.$/, '');
  if (!value || /[/:@?#\\\s]/.test(value)) return null;
  try {
    value = new URL(`http://${value}`).hostname;
  } catch {
    return null;
  }
  return domainSchema.safeParse(value).success ? value : null;
}

function splitDomains(input: DomainQuoteRequest['domains']): string[] {
  const parts = typeof input === 'string' ? input.split(/[\s,;，；、]+/) : input;
  return parts.map((part) => part.trim()).filter(Boolean);
}

interface QuoteLine extends Evaluation { domain: string }

const ITEM_INSERT_SQL = `INSERT INTO domain_purchase_items (batch_id, domain, status, availability, skip_reason, price_class, final_cents,
  regular_cents, cap_basis_cents, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`;

export async function quoteDomainPurchase(
  env: Env, actor: Actor, req: DomainQuoteRequest, ip?: string, depsIn?: Partial<DomainPurchaseDeps>,
): Promise<DomainPurchaseBatchView> {
  const cfg = await loadConfig(env);
  requireQuotable(cfg);
  const s = cfg.settings;
  const deps = buildDeps(env, cfg, depsIn);
  const now = deps.now();
  const years = req.years ?? s.years;

  const raw = splitDomains(req.domains);
  if (raw.length > MAX_DOMAIN_QUOTE_NAMES) throw new AppError('validation_failed', `单次最多粘贴 ${MAX_DOMAIN_QUOTE_NAMES} 个域名`);
  const lines: QuoteLine[] = [];
  const seen = new Set<string>();
  const candidates: string[] = [];
  const empty = { availability: '', priceClass: '', finalCents: null, regularCents: null, capBasisCents: null } as const;
  for (const entry of raw) {
    const domain = normalizeDomain(entry);
    if (!domain) {
      lines.push({ domain: entry.slice(0, 253), status: 'skipped', skipReason: 'invalid', ...empty });
      continue;
    }
    if (seen.has(domain)) {
      lines.push({ domain, status: 'skipped', skipReason: 'duplicate', ...empty });
      continue;
    }
    seen.add(domain);
    candidates.push(domain);
  }
  if (!candidates.length) throw new AppError('validation_failed', '没有可报价的域名');
  if (candidates.length > s.maxBatchDomains) throw new AppError('validation_failed', `单批最多 ${s.maxBatchDomains} 个域名`);

  // 本地排除：已是系统域名、被用户托管、已有历史地址或邮件（防止继承他人历史）、在其他批次进行中
  const listed = new Set(cfg.all.domains.list.map((entry) => entry.domain));
  const names = JSON.stringify(candidates);
  const [hosted, history, inFlight] = await env.db.batch([
    env.db.prepare('SELECT domain FROM hosted_domains WHERE domain IN (SELECT value FROM json_each(?))').bind(names),
    env.db.prepare(`SELECT j.value AS domain FROM json_each(?) j WHERE EXISTS (SELECT 1 FROM mailboxes m WHERE m.domain = j.value)
      OR EXISTS (SELECT 1 FROM messages g WHERE g.domain = j.value)`).bind(names),
    env.db.prepare(`SELECT DISTINCT domain FROM domain_purchase_items WHERE domain IN (SELECT value FROM json_each(?))
      AND status IN (${IN_FLIGHT_SQL})`).bind(names),
  ]);
  const set = (result: D1Result | undefined) => new Set(((result?.results ?? []) as { domain: string }[]).map((row) => row.domain));
  const exclusions: [Set<string>, string][] = [
    [listed, 'already_listed'], [set(hosted), 'hosted'], [set(history), 'has_history'], [set(inFlight), 'in_flight'],
  ];
  const toCheck: string[] = [];
  for (const domain of candidates) {
    const reason = exclusions.find(([names]) => names.has(domain))?.[1];
    if (reason) lines.push({ domain, status: 'skipped', skipReason: reason, ...empty });
    else toCheck.push(domain);
  }

  const evaluated = await lookupVendor(deps, toCheck, years, s);
  for (const domain of toCheck) lines.push({ domain, ...evaluated.get(domain)! });

  const total = lines.reduce((sum, line) => sum + (line.status === 'quoted' ? line.capBasisCents! : 0), 0);
  const batch = await env.db.prepare(`INSERT INTO domain_purchase_batches (status, years, auto_renew, privacy_level, quote_total_cents,
      quote_expires_at, created_by, created_at, updated_at) VALUES ('quoted', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7) RETURNING id`)
    .bind(years, s.autoRenew ? 1 : 0, s.privacyLevel, total, now + s.quoteTtlMinutes * MINUTE, actor.id, now).first<{ id: number }>();
  const batchId = Number(batch!.id);
  // 先插批次拿到 id，再一次性插入全部条目（不用 MAX(id) 反查）
  await env.db.batch(lines.map((line) => env.db.prepare(ITEM_INSERT_SQL).bind(
    batchId, line.domain, line.status, line.availability, line.skipReason, line.priceClass, line.finalCents, line.regularCents,
    line.capBasisCents, now,
  )));
  const quoted = lines.filter((line) => line.status === 'quoted').length;
  await logAdminAction(env, actor, 'domain_purchase.quote', `domain_batch:${batchId}`, `count=${quoted}/${lines.length} total_cents=${total}`, ip);
  return getDomainBatch(env, batchId);
}

// ---------------------------------------------------------------------------
// 确认

async function releaseConfirm(env: Env, id: number, now: number): Promise<void> {
  await env.db.prepare("UPDATE domain_purchase_batches SET status = 'quoted', lease_until = NULL, updated_at = ?1 WHERE id = ?2 AND status = 'confirming'")
    .bind(now, id).run();
}

export async function confirmDomainBatch(
  env: Env, actor: Actor, id: number, req: DomainConfirmRequest, ip?: string, ctx?: ExecCtx | null, depsIn?: Partial<DomainPurchaseDeps>,
): Promise<DomainPurchaseBatchView> {
  const cfg = await loadConfig(env);
  const reasons = purchaseReasons(env, cfg);
  if (reasons.length) throw new AppError('not_configured', reasons.join('；'));
  const s = cfg.settings;
  const deps = buildDeps(env, cfg, depsIn);
  if (!deps.cf) throw new AppError('not_configured', '未配置 Cloudflare 凭据或收件 Worker');
  const now = deps.now();

  // 1. 认领批次（租约内其他确认请求进不来；过期由 cron 退回 quoted）
  const claimed = await env.db.prepare(`UPDATE domain_purchase_batches SET status = 'confirming', lease_until = ?1, updated_at = ?2
      WHERE id = ?3 AND status = 'quoted' AND quote_expires_at > ?2 RETURNING id`)
    .bind(now + CONFIRM_LEASE_MS, now, id).first();
  if (!claimed) {
    const batch = await createDb(env).select().from(domainPurchaseBatches).where(eq(domainPurchaseBatches.id, id)).get();
    if (!batch) throw new AppError('not_found', '采购批次不存在');
    if (batch.status === 'quoted') {
      await expireBatches(env, now, id);
      throw new AppError('conflict', '报价已过期，请重新报价');
    }
    if (batch.status === 'expired') throw new AppError('conflict', '报价已过期，请重新报价');
    throw new AppError('conflict', batch.status === 'confirming' ? '该批次正在确认中' : `批次状态为 ${batch.status}，不能确认`);
  }

  let committed = false;
  try {
    const batch = (await createDb(env).select().from(domainPurchaseBatches).where(eq(domainPurchaseBatches.id, id)).get())!;
    const items = await createDb(env).select().from(domainPurchaseItems).where(eq(domainPurchaseItems.batchId, id)).all();
    const quotedItems = new Map(items.filter((item) => item.status === 'quoted').map((item) => [item.domain, item]));
    const selected = [...new Set(req.domains)];
    const missing = selected.filter((domain) => !quotedItems.has(domain));
    if (missing.length) throw new AppError('validation_failed', `${missing.slice(0, 5).join('、')} 不在本批可购买的域名里`);
    const chosen = selected.map((domain) => quotedItems.get(domain)!);
    const total = chosen.reduce((sum, item) => sum + item.capBasisCents!, 0);
    if (total !== req.expectedTotalCents) throw new AppError('conflict', '确认金额与报价不一致，请刷新后重新确认');
    if (selected.length > s.maxBatchDomains) throw new AppError('validation_failed', `单批最多 ${s.maxBatchDomains} 个域名`);

    // 2. 复核可用性与价格：任何一个不再可买或价格上涨都不采购，写回新报价并 409
    const fresh = await lookupVendor(deps, selected, batch.years, s);
    const changed = chosen.filter((item) => {
      const next = fresh.get(item.domain)!;
      return next.status !== 'quoted' || next.capBasisCents! > item.capBasisCents!;
    });
    if (changed.length) {
      const writes = changed.map((item) => {
        const next = fresh.get(item.domain)!;
        return env.db.prepare(`UPDATE domain_purchase_items SET status = ?1, availability = ?2, skip_reason = ?3, price_class = ?4,
            final_cents = ?5, regular_cents = ?6, cap_basis_cents = ?7, updated_at = ?8 WHERE id = ?9 AND status = 'quoted'`)
          .bind(next.status, next.availability, next.skipReason, next.priceClass, next.finalCents, next.regularCents, next.capBasisCents, now, item.id);
      });
      const changedIds = new Set(changed.map((item) => item.id));
      const newTotal = [...quotedItems.values()].reduce((sum, item) => {
        if (!changedIds.has(item.id)) return sum + item.capBasisCents!;
        const next = fresh.get(item.domain)!;
        return sum + (next.status === 'quoted' ? next.capBasisCents! : 0);
      }, 0);
      await env.db.batch([
        ...writes,
        env.db.prepare(`UPDATE domain_purchase_batches SET status = 'quoted', lease_until = NULL, quote_expires_at = ?1, quote_total_cents = ?2,
            last_error = ?3, updated_at = ?4 WHERE id = ?5 AND status = 'confirming'`)
          .bind(now + s.quoteTtlMinutes * MINUTE, newTotal, `报价已变化：${changed.map((item) => item.domain).join('、')}`.slice(0, 1000), now, id),
      ]);
      committed = true;
      throw new AppError('conflict', '报价已变化，请核对后重新确认');
    }

    // 3. 上限与名额在同一条守卫语句里判定，并发确认不会同时通过；随后的语句以批次是否进入 processing 为前提
    const listedCount = cfg.all.domains.list.length;
    const results = await env.db.batch([
      env.db.prepare(`UPDATE domain_purchase_batches SET status = 'processing', confirmed_by = ?1, confirmed_at = ?2,
          confirmed_total_cents = ?3, lease_until = NULL, last_error = '', updated_at = ?2
        WHERE id = ?4 AND status = 'confirming' AND ?3 <= ?5
          AND ?3 + (${ledgerSql('?6')}) <= ?7
          AND (SELECT COUNT(*) FROM domain_purchase_items WHERE status IN (${IN_FLIGHT_SQL})) + ?8 + ?9 <= ?10
        RETURNING id`)
        .bind(actor.id, now, total, id, s.maxBatchCents, now - DAY, s.maxDailyCents, selected.length, listedCount, MAX_SYSTEM_DOMAINS),
      env.db.prepare(`UPDATE domain_purchase_items SET status = 'confirmed', next_check_at = ?1, updated_at = ?1
        WHERE batch_id = ?2 AND status = 'quoted' AND domain IN (SELECT value FROM json_each(?3))
          AND (SELECT status FROM domain_purchase_batches WHERE id = ?2) = 'processing'
          AND NOT EXISTS (SELECT 1 FROM domain_purchase_items o WHERE o.domain = domain_purchase_items.domain
            AND o.id <> domain_purchase_items.id AND o.status IN (${IN_FLIGHT_SQL}, 'domain_added'))`)
        .bind(now, id, JSON.stringify(selected)),
      env.db.prepare(`UPDATE domain_purchase_items SET status = 'skipped', skip_reason = 'in_flight', updated_at = ?1
        WHERE batch_id = ?2 AND status = 'quoted' AND domain IN (SELECT value FROM json_each(?3))
          AND (SELECT status FROM domain_purchase_batches WHERE id = ?2) = 'processing'`)
        .bind(now, id, JSON.stringify(selected)),
      env.db.prepare(`UPDATE domain_purchase_items SET status = 'skipped', skip_reason = 'not_selected', updated_at = ?1
        WHERE batch_id = ?2 AND status = 'quoted' AND (SELECT status FROM domain_purchase_batches WHERE id = ?2) = 'processing'`)
        .bind(now, id),
    ]);
    if (!results[0]?.results?.length) {
      const [spent, inFlight] = await Promise.all([spentLast24h(env, now), inFlightCount(env)]);
      if (total > s.maxBatchCents) throw new AppError('validation_failed', `本批合计超过单批上限（${total} > ${s.maxBatchCents} 美分）`);
      if (total + spent > s.maxDailyCents) throw new AppError('validation_failed', `超过 24 小时采购上限（已用 ${spent}，本批 ${total}，上限 ${s.maxDailyCents} 美分）`);
      if (inFlight + selected.length + listedCount > MAX_SYSTEM_DOMAINS) {
        throw new AppError('validation_failed', `系统域名名额不足（已有 ${listedCount}，进行中 ${inFlight}，上限 ${MAX_SYSTEM_DOMAINS}）`);
      }
      throw new AppError('conflict', '批次状态已变化，请刷新后重试');
    }
    committed = true;
    await logAdminAction(env, actor, 'domain_purchase.confirm', `domain_batch:${id}`, `count=${selected.length} total_cents=${total}`, ip);
    // 选中的域名可能全被其他批次抢先（skipped:in_flight），此时批次已无可推进条目，直接完成
    await maybeCompleteBatch(env, id, now);
  } finally {
    if (!committed) await releaseConfirm(env, id, now);
  }
  // 立即开始推进；持久性由 cron 负责
  if (ctx) ctx.waitUntil(runDomainPurchaseCron(env, { deps: depsIn }).catch((error) => console.error('域名采购推进失败:', error)));
  return getDomainBatch(env, id);
}

export async function cancelDomainBatch(env: Env, actor: Actor, id: number, ip?: string): Promise<DomainPurchaseBatchView> {
  const now = Date.now();
  const [result] = await env.db.batch([
    env.db.prepare("UPDATE domain_purchase_batches SET status = 'cancelled', lease_until = NULL, updated_at = ?1 WHERE id = ?2 AND status = 'quoted' RETURNING id")
      .bind(now, id),
    env.db.prepare(`UPDATE domain_purchase_items SET status = 'cancelled', updated_at = ?1
      WHERE batch_id = ?2 AND status = 'quoted' AND (SELECT status FROM domain_purchase_batches WHERE id = ?2) = 'cancelled'`).bind(now, id),
  ]);
  if (!result?.results?.length) {
    const batch = await createDb(env).select().from(domainPurchaseBatches).where(eq(domainPurchaseBatches.id, id)).get();
    if (!batch) throw new AppError('not_found', '采购批次不存在');
    throw new AppError('conflict', `批次状态为 ${batch.status}，不能取消`);
  }
  await logAdminAction(env, actor, 'domain_purchase.cancel', `domain_batch:${id}`, '', ip);
  return getDomainBatch(env, id);
}

/** 过期报价：quoted 且过了有效期的批次 → expired，其中未确认条目 → cancelled */
async function expireBatches(env: Env, now: number, onlyId?: number): Promise<void> {
  const scope = onlyId === undefined ? '' : ' AND id = ?2';
  const params = onlyId === undefined ? [now] : [now, onlyId];
  await env.db.batch([
    env.db.prepare(`UPDATE domain_purchase_items SET status = 'cancelled', updated_at = ?1 WHERE status = 'quoted'
      AND batch_id IN (SELECT id FROM domain_purchase_batches WHERE status = 'quoted' AND quote_expires_at <= ?1${scope})`).bind(...params),
    env.db.prepare(`UPDATE domain_purchase_batches SET status = 'expired', updated_at = ?1
      WHERE status = 'quoted' AND quote_expires_at <= ?1${scope}`).bind(...params),
  ]);
}

// ---------------------------------------------------------------------------
// 单条目推进（cron / 管理员刷新共用）

/** 非花钱步骤的行认领 */
async function claimItem(env: Env, id: number, status: DomainItemStatus, now: number, lease = STEP_LEASE_MS): Promise<boolean> {
  const row = await env.db.prepare(`UPDATE domain_purchase_items SET lease_until = ?1 WHERE id = ?2 AND status = ?3
      AND COALESCE(lease_until, 0) < ?4 RETURNING id`).bind(now + lease, id, status, now).first();
  return Boolean(row);
}

type Column =
  | 'status' | 'operation_id' | 'op_status' | 'cf_zone_id' | 'name_servers' | 'zone_status' | 'routing_status' | 'lifecycle_status'
  | 'verification_status' | 'suspensions' | 'failed_step' | 'last_error' | 'error_code' | 'vendor_operation_id' | 'step_attempts'
  | 'next_check_at' | 'zone_create_attempted_at' | 'registered_at' | 'ns_set_at' | 'ready_at';

/** 以「状态仍为 expected」为前提写结果并释放租约；bump 时 step_attempts + 1 */
async function settle(
  env: Env, id: number, expected: DomainItemStatus, now: number, set: Partial<Record<Column, string | number | null>>, bump = false,
): Promise<boolean> {
  const entries = Object.entries(set) as [Column, string | number | null][];
  const assignments = entries.map(([column], index) => `${column} = ?${index + 1}`);
  if (bump) assignments.push('step_attempts = step_attempts + 1');
  const n = entries.length;
  const row = await env.db.prepare(`UPDATE domain_purchase_items SET ${[...assignments, `lease_until = NULL`, `updated_at = ?${n + 1}`].join(', ')}
      WHERE id = ?${n + 2} AND status = ?${n + 3} RETURNING id`)
    .bind(...entries.map(([, value]) => value), now, id, expected).first();
  return Boolean(row);
}

function errorFields(error: unknown): Partial<Record<Column, string>> {
  if (error instanceof SpaceshipError) return { last_error: errorText(error), error_code: error.code, vendor_operation_id: error.operationId };
  if (error instanceof CloudflareApiError) return { last_error: errorText(error), error_code: error.codes.join(','), vendor_operation_id: '' };
  return { last_error: errorText(error), error_code: '', vendor_operation_id: '' };
}

/** 暂时性错误：保持状态，下次再试（429 按 Retry-After） */
async function retryLater(env: Env, row: ItemRow, now: number, error: unknown, delay = RETRY_DELAY_MS): Promise<AdvanceResult> {
  const after = error instanceof SpaceshipError && error.retryAfterSec !== null ? Math.max(error.retryAfterSec * SECOND, MINUTE) : delay;
  await settle(env, row.id, row.status, now, { next_check_at: now + after, ...errorFields(error) }, true);
  return 'waiting';
}

/** 正常等待（zone 未生效、操作进行中等），不算失败 */
async function waitLater(env: Env, row: ItemRow, now: number, delay: number, extra: Partial<Record<Column, string | number | null>> = {}, bump = false): Promise<AdvanceResult> {
  await settle(env, row.id, row.status, now, { next_check_at: now + delay, ...extra }, bump);
  return 'waiting';
}

async function failItem(env: Env, row: ItemRow, now: number, step: DomainItemStep, error: unknown): Promise<AdvanceResult> {
  const fields = typeof error === 'string' ? { last_error: error, error_code: '', vendor_operation_id: '' } : errorFields(error);
  await settle(env, row.id, row.status, now, { status: 'failed', failed_step: step, next_check_at: null, ...fields });
  return 'failed';
}

function domainInfoFields(info: { lifecycleStatus: string; verificationStatus: string | null; suspensions: string[] }) {
  return { lifecycle_status: info.lifecycleStatus, verification_status: info.verificationStatus ?? '', suspensions: JSON.stringify(info.suspensions) };
}

async function maybeCompleteBatch(env: Env, batchId: number, now: number): Promise<void> {
  await env.db.prepare(`UPDATE domain_purchase_batches SET status = 'completed', completed_at = ?1, updated_at = ?1
      WHERE id = ?2 AND status = 'processing'
        AND NOT EXISTS (SELECT 1 FROM domain_purchase_items WHERE batch_id = ?2 AND status NOT IN (${TERMINAL_SQL}))`)
    .bind(now, batchId).run();
}

/** 管理路由的每分钟限流 scope（按管理员 id、minuteWindow(1) 计；每日维护按此清理过期行） */
export const DOMAIN_PURCHASE_RATE_SCOPES = [
  'admin.domain_purchase.test', 'admin.domain_purchase.contact', 'admin.domain_purchase.quote',
  'admin.domain_purchase.refresh', 'admin.domain_purchase.confirm',
] as const;
export type DomainPurchaseRateScope = (typeof DOMAIN_PURCHASE_RATE_SCOPES)[number];
/** 账户级异步操作查询计数（minuteWindow(5)） */
export const SPACESHIP_POLL_SCOPE = 'spaceship.poll';

/** 账户级异步操作查询额度（多副本与管理员刷新共用） */
async function takePollSlot(env: Env, now: number): Promise<boolean> {
  const value = await bumpCounter(env, SPACESHIP_POLL_SCOPE, 'account', minuteWindow(5, now));
  return value.count <= POLL_LIMIT_PER_5_MIN;
}

/** settings.domains.list 追加（带修订号 CAS，冲突重读重试；已在列表视为成功） */
async function appendSystemDomain(env: Env, domain: string): Promise<{ ok: true } | { ok: false; error: string; definite: boolean }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const settings = await getSettingsFresh(env);
    if (settings.domains.list.some((entry) => entry.domain === domain)) return { ok: true };
    const hosted = await env.db.prepare('SELECT 1 AS hit FROM hosted_domains WHERE domain = ?').bind(domain).first();
    if (hosted) return { ok: false, error: '该域名已被用户托管，不能加为系统域名', definite: true };
    if (settings.domains.list.length >= MAX_SYSTEM_DOMAINS) return { ok: false, error: `系统域名已达上限 ${MAX_SYSTEM_DOMAINS}`, definite: true };
    try {
      await updateSettings(env, {
        domains: { ...settings.domains, list: [...settings.domains.list, { domain, public: false, perUserLimit: 0 }] },
        expectedDomainsRevision: settings.domains.revision ?? 0,
      });
      return { ok: true };
    } catch (error) {
      if (error instanceof AppError && error.code === 'conflict') continue;
      throw error;
    }
  }
  return { ok: false, error: '域名配置并发修改，稍后重试', definite: false };
}

/** 幂等的单步推进：每次最多一个状态转换；先认领行再调用外部接口，结果按「状态仍为预期」写回 */
export async function advanceDomainItem(env: Env, itemId: number, deps: DomainPurchaseDeps, budget: DomainCronBudget): Promise<AdvanceResult> {
  const row = await loadItem(env, itemId);
  const now = deps.now();
  const result = await advanceRow(env, row, deps, budget, now);
  if (result !== 'skipped') await maybeCompleteBatch(env, row.batchId, now);
  return result;
}

async function advanceRow(env: Env, row: ItemRow, deps: DomainPurchaseDeps, budget: DomainCronBudget, now: number): Promise<AdvanceResult> {
  const sp = deps.spaceship;
  const cf = deps.cf;
  switch (row.status) {
    case 'confirmed': {
      if (budget.registers <= 0) return 'skipped';
      const [settings, batch] = await Promise.all([
        getSettingsFresh(env).then((all) => all.spaceship),
        createDb(env).select().from(domainPurchaseBatches).where(eq(domainPurchaseBatches.id, row.batchId)).get(),
      ]);
      if (!batch || batch.status !== 'processing') return 'skipped';
      const confirmedAt = (batch.confirmedAt ?? row.createdAt).getTime();
      if (now - confirmedAt > CONFIRMED_MAX_AGE_MS) {
        return failItem(env, row, now, 'register', '确认后超过 24 小时仍未发起注册，已作废（未扣费），请重新报价');
      }
      // 采购开关 / 上限 / 凭据在确认后可能被关掉：暂停（不注册），恢复后在有效期内继续
      const contact = deps.registrantContactId ?? settings.registrantContactId;
      const hold = !settings.enabled ? '域名采购已停用，暂停注册'
        : !capsSet(settings) ? '采购上限为 0（禁止采购），暂停注册'
        : !cf ? '未配置 Cloudflare 凭据或收件 Worker，暂停注册'
        : !contact ? '未设置注册联系人' : '';
      if (hold) return waitLater(env, row, now, RETRY_DELAY_MS, { last_error: hold });
      if (row.priceClass !== 'standard' && !settings.allowPremium) {
        return failItem(env, row, now, 'register', '已不允许购买溢价域名，未注册（未扣费）');
      }
      if (row.capBasisCents === null || row.capBasisCents > settings.maxDomainCents) {
        return failItem(env, row, now, 'register', `超过当前单域名上限（${row.capBasisCents ?? '?'} > ${settings.maxDomainCents} 美分），未注册（未扣费）`);
      }
      // 确认已超过报价有效期：注册前对该域名重新查可用性与价格（注册请求没有最高价参数）
      if (now - confirmedAt > settings.quoteTtlMinutes * MINUTE) {
        let fresh: Evaluation;
        try {
          const [availability] = await sp.checkAvailability([row.domain]);
          const result = availability?.domain === row.domain ? availability.result : 'unexpectedError';
          const price = result === 'available' ? (await sp.queryPricing([row.domain], batch.years)).find((p) => p.domain === row.domain) : undefined;
          fresh = evaluate(result, price, settings);
        } catch (error) {
          return retryLater(env, row, now, error);
        }
        if (fresh.status !== 'quoted') {
          return failItem(env, row, now, 'register', `注册前复核：不再可购买（${fresh.skipReason || fresh.availability}），未注册（未扣费）`);
        }
        if (fresh.capBasisCents! > row.capBasisCents) {
          return failItem(env, row, now, 'register', `注册前复核：价格已上涨（${row.capBasisCents} → ${fresh.capBasisCents} 美分），未注册（未扣费），请重新报价`);
        }
      }
      // 唯一花钱的转换：CAS 成功才 POST，同一条目最多一次。确认有效期（24 小时）内注册，
      // 台账按批次确认时间与注册时间都计入窗口，延后注册的花费不会落在任何 24 小时窗口之外
      const won = await env.db.prepare(`UPDATE domain_purchase_items SET status = 'registering', register_attempted_at = ?1,
          lease_until = ?2, updated_at = ?1 WHERE id = ?3 AND status = 'confirmed' AND operation_id IS NULL
          AND COALESCE(lease_until, 0) < ?1 RETURNING id`).bind(now, now + REGISTER_LEASE_MS, row.id).first();
      if (!won) return 'skipped';
      budget.registers--;
      await logAdminAction(env, SYSTEM_ACTOR, 'domain_purchase.register', row.domain, `batch=${row.batchId} cap_cents=${row.capBasisCents}`);
      try {
        const { operationId } = await sp.registerDomain(row.domain, {
          years: batch.years, autoRenew: Boolean(batch.autoRenew), privacyLevel: batch.privacyLevel, registrantContactId: contact,
        });
        await settle(env, row.id, 'registering', now, {
          operation_id: operationId, op_status: 'pending', next_check_at: now + MINUTE, step_attempts: 0, last_error: '', error_code: '', vendor_operation_id: '',
        });
        return 'advanced';
      } catch (error) {
        const outcome = error instanceof SpaceshipError ? error.outcome : 'unknown';
        if (outcome === 'rate_limited') {
          // 429 在处理前被拒，退回 confirmed 安全
          const after = (error as SpaceshipError).retryAfterSec;
          await settle(env, row.id, 'registering', now, { status: 'confirmed', next_check_at: now + Math.max((after ?? 60) * SECOND, MINUTE), ...errorFields(error) });
          return 'waiting';
        }
        if (outcome === 'rejected' || outcome === 'not_found') {
          await settle(env, row.id, 'registering', now, { status: 'failed', failed_step: 'register', next_check_at: null, ...errorFields(error) });
          await logAdminAction(env, SYSTEM_ACTOR, 'domain_purchase.register_failed', row.domain, `batch=${row.batchId} code=${(error as SpaceshipError).code}`);
          return 'failed';
        }
        await settle(env, row.id, 'registering', now, { status: 'unknown', next_check_at: now + UNKNOWN_RECHECK_MS, ...errorFields(error) });
        await logAdminAction(env, SYSTEM_ACTOR, 'domain_purchase.register_unknown', row.domain,
          `batch=${row.batchId} code=${error instanceof SpaceshipError ? error.code : ''}`);
        return 'advanced';
      }
    }

    case 'registering': {
      if (!row.operationId) {
        // CAS 后、写回操作号前中断：租约过期即为结果不明
        if (row.leaseUntil && row.leaseUntil.getTime() >= now) return 'skipped';
        const moved = await env.db.prepare(`UPDATE domain_purchase_items SET status = 'unknown', lease_until = NULL, next_check_at = ?1,
            last_error = '注册请求中断，结果不明', updated_at = ?2 WHERE id = ?3 AND status = 'registering' AND operation_id IS NULL
            AND COALESCE(lease_until, 0) < ?2 RETURNING id`).bind(now + UNKNOWN_RECHECK_MS, now, row.id).first();
        if (!moved) return 'skipped';
        await logAdminAction(env, SYSTEM_ACTOR, 'domain_purchase.register_unknown', row.domain, `batch=${row.batchId} lease_expired`);
        return 'advanced';
      }
      if (budget.polls <= 0) return 'skipped';
      if (!(await takePollSlot(env, now))) return 'skipped';
      if (!(await claimItem(env, row.id, row.status, now))) return 'skipped';
      budget.polls--;
      try {
        const op = await sp.getAsyncOperation(row.operationId);
        if (op.status === 'success') {
          await settle(env, row.id, row.status, now, { status: 'registered', op_status: 'success', registered_at: now, next_check_at: now, step_attempts: 0, last_error: '' });
          return 'advanced';
        }
        if (op.status === 'failed') {
          const details = JSON.stringify(op.details ?? null).slice(0, 1000);
          await settle(env, row.id, row.status, now, { status: 'failed', failed_step: 'poll', op_status: 'failed', next_check_at: null, last_error: `注册失败：${details}` });
          await logAdminAction(env, SYSTEM_ACTOR, 'domain_purchase.register_failed', row.domain, `batch=${row.batchId} op=${row.operationId}`);
          return 'failed';
        }
        const late = row.registerAttemptedAt && now - row.registerAttemptedAt.getTime() > OP_PENDING_WARN_MS;
        return waitLater(env, row, now, RETRY_DELAY_MS, { op_status: 'pending', ...(late ? { last_error: '注册超过 24 小时未完成' } : {}) });
      } catch (error) {
        return retryLater(env, row, now, error);
      }
    }

    case 'unknown': {
      if (!(await claimItem(env, row.id, row.status, now))) return 'skipped';
      try {
        // 只读核对：账户里查得到该域名 → 已注册
        const info = await sp.getDomain(row.domain);
        if (!info) return waitLater(env, row, now, UNKNOWN_RECHECK_MS, { last_error: '尚未在 Spaceship 账户中找到该域名（可能已扣费）' });
        await settle(env, row.id, row.status, now, { status: 'registered', registered_at: now, next_check_at: now, last_error: '', ...domainInfoFields(info) });
        await logAdminAction(env, SYSTEM_ACTOR, 'domain_purchase.reconciled', row.domain, `batch=${row.batchId}`);
        return 'advanced';
      } catch (error) {
        return retryLater(env, row, now, error, UNKNOWN_RECHECK_MS);
      }
    }

    case 'registered': {
      if (!cf) return 'skipped';
      if (budget.zoneCreates <= 0) return 'skipped';
      if (!(await claimItem(env, row.id, row.status, now))) return 'skipped';
      try {
        const existing = await findZone(cf, row.domain);
        if (existing) {
          // 只接管自己刚才建的 zone（创建请求结果丢失）；账户里原有的 zone 一律不接管
          const attempted = row.zoneCreateAttemptedAt?.getTime();
          const created = existing.created_on ? Date.parse(existing.created_on) : Number.NaN;
          if (!attempted || !Number.isFinite(created) || created < attempted - MINUTE) {
            return failItem(env, row, now, 'zone', 'Cloudflare 账户里已存在该 zone，拒绝接管');
          }
          await settle(env, row.id, row.status, now, {
            status: 'zone_created', cf_zone_id: existing.id, name_servers: JSON.stringify(existing.name_servers ?? []),
            zone_status: existing.status, next_check_at: now, step_attempts: 0, last_error: '',
          });
          return 'advanced';
        }
        const counts = await countZones(cf);
        if (counts.total > 50 && counts.pending >= counts.total - counts.pending) {
          return waitLater(env, row, now, 30 * MINUTE, { last_error: 'Cloudflare 账户 pending zone 过多，暂停新建' });
        }
        budget.zoneCreates--;
        await env.db.prepare("UPDATE domain_purchase_items SET zone_create_attempted_at = ?1 WHERE id = ?2 AND status = 'registered'").bind(now, row.id).run();
        const zone = await createZone(cf, row.domain);
        await settle(env, row.id, row.status, now, {
          status: 'zone_created', cf_zone_id: zone.id, name_servers: JSON.stringify(zone.name_servers ?? []), zone_status: zone.status,
          zone_create_attempted_at: now, next_check_at: now, step_attempts: 0, last_error: '', error_code: '',
        });
        return 'advanced';
      } catch (error) {
        // 1061 = 已存在（并发创建或结果丢失），下次 findZone 会按创建时间判断是否接管
        if (isTransientCloudflareError(error) || (error instanceof CloudflareApiError && error.has(1061))) return retryLater(env, row, now, error);
        return failItem(env, row, now, 'zone', error);
      }
    }

    case 'zone_created': {
      if (!(await claimItem(env, row.id, row.status, now))) return 'skipped';
      try {
        const info = await sp.getDomain(row.domain);
        if (!info || info.lifecycleStatus !== 'registered') {
          return waitLater(env, row, now, RETRY_DELAY_MS, info ? domainInfoFields(info) : {});
        }
        const hosts = row.nameServers ?? [];
        if (hosts.length < 2) return failItem(env, row, now, 'nameservers', 'Cloudflare 未分配名称服务器');
        await sp.setNameservers(row.domain, hosts);
        await settle(env, row.id, row.status, now, {
          status: 'ns_set', ns_set_at: now, next_check_at: now + RETRY_DELAY_MS, step_attempts: 0, last_error: '', error_code: '', ...domainInfoFields(info),
        });
        return 'advanced';
      } catch (error) {
        if (error instanceof SpaceshipError && error.outcome === 'rejected') return failItem(env, row, now, 'nameservers', error);
        return retryLater(env, row, now, error);
      }
    }

    case 'ns_set': {
      if (!cf || !row.cfZoneId) return 'skipped';
      if (!(await claimItem(env, row.id, row.status, now))) return 'skipped';
      try {
        const zone = await getZone(cf, row.cfZoneId, row.domain);
        if (!zone) return failItem(env, row, now, 'zone', 'Cloudflare zone 已被删除');
        if (zone.status === 'active') {
          await settle(env, row.id, row.status, now, { status: 'zone_active', zone_status: 'active', next_check_at: now, step_attempts: 0, last_error: '' });
          return 'advanced';
        }
        if (zone.status === 'moved') return failItem(env, row, now, 'nameservers', 'Cloudflare zone 已 moved（NS 被改走）');
        // 从本次设置 NS 起算（不含注册、建 zone、等 pending 额度的时间）；重试会重新设置 NS 并重新计时
        const since = (row.nsSetAt ?? row.registeredAt ?? row.createdAt).getTime();
        if (now - since > NS_TIMEOUT_MS) return failItem(env, row, now, 'nameservers', 'NS 设置后超过 7 天未生效');
        if (row.stepAttempts % ACTIVATION_CHECK_EVERY === 0) await requestActivationCheck(cf, row.cfZoneId);
        return waitLater(env, row, now, RETRY_DELAY_MS, { zone_status: zone.status }, true);
      } catch (error) {
        if (isTransientCloudflareError(error)) return retryLater(env, row, now, error);
        return failItem(env, row, now, 'zone', error);
      }
    }

    case 'zone_active': {
      if (!cf || !row.cfZoneId) return 'skipped';
      if (!(await claimItem(env, row.id, row.status, now))) return 'skipped';
      let step: DomainItemStep = 'routing';
      try {
        const routing = await getRouting(cf, row.cfZoneId);
        if (!routing.enabled) await enableRouting(cf, row.cfZoneId);
        step = 'catch_all';
        const rule = await getCatchAll(cf, row.cfZoneId);
        if (!catchAllTargetsWorker(rule, cf.workerName)) await putCatchAll(cf, row.cfZoneId);
        await settle(env, row.id, row.status, now, { status: 'routing_ready', routing_status: 'ready', next_check_at: now, step_attempts: 0, last_error: '', error_code: '' });
        return 'advanced';
      } catch (error) {
        // 2009：zone 尚未完全生效，Email Routing 开不了，稍后再试
        if (error instanceof CloudflareApiError && error.has(2009)) return waitLater(env, row, now, RETRY_DELAY_MS, { routing_status: 'zone_pending', ...errorFields(error) }, true);
        if (isTransientCloudflareError(error)) return retryLater(env, row, now, error);
        return failItem(env, row, now, step, error);
      }
    }

    case 'routing_ready': {
      if (!(await claimItem(env, row.id, row.status, now))) return 'skipped';
      try {
        const appended = await appendSystemDomain(env, row.domain);
        if (!appended.ok) {
          if (appended.definite) return failItem(env, row, now, 'domain_add', appended.error);
          return retryLater(env, row, now, new Error(appended.error));
        }
      } catch (error) {
        return retryLater(env, row, now, error);
      }
      await settle(env, row.id, row.status, now, { status: 'domain_added', ready_at: now, next_check_at: null, step_attempts: 0, last_error: '', error_code: '' });
      await logAdminAction(env, SYSTEM_ACTOR, 'domain_purchase.ready', row.domain, `batch=${row.batchId}`);
      try {
        // 尽力刷新 RAA 核验 / 暂停状态，供管理员查看
        const info = await sp.getDomain(row.domain);
        if (info) {
          const fields = domainInfoFields(info);
          await env.db.prepare(`UPDATE domain_purchase_items SET lifecycle_status = ?1, verification_status = ?2, suspensions = ?3
              WHERE id = ?4 AND status = 'domain_added'`).bind(fields.lifecycle_status, fields.verification_status, fields.suspensions, row.id).run();
        }
      } catch {
        // 忽略
      }
      return 'advanced';
    }

    default:
      return 'skipped';
  }
}

/** cron 入口：回收确认租约、过期报价，推进到期条目（≤ 30 个、60 秒）。未启用或未配置凭据时不做任何事 */
export async function runDomainPurchaseCron(
  env: Env, opts: { now?: number; deps?: Partial<DomainPurchaseDeps>; deadlineMs?: number } = {},
): Promise<number> {
  const cfg = await loadConfig(env);
  if (!cfg.settings.enabled || !cfg.apiKey || !cfg.apiSecret) return 0;
  const fixedNow = opts.now;
  const deps = buildDeps(env, cfg, { ...opts.deps, ...(fixedNow === undefined ? {} : { now: () => fixedNow }) });
  const now = deps.now();
  await env.db.prepare(`UPDATE domain_purchase_batches SET status = 'quoted', lease_until = NULL, updated_at = ?1
      WHERE status = 'confirming' AND COALESCE(lease_until, 0) < ?1`).bind(now).run();
  await expireBatches(env, now);

  const due = await env.db.prepare(`SELECT id FROM domain_purchase_items WHERE status IN (${IN_FLIGHT_SQL})
      AND COALESCE(next_check_at, 0) <= ?1 AND COALESCE(lease_until, 0) < ?1
      ORDER BY COALESCE(next_check_at, 0), id LIMIT ?2`).bind(now, CRON_DUE_LIMIT).all<{ id: number }>();
  const budget: DomainCronBudget = { registers: 20, polls: 40, zoneCreates: 5, deadline: Date.now() + (opts.deadlineMs ?? CRON_DEADLINE_MS) };
  let advanced = 0;
  for (const { id } of due.results) {
    if (Date.now() > budget.deadline) break;
    try {
      if (await advanceDomainItem(env, Number(id), deps, budget) === 'advanced') advanced++;
    } catch (error) {
      console.error(`域名采购条目 #${id} 推进失败:`, error);
    }
  }
  return advanced;
}

// ---------------------------------------------------------------------------
// 管理员对单条目的操作

export async function retryDomainItem(env: Env, actor: Actor, itemId: number, ip?: string): Promise<DomainPurchaseItemView> {
  const row = await loadItem(env, itemId);
  if (row.status !== 'failed') throw new AppError('conflict', '只有失败的条目可以重试');
  const target = RETRY_TARGET[row.failedStep as DomainItemStep];
  if (!target) throw new AppError('conflict', '注册未成功的域名需重新报价采购');
  const now = Date.now();
  const [moved] = await env.db.batch([
    env.db.prepare(`UPDATE domain_purchase_items SET status = ?1, failed_step = '', step_attempts = 0, next_check_at = ?2, last_error = '',
        error_code = '', vendor_operation_id = '', lease_until = NULL, ns_set_at = CASE WHEN ?1 = 'zone_created' THEN NULL ELSE ns_set_at END,
        updated_at = ?2 WHERE id = ?3 AND status = 'failed' AND failed_step = ?4 RETURNING id`)
      .bind(target, now, row.id, row.failedStep),
    env.db.prepare(`UPDATE domain_purchase_batches SET status = 'processing', completed_at = NULL, updated_at = ?1
        WHERE id = ?2 AND status = 'completed' AND EXISTS (SELECT 1 FROM domain_purchase_items WHERE id = ?3 AND status = ?4)`)
      .bind(now, row.batchId, row.id, target),
  ]);
  if (!moved?.results?.length) throw new AppError('conflict', '条目状态已变化，请刷新');
  await logAdminAction(env, actor, 'domain_purchase.item_retry', row.domain, `step=${row.failedStep}`, ip);
  return toItemView(await loadItem(env, itemId));
}

export async function resolveDomainItem(
  env: Env, actor: Actor, itemId: number, req: DomainItemResolveRequest, ip?: string, depsIn?: Partial<DomainPurchaseDeps>,
): Promise<DomainPurchaseItemView> {
  const row = await loadItem(env, itemId);
  if (row.status !== 'unknown') throw new AppError('conflict', '只有结果不明的条目需要裁决');
  const cfg = await loadConfig(env);
  requireCredentials(cfg);
  const deps = buildDeps(env, cfg, depsIn);
  const now = deps.now();
  if (req.action === 'mark_registered') {
    const info = await vendor(deps, () => deps.spaceship.getDomain(row.domain));
    if (!info) throw new AppError('conflict', 'Spaceship 账户里找不到该域名，不能标记为已注册');
    const ok = await settle(env, row.id, 'unknown', now, { status: 'registered', registered_at: now, next_check_at: now, last_error: '', ...domainInfoFields(info) });
    if (!ok) throw new AppError('conflict', '条目状态已变化，请刷新');
  } else {
    const [availability] = await vendor(deps, () => deps.spaceship.checkAvailability([row.domain]));
    if (availability?.result !== 'available') throw new AppError('conflict', `该域名当前可用性为 ${availability?.result ?? '未知'}，不能标记为未注册`);
    const ok = await settle(env, row.id, 'unknown', now, { status: 'failed', failed_step: 'register', next_check_at: null, last_error: '管理员确认未注册（实时查询仍可注册）' });
    if (!ok) throw new AppError('conflict', '条目状态已变化，请刷新');
  }
  await maybeCompleteBatch(env, row.batchId, now);
  await logAdminAction(env, actor, 'domain_purchase.item_resolve', row.domain, `action=${req.action}`, ip);
  return toItemView(await loadItem(env, itemId));
}

/** 立即推进一步（不会发起注册）；同一条目 60 秒内只能刷新一次 */
export async function refreshDomainItem(env: Env, _actor: Actor, itemId: number, depsIn?: Partial<DomainPurchaseDeps>): Promise<DomainPurchaseItemView> {
  const row = await loadItem(env, itemId);
  if (!(DOMAIN_ITEM_IN_FLIGHT as readonly string[]).includes(row.status) || row.status === 'confirmed') {
    throw new AppError('conflict', '该条目当前不需要刷新');
  }
  const cfg = await loadConfig(env);
  requireCredentials(cfg);
  const deps = buildDeps(env, cfg, depsIn);
  const now = deps.now();
  if (row.updatedAt.getTime() > now - REFRESH_MIN_INTERVAL_MS) throw new AppError('rate_limited', '刚刚核对过，请一分钟后再试');
  await advanceDomainItem(env, itemId, deps, { registers: 0, polls: 1, zoneCreates: 1, deadline: Date.now() + 30 * SECOND });
  return toItemView(await loadItem(env, itemId));
}

// ---------------------------------------------------------------------------
// 凭据与联系人

export async function saveRegistrantContact(
  env: Env, actor: Actor, req: RegistrantContactRequest, ip?: string, depsIn?: Partial<DomainPurchaseDeps>,
): Promise<{ contactId: string }> {
  const cfg = await loadConfig(env);
  requireCredentials(cfg);
  const deps = buildDeps(env, cfg, depsIn);
  const { contactId } = await vendor(deps, () => deps.spaceship.saveContact(req));
  // 只改联系人 ID；密文字段提交 SECRET_MASK 表示保留库里的原值
  const current = (await getSettingsFresh(env)).spaceship;
  await updateSettings(env, { spaceship: { ...current, apiKey: SECRET_MASK, apiSecret: SECRET_MASK, registrantContactId: contactId } });
  await logAdminAction(env, actor, 'domain_purchase.contact_save', 'spaceship', `contact=${contactId}`, ip);
  return { contactId };
}

export async function testSpaceshipCredentials(env: Env, _actor: Actor, depsIn?: Partial<DomainPurchaseDeps>): Promise<SpaceshipCredentialTest> {
  const cfg = await loadConfig(env);
  requireCredentials(cfg);
  const deps = buildDeps(env, cfg, depsIn);
  const { total } = await vendor(deps, () => deps.spaceship.listDomains({ take: 1, skip: 0 }));
  return { ok: true, domainCount: total };
}
