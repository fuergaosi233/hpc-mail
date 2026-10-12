import type { MailboxShareGrant, SharedMailboxView } from '@hpc-mail/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { mailboxShares, mailboxes, users } from '../db/schema.js';
import { chunk } from '../lib/d1.js';
import { AppError } from '../lib/errors.js';
import type { Env } from '../types.js';

const MAX_GRANTEES = 100;

function assertManageableMailbox<T extends { userId: number }>(
  box: T | undefined,
  actorId: number,
  isAdmin = false,
): asserts box is T {
  if (!box || (!isAdmin && box.userId !== actorId)) {
    throw new AppError('forbidden', '只能共享自己已认领的地址');
  }
}

/** 自有或全站已认领邮箱，附带所有者与共享名单（含尚未分享的）。 */
export async function listMailboxShares(env: Env, actorId: number, all = false): Promise<MailboxShareGrant[]> {
  const db = createDb(env);
  const boxes = await db
    .select({ box: mailboxes, ownerUsername: users.username })
    .from(mailboxes)
    .innerJoin(users, eq(users.id, mailboxes.userId))
    .where(all ? undefined : eq(mailboxes.userId, actorId))
    .orderBy(asc(mailboxes.address))
    .all();
  if (boxes.length === 0) return [];

  const rows = [];
  for (const batch of chunk(boxes.map(({ box }) => box.id))) {
    const part = await db
      .select({
        mailboxId: mailboxShares.mailboxId,
        userId: mailboxShares.userId,
        username: users.username,
        status: users.status,
        grantedAt: mailboxShares.createdAt,
      })
      .from(mailboxShares)
      .innerJoin(users, eq(users.id, mailboxShares.userId))
      .where(inArray(mailboxShares.mailboxId, batch))
      .orderBy(asc(users.username))
      .all();
    rows.push(...part);
  }

  const byMailbox = new Map<number, MailboxShareGrant['grantees']>();
  for (const row of rows) {
    const list = byMailbox.get(row.mailboxId) ?? [];
    list.push({
      userId: row.userId,
      username: row.username,
      status: row.status,
      grantedAt: row.grantedAt.toISOString(),
    });
    byMailbox.set(row.mailboxId, list);
  }

  return boxes.map(({ box, ownerUsername }) => ({
    mailboxId: box.id,
    address: box.address,
    domain: box.domain,
    displayName: box.displayName,
    ownerUserId: box.userId,
    ownerUsername,
    grantees: byMailbox.get(box.id) ?? [],
  }));
}

/**
 * 整体替换一只邮箱的共享名单。
 * 所有者可管理自己的邮箱，管理员可管理任意邮箱；被分享人必须启用。
 */
export async function replaceMailboxShares(
  env: Env,
  actorId: number,
  mailboxId: number,
  userIds: number[],
  isAdmin = false,
  expectedOwnerId?: number,
): Promise<MailboxShareGrant> {
  const db = createDb(env);
  const box = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId)).get();
  assertManageableMailbox(box, actorId, isAdmin);
  if (expectedOwnerId !== undefined && box.userId !== expectedOwnerId) {
    throw new AppError('conflict', '邮箱所有者已改变，请刷新后重试');
  }

  const uniqueIds = [...new Set(userIds)];
  if (uniqueIds.length > MAX_GRANTEES) {
    throw new AppError('validation_failed', `一次最多共享给 ${MAX_GRANTEES} 个用户`);
  }
  if (uniqueIds.includes(box.userId)) {
    throw new AppError('validation_failed', '邮箱所有者已经拥有访问权限，无需共享');
  }
  if (uniqueIds.length > 0) {
    const targets = [];
    for (const batch of chunk(uniqueIds)) {
      const part = await db
        .select({ id: users.id, role: users.role, status: users.status })
        .from(users)
        .where(inArray(users.id, batch))
        .all();
      targets.push(...part);
    }
    if (targets.length !== uniqueIds.length) {
      throw new AppError('validation_failed', '包含不存在的用户');
    }
    if (targets.some((target) => target.status !== 'active')) {
      throw new AppError('validation_failed', '只能共享给启用中的用户');
    }
  }

  try {
    await env.db.batch([
      env.db.prepare(`DELETE FROM mailbox_shares WHERE mailbox_id = ?
        AND EXISTS (SELECT 1 FROM mailboxes WHERE id = ? AND user_id = ?)`).bind(mailboxId, mailboxId, box.userId),
      ...uniqueIds.map((userId) =>
        env.db
          .prepare(`INSERT INTO mailbox_shares (mailbox_id, user_id, granted_by)
          SELECT id, CASE WHEN (SELECT status FROM users WHERE id = ?) = 'active' THEN ? ELSE NULL END, ?
          FROM mailboxes WHERE id = ? AND user_id = ?`)
          .bind(userId, userId, actorId, mailboxId, box.userId),
      ),
    ]);
  } catch (error) {
    if (String(error).includes('NOT NULL constraint failed: mailbox_shares.user_id')) {
      throw new AppError('conflict', '共享用户状态已改变，请刷新后重试');
    }
    throw error;
  }
  const current = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId)).get();
  assertManageableMailbox(current, actorId, isAdmin);
  if (current.userId !== box.userId) throw new AppError('conflict', '邮箱所有者已改变，请刷新后重试');
  const owner = await db.select({ username: users.username }).from(users).where(eq(users.id, box.userId)).get();

  return {
    mailboxId: box.id,
    address: box.address,
    domain: box.domain,
    displayName: box.displayName,
    ownerUserId: box.userId,
    ownerUsername: owner!.username,
    grantees: await granteesOf(env, mailboxId),
  };
}

export async function revokeMailboxShare(
  env: Env,
  actorId: number,
  mailboxId: number,
  userId: number,
  isAdmin = false,
): Promise<void> {
  const db = createDb(env);
  const box = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId)).get();
  assertManageableMailbox(box, actorId, isAdmin);
  const result = await db
    .delete(mailboxShares)
    .where(and(eq(mailboxShares.mailboxId, mailboxId), eq(mailboxShares.userId, userId),
      sql`EXISTS (SELECT 1 FROM mailboxes WHERE id = ${mailboxId} AND user_id = ${box.userId})`))
    .run();
  if ((result.meta.changes ?? 0) === 0) throw new AppError('not_found', '该用户不在共享名单中');
}

/** 登录用户被分享、且所有者仍启用的邮箱。 */
export async function listSharedMailboxes(env: Env, userId: number): Promise<SharedMailboxView[]> {
  const db = createDb(env);
  const rows = await db
    .select({
      mailboxId: mailboxes.id,
      address: mailboxes.address,
      domain: mailboxes.domain,
      displayName: mailboxes.displayName,
      ownerUsername: users.username,
    })
    .from(mailboxShares)
    .innerJoin(mailboxes, eq(mailboxes.id, mailboxShares.mailboxId))
    .innerJoin(users, eq(users.id, mailboxes.userId))
    .where(and(eq(mailboxShares.userId, userId), eq(users.status, 'active')))
    .orderBy(asc(mailboxes.address))
    .all();
  return rows;
}

async function granteesOf(env: Env, mailboxId: number): Promise<MailboxShareGrant['grantees']> {
  const db = createDb(env);
  const rows = await db
    .select({
      userId: mailboxShares.userId,
      username: users.username,
      status: users.status,
      grantedAt: mailboxShares.createdAt,
    })
    .from(mailboxShares)
    .innerJoin(users, eq(users.id, mailboxShares.userId))
    .where(eq(mailboxShares.mailboxId, mailboxId))
    .orderBy(asc(users.username))
    .all();
  return rows.map((row) => ({
    userId: row.userId,
    username: row.username,
    status: row.status,
    grantedAt: row.grantedAt.toISOString(),
  }));
}
