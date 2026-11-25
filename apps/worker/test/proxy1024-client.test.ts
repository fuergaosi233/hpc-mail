import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PROXY1024_ALLOWED_PATHS, PROXY1024_FORBIDDEN_PATHS, Proxy1024Error, createProxy1024Client, parseResidentialPricing,
  parseStaticPricing, parseUnlimitedPricing, parseVendorTime,
} from '../src/services/proxy1024-client.js';
import { fake1024 } from './fixtures/proxy1024/fake-api.js';
import { RESIDENTIAL_HTML, STATIC_HTML, UNLIMITED_HTML } from './fixtures/proxy1024/pricing.js';

const client = (token = 'zero-sid-test', extra: { timeoutMs?: number; minIntervalMs?: number } = {}) =>
  createProxy1024Client({ token, lang: 'en', minIntervalMs: 0, ...extra });

async function kindOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (e) {
    return e instanceof Proxy1024Error ? e.kind : `other:${String(e)}`;
  }
}

afterEach(() => vi.unstubAllGlobals());

describe('1024proxy 客户端：传输', () => {
  it('POST 表单编码，body 带 token 与 lang，头 Accept-Protocol: https，redirect=manual', async () => {
    const fake = fake1024();
    const member = await client().getMember();
    expect(member).toMatchObject({ email: 'buyer@example.com', balanceCents: 10000, totalBalanceCents: 10000, mfaBound: false, multiLogin: true });
    const [call] = fake.calls;
    expect(call!.path).toBe('/get/v1/member');
    expect(call!.fields).toMatchObject({ token: 'zero-sid-test', lang: 'en' });
    expect(call!.headers.get('Accept-Protocol')).toBe('https');
    expect(call!.headers.get('Content-Type')).toContain('application/x-www-form-urlencoded');
    const init = fake.fetchMock.mock.calls[0]![1]!;
    expect(init.redirect).toBe('manual');
    expect(init.method).toBe('POST');
  });

  it('验证码与登录不带会话 token；code 30 → captcha_image_required；其他非 0 → rejected', async () => {
    const fake = fake1024();
    const c = client('should-not-be-sent');
    const captcha = await c.getSlideCaptcha();
    expect(captcha).toMatchObject({ captchaId: 'cap-1', masterImage: 'data:image/png;base64,AAAA', tileImage: 'data:image/png;base64,BBBB', initialY: 42 });
    const login = await c.signin({ email: 'buyer@example.com', password: 'pw-12345678', captchaId: 'cap-1', x: 120, y: 42 });
    expect(login).toEqual({ token: 'zero-sid-test', tokenCacheDays: 30 });
    const signinCall = fake.callsTo('/add/v1/signin')[0]!;
    expect(signinCall.fields).toMatchObject({ email: 'buyer@example.com', pwd: 'pw-12345678', idkey: 'cap-1', x: '120', y: '42', token: '' });
    expect(fake.calls.every((call) => call.fields.token !== 'should-not-be-sent')).toBe(true);

    fake.state.signinCode = 30;
    expect(await kindOf(c.signin({ email: 'a@b.c', password: 'x', captchaId: 'c', x: 1, y: 1 }))).toBe('captcha_image_required');
    fake.state.signinCode = 7;
    expect(await kindOf(c.signin({ email: 'a@b.c', password: 'x', captchaId: 'c', x: 1, y: 1 }))).toBe('rejected');
  });

  it('code 300 → session_invalid', async () => {
    fake1024();
    const error = await client('stale-token').getMember().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Proxy1024Error);
    expect((error as Proxy1024Error).kind).toBe('session_invalid');
    expect((error as Proxy1024Error).code).toBe(300);
  });

  it('下单：5xx / 非 JSON / 超时 / 缺结账链接 → unknown；明确拒绝 → rejected；只读调用 5xx → transient', async () => {
    const fake = fake1024();
    const order = { product: 'unlimited_port' as const, sku: '2-15ports30d', quantity: 2, orderSpec: '' };
    for (const mode of ['http500', 'non_json', 'no_url'] as const) {
      fake.state.orderMode = mode;
      expect(await kindOf(client().createOrder(order)), mode).toBe('unknown');
    }
    fake.state.orderMode = 'timeout';
    expect(await kindOf(client('zero-sid-test', { timeoutMs: 30 }).createOrder(order))).toBe('unknown');
    fake.state.orderMode = 'reject';
    const rejected = await client().createOrder(order).then(() => null, (e: unknown) => e as Proxy1024Error);
    expect(rejected?.kind).toBe('rejected');
    expect(rejected?.vendorMessage).toBe('库存不足');
    fake.state.orderMode = 'session';
    expect(await kindOf(client().createOrder(order))).toBe('session_invalid');

    fake.fetchMock.mockImplementationOnce(async () => new Response('nope', { status: 503 }));
    expect(await kindOf(client().getMember())).toBe('transient');
    fake.fetchMock.mockImplementationOnce(async () => { throw new TypeError('network down'); });
    expect(await kindOf(client().getMember())).toBe('transient');
    fake.fetchMock.mockImplementationOnce(async () => new Response(null, { status: 302, headers: { Location: 'https://1024proxy.com/sign-in/' } }));
    expect(await kindOf(client().getMember())).toBe('transient');
  });

  it('下单字段：静态 ISP 传 data 串，无限端口传 sn/cate/num，住宅流量传 sn/num；成功返回结账链接与订单号', async () => {
    const fake = fake1024();
    const c = client();
    const created = await c.createOrder({ product: 'static_isp', sku: '', quantity: 7, orderSpec: 'KR-30-2,US-30-5' });
    expect(created.checkoutUrl).toMatch(/^https:\/\//);
    expect(created.orderNo).toBe('ORD1001');
    await c.createOrder({ product: 'unlimited_port', sku: '2-15ports30d', quantity: 3, orderSpec: '' });
    await c.createOrder({ product: 'unlimited_bandwidth', sku: '30D100mRand', quantity: 1, orderSpec: '' });
    await c.createOrder({ product: 'residential_flow', sku: 'flowmax100', quantity: 5, orderSpec: '' });
    expect(fake.orderCalls().map((call) => [call.path, call.fields])).toEqual([
      ['/add/v2/1024/orderStatic', expect.objectContaining({ data: 'KR-30-2,US-30-5', coupon_code: '' })],
      ['/add/v1/1024/orderUnlimit', expect.objectContaining({ sn: '2-15ports30d', cate: 'ports', num: '3' })],
      ['/add/v1/1024/orderUnlimit', expect.objectContaining({ sn: '30D100mRand', cate: 'bandwidth', num: '1' })],
      ['/add/v1/1024/orderFlow', expect.objectContaining({ sn: 'flowmax100', num: '5' })],
    ]);
    fake.state.orderNoInResponse = false;
    expect((await c.createOrder({ product: 'residential_flow', sku: 'flowmax100', quantity: 2, orderSpec: '' })).orderNo).toBeNull();
    // 响应回显的 sn 是 SKU 编码，不能当订单号
    fake.fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ code: 0, msg: 'success', data: { url: 'https://api.1024proxy.com/pay/checkout?s=abc', sn: 'flowmax100' } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    expect((await c.createOrder({ product: 'residential_flow', sku: 'flowmax100', quantity: 2, orderSpec: '' })).orderNo).toBeNull();
    fake.fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ code: 0, msg: 'success', data: { url: 'https://api.1024proxy.com/pay/checkout?s=abc', sn: 'flowmax100', out_trade_no: 'T-77' } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    expect((await c.createOrder({ product: 'residential_flow', sku: 'flowmax100', quantity: 2, orderSpec: '' })).orderNo).toBe('T-77');
  });

  it('余额支付未实现：恒抛 unsupported，且不发任何请求', async () => {
    const fake = fake1024();
    expect(await kindOf(client().payOrderWithBalance('https://api.1024proxy.com/pay/x'))).toBe('unsupported');
    expect(fake.calls).toHaveLength(0);
  });

  it('白名单不含任何禁用路径；所有请求都落在白名单内', async () => {
    for (const forbidden of PROXY1024_FORBIDDEN_PATHS) {
      expect((PROXY1024_ALLOWED_PATHS as readonly string[]).some((p) => p === forbidden || p.startsWith(forbidden))).toBe(false);
    }
    const fake = fake1024();
    const c = client();
    await c.getMember();
    await c.validateSession();
    await c.getPurchaseRecords({ page: 1, limit: 10 });
    await c.listPortServers({ page: 1, pageSize: 10 });
    await c.listBandwidthServers({ page: 1, pageSize: 10 });
    await c.listStaticIps({ page: 1, size: 10 });
    await c.listStaticInventory({ code: 'KR' });
    await c.listSubUsers();
    await c.getSubUserPassword('mailsub');
    await c.listTrafficGateways();
    expect(fake.calls.every((call) => (PROXY1024_ALLOWED_PATHS as readonly string[]).includes(call.path))).toBe(true);
  });

  it('同一客户端两次调用间隔不少于 minIntervalMs', async () => {
    fake1024();
    const c = client('zero-sid-test', { minIntervalMs: 60 });
    const start = Date.now();
    await c.getMember();
    await c.getMember();
    expect(Date.now() - start).toBeGreaterThanOrEqual(55);
  });
});

describe('1024proxy 客户端：响应映射', () => {
  it('购买记录：pay_status 1=paid 2=refunded 其余 pending，金额转美分', async () => {
    const fake = fake1024();
    fake.state.records = [
      { order_no: 'A1', name: 'Static ISP', true_money: '12.30', pay_time: '2026-11-25 10:00:00', pay_status: 1 },
      { order_no: 'A2', name: 'Ports', true_money: '5', pay_time: '', pay_status: 2 },
      { order_no: 'A3', name: 'Flow', true_money: '0.005', pay_time: '', pay_status: 0 },
    ];
    const { items, total } = await client().getPurchaseRecords({ page: 1, limit: 10 });
    expect(total).toBe(3);
    expect(items).toEqual([
      { orderNo: 'A1', name: 'Static ISP', trueCents: 1230, payStatus: 'paid', payTime: '2026-11-25 10:00:00' },
      { orderNo: 'A2', name: 'Ports', trueCents: 500, payStatus: 'refunded', payTime: null },
      { orderNo: 'A3', name: 'Flow', trueCents: 1, payStatus: 'pending', payTime: null },
    ]);
  });

  it('子账号密码只在 getSubUserPassword 返回；不存在 → rejected', async () => {
    fake1024();
    const c = client();
    expect(await c.listSubUsers()).toEqual([{ username: 'mailsub', title: 'mail', trafficBytes: 1_000_000 }]);
    expect(await c.getSubUserPassword('mailsub')).toBe('sub-pass');
    expect(await kindOf(c.getSubUserPassword('ghost'))).toBe('rejected');
  });

  it('供应商时间：秒/毫秒/无时区日期（按 UTC+8）', () => {
    expect(parseVendorTime(1_800_000_000)).toBe(1_800_000_000_000);
    expect(parseVendorTime('1800000000000')).toBe(1_800_000_000_000);
    expect(parseVendorTime('2027-01-01 00:00:00')).toBe(Date.parse('2026-12-31T16:00:00Z'));
    expect(parseVendorTime('')).toBeNull();
    expect(parseVendorTime(0)).toBeNull();
    expect(parseVendorTime('garbage')).toBeNull();
  });
});

describe('1024proxy 定价页解析', () => {
  it('住宅流量：计算器套餐按 GB 单价与上下限，固定套餐数量为 1', () => {
    expect(parseResidentialPricing(RESIDENTIAL_HTML)).toEqual([
      expect.objectContaining({ product: 'residential_flow', sku: 'flowmax100', label: '2-100GB', unitPriceCents: 120, minQuantity: 2, maxQuantity: 100 }),
      expect.objectContaining({ product: 'residential_flow', sku: 'flowmax200', label: '200GB', unitPriceCents: 14000, minQuantity: 1, maxQuantity: 1 }),
      expect.objectContaining({ product: 'residential_flow', sku: 'flowmax1tb', label: '1 TB', unitPriceCents: 49000, minQuantity: 1, maxQuantity: 1 }),
    ]);
  });

  it('无限端口按档位上下限与每端口单价；无限带宽取 data-money 总价（跨行属性）', () => {
    const items = parseUnlimitedPricing(UNLIMITED_HTML);
    const ports = items.filter((i) => i.product === 'unlimited_port');
    expect(ports.map((i) => [i.sku, i.unitPriceCents, i.minQuantity, i.maxQuantity, i.days])).toEqual([
      ['2-15ports3d', 250, 2, 15, 3], ['2-15ports7d', 450, 2, 15, 7], ['2-15ports30d', 1550, 2, 15, 30], ['16-40ports30d', 1356, 16, 40, 30],
    ]);
    const bandwidth = items.filter((i) => i.product === 'unlimited_bandwidth');
    expect(bandwidth.map((i) => [i.sku, i.unitPriceCents, i.days, i.label])).toEqual([
      ['30D100mRand', 103500, 30, '100 Mbps · 30 天'], ['3H100mRand', 2160, null, '100 Mbps · 3 小时'], ['7D200MRand', 39879, 7, '200 Mbps · 7 天'],
    ]);
  });

  it('静态 ISP：按时长分组，上限基准取 max(售价, 原价)', () => {
    const items = parseStaticPricing(STATIC_HTML);
    expect(items.map((i) => [i.country, i.days, i.unitPriceCents, i.capUnitCents])).toEqual([
      ['KR', 7, 150, 180], ['KR', 30, 300, 340], ['US', 30, 250, 250], ['MY2', 30, 350, 390], ['US', 90, 650, 700],
    ]);
  });

  it('fetchCatalogue 只 GET 三个公开页、不带凭据；页面失败 → transient', async () => {
    const fake = fake1024();
    const items = await client().fetchCatalogue();
    expect(items.length).toBeGreaterThan(10);
    expect(fake.pageHits.sort()).toEqual(['/pricing/residential/', '/pricing/static/', '/pricing/unlimited/']);
    expect(fake.calls).toHaveLength(0);
    for (const [, init] of fake.fetchMock.mock.calls) expect(String(init?.body ?? '')).not.toContain('zero-sid');
    fake.state.pricingDown = true;
    expect(await kindOf(client().fetchCatalogue())).toBe('transient');
  });
});
