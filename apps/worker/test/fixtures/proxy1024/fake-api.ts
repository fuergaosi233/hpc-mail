import { vi } from 'vitest';
import { RESIDENTIAL_HTML, STATIC_HTML, UNLIMITED_HTML } from './pricing.js';

/**
 * 有状态的假 1024proxy（api.1024proxy.com + 公开定价页）。按 P§ 的响应形状手写。
 * 任何未显式处理的 URL 都抛错，保证漏 mock 的请求不会打到真实网络。
 */
export type OrderMode = 'ok' | 'reject' | 'http500' | 'timeout' | 'session' | 'no_url' | 'non_json';

export interface FakeRecord { order_no: string; name: string; true_money: string; pay_time: string; pay_status: number }
export interface FakeServer { id: number; ip: string; domain: string; port: number; username: string; password: string; region: string; expired: string; is_demo?: number }
export interface FakeStaticIp { id: number; ip: string; port: number; username: string; password: string; code: string; city: string; region: string; expired: string }

export interface FakeCall { path: string; fields: Record<string, string>; headers: Headers }

export function fake1024(opts: { token?: string } = {}) {
  const token = opts.token ?? 'zero-sid-test';
  const state = {
    token,
    balance: '100.00',
    orderMode: 'ok' as OrderMode,
    orderCount: 0,
    orderNoInResponse: true,
    records: [] as FakeRecord[],
    portServers: [] as FakeServer[],
    bandwidthServers: [] as FakeServer[],
    staticIps: [] as FakeStaticIp[],
    staticInventory: { KR: ['501', '502', '503'], US: ['601'] } as Record<string, string[]>,
    subUsers: [{ username: 'mailsub', password: 'sub-pass', title: 'mail', traffic: 1_000_000 }],
    gateways: [{ hostname: 'us.1024proxy.io:3000', title: 'US' }],
    pricing: { residential: RESIDENTIAL_HTML, unlimited: UNLIMITED_HTML, static: STATIC_HTML },
    pricingDown: false,
    signinCode: 0,
    /** 下单前的钩子（模拟并发等） */
    beforeOrder: null as null | (() => Promise<void>),
  };
  const calls: FakeCall[] = [];
  const pageHits: string[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const okData = (data: unknown) => json({ code: 0, msg: 'success', data });

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.origin === 'https://1024proxy.com' && method === 'GET') {
      pageHits.push(url.pathname);
      if (state.pricingDown) return new Response('bad gateway', { status: 502 });
      const page = url.pathname === '/pricing/residential/' ? state.pricing.residential
        : url.pathname === '/pricing/unlimited/' ? state.pricing.unlimited
          : url.pathname === '/pricing/static/' ? state.pricing.static : null;
      if (page === null) throw new Error(`fake1024: unexpected page ${url.href}`);
      return new Response(page, { status: 200, headers: { 'Content-Type': 'text/html' } });
    }
    if (url.origin !== 'https://api.1024proxy.com' || method !== 'POST') throw new Error(`fake1024: unexpected ${method} ${url.href}`);
    const headers = new Headers(init?.headers);
    const fields = Object.fromEntries(new URLSearchParams(String(init?.body ?? '')));
    calls.push({ path: url.pathname, fields, headers });
    const authed = fields.token === state.token;
    switch (url.pathname) {
      case '/get/v1/captcha/drag':
        return okData({ id: 'cap-1', master_image: 'AAAA', tile_image: 'data:image/png;base64,BBBB', tile_width: 60, tile_height: 60, initial_x: 0, initial_y: 42 });
      case '/add/v1/signin':
        if (state.signinCode === 30) return json({ code: 30, msg: 'verify', data: null });
        if (state.signinCode !== 0) return json({ code: state.signinCode, msg: '验证码错误', data: null });
        return okData({ token: state.token, token_cache: 30, email: 'buyer@example.com' });
    }
    if (!authed) return json({ code: 300, msg: 'login expired', data: null });
    switch (url.pathname) {
      case '/add/v1/webauto':
      case '/get/v1/member':
        return okData({ email: 'buyer@example.com', balance: state.balance, total_balance: state.balance, mfa_bind: 'unbind', morelogin: 1 });
      case '/add/v2/1024/orderStatic':
      case '/add/v1/1024/orderUnlimit':
      case '/add/v1/1024/orderFlow': {
        if (state.beforeOrder) await state.beforeOrder();
        state.orderCount++;
        const orderNo = `ORD${1000 + state.orderCount}`;
        switch (state.orderMode) {
          case 'reject': return json({ code: 1, msg: '库存不足', data: null });
          case 'session': return json({ code: 300, msg: 'login expired', data: null });
          case 'http500': return new Response('upstream error', { status: 500 });
          case 'non_json': return new Response('<html>oops</html>', { status: 200 });
          case 'no_url': return okData({});
          case 'timeout':
            return new Promise<Response>((_, reject) => {
              const signal = init?.signal;
              signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
            });
          default:
            return okData(state.orderNoInResponse ? { url: `https://api.1024proxy.com/pay/checkout?order_no=${orderNo}&s=abc`, order_no: orderNo } : { url: 'https://api.1024proxy.com/pay/checkout?s=abc' });
        }
      }
      case '/get/v1/1024/get_recharge_record': {
        const list = fields.order_no ? state.records.filter((r) => r.order_no === fields.order_no) : state.records;
        return okData({ lists: list, total: list.length });
      }
      case '/get/v2/unlimit/portServers':
        return okData({ list: state.portServers.slice((Number(fields.page) - 1) * Number(fields.page_size), Number(fields.page) * Number(fields.page_size)), total: state.portServers.length });
      case '/get/v3/unlimit/bandwidthServers':
        return okData({ lists: state.bandwidthServers, total: state.bandwidthServers.length });
      case '/get/v1/1024/static_use_list':
        return okData({ lists: state.staticIps, total: state.staticIps.length });
      case '/get/v1/static/list':
        return okData((state.staticInventory[fields.code ?? ''] ?? []).map((id) => ({ id })));
      case '/add/v1/1024/static_use': {
        const ids = (fields.id ?? '').split(',').filter(Boolean);
        for (const id of ids) {
          state.staticIps.push({ id: Number(id), ip: `203.0.113.${Number(id) % 250}`, port: 8000, username: `st${id}`, password: `pw${id}`, code: fields.code!, city: 'Seoul', region: 'AS', expired: '2027-01-01 00:00:00' });
        }
        return okData(null);
      }
      case '/get/v1/1024/subUsers':
        return okData({ list: state.subUsers.map((u) => ({ id: 1, username: u.username, title: u.title, traffic: u.traffic })) });
      case '/get/v1/availableSubUsers':
        return okData(state.subUsers.map((u) => ({ username: u.username, password: u.password })));
      case '/get/v1/traffic/server':
        return okData(state.gateways);
      default:
        throw new Error(`fake1024: unexpected path ${url.pathname}`);
    }
  });
  vi.stubGlobal('fetch', fetchMock);
  const callsTo = (path: string) => calls.filter((c) => c.path === path);
  const orderCalls = () => calls.filter((c) => /^\/add\/v[12]\/1024\/order/.test(c.path));
  return { state, calls, callsTo, orderCalls, pageHits, fetchMock };
}
