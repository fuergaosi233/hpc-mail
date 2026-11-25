import { SPACESHIP_AVAILABILITY_CHUNK, usdToCents, type RegistrantContactRequest } from '@hpc-mail/shared';

/**
 * Spaceship REST 客户端（docs/integrations/spaceship-api.md）。
 *
 * - 只发往 SPACESHIP_API，凭据只放在请求头，错误信息里从不带凭据。
 * - 客户端内不重试：429 / 5xx / 超时由调用方按状态机决定（注册结果不明必须标 unknown，不能重发）。
 * - workerd 的 fetch 不支持 redirect: 'error'，用 manual 并把 3xx 当失败。
 */
export const SPACESHIP_API = 'https://spaceship.dev/api';
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * rejected：请求被明确拒绝（400/401/403/422 等），没有副作用；
 * rate_limited：429，请求在处理前被拒，稍后再试安全；
 * not_found：404；
 * transient：读请求的网络错误 / 超时 / 5xx，稍后再试；
 * unknown：注册请求结果不明（可能已扣费），绝不自动重试。
 */
export type SpaceshipOutcome = 'rejected' | 'rate_limited' | 'not_found' | 'transient' | 'unknown';

export class SpaceshipError extends Error {
  constructor(
    readonly status: number,
    readonly outcome: SpaceshipOutcome,
    message: string,
    readonly code = '',
    readonly operationId = '',
    readonly retryAfterSec: number | null = null,
    readonly detail = '',
    readonly fields: { field: string; details: string }[] = [],
  ) {
    super(message);
    this.name = 'SpaceshipError';
  }
}

export interface SsAvailability {
  domain: string;
  result: 'available' | 'taken' | 'invalidDomainName' | 'tldNotSupported' | 'unexpectedError';
}
export interface SsPrice {
  domain: string;
  priceClass: 'standard' | 'premium';
  finalCents: number;
  regularCents: number;
  years: number;
}
export interface SsAsyncOp {
  status: 'pending' | 'success' | 'failed';
  type: string;
  details: unknown;
  createdAt: string;
  modifiedAt: string;
}
export interface SsDomainInfo {
  name: string;
  lifecycleStatus: string;
  verificationStatus: string | null;
  suspensions: string[];
  nameservers: { provider: string; hosts: string[] } | null;
}

export interface SpaceshipClient {
  /** 自动按 ≤ 20 个分组；按域名匹配结果，不依赖返回顺序。响应里缺失的域名记为 unexpectedError */
  checkAvailability(domains: string[]): Promise<SsAvailability[]>;
  /**
   * 注册 `years` 年的价格；自动按 ≤ 20 个分组。没有对应年限的 register 价、返回 errorCode、
   * 非 USD 或未知 priceClass 的域名不出现在结果里（视为无法报价）。
   */
  queryPricing(domains: string[], years: number): Promise<SsPrice[]>;
  saveContact(c: RegistrantContactRequest): Promise<{ contactId: string }>;
  registerDomain(domain: string, body: { years: number; autoRenew: boolean; privacyLevel: 'public' | 'high'; registrantContactId: string }): Promise<{ operationId: string }>;
  getAsyncOperation(id: string): Promise<SsAsyncOp>;
  /** 404 → null */
  getDomain(domain: string): Promise<SsDomainInfo | null>;
  listDomains(q: { take: number; skip: number; orderBy?: '-registrationDate' }): Promise<{ items: SsDomainInfo[]; total: number }>;
  setNameservers(domain: string, hosts: string[]): Promise<{ hosts: string[] }>;
}

type FetchFn = typeof fetch;

interface RequestOptions {
  /** register：网络错误 / 5xx / 3xx 视为结果不明 */
  kind: 'read' | 'write' | 'register';
}

function retryAfter(headers: Headers): number | null {
  const raw = headers.get('Retry-After');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : null;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function text(value: unknown, max = 500): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function toDomainInfo(raw: unknown): SsDomainInfo {
  const r = (raw ?? {}) as Record<string, unknown>;
  const ns = r.nameservers as { provider?: unknown; hosts?: unknown } | undefined;
  const suspensions = Array.isArray(r.suspensions) ? r.suspensions : [];
  return {
    name: text(r.name, 255).toLowerCase(),
    lifecycleStatus: text(r.lifecycleStatus, 32),
    verificationStatus: typeof r.verificationStatus === 'string' ? r.verificationStatus : null,
    suspensions: suspensions.map((s) => text((s as { reasonCode?: unknown })?.reasonCode, 64)).filter(Boolean),
    nameservers: ns && typeof ns === 'object'
      ? { provider: text(ns.provider, 16), hosts: Array.isArray(ns.hosts) ? ns.hosts.map((h) => text(h, 255).toLowerCase()) : [] }
      : null,
  };
}

export function createSpaceshipClient(
  creds: { apiKey: string; apiSecret: string },
  opts: { fetch?: FetchFn; timeoutMs?: number } = {},
): SpaceshipClient {
  const doFetch: FetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request(method: string, path: string, body: unknown, { kind }: RequestOptions): Promise<Response> {
    const lost: SpaceshipOutcome = kind === 'register' ? 'unknown' : 'transient';
    let res: Response;
    try {
      res = await doFetch(`${SPACESHIP_API}${path}`, {
        method,
        headers: {
          'X-API-Key': creds.apiKey,
          'X-API-Secret': creds.apiSecret,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new SpaceshipError(0, lost, timeout ? 'Spaceship 请求超时' : `Spaceship 请求失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (res.status >= 200 && res.status < 300) return res;
    const code = (res.headers.get('spaceship-error-code') ?? '').slice(0, 255);
    const operationId = (res.headers.get('spaceship-operation-id') ?? '').slice(0, 64);
    let detail = '';
    let fields: { field: string; details: string }[] = [];
    try {
      const payload = await res.json() as { detail?: unknown; data?: unknown };
      detail = text(payload?.detail);
      if (Array.isArray(payload?.data)) {
        fields = payload.data.slice(0, 10).map((item) => ({ field: text((item as { field?: unknown })?.field, 100), details: text((item as { details?: unknown })?.details, 300) }));
      }
    } catch {
      // 非 JSON 错误体
    }
    const summary = [detail, ...fields.map((f) => `${f.field}: ${f.details}`)].filter(Boolean).join('; ');
    const message = `Spaceship HTTP ${res.status}${code ? ` ${code}` : ''}${summary ? `：${summary}` : ''}`;
    let outcome: SpaceshipOutcome;
    if (res.status === 429) outcome = 'rate_limited';
    else if (res.status >= 500 || res.status < 200 || (res.status >= 300 && res.status < 400)) outcome = lost;
    else if (res.status === 404) outcome = 'not_found';
    else outcome = 'rejected';
    throw new SpaceshipError(res.status, outcome, message, code, operationId, res.status === 429 ? retryAfter(res.headers) : null, detail, fields);
  }

  async function json<T>(res: Response, kind: RequestOptions['kind']): Promise<T> {
    try {
      return await res.json() as T;
    } catch {
      throw new SpaceshipError(res.status, kind === 'register' ? 'unknown' : 'transient', 'Spaceship 响应不是合法 JSON');
    }
  }

  return {
    async checkAvailability(domains) {
      const out: SsAvailability[] = [];
      for (const group of chunk(domains, SPACESHIP_AVAILABILITY_CHUNK)) {
        const res = await request('POST', '/v1/domains/available', { domains: group }, { kind: 'read' });
        const payload = await json<{ domains?: { domain?: unknown; result?: unknown }[] }>(res, 'read');
        const byName = new Map<string, SsAvailability['result']>();
        for (const item of payload.domains ?? []) {
          const name = text(item?.domain, 255).toLowerCase();
          const result = item?.result;
          if (result === 'available' || result === 'taken' || result === 'invalidDomainName' || result === 'tldNotSupported') byName.set(name, result);
          else byName.set(name, 'unexpectedError');
        }
        for (const domain of group) out.push({ domain, result: byName.get(domain.toLowerCase()) ?? 'unexpectedError' });
      }
      return out;
    },

    async queryPricing(domains, years) {
      const out: SsPrice[] = [];
      for (const group of chunk(domains, SPACESHIP_AVAILABILITY_CHUNK)) {
        const res = await request('POST', '/v1/domains/pricing/query', { domains: group }, { kind: 'read' });
        const payload = await json<{ domains?: unknown[]; items?: unknown[] } | unknown[]>(res, 'read');
        const list = Array.isArray(payload) ? payload : (payload.domains ?? payload.items ?? []);
        const wanted = new Set(group.map((d) => d.toLowerCase()));
        for (const raw of list) {
          const item = (raw ?? {}) as { domain?: unknown; priceClass?: unknown; prices?: { register?: unknown } };
          const domain = text(item.domain, 255).toLowerCase();
          if (!wanted.has(domain) || (item.priceClass !== 'standard' && item.priceClass !== 'premium')) continue;
          const register = Array.isArray(item.prices?.register) ? item.prices.register : [];
          const match = register.find((p) => {
            const period = (p as { period?: { value?: unknown; unit?: unknown } })?.period;
            return period?.unit === 'y' && Number(period.value) === years;
          }) as { priceInDefaultCurrency?: { finalPrice?: { amount?: unknown; currency?: unknown }; regularPrice?: { amount?: unknown; currency?: unknown } } } | undefined;
          const pair = match?.priceInDefaultCurrency;
          if (!pair?.finalPrice || !pair.regularPrice) continue;
          if (pair.finalPrice.currency !== 'USD' || pair.regularPrice.currency !== 'USD') continue;
          try {
            out.push({
              domain, priceClass: item.priceClass, years,
              finalCents: usdToCents(String(pair.finalPrice.amount)),
              regularCents: usdToCents(String(pair.regularPrice.amount)),
            });
          } catch {
            // 金额无法解析：视为无法报价
          }
          wanted.delete(domain);
        }
      }
      return out;
    },

    async saveContact(c) {
      const body = Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined && v !== ''));
      const res = await request('PUT', '/v1/contacts', body, { kind: 'write' });
      const payload = await json<{ contactId?: unknown }>(res, 'write');
      const contactId = text(payload.contactId, 64);
      if (!/^[A-Za-z0-9]{27,32}$/.test(contactId)) throw new SpaceshipError(res.status, 'transient', 'Spaceship 未返回有效的联系人 ID');
      return { contactId };
    },

    async registerDomain(domain, body) {
      const contact = body.registrantContactId;
      const res = await request('POST', `/v1/domains/${encodeURIComponent(domain)}`, {
        autoRenew: body.autoRenew,
        years: body.years,
        privacyProtection: { level: body.privacyLevel, userConsent: true },
        contacts: { registrant: contact, admin: contact, tech: contact, billing: contact },
      }, { kind: 'register' });
      const operationId = res.headers.get('spaceship-async-operationid') ?? '';
      // 202 是唯一承诺的成功形态；其他 2xx 或缺少操作号都无法确认结果
      if (res.status !== 202 || !/^[a-zA-Z0-9]{1,36}$/.test(operationId)) {
        throw new SpaceshipError(res.status, 'unknown', `Spaceship 注册响应缺少异步操作号（HTTP ${res.status}）`);
      }
      return { operationId };
    },

    async getAsyncOperation(id) {
      const res = await request('GET', `/v1/async-operations/${encodeURIComponent(id)}`, undefined, { kind: 'read' });
      const payload = await json<Record<string, unknown>>(res, 'read');
      const status = payload.status;
      if (status !== 'pending' && status !== 'success' && status !== 'failed') {
        throw new SpaceshipError(res.status, 'transient', `Spaceship 异步操作状态未知：${text(status, 32)}`);
      }
      return { status, type: text(payload.type, 255), details: payload.details ?? null, createdAt: text(payload.createdAt, 40), modifiedAt: text(payload.modifiedAt, 40) };
    },

    async getDomain(domain) {
      try {
        const res = await request('GET', `/v1/domains/${encodeURIComponent(domain)}`, undefined, { kind: 'read' });
        return toDomainInfo(await json(res, 'read'));
      } catch (error) {
        if (error instanceof SpaceshipError && error.outcome === 'not_found') return null;
        throw error;
      }
    },

    async listDomains(q) {
      const query = new URLSearchParams({ take: String(q.take), skip: String(q.skip) });
      if (q.orderBy) query.set('orderBy', q.orderBy);
      const res = await request('GET', `/v1/domains?${query}`, undefined, { kind: 'read' });
      const payload = await json<{ items?: unknown[]; total?: unknown }>(res, 'read');
      return { items: (payload.items ?? []).map(toDomainInfo), total: Number(payload.total ?? 0) || 0 };
    },

    async setNameservers(domain, hosts) {
      const res = await request('PUT', `/v1/domains/${encodeURIComponent(domain)}/nameservers`, { provider: 'custom', hosts }, { kind: 'write' });
      const payload = await json<{ hosts?: unknown }>(res, 'write');
      return { hosts: Array.isArray(payload.hosts) ? payload.hosts.map((h) => text(h, 255).toLowerCase()) : hosts };
    },
  };
}
