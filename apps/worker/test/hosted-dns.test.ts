import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_HOSTED_DNS_RECORDS, MAX_HOSTED_DNS_REQUESTS_PER_MINUTE, type HostedDnsRecord } from '@hpc-mail/shared';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { adminAuditLogs, hostedDomainMembers, hostedDomains, users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import { createSession } from '../src/services/session.js';
import { updateSettings } from '../src/services/setting.js';
import type { Env } from '../src/types.js';

const app = createApp();
const db = createDb(env);
const ACCOUNT = 'acct-test';

interface FakeRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  priority?: number;
  proxied: boolean;
  proxiable: boolean;
  ttl: number;
  meta: Record<string, boolean>;
  comment: string | null;
  tags: string[];
  modified_on: string;
  data?: Record<string, unknown>;
}

let recordSeq = 0;
const rid = () => (++recordSeq).toString(16).padStart(32, '0');
const MAIL_META = { email_routing: true, read_only: true };

function record(fields: Partial<FakeRecord> & Pick<FakeRecord, 'type' | 'name' | 'content'>): FakeRecord {
  return {
    id: rid(), proxied: false, proxiable: ['A', 'AAAA', 'CNAME'].includes(fields.type), ttl: 1, meta: {}, comment: null, tags: [],
    modified_on: '2026-10-01T00:00:00.000Z', ...fields,
  };
}

/** 与线上 zone 实测一致的邮箱记录：根域 SPF 与 _dmarc 没有 meta 标记 */
function mailRecords(domain: string): FakeRecord[] {
  return [
    ...[1, 2, 3].map((n) => record({ type: 'MX', name: domain, content: `route${n}.mx.cloudflare.net`, priority: n * 10, meta: MAIL_META })),
    ...[1, 2, 3].map((n) => record({ type: 'MX', name: `cf-bounce.${domain}`, content: `route${n}.mx.cloudflare.net`, priority: n * 10, meta: MAIL_META })),
    record({ type: 'TXT', name: domain, content: '"v=spf1 include:_spf.mx.cloudflare.net ~all"' }),
    record({ type: 'TXT', name: `cf2024-1._domainkey.${domain}`, content: '"v=DKIM1; h=sha256; k=rsa; p=MIIB"', meta: MAIL_META }),
    record({ type: 'TXT', name: `cf-bounce.${domain}`, content: '"v=spf1 include:_spf.mx.cloudflare.net ~all"', meta: { read_only: true } }),
    record({ type: 'TXT', name: `cf-bounce._domainkey.${domain}`, content: '"v=DKIM1; p=MIIB"', meta: { read_only: true } }),
    record({ type: 'TXT', name: `_dmarc.${domain}`, content: '"v=DMARC1; p=reject;"' }),
  ];
}

/** 结构化记录的 content 与 Cloudflare 一致：SRV 为「weight port target」，CAA 为「flags tag "value"」 */
function materialize(body: Record<string, unknown>, id: string, prev?: FakeRecord): FakeRecord {
  const type = String(body.type ?? prev?.type);
  const data = (body.data ?? prev?.data) as Record<string, unknown> | undefined;
  let content = String(body.content ?? prev?.content ?? '');
  if (type === 'SRV' && data) content = `${data.weight} ${data.port} ${data.target}`;
  if (type === 'CAA' && data) content = `${data.flags} ${data.tag} "${data.value}"`;
  const priority = type === 'SRV' ? Number(data?.priority) : (body.priority ?? prev?.priority) as number | undefined;
  const comment = 'comment' in body ? (body.comment ? String(body.comment) : null) : prev?.comment ?? null;
  return {
    id, type, name: String(body.name ?? prev?.name), content, ...(priority === undefined ? {} : { priority }),
    proxied: Boolean(body.proxied ?? prev?.proxied ?? false), proxiable: ['A', 'AAAA', 'CNAME'].includes(type),
    ttl: Number(body.ttl ?? prev?.ttl ?? 1), meta: prev?.meta ?? {}, comment, tags: [], modified_on: '2026-10-22T00:00:00.000Z',
    ...(data ? { data } : {}),
  };
}

/** 有状态的假 Cloudflare DNS 接口：只实现 dns_records，记录每次调用，可注入一次失败 */
function fakeCloudflare() {
  const zones = new Map<string, { name: string; records: Map<string, FakeRecord> }>();
  const calls: { method: string; path: string; query: string; body: Record<string, unknown> | null }[] = [];
  let failure: { method: string; status: number; code: number } | null = null;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const ok = (result: unknown, extra: Record<string, unknown> = {}) => json({ success: true, errors: [], messages: [], result, ...extra });
  const fail = (status: number, code: number, message: string) => json({ success: false, errors: [{ code, message }], messages: [], result: null }, status);
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    expect(url.origin).toBe('https://api.cloudflare.com');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-token');
    const path = url.pathname.replace('/client/v4', '');
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    calls.push({ method, path, query: url.search, body });
    if (failure && failure.method === method) {
      const { status, code } = failure;
      failure = null;
      return status >= 500 ? new Response('upstream error', { status }) : fail(status, code, `injected ${code}`);
    }
    const match = path.match(/^\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/);
    const zone = match ? zones.get(match[1]!) : undefined;
    // 与真实 Cloudflare 一致：不存在的 zone 返回 403/9109
    if (!zone) return fail(403, 9109, 'Invalid zone identifier');
    const recordId = match![2];
    if (!recordId && method === 'GET') {
      const perPage = Number(url.searchParams.get('per_page') ?? 100);
      const page = Number(url.searchParams.get('page') ?? 1);
      const all = [...zone.records.values()];
      const result = all.slice((page - 1) * perPage, page * perPage);
      return ok(result, { result_info: { page, per_page: perPage, count: result.length, total_count: all.length,
        total_pages: Math.max(1, Math.ceil(all.length / perPage)) } });
    }
    if (!recordId && method === 'POST') {
      const created = materialize(body ?? {}, rid());
      zone.records.set(created.id, created);
      return ok(created);
    }
    const existing = recordId ? zone.records.get(recordId) : undefined;
    if (!existing) return fail(404, 81044, 'Record does not exist.');
    if (method === 'GET') return ok(existing);
    if (method === 'PATCH') {
      const updated = materialize(body ?? {}, existing.id, existing);
      zone.records.set(existing.id, updated);
      return ok(updated);
    }
    if (method === 'DELETE') {
      zone.records.delete(existing.id);
      return ok({ id: existing.id });
    }
    return fail(400, 9999, `unexpected ${method} ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    zones, calls,
    writes: () => calls.filter((entry) => entry.method !== 'GET'),
    failNext: (method: string, status: number, code = 0) => { failure = { method, status, code }; },
    add: (zoneId: string, ...records: FakeRecord[]) => { for (const item of records) zones.get(zoneId)!.records.set(item.id, item); return records; },
  };
}

const runtime: Env = { ...env, cf_api_token: 'test-token', cf_account_id: ACCOUNT, worker_name: 'hpc-cloud-mail' };
const HOSTED_SETTINGS = { enabled: true, maxPerUser: 3, maxPendingPerUser: 1, maxPendingTotal: 10, pendingDays: 7, autoClaimLimit: 1000 };

let sequence = 0;
async function fixture(cf: ReturnType<typeof fakeCloudflare>) {
  const prefix = `dns${++sequence}`;
  await updateSettings(env, { hosted_domains: HOSTED_SETTINGS });
  async function actor(suffix: string, role: 'admin' | 'user' = 'user') {
    const user = (await db.insert(users).values({ username: `${prefix}-${suffix}`, role, passwordHash: 'test', authVersionMigrated: true }).returning().get())!;
    const sid = await createSession(env, user.id);
    const jwt = await signToken(env.jwt_secret, { sub: user.id, sid, epoch: 0, uepoch: 0 });
    return { ...user, jwt };
  }
  /** 直接落一行托管域名并在假 Cloudflare 建好带邮箱记录的 zone；zoneId 为 null 表示创建中 */
  async function hosted(owner: { id: number }, name = 'site', opts: { status?: typeof hostedDomains.$inferInsert.status; zoneId?: string | null } = {}) {
    const domain = `${prefix}-${name}.test`;
    const zoneId = opts.zoneId === undefined ? `zone-${prefix}-${name}` : opts.zoneId;
    const row = (await db.insert(hostedDomains).values({ domain, userId: owner.id, status: opts.status ?? 'active', zoneId }).returning().get())!;
    if (zoneId && opts.zoneId === undefined) cf.zones.set(zoneId, { name: domain, records: new Map(mailRecords(domain).map((item) => [item.id, item])) });
    return { id: row.id, domain, zoneId: zoneId ?? '' };
  }
  return { prefix, actor, hosted };
}

async function call(method: string, path: string, token: string, body?: unknown, runtimeEnv: Env = runtime) {
  const ctx = createExecutionContext();
  const response = await app.request(`/api${path}`, { method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, runtimeEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
async function data<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json() as { data: T; error?: { code: string; message: string } };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body.data;
}
async function errorOf(response: Response, status: number): Promise<{ code: string; message: string }> {
  const body = await response.json() as { error: { code: string; message: string } };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body.error;
}
async function audits(domain: string) {
  return (await db.select().from(adminAuditLogs)
    .where(and(eq(adminAuditLogs.action, 'hosted_domain.dns'), eq(adminAuditLogs.target, domain))).all()).map((row) => row.detail);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('托管域名 DNS 列表', () => {
  it('邮箱记录按名称与 meta 判为 mail，NS 与已代理的记录只读，其余可编辑，@ 在最前', async () => {
    const cf = fakeCloudflare();
    const f = await fixture(cf);
    const owner = await f.actor('owner');
    const site = await f.hosted(owner);
    const d = site.domain;
    const [www, verify, ns, proxied, metaOnly, caa, srv] = cf.add(site.zoneId,
      record({ type: 'A', name: `www.${d}`, content: '203.0.113.10', comment: '官网' }),
      record({ type: 'TXT', name: d, content: '"google-site-verification=abc"' }),
      record({ type: 'NS', name: `sub.${d}`, content: 'ns1.other.example' }),
      record({ type: 'A', name: `cdn.${d}`, content: '203.0.113.20', proxied: true }),
      record({ type: 'TXT', name: `_cf-custom.${d}`, content: 'x', meta: { read_only: true } }),
      record({ type: 'CAA', name: d, content: '0 issue "letsencrypt.org"', data: { flags: 0, tag: 'issue', value: 'letsencrypt.org' } }),
      record({ type: 'SRV', name: `_sip._tcp.${d}`, content: '5 5060 sip.example.net', priority: 10, data: { priority: 10, weight: 5, port: 5060, target: 'sip.example.net' } }),
    );
    const list = await data<HostedDnsRecord[]>(await call('GET', `/hosted-domains/${site.id}/dns-records`, owner.jwt));
    expect(list).toHaveLength(18);
    const byId = new Map(list.map((item) => [item.id, item]));
    const kinds = (type: string, name: string) => list.filter((item) => item.type === type && item.name === name).map((item) => item.kind);
    expect(kinds('MX', '@')).toEqual(['mail', 'mail', 'mail']);
    expect(kinds('MX', 'cf-bounce')).toEqual(['mail', 'mail', 'mail']);
    expect(kinds('TXT', 'cf2024-1._domainkey')).toEqual(['mail']);
    expect(kinds('TXT', 'cf-bounce._domainkey')).toEqual(['mail']);
    expect(kinds('TXT', 'cf-bounce')).toEqual(['mail']);
    // 根域 SPF 与 _dmarc 没有 meta 标记，按名称判定
    const spf = list.find((item) => item.type === 'TXT' && item.name === '@' && item.content.includes('spf1'))!;
    expect(spf).toMatchObject({ kind: 'mail', lockedReason: expect.stringContaining('SPF') });
    expect(list.find((item) => item.name === '_dmarc')).toMatchObject({ kind: 'mail', lockedReason: expect.stringContaining('DMARC') });
    expect(byId.get(metaOnly!.id)).toMatchObject({ kind: 'mail', lockedReason: '由 Cloudflare 邮件服务自动维护' });
    expect(byId.get(ns!.id)).toMatchObject({ kind: 'readonly', lockedReason: '本站暂不支持编辑 NS 记录', name: 'sub' });
    expect(byId.get(proxied!.id)).toMatchObject({ kind: 'readonly', proxied: true, lockedReason: '已开启 Cloudflare 代理，请联系管理员修改' });
    expect(byId.get(www!.id)).toEqual({
      id: www!.id, type: 'A', name: 'www', fqdn: `www.${d}`, content: '203.0.113.10', ttl: 1, priority: null, srv: null, caa: null,
      proxied: false, comment: '官网', kind: 'user', lockedReason: '', modifiedAt: '2026-10-01T00:00:00.000Z',
    });
    expect(byId.get(verify!.id)).toMatchObject({ kind: 'user', name: '@' });
    expect(byId.get(caa!.id)).toMatchObject({ kind: 'user', caa: { flags: 0, tag: 'issue', value: 'letsencrypt.org' }, priority: null });
    expect(byId.get(srv!.id)).toMatchObject({ kind: 'user', name: '_sip._tcp', srv: { priority: 10, weight: 5, port: 5060, target: 'sip.example.net' }, priority: null });
    expect(list.find((item) => item.type === 'MX' && item.name === '@')!.priority).toBe(10);

    expect(list.map((item) => `${item.name} ${item.type} ${item.content}`)).toEqual([
      '@ CAA 0 issue "letsencrypt.org"', '@ MX route1.mx.cloudflare.net', '@ MX route2.mx.cloudflare.net', '@ MX route3.mx.cloudflare.net',
      '@ TXT "google-site-verification=abc"', '@ TXT "v=spf1 include:_spf.mx.cloudflare.net ~all"',
      '_cf-custom TXT x', '_dmarc TXT "v=DMARC1; p=reject;"', '_sip._tcp SRV 5 5060 sip.example.net', 'cdn A 203.0.113.20',
      'cf-bounce MX route1.mx.cloudflare.net', 'cf-bounce MX route2.mx.cloudflare.net', 'cf-bounce MX route3.mx.cloudflare.net',
      'cf-bounce TXT "v=spf1 include:_spf.mx.cloudflare.net ~all"', 'cf-bounce._domainkey TXT "v=DKIM1; p=MIIB"',
      'cf2024-1._domainkey TXT "v=DKIM1; h=sha256; k=rsa; p=MIIB"', 'sub NS ns1.other.example', 'www A 203.0.113.10',
    ]);
    expect(cf.writes()).toEqual([]);
  });

  it('tag 或 flags 超出表单范围的 CAA 记录只读，不能修改或删除', async () => {
    const cf = fakeCloudflare();
    const f = await fixture(cf);
    const owner = await f.actor('owner');
    const site = await f.hosted(owner);
    const caa = (flags: number, tag: string, value: string) =>
      record({ type: 'CAA', name: site.domain, content: `${flags} ${tag} "${value}"`, data: { flags, tag, value } });
    const [mailTag, oddFlags, wild, critical] = cf.add(site.zoneId,
      caa(0, 'issuemail', 'letsencrypt.org'), caa(1, 'issue', 'letsencrypt.org'), caa(0, 'issuewild', 'pki.goog'), caa(128, 'iodef', 'mailto:ca@example.net'));
    const byId = new Map((await data<HostedDnsRecord[]>(await call('GET', `/hosted-domains/${site.id}/dns-records`, owner.jwt)))
      .map((item) => [item.id, item]));
    for (const locked of [mailTag!, oddFlags!]) {
      expect(byId.get(locked.id)).toMatchObject({ kind: 'readonly', lockedReason: '本站暂不支持编辑该 CAA 记录' });
    }
    expect(byId.get(wild!.id)).toMatchObject({ kind: 'user', lockedReason: '' });
    expect(byId.get(critical!.id)).toMatchObject({ kind: 'user', caa: { flags: 128, tag: 'iodef', value: 'mailto:ca@example.net' } });

    const path = `/hosted-domains/${site.id}/dns-records/${mailTag!.id}`;
    const input = { type: 'CAA', name: '@', ttl: 1, caa: { flags: 0, tag: 'issue', value: 'letsencrypt.org' } };
    expect((await errorOf(await call('PUT', path, owner.jwt, input), 403)).message).toBe('本站暂不支持编辑该 CAA 记录');
    expect((await errorOf(await call('DELETE', path, owner.jwt), 403)).message).toBe('本站暂不支持编辑该 CAA 记录');
    expect(cf.writes()).toEqual([]);
  });
});

describe('新增与冲突', () => {
  it('各类型按 Cloudflare 格式写入：完整域名、A/AAAA/CNAME 显式关闭代理、SRV/CAA 用 data，并记审计', async () => {
    const cf = fakeCloudflare();
    const f = await fixture(cf);
    const owner = await f.actor('owner');
    const site = await f.hosted(owner);
    const d = site.domain;
    const path = `/hosted-domains/${site.id}/dns-records`;
    const inputs = [
      { type: 'A', name: 'www', ttl: 1, content: '203.0.113.10' },
      { type: 'AAAA', name: '@', ttl: 300, content: '2001:db8::1', comment: '  IPv6 入口 ' },
      { type: 'CNAME', name: `blog.${d}.`, ttl: 1, content: 'cname.vercel-dns.com' },
      { type: 'TXT', name: '@', ttl: 1, content: 'google-site-verification=abc' },
      { type: 'MX', name: 'mail', ttl: 3600, content: 'mx.other.example', priority: 10 },
      { type: 'SRV', name: '_minecraft._tcp.mc', ttl: 1, srv: { priority: 0, weight: 5, port: 25565, target: 'MC.example.net.' } },
      { type: 'CAA', name: '@', ttl: 1, caa: { flags: 0, tag: 'issue', value: 'letsencrypt.org' } },
    ];
    const created: HostedDnsRecord[] = [];
    for (const input of inputs) created.push(await data<HostedDnsRecord>(await call('POST', path, owner.jwt, input), 201));
    const bodies = cf.writes().map((entry) => {
      expect(entry).toMatchObject({ method: 'POST', path: `/zones/${site.zoneId}/dns_records` });
      return entry.body;
    });
    expect(bodies).toEqual([
      { type: 'A', name: `www.${d}`, ttl: 1, content: '203.0.113.10', proxied: false },
      { type: 'AAAA', name: d, ttl: 300, content: '2001:db8::1', proxied: false, comment: 'IPv6 入口' },
      { type: 'CNAME', name: `blog.${d}`, ttl: 1, content: 'cname.vercel-dns.com', proxied: false },
      { type: 'TXT', name: d, ttl: 1, content: 'google-site-verification=abc' },
      { type: 'MX', name: `mail.${d}`, ttl: 3600, content: 'mx.other.example', priority: 10 },
      { type: 'SRV', name: `_minecraft._tcp.mc.${d}`, ttl: 1, data: { priority: 0, weight: 5, port: 25565, target: 'mc.example.net' } },
      { type: 'CAA', name: d, ttl: 1, data: { flags: 0, tag: 'issue', value: 'letsencrypt.org' } },
    ]);
    expect(created.map((item) => [item.type, item.name, item.kind])).toEqual([
      ['A', 'www', 'user'], ['AAAA', '@', 'user'], ['CNAME', 'blog', 'user'], ['TXT', '@', 'user'], ['MX', 'mail', 'user'],
      ['SRV', '_minecraft._tcp.mc', 'user'], ['CAA', '@', 'user'],
    ]);
    expect(created[1]).toMatchObject({ comment: 'IPv6 入口', ttl: 300, proxied: false, priority: null });
    expect(created[4]).toMatchObject({ priority: 10, content: 'mx.other.example' });
    expect(created[5]).toMatchObject({
      srv: { priority: 0, weight: 5, port: 25565, target: 'mc.example.net' }, content: '5 25565 mc.example.net', priority: null,
    });
    expect(created[6]).toMatchObject({ caa: { flags: 0, tag: 'issue', value: 'letsencrypt.org' } });
    expect(await audits(d)).toEqual([
      '新增 A www → 203.0.113.10', '新增 AAAA @ → 2001:db8::1', '新增 CNAME blog → cname.vercel-dns.com',
      '新增 TXT @ → google-site-verification=abc', '新增 MX mail → 10 mx.other.example', '新增 SRV _minecraft._tcp.mc → 0 5 25565 mc.example.net',
      '新增 CAA @ → 0 issue "letsencrypt.org"',
    ]);
  });

  it('与邮箱冲突的记录在调用 Cloudflare 写接口之前拒绝', async () => {
    const cf = fakeCloudflare();
    const f = await fixture(cf);
    const owner = await f.actor('owner');
    const site = await f.hosted(owner);
    const path = `/hosted-domains/${site.id}/dns-records`;
    const cases: [Record<string, unknown>, string][] = [
      [{ type: 'MX', name: '@', ttl: 1, content: 'mx.other.example', priority: 5 }, 'MX'],
      [{ type: 'TXT', name: '@', ttl: 1, content: 'v=spf1 include:other.example -all' }, 'SPF'],
      [{ type: 'TXT', name: '_dmarc', ttl: 1, content: 'v=DMARC1; p=none' }, 'DMARC'],
      [{ type: 'TXT', name: 'x._domainkey', ttl: 1, content: 'v=DKIM1; p=abc' }, 'DKIM'],
      [{ type: 'A', name: 'cf-bounce', ttl: 1, content: '203.0.113.10' }, 'cf-bounce'],
      [{ type: 'CNAME', name: '@', ttl: 1, content: 'cname.vercel-dns.com' }, 'CNAME'],
      [{ type: 'CNAME', name: 'loop', ttl: 1, content: `loop.${site.domain}` }, 'CNAME 不能指向自身'],
      [{ type: 'A', name: `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}`, ttl: 1, content: '203.0.113.10' }, '记录名过长'],
    ];
    for (const [input, reason] of cases) {
      const error = await errorOf(await call('POST', path, owner.jwt, input), 400);
      expect(error, JSON.stringify(input)).toMatchObject({ code: 'validation_failed', message: expect.stringContaining(reason) });
    }
    // 修改时改到邮箱占用的名称同样拒绝
    const [www] = cf.add(site.zoneId, record({ type: 'TXT', name: `www.${site.domain}`, content: 'hello' }));
    const renamed = { type: 'TXT', name: '_dmarc', ttl: 1, content: 'v=DMARC1; p=none' };
    expect((await errorOf(await call('PUT', `${path}/${www!.id}`, owner.jwt, renamed), 400)).message).toContain('DMARC');
    expect(cf.writes()).toEqual([]);
    expect(await audits(site.domain)).toEqual([]);
  });
});

describe('修改与删除', () => {
  it('只能改可编辑的记录，不能改类型；修改与删除都记审计', async () => {
    const cf = fakeCloudflare();
    const f = await fixture(cf);
    const owner = await f.actor('owner');
    const site = await f.hosted(owner);
    const path = `/hosted-domains/${site.id}/dns-records`;
    const [www, ns, cdn] = cf.add(site.zoneId,
      record({ type: 'A', name: `www.${site.domain}`, content: '203.0.113.10', comment: '旧备注' }),
      record({ type: 'NS', name: `sub.${site.domain}`, content: 'ns1.other.example' }),
      record({ type: 'A', name: `cdn.${site.domain}`, content: '203.0.113.20', proxied: true }),
    );
    const zone = cf.zones.get(site.zoneId)!;
    const rootMx = [...zone.records.values()].find((item) => item.type === 'MX' && item.name === site.domain)!;
    const rootSpf = [...zone.records.values()].find((item) => item.type === 'TXT' && item.name === site.domain)!;
    const put = (id: string, body: unknown) => call('PUT', `${path}/${id}`, owner.jwt, body);

    expect((await errorOf(await put(www!.id, { type: 'TXT', name: 'www', ttl: 1, content: 'x' }), 400)).message)
      .toBe('不能修改记录类型，请删除后重新添加');
    expect((await errorOf(await put(rootMx.id, { type: 'MX', name: 'mail', ttl: 1, content: 'mx.other.example', priority: 1 }), 403)).message)
      .toContain('MX');
    expect((await errorOf(await put(rootSpf.id, { type: 'TXT', name: '@', ttl: 1, content: 'hello' }), 403)).message).toContain('SPF');
    expect((await errorOf(await put(ns!.id, { type: 'A', name: 'sub', ttl: 1, content: '203.0.113.1' }), 403)).message)
      .toBe('本站暂不支持编辑 NS 记录');
    expect((await errorOf(await put(cdn!.id, { type: 'A', name: 'cdn', ttl: 1, content: '203.0.113.1' }), 403)).message).toContain('代理');
    for (const target of [rootMx, rootSpf, ns!, cdn!]) {
      expect((await errorOf(await call('DELETE', `${path}/${target.id}`, owner.jwt), 403)).code).toBe('forbidden');
    }
    expect(cf.writes()).toEqual([]);

    const missing = 'f'.repeat(32);
    expect((await errorOf(await put(missing, { type: 'A', name: 'www', ttl: 1, content: '203.0.113.1' }), 404)).message).toBe('解析记录不存在');
    expect((await errorOf(await call('DELETE', `${path}/${missing}`, owner.jwt), 404)).message).toBe('解析记录不存在');
    const calls = cf.calls.length;
    for (const bad of ['not-a-record', 'F'.repeat(32), 'a'.repeat(31)]) {
      expect((await errorOf(await call('DELETE', `${path}/${bad}`, owner.jwt), 404)).message).toBe('解析记录不存在');
    }
    expect(cf.calls).toHaveLength(calls);

    const updated = await data<HostedDnsRecord>(await put(www!.id, { type: 'A', name: 'web', ttl: 600, content: '203.0.113.99' }));
    expect(updated).toMatchObject({ id: www!.id, name: 'web', content: '203.0.113.99', ttl: 600, comment: '', kind: 'user' });
    // PATCH 显式关闭代理，备注清空时传空串
    expect(cf.writes()).toEqual([{ method: 'PATCH', path: `/zones/${site.zoneId}/dns_records/${www!.id}`, query: '',
      body: { type: 'A', name: `web.${site.domain}`, ttl: 600, comment: '', content: '203.0.113.99', proxied: false } }]);
    expect(await data(await call('DELETE', `${path}/${www!.id}`, owner.jwt))).toEqual({ success: true });
    expect(zone.records.has(www!.id)).toBe(false);
    expect(await audits(site.domain)).toEqual(['修改 A www→web：203.0.113.10 → 203.0.113.99', '删除 A web → 203.0.113.99']);

    const long = await data<HostedDnsRecord>(await call('POST', path, owner.jwt, { type: 'TXT', name: 'long', ttl: 1, content: 'x'.repeat(200) }), 201);
    await data(await put(long.id, { type: 'TXT', name: 'long', ttl: 1, content: 'y'.repeat(200) }));
    expect((await audits(site.domain))[3]).toBe(`修改 TXT long：${'x'.repeat(79)}… → ${'y'.repeat(79)}…`);
  });
});

describe('权限与状态', () => {
  it('成员 403、无关用户 404，管理员可管理他人域名', async () => {
    const cf = fakeCloudflare();
    const f = await fixture(cf);
    const owner = await f.actor('owner');
    const member = await f.actor('member');
    const stranger = await f.actor('stranger');
    const admin = await f.actor('admin', 'admin');
    const site = await f.hosted(owner);
    await db.insert(hostedDomainMembers).values({ domainId: site.id, userId: member.id, grantedBy: owner.id });
    const path = `/hosted-domains/${site.id}/dns-records`;
    const input = { type: 'A', name: 'www', ttl: 1, content: '203.0.113.10' };

    expect((await errorOf(await call('GET', path, member.jwt), 403)).message).toBe('只有域名所有者或管理员可以执行此操作');
    expect((await errorOf(await call('POST', path, member.jwt, input), 403)).code).toBe('forbidden');
    expect((await errorOf(await call('GET', path, stranger.jwt), 404)).message).toBe('域名不存在');
    expect((await errorOf(await call('POST', path, stranger.jwt, input), 404)).code).toBe('not_found');
    expect((await errorOf(await call('GET', '/hosted-domains/999999/dns-records', owner.jwt), 404)).code).toBe('not_found');
    expect(cf.calls).toEqual([]);

    const created = await data<HostedDnsRecord>(await call('POST', path, admin.jwt, input), 201);
    expect(await data<HostedDnsRecord[]>(await call('GET', path, admin.jwt))).toContainEqual(created);
    await data(await call('DELETE', `${path}/${created.id}`, admin.jwt));
    const rows = await db.select().from(adminAuditLogs)
      .where(and(eq(adminAuditLogs.action, 'hosted_domain.dns'), eq(adminAuditLogs.target, site.domain))).all();
    expect(rows.map((row) => [row.actorId, row.detail])).toEqual([[admin.id, '新增 A www → 203.0.113.10'], [admin.id, '删除 A www → 203.0.113.10']]);
  });

  it('删除中与创建中 409；暂停时所有者只读、管理员可写；等待 NS 时可以先补记录', async () => {
    const cf = fakeCloudflare();
    const f = await fixture(cf);
    const owner = await f.actor('owner');
    const admin = await f.actor('admin', 'admin');
    const input = { type: 'A', name: 'www', ttl: 1, content: '203.0.113.10' };
    const records = (id: number) => `/hosted-domains/${id}/dns-records`;

    const deleting = await f.hosted(owner, 'deleting', { status: 'deleting' });
    expect((await errorOf(await call('GET', records(deleting.id), owner.jwt), 409)).message).toBe('域名正在删除');
    expect((await errorOf(await call('POST', records(deleting.id), admin.jwt, input), 409)).message).toBe('域名正在删除');
    const creating = await f.hosted(owner, 'creating', { status: 'pending', zoneId: null });
    expect((await errorOf(await call('GET', records(creating.id), owner.jwt), 409)).message).toBe('域名还在创建中，请稍后再试');
    expect(cf.calls).toEqual([]);

    const suspended = await f.hosted(owner, 'suspended', { status: 'suspended' });
    expect(await data<HostedDnsRecord[]>(await call('GET', records(suspended.id), owner.jwt))).toHaveLength(11);
    expect((await errorOf(await call('POST', records(suspended.id), owner.jwt, input), 403)).message).toBe('域名已被管理员暂停，解析只读');
    const [www] = cf.add(suspended.zoneId, record({ type: 'A', name: `www.${suspended.domain}`, content: '203.0.113.1' }));
    expect((await errorOf(await call('PUT', `${records(suspended.id)}/${www!.id}`, owner.jwt, input), 403)).code).toBe('forbidden');
    expect((await errorOf(await call('DELETE', `${records(suspended.id)}/${www!.id}`, owner.jwt), 403)).code).toBe('forbidden');
    expect(cf.writes()).toEqual([]);
    expect(await data<HostedDnsRecord>(await call('PUT', `${records(suspended.id)}/${www!.id}`, admin.jwt, input)))
      .toMatchObject({ content: '203.0.113.10' });
    await data<HostedDnsRecord>(await call('POST', records(suspended.id), admin.jwt, { ...input, name: 'api' }), 201);

    const pending = await f.hosted(owner, 'pending', { status: 'pending' });
    expect(await data<HostedDnsRecord>(await call('POST', records(pending.id), owner.jwt, input), 201)).toMatchObject({ name: 'www', kind: 'user' });
  });

  it('只看 Worker 凭据：关闭托管开关仍可管理，没有凭据 403', async () => {
    const cf = fakeCloudflare();
    const f = await fixture(cf);
    const owner = await f.actor('owner');
    const site = await f.hosted(owner);
    const path = `/hosted-domains/${site.id}/dns-records`;
    await updateSettings(env, { hosted_domains: { ...HOSTED_SETTINGS, enabled: false } });
    expect(await data<HostedDnsRecord[]>(await call('GET', path, owner.jwt))).toHaveLength(11);
    await data(await call('POST', path, owner.jwt, { type: 'A', name: 'www', ttl: 1, content: '203.0.113.10' }), 201);
    const calls = cf.calls.length;
    expect((await errorOf(await call('GET', path, owner.jwt, undefined, env), 403)).message).toBe('本站未开启域名托管');
    expect(cf.calls).toHaveLength(calls);
  });
});

describe('上限与限流', () => {
  it(`非邮箱记录达到 ${MAX_HOSTED_DNS_RECORDS} 条后不能新增，列表分页拉全`, async () => {
    const cf = fakeCloudflare();
    const f = await fixture(cf);
    const owner = await f.actor('owner');
    const site = await f.hosted(owner);
    const path = `/hosted-domains/${site.id}/dns-records`;
    cf.add(site.zoneId, ...Array.from({ length: MAX_HOSTED_DNS_RECORDS - 2 },
      (_, i) => record({ type: 'A', name: `h${i}.${site.domain}`, content: '203.0.113.1' })));
    // 只读记录也占额度，邮箱记录不占
    cf.add(site.zoneId, record({ type: 'NS', name: `sub.${site.domain}`, content: 'ns1.other.example' }));
    const list = await data<HostedDnsRecord[]>(await call('GET', path, owner.jwt));
    expect(list).toHaveLength(MAX_HOSTED_DNS_RECORDS - 1 + 11);
    expect(cf.calls.map((entry) => entry.query)).toEqual(['?page=1&per_page=100', '?page=2&per_page=100']);

    await data(await call('POST', path, owner.jwt, { type: 'A', name: 'last', ttl: 1, content: '203.0.113.1' }), 201);
    const writes = cf.writes().length;
    expect((await errorOf(await call('POST', path, owner.jwt, { type: 'A', name: 'more', ttl: 1, content: '203.0.113.1' }), 403)).message)
      .toBe(`每个域名最多 ${MAX_HOSTED_DNS_RECORDS} 条解析记录`);
    expect(cf.writes()).toHaveLength(writes);
  });

  it(`每位用户每分钟最多 ${MAX_HOSTED_DNS_REQUESTS_PER_MINUTE} 次，超出返回 429 且不再调用 Cloudflare`, async () => {
    const cf = fakeCloudflare();
    const f = await fixture(cf);
    const owner = await f.actor('owner');
    const site = await f.hosted(owner);
    const path = `/hosted-domains/${site.id}/dns-records`;
    // 离整分钟太近时等到下一分钟，避免计数窗口在中途切换
    const left = 60_000 - (Date.now() % 60_000);
    if (left < 8_000) await new Promise((resolve) => setTimeout(resolve, left + 50));
    for (let i = 0; i < MAX_HOSTED_DNS_REQUESTS_PER_MINUTE; i++) await data(await call('GET', path, owner.jwt));
    const calls = cf.calls.length;
    expect((await errorOf(await call('GET', path, owner.jwt), 429)).message).toBe('解析操作过于频繁，请稍后再试');
    expect((await errorOf(await call('POST', path, owner.jwt, { type: 'A', name: 'www', ttl: 1, content: '203.0.113.1' }), 429)).code)
      .toBe('rate_limited');
    expect(cf.calls).toHaveLength(calls);
    // 按用户计数，其他用户不受影响
    const admin = await f.actor('admin', 'admin');
    await data(await call('GET', path, admin.jwt));
  }, 30_000);
});

describe('Cloudflare 错误映射', () => {
  it('同名冲突 409、记录值 400、5xx 500、限流 429、记录不存在 404、zone 不可用 409', async () => {
    const cf = fakeCloudflare();
    const f = await fixture(cf);
    const owner = await f.actor('owner');
    const site = await f.hosted(owner);
    const path = `/hosted-domains/${site.id}/dns-records`;
    const input = { type: 'CNAME', name: 'www', ttl: 1, content: 'cname.vercel-dns.com' };

    cf.failNext('POST', 400, 81057);
    expect(await errorOf(await call('POST', path, owner.jwt, input), 409))
      .toEqual({ code: 'conflict', message: '已存在冲突的记录：同名下已有相同或不能共存的记录' });
    cf.failNext('POST', 400, 9005);
    expect(await errorOf(await call('POST', path, owner.jwt, input), 400))
      .toEqual({ code: 'validation_failed', message: 'Cloudflare 校验未通过：9005 injected 9005' });
    cf.failNext('POST', 500);
    expect(await errorOf(await call('POST', path, owner.jwt, input), 500))
      .toEqual({ code: 'internal', message: 'Cloudflare 暂时没有响应，请稍后重试' });
    cf.failNext('GET', 429, 10000);
    expect(await errorOf(await call('GET', path, owner.jwt), 429))
      .toEqual({ code: 'rate_limited', message: 'Cloudflare 接口繁忙，请稍后再试' });

    const created = await data<HostedDnsRecord>(await call('POST', path, owner.jwt, input), 201);
    cf.failNext('PATCH', 404, 81044);
    expect(await errorOf(await call('PUT', `${path}/${created.id}`, owner.jwt, input), 404))
      .toEqual({ code: 'not_found', message: '解析记录不存在' });
    expect(await audits(site.domain)).toEqual(['新增 CNAME www → cname.vercel-dns.com']);

    // 不存在的 zone：Cloudflare 返回 403/9109
    const gone = await f.hosted(owner, 'gone', { zoneId: 'zone-gone' });
    expect(await errorOf(await call('GET', `/hosted-domains/${gone.id}/dns-records`, owner.jwt), 409))
      .toEqual({ code: 'conflict', message: 'Cloudflare 中的域名已不可用，请联系管理员' });
  });
});
