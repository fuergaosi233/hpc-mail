import { env } from 'cloudflare:test';
import type { ProxyOrderView, Settings } from '@hpc-mail/shared';
import { desc, eq, like } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/db/client.js';
import { adminAuditLogs, proxies, proxyOrders } from '../src/db/schema.js';
import { isSealed } from '../src/lib/secret-box.js';
import {
  allocateStaticForOrder, cancelProxyOrder, completeProxy1024Login, confirmProxyOrder, generateStickyProxies, getProxy1024Catalogue,
  getProxyOrder, proxy1024Runtime, proxy1024Status, quoteProxyOrder, resetProxy1024CatalogueCache, resolveProxyOrder,
  runProxy1024Cron, startProxy1024Login, stickyUsername, syncProxy1024Inventory,
} from '../src/services/proxy-purchase.js';
import { getSettingsFresh, readVendorSecrets, updateSettings } from '../src/services/setting.js';
import { createProxy1024Client, type Proxy1024Client } from '../src/services/proxy1024-client.js';
import { fake1024 } from './fixtures/proxy1024/fake-api.js';
import { call, data, failure, makeUser, type TestActor } from './fixtures/proxy1024/harness.js';

const db = createDb(env);
const MIN = 60_000;

function settings(patch: Partial<Settings['proxy1024']> = {}): Settings['proxy1024'] {
  return {
    enabled: true, email: 'buyer@example.com', password: 'login-pw-123', sessionToken: 'zero-sid-test', lang: 'en',
    maxOrderCents: 10_000, maxDailyCents: 20_000, quoteTtlMinutes: 15, ...patch,
  };
}

async function configure(patch: Partial<Settings['proxy1024']> = {}) {
  await updateSettings(env, { proxy1024: settings(patch) });
}

let admin: TestActor;
beforeEach(async () => {
  proxy1024Runtime.minIntervalMs = 0;
  proxy1024Runtime.timeoutMs = 14_000;
  resetProxy1024CatalogueCache();
  await env.db.batch([
    env.db.prepare('DELETE FROM proxy_orders'),
    env.db.prepare('DELETE FROM integration_status'),
    env.db.prepare("DELETE FROM proxies WHERE provider = '1024proxy'"),
  ]);
  admin = await makeUser('p1024', 'admin');
});
afterEach(() => vi.unstubAllGlobals());

const portQuote = (quantity = 3, sku = '2-15ports30d') => quoteProxyOrder(env, admin, { product: 'unlimited_port', sku, quantity });
async function orderRow(id: number) {
  return (await db.select().from(proxyOrders).where(eq(proxyOrders.id, id)).get())!;
}
async function actions(id: number) {
  return (await db.select().from(adminAuditLogs).where(eq(adminAuditLogs.target, `proxy_order:${id}`)).orderBy(adminAuditLogs.id).all()).map((a) => a.action);
}

describe('1024 采购：开关与配置', () => {
  it('未启用 / 无会话 / 上限为 0 → not_configured（503），且不发任何请求', async () => {
    const fake = fake1024();
    for (const patch of [{ enabled: false }, { sessionToken: '' }, { maxOrderCents: 0 }, { maxDailyCents: 0 }]) {
      await configure(patch);
      await expect(portQuote()).rejects.toMatchObject({ code: 'not_configured' });
    }
    await configure({ enabled: false });
    await failure(await call('POST', '/api/admin/proxy-1024/quotes', admin.jwt, { product: 'unlimited_port', sku: '2-15ports30d', quantity: 3 }), 503, 'not_configured');
    await failure(await call('GET', '/api/admin/proxy-1024/catalogue', admin.jwt), 503, 'not_configured');
    expect(await runProxy1024Cron(env)).toBe(0);
    expect(fake.fetchMock).not.toHaveBeenCalled();
    const status = await proxy1024Status(env, { live: true });
    expect(status).toMatchObject({ enabled: false, purchasingAllowed: false });
    expect(fake.fetchMock).not.toHaveBeenCalled();
    const user = await makeUser('p1024-user');
    await failure(await call('GET', '/api/admin/proxy-1024/status', user.jwt), 403, 'forbidden');
  });

  it('状态：live 读取余额写入 integration_status；会话失效转 invalid 并审计一次', async () => {
    const fake = fake1024();
    await configure();
    const live = await data<{ session: string; balanceCents: number; purchasingAllowed: boolean; email: string }>(await call('GET', '/api/admin/proxy-1024/status?live=1', admin.jwt));
    expect(live).toMatchObject({ session: 'ok', balanceCents: 10_000, purchasingAllowed: true, email: 'buyer@example.com' });
    fake.state.token = 'rotated-elsewhere';
    expect(await proxy1024Status(env, { live: true })).toMatchObject({ session: 'invalid', purchasingAllowed: false, balanceCents: 10_000 });
    await proxy1024Status(env, { live: true });
    const invalidAudits = await db.select().from(adminAuditLogs).where(eq(adminAuditLogs.action, 'proxy_1024.session_invalid')).all();
    expect(invalidAudits.length).toBe(1);
    await db.delete(adminAuditLogs).where(eq(adminAuditLogs.action, 'proxy_1024.session_invalid'));
  });

  it('邮箱+密码登录：人工滑块 → signin → 新 token 加密保存；审计只有邮箱', async () => {
    const fake = fake1024({ token: 'fresh-session-token' });
    await configure({ sessionToken: '' });
    const captcha = await startProxy1024Login(env, admin);
    expect(captcha.captchaId).toBe('cap-1');
    const status = await completeProxy1024Login(env, admin, { captchaId: 'cap-1', x: 133, y: 42 }, '1.2.3.4');
    expect(status).toMatchObject({ configured: true, session: 'ok', balanceCents: 10_000 });
    const stored = (await getSettingsFresh(env)).proxy1024;
    expect(isSealed(stored.sessionToken)).toBe(true);
    expect((await readVendorSecrets(env, 'proxy1024')).sessionToken).toBe('fresh-session-token');
    expect(fake.callsTo('/add/v1/signin')[0]!.fields).toMatchObject({ email: 'buyer@example.com', pwd: 'login-pw-123', x: '133', y: '42' });
    const audit = (await db.select().from(adminAuditLogs).where(eq(adminAuditLogs.action, 'proxy_1024.login')).orderBy(desc(adminAuditLogs.id)).get())!;
    expect(audit.detail).toBe('buyer@example.com');
    expect(JSON.stringify(audit)).not.toMatch(/login-pw-123|fresh-session-token/);

    fake.state.signinCode = 30;
    await expect(completeProxy1024Login(env, admin, { captchaId: 'cap-1', x: 1, y: 1 })).rejects.toMatchObject({ code: 'upstream_failed', message: '请先在 1024proxy 官网登录一次后再试' });
    await configure({ password: '' });
    await expect(startProxy1024Login(env, admin)).rejects.toMatchObject({ code: 'not_configured' });
  });

  it('目录：解析公开定价页、10 分钟缓存、不暴露上限基准字段', async () => {
    const fake = fake1024();
    await configure();
    const catalogue = await getProxy1024Catalogue(env);
    expect(catalogue.source).toBe('pricing_pages');
    expect(catalogue.items.find((i) => i.product === 'static_isp' && i.country === 'KR' && i.days === 30)).toEqual({
      product: 'static_isp', sku: '', label: 'KR · 30 天 · AS', days: 30, country: 'KR', unitPriceCents: 300, minQuantity: 1, maxQuantity: 500,
    });
    await getProxy1024Catalogue(env);
    expect(fake.pageHits).toHaveLength(3);
  });
});

describe('1024 采购：报价', () => {
  it('无限端口按单价 × 数量；静态 ISP 按批量折扣估价、按原价计上限基准；记录报价时余额', async () => {
    fake1024();
    await configure();
    const port = await portQuote(3);
    expect(port).toMatchObject({ status: 'quoted', product: 'unlimited_port', sku: '2-15ports30d', quantity: 3, estimateCents: 4650, capBasisCents: 4650, balanceCentsAtQuote: 10_000, orderNo: null, checkoutUrl: null });
    expect(Date.parse(port.quoteExpiresAt) - Date.now()).toBeGreaterThan(14 * MIN);

    const stat = await quoteProxyOrder(env, admin, { product: 'static_isp', items: [{ country: 'KR', days: 30, count: 2 }, { country: 'US', days: 30, count: 5 }] });
    // (300×2 + 250×5) × 0.95 = 1757.5 → 1758；上限基准 340×2 + 250×5 = 1930
    expect(stat).toMatchObject({ orderSpec: 'KR-30-2,US-30-5', quantity: 7, estimateCents: 1758, capBasisCents: 1930 });
    expect(await actions(stat.id)).toEqual(['proxy_1024.quote']);
  });

  it('超单笔上限、未知 SKU、数量越界、未提供的国家 → validation_failed', async () => {
    fake1024();
    await configure({ maxOrderCents: 4000 });
    await expect(portQuote(3)).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(portQuote(1, 'nope')).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(portQuote(16)).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(quoteProxyOrder(env, admin, { product: 'static_isp', items: [{ country: 'ZZ', days: 30, count: 1 }] })).rejects.toMatchObject({ code: 'validation_failed' });
    expect(await db.select().from(proxyOrders).all()).toHaveLength(0);
  });
});

describe('1024 采购：确认（金额安全）', () => {
  it('成功：下单一次 → awaiting_payment，结账链接加密保存、管理员可见，标记需手动支付', async () => {
    const fake = fake1024();
    await configure();
    const quote = await portQuote(3);
    const confirmed = await data<ProxyOrderView>(await call('POST', `/api/admin/proxy-1024/orders/${quote.id}/confirm`, admin.jwt, { expectedCents: 4650 }));
    expect(confirmed).toMatchObject({ status: 'awaiting_payment', orderNo: 'ORD1001', confirmedBy: admin.id, warnings: expect.arrayContaining(['payment_manual', 'maybe_charged']) });
    expect(confirmed.checkoutUrl).toMatch(/^https:\/\/api\.1024proxy\.com\/pay\/checkout/);
    const row = await orderRow(quote.id);
    expect(isSealed(row.checkoutUrlEnc)).toBe(true);
    expect(row.leaseUntil).toBeNull();
    expect(fake.orderCalls()).toHaveLength(1);
    expect(await actions(quote.id)).toEqual(['proxy_1024.quote', 'proxy_1024.order_confirm', 'proxy_1024.order_created']);
    // 再次确认 → 409，不再下单
    await failure(await call('POST', `/api/admin/proxy-1024/orders/${quote.id}/confirm`, admin.jwt, { expectedCents: 4650 }), 409, 'conflict');
    expect(fake.orderCalls()).toHaveLength(1);
  });

  it('回显金额不一致 → 409；报价过期 → 409 且标 expired；都不下单', async () => {
    const fake = fake1024();
    await configure();
    const quote = await portQuote(3);
    await expect(confirmProxyOrder(env, admin, quote.id, { expectedCents: 4649 })).rejects.toMatchObject({ code: 'conflict' });
    await expect(confirmProxyOrder(env, admin, quote.id, { expectedCents: 4650 }, '', { now: () => Date.now() + 16 * MIN })).rejects.toMatchObject({ code: 'conflict', message: '报价已过期，请重新报价' });
    expect((await orderRow(quote.id)).status).toBe('expired');
    expect(fake.orderCalls()).toHaveLength(0);
  });

  it('确认时涨价 → 409 并按新价重新报价（仍为 quoted）；按新价确认才下单', async () => {
    const fake = fake1024();
    await configure();
    const quote = await portQuote(3);
    fake.state.pricing.unlimited = fake.state.pricing.unlimited.replace('data-sn="2-15ports30d" data-price="15.50"', 'data-sn="2-15ports30d" data-price="16.00"');
    await expect(confirmProxyOrder(env, admin, quote.id, { expectedCents: 4650 })).rejects.toMatchObject({ code: 'conflict' });
    const requoted = await getProxyOrder(env, quote.id);
    expect(requoted).toMatchObject({ status: 'quoted', estimateCents: 4800, capBasisCents: 4800 });
    expect(fake.orderCalls()).toHaveLength(0);
    await expect(confirmProxyOrder(env, admin, quote.id, { expectedCents: 4650 })).rejects.toMatchObject({ code: 'conflict' });
    expect((await confirmProxyOrder(env, admin, quote.id, { expectedCents: 4800 })).status).toBe('awaiting_payment');
    expect(fake.orderCalls()).toHaveLength(1);
  });

  it('余额不足 → 409；定价页或余额读不到 → 502；都不下单', async () => {
    const fake = fake1024();
    await configure();
    const quote = await portQuote(3);
    fake.state.balance = '46.49';
    await expect(confirmProxyOrder(env, admin, quote.id, { expectedCents: 4650 })).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('余额不足') });
    fake.state.balance = '100';
    fake.state.pricingDown = true;
    await expect(confirmProxyOrder(env, admin, quote.id, { expectedCents: 4650 })).rejects.toMatchObject({ code: 'upstream_failed' });
    expect(fake.orderCalls()).toHaveLength(0);
    expect((await orderRow(quote.id)).status).toBe('quoted');
  });

  it('24 小时上限跨订单累计：第二单在 CAS 处被拒，不下单', async () => {
    const fake = fake1024();
    await configure({ maxDailyCents: 6000 });
    const first = await portQuote(3);
    const second = await portQuote(2);
    expect((await confirmProxyOrder(env, admin, first.id, { expectedCents: 4650 })).status).toBe('awaiting_payment');
    await expect(confirmProxyOrder(env, admin, second.id, { expectedCents: 3100 })).rejects.toMatchObject({ code: 'validation_failed', message: expect.stringContaining('24 小时') });
    expect((await orderRow(second.id)).status).toBe('quoted');
    expect(fake.orderCalls()).toHaveLength(1);
    // 新报价也会被 24 小时额度挡下
    await expect(portQuote(2)).rejects.toMatchObject({ code: 'validation_failed' });
    expect((await proxy1024Status(env)).caps.spentLast24hCents).toBe(4650);
  });

  it('并发确认同一订单：只有一个进入 ordering，createOrder 只调用一次', async () => {
    const fake = fake1024();
    await configure();
    const quote = await portQuote(3);
    const results = await Promise.allSettled([
      confirmProxyOrder(env, admin, quote.id, { expectedCents: 4650 }),
      confirmProxyOrder(env, admin, quote.id, { expectedCents: 4650 }),
      confirmProxyOrder(env, admin, quote.id, { expectedCents: 4650 }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected')) expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'conflict' });
    expect(fake.orderCalls()).toHaveLength(1);
  });

  it('复核价格后、CAS 前报价被并发确认按新价改写 → 409，不按管理员没确认过的金额下单', async () => {
    const fake = fake1024();
    await configure();
    const quote = await portQuote(3);
    const real = createProxy1024Client({ token: 'zero-sid-test', lang: 'en', minIntervalMs: 0 });
    // 模拟另一请求在本请求复核价格之后把报价改写成更高的新价（仍为 quoted）
    const client = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'getMember') {
          return async () => {
            await env.db.prepare("UPDATE proxy_orders SET estimate_cents = 4800, cap_basis_cents = 4800 WHERE id = ? AND status = 'quoted'").bind(quote.id).run();
            return target.getMember();
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as Proxy1024Client;
    await expect(confirmProxyOrder(env, admin, quote.id, { expectedCents: 4650 }, '', { client })).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('价格已变化') });
    expect(await orderRow(quote.id)).toMatchObject({ status: 'quoted', estimateCents: 4800 });
    expect(fake.orderCalls()).toHaveLength(0);
    expect(await actions(quote.id)).not.toContain('proxy_1024.order_confirm');
  });

  it('并发确认两笔不同订单：24 小时上限在同一语句里判定，只放行一笔', async () => {
    const fake = fake1024();
    await configure({ maxDailyCents: 6000 });
    const a = await portQuote(3);
    const b = await portQuote(3);
    const results = await Promise.allSettled([
      confirmProxyOrder(env, admin, a.id, { expectedCents: 4650 }),
      confirmProxyOrder(env, admin, b.id, { expectedCents: 4650 }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(fake.orderCalls()).toHaveLength(1);
  });

  it('下单超时 / 5xx / 非 JSON → unknown（审计 order_unknown）；cron 多次运行也绝不重试下单', async () => {
    const fake = fake1024();
    await configure();
    proxy1024Runtime.timeoutMs = 50;
    const ids: number[] = [];
    for (const mode of ['timeout', 'http500', 'non_json'] as const) {
      fake.state.orderMode = mode;
      const quote = await portQuote(2);
      const view = await confirmProxyOrder(env, admin, quote.id, { expectedCents: 3100 });
      expect(view).toMatchObject({ status: 'unknown', orderNo: null, warnings: expect.arrayContaining(['maybe_charged']) });
      expect(await actions(quote.id)).toContain('proxy_1024.order_unknown');
      ids.push(quote.id);
    }
    expect(fake.orderCalls()).toHaveLength(3);
    fake.state.orderMode = 'ok';
    let now = Date.now();
    for (let i = 0; i < 3; i++) {
      now += 5 * MIN;
      await runProxy1024Cron(env, { now });
    }
    expect(fake.orderCalls()).toHaveLength(3);
    for (const id of ids) expect((await orderRow(id)).status).toBe('unknown');
    // unknown 计入 24 小时额度
    expect((await proxy1024Status(env)).caps.spentLast24hCents).toBe(9300);
    // 管理员也不能再次确认
    await expect(confirmProxyOrder(env, admin, ids[0]!, { expectedCents: 3100 })).rejects.toMatchObject({ code: 'conflict' });
    expect(fake.orderCalls()).toHaveLength(3);
  });

  it('明确拒绝 → failed（不计额度）；下单时会话失效 → failed 且集成状态 invalid', async () => {
    const fake = fake1024();
    await configure();
    fake.state.orderMode = 'reject';
    const rejected = await portQuote(2);
    expect(await confirmProxyOrder(env, admin, rejected.id, { expectedCents: 3100 })).toMatchObject({ status: 'failed', lastError: expect.stringContaining('库存不足') });
    expect((await proxy1024Status(env)).caps.spentLast24hCents).toBe(0);
    fake.state.orderMode = 'session';
    const session = await portQuote(2);
    expect((await confirmProxyOrder(env, admin, session.id, { expectedCents: 3100 })).status).toBe('failed');
    expect(await proxy1024Status(env)).toMatchObject({ session: 'invalid', purchasingAllowed: false });
    expect(fake.orderCalls()).toHaveLength(2);
  });

  it('在 CAS 与响应之间崩溃（ordering 租约过期）→ cron 标 unknown，不下单', async () => {
    const fake = fake1024();
    await configure();
    const quote = await portQuote(2);
    await db.update(proxyOrders).set({ status: 'ordering', confirmedAt: new Date(), leaseUntil: new Date(Date.now() - 1000) }).where(eq(proxyOrders.id, quote.id));
    await runProxy1024Cron(env);
    expect(await getProxyOrder(env, quote.id)).toMatchObject({ status: 'unknown', lastError: expect.stringContaining('进程中断') });
    expect(fake.orderCalls()).toHaveLength(0);
  });

  it('取消只对未确认报价有效', async () => {
    fake1024();
    await configure();
    const quote = await portQuote(2);
    expect((await cancelProxyOrder(env, admin, quote.id)).status).toBe('cancelled');
    await expect(cancelProxyOrder(env, admin, quote.id)).rejects.toMatchObject({ code: 'conflict' });
    await expect(confirmProxyOrder(env, admin, quote.id, { expectedCents: 3100 })).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('1024 采购：对账与交付', () => {
  async function awaiting(fake: ReturnType<typeof fake1024>, quantity = 3) {
    const quote = await portQuote(quantity);
    const view = await confirmProxyOrder(env, admin, quote.id, { expectedCents: 1550 * quantity });
    expect(view.status).toBe('awaiting_payment');
    return { id: quote.id, orderNo: view.orderNo!, fake };
  }

  it('已付款 → paid → 同步无限端口服务器入库（带 order_id）→ fulfilled；重复 cron 幂等', async () => {
    const fake = fake1024();
    await configure();
    const { id, orderNo } = await awaiting(fake);
    let now = Date.now() + 5 * MIN;
    await runProxy1024Cron(env, { now });
    expect((await orderRow(id)).status).toBe('awaiting_payment');

    fake.state.records.push({ order_no: orderNo, name: 'Unlimited ports', true_money: '46.50', pay_time: '2026-11-25 12:00:00', pay_status: 1 });
    fake.state.portServers = [
      { id: 11, ip: '198.51.100.11', domain: 'unlimit.1024proxy.io:20011', port: 20011, username: 'pu', password: 'pp1', region: 'US', expired: '2099-01-01 00:00:00' },
      { id: 12, ip: '198.51.100.12', domain: 'unlimit.1024proxy.io:20012', port: 20012, username: 'pu', password: 'pp2', region: 'US', expired: '2099-01-01 00:00:00' },
      { id: 13, ip: '198.51.100.13', domain: '', port: 20013, username: 'demo', password: 'd', region: 'US', expired: '', is_demo: 1 },
    ];
    now += 5 * MIN;
    await runProxy1024Cron(env, { now });
    const done = await getProxyOrder(env, id);
    expect(done).toMatchObject({ status: 'fulfilled', actualCents: 4650, materializedCount: 2 });
    expect(done.paidAt).toBe(new Date(Date.parse('2026-11-25T04:00:00Z')).toISOString());
    const synced = await db.select().from(proxies).where(eq(proxies.orderId, id)).all();
    expect(synced.map((p) => [p.providerRef, p.host, p.port, p.product, p.source]).sort()).toEqual([
      ['port:11', 'unlimit.1024proxy.io', 20011, 'unlimited_port', 'proxy1024'],
      ['port:12', 'unlimit.1024proxy.io', 20012, 'unlimited_port', 'proxy1024'],
    ]);
    expect(await actions(id)).toContain('proxy_1024.order_paid');

    now += 5 * MIN;
    await runProxy1024Cron(env, { now });
    expect(await db.select().from(proxies).where(eq(proxies.orderId, id)).all()).toHaveLength(2);
    expect(fake.orderCalls()).toHaveLength(1);
  });

  it('实付超过上限基准 → 记 overcharge 审计与 actual_exceeds_estimate 警告；退款 → abandoned', async () => {
    const fake = fake1024();
    await configure();
    const over = await awaiting(fake, 2);
    const refunded = await awaiting(fake, 2);
    fake.state.records.push(
      { order_no: over.orderNo, name: 'x', true_money: '40.00', pay_time: '', pay_status: 1 },
      { order_no: refunded.orderNo, name: 'x', true_money: '31.00', pay_time: '', pay_status: 2 },
    );
    await runProxy1024Cron(env, { now: Date.now() + 5 * MIN });
    const overView = await getProxyOrder(env, over.id);
    expect(overView).toMatchObject({ status: 'paid', actualCents: 4000, warnings: expect.arrayContaining(['actual_exceeds_estimate']) });
    expect(await actions(over.id)).toContain('proxy_1024.order_overcharge');
    expect(await getProxyOrder(env, refunded.id)).toMatchObject({ status: 'abandoned', lastError: '1024proxy 已退款' });
  });

  it('unknown 无订单号：按金额与时间窗唯一匹配后挂上订单号；多条候选时保持 unknown', async () => {
    const fake = fake1024();
    await configure();
    fake.state.orderMode = 'http500';
    const a = await portQuote(2);
    await confirmProxyOrder(env, admin, a.id, { expectedCents: 3100 });
    expect((await orderRow(a.id)).status).toBe('unknown');

    fake.state.records.push({ order_no: 'X-1', name: 'p', true_money: '31.00', pay_time: '', pay_status: 0 }, { order_no: 'X-2', name: 'p', true_money: '31.01', pay_time: '', pay_status: 0 });
    await runProxy1024Cron(env, { now: Date.now() + 5 * MIN });
    expect(await orderRow(a.id)).toMatchObject({ status: 'unknown', orderNo: null });

    fake.state.records = [{ order_no: 'X-3', name: 'p', true_money: '31.00', pay_time: '', pay_status: 0 }, { order_no: 'X-4', name: 'p', true_money: '99.00', pay_time: '', pay_status: 1 }];
    await runProxy1024Cron(env, { now: Date.now() + 10 * MIN });
    expect(await orderRow(a.id)).toMatchObject({ status: 'awaiting_payment', orderNo: 'X-3' });
    expect(fake.orderCalls()).toHaveLength(1);
  });

  it('管理员处理：关联订单号需要实时记录佐证；放弃不调用供应商', async () => {
    const fake = fake1024();
    await configure();
    fake.state.orderMode = 'http500';
    const a = await portQuote(2);
    await confirmProxyOrder(env, admin, a.id, { expectedCents: 3100 });
    await expect(resolveProxyOrder(env, admin, a.id, { action: 'attach_order_no', orderNo: 'NOPE' })).rejects.toMatchObject({ code: 'conflict' });
    fake.state.records.push({ order_no: 'REAL-9', name: 'p', true_money: '31.00', pay_time: '', pay_status: 1 });
    expect(await resolveProxyOrder(env, admin, a.id, { action: 'attach_order_no', orderNo: 'REAL-9' })).toMatchObject({ status: 'paid', orderNo: 'REAL-9', actualCents: 3100 });

    const b = await portQuote(2);
    await confirmProxyOrder(env, admin, b.id, { expectedCents: 3100 });
    const before = fake.calls.length;
    expect((await resolveProxyOrder(env, admin, b.id, { action: 'abandon' })).status).toBe('abandoned');
    expect(fake.calls.length).toBe(before);
    await expect(resolveProxyOrder(env, admin, b.id, { action: 'abandon' })).rejects.toMatchObject({ code: 'conflict' });
    expect(await actions(b.id)).toContain('proxy_1024.order_resolve');
  });

  it('关联订单号：下单响应里的订单号在消费记录里查不到时可替换；已被记录确认的不能替换', async () => {
    const fake = fake1024();
    await configure();
    const { id, orderNo } = await awaiting(fake, 2);
    fake.state.records.push({ order_no: 'REAL-11', name: 'p', true_money: '31.00', pay_time: '', pay_status: 0 });
    expect(await resolveProxyOrder(env, admin, id, { action: 'attach_order_no', orderNo: 'REAL-11' })).toMatchObject({ status: 'awaiting_payment', orderNo: 'REAL-11' });
    expect(orderNo).not.toBe('REAL-11');
    fake.state.records.push({ order_no: 'REAL-12', name: 'p', true_money: '31.00', pay_time: '', pay_status: 0 });
    await expect(resolveProxyOrder(env, admin, id, { action: 'attach_order_no', orderNo: 'REAL-12' })).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('已在 1024proxy 消费记录中确认') });
    expect((await orderRow(id)).orderNo).toBe('REAL-11');
    expect(fake.orderCalls()).toHaveLength(1);
  });

  it('先做了整账户同步再对账：认领下单后入库、未关联的服务器 → fulfilled', async () => {
    const fake = fake1024();
    await configure();
    const { id, orderNo } = await awaiting(fake, 2);
    fake.state.records.push({ order_no: orderNo, name: 'ports', true_money: '31.00', pay_time: '', pay_status: 1 });
    fake.state.portServers = [
      { id: 21, ip: '198.51.100.21', domain: 'unlimit.1024proxy.io:20021', port: 20021, username: 'pu', password: 'p21', region: 'US', expired: '2099-01-01 00:00:00' },
      { id: 22, ip: '198.51.100.22', domain: 'unlimit.1024proxy.io:20022', port: 20022, username: 'pu', password: 'p22', region: 'US', expired: '2099-01-01 00:00:00' },
    ];
    expect(await syncProxy1024Inventory(env, admin, { kinds: ['unlimited_port'] })).toMatchObject({ created: 2 });
    await runProxy1024Cron(env, { now: Date.now() + 5 * MIN });
    expect(await getProxyOrder(env, id)).toMatchObject({ status: 'fulfilled', materializedCount: 2 });
    expect(await db.select().from(proxies).where(eq(proxies.orderId, id)).all()).toHaveLength(2);
  });

  it('两笔已付款无限端口订单：第一笔认领全部新服务器，第二笔提示核对、24 小时后停止自动同步，可手动标记已交付', async () => {
    const fake = fake1024();
    await configure();
    const a = await awaiting(fake, 2);
    const b = await awaiting(fake, 2);
    fake.state.records.push(
      { order_no: a.orderNo, name: 'ports', true_money: '31.00', pay_time: '', pay_status: 1 },
      { order_no: b.orderNo, name: 'ports', true_money: '31.00', pay_time: '', pay_status: 1 },
    );
    fake.state.portServers = [
      { id: 31, ip: '198.51.100.31', domain: 'unlimit.1024proxy.io:20031', port: 20031, username: 'pu', password: 'p31', region: 'US', expired: '2099-01-01 00:00:00' },
      { id: 32, ip: '198.51.100.32', domain: 'unlimit.1024proxy.io:20032', port: 20032, username: 'pu', password: 'p32', region: 'US', expired: '2099-01-01 00:00:00' },
    ];
    const t0 = Date.now() + 5 * MIN;
    await runProxy1024Cron(env, { now: t0 });
    expect((await orderRow(a.id)).status).toBe('fulfilled');
    expect(await orderRow(b.id)).toMatchObject({ status: 'paid', lastError: '' });
    await expect(resolveProxyOrder(env, admin, a.id, { action: 'mark_fulfilled' })).rejects.toMatchObject({ code: 'conflict' });

    await runProxy1024Cron(env, { now: t0 + 40 * MIN });
    expect(await orderRow(b.id)).toMatchObject({ status: 'paid', lastError: expect.stringContaining('标记已交付') });
    const listCalls = () => fake.callsTo('/get/v2/unlimit/portServers').length;
    const before = listCalls();
    await runProxy1024Cron(env, { now: t0 + 25 * 60 * MIN });
    expect(listCalls()).toBe(before);

    expect(await resolveProxyOrder(env, admin, b.id, { action: 'mark_fulfilled' })).toMatchObject({ status: 'fulfilled', lastError: '' });
    expect(await actions(b.id)).toContain('proxy_1024.order_resolve');
    expect(fake.orderCalls()).toHaveLength(2);
  });

  it('住宅流量付款后直接 fulfilled（额度类产品）；刷新单笔订单立即对账', async () => {
    const fake = fake1024();
    await configure();
    const quote = await quoteProxyOrder(env, admin, { product: 'residential_flow', sku: 'flowmax100', quantity: 10 });
    expect(quote).toMatchObject({ estimateCents: 1200 });
    const view = await confirmProxyOrder(env, admin, quote.id, { expectedCents: 1200 });
    fake.state.records.push({ order_no: view.orderNo!, name: 'flow', true_money: '12', pay_time: '', pay_status: 1 });
    const refreshed = await data<ProxyOrderView>(await call('POST', `/api/admin/proxy-1024/orders/${quote.id}/refresh`, admin.jwt));
    expect(refreshed).toMatchObject({ status: 'fulfilled', actualCents: 1200 });
  });

  it('静态 ISP：付款后分配（UNVERIFIED 路径）→ 同步入库 → fulfilled；每单只允许分配一次', async () => {
    const fake = fake1024();
    await configure();
    const quote = await quoteProxyOrder(env, admin, { product: 'static_isp', items: [{ country: 'KR', days: 30, count: 2 }] });
    const view = await confirmProxyOrder(env, admin, quote.id, { expectedCents: quote.estimateCents });
    await expect(allocateStaticForOrder(env, admin, quote.id)).rejects.toMatchObject({ code: 'conflict' });
    fake.state.records.push({ order_no: view.orderNo!, name: 'static', true_money: '5.70', pay_time: '', pay_status: 1 });
    await runProxy1024Cron(env, { now: Date.now() + 5 * MIN });
    expect((await orderRow(quote.id)).status).toBe('paid');

    const result = await allocateStaticForOrder(env, admin, quote.id);
    expect(result).toMatchObject({ created: 2 });
    expect(fake.callsTo('/add/v1/1024/static_use').map((c) => c.fields)).toEqual([expect.objectContaining({ code: 'KR', id: '501,502', day: '30' })]);
    const row = await orderRow(quote.id);
    expect(row).toMatchObject({ status: 'fulfilled', materializedCount: 2 });
    const synced = await db.select().from(proxies).where(eq(proxies.orderId, quote.id)).all();
    expect(synced.map((p) => [p.providerRef, p.product, p.country]).sort()).toEqual([['static:501', 'static_isp', 'KR'], ['static:502', 'static_isp', 'KR']]);
    await expect(allocateStaticForOrder(env, admin, quote.id)).rejects.toMatchObject({ code: 'conflict' });
    expect(fake.callsTo('/add/v1/1024/static_use')).toHaveLength(1);
  });

  it('cron：每轮最多 20 次供应商调用（20 单），其余留到下一轮', async () => {
    const fake = fake1024();
    await configure();
    const now = Date.now();
    for (let i = 0; i < 25; i++) {
      await db.insert(proxyOrders).values({
        status: 'awaiting_payment', product: 'unlimited_port', sku: '2-15ports30d', quantity: 2, estimateCents: 3100, capBasisCents: 3100,
        quoteExpiresAt: new Date(now), orderNo: `B-${i}`, createdBy: admin.id, confirmedAt: new Date(now), orderedAt: new Date(now),
      });
    }
    await runProxy1024Cron(env, { now: now + 5 * MIN });
    expect(fake.callsTo('/get/v1/1024/get_recharge_record')).toHaveLength(20);
    await runProxy1024Cron(env, { now: now + 6 * MIN });
    expect(fake.callsTo('/get/v1/1024/get_recharge_record')).toHaveLength(25);
    expect(fake.orderCalls()).toHaveLength(0);
  });

  it('cron：会话已失效时不调用供应商', async () => {
    const fake = fake1024();
    await configure();
    const { id } = await awaiting(fake, 2);
    await env.db.prepare("UPDATE integration_status SET state = 'invalid' WHERE provider = 'proxy1024'").run();
    const before = fake.calls.length;
    await runProxy1024Cron(env, { now: Date.now() + 5 * MIN });
    expect(fake.calls.length).toBe(before);
    expect((await orderRow(id)).checkedAt).toBeNull();
  });
});

describe('1024：库存同步与粘性会话生成', () => {
  it('同步三类库存：按 provider_ref 幂等，过期计数', async () => {
    const fake = fake1024();
    await configure();
    fake.state.bandwidthServers = [{ id: 7, ip: '192.0.2.7', domain: 'bw7.1024proxy.io', port: 9007, username: 'bw', password: 'bwp', region: 'DE', expired: '2020-01-01 00:00:00' }];
    fake.state.staticIps = [{ id: 31, ip: '203.0.113.31', port: 6000, username: 'su', password: 'sp', code: 'TH', city: 'Bangkok', region: 'AS', expired: '2099-01-01' }];
    const first = await syncProxy1024Inventory(env, admin, { kinds: ['static_isp', 'unlimited_port', 'unlimited_bandwidth'] });
    expect(first).toEqual({ created: 2, updated: 0, expired: 1 });
    expect(await syncProxy1024Inventory(env, admin, { kinds: ['static_isp', 'unlimited_bandwidth'] })).toEqual({ created: 0, updated: 2, expired: 1 });
    const bw = (await db.select().from(proxies).where(eq(proxies.providerRef, 'bw:7')).get())!;
    expect(bw).toMatchObject({ host: 'bw7.1024proxy.io', port: 9007, status: 'expired' });
  });

  it('生成粘性会话：用户名语法、密码取自子账号、网关缺省取第一个、每个 sid 一行', async () => {
    fake1024();
    await configure();
    const result = await generateStickyProxies(env, admin, { subUser: 'mailsub', country: 'US', state: 'Louisiana', city: 'New Orleans', minutes: 30, count: 3, protocol: 'socks5', maxBindings: 1 });
    expect(result).toEqual({ created: 3 });
    const rows = await db.select().from(proxies).where(like(proxies.providerRef, 'sub:mailsub:sid:%')).all();
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.username).toMatch(/^mailsub-region-US-st-Louisiana-city-New Orleans-sid-[A-HJ-NP-Za-km-z1-9]{8}-t-30$/);
      expect(row).toMatchObject({ host: 'us.1024proxy.io', port: 3000, protocol: 'socks5', product: 'residential_sticky', provider: '1024proxy' });
      expect(row.providerRef).toBe(`sub:mailsub:sid:${row.username.match(/-sid-(\w{8})-/)![1]}`);
    }
    expect(stickyUsername({ subUser: 'u', country: 'DE', sid: 'ENQzeWjG', minutes: 5 })).toBe('u-region-DE-sid-ENQzeWjG-t-5');
    await expect(generateStickyProxies(env, admin, { subUser: 'ghost', country: 'US', minutes: 30, count: 1, protocol: 'http', maxBindings: 1 })).rejects.toMatchObject({ code: 'upstream_failed' });
  });
});
