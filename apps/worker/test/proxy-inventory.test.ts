import { env } from 'cloudflare:test';
import { SECRET_MASK, type ProxyCredential, type ProxyExport, type ProxyImportResult, type ProxyPoolStats, type ProxyView } from '@hpc-mail/shared';
import { desc, eq, like } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client.js';
import { adminAuditLogs, proxies } from '../src/db/schema.js';
import { isSealed } from '../src/lib/secret-box.js';
import { bindAddress, expireProxies, upsertProviderProxies, type ProviderProxyRow } from '../src/services/proxy-inventory.js';
import { call, data, failure, makeUser, rand } from './fixtures/proxy1024/harness.js';

const db = createDb(env);

async function create(jwt: string, body: Record<string, unknown>) {
  return data<ProxyView>(await call('POST', '/api/admin/proxies', jwt, body), 201);
}

async function auditFor(target: string) {
  return db.select().from(adminAuditLogs).where(eq(adminAuditLogs.target, target)).orderBy(desc(adminAuditLogs.id)).all();
}

describe('代理库存 CRUD', () => {
  it('仅管理员可用；创建后密码加密落库，视图不含密码；reveal 返回明文并留痕（不含密码）', async () => {
    const admin = await makeUser('inv-admin', 'admin');
    const user = await makeUser('inv-user');
    await failure(await call('GET', '/api/admin/proxies', user.jwt), 403, 'forbidden');

    const host = `p-${rand()}.example.net`;
    const view = await create(admin.jwt, { host, port: 8080, username: 'alice', password: 's3cret:pw@1', provider: 'Acme', country: 'us', label: '第一个', maxBindings: 2 });
    expect(view).toMatchObject({ host, port: 8080, username: 'alice', hasPassword: true, provider: 'acme', country: 'US', source: 'manual', status: 'active', bindingCount: 0, maxBindings: 2 });
    expect(JSON.stringify(view)).not.toContain('s3cret');
    const stored = (await db.select().from(proxies).where(eq(proxies.id, view.id)).get())!;
    expect(isSealed(stored.passwordEnc)).toBe(true);
    expect(stored.passwordEnc).not.toContain('s3cret');

    const revealed = await data<ProxyCredential>(await call('POST', `/api/admin/proxies/${view.id}/reveal`, admin.jwt));
    expect(revealed).toMatchObject({ proxyId: view.id, password: 's3cret:pw@1', url: `http://alice:s3cret%3Apw%401@${host}:8080` });
    const audits = await auditFor(`proxy:${view.id}`);
    expect(audits.map((a) => a.action)).toEqual(['proxy.reveal', 'proxy.create']);
    expect(JSON.stringify(audits)).not.toContain('s3cret');

    await failure(await call('POST', '/api/admin/proxies', admin.jwt, { host, port: 8080, username: 'alice' }), 409, 'conflict');
    await failure(await call('GET', '/api/admin/proxies/999999', admin.jwt), 404, 'not_found');
  });

  it('更新：SECRET_MASK 保留密码、新值替换、空串清除；端点冲突 409；只记录改动字段名', async () => {
    const admin = await makeUser('inv-upd', 'admin');
    const host = `u-${rand()}.example.net`;
    const a = await create(admin.jwt, { host, port: 1000, username: 'u', password: 'first' });
    await create(admin.jwt, { host, port: 1001, username: 'u', password: 'other' });
    const reveal = async () => (await data<ProxyCredential>(await call('POST', `/api/admin/proxies/${a.id}/reveal`, admin.jwt))).password;

    await data(await call('PUT', `/api/admin/proxies/${a.id}`, admin.jwt, { password: SECRET_MASK, label: '改名' }));
    expect(await reveal()).toBe('first');
    await data(await call('PUT', `/api/admin/proxies/${a.id}`, admin.jwt, { password: 'second' }));
    expect(await reveal()).toBe('second');
    const cleared = await data<ProxyView>(await call('PUT', `/api/admin/proxies/${a.id}`, admin.jwt, { password: '' }));
    expect(cleared.hasPassword).toBe(false);
    await failure(await call('PUT', `/api/admin/proxies/${a.id}`, admin.jwt, { port: 1001 }), 409, 'conflict');
    await failure(await call('PUT', `/api/admin/proxies/${a.id}`, admin.jwt, {}), 400, 'validation_failed');

    const updates = (await auditFor(`proxy:${a.id}`)).filter((x) => x.action === 'proxy.update').map((x) => x.detail);
    expect(updates).toEqual([`${host}:1000 password`, `${host}:1000 password`, `${host}:1000 label`]);
    expect(updates.join()).not.toMatch(/first|second/);
  });

  it('过期时间已过 → expired；续期后自动恢复 active；cron 按 expires_at 批量过期', async () => {
    const admin = await makeUser('inv-exp', 'admin');
    const host = `e-${rand()}.example.net`;
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const p = await create(admin.jwt, { host, port: 1, expiresAt: past });
    expect(p.status).toBe('expired');
    const renewed = await data<ProxyView>(await call('PUT', `/api/admin/proxies/${p.id}`, admin.jwt, { expiresAt: future }));
    expect(renewed.status).toBe('active');
    const disabled = await data<ProxyView>(await call('PUT', `/api/admin/proxies/${p.id}`, admin.jwt, { status: 'disabled' }));
    expect(disabled.status).toBe('disabled');

    const soon = await create(admin.jwt, { host, port: 2, expiresAt: new Date(Date.now() + 1000).toISOString() });
    expect(await expireProxies(env, Date.now() + 5000)).toBeGreaterThanOrEqual(1);
    expect((await data<ProxyView>(await call('GET', `/api/admin/proxies/${soon.id}`, admin.jwt))).status).toBe('expired');
  });

  it('列表：筛选 q/status/provider/country/bound + 游标分页（id 倒序）', async () => {
    const admin = await makeUser('inv-list', 'admin');
    const tag = rand();
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push((await create(admin.jwt, { host: `l${i}-${tag}.example.net`, port: 3000, provider: i % 2 ? 'odd' : 'even', country: i < 2 ? 'DE' : 'JP', notes: `Note-${tag}` })).id);
    }
    await bindAddress(env, { id: admin.id, username: admin.username }, `list-${tag}@bound.test`, ids[0]!);
    const page = async (query: string) => data<{ items: ProxyView[]; nextCursor: string | null }>(await call('GET', `/api/admin/proxies?${query}`, admin.jwt));
    const first = await page(`q=${tag.toUpperCase()}&limit=2`);
    expect(first.items.map((x) => x.id)).toEqual([ids[4], ids[3]]);
    const second = await page(`q=${tag}&limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(second.items.map((x) => x.id)).toEqual([ids[2], ids[1]]);
    expect((await page(`q=${tag}&provider=odd`)).items.map((x) => x.id)).toEqual([ids[3], ids[1]]);
    expect((await page(`q=${tag}&country=de`)).items.map((x) => x.id)).toEqual([ids[1], ids[0]]);
    const bound = await page(`q=${tag}&bound=yes`);
    expect(bound.items.map((x) => [x.id, x.bindingCount])).toEqual([[ids[0], 1]]);
    expect((await page(`q=${tag}&bound=no`)).items).toHaveLength(4);
    expect((await page(`q=${tag}%25`)).items).toHaveLength(0);
    await failure(await call('GET', '/api/admin/proxies?cursor=@@', admin.jwt), 400, 'validation_failed');
  });

  it('删除：有绑定且未强制 → 409；强制删除同时删掉绑定', async () => {
    const admin = await makeUser('inv-del', 'admin');
    const tag = rand();
    const p = await create(admin.jwt, { host: `d-${tag}.example.net`, port: 9 });
    await bindAddress(env, admin, `del-${tag}@bound.test`, p.id);
    await failure(await call('DELETE', `/api/admin/proxies/${p.id}`, admin.jwt), 409, 'conflict');
    await data(await call('DELETE', `/api/admin/proxies/${p.id}?force=1`, admin.jwt));
    await failure(await call('GET', `/api/admin/proxies/${p.id}`, admin.jwt), 404);
    const lookup = await data<{ items: { binding: unknown }[] }>(await call('POST', '/api/admin/proxies/bindings/lookup', admin.jwt, { addresses: [`del-${tag}@bound.test`] }));
    expect(lookup.items[0]!.binding).toBeNull();
    const free = await create(admin.jwt, { host: `d2-${tag}.example.net`, port: 9 });
    await data(await call('DELETE', `/api/admin/proxies/${free.id}`, admin.jwt));
  });

  it('健康上报与统计', async () => {
    await env.db.batch([env.db.prepare('DELETE FROM address_proxy_bindings'), env.db.prepare('DELETE FROM proxies')]);
    const admin = await makeUser('inv-stats', 'admin');
    const tag = rand();
    const a = await create(admin.jwt, { host: `s1-${tag}.example.net`, port: 1, provider: 'acme' });
    const b = await create(admin.jwt, { host: `s2-${tag}.example.net`, port: 1, provider: 'acme', maxBindings: 2 });
    await create(admin.jwt, { host: `s3-${tag}.example.net`, port: 1, status: 'disabled' });
    await create(admin.jwt, { host: `s4-${tag}.example.net`, port: 1, expiresAt: new Date(Date.now() - 1000).toISOString() });
    await bindAddress(env, admin, `s-${tag}@stats.test`, a.id);
    await bindAddress(env, admin, `t-${tag}@stats.test`, b.id);
    const stats = await data<ProxyPoolStats>(await call('GET', '/api/admin/proxies/stats', admin.jwt));
    expect(stats).toEqual({ total: 4, active: 2, expired: 1, disabled: 1, bound: 2, free: 1, byProvider: { acme: 2, manual: 2 } });

    const ok = await data<ProxyView>(await call('POST', `/api/admin/proxies/${a.id}/health`, admin.jwt, { ok: true, latencyMs: 120 }));
    expect(ok.health).toMatchObject({ status: 'ok', latencyMs: 120, error: '' });
    const bad = await data<ProxyView>(await call('POST', `/api/admin/proxies/${a.id}/health`, admin.jwt, { ok: false, error: 'timeout' }));
    expect(bad.health).toMatchObject({ status: 'fail', latencyMs: null, error: 'timeout' });
    expect(bad.health.checkedAt).not.toBeNull();
  });
});

describe('代理批量导入', () => {
  it('三种格式 + auto，默认值套用，重复与非法行计数，dryRun 不落库', async () => {
    const admin = await makeUser('imp', 'admin');
    const tag = rand();
    const text = [
      `# 注释行`,
      `socks5://u1:p%3A1@a-${tag}.example.net:1080`,
      `b-${tag}.example.net:8000:user-region-US-city-New Orleans:pass:with:colons`,
      `u3:p3@c-${tag}.example.net:9000`,
      `[2001:db8::${parseInt(tag.slice(0, 4), 16).toString(16)}]:3128`,
      `b-${tag}.example.net:8000:user-region-US-city-New Orleans:dup`,
      `not a proxy line`,
      `d-${tag}.example.net:70000`,
      '',
    ].join('\n');
    const dry = await data<ProxyImportResult>(await call('POST', '/api/admin/proxies/import', admin.jwt, { text, defaults: { provider: 'bulk', country: 'jp', maxBindings: 3 }, dryRun: true }));
    expect(dry).toEqual({ created: 4, duplicates: 1, invalid: [{ line: 7, reason: expect.any(String) }, { line: 8, reason: '端口需为 1-65535' }], dryRun: true });
    expect(await db.select().from(proxies).where(like(proxies.host, `%${tag}%`)).all()).toHaveLength(0);

    const result = await data<ProxyImportResult>(await call('POST', '/api/admin/proxies/import', admin.jwt, { text, defaults: { provider: 'bulk', country: 'jp', maxBindings: 3 } }));
    expect(result).toMatchObject({ created: 4, duplicates: 1, dryRun: false });
    const rows = await db.select().from(proxies).where(eq(proxies.provider, 'bulk')).all();
    const mine = rows.filter((r) => r.host.includes(tag) || r.host.startsWith('2001:db8::'));
    expect(mine.map((r) => [r.protocol, r.port, r.username, r.source, r.country, r.maxBindings]).sort()).toEqual([
      ['http', 3128, '', 'import', 'JP', 3],
      ['http', 8000, 'user-region-US-city-New Orleans', 'import', 'JP', 3],
      ['http', 9000, 'u3', 'import', 'JP', 3],
      ['socks5', 1080, 'u1', 'import', 'JP', 3],
    ].sort());
    expect(mine.every((r) => r.passwordEnc === '' || isSealed(r.passwordEnc))).toBe(true);

    // 再导入一次：全部重复
    const again = await data<ProxyImportResult>(await call('POST', '/api/admin/proxies/import', admin.jwt, { text }));
    expect(again).toMatchObject({ created: 0, duplicates: 5 });
    // 显式格式：url 格式不接受 host:port:user:pass
    const strict = await data<ProxyImportResult>(await call('POST', '/api/admin/proxies/import', admin.jwt, { text: `e-${tag}.example.net:1:u:p`, format: 'url' }));
    expect(strict).toMatchObject({ created: 0, invalid: [{ line: 1, reason: '不是 URL 格式' }] });
  });

  it('超过 2000 个非空行整体拒绝', async () => {
    const admin = await makeUser('imp-max', 'admin');
    const text = Array.from({ length: 2001 }, (_, i) => `h${i}.example.net:${(i % 60000) + 1}`).join('\n');
    await failure(await call('POST', '/api/admin/proxies/import', admin.jwt, { text }), 400, 'validation_failed');
  });
});

describe('代理导出', () => {
  it('bindings/proxies 两种范围 × 四种格式，按域名筛选，审计只记数量', async () => {
    const admin = await makeUser('exp', 'admin');
    const tag = rand();
    const domain = `exp-${tag}.test`;
    const p = await data<ProxyView>(await call('POST', '/api/admin/proxies', admin.jwt, { host: `x-${tag}.example.net`, port: 8080, username: 'eu', password: 'ep@ss', protocol: 'socks5' }), 201);
    await bindAddress(env, admin, `a@${domain}`, p.id);
    const exp = async (query: string) => data<ProxyExport>(await call('GET', `/api/admin/proxies/export?${query}`, admin.jwt));
    expect(await exp(`domain=${domain}`)).toEqual({ format: 'url', count: 1, content: `a@${domain}\tsocks5://eu:ep%40ss@x-${tag}.example.net:8080` });
    expect((await exp(`domain=${domain}&format=host_port_user_pass`)).content).toBe(`a@${domain}\tx-${tag}.example.net:8080:eu:ep@ss`);
    expect((await exp(`domain=${domain}&format=user_pass_at_host_port`)).content).toBe(`a@${domain}\teu:ep@ss@x-${tag}.example.net:8080`);
    const json = JSON.parse((await exp(`domain=${domain}&format=json`)).content) as Record<string, unknown>[];
    expect(json).toEqual([expect.objectContaining({ address: `a@${domain}`, proxyId: p.id, password: 'ep@ss', protocol: 'socks5' })]);
    const byProxy = await exp(`scope=proxies&domain=${domain}&format=json`);
    expect(JSON.parse(byProxy.content)).toEqual([expect.objectContaining({ id: p.id, provider: 'manual', password: 'ep@ss' })]);
    const audits = await auditFor('proxies');
    const exports = audits.filter((a) => a.action === 'proxy.export');
    expect(exports.length).toBeGreaterThanOrEqual(5);
    expect(JSON.stringify(exports)).not.toContain('ep@ss');
  });
});

describe('供应商同步 upsert', () => {
  const row = (ref: string, patch: Partial<ProviderProxyRow> = {}): ProviderProxyRow => ({
    provider: '1024proxy', providerRef: ref, protocol: 'http', host: `${ref.replace(/[^a-z0-9]/gi, '')}.sync.example.net`, port: 7000,
    username: 'syn', password: 'sync-pw', product: 'static_isp', country: 'kr', region: 'AS', city: 'Seoul', expiresAt: null, ...patch,
  });

  it('按 provider_ref 幂等；保留已有 order_id 与 disabled；端点被手工代理占用时跳过', async () => {
    const tag = rand();
    const first = await upsertProviderProxies(env, [row(`static:${tag}-1`), row(`static:${tag}-2`, { expiresAt: Date.now() - 1000 })], 7);
    expect(first).toEqual({ created: 2, updated: 0, skipped: 0 });
    const again = await upsertProviderProxies(env, [row(`static:${tag}-1`, { password: 'rotated' }), row(`static:${tag}-3`)], 8);
    expect(again).toEqual({ created: 1, updated: 1, skipped: 0 });
    const r1 = (await db.select().from(proxies).where(eq(proxies.providerRef, `static:${tag}-1`)).get())!;
    expect(r1).toMatchObject({ orderId: 7, status: 'active', country: 'KR', source: 'proxy1024' });
    expect((await db.select().from(proxies).where(eq(proxies.providerRef, `static:${tag}-2`)).get())!.status).toBe('expired');
    expect((await db.select().from(proxies).where(eq(proxies.providerRef, `static:${tag}-3`)).get())!.orderId).toBe(8);

    await db.update(proxies).set({ status: 'disabled' }).where(eq(proxies.id, r1.id));
    await upsertProviderProxies(env, [row(`static:${tag}-1`)], null);
    expect((await db.select().from(proxies).where(eq(proxies.id, r1.id)).get())!.status).toBe('disabled');

    const manualHost = `manual-${tag}.sync.example.net`;
    await db.insert(proxies).values({ host: manualHost, port: 7000, username: 'syn' });
    expect(await upsertProviderProxies(env, [row(`static:${tag}-9`, { host: manualHost })], null)).toEqual({ created: 0, updated: 0, skipped: 1 });
  });
});
