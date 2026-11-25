import { env } from 'cloudflare:test';
import type { AutoAssignResult, ProxyBindingLookupItem, ProxyBindingView, ProxyView } from '@hpc-mail/shared';
import { describe, expect, it } from 'vitest';
import { autoAssignProxies, bindAddress } from '../src/services/proxy-inventory.js';
import type { Env } from '../src/types.js';
import { call, claim, data, failure, makeUser, rand } from './fixtures/proxy1024/harness.js';

async function proxy(jwt: string, body: Record<string, unknown>) {
  return data<ProxyView>(await call('POST', '/api/admin/proxies', jwt, body), 201);
}
const bindPath = (address: string) => `/api/admin/proxies/bindings/${encodeURIComponent(address)}`;

describe('地址 ↔ 代理绑定', () => {
  it('绑定/改绑/解绑；未认领地址同样可绑；地址大小写归一；视图带当前认领人', async () => {
    const admin = await makeUser('bind', 'admin');
    const owner = await makeUser('bind-owner');
    const tag = rand();
    const a = await proxy(admin.jwt, { host: `ba-${tag}.example.net`, port: 1 });
    const b = await proxy(admin.jwt, { host: `bb-${tag}.example.net`, port: 1 });
    const claimed = `Claimed+${tag}@bind.test`;
    await claim(owner.id, claimed.toLowerCase());

    const view = await data<ProxyBindingView>(await call('PUT', bindPath(claimed), admin.jwt, { proxyId: a.id }));
    expect(view).toMatchObject({ address: claimed.toLowerCase(), domain: 'bind.test', proxyId: a.id, source: 'manual', boundBy: admin.id, ownerUserId: owner.id, ownerUsername: owner.username });
    expect(view.proxy).toMatchObject({ id: a.id, host: `ba-${tag}.example.net` });
    expect(JSON.stringify(view)).not.toMatch(/password/i);

    const rebound = await data<ProxyBindingView>(await call('PUT', bindPath(claimed), admin.jwt, { proxyId: b.id }));
    expect(rebound.proxyId).toBe(b.id);
    // 改回 a：a 的额度（max 1）只排除本地址自身
    await data(await call('PUT', bindPath(claimed), admin.jwt, { proxyId: a.id }));

    const unclaimed = await data<ProxyBindingView>(await call('PUT', bindPath(`nobody-${tag}@bind.test`), admin.jwt, { proxyId: b.id }));
    expect(unclaimed).toMatchObject({ ownerUserId: null, ownerUsername: null });

    await data(await call('DELETE', bindPath(claimed), admin.jwt));
    await failure(await call('DELETE', bindPath(claimed), admin.jwt), 404, 'not_found');
    await failure(await call('PUT', bindPath('not-an-address'), admin.jwt, { proxyId: a.id }), 400, 'validation_failed');
    await failure(await call('PUT', bindPath(`x-${tag}@bind.test`), admin.jwt, { proxyId: 99999999 }), 404, 'not_found');
  });

  it('额度守卫：max_bindings 用满 409；停用、过期的代理不能绑定', async () => {
    const admin = await makeUser('cap', 'admin');
    const tag = rand();
    const two = await proxy(admin.jwt, { host: `c2-${tag}.example.net`, port: 1, maxBindings: 2 });
    await data(await call('PUT', bindPath(`a-${tag}@cap.test`), admin.jwt, { proxyId: two.id }));
    await data(await call('PUT', bindPath(`b-${tag}@cap.test`), admin.jwt, { proxyId: two.id }));
    expect(await failure(await call('PUT', bindPath(`c-${tag}@cap.test`), admin.jwt, { proxyId: two.id }), 409, 'conflict')).toContain('已满');
    // 已绑定的地址重复绑定同一代理不受额度影响
    await data(await call('PUT', bindPath(`a-${tag}@cap.test`), admin.jwt, { proxyId: two.id }));

    const disabled = await proxy(admin.jwt, { host: `cd-${tag}.example.net`, port: 1, status: 'disabled' });
    expect(await failure(await call('PUT', bindPath(`d-${tag}@cap.test`), admin.jwt, { proxyId: disabled.id }), 409)).toContain('停用');
    const expired = await proxy(admin.jwt, { host: `ce-${tag}.example.net`, port: 1, expiresAt: new Date(Date.now() - 1000).toISOString() });
    await failure(await call('PUT', bindPath(`e-${tag}@cap.test`), admin.jwt, { proxyId: expired.id }), 409);
  });

  it('批量查询一次返回（按输入顺序，未绑定为 null）；列表按域名与地址游标分页', async () => {
    const admin = await makeUser('look', 'admin');
    const tag = rand();
    const domain = `look-${tag}.test`;
    const p = await proxy(admin.jwt, { host: `lk-${tag}.example.net`, port: 1, maxBindings: 10 });
    for (const local of ['c', 'a', 'b']) await bindAddress(env, admin, `${local}@${domain}`, p.id);
    const lookup = await data<{ items: ProxyBindingLookupItem[] }>(await call('POST', '/api/admin/proxies/bindings/lookup', admin.jwt, {
      addresses: [`B@${domain}`, `zz@${domain}`, `a@${domain}`, `b@${domain}`],
    }));
    expect(lookup.items.map((i) => [i.address, i.binding?.proxyId ?? null])).toEqual([[`b@${domain}`, p.id], [`zz@${domain}`, null], [`a@${domain}`, p.id]]);

    const page1 = await data<{ items: ProxyBindingView[]; nextCursor: string | null }>(await call('GET', `/api/admin/proxies/bindings?domain=${domain}&limit=2`, admin.jwt));
    expect(page1.items.map((i) => i.address)).toEqual([`a@${domain}`, `b@${domain}`]);
    const page2 = await data<{ items: ProxyBindingView[]; nextCursor: string | null }>(await call('GET', `/api/admin/proxies/bindings?domain=${domain}&limit=2&cursor=${page1.nextCursor}`, admin.jwt));
    expect(page2).toMatchObject({ items: [{ address: `c@${domain}` }], nextCursor: null });
    const byQ = await data<{ items: ProxyBindingView[] }>(await call('GET', `/api/admin/proxies/bindings?q=${encodeURIComponent(`C@LOOK-${tag}`)}&proxyId=${p.id}`, admin.jwt));
    expect(byQ.items.map((i) => i.address)).toEqual([`c@${domain}`]);
  });
});

describe('自动分配', () => {
  it('target=claimed：只分配未绑定的已认领地址，按域名过滤，dryRun 不写入，额度用完的地址列入 unassigned', async () => {
    const admin = await makeUser('auto', 'admin');
    const owner = await makeUser('auto-owner');
    const tag = rand();
    const domain = `auto-${tag}.test`;
    for (const local of ['m1', 'm2', 'm3', 'm4']) await claim(owner.id, `${local}@${domain}`);
    await claim(owner.id, `other@auto-x-${tag}.test`);
    const provider = `prov${tag}`;
    const p1 = await proxy(admin.jwt, { host: `a1-${tag}.example.net`, port: 1, provider, maxBindings: 2 });
    const p2 = await proxy(admin.jwt, { host: `a2-${tag}.example.net`, port: 1, provider });
    await proxy(admin.jwt, { host: `a3-${tag}.example.net`, port: 1, provider: 'elsewhere' });
    // m1 已手工绑定，不参与
    await bindAddress(env, admin, `m1@${domain}`, p2.id);

    const dry = await data<AutoAssignResult>(await call('POST', '/api/admin/proxies/auto-assign', admin.jwt, { target: 'claimed', domain, filter: { provider }, dryRun: true }));
    expect(dry).toEqual({ assigned: [{ address: `m2@${domain}`, proxyId: p1.id }, { address: `m3@${domain}`, proxyId: p1.id }], unassigned: [`m4@${domain}`], freeProxiesLeft: 0, dryRun: true });
    const lookup = async () => (await data<{ items: ProxyBindingLookupItem[] }>(await call('POST', '/api/admin/proxies/bindings/lookup', admin.jwt, {
      addresses: ['m2', 'm3', 'm4'].map((l) => `${l}@${domain}`),
    }))).items.map((i) => i.binding?.source ?? null);
    expect(await lookup()).toEqual([null, null, null]);

    const real = await data<AutoAssignResult>(await call('POST', '/api/admin/proxies/auto-assign', admin.jwt, { target: 'claimed', domain, filter: { provider } }));
    expect(real).toMatchObject({ assigned: dry.assigned, unassigned: [`m4@${domain}`], dryRun: false });
    expect(await lookup()).toEqual(['auto', 'auto', null]);
  });

  it('target=addresses：可含未认领地址，跳过已绑定地址', async () => {
    const admin = await makeUser('auto-x', 'admin');
    const tag = rand();
    const provider = `px${tag}`;
    const p = await proxy(admin.jwt, { host: `ax-${tag}.example.net`, port: 1, provider, maxBindings: 5, country: 'SG' });
    await bindAddress(env, admin, `already-${tag}@x.test`, p.id);
    const result = await data<AutoAssignResult>(await call('POST', '/api/admin/proxies/auto-assign', admin.jwt, {
      target: 'addresses', addresses: [`New-${tag}@x.test`, `already-${tag}@x.test`, `new-${tag}@x.test`], filter: { provider, country: 'sg' },
    }));
    expect(result).toMatchObject({ assigned: [{ address: `new-${tag}@x.test`, proxyId: p.id }], unassigned: [], freeProxiesLeft: 1 });
    await failure(await call('POST', '/api/admin/proxies/auto-assign', admin.jwt, { target: 'addresses' }), 400, 'validation_failed');
  });

  it('写入阶段并发的手工绑定优先（自动分配用 DO NOTHING，不覆盖）', async () => {
    const admin = await makeUser('auto-race', 'admin');
    const tag = rand();
    const provider = `race${tag}`;
    const auto = await proxy(admin.jwt, { host: `r1-${tag}.example.net`, port: 1, provider });
    const manual = await proxy(admin.jwt, { host: `r2-${tag}.example.net`, port: 1, provider: `manual${tag}` });
    const address = `race-${tag}@race.test`;
    let batches = 0;
    // 第二次 batch（写入）之前插入一次手工绑定，模拟并发
    const racing: Env = {
      ...env,
      db: new Proxy(env.db, {
        get(target, prop) {
          if (prop === 'batch') {
            return async (statements: D1PreparedStatement[]) => {
              if (++batches === 2) await bindAddress(env, admin, address, manual.id);
              return target.batch(statements);
            };
          }
          const value = Reflect.get(target, prop) as unknown;
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      }),
    };
    const result = await autoAssignProxies(racing, admin, { target: 'addresses', addresses: [address], limit: 10, filter: { provider }, dryRun: false });
    expect(result).toMatchObject({ assigned: [], unassigned: [address] });
    const lookup = await data<{ items: ProxyBindingLookupItem[] }>(await call('POST', '/api/admin/proxies/bindings/lookup', admin.jwt, { addresses: [address] }));
    expect(lookup.items[0]!.binding).toMatchObject({ proxyId: manual.id, source: 'manual' });
    expect(auto.id).not.toBe(manual.id);
  });
});
