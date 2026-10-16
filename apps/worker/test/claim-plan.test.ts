import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ClaimPlan, ClaimPlanItem, DomainClaudeStats, DomainEntry } from '@hpc-mail/shared';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { claudeAddressFacts, mailboxes, users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import { allocateLowRisk, allocateUniform, domainRisk, planRandomDomains, type PlanCandidate } from '../src/services/claim-plan.js';
import { createSession } from '../src/services/session.js';
import { updateSettings } from '../src/services/setting.js';
import type { Env } from '../src/types.js';

const app = createApp();
const db = createDb(env);
const DAY = 24 * 60 * 60 * 1000;
let sequence = 0;

const tally = (items: ClaimPlanItem[]) =>
  items.reduce<Record<string, number>>((acc, item) => ({ ...acc, [item.domain]: (acc[item.domain] ?? 0) + 1 }), {});
const candidate = (domain: string, suspended: number, load: number, remaining = Infinity): PlanCandidate => ({ domain, suspended, load, remaining });
const first = () => 0;

describe('分配算法', () => {
  it('Claude 低风险：先用封号最少的后缀，并把负载拉平；平局交给随机源', () => {
    const items = allocateLowRisk([candidate('a', 0, 0), candidate('b', 0, 1), candidate('c', 0, 2), candidate('risky', 1, 0)], 6, first);
    expect(tally(items)).toEqual({ a: 3, b: 2, c: 1 });
    expect(items.every((item) => item.suspended === 0)).toBe(true);
    // 前两个必然给负载最低的 a，第三个起与 b 打平
    expect(items.slice(0, 2).map((item) => item.domain)).toEqual(['a', 'a']);
  });

  it('0 封号后缀额度用完才分到有封号记录的后缀，并带上封号数', () => {
    const items = allocateLowRisk([candidate('safe', 0, 5, 2), candidate('one', 1, 0), candidate('two', 2, 0)], 4, first);
    expect(items).toEqual([
      { domain: 'safe', suspended: 0 }, { domain: 'safe', suspended: 0 }, { domain: 'one', suspended: 1 }, { domain: 'one', suspended: 1 },
    ]);
  });

  it('均匀随机只在还有额度的后缀里选，额度耗尽就停', () => {
    const items = allocateUniform([candidate('a', 0, 0, 1), candidate('b', 3, 0, 0), candidate('c', 0, 0, 2)], 5, first);
    expect(tally(items)).toEqual({ a: 1, c: 2 });
  });

  it('全军覆没与付费被封阈值', () => {
    const base = { accounts: 0, suspended: 0, paid: 0, paidSuspended: 0, pending: 0 };
    expect(domainRisk(base, 2)).toBeNull();
    expect(domainRisk({ ...base, accounts: 3, suspended: 3 }, 2)).toBe('wiped');
    expect(domainRisk({ ...base, accounts: 5, suspended: 4, paid: 2, paidSuspended: 2 }, 0)).toBe('wiped');
    expect(domainRisk({ ...base, accounts: 5, suspended: 4, paid: 3, paidSuspended: 2 }, 2)).toBe('paid_suspended');
    expect(domainRisk({ ...base, accounts: 5, suspended: 4, paid: 3, paidSuspended: 2 }, 0)).toBeNull();
  });
});

async function fixture(entries: Omit<DomainEntry, 'domain'>[], claimRandom = { paidSuspendedLimit: 2, pendingDays: 7 }, perUserLimit = 0) {
  const prefix = `plan${++sequence}`;
  const domains = entries.map((_, index) => `${prefix}-d${index}.test`);
  await updateSettings(env, {
    domains: { list: entries.map((entry, index) => ({ domain: domains[index]!, ...entry })) },
    mailbox_policy: { perUserLimit, reservedLocalParts: [] },
    claim_random: claimRandom,
    security: { require2fa: false },
  });
  async function actor(name: string, role: 'admin' | 'user' = 'user') {
    const user = (await db.insert(users).values({ username: `${prefix}-${name}`, role, passwordHash: 'test', authVersionMigrated: true }).returning().get())!;
    const sid = await createSession(env, user.id);
    return { ...user, jwt: await signToken(env.jwt_secret, { sub: user.id, sid, epoch: 0, uepoch: 0 }) };
  }
  /** 在第 index 个域名下写入 n 个地址事实 */
  async function facts(index: number, n: number, flags: { suspended?: boolean; paid?: boolean } = {}) {
    for (let i = 0; i < n; i++) {
      await db.insert(claudeAddressFacts).values({
        address: `${prefix}-${index}-${i}-${flags.suspended ? 's' : ''}${flags.paid ? 'p' : ''}@${domains[index]}`, domain: domains[index]!,
        paid: flags.paid ?? false, suspended: flags.suspended ?? false, firstSeenAt: new Date(),
      });
    }
  }
  return { prefix, domains, admin: await actor('admin', 'admin'), user: await actor('user'), actor, facts };
}

async function request(path: string, token: string) {
  const ctx = createExecutionContext();
  const response = await app.request(`/api${path}`, { headers: { Authorization: `Bearer ${token}` } }, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
async function plan(token: string, count: number, strategy: string, status = 200): Promise<ClaimPlan> {
  const response = await request(`/mailboxes/random-plan?count=${count}&strategy=${strategy}`, token);
  const body = await response.json() as { data: ClaimPlan };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body.data;
}

describe('GET /api/mailboxes/random-plan', () => {
  it('Claude 低风险：排除全军覆没与付费被封达阈值，按封号数再按账号数均衡', async () => {
    const f = await fixture(Array.from({ length: 5 }, () => ({ public: false, perUserLimit: 0 })));
    await f.facts(0, 1);                                   // d0：1 个账号，无封号
    await f.facts(1, 2, { suspended: true });             // d1：全军覆没
    await f.facts(2, 3, { paid: true });
    await f.facts(2, 2, { paid: true, suspended: true }); // d2：付费被封 2，达到阈值
    await f.facts(3, 2);
    await f.facts(3, 1, { suspended: true });             // d3：有 1 个封号
    // d4：没有任何记录
    const result = await plan(f.admin.jwt, 3, 'claude');
    expect(result).toMatchObject({ strategy: 'claude', shortfall: 0, reason: null });
    // 只用 0 封号的 d0（负载 1）与 d4（负载 0），分完负载都是 2
    expect(tally(result.items)).toEqual({ [f.domains[0]!]: 1, [f.domains[4]!]: 2 });
    expect(result.pool.sort()).toEqual([...f.domains].sort());
    // 0 封号后缀额度不限时，有封号记录的后缀一个都不分
    expect((await plan(f.admin.jwt, 20, 'claude')).items.every((item) => item.suspended === 0)).toBe(true);

    // 只留 d2 参与随机：阈值为 2 时被排除，阈值为 0 时可分配并带上封号数
    const onlyD2 = f.domains.map((domain, index) => ({ domain, public: false, perUserLimit: 0, random: index === 2 }));
    await updateSettings(env, { domains: { list: onlyD2 } });
    expect(await plan(f.admin.jwt, 2, 'claude')).toMatchObject({ items: [], shortfall: 2, reason: 'no_candidates' });
    await updateSettings(env, { claim_random: { paidSuspendedLimit: 0, pendingDays: 7 } });
    expect((await plan(f.admin.jwt, 2, 'claude')).items).toEqual([
      { domain: f.domains[2], suspended: 2 }, { domain: f.domains[2], suspended: 2 },
    ]);
  });

  it('不参与随机的域名两种模式都不出现，全军覆没只在 Claude 模式排除', async () => {
    const f = await fixture([{ public: true, perUserLimit: 0 }, { public: true, perUserLimit: 0, random: false }, { public: true, perUserLimit: 0 }]);
    await f.facts(2, 1, { suspended: true });
    for (const strategy of ['uniform', 'claude']) {
      const result = await plan(f.user.jwt, 10, strategy);
      expect(result.pool.sort()).toEqual([f.domains[0], f.domains[2]].sort());
      expect(result.items.map((item) => item.domain)).not.toContain(f.domains[1]);
    }
    expect(new Set((await plan(f.user.jwt, 10, 'claude')).items.map((item) => item.domain))).toEqual(new Set([f.domains[0]]));
  });

  it('普通用户只拿到可认领的域名，按每域与全局剩余额度裁剪并说明原因', async () => {
    const f = await fixture([{ public: true, perUserLimit: 2 }, { public: true, perUserLimit: 1 }, { public: false, perUserLimit: 0 }], undefined, 4);
    await db.insert(mailboxes).values({ userId: f.user.id, domain: f.domains[1]!, address: `owned@${f.domains[1]}` });
    const result = await plan(f.user.jwt, 5, 'claude');
    expect(result.pool).toEqual([f.domains[0]]);
    expect(tally(result.items)).toEqual({ [f.domains[0]!]: 2 });
    expect(result).toMatchObject({ shortfall: 3, reason: 'quota' });

    const g = await fixture([{ public: true, perUserLimit: 0 }]);
    await g.facts(0, 2, { suspended: true });
    expect(await plan(g.user.jwt, 3, 'claude')).toMatchObject({ items: [], shortfall: 3, reason: 'no_candidates' });
    expect((await plan(g.user.jwt, 3, 'uniform')).items).toHaveLength(3);
  });

  it('近 pendingDays 天认领、还没收到 Claude 来信的邮箱计入负载', async () => {
    const f = await fixture([{ public: false, perUserLimit: 0 }, { public: false, perUserLimit: 0 }], { paidSuspendedLimit: 2, pendingDays: 7 });
    const other = await f.actor('other');
    for (let i = 0; i < 3; i++) await db.insert(mailboxes).values({ userId: other.id, domain: f.domains[0]!, address: `p${i}@${f.domains[0]}` });
    await db.insert(mailboxes).values({ userId: other.id, domain: f.domains[1]!, address: `old@${f.domains[1]}`, createdAt: new Date(Date.now() - 30 * DAY) });
    expect(tally((await plan(f.admin.jwt, 3, 'claude')).items)).toEqual({ [f.domains[1]!]: 3 });

    await updateSettings(env, { claim_random: { paidSuspendedLimit: 2, pendingDays: 0 } });
    const items = (await plan(f.admin.jwt, 4, 'claude')).items;
    expect(tally(items)).toEqual({ [f.domains[0]!]: 2, [f.domains[1]!]: 2 });
  });

  it('参数校验', async () => {
    const f = await fixture([{ public: true, perUserLimit: 0 }]);
    for (const query of ['count=0&strategy=claude', 'count=21&strategy=claude', 'count=3&strategy=all', 'strategy=claude']) {
      expect((await request(`/mailboxes/random-plan?${query}`, f.user.jwt)).status, query).toBe(400);
    }
  });

  it('规则、权限、额度与后缀统计一次 D1 batch 读齐', async () => {
    const f = await fixture([{ public: true, perUserLimit: 0 }]);
    let batches = 0;
    let single = 0;
    const counted = { ...env, db: new Proxy(env.db, { get(target, property) {
      if (property === 'batch') return (statements: D1PreparedStatement[]) => { batches++; return target.batch(statements); };
      if (property === 'prepare') return (query: string) => new Proxy(target.prepare(query), { get(statement, key) {
        const value = Reflect.get(statement, key);
        if (['first', 'all', 'run', 'raw'].includes(String(key))) single++;
        return typeof value === 'function' ? value.bind(statement) : value;
      } });
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) } as Env;
    await planRandomDomains(counted, { userId: f.user.id, role: 'user' }, 5, 'claude');
    expect({ batches, single }).toEqual({ batches: 1, single: 0 });
  });
});

describe('GET /api/admin/settings/domain-claude-stats', () => {
  it('按域名列表顺序返回四个数、未注册数与排除原因；普通用户无权访问', async () => {
    const f = await fixture([{ public: true, perUserLimit: 0 }, { public: false, perUserLimit: 0 }, { public: false, perUserLimit: 0 }]);
    await f.facts(0, 2, { suspended: true });
    await f.facts(1, 3, { paid: true });
    await f.facts(1, 2, { paid: true, suspended: true });
    await db.insert(mailboxes).values({ userId: f.user.id, domain: f.domains[2]!, address: `pending@${f.domains[2]}` });
    const response = await request('/admin/settings/domain-claude-stats', f.admin.jwt);
    const stats = (await response.json() as { data: DomainClaudeStats[] }).data;
    expect(response.status).toBe(200);
    expect(stats).toEqual([
      { domain: f.domains[0], accounts: 2, suspended: 2, paid: 0, paidSuspended: 0, pending: 0, risk: 'wiped' },
      { domain: f.domains[1], accounts: 5, suspended: 2, paid: 5, paidSuspended: 2, pending: 0, risk: 'paid_suspended' },
      { domain: f.domains[2], accounts: 0, suspended: 0, paid: 0, paidSuspended: 0, pending: 1, risk: null },
    ]);
    expect((await request('/admin/settings/domain-claude-stats', f.user.jwt)).status).toBe(403);
  });
});
