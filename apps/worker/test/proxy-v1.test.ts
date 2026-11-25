import { env } from 'cloudflare:test';
import type { CursorPage, MyProxyBinding, ProxyView, V1ProxyLookup } from '@hpc-mail/shared';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client.js';
import { mailboxShares } from '../src/db/schema.js';
import { bindAddress } from '../src/services/proxy-inventory.js';
import { updateSettings } from '../src/services/setting.js';
import { apiKey, call, claim, data, failure, makeUser, rand } from './fixtures/proxy1024/harness.js';

async function setup() {
  await updateSettings(env, { api: { enabled: true } });
  const tag = rand();
  const admin = await makeUser('v1-admin', 'admin');
  const owner = await makeUser('v1-owner');
  const other = await makeUser('v1-other');
  const domain = `v1-${tag}.test`;
  const mine = `mine@${domain}`;
  const unbound = `unbound@${domain}`;
  const boxId = await claim(owner.id, mine);
  await claim(owner.id, unbound);
  await claim(other.id, `theirs@${domain}`);
  await createDb(env).insert(mailboxShares).values({ mailboxId: boxId, userId: other.id, grantedBy: owner.id });
  const p = await data<ProxyView>(await call('POST', '/api/admin/proxies', admin.jwt, { host: `v1-${tag}.example.net`, port: 3128, username: 'v1u', password: 'v1-pass', country: 'US', maxBindings: 5 }), 201);
  await bindAddress(env, admin, mine, p.id);
  await bindAddress(env, admin, `theirs@${domain}`, p.id);
  await bindAddress(env, admin, `orphan@${domain}`, p.id);
  return { tag, admin, owner, other, domain, mine, unbound, proxy: p };
}

describe('/v1/proxies（API Key）', () => {
  it('需要 proxy.read scope', async () => {
    const s = await setup();
    const key = await apiKey(s.owner.id, ['mail.read', 'mailbox.read']);
    expect(await failure(await call('GET', `/v1/proxies/lookup?address=${s.mine}`, key), 403, 'forbidden')).toContain('proxy.read');
    await failure(await call('GET', '/v1/proxies', key), 403, 'forbidden');
  });

  it('所有者能查到明文凭据；未绑定返回 proxy=null；他人/共享接收人/不存在的地址一律 404', async () => {
    const s = await setup();
    const ownerKey = await apiKey(s.owner.id, ['proxy.read']);
    const hit = await data<V1ProxyLookup>(await call('GET', `/v1/proxies/lookup?address=${encodeURIComponent(s.mine.toUpperCase())}`, ownerKey));
    expect(hit).toEqual({
      address: s.mine,
      proxy: expect.objectContaining({ proxyId: s.proxy.id, host: `v1-${s.tag}.example.net`, port: 3128, username: 'v1u', password: 'v1-pass', url: `http://v1u:v1-pass@v1-${s.tag}.example.net:3128`, status: 'active', country: 'US' }),
    });
    expect(await data<V1ProxyLookup>(await call('GET', `/v1/proxies/lookup?address=${s.unbound}`, ownerKey))).toEqual({ address: s.unbound, proxy: null });

    const otherKey = await apiKey(s.other.id, ['proxy.read']);
    // 共享给我的邮箱不授予代理凭据
    await failure(await call('GET', `/v1/proxies/lookup?address=${s.mine}`, otherKey), 404, 'not_found');
    await failure(await call('GET', `/v1/proxies/lookup?address=orphan@${s.domain}`, ownerKey), 404, 'not_found');
    await failure(await call('GET', `/v1/proxies/lookup?address=nope@${s.domain}`, ownerKey), 404, 'not_found');
    await failure(await call('GET', '/v1/proxies/lookup?address=bad', ownerKey), 400, 'validation_failed');
  });

  it('管理员 Key 可查任意地址（含未认领）；all=1 仅管理员', async () => {
    const s = await setup();
    const adminKey = await apiKey(s.admin.id, ['proxy.read']);
    const orphan = await data<V1ProxyLookup>(await call('GET', `/v1/proxies/lookup?address=orphan@${s.domain}`, adminKey));
    expect(orphan.proxy?.password).toBe('v1-pass');
    expect(await data<V1ProxyLookup>(await call('GET', `/v1/proxies/lookup?address=ghost@${s.domain}`, adminKey))).toEqual({ address: `ghost@${s.domain}`, proxy: null });

    const all = await data<CursorPage<MyProxyBinding>>(await call('GET', `/v1/proxies?all=1&domain=${s.domain}&limit=2`, adminKey));
    expect(all.items.map((i) => i.address)).toEqual([`mine@${s.domain}`, `orphan@${s.domain}`]);
    const rest = await data<CursorPage<MyProxyBinding>>(await call('GET', `/v1/proxies?all=1&domain=${s.domain}&limit=2&cursor=${all.nextCursor}`, adminKey));
    expect(rest).toEqual({ items: [expect.objectContaining({ address: `theirs@${s.domain}` })], nextCursor: null });
    // 管理员不带 all 只看自己认领的
    expect((await data<CursorPage<MyProxyBinding>>(await call('GET', `/v1/proxies?domain=${s.domain}`, adminKey))).items).toEqual([]);

    const ownerKey = await apiKey(s.owner.id, ['proxy.read']);
    await failure(await call('GET', '/v1/proxies?all=1', ownerKey), 403, 'forbidden');
    const own = await data<CursorPage<MyProxyBinding>>(await call('GET', `/v1/proxies?domain=${s.domain}`, ownerKey));
    expect(own.items.map((i) => [i.address, i.proxy.password])).toEqual([[s.mine, 'v1-pass']]);
  });
});

describe('/api/proxies/mine（JWT）', () => {
  it('只返回自己认领地址的代理；释放后立刻不可见', async () => {
    const s = await setup();
    const mine = await data<{ items: MyProxyBinding[] }>(await call('GET', '/api/proxies/mine', s.owner.jwt));
    expect(mine.items.map((i) => [i.address, i.proxy.url])).toEqual([[s.mine, `http://v1u:v1-pass@v1-${s.tag}.example.net:3128`]]);
    const other = await data<{ items: MyProxyBinding[] }>(await call('GET', '/api/proxies/mine', s.other.jwt));
    expect(other.items.map((i) => i.address)).toEqual([`theirs@${s.domain}`]);
    await env.db.prepare('DELETE FROM mailboxes WHERE address = ?').bind(s.mine).run();
    expect((await data<{ items: MyProxyBinding[] }>(await call('GET', '/api/proxies/mine', s.owner.jwt))).items).toEqual([]);
    await failure(await call('GET', '/api/proxies/mine', 'not-a-token'), 401);
  });
});
