import {
  MAX_PROXY_EXPORT_ROWS,
  MAX_PROXY_IMPORT_LINES,
  SECRET_MASK,
  buildProxyUrl,
  formatProxyLine,
  parseProxyLine,
  proxyAddressSchema,
  proxyInputSchema,
  type AutoAssignRequest,
  type AutoAssignResult,
  type CursorPage,
  type ExportProxiesQuery,
  type ImportProxiesRequest,
  type ListBindingsQuery,
  type ListProxiesQuery,
  type MyProxyBinding,
  type ProxyBindingLookupItem,
  type ProxyBindingSource,
  type ProxyBindingView,
  type ProxyCredential,
  type ProxyExport,
  type ProxyHealthReport,
  type ProxyHealthStatus,
  type ProxyImportResult,
  type ProxyInput,
  type ProxyPoolStats,
  type ProxyProtocol,
  type ProxySource,
  type ProxyStatus,
  type ProxyView,
  type Role,
  type UpdateProxyRequest,
  type V1ProxyListQuery,
  type V1ProxyLookup,
} from '@hpc-mail/shared';
import { chunk } from '../lib/d1.js';
import { AppError } from '../lib/errors.js';
import { decodeCursor, encodeCursor } from '../lib/pagination.js';
import { openSecret, sealSecret } from '../lib/secret-box.js';
import type { AuthUser, Env } from '../types.js';
import { logAdminAction } from './audit.js';

/**
 * 代理库存 + 「邮箱地址 ↔ 代理」绑定（DESIGN §5.1）。
 * - 密码以 secret box 密文存 `password_enc`；列表/详情永不返回密码，只有 reveal、地址查询、导出才解密。
 * - 绑定以地址为主键，与认领/释放/过户解耦；非管理员可见性按「当前认领人」实时计算。
 * - SQL 同时跑在 D1/SQLite 与 PostgreSQL 适配层：时间戳一律由 JS 绑定毫秒数，布尔绑 1/0，文本比较两侧小写。
 */

type Actor = Pick<AuthUser, 'id' | 'username'>;

/**
 * 代理/1024 管理路由使用的 rate_counters scope（按管理员 id、minuteWindow(1) 计）。
 * INTEGRATOR：在 scheduled.ts 每日维护里对每个 scope 调 purgeCounters(env, scope, minuteWindow(1) - 120)。
 */
export const PROXY_RATE_SCOPES = [
  'proxy.export', 'proxy.auto_assign', 'proxy.reveal',
  'proxy_1024.status', 'proxy_1024.login', 'proxy_1024.quote', 'proxy_1024.confirm', 'proxy_1024.refresh', 'proxy_1024.allocate', 'proxy_1024.sync',
] as const;
export type ProxyRateScope = (typeof PROXY_RATE_SCOPES)[number];
export interface ProxyViewer { userId: number; role: Role }

/** proxies 表原始行（两种引擎都返回 snake_case 列名） */
export interface ProxyRow {
  id: number;
  label: string;
  provider: string;
  source: string;
  protocol: string;
  host: string;
  port: number;
  username: string;
  password_enc: string;
  product: string;
  country: string;
  region: string;
  city: string;
  provider_ref: string | null;
  order_id: number | null;
  expires_at: number | null;
  status: string;
  max_bindings: number;
  health_status: string;
  health_checked_at: number | null;
  health_latency_ms: number | null;
  health_error: string;
  notes: string;
  created_by: number;
  updated_at: number;
  created_at: number;
  binding_count?: number;
}

/** 供应商同步写入库存的一行（按 provider + providerRef 幂等） */
export interface ProviderProxyRow {
  provider: string;
  providerRef: string;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username: string;
  password: string;
  product: string;
  country: string;
  region: string;
  city: string;
  expiresAt: number | null;
  /** 仅新建时使用，缺省 1 */
  maxBindings?: number;
  label?: string;
}

const BINDING_COUNT_SQL = '(SELECT COUNT(*) FROM address_proxy_bindings b WHERE b.proxy_id = p.id)';
const PROXY_SELECT = `SELECT p.*, ${BINDING_COUNT_SQL} AS binding_count FROM proxies p`;
const STATEMENTS_PER_BATCH = 50;

function iso(ms: number | null | undefined): string | null {
  return ms === null || ms === undefined ? null : new Date(Number(ms)).toISOString();
}

function num(value: unknown): number {
  return Number(value ?? 0);
}

/** 过期时间已过的 active 代理按 expired 存，避免「active 却绑不上」 */
function effectiveStatus(status: ProxyStatus, expiresAt: number | null, now: number): ProxyStatus {
  return status === 'active' && expiresAt !== null && expiresAt <= now ? 'expired' : status;
}

function parseIsoMs(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new AppError('validation_failed', '过期时间格式非法');
  return ms;
}

/** LIKE 模式：转义 % _ \，两侧小写 */
function likePattern(text: string): string {
  return `%${text.toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? '')}` : String(error);
  return /UNIQUE constraint failed/i.test(message);
}

/** 地址游标：base64url(UTF-8 地址) */
function encodeAddressCursor(address: string): string {
  const bytes = new TextEncoder().encode(address);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeAddressCursor(cursor: string | undefined): string | null {
  if (!cursor) return null;
  try {
    const binary = atob(cursor.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    const address = new TextDecoder().decode(bytes);
    return address || null;
  } catch {
    throw new AppError('validation_failed', '游标非法');
  }
}

function normalizeAddress(address: string): string {
  const parsed = proxyAddressSchema.safeParse(address);
  if (!parsed.success) throw new AppError('validation_failed', parsed.error.issues[0]?.message ?? '邮箱地址格式非法');
  return parsed.data;
}

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1);
}

export function toProxyView(row: ProxyRow, bindingCount: number): ProxyView {
  return {
    id: num(row.id),
    label: row.label,
    provider: row.provider,
    source: row.source as ProxySource,
    protocol: row.protocol as ProxyProtocol,
    host: row.host,
    port: num(row.port),
    username: row.username,
    hasPassword: row.password_enc !== '',
    product: row.product,
    country: row.country,
    region: row.region,
    city: row.city,
    providerRef: row.provider_ref ?? null,
    orderId: row.order_id === null || row.order_id === undefined ? null : num(row.order_id),
    expiresAt: iso(row.expires_at),
    status: row.status as ProxyStatus,
    maxBindings: num(row.max_bindings),
    bindingCount,
    health: {
      status: row.health_status as ProxyHealthStatus,
      checkedAt: iso(row.health_checked_at),
      latencyMs: row.health_latency_ms === null || row.health_latency_ms === undefined ? null : num(row.health_latency_ms),
      error: row.health_error,
    },
    notes: row.notes,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

function rowView(row: ProxyRow): ProxyView {
  return toProxyView(row, num(row.binding_count));
}

async function credentialOf(env: Env, row: Pick<ProxyRow, 'id' | 'protocol' | 'host' | 'port' | 'username' | 'password_enc' | 'country' | 'city' | 'product' | 'status' | 'expires_at'>): Promise<ProxyCredential> {
  const password = await openSecret(env, row.password_enc);
  const protocol = row.protocol as ProxyProtocol;
  const port = num(row.port);
  return {
    proxyId: num(row.id),
    protocol,
    host: row.host,
    port,
    username: row.username,
    password,
    url: buildProxyUrl({ protocol, host: row.host, port, username: row.username, password }),
    country: row.country,
    city: row.city,
    product: row.product,
    status: row.status as ProxyStatus,
    expiresAt: iso(row.expires_at),
  };
}

async function loadProxyRow(env: Env, id: number): Promise<ProxyRow> {
  const row = await env.db.prepare(`${PROXY_SELECT} WHERE p.id = ?`).bind(id).first<ProxyRow>();
  if (!row) throw new AppError('not_found', '代理不存在');
  return row;
}

// ───────────────────────────── 库存 CRUD ─────────────────────────────

export async function listProxies(env: Env, query: ListProxiesQuery): Promise<CursorPage<ProxyView>> {
  const where: string[] = [];
  const params: unknown[] = [];
  const cursor = decodeCursor(query.cursor);
  if (query.cursor && cursor === null) throw new AppError('validation_failed', '游标非法');
  if (cursor !== null) { where.push('p.id < ?'); params.push(cursor); }
  if (query.status) { where.push('p.status = ?'); params.push(query.status); }
  if (query.provider) { where.push('p.provider = ?'); params.push(query.provider.toLowerCase()); }
  if (query.country) { where.push('p.country = ?'); params.push(query.country.toUpperCase()); }
  if (query.orderId) { where.push('p.order_id = ?'); params.push(query.orderId); }
  if (query.bound === 'yes') where.push('EXISTS (SELECT 1 FROM address_proxy_bindings b2 WHERE b2.proxy_id = p.id)');
  if (query.bound === 'no') where.push('NOT EXISTS (SELECT 1 FROM address_proxy_bindings b2 WHERE b2.proxy_id = p.id)');
  if (query.q) {
    const pattern = likePattern(query.q);
    where.push(`(lower(p.label) LIKE ? ESCAPE '\\' OR lower(p.host) LIKE ? ESCAPE '\\' OR lower(p.username) LIKE ? ESCAPE '\\'
      OR lower(COALESCE(p.provider_ref, '')) LIKE ? ESCAPE '\\' OR lower(p.notes) LIKE ? ESCAPE '\\')`);
    params.push(pattern, pattern, pattern, pattern, pattern);
  }
  const limit = query.limit;
  const sql = `${PROXY_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY p.id DESC LIMIT ?`;
  const { results } = await env.db.prepare(sql).bind(...params, limit + 1).all<ProxyRow>();
  const rows = results.slice(0, limit);
  return {
    items: rows.map(rowView),
    nextCursor: results.length > limit ? encodeCursor(num(rows[rows.length - 1]!.id)) : null,
  };
}

export async function getProxy(env: Env, id: number): Promise<ProxyView> {
  return rowView(await loadProxyRow(env, id));
}

export async function proxyPoolStats(env: Env, now = Date.now()): Promise<ProxyPoolStats> {
  const [totals, providers] = await env.db.batch([
    env.db.prepare(`SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN p.status = 'active' THEN 1 ELSE 0 END), 0) AS active,
        COALESCE(SUM(CASE WHEN p.status = 'expired' THEN 1 ELSE 0 END), 0) AS expired,
        COALESCE(SUM(CASE WHEN p.status = 'disabled' THEN 1 ELSE 0 END), 0) AS disabled,
        COALESCE(SUM(CASE WHEN EXISTS (SELECT 1 FROM address_proxy_bindings b WHERE b.proxy_id = p.id) THEN 1 ELSE 0 END), 0) AS bound,
        COALESCE(SUM(CASE WHEN p.status = 'active' AND (p.expires_at IS NULL OR p.expires_at > ?)
          AND ${BINDING_COUNT_SQL} < p.max_bindings THEN 1 ELSE 0 END), 0) AS free
      FROM proxies p`).bind(now),
    env.db.prepare('SELECT provider, COUNT(*) AS n FROM proxies GROUP BY provider ORDER BY provider'),
  ]);
  const t = (totals!.results[0] ?? {}) as Record<string, unknown>;
  const byProvider: Record<string, number> = {};
  for (const row of providers!.results as { provider: string; n: unknown }[]) byProvider[row.provider] = num(row.n);
  return {
    total: num(t.total), active: num(t.active), expired: num(t.expired), disabled: num(t.disabled),
    bound: num(t.bound), free: num(t.free), byProvider,
  };
}

export async function createProxy(env: Env, actor: Actor, input: ProxyInput, ip = ''): Promise<ProxyView> {
  const parsed = proxyInputSchema.safeParse(input);
  if (!parsed.success) throw new AppError('validation_failed', parsed.error.issues[0]?.message ?? '参数校验失败');
  const p = parsed.data;
  if (p.password === SECRET_MASK) throw new AppError('validation_failed', '新建代理不能使用掩码密码');
  const now = Date.now();
  const expiresAt = parseIsoMs(p.expiresAt);
  const status = effectiveStatus(p.status, expiresAt, now);
  const passwordEnc = await sealSecret(env, p.password);
  let inserted: { id: number } | null;
  try {
    inserted = await env.db.prepare(`INSERT INTO proxies (label, provider, source, protocol, host, port, username, password_enc, product,
        country, region, city, expires_at, status, max_bindings, notes, created_by, updated_at, created_at)
      VALUES (?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
      .bind(p.label, p.provider, p.protocol, p.host, p.port, p.username, passwordEnc, p.product, p.country, p.region, p.city,
        expiresAt, status, p.maxBindings, p.notes, actor.id, now, now)
      .first<{ id: number }>();
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError('conflict', '相同 主机:端口:用户名 的代理已存在');
    throw e;
  }
  if (!inserted) throw new AppError('internal', '代理创建失败');
  await logAdminAction(env, actor, 'proxy.create', `proxy:${inserted.id}`, `${p.host}:${p.port}`, ip);
  return getProxy(env, num(inserted.id));
}

export async function updateProxy(env: Env, actor: Actor, id: number, patch: UpdateProxyRequest, ip = ''): Promise<ProxyView> {
  const row = await loadProxyRow(env, id);
  const now = Date.now();
  const changed: string[] = [];
  const next = {
    label: row.label, provider: row.provider, protocol: row.protocol, host: row.host, port: num(row.port), username: row.username,
    passwordEnc: row.password_enc, product: row.product, country: row.country, region: row.region, city: row.city,
    expiresAt: row.expires_at === null ? null : num(row.expires_at), maxBindings: num(row.max_bindings), notes: row.notes,
  };
  const assign = <K extends keyof typeof next>(key: K, value: (typeof next)[K] | undefined, name: string = key) => {
    if (value === undefined || value === next[key]) return;
    next[key] = value;
    changed.push(name);
  };
  assign('label', patch.label);
  assign('provider', patch.provider);
  assign('protocol', patch.protocol);
  assign('host', patch.host);
  assign('port', patch.port);
  assign('username', patch.username);
  assign('product', patch.product);
  assign('country', patch.country);
  assign('region', patch.region);
  assign('city', patch.city);
  assign('maxBindings', patch.maxBindings);
  assign('notes', patch.notes);
  if (patch.expiresAt !== undefined) assign('expiresAt', parseIsoMs(patch.expiresAt), 'expiresAt');
  if (patch.password !== undefined && patch.password !== SECRET_MASK) {
    next.passwordEnc = await sealSecret(env, patch.password);
    changed.push('password');
  }
  // expired 只由过期时间决定：未显式改状态时按 active 重新计算（续期即恢复）
  const baseStatus: ProxyStatus = patch.status ?? (row.status === 'expired' ? 'active' : row.status as ProxyStatus);
  const status = effectiveStatus(baseStatus, next.expiresAt, now);
  if (status !== row.status) changed.push('status');
  let updated: { id: number } | null;
  try {
    updated = await env.db.prepare(`UPDATE proxies SET label = ?, provider = ?, protocol = ?, host = ?, port = ?, username = ?, password_enc = ?,
        product = ?, country = ?, region = ?, city = ?, expires_at = ?, status = ?, max_bindings = ?, notes = ?, updated_at = ?
      WHERE id = ? RETURNING id`)
      .bind(next.label, next.provider, next.protocol, next.host, next.port, next.username, next.passwordEnc, next.product, next.country,
        next.region, next.city, next.expiresAt, status, next.maxBindings, next.notes, now, id)
      .first<{ id: number }>();
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError('conflict', '相同 主机:端口:用户名 的代理已存在');
    throw e;
  }
  if (!updated) throw new AppError('not_found', '代理不存在');
  if (changed.length) {
    await logAdminAction(env, actor, 'proxy.update', `proxy:${id}`, `${next.host}:${next.port} ${changed.join(',')}`, ip);
  }
  return getProxy(env, id);
}

export async function deleteProxy(env: Env, actor: Actor, id: number, force: boolean, ip = ''): Promise<void> {
  const row = await loadProxyRow(env, id);
  if (force) {
    const [, removed] = await env.db.batch([
      env.db.prepare('DELETE FROM address_proxy_bindings WHERE proxy_id = ?').bind(id),
      env.db.prepare('DELETE FROM proxies WHERE id = ? RETURNING id').bind(id),
    ]);
    if (!removed!.results.length) throw new AppError('not_found', '代理不存在');
  } else {
    // 守卫删除：检查与删除之间新增的绑定同样拦下
    const removed = await env.db.prepare(`DELETE FROM proxies WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM address_proxy_bindings b WHERE b.proxy_id = ?) RETURNING id`)
      .bind(id, id).first<{ id: number }>();
    if (!removed) {
      const still = await env.db.prepare('SELECT id FROM proxies WHERE id = ?').bind(id).first();
      if (!still) throw new AppError('not_found', '代理不存在');
      throw new AppError('conflict', '代理仍有绑定的邮箱，解除绑定后再删除（或强制删除）');
    }
  }
  await logAdminAction(env, actor, 'proxy.delete', `proxy:${id}`, `${row.host}:${row.port}${force ? ' force' : ''}`, ip);
}

interface ImportCandidate {
  line: number;
  input: ProxyInput;
}

function endpointKey(host: string, port: number, username: string): string {
  return `${host}\u0000${port}\u0000${username}`;
}

export async function importProxies(env: Env, actor: Actor, req: ImportProxiesRequest, ip = ''): Promise<ProxyImportResult> {
  const lines = req.text.split(/\r?\n/);
  const nonEmpty = lines.filter((l) => l.trim() && !l.trim().startsWith('#')).length;
  if (nonEmpty > MAX_PROXY_IMPORT_LINES) {
    throw new AppError('validation_failed', `单次最多导入 ${MAX_PROXY_IMPORT_LINES} 行（本次 ${nonEmpty} 行）`);
  }
  const invalid: { line: number; reason: string }[] = [];
  const candidates: ImportCandidate[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  const defaults = req.defaults ?? {};
  lines.forEach((raw, index) => {
    const text = raw.trim();
    if (!text || text.startsWith('#')) return;
    const line = index + 1;
    const parsed = parseProxyLine(text, req.format);
    if ('error' in parsed) { invalid.push({ line, reason: parsed.error }); return; }
    const result = proxyInputSchema.safeParse({
      ...defaults,
      protocol: parsed.protocol ?? defaults.protocol ?? 'http',
      host: parsed.host, port: parsed.port, username: parsed.username, password: parsed.password,
    });
    if (!result.success) { invalid.push({ line, reason: result.error.issues[0]?.message ?? '参数校验失败' }); return; }
    const key = endpointKey(result.data.host, result.data.port, result.data.username);
    if (seen.has(key)) { duplicates++; return; }
    seen.add(key);
    candidates.push({ line, input: result.data });
  });

  if (req.dryRun) {
    const existing = await existingEndpoints(env, candidates.map((c) => c.input.host));
    const fresh = candidates.filter((c) => !existing.has(endpointKey(c.input.host, c.input.port, c.input.username)));
    return { created: fresh.length, duplicates: duplicates + candidates.length - fresh.length, invalid, dryRun: true };
  }

  const now = Date.now();
  let created = 0;
  for (const group of chunk(candidates, STATEMENTS_PER_BATCH)) {
    const statements = await Promise.all(group.map(async ({ input: p }) => {
      const expiresAt = parseIsoMs(p.expiresAt);
      return env.db.prepare(`INSERT INTO proxies (label, provider, source, protocol, host, port, username, password_enc, product,
          country, region, city, expires_at, status, max_bindings, notes, created_by, updated_at, created_at)
        VALUES (?, ?, 'import', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT DO NOTHING RETURNING id`)
        .bind(p.label, p.provider, p.protocol, p.host, p.port, p.username, await sealSecret(env, p.password), p.product, p.country,
          p.region, p.city, expiresAt, effectiveStatus(p.status, expiresAt, now), p.maxBindings, p.notes, actor.id, now, now);
    }));
    const results = await env.db.batch(statements);
    created += results.filter((r) => r.results.length > 0).length;
  }
  duplicates += candidates.length - created;
  await logAdminAction(env, actor, 'proxy.import', 'proxies', `created=${created} duplicates=${duplicates} invalid=${invalid.length}`, ip);
  return { created, duplicates, invalid, dryRun: false };
}

async function existingEndpoints(env: Env, hosts: string[]): Promise<Set<string>> {
  const unique = [...new Set(hosts)];
  const found = new Set<string>();
  for (const group of chunk(unique, 500)) {
    const { results } = await env.db.prepare('SELECT host, port, username FROM proxies WHERE host IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(group)).all<{ host: string; port: number; username: string }>();
    for (const r of results) found.add(endpointKey(r.host, num(r.port), r.username));
  }
  return found;
}

export async function revealProxy(env: Env, actor: Actor, id: number, ip = ''): Promise<ProxyCredential> {
  const row = await loadProxyRow(env, id);
  const credential = await credentialOf(env, row);
  await logAdminAction(env, actor, 'proxy.reveal', `proxy:${id}`, '', ip);
  return credential;
}

export async function reportProxyHealth(env: Env, id: number, report: ProxyHealthReport): Promise<ProxyView> {
  const now = Date.now();
  const updated = await env.db.prepare(`UPDATE proxies SET health_status = ?, health_checked_at = ?, health_latency_ms = ?, health_error = ?, updated_at = ?
      WHERE id = ? RETURNING id`)
    .bind(report.ok ? 'ok' : 'fail', now, report.latencyMs ?? null, report.ok ? '' : (report.error ?? '').slice(0, 500), now, id)
    .first();
  if (!updated) throw new AppError('not_found', '代理不存在');
  return getProxy(env, id);
}

/** cron：active 且 expires_at 已过 → expired */
export async function expireProxies(env: Env, now = Date.now()): Promise<number> {
  const { results } = await env.db.prepare(`UPDATE proxies SET status = 'expired', updated_at = ?
      WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ? RETURNING id`).bind(now, now).all();
  return results.length;
}

/**
 * 供应商同步：按 (provider, provider_ref) 幂等 upsert。
 * - 新行带上 orderId；已存在的行保留原 order_id（含 NULL，不改归属：整账户同步会列出全部服务器，不能把早已存在、
 *   未关联的旧服务器记到当前订单上；下单后才入库的由采购侧按入库时间认领）、max_bindings、label、notes，刷新端点/凭据/地区/过期时间。
 * - 端点（host:port:username）已被另一条代理占用的行跳过（不接管手工录入的代理）。
 * - 供应商列表里消失的行不删除，只由 expires_at 决定 expired。
 */
export async function upsertProviderProxies(env: Env, rows: ProviderProxyRow[], orderId: number | null): Promise<{ created: number; updated: number; skipped: number }> {
  if (!rows.length) return { created: 0, updated: 0, skipped: 0 };
  const now = Date.now();
  const byRef = new Map<string, ProviderProxyRow>();
  for (const row of rows) byRef.set(`${row.provider}\u0000${row.providerRef}`, row);
  const unique = [...byRef.values()];
  const existingRefs = new Set<string>();
  const endpointOwners = new Map<string, string>();
  for (const group of chunk(unique, 500)) {
    const [refs, endpoints] = await env.db.batch([
      env.db.prepare('SELECT provider, provider_ref FROM proxies WHERE provider_ref IN (SELECT value FROM json_each(?))')
        .bind(JSON.stringify(group.map((r) => r.providerRef))),
      env.db.prepare('SELECT host, port, username, provider, provider_ref FROM proxies WHERE host IN (SELECT value FROM json_each(?))')
        .bind(JSON.stringify([...new Set(group.map((r) => r.host.toLowerCase()))])),
    ]);
    for (const r of refs!.results as { provider: string; provider_ref: string }[]) existingRefs.add(`${r.provider}\u0000${r.provider_ref}`);
    for (const r of endpoints!.results as { host: string; port: number; username: string; provider: string; provider_ref: string | null }[]) {
      endpointOwners.set(endpointKey(r.host, num(r.port), r.username), `${r.provider}\u0000${r.provider_ref ?? ''}`);
    }
  }
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const writable: ProviderProxyRow[] = [];
  for (const row of unique) {
    const ref = `${row.provider}\u0000${row.providerRef}`;
    const owner = endpointOwners.get(endpointKey(row.host.toLowerCase(), row.port, row.username));
    if (owner !== undefined && owner !== ref) { skipped++; continue; }
    writable.push(row);
  }
  for (const group of chunk(writable, STATEMENTS_PER_BATCH)) {
    const statements = await Promise.all(group.map(async (r) => {
      const status = r.expiresAt !== null && r.expiresAt <= now ? 'expired' : 'active';
      return env.db.prepare(`INSERT INTO proxies (label, provider, source, protocol, host, port, username, password_enc, product, country, region, city,
          provider_ref, order_id, expires_at, status, max_bindings, created_by, updated_at, created_at)
        VALUES (?1, ?2, 'proxy1024', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, 0, ?17, ?17)
        ON CONFLICT(provider, provider_ref) DO UPDATE SET protocol = excluded.protocol, host = excluded.host, port = excluded.port,
          username = excluded.username, password_enc = excluded.password_enc, product = excluded.product, country = excluded.country,
          region = excluded.region, city = excluded.city, expires_at = excluded.expires_at,
          status = CASE WHEN proxies.status = 'disabled' THEN 'disabled' ELSE excluded.status END,
          updated_at = excluded.updated_at
        RETURNING id`)
        .bind(r.label ?? '', r.provider, r.protocol, r.host.toLowerCase(), r.port, r.username, await sealSecret(env, r.password), r.product,
          r.country.toUpperCase(), r.region, r.city, r.providerRef, orderId, r.expiresAt, status, r.maxBindings ?? 1, now);
    }));
    await env.db.batch(statements);
    for (const r of group) {
      if (existingRefs.has(`${r.provider}\u0000${r.providerRef}`)) updated++;
      else created++;
    }
  }
  return { created, updated, skipped };
}

// ───────────────────────────── 绑定 ─────────────────────────────

interface BindingRow {
  address: string;
  domain: string;
  proxy_id: number;
  source: string;
  bound_by: number;
  b_created_at: number;
  b_updated_at: number;
  label: string;
  provider: string;
  protocol: string;
  host: string;
  port: number;
  username: string;
  country: string;
  status: string;
  expires_at: number | null;
  health_status: string;
  health_checked_at: number | null;
  health_latency_ms: number | null;
  health_error: string;
  owner_user_id: number | null;
  owner_username: string | null;
}

const BINDING_SELECT = `SELECT b.address, b.domain, b.proxy_id, b.source, b.bound_by, b.created_at AS b_created_at, b.updated_at AS b_updated_at,
    p.label, p.provider, p.protocol, p.host, p.port, p.username, p.country, p.status, p.expires_at,
    p.health_status, p.health_checked_at, p.health_latency_ms, p.health_error,
    m.user_id AS owner_user_id, u.username AS owner_username
  FROM address_proxy_bindings b
  JOIN proxies p ON p.id = b.proxy_id
  LEFT JOIN mailboxes m ON m.address = b.address
  LEFT JOIN users u ON u.id = m.user_id`;

function toBindingView(row: BindingRow): ProxyBindingView {
  return {
    address: row.address,
    domain: row.domain,
    proxyId: num(row.proxy_id),
    source: row.source as ProxyBindingSource,
    boundBy: num(row.bound_by),
    createdAt: iso(row.b_created_at)!,
    updatedAt: iso(row.b_updated_at)!,
    proxy: {
      id: num(row.proxy_id),
      label: row.label,
      provider: row.provider,
      protocol: row.protocol as ProxyProtocol,
      host: row.host,
      port: num(row.port),
      username: row.username,
      country: row.country,
      status: row.status as ProxyStatus,
      expiresAt: iso(row.expires_at),
      health: {
        status: row.health_status as ProxyHealthStatus,
        checkedAt: iso(row.health_checked_at),
        latencyMs: row.health_latency_ms === null || row.health_latency_ms === undefined ? null : num(row.health_latency_ms),
        error: row.health_error,
      },
    },
    ownerUserId: row.owner_user_id === null || row.owner_user_id === undefined ? null : num(row.owner_user_id),
    ownerUsername: row.owner_username ?? null,
  };
}

export async function listBindings(env: Env, query: ListBindingsQuery): Promise<CursorPage<ProxyBindingView>> {
  const where: string[] = [];
  const params: unknown[] = [];
  const cursor = decodeAddressCursor(query.cursor);
  if (cursor) { where.push('b.address > ?'); params.push(cursor); }
  if (query.domain) { where.push('b.domain = ?'); params.push(query.domain.toLowerCase()); }
  if (query.proxyId) { where.push('b.proxy_id = ?'); params.push(query.proxyId); }
  if (query.q) { where.push(`b.address LIKE ? ESCAPE '\\'`); params.push(likePattern(query.q)); }
  const limit = query.limit;
  const { results } = await env.db.prepare(`${BINDING_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY b.address LIMIT ?`)
    .bind(...params, limit + 1).all<BindingRow>();
  const rows = results.slice(0, limit);
  return {
    items: rows.map(toBindingView),
    nextCursor: results.length > limit ? encodeAddressCursor(rows[rows.length - 1]!.address) : null,
  };
}

/** 一次查询批量查地址绑定（按输入顺序返回，未绑定为 null） */
export async function lookupBindings(env: Env, addresses: string[]): Promise<ProxyBindingLookupItem[]> {
  const normalized = [...new Set(addresses.map(normalizeAddress))];
  if (!normalized.length) return [];
  const { results } = await env.db.prepare(`${BINDING_SELECT} WHERE b.address IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(normalized)).all<BindingRow>();
  const byAddress = new Map(results.map((r) => [r.address, toBindingView(r)]));
  return normalized.map((address) => ({ address, binding: byAddress.get(address) ?? null }));
}

async function getBinding(env: Env, address: string): Promise<ProxyBindingView | null> {
  const row = await env.db.prepare(`${BINDING_SELECT} WHERE b.address = ?`).bind(address).first<BindingRow>();
  return row ? toBindingView(row) : null;
}

/**
 * 单语句守卫绑定（两种引擎都原子）：代理必须 active、未过期、且（除本地址外）绑定数 < max_bindings。
 * onConflict='update' 用于手工绑定（改绑）；'nothing' 用于自动分配（并发的手工绑定优先）。
 */
function bindStatement(env: Env, address: string, proxyId: number, source: ProxyBindingSource, actorId: number, now: number, onConflict: 'update' | 'nothing'): D1PreparedStatement {
  const conflict = onConflict === 'update'
    ? 'DO UPDATE SET proxy_id = excluded.proxy_id, source = excluded.source, bound_by = excluded.bound_by, updated_at = excluded.updated_at'
    : 'DO NOTHING';
  return env.db.prepare(`INSERT INTO address_proxy_bindings (address, proxy_id, domain, source, bound_by, created_at, updated_at)
      SELECT ?1, p.id, ?2, ?3, ?4, ?5, ?5 FROM proxies p
      WHERE p.id = ?6 AND p.status = 'active' AND (p.expires_at IS NULL OR p.expires_at > ?5)
        AND (SELECT COUNT(*) FROM address_proxy_bindings b WHERE b.proxy_id = p.id AND b.address <> ?1) < p.max_bindings
      ON CONFLICT(address) ${conflict}
      RETURNING address`).bind(address, domainOf(address), source, actorId, now, proxyId);
}

export async function bindAddress(env: Env, actor: Actor, address: string, proxyId: number, ip = '', source: ProxyBindingSource = 'manual'): Promise<ProxyBindingView> {
  const normalized = normalizeAddress(address);
  const now = Date.now();
  const bound = await bindStatement(env, normalized, proxyId, source, actor.id, now, 'update').first();
  if (!bound) {
    const proxy = await env.db.prepare('SELECT status, expires_at FROM proxies WHERE id = ?').bind(proxyId).first<{ status: string; expires_at: number | null }>();
    if (!proxy) throw new AppError('not_found', '代理不存在');
    if (proxy.status !== 'active' || (proxy.expires_at !== null && num(proxy.expires_at) <= now)) {
      throw new AppError('conflict', '代理已停用或已过期，不能绑定');
    }
    throw new AppError('conflict', '该代理的绑定数已满');
  }
  await logAdminAction(env, actor, 'proxy.bind', normalized, `proxy:${proxyId}`, ip);
  const view = await getBinding(env, normalized);
  if (!view) throw new AppError('conflict', '绑定已被并发修改，请刷新后重试');
  return view;
}

export async function unbindAddress(env: Env, actor: Actor, address: string, ip = ''): Promise<void> {
  const normalized = normalizeAddress(address);
  const removed = await env.db.prepare('DELETE FROM address_proxy_bindings WHERE address = ? RETURNING proxy_id').bind(normalized).first<{ proxy_id: number }>();
  if (!removed) throw new AppError('not_found', '该地址没有绑定代理');
  await logAdminAction(env, actor, 'proxy.unbind', normalized, `proxy:${num(removed.proxy_id)}`, ip);
}

export async function autoAssignProxies(env: Env, actor: Actor, req: AutoAssignRequest, ip = ''): Promise<AutoAssignResult> {
  const now = Date.now();
  let candidates: string[];
  if (req.target === 'claimed') {
    const { results } = await env.db.prepare(`SELECT m.address FROM mailboxes m
        WHERE NOT EXISTS (SELECT 1 FROM address_proxy_bindings b WHERE b.address = m.address)${req.domain ? ' AND m.domain = ?' : ''}
        ORDER BY m.id LIMIT ?`)
      .bind(...(req.domain ? [req.domain.toLowerCase()] : []), req.limit).all<{ address: string }>();
    candidates = results.map((r) => r.address.toLowerCase());
  } else {
    const wanted = [...new Set((req.addresses ?? []).map(normalizeAddress))];
    if (!wanted.length) throw new AppError('validation_failed', 'target=addresses 需要提供地址列表');
    const { results } = await env.db.prepare('SELECT address FROM address_proxy_bindings WHERE address IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(wanted)).all<{ address: string }>();
    const bound = new Set(results.map((r) => r.address));
    candidates = wanted.filter((a) => !bound.has(a)).slice(0, req.limit);
  }

  const filters: string[] = [];
  const filterParams: unknown[] = [];
  if (req.filter.provider) { filters.push('p.provider = ?'); filterParams.push(req.filter.provider.toLowerCase()); }
  if (req.filter.country) { filters.push('p.country = ?'); filterParams.push(req.filter.country.toUpperCase()); }
  if (req.filter.product) { filters.push('p.product = ?'); filterParams.push(req.filter.product); }
  const freeWhere = `p.status = 'active' AND (p.expires_at IS NULL OR p.expires_at > ?) AND ${BINDING_COUNT_SQL} < p.max_bindings${filters.length ? ` AND ${filters.join(' AND ')}` : ''}`;
  const [freeRows, freeTotal] = await env.db.batch([
    env.db.prepare(`SELECT p.id, p.max_bindings - ${BINDING_COUNT_SQL} AS free_slots FROM proxies p WHERE ${freeWhere} ORDER BY p.id LIMIT ?`)
      .bind(now, ...filterParams, Math.max(candidates.length, 1)),
    env.db.prepare(`SELECT COUNT(*) AS n FROM proxies p WHERE ${freeWhere}`).bind(now, ...filterParams),
  ]);
  const slots = (freeRows!.results as { id: number; free_slots: unknown }[]).map((r) => ({ id: num(r.id), free: num(r.free_slots) }));
  const totalFree = num((freeTotal!.results[0] as { n?: unknown } | undefined)?.n);

  const pairs: { address: string; proxyId: number }[] = [];
  const unassigned: string[] = [];
  let cursor = 0;
  for (const address of candidates) {
    while (cursor < slots.length && slots[cursor]!.free <= 0) cursor++;
    const slot = slots[cursor];
    if (!slot) { unassigned.push(address); continue; }
    pairs.push({ address, proxyId: slot.id });
    slot.free--;
  }

  const fullyUsed = (assigned: { proxyId: number }[]) => {
    const used = new Map<number, number>();
    for (const a of assigned) used.set(a.proxyId, (used.get(a.proxyId) ?? 0) + 1);
    const original = new Map((freeRows!.results as { id: number; free_slots: unknown }[]).map((r) => [num(r.id), num(r.free_slots)]));
    return [...used].filter(([id, n]) => n >= (original.get(id) ?? 0)).length;
  };

  if (req.dryRun) {
    return { assigned: pairs, unassigned, freeProxiesLeft: Math.max(0, totalFree - fullyUsed(pairs)), dryRun: true };
  }

  const assigned: { address: string; proxyId: number }[] = [];
  for (const group of chunk(pairs, STATEMENTS_PER_BATCH)) {
    const results = await env.db.batch(group.map((pair) => bindStatement(env, pair.address, pair.proxyId, 'auto', actor.id, now, 'nothing')));
    group.forEach((pair, i) => {
      if (results[i]!.results.length) assigned.push(pair);
      else unassigned.push(pair.address);
    });
  }
  if (assigned.length || pairs.length) {
    const target = req.target === 'claimed' ? (req.domain ?? 'claimed') : 'addresses';
    await logAdminAction(env, actor, 'proxy.auto_assign', target, `assigned=${assigned.length} unassigned=${unassigned.length}`, ip);
  }
  return { assigned, unassigned, freeProxiesLeft: Math.max(0, totalFree - fullyUsed(assigned)), dryRun: false };
}

// ───────────────────────────── 导出 ─────────────────────────────

interface CredentialRow {
  id: number;
  protocol: string;
  host: string;
  port: number;
  username: string;
  password_enc: string;
  country: string;
  city: string;
  product: string;
  status: string;
  expires_at: number | null;
  label?: string;
  provider?: string;
  address?: string;
}

const CREDENTIAL_COLUMNS = 'p.id, p.protocol, p.host, p.port, p.username, p.password_enc, p.country, p.city, p.product, p.status, p.expires_at';

/** 同一代理只解密一次 */
function credentialCache(env: Env) {
  const cache = new Map<number, Promise<ProxyCredential>>();
  return (row: CredentialRow) => {
    const id = num(row.id);
    let hit = cache.get(id);
    if (!hit) { hit = credentialOf(env, row); cache.set(id, hit); }
    return hit;
  };
}

/**
 * 导出：
 * - scope=bindings：每行 `地址<TAB>代理`（json 为 [{address, ...凭据}]）
 * - scope=proxies：每行一个代理（json 为 [{id, label, provider, ...凭据}]）
 * 超过 MAX_PROXY_EXPORT_ROWS 行时拒绝，请按域名/状态缩小范围。
 */
export async function exportProxies(env: Env, actor: Actor, query: ExportProxiesQuery, ip = ''): Promise<ProxyExport> {
  const where: string[] = [];
  const params: unknown[] = [];
  let sql: string;
  if (query.scope === 'bindings') {
    if (query.domain) { where.push('b.domain = ?'); params.push(query.domain.toLowerCase()); }
    if (query.status) { where.push('p.status = ?'); params.push(query.status); }
    sql = `SELECT b.address, ${CREDENTIAL_COLUMNS} FROM address_proxy_bindings b JOIN proxies p ON p.id = b.proxy_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY b.address LIMIT ?`;
  } else {
    if (query.domain) {
      where.push('EXISTS (SELECT 1 FROM address_proxy_bindings b WHERE b.proxy_id = p.id AND b.domain = ?)');
      params.push(query.domain.toLowerCase());
    }
    if (query.status) { where.push('p.status = ?'); params.push(query.status); }
    sql = `SELECT ${CREDENTIAL_COLUMNS}, p.label, p.provider FROM proxies p ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.id LIMIT ?`;
  }
  const { results } = await env.db.prepare(sql).bind(...params, MAX_PROXY_EXPORT_ROWS + 1).all<CredentialRow>();
  if (results.length > MAX_PROXY_EXPORT_ROWS) {
    throw new AppError('validation_failed', `导出超过 ${MAX_PROXY_EXPORT_ROWS} 行，请按域名或状态筛选`);
  }
  const reveal = credentialCache(env);
  const credentials = await Promise.all(results.map(reveal));
  let content: string;
  if (query.format === 'json') {
    content = JSON.stringify(results.map((row, i) => {
      const c = credentials[i]!;
      return query.scope === 'bindings'
        ? { address: row.address, ...c }
        : { id: c.proxyId, label: row.label ?? '', provider: row.provider ?? '', ...c };
    }));
  } else {
    content = results.map((row, i) => {
      const line = formatProxyLine(credentials[i]!, query.format);
      return query.scope === 'bindings' ? `${row.address}\t${line}` : line;
    }).join('\n');
  }
  await logAdminAction(env, actor, 'proxy.export', 'proxies', `format=${query.format} scope=${query.scope} count=${results.length}`, ip);
  return { format: query.format, count: results.length, content };
}

// ───────────────────────────── 调用方视角（/v1 与 /api/proxies/mine） ─────────────────────────────

const VIEWER_SELECT = `SELECT b.address, ${CREDENTIAL_COLUMNS} FROM address_proxy_bindings b JOIN proxies p ON p.id = b.proxy_id`;

/** 地址对应的代理凭据：管理员看任意地址；普通用户只看自己认领的地址（共享给我的不算）。不可见或未绑定都返回 null。 */
export async function getProxyForAddress(env: Env, viewer: ProxyViewer, address: string): Promise<ProxyCredential | null> {
  const normalized = normalizeAddress(address);
  const row = viewer.role === 'admin'
    ? await env.db.prepare(`${VIEWER_SELECT} WHERE b.address = ?`).bind(normalized).first<CredentialRow>()
    : await env.db.prepare(`${VIEWER_SELECT} JOIN mailboxes m ON m.address = b.address AND m.user_id = ? WHERE b.address = ?`)
      .bind(viewer.userId, normalized).first<CredentialRow>();
  return row ? credentialOf(env, row) : null;
}

/**
 * /v1/proxies/lookup：管理员任意地址；非管理员必须是当前认领人，否则 404（不泄露地址是否存在/是否绑定）。
 * 可见但未绑定 → proxy: null。
 */
export async function lookupProxyForViewer(env: Env, viewer: ProxyViewer, address: string): Promise<V1ProxyLookup> {
  const normalized = normalizeAddress(address);
  if (viewer.role !== 'admin') {
    const owned = await env.db.prepare('SELECT 1 AS ok FROM mailboxes WHERE address = ? AND user_id = ?').bind(normalized, viewer.userId).first();
    if (!owned) throw new AppError('not_found', '地址不存在或不属于你');
  }
  return { address: normalized, proxy: await getProxyForAddress(env, viewer, normalized) };
}

/** /v1/proxies：默认只列自己认领地址的绑定；all=1 仅管理员（全站）。游标 = 地址。 */
export async function listViewerProxies(env: Env, viewer: ProxyViewer, q: V1ProxyListQuery): Promise<CursorPage<MyProxyBinding>> {
  if (q.all && viewer.role !== 'admin') throw new AppError('forbidden', '需要管理员权限');
  const where: string[] = [];
  const params: unknown[] = [];
  let join = '';
  if (!q.all) { join = ' JOIN mailboxes m ON m.address = b.address AND m.user_id = ?'; params.push(viewer.userId); }
  const cursor = decodeAddressCursor(q.cursor);
  if (cursor) { where.push('b.address > ?'); params.push(cursor); }
  if (q.domain) { where.push('b.domain = ?'); params.push(q.domain.toLowerCase()); }
  const { results } = await env.db.prepare(`${VIEWER_SELECT}${join}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY b.address LIMIT ?`)
    .bind(...params, q.limit + 1).all<CredentialRow>();
  const rows = results.slice(0, q.limit);
  const reveal = credentialCache(env);
  const items = await Promise.all(rows.map(async (row) => ({ address: row.address!, proxy: await reveal(row) })));
  return { items, nextCursor: results.length > q.limit ? encodeAddressCursor(rows[rows.length - 1]!.address!) : null };
}

/** /api/proxies/mine：自己认领地址的代理（最多 500 条） */
export async function listMyProxies(env: Env, userId: number): Promise<MyProxyBinding[]> {
  const { results } = await env.db.prepare(`${VIEWER_SELECT} JOIN mailboxes m ON m.address = b.address AND m.user_id = ? ORDER BY b.address LIMIT 500`)
    .bind(userId).all<CredentialRow>();
  const reveal = credentialCache(env);
  return Promise.all(results.map(async (row) => ({ address: row.address!, proxy: await reveal(row) })));
}
