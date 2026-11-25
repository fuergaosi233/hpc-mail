import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DomainPurchaseBatchView, DomainPurchaseStatus } from '@hpc-mail/shared';
import { createDb } from '../src/db/client.js';
import { adminAuditLogs, mailboxes, users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import { onError, requestId } from '../src/middleware/error.js';
import adminDomainPurchases from '../src/routes/admin/domain-purchases.js';
import {
  cancelDomainBatch, confirmDomainBatch, domainPurchaseStatus, getDomainBatch, listDomainBatches, quoteDomainPurchase, runDomainPurchaseCron,
} from '../src/services/domain-purchase.js';
import { createSession } from '../src/services/session.js';
import { getSettingsFresh } from '../src/services/setting.js';
import type { AppContext, Env } from '../src/types.js';
import { fakeVendors } from './fixtures/spaceship/fake-vendors.js';
import { admin, batchRow, expectAppError, itemsOf, runtime, setupPurchase } from './fixtures/spaceship/setup.js';

const db = createDb(env);
let clock = Date.now();
const deps = () => ({ now: () => clock, sleep: async () => {} });

afterEach(() => {
  vi.unstubAllGlobals();
});

async function quote(domains: string[] | string, envIn: Env = runtime) {
  return quoteDomainPurchase(envIn, admin, { domains }, '127.0.0.1', deps());
}

function quotedTotal(batch: DomainPurchaseBatchView, domains: string[]) {
  return batch.items!.filter((item) => domains.includes(item.domain)).reduce((sum, item) => sum + item.capBasisCents!, 0);
}

describe('域名采购：报价', () => {
  it('拆分/规范化/去重，本地排除与供应商结果逐项标记，价格按 max(final, regular)', async () => {
    clock = Date.now();
    const listed = `listed-${Date.now()}.com`;
    const t = await setupPurchase({ maxDomainCents: 3_000 }, [listed]);
    const vendors = fakeVendors({ clock: () => clock });
    const user = (await db.insert(users).values({ username: `${t.prefix}-owner`, role: 'user', passwordHash: 'x', authVersionMigrated: true }).returning().get())!;
    await db.insert(mailboxes).values({ address: `old@${t.domain('history')}`, domain: t.domain('history'), userId: user.id });
    vendors.ss.availability.set(t.domain('taken'), 'taken');
    vendors.ss.availability.set(t.domain('weird'), 'tldNotSupported');
    vendors.ss.prices.set(t.domain('premium'), { final: '20.00', regular: '20.00', priceClass: 'premium' });
    vendors.ss.prices.set(t.domain('pricey'), { final: '10.00', regular: '30.01' });
    vendors.ss.prices.set(t.domain('promo'), { final: '1.234', regular: '9.00' });

    const text = [
      ` ${t.domain('ok').toUpperCase()}.`, t.domain('ok'), 'bad/x', listed, t.domain('history'), t.domain('taken'),
      t.domain('weird'), t.domain('premium'), t.domain('pricey'), t.domain('promo'),
    ].join(',\n');
    const batch = await quote(text);
    const byDomain = new Map(batch.items!.map((item) => [item.domain, item]));
    expect(batch.status).toBe('quoted');
    expect(byDomain.get(t.domain('ok'))).toMatchObject({ status: 'quoted', finalCents: 998, regularCents: 1298, capBasisCents: 1298, priceClass: 'standard' });
    expect(byDomain.get(t.domain('promo'))).toMatchObject({ status: 'quoted', finalCents: 124, capBasisCents: 900 });
    expect(batch.items!.filter((item) => item.skipReason === 'duplicate')).toHaveLength(1);
    expect(batch.items!.filter((item) => item.skipReason === 'invalid')).toHaveLength(1);
    expect(byDomain.get(listed)!.skipReason).toBe('already_listed');
    expect(byDomain.get(t.domain('history'))!.skipReason).toBe('has_history');
    expect(byDomain.get(t.domain('taken'))!.skipReason).toBe('taken');
    expect(byDomain.get(t.domain('weird'))!.skipReason).toBe('tldNotSupported');
    expect(byDomain.get(t.domain('premium'))!.skipReason).toBe('premium');
    expect(byDomain.get(t.domain('pricey'))).toMatchObject({ status: 'skipped', skipReason: 'over_domain_cap', capBasisCents: 3001 });
    expect(batch.quoteTotalCents).toBe(1298 + 900);
    expect(new Date(batch.quoteExpiresAt).getTime()).toBe(clock + 15 * 60_000);
    // 本地排除的域名不发往供应商；价格只查可用的
    const asked = vendors.ss.availabilityCalls.flat();
    expect(asked).not.toContain(listed);
    expect(asked).not.toContain(t.domain('history'));
    expect(vendors.ss.pricingCalls.flat()).not.toContain(t.domain('taken'));
    expect(vendors.ss.registerCalls).toEqual([]);
    const audit = await db.select().from(adminAuditLogs).all();
    expect(audit.some((row) => row.action === 'domain_purchase.quote' && row.target === `domain_batch:${batch.id}`)).toBe(true);
  });

  it('超过 20 个名称分组查询；进行中的同名域名排除；超出单批数量 400', async () => {
    clock = Date.now();
    const t = await setupPurchase();
    const vendors = fakeVendors({ clock: () => clock });
    const names = Array.from({ length: 25 }, (_, i) => t.domain(`n${i}`));
    const first = await quote(names);
    expect(vendors.ss.availabilityCalls.map((group) => group.length)).toEqual([20, 5]);
    expect(first.items!.every((item) => item.status === 'quoted')).toBe(true);

    await confirmDomainBatch(runtime, admin, first.id, { domains: [names[0]!], expectedTotalCents: 1298 }, '', null, deps());
    const second = await quote([names[0]!, names[1]!]);
    expect(second.items!.find((item) => item.domain === names[0])!.skipReason).toBe('in_flight');

    const many = Array.from({ length: 31 }, (_, i) => t.domain(`m${i}`));
    await expectAppError(quote(many), 'validation_failed');
  });

  it('未启用 / 未配置凭据 / 上限为 0 时 not_configured，且不发任何外部请求', async () => {
    clock = Date.now();
    const vendors = fakeVendors({ clock: () => clock });
    await setupPurchase({ enabled: false });
    await expectAppError(quote(['a-x.com']), 'not_configured');
    await setupPurchase({ apiSecret: '' });
    await expectAppError(quote(['a-x.com']), 'not_configured');
    await setupPurchase({ maxDailyCents: 0 });
    await expectAppError(quote(['a-x.com']), 'not_configured');
    expect(vendors.fetchMock).not.toHaveBeenCalled();
  });
});

describe('域名采购：确认', () => {
  it('价格上涨 → 409，写回新报价并延长有效期，不注册', async () => {
    clock = Date.now();
    const t = await setupPurchase();
    const vendors = fakeVendors({ clock: () => clock });
    const names = [t.domain('a'), t.domain('b')];
    const batch = await quote(names);
    vendors.ss.prices.set(names[1]!, { final: '9.98', regular: '14.50' });
    clock += 60_000;
    const message = await expectAppError(confirmDomainBatch(runtime, admin, batch.id, { domains: names, expectedTotalCents: quotedTotal(batch, names) }, '', null, deps()), 'conflict');
    expect(message).toContain('报价已变化');
    const after = await getDomainBatch(runtime, batch.id);
    expect(after.status).toBe('quoted');
    expect(after.items!.find((item) => item.domain === names[1])!.capBasisCents).toBe(1450);
    expect(after.quoteTotalCents).toBe(1298 + 1450);
    expect(new Date(after.quoteExpiresAt).getTime()).toBe(clock + 15 * 60_000);
    expect(after.lastError).toContain(names[1]);
    expect(vendors.ss.registerCalls).toEqual([]);
    // 按新价格重新确认即可通过
    const confirmed = await confirmDomainBatch(runtime, admin, batch.id, { domains: names, expectedTotalCents: 1298 + 1450 }, '', null, deps());
    expect(confirmed.status).toBe('processing');
    expect(confirmed.confirmedTotalCents).toBe(1298 + 1450);
  });

  it('确认时已不可注册 → 409，条目改为 skipped:taken；降价不阻止确认', async () => {
    clock = Date.now();
    const t = await setupPurchase();
    const vendors = fakeVendors({ clock: () => clock });
    const names = [t.domain('a'), t.domain('b')];
    const batch = await quote(names);
    vendors.ss.availability.set(names[0]!, 'taken');
    vendors.ss.prices.set(names[1]!, { final: '1.00', regular: '1.00' });
    await expectAppError(confirmDomainBatch(runtime, admin, batch.id, { domains: names, expectedTotalCents: quotedTotal(batch, names) }, '', null, deps()), 'conflict');
    const after = await getDomainBatch(runtime, batch.id);
    expect(after.items!.find((item) => item.domain === names[0])).toMatchObject({ status: 'skipped', skipReason: 'taken' });
    // 降价不算变化：仍按原报价（较高者）计上限
    expect(after.items!.find((item) => item.domain === names[1])).toMatchObject({ status: 'quoted', capBasisCents: 1298 });
    const confirmed = await confirmDomainBatch(runtime, admin, batch.id, { domains: [names[1]!], expectedTotalCents: 1298 }, '', null, deps());
    expect(confirmed.items!.find((item) => item.domain === names[1])!.status).toBe('confirmed');
  });

  it('确认金额与报价不一致 → 409，批次退回 quoted', async () => {
    clock = Date.now();
    const t = await setupPurchase();
    fakeVendors({ clock: () => clock });
    const batch = await quote([t.domain('a')]);
    await expectAppError(confirmDomainBatch(runtime, admin, batch.id, { domains: [t.domain('a')], expectedTotalCents: 1 }, '', null, deps()), 'conflict');
    expect((await batchRow(batch.id)).status).toBe('quoted');
    await expectAppError(confirmDomainBatch(runtime, admin, batch.id, { domains: ['other-domain.com'], expectedTotalCents: 1298 }, '', null, deps()), 'validation_failed');
    expect((await batchRow(batch.id)).status).toBe('quoted');
  });

  it('上限：单批、24 小时滚动、系统域名名额；超限不采购且批次退回 quoted', async () => {
    clock = Date.now();
    let t = await setupPurchase({ maxBatchCents: 2_000 });
    const vendors = fakeVendors({ clock: () => clock });
    let names = [t.domain('a'), t.domain('b')];
    let batch = await quote(names);
    expect(await expectAppError(confirmDomainBatch(runtime, admin, batch.id, { domains: names, expectedTotalCents: 2596 }, '', null, deps()), 'validation_failed')).toContain('单批上限');
    expect((await batchRow(batch.id)).status).toBe('quoted');

    // 24 小时：第一批 1298 通过，第二批 1298 + 2596 > 2600
    t = await setupPurchase({ maxDailyCents: 2_600 });
    const first = await quote([t.domain('one')]);
    await confirmDomainBatch(runtime, admin, first.id, { domains: [t.domain('one')], expectedTotalCents: 1298 }, '', null, deps());
    names = [t.domain('two'), t.domain('three')];
    batch = await quote(names);
    expect(await expectAppError(confirmDomainBatch(runtime, admin, batch.id, { domains: names, expectedTotalCents: 2596 }, '', null, deps()), 'validation_failed')).toContain('24 小时');
    // 只买一个刚好在上限内
    const ok = await confirmDomainBatch(runtime, admin, batch.id, { domains: [names[0]!], expectedTotalCents: 1298 }, '', null, deps());
    expect(ok.status).toBe('processing');
    expect(ok.items!.find((item) => item.domain === names[1])).toMatchObject({ status: 'skipped', skipReason: 'not_selected' });

    // 系统域名：已有 63 个 + 选 2 个 > 64
    const existing = Array.from({ length: 63 }, (_, i) => `sys${i}-${Date.now()}.com`);
    t = await setupPurchase({}, existing);
    names = [t.domain('a'), t.domain('b')];
    batch = await quote(names);
    expect(await expectAppError(confirmDomainBatch(runtime, admin, batch.id, { domains: names, expectedTotalCents: 2596 }, '', null, deps()), 'validation_failed')).toContain('名额');
    expect(vendors.ss.registerCalls).toEqual([]);
  });

  it('并发确认只有一个成功；过期报价 409 并置 expired；quoted 可取消', async () => {
    clock = Date.now();
    const t = await setupPurchase();
    const vendors = fakeVendors({ clock: () => clock });
    const names = [t.domain('a')];
    const batch = await quote(names);
    const results = await Promise.allSettled([
      confirmDomainBatch(runtime, admin, batch.id, { domains: names, expectedTotalCents: 1298 }, '', null, deps()),
      confirmDomainBatch(runtime, admin, batch.id, { domains: names, expectedTotalCents: 1298 }, '', null, deps()),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.code).toBe('conflict');
    expect((await itemsOf(batch.id)).filter((item) => item.status === 'confirmed')).toHaveLength(1);
    await runDomainPurchaseCron(runtime, { now: clock, deps: deps() });
    await runDomainPurchaseCron(runtime, { now: clock + 1000, deps: deps() });
    expect(vendors.ss.registerCalls).toEqual(names);

    const late = await quote([t.domain('late')]);
    clock += 16 * 60_000;
    expect(await expectAppError(confirmDomainBatch(runtime, admin, late.id, { domains: [t.domain('late')], expectedTotalCents: 1298 }, '', null, deps()), 'conflict')).toContain('过期');
    expect((await batchRow(late.id)).status).toBe('expired');
    expect((await itemsOf(late.id))[0]!.status).toBe('cancelled');

    const other = await quote([t.domain('cancel')]);
    const cancelled = await cancelDomainBatch(runtime, admin, other.id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.items![0]!.status).toBe('cancelled');
    await expectAppError(cancelDomainBatch(runtime, admin, batch.id), 'conflict');
  });

  it('未配置 Cloudflare 或收件 Worker 时确认返回 not_configured；状态接口列出原因', async () => {
    clock = Date.now();
    const t = await setupPurchase();
    const vendors = fakeVendors({ clock: () => clock });
    const batch = await quote([t.domain('a')]);
    const noIngress: Env = { ...runtime, worker_name: undefined };
    await expectAppError(confirmDomainBatch(noIngress, admin, batch.id, { domains: [t.domain('a')], expectedTotalCents: 1298 }, '', null, deps()), 'not_configured');
    const status = await domainPurchaseStatus(noIngress);
    expect(status.purchasingAllowed).toBe(false);
    expect(status.ingressWorker).toBeNull();
    expect(status.reasons.join()).toContain('收件 Worker');
    const ok = await domainPurchaseStatus(runtime);
    expect(ok).toMatchObject({ purchasingAllowed: true, ingressWorker: 'hpc-mail-ingress-test', ingressWorkerSource: 'env', configured: true, cloudflareConfigured: true });
    await setupPurchase({ ingressWorkerName: 'hpc-mail-ingress-20261028' });
    expect(await domainPurchaseStatus(noIngress)).toMatchObject({ ingressWorker: 'hpc-mail-ingress-20261028', ingressWorkerSource: 'setting' });
    expect(vendors.ss.calls.filter((call) => call.startsWith('POST /v1/domains/') && !call.includes('available') && !call.includes('pricing'))).toEqual([]);
  });
});

describe('域名采购：管理接口', () => {
  async function adminToken(role: 'admin' | 'user' = 'admin') {
    const user = (await db.insert(users).values({ username: `dp-route-${role}-${crypto.randomUUID().slice(0, 8)}`, role, passwordHash: 'x', authVersionMigrated: true }).returning().get())!;
    const sid = await createSession(env, user.id);
    return signToken(env.jwt_secret, { sub: user.id, sid, epoch: 0, uepoch: 0 });
  }
  const app = new Hono<AppContext>();
  app.use('*', requestId);
  app.route('/api/admin/domain-purchases', adminDomainPurchases);
  app.onError(onError);
  const call = (method: string, path: string, token: string, body?: unknown) => app.request(`/api/admin/domain-purchases${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, runtime);

  it('管理员可报价、查看、列表；普通用户 403；信封与密钥回显', async () => {
    clock = Date.now();
    const t = await setupPurchase();
    fakeVendors({ clock: () => Date.now() });
    const token = await adminToken();
    const status = await call('GET', '/status', token);
    expect(status.status).toBe(200);
    expect(((await status.json()) as { data: DomainPurchaseStatus }).data.purchasingAllowed).toBe(true);

    const created = await call('POST', '/quotes', token, { domains: `${t.domain('a')} ${t.domain('b')}` });
    expect(created.status).toBe(201);
    const batch = ((await created.json()) as { data: DomainPurchaseBatchView }).data;
    expect(batch.items).toHaveLength(2);

    const detail = await call('GET', `/${batch.id}`, token);
    expect(((await detail.json()) as { data: DomainPurchaseBatchView }).data.items).toHaveLength(2);
    const list = await call('GET', '?limit=1', token);
    const page = ((await list.json()) as { data: { items: DomainPurchaseBatchView[]; nextCursor: string | null } }).data;
    expect(page.items[0]).toMatchObject({ id: batch.id, counts: { quoted: 2 } });
    expect(page.items[0]!.items).toBeUndefined();

    const bad = await call('POST', `/${batch.id}/confirm`, token, { domains: [t.domain('a')], expectedTotalCents: 5 });
    expect(bad.status).toBe(409);
    expect(((await bad.json()) as { error: { code: string }; requestId: string })).toMatchObject({ error: { code: 'conflict' } });

    const missing = await call('GET', '/999999', token);
    expect(missing.status).toBe(404);

    const user = await adminToken('user');
    expect((await call('GET', '/status', user)).status).toBe(403);

    // 密钥只以密文落库
    const raw = await env.db.prepare("SELECT value FROM settings WHERE key = 'spaceship'").first<{ value: string }>();
    expect(raw!.value).not.toContain('test-secret');
    expect((await getSettingsFresh(env)).spaceship.apiSecret.startsWith('enc:v1:')).toBe(true);

    const listed = await listDomainBatches(env, { limit: 50 });
    expect(listed.items.some((item) => item.id === batch.id)).toBe(true);
  });
});
