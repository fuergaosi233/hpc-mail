import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { MailboxShareGrant, MessageDetail, MessageSummary, Page, SharedMailboxView } from '@hpc-mail/shared';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { adminAuditLogs, mailboxShares, mailboxes, messages, users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import { replaceMailboxShares } from '../src/services/mailbox-share.js';
import { createSession } from '../src/services/session.js';
import { updateSettings } from '../src/services/setting.js';
import type { Env } from '../src/types.js';

const app = createApp();
const db = createDb(env);
let sequence = 0;

async function fixture() {
  const prefix = `sharing-${++sequence}`;
  await updateSettings(env, { security: { require2fa: false }, api: { enabled: true } });
  async function actor(name: string, role: 'admin' | 'user' = 'user') {
    const user = (await db.insert(users).values({ username: `${prefix}-${name}`, role,
      passwordHash: 'test', authVersionMigrated: true }).returning().get())!;
    const sid = await createSession(env, user.id);
    const jwt = await signToken(env.jwt_secret, { sub: user.id, sid, epoch: 0, uepoch: 0 });
    return { ...user, jwt };
  }
  const owner = await actor('owner');
  const admin = await actor('admin', 'admin');
  const member = await actor('member');
  const stranger = await actor('stranger');
  const box = (await db.insert(mailboxes).values({ address: `${prefix}@sharing.test`,
    domain: 'sharing.test', userId: owner.id }).returning().get())!;
  const incoming = (await db.insert(messages).values({ address: box.address, domain: box.domain,
    fromAddress: 'sender@example.com', direction: 'inbound', subject: 'shared history', bodyText: 'private body',
    status: 'received', verificationCode: '123456' }).returning().get())!;
  const sent = (await db.insert(messages).values({ address: box.address, domain: box.domain,
    fromAddress: box.address, direction: 'outbound', subject: 'private sent', status: 'sent' }).returning().get())!;
  return { owner, admin, member, stranger, box, incoming, sent };
}

async function request(path: string, jwt: string, method = 'GET', body?: unknown) {
  const ctx = createExecutionContext();
  const response = await app.request(`/api${path}`, { method,
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
async function data<T>(response: Response): Promise<T> {
  const result = await response.json() as { data: T };
  expect(response.status, JSON.stringify(result)).toBe(200);
  return result.data;
}
function beforeBatch(hook: () => Promise<void>): Env {
  let called = false;
  return { ...env, db: new Proxy(env.db, { get(target, property) {
    if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
      if (!called) { called = true; await hook(); }
      return target.batch(statements);
    };
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) };
}

describe('所有者共享与管理员全站共享', () => {
  it('普通用户共享自己的邮箱给用户和管理员；成员只有来信读取权，撤销立即生效', async () => {
    const f = await fixture();
    const grant = await data<MailboxShareGrant>(await request('/mailboxes/shares', f.owner.jwt, 'PUT', {
      mailboxId: f.box.id, expectedOwnerId: f.owner.id, userIds: [f.member.id, f.admin.id],
    }));
    expect(grant).toMatchObject({ ownerUserId: f.owner.id, ownerUsername: f.owner.username });
    expect(grant.grantees).toHaveLength(2);
    const owned = await data<MailboxShareGrant[]>(await request('/mailboxes/shares', f.owner.jwt));
    expect(owned.map((item) => item.mailboxId)).toContain(f.box.id);
    for (const member of [f.member, f.admin]) {
      const shared = await data<SharedMailboxView[]>(await request('/mailboxes/shared', member.jwt));
      expect(shared.map((item) => item.mailboxId)).toContain(f.box.id);
      const inbox = await data<Page<MessageSummary>>(await request('/messages?direction=inbound', member.jwt));
      expect(inbox.items.map((item) => item.id)).toContain(f.incoming.id);
      expect(await data<MessageDetail>(await request(`/messages/${f.incoming.id}`, member.jwt))).toMatchObject({ bodyText: 'private body' });
      expect((await request(`/messages/${f.sent.id}`, member.jwt)).status).toBe(404);
      expect(await data(await request('/messages/read', member.jwt, 'POST', { ids: [f.incoming.id], isRead: true }))).toMatchObject({ changed: 0 });
    }
    expect(await data(await request('/messages/delete', f.member.jwt, 'POST', { ids: [f.incoming.id] }))).toMatchObject({ deleted: 0 });
    expect((await request(`/mailboxes/${f.box.id}`, f.member.jwt, 'PUT', { displayName: 'unauthorized' })).status).toBe(404);
    expect((await request('/mailboxes/shares', f.member.jwt, 'PUT', { mailboxId: f.box.id, userIds: [f.stranger.id] })).status).toBe(403);
    expect((await request('/admin/mailbox-shares', f.owner.jwt)).status).toBe(403);
    expect((await request(`/messages/${f.incoming.id}`, f.stranger.jwt)).status).toBe(404);
    await data(await request(`/mailboxes/shares/${f.box.id}/grantees/${f.member.id}`, f.owner.jwt, 'DELETE'));
    expect((await request(`/messages/${f.incoming.id}`, f.member.jwt)).status).toBe(404);
    await data(await request('/mailboxes/shares', f.owner.jwt, 'PUT', { mailboxId: f.box.id, userIds: [] }));
    expect((await request(`/messages/${f.incoming.id}`, f.admin.jwt)).status).toBe(404);
  });

  it('管理员可共享他人邮箱给自己和其他人，全站列表返回所有者并记录审计', async () => {
    const f = await fixture();
    const all = await data<MailboxShareGrant[]>(await request('/admin/mailbox-shares', f.admin.jwt));
    expect(all.find((item) => item.mailboxId === f.box.id)).toMatchObject({ ownerUsername: f.owner.username });
    await data(await request('/admin/mailbox-shares', f.admin.jwt, 'PUT', {
      mailboxId: f.box.id, expectedOwnerId: f.owner.id, userIds: [f.admin.id, f.member.id],
    }));
    expect((await db.select().from(mailboxes).where(eq(mailboxes.id, f.box.id)).get())!.userId).toBe(f.owner.id);
    expect(await db.select().from(adminAuditLogs).where(eq(adminAuditLogs.target, f.box.address))).toHaveLength(1);
    await data(await request(`/admin/mailbox-shares/${f.box.id}/grantees/${f.member.id}`, f.admin.jwt, 'DELETE'));
    expect((await request(`/messages/${f.incoming.id}`, f.member.jwt)).status).toBe(404);
    expect((await request('/admin/mailbox-shares', f.admin.jwt, 'PUT', {
      mailboxId: f.box.id, userIds: [f.owner.id],
    })).status).toBe(400);
    expect((await request('/admin/mailbox-shares', f.admin.jwt, 'PUT', {
      mailboxId: f.box.id, expectedOwnerId: f.member.id, userIds: [],
    })).status).toBe(409);
  });

  it('共享候选搜索仅返回必要公开字段，支持管理员并排除所有者', async () => {
    const f = await fixture();
    const result = await data<{ items: Array<Record<string, unknown>> }>(await request(
      `/mailboxes/share-users?q=sharing-${sequence}&excludeUserId=${f.owner.id}`, f.owner.jwt));
    expect(result.items.some((item) => item.id === f.admin.id)).toBe(true);
    expect(result.items.some((item) => item.id === f.owner.id)).toBe(false);
    for (const item of result.items) expect(Object.keys(item).sort()).toEqual(['id', 'role', 'username']);
    expect((await request('/mailboxes/share-users?q=', f.owner.jwt)).status).toBe(400);
  });

  it('写入边界用户被禁用时回滚整份共享名单，不丢失已有授权', async () => {
    const f = await fixture();
    await replaceMailboxShares(env, f.owner.id, f.box.id, [f.member.id]);
    const racing = beforeBatch(async () => {
      await db.update(users).set({ status: 'disabled' }).where(eq(users.id, f.stranger.id));
    });
    await expect(replaceMailboxShares(racing, f.admin.id, f.box.id, [f.stranger.id], true)).rejects.toMatchObject({ code: 'conflict' });
    expect((await db.select().from(mailboxShares).where(eq(mailboxShares.mailboxId, f.box.id))).map((row) => row.userId)).toEqual([f.member.id]);
  });

  it('管理员共享也复核写入时归属，不能覆盖并发过户后的新共享', async () => {
    const f = await fixture();
    const racing = beforeBatch(async () => {
      await db.update(mailboxes).set({ userId: f.stranger.id }).where(eq(mailboxes.id, f.box.id));
      await replaceMailboxShares(env, f.stranger.id, f.box.id, [f.member.id]);
    });
    await expect(replaceMailboxShares(racing, f.admin.id, f.box.id, [], true)).rejects.toMatchObject({ code: 'conflict' });
    expect((await db.select().from(mailboxShares).where(eq(mailboxShares.mailboxId, f.box.id))).map((row) => row.userId)).toEqual([f.member.id]);
  });
});
