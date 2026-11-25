import { vi } from 'vitest';

/**
 * 有状态的假 Spaceship + 假 Cloudflare（只实现域名采购用到的接口）。
 * 其余任何 URL 一律抛错：漏写的 mock 会让测试失败，绝不会打到真实供应商。
 */
export const CF_ACCOUNT = 'acct-domain-purchase';
export const CF_NS = ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'];
export const CONTACT_ID = 'ContactIdForTests0000000000A';

export type RegisterMode = 'ok' | '5xx' | 'timeout' | '422' | '429' | 'noheader';

interface FakeZone {
  id: string;
  name: string;
  status: 'pending' | 'active' | 'moved';
  createdOn: number;
  routing: { enabled: boolean; status: string };
  catchAll: { enabled: boolean; actions: { type: string; value: string[] }[] } | null;
}

export interface Price { final: string; regular: string; priceClass?: string }

export function fakeVendors(opts: { clock: () => number }) {
  const ss = {
    /** 不在表里的域名视为 available */
    availability: new Map<string, string>(),
    /** 不在表里的域名默认 standard 9.98 / 12.98 */
    prices: new Map<string, Price>(),
    registerMode: new Map<string, RegisterMode>(),
    /** 账户里的域名（GET /v1/domains/{d} 200） */
    owned: new Map<string, { lifecycleStatus: string; verificationStatus: string | null; suspensions: string[]; nameservers: string[] }>(),
    ops: new Map<string, { status: 'pending' | 'success' | 'failed'; domain: string; details?: unknown }>(),
    /** 注册成功后操作直接 success 并进账户 */
    autoSucceed: false,
    registerCalls: [] as string[],
    nameserverCalls: [] as { domain: string; hosts: string[] }[],
    availabilityCalls: [] as string[][],
    pricingCalls: [] as string[][],
    calls: [] as string[],
  };
  const zones = new Map<string, FakeZone>();
  const cfCalls: string[] = [];
  let seq = 0;

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  const problem = (status: number, code: string, detail: string, extra: Record<string, string> = {}) =>
    json({ detail }, status, { 'spaceship-error-code': code, 'spaceship-operation-id': 'abcdefgh12345678', ...extra });
  const cfOk = (result: unknown, extra: Record<string, unknown> = {}) => json({ success: true, errors: [], result, ...extra });
  const cfFail = (status: number, code: number, message: string) => json({ success: false, errors: [{ code, message }], result: null }, status);
  const zoneView = (zone: FakeZone) => ({
    id: zone.id, name: zone.name, status: zone.status, name_servers: CF_NS, created_on: new Date(zone.createdOn).toISOString(),
  });

  function priceItem(domain: string) {
    const price = ss.prices.get(domain) ?? { final: '9.98', regular: '12.98' };
    return {
      domain, priceClass: price.priceClass ?? 'standard',
      prices: { register: [
        { period: { value: 1, unit: 'y' }, priceInDefaultCurrency: { finalPrice: { amount: price.final, currency: 'USD' }, regularPrice: { amount: price.regular, currency: 'USD' } } },
      ] },
    };
  }

  function spaceship(url: URL, method: string, init: RequestInit | undefined): Response {
    const headers = new Headers(init?.headers);
    if (headers.get('X-API-Key') !== 'test-key' || headers.get('X-API-Secret') !== 'test-secret') return problem(401, 'application.unauthorized', 'bad credentials');
    const path = url.pathname.replace(/^\/api/, '');
    ss.calls.push(`${method} ${path}`);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (path === '/v1/domains/available' && method === 'POST') {
      const domains = body.domains as string[];
      ss.availabilityCalls.push(domains);
      if (domains.length > 20) return problem(422, 'application.validation', 'too many');
      // 故意倒序返回，验证按名称匹配
      return json({ domains: [...domains].reverse().map((domain) => ({ domain, result: ss.availability.get(domain) ?? 'available', premiumPricing: [] })) });
    }
    if (path === '/v1/domains/pricing/query' && method === 'POST') {
      const domains = body.domains as string[];
      ss.pricingCalls.push(domains);
      return json({ domains: domains.map(priceItem) });
    }
    if (path === '/v1/domains' && method === 'GET') {
      return json({ items: [...ss.owned.keys()].map((name) => ({ name, lifecycleStatus: 'registered' })), total: ss.owned.size });
    }
    const asyncOp = path.match(/^\/v1\/async-operations\/([^/]+)$/);
    if (asyncOp && method === 'GET') {
      const op = ss.ops.get(decodeURIComponent(asyncOp[1]!));
      if (!op) return problem(404, 'application.notFound', 'no such op');
      return json({ status: op.status, type: 'domains_Create', details: op.details ?? {}, createdAt: '2026-11-25T00:00:00.000Z' });
    }
    const ns = path.match(/^\/v1\/domains\/([^/]+)\/nameservers$/);
    if (ns && method === 'PUT') {
      const domain = decodeURIComponent(ns[1]!);
      const owned = ss.owned.get(domain);
      if (!owned) return problem(404, 'application.notFound', 'domain not found');
      ss.nameserverCalls.push({ domain, hosts: body.hosts as string[] });
      owned.nameservers = body.hosts as string[];
      return json({ provider: 'custom', hosts: body.hosts });
    }
    const one = path.match(/^\/v1\/domains\/([^/]+)$/);
    if (one && method === 'GET') {
      const domain = decodeURIComponent(one[1]!);
      const owned = ss.owned.get(domain);
      if (!owned) return problem(404, 'application.notFound', 'not found');
      return json({
        name: domain, unicodeName: domain, isPremium: false, autoRenew: false, lifecycleStatus: owned.lifecycleStatus,
        verificationStatus: owned.verificationStatus, eppStatuses: [], suspensions: owned.suspensions.map((reasonCode) => ({ reasonCode })),
        privacyProtection: { contactForm: true, level: 'high' }, nameservers: { provider: 'custom', hosts: owned.nameservers },
        contacts: { registrant: CONTACT_ID },
      });
    }
    if (one && method === 'POST') {
      const domain = decodeURIComponent(one[1]!);
      ss.registerCalls.push(domain);
      const mode = ss.registerMode.get(domain) ?? 'ok';
      if (mode === 'timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      if (mode === '5xx') return problem(500, 'infrastructure.outcomeUnknown', 'outcome unknown');
      if (mode === '422') return problem(422, 'business.domainNotAvailable', 'not available');
      if (mode === '429') return problem(429, 'application.rateLimited', 'slow down', { 'Retry-After': '30' });
      if (mode === 'noheader') return new Response(null, { status: 202 });
      const contacts = body.contacts as Record<string, string>;
      if (contacts.registrant !== CONTACT_ID) return problem(422, 'application.validation', 'bad contact');
      const opId = `op${++seq}x${domain.replace(/[^a-z0-9]/g, '')}`.slice(0, 36);
      ss.ops.set(opId, { status: ss.autoSucceed ? 'success' : 'pending', domain });
      if (ss.autoSucceed) ss.owned.set(domain, { lifecycleStatus: 'registered', verificationStatus: 'verification', suspensions: [], nameservers: ['launch1.spaceship.net', 'launch2.spaceship.net'] });
      return new Response(null, { status: 202, headers: { 'spaceship-async-operationid': opId } });
    }
    return problem(400, 'application.unexpected', `unexpected ${method} ${path}`);
  }

  function cloudflare(url: URL, method: string, init: RequestInit | undefined): Response {
    if (new Headers(init?.headers).get('Authorization') !== 'Bearer test-token') return cfFail(403, 9109, 'bad token');
    const path = url.pathname.replace('/client/v4', '');
    cfCalls.push(`${method} ${path}`);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (path === '/zones' && method === 'GET') {
      const name = url.searchParams.get('name');
      const status = url.searchParams.get('status');
      const list = [...zones.values()].filter((zone) => (!name || zone.name === name) && (!status || zone.status === status));
      return cfOk(list.map(zoneView), { result_info: { total_count: list.length } });
    }
    if (path === '/zones' && method === 'POST') {
      const name = String(body.name);
      if ([...zones.values()].some((zone) => zone.name === name)) return cfFail(400, 1061, 'already exists');
      const zone: FakeZone = { id: `zone-${++seq}`, name, status: 'pending', createdOn: opts.clock(), routing: { enabled: false, status: 'unconfigured' }, catchAll: null };
      zones.set(zone.id, zone);
      return cfOk(zoneView(zone));
    }
    const match = path.match(/^\/zones\/([^/]+)(\/.*)?$/);
    const zone = match ? zones.get(match[1]!) : undefined;
    if (!zone) return cfFail(403, 9109, 'Invalid zone identifier');
    const rest = match![2] ?? '';
    if (rest === '' && method === 'GET') return cfOk(zoneView(zone));
    if (rest === '/activation_check') return cfOk({ id: zone.id });
    if (rest === '/email/routing' && method === 'GET') return cfOk(zone.routing);
    if (rest === '/email/routing/dns' && method === 'POST') {
      if (zone.status !== 'active') return cfFail(400, 2009, 'Active zone required');
      zone.routing = { enabled: true, status: 'ready' };
      return cfOk(zone.routing);
    }
    if (rest === '/email/routing/rules/catch_all' && method === 'GET') return cfOk(zone.catchAll ?? { enabled: false, actions: [{ type: 'drop', value: [] }] });
    if (rest === '/email/routing/rules/catch_all' && method === 'PUT') {
      zone.catchAll = { enabled: Boolean(body.enabled), actions: body.actions as { type: string; value: string[] }[] };
      return cfOk(zone.catchAll);
    }
    return cfFail(400, 9999, `unexpected ${method} ${path}`);
  }

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.origin === 'https://spaceship.dev' && url.pathname.startsWith('/api/')) return spaceship(url, method, init);
    if (url.origin === 'https://api.cloudflare.com') return cloudflare(url, method, init);
    throw new Error(`unexpected fetch ${method} ${url.href}`);
  });
  vi.stubGlobal('fetch', fetchMock);

  return {
    ss, zones, cfCalls, fetchMock,
    zoneByName: (name: string) => [...zones.values()].find((zone) => zone.name === name),
    /** 预置一个账户里早已存在的 zone（不能接管） */
    addExistingZone(name: string, createdOn: number) {
      zones.set(`zone-old-${name}`, { id: `zone-old-${name}`, name, status: 'active', createdOn, routing: { enabled: false, status: 'unconfigured' }, catchAll: null });
    },
    /** 所有待处理操作置为 success 并进账户 */
    succeedAllOps() {
      for (const op of ss.ops.values()) {
        if (op.status !== 'pending') continue;
        op.status = 'success';
        ss.owned.set(op.domain, { lifecycleStatus: 'registered', verificationStatus: 'verification', suspensions: [], nameservers: [] });
      }
    },
    activateZones() {
      for (const zone of zones.values()) zone.status = 'active';
    },
  };
}
