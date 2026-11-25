import { describe, expect, it, vi } from 'vitest';
import { SPACESHIP_API, SpaceshipError, createSpaceshipClient } from '../src/services/spaceship-client.js';

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

/** 只接受 spaceship.dev/api 的请求；其他 URL 直接抛错 */
function client(handler: Handler) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (!url.href.startsWith(`${SPACESHIP_API}/`)) throw new Error(`unexpected fetch ${url.href}`);
    return handler(url, init ?? {});
  });
  return { api: createSpaceshipClient({ apiKey: 'k-123', apiSecret: 's-456' }, { fetch: fetchMock as unknown as typeof fetch }), fetchMock };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const problem = (status: number, code: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  json(body, status, { 'spaceship-error-code': code, 'spaceship-operation-id': 'op0000000000abcd', ...headers });

async function caught(promise: Promise<unknown>): Promise<SpaceshipError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SpaceshipError);
    return error as SpaceshipError;
  }
  throw new Error('expected SpaceshipError');
}

describe('spaceship client', () => {
  it('发送凭据头、manual 重定向，可用性按 ≤ 20 分组并按名称匹配', async () => {
    const seen: string[][] = [];
    const { api, fetchMock } = client((url, init) => {
      const headers = new Headers(init.headers);
      expect(headers.get('X-API-Key')).toBe('k-123');
      expect(headers.get('X-API-Secret')).toBe('s-456');
      expect(headers.get('Content-Type')).toBe('application/json');
      expect(init.redirect).toBe('manual');
      expect(init.method).toBe('POST');
      expect(url.pathname).toBe('/api/v1/domains/available');
      const domains = JSON.parse(String(init.body)).domains as string[];
      seen.push(domains);
      // 倒序返回，且漏掉一个
      return json({ domains: [...domains].reverse().filter((d) => d !== 'n3.com').map((domain) => ({ domain: domain.toUpperCase(), result: domain === 'n1.com' ? 'taken' : 'available' })) });
    });
    const names = Array.from({ length: 25 }, (_, i) => `n${i}.com`);
    const result = await api.checkAvailability(names);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(seen.map((group) => group.length)).toEqual([20, 5]);
    expect(result.map((r) => r.domain)).toEqual(names);
    expect(result.find((r) => r.domain === 'n1.com')!.result).toBe('taken');
    expect(result.find((r) => r.domain === 'n3.com')!.result).toBe('unexpectedError');
    expect(result.find((r) => r.domain === 'n0.com')!.result).toBe('available');
  });

  it('价格：取对应年限的 register 价，跳过 errorCode / 非 USD / 无对应年限', async () => {
    const { api } = client((_url, init) => {
      expect(JSON.parse(String(init.body))).toEqual({ domains: ['a.com', 'b.io', 'c.net', 'd.org', 'e.dev'] });
      const pair = (final: string, regular: string, currency = 'USD') => ({ finalPrice: { amount: final, currency }, regularPrice: { amount: regular, currency } });
      return json({ domains: [
        { domain: 'a.com', priceClass: 'standard', prices: { register: [
          { period: { value: 1, unit: 'y' }, priceInDefaultCurrency: pair('5.98', '10.98') },
          { period: { value: 2, unit: 'y' }, priceInDefaultCurrency: pair('16.981', '21.96') },
        ], renew: [] } },
        { domain: 'b.io', priceClass: 'premium', prices: { register: [{ period: { value: 2, unit: 'y' }, priceInDefaultCurrency: pair('999.99', '999.99') }] } },
        { domain: 'c.net', errorCode: 'tldNotSupported' },
        { domain: 'd.org', priceClass: 'standard', prices: { register: [{ period: { value: 2, unit: 'y' }, priceInDefaultCurrency: pair('1', '2', 'EUR') }] } },
        { domain: 'e.dev', priceClass: 'standard', prices: { register: [{ period: { value: 1, unit: 'y' }, priceInDefaultCurrency: pair('1', '2') }] } },
      ] });
    });
    const prices = await api.queryPricing(['a.com', 'b.io', 'c.net', 'd.org', 'e.dev'], 2);
    expect(prices).toEqual([
      { domain: 'a.com', priceClass: 'standard', years: 2, finalCents: 1699, regularCents: 2196 },
      { domain: 'b.io', priceClass: 'premium', years: 2, finalCents: 99999, regularCents: 99999 },
    ]);
  });

  it('注册：请求体完整，202 + 操作号成功；缺操作号、5xx、超时都是 unknown', async () => {
    let mode: 'ok' | 'noheader' | '5xx' | 'timeout' | '200' = 'ok';
    const { api } = client((url, init) => {
      expect(url.pathname).toBe('/api/v1/domains/example.com');
      expect(JSON.parse(String(init.body))).toEqual({
        autoRenew: false, years: 1, privacyProtection: { level: 'high', userConsent: true },
        contacts: { registrant: 'C1', admin: 'C1', tech: 'C1', billing: 'C1' },
      });
      if (mode === 'timeout') throw new DOMException('timed out', 'TimeoutError');
      if (mode === '5xx') return problem(500, 'infrastructure.outcomeUnknown', { detail: 'boom' });
      if (mode === 'noheader') return new Response(null, { status: 202 });
      if (mode === '200') return json({}, 200, { 'spaceship-async-operationid': 'abc' });
      return new Response(null, { status: 202, headers: { 'spaceship-async-operationid': 'OpId123' } });
    });
    const body = { years: 1, autoRenew: false, privacyLevel: 'high' as const, registrantContactId: 'C1' };
    expect(await api.registerDomain('example.com', body)).toEqual({ operationId: 'OpId123' });
    for (const next of ['noheader', '5xx', 'timeout', '200'] as const) {
      mode = next;
      const error = await caught(api.registerDomain('example.com', body));
      expect(error.outcome, next).toBe('unknown');
    }
  });

  it('错误分类：422 rejected 带字段、401 rejected、429 带 Retry-After、读请求 5xx/超时为 transient、404 getDomain → null', async () => {
    let next: () => Response = () => json({});
    const { api } = client(() => next());
    next = () => problem(422, 'application.validation', { detail: 'invalid', data: [{ field: 'name', details: 'bad chars' }] });
    let error = await caught(api.checkAvailability(['x.com']));
    expect(error).toMatchObject({ status: 422, outcome: 'rejected', code: 'application.validation', operationId: 'op0000000000abcd', detail: 'invalid' });
    expect(error.fields).toEqual([{ field: 'name', details: 'bad chars' }]);
    expect(error.message).not.toContain('k-123');
    expect(error.message).not.toContain('s-456');

    next = () => problem(401, 'application.unauthorized', { detail: 'nope' });
    expect((await caught(api.listDomains({ take: 1, skip: 0 }))).outcome).toBe('rejected');

    next = () => problem(429, 'application.rateLimited', { detail: 'slow' }, { 'Retry-After': '7' });
    error = await caught(api.queryPricing(['x.com'], 1));
    expect(error).toMatchObject({ outcome: 'rate_limited', retryAfterSec: 7 });

    next = () => problem(503, 'infrastructure.unavailable', { detail: 'down' });
    expect((await caught(api.getAsyncOperation('op1'))).outcome).toBe('transient');

    next = () => { throw new DOMException('timed out', 'TimeoutError'); };
    expect((await caught(api.getDomain('x.com'))).outcome).toBe('transient');

    next = () => new Response('<html>', { status: 302, headers: { Location: 'https://elsewhere.example' } });
    expect((await caught(api.getDomain('x.com'))).outcome).toBe('transient');

    next = () => problem(404, 'application.notFound', { detail: 'missing' });
    expect(await api.getDomain('x.com')).toBeNull();
    expect((await caught(api.getAsyncOperation('missing'))).outcome).toBe('not_found');
  });

  it('域名信息、异步操作、改 NS、联系人', async () => {
    const { api, fetchMock } = client((url, init) => {
      const path = url.pathname.replace('/api', '');
      if (path === '/v1/domains/ex.com' && init.method === 'GET') {
        return json({ name: 'ex.com', lifecycleStatus: 'registered', verificationStatus: null, suspensions: [{ reasonCode: 'raaVerification' }], nameservers: { provider: 'basic', hosts: ['LAUNCH1.spaceship.net', 'launch2.spaceship.net'] } });
      }
      if (path === '/v1/async-operations/op%2F1' || path === '/v1/async-operations/op/1') throw new Error('id must be encoded once');
      if (path.startsWith('/v1/async-operations/')) return json({ status: 'failed', type: 'domains_Create', details: { reason: 'x' }, createdAt: '2026-11-25T00:00:00Z' });
      if (path === '/v1/domains/ex.com/nameservers') {
        expect(init.method).toBe('PUT');
        expect(JSON.parse(String(init.body))).toEqual({ provider: 'custom', hosts: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'] });
        return json({ provider: 'custom', hosts: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'] });
      }
      if (path === '/v1/contacts') {
        expect(init.method).toBe('PUT');
        const body = JSON.parse(String(init.body));
        expect(body).not.toHaveProperty('organization');
        return json({ contactId: '1ZdMXpapqp9sle5dl8BlppTJXAzf3' });
      }
      if (path === '/v1/domains') {
        expect(url.searchParams.get('take')).toBe('1');
        return json({ items: [], total: 3 });
      }
      throw new Error(`unhandled ${path}`);
    });
    expect(await api.getDomain('ex.com')).toEqual({
      name: 'ex.com', lifecycleStatus: 'registered', verificationStatus: null, suspensions: ['raaVerification'],
      nameservers: { provider: 'basic', hosts: ['launch1.spaceship.net', 'launch2.spaceship.net'] },
    });
    expect(await api.getAsyncOperation('opABC')).toMatchObject({ status: 'failed', details: { reason: 'x' } });
    expect(await api.setNameservers('ex.com', ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'])).toEqual({ hosts: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'] });
    expect(await api.saveContact({ firstName: 'A', lastName: 'B', email: 'a@b.co', address1: 'x', city: 'y', country: 'US', phone: '+1.4155550100', organization: '' })).toEqual({ contactId: '1ZdMXpapqp9sle5dl8BlppTJXAzf3' });
    expect(await api.listDomains({ take: 1, skip: 0 })).toEqual({ items: [], total: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});
