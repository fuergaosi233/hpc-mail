import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { MAX_BATCH_CLAIM, type BatchClaimMailboxResult, type ClaimMailboxRequest, type Mailbox, type MailboxAvailability, type UserMailboxPolicy } from '@hpc-mail/shared';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { mailboxes, messages, users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import { checkAvailability, checkAvailabilityBatch, claimMailbox, claimMailboxes } from '../src/services/mailbox.js';
import { createSession } from '../src/services/session.js';
import { updateSettings } from '../src/services/setting.js';
import { updateUser } from '../src/services/user.js';
import type { Env } from '../src/types.js';

const app = createApp();
const db = createDb(env);
const openDomain = 'batch.test';
const limitedDomain = 'limited.batch.test';
const privateDomain = 'private.batch.test';
let sequence = 0;

async function fixture(perUserLimit = 0) {
  const prefix = `batch-${++sequence}`;
  await updateSettings(env, {
    domains: { list: [
      { domain: openDomain, public: true, perUserLimit: 0 },
      { domain: limitedDomain, public: true, perUserLimit: 1 },
      { domain: privateDomain, public: false, perUserLimit: 0 },
    ] },
    mailbox_policy: { perUserLimit, reservedLocalParts: ['admin', 'support'] },
    security: { require2fa: false }, api: { enabled: true },
  });
  async function actor(name: string, role: 'admin' | 'user' = 'user') {
    const user = (await db.insert(users).values({ username: `${prefix}-${name}`, role, passwordHash: 'test', authVersionMigrated: true }).returning().get())!;
    const sid = await createSession(env, user.id);
    return { ...user, jwt: await signToken(env.jwt_secret, { sub: user.id, sid, epoch: 0, uepoch: 0 }) };
  }
  const admin = await actor('admin', 'admin');
  const user = await actor('user');
  const other = await actor('other');
  const item = (name: string, domain = openDomain): ClaimMailboxRequest => ({ localPart: `${prefix}-${name}`, domain });
  const own = async (ownerId: number, req: ClaimMailboxRequest) =>
    (await db.insert(mailboxes).values({ userId: ownerId, domain: req.domain, address: `${req.localPart}@${req.domain}` }).returning().get())!;
  return { prefix, admin, user, other, item, own };
}

async function request(path: string, token: string, method = 'GET', body?: unknown) {
  const ctx = createExecutionContext();
  const response = await app.request(`/api${path}`, { method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
async function data<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json() as { data: T };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body.data;
}
const ownedBy = async (userId: number) => (await db.select().from(mailboxes).where(eq(mailboxes.userId, userId))).map((row) => row.address).sort();

/** 统计 D1 往返：每次 batch 与每条单独执行的语句各算一次 */
function counting(hook?: (sql: string) => Promise<void>): { env: Env; trips: () => number } {
  let trips = 0;
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(statement, {
    get(target, property) {
      if (property === 'bind') return (...args: unknown[]) => wrap(target.bind(...args), sql);
      const method = Reflect.get(target, property);
      if (typeof method !== 'function') return method;
      return async (...args: unknown[]) => {
        if (['first', 'all', 'run', 'raw'].includes(String(property))) { trips++; await hook?.(sql); }
        return method.apply(target, args);
      };
    },
  });
  const wrapped = { ...env, db: new Proxy(env.db, { get(target, property) {
    if (property === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
    if (property === 'batch') return async (statements: D1PreparedStatement[]) => { trips++; return target.batch(statements); };
    const method = Reflect.get(target, property);
    return typeof method === 'function' ? method.bind(target) : method;
  } }) } as Env;
  return { env: wrapped, trips: () => trips };
}

describe('批量认领', () => {
  it('按顺序逐个认领：被占用（含本批重复）的跳过并继续，认领结果与单个认领同形', async () => {
    const f = await fixture();
    const taken = f.item('taken');
    await f.own(f.other.id, taken);
    const history = f.item('history');
    for (const subject of ['old 1', 'old 2']) {
      await db.insert(messages).values({ address: `${history.localPart}@${history.domain}`, domain: openDomain, direction: 'inbound', status: 'received', subject });
    }
    const first = f.item('first');
    const result = await data<BatchClaimMailboxResult>(await request('/mailboxes/batch', f.user.jwt, 'POST', { items: [first, taken, history, first] }));
    expect(result.claimed.map((box) => box.address)).toEqual([`${first.localPart}@${openDomain}`, `${history.localPart}@${openDomain}`]);
    expect(result.claimed.map((box) => box.messageCount)).toEqual([0, 2]);
    expect(result).toMatchObject({ taken: [taken, first], notAttempted: [], stoppedBy: null });
    // 与 GET /mailboxes（单个认领后读回的同一形状）逐字段一致
    const listed = await data<Mailbox[]>(await request('/mailboxes', f.user.jwt));
    for (const box of result.claimed) expect(box).toEqual(listed.find((entry) => entry.id === box.id));
    const single = await data<Mailbox>(await request('/mailboxes', f.user.jwt, 'POST', f.item('single')), 201);
    expect(Object.keys(result.claimed[0]!).sort()).toEqual(Object.keys(single).sort());
  });

  it('配额中途用尽立即停止：已认领的保留，触发项及其后各项进入 notAttempted', async () => {
    const f = await fixture(2);
    const takenLater = f.item('taken-later');
    await f.own(f.admin.id, takenLater);
    const items = [f.item('a'), f.item('b'), f.item('over'), takenLater];
    const result = await claimMailboxes(env, f.user.id, 'user', items);
    expect(result.claimed.map((box) => box.address)).toEqual([`${f.prefix}-a@${openDomain}`, `${f.prefix}-b@${openDomain}`]);
    expect(result).toMatchObject({ taken: [], notAttempted: items.slice(2), stoppedBy: { code: 'forbidden', message: '认领地址数已达上限（2）' } });
    expect(await ownedBy(f.user.id)).toEqual([`${f.prefix}-a@${openDomain}`, `${f.prefix}-b@${openDomain}`]);
    // 按域上限同样按本批已认领数累计
    const domainItems = [f.item('l1', limitedDomain), f.item('l2', limitedDomain)];
    const limited = await claimMailboxes(env, f.other.id, 'user', domainItems);
    expect(limited).toMatchObject({ notAttempted: [domainItems[1]], stoppedBy: { code: 'forbidden', message: '在该域名下最多认领 1 个地址' } });
    expect(limited.claimed).toHaveLength(1);
  });

  it('专属权限按域额度在批内累计；空白名单与系统域名外的地址停止并给出原因', async () => {
    const f = await fixture();
    const policy: UserMailboxPolicy = { perUserLimit: 0, domains: [{ domain: privateDomain, perUserLimit: 2 }] };
    await updateUser(env, f.admin.id, f.user.id, { mailboxPolicy: policy, expectedMailboxPolicyRevision: 0 });
    const items = [f.item('p1', privateDomain), f.item('p2', privateDomain), f.item('p3', privateDomain)];
    const result = await claimMailboxes(env, f.user.id, 'user', items);
    expect(result.claimed).toHaveLength(2);
    expect(result).toMatchObject({ notAttempted: [items[2]], stoppedBy: { code: 'forbidden', message: '在该域名下最多认领 2 个地址' } });
    const outside = await claimMailboxes(env, f.other.id, 'user', [f.item('x', privateDomain)]);
    expect(outside.stoppedBy).toEqual({ code: 'forbidden', message: '当前用户无权认领该域名' });
    const unknown = await claimMailboxes(env, f.other.id, 'user', [f.item('ok'), f.item('x', 'unknown.batch.test')]);
    expect(unknown.claimed).toHaveLength(1);
    expect(unknown.stoppedBy).toEqual({ code: 'validation_failed', message: '域名不在系统域名列表内' });
  });

  it('普通用户受保留前缀与额度限制，管理员豁免并可认领私有域', async () => {
    const f = await fixture(1);
    const reserved = { localPart: 'support', domain: privateDomain };
    const items = [{ localPart: 'admin', domain: openDomain }, reserved, f.item('a'), f.item('b')];
    const blocked = await data<BatchClaimMailboxResult>(await request('/mailboxes/batch', f.user.jwt, 'POST', { items }));
    expect(blocked).toMatchObject({ claimed: [], taken: [], notAttempted: items, stoppedBy: { code: 'forbidden', message: '前缀 admin 为系统保留，无法认领' } });
    const admin = await data<BatchClaimMailboxResult>(await request('/mailboxes/batch', f.admin.jwt, 'POST', { items }));
    // 'admin@batch.test' 与 'support@private.batch.test' 在共享存储里可能已被别的用例认领，计入 taken 也合法
    expect([...admin.claimed.map((box) => box.address), ...admin.taken.map((req) => `${req.localPart}@${req.domain}`)].sort())
      .toEqual(items.map((req) => `${req.localPart}@${req.domain}`).sort());
    expect(admin).toMatchObject({ notAttempted: [], stoppedBy: null });
  });

  it('写入前域名配置改变：停止为 conflict，之前认领的保留', async () => {
    const f = await fixture();
    let inserts = 0;
    const racing = counting(async (sql) => {
      if (/INSERT INTO mailboxes/i.test(sql) && ++inserts === 2) {
        await updateSettings(env, { domains: { list: [{ domain: openDomain, public: true, perUserLimit: 0 }] } });
      }
    });
    const items = [f.item('a'), f.item('b'), f.item('c')];
    const result = await claimMailboxes(racing.env, f.user.id, 'user', items);
    expect(result.claimed.map((box) => box.address)).toEqual([`${f.prefix}-a@${openDomain}`]);
    expect(result).toMatchObject({ taken: [], notAttempted: items.slice(1), stoppedBy: { code: 'conflict', message: '域名配置已改变，请刷新后重试' } });
    expect(await ownedBy(f.user.id)).toEqual([`${f.prefix}-a@${openDomain}`]);
  });

  it('并发批量认领不能突破全局额度', async () => {
    const f = await fixture(2);
    const attempts = await Promise.all([0, 1].map((n) => claimMailboxes(env, f.user.id, 'user', [f.item(`${n}-a`), f.item(`${n}-b`)])));
    expect(attempts.reduce((sum, result) => sum + result.claimed.length, 0)).toBe(2);
    expect(await ownedBy(f.user.id)).toHaveLength(2);
    for (const result of attempts.filter((entry) => entry.stoppedBy)) expect(result.stoppedBy!.code).toBe('forbidden');
  });

  it('非法请求体返回 400', async () => {
    const f = await fixture();
    const tooMany = Array.from({ length: MAX_BATCH_CLAIM + 1 }, (_, index) => f.item(`n${index}`));
    for (const path of ['/mailboxes/batch', '/mailboxes/availability/batch']) {
      for (const body of [{ items: [] }, { items: tooMany }, { items: [{ localPart: 'Bad Name', domain: openDomain }] }, {}]) {
        expect((await request(path, f.user.jwt, 'POST', body)).status).toBe(400);
      }
    }
    expect(await ownedBy(f.user.id)).toEqual([]);
  });
});

describe('批量可用性', () => {
  it('逐项结果与 GET /availability 一致并保持请求顺序（普通用户与管理员）', async () => {
    const f = await fixture(3);
    const taken = f.item('taken');
    await f.own(f.other.id, taken);
    await f.own(f.user.id, f.item('owned', limitedDomain));
    for (let index = 0; index < 3; index++) await f.own(f.other.id, f.item(`full${index}`, privateDomain));
    const items: ClaimMailboxRequest[] = [
      f.item('free'), taken, { localPart: 'admin', domain: openDomain }, f.item('more', limitedDomain),
      f.item('private', privateDomain), f.item('unknown', 'unknown.batch.test'), f.item('free'),
    ];
    for (const actor of [f.user, f.other, f.admin]) {
      const batch = await data<MailboxAvailability[]>(await request('/mailboxes/availability/batch', actor.jwt, 'POST', { items }));
      const single: MailboxAvailability[] = [];
      for (const req of items) {
        single.push(await data<MailboxAvailability>(await request(`/mailboxes/availability?localPart=${req.localPart}&domain=${req.domain}`, actor.jwt)));
      }
      expect(batch).toEqual(single);
    }
    // 三种身份覆盖到每一种 reason
    const reasons = new Set<string>();
    for (const actor of [f.user, f.other]) {
      for (const result of await checkAvailabilityBatch(env, { userId: actor.id, role: 'user' }, items)) reasons.add(result.reason ?? 'available');
    }
    expect([...reasons].sort()).toEqual(['available', 'domain_limit', 'domain_unavailable', 'quota', 'reserved', 'taken']);
  });
});

describe('认领与可用性的 D1 往返', () => {
  it('单个认领成功 2 次、守卫失败 3 次，单个与批量可用性各 1 次，20 个批量认领 21 次', async () => {
    const f = await fixture();
    let probe = counting();
    await claimMailbox(probe.env, f.user.id, 'user', f.item('one'));
    expect(probe.trips()).toBe(2);

    probe = counting();
    await checkAvailability(probe.env, { userId: f.user.id, role: 'user' }, `${f.prefix}-two`, openDomain);
    expect(probe.trips()).toBe(1);

    const items = Array.from({ length: MAX_BATCH_CLAIM }, (_, index) => f.item(`many${index}`));
    probe = counting();
    expect(await checkAvailabilityBatch(probe.env, { userId: f.user.id, role: 'user' }, items)).toHaveLength(MAX_BATCH_CLAIM);
    expect(probe.trips()).toBe(1);

    probe = counting();
    const result = await claimMailboxes(probe.env, f.user.id, 'user', items);
    expect(result.claimed).toHaveLength(MAX_BATCH_CLAIM);
    expect(probe.trips()).toBe(1 + MAX_BATCH_CLAIM);

    // 并发认领在写入前占满按域额度：守卫拒绝，再读一次判定为并发用尽
    probe = counting(async (sql) => {
      if (/INSERT INTO mailboxes/i.test(sql)) await f.own(f.other.id, f.item('race', limitedDomain));
    });
    await expect(claimMailbox(probe.env, f.other.id, 'user', f.item('late', limitedDomain)))
      .rejects.toMatchObject({ code: 'forbidden', message: '认领配额已在并发请求中用尽，请刷新后重试' });
    expect(probe.trips()).toBe(3);
  });
});
