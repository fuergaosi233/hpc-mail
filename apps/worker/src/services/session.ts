import { and, eq, sql } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { sessions, users } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import type { Env, ExecCtx } from '../types.js';

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const sessKey = (sid: string) => `sess:${sid}`;
const uepochKey = (userId: number) => `uepoch:${userId}`;
const INSTANCE_EPOCH_KEY = 'instance_epoch';

/**
 * KV 兼容镜像（KV 不是鉴权真源）：有 ctx 时交给 waitUntil，不阻塞响应；无 ctx（单测直调）时 await。
 * 失败都只记日志，不影响主流程。
 */
async function mirrorToKv(ctx: ExecCtx | null | undefined, label: string, task: () => Promise<unknown>): Promise<void> {
  const guarded = (async () => {
    try {
      await task();
    } catch (e) {
      console.error(label, e);
    }
  })();
  if (ctx) ctx.waitUntil(guarded);
  else await guarded;
}

/** 创建会话：D1 是鉴权真源；KV 过渡期双写，确保回滚旧 Worker 时新会话仍可用。 */
export async function createSession(env: Env, userId: number, verified?: {
  authVersion: number; passwordHash: string; totpEnabledAt?: Date | null; totpSecret?: string | null;
}, ctx?: ExecCtx | null): Promise<string> {
  const sid = crypto.randomUUID();
  const now = Date.now();
  const db = createDb(env);
  if (verified) {
    const inserted = await env.db.prepare(`INSERT INTO sessions (id, user_id, created_at, expires_at)
      SELECT ?, id, ?, ? FROM users
      WHERE id = ? AND status = 'active' AND auth_version = ? AND password_hash = ?
        AND totp_enabled_at IS ? AND totp_secret IS ? RETURNING id`)
      .bind(sid, now, now + SESSION_TTL_SECONDS * 1000, userId, verified.authVersion, verified.passwordHash,
        verified.totpEnabledAt?.getTime() ?? null, verified.totpSecret ?? null)
      .first<{ id: string }>();
    if (!inserted) throw new AppError('bad_credentials', '账号凭据已改变，请重新登录');
  } else {
    await db.insert(sessions).values({ id: sid, userId, createdAt: new Date(now), expiresAt: new Date(now + SESSION_TTL_SECONDS * 1000) });
  }
  await mirrorToKv(ctx, '会话 KV 兼容写入失败:', () => env.kv.put(sessKey(sid), JSON.stringify({ userId, createdAt: now }), {
    expirationTtl: SESSION_TTL_SECONDS,
  }));
  return sid;
}

/**
 * 会话只认 D1：必须存在、未撤销、未过期，且归属于令牌声明的用户。
 * 不再从 KV 惰性迁入——换库时，旧库切换窗口里签发的令牌曾借此在新库落到同 id 的另一个用户上（2026-10-11 串号事故）。
 */
export async function sessionValidFor(env: Env, sid: string, userId: number): Promise<boolean> {
  const db = createDb(env);
  const row = await db.select().from(sessions).where(eq(sessions.id, sid)).get();
  return !!row && row.userId === userId && row.revokedAt === null && row.expiresAt.getTime() > Date.now();
}

export async function destroySession(env: Env, sid: string, ctx?: ExecCtx | null): Promise<void> {
  const db = createDb(env);
  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sid));
  await mirrorToKv(ctx, '会话 KV 兼容删除失败:', () => env.kv.delete(sessKey(sid)));
}

/** 用户代：D1 强一致；缺省视为 0。 */
export async function getUserEpoch(env: Env, userId: number): Promise<number> {
  const db = createDb(env);
  const row = await db
    .select({ authVersion: users.authVersion, migrated: users.authVersionMigrated })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  if (!row) return 0;
  if (row.migrated) return row.authVersion;
  // 升级兼容：旧版本可能已在 KV 中把用户版本 bump 到非零，首次读取时迁入 D1。
  let legacy = 0;
  try {
    legacy = Number(await env.kv.get(uepochKey(userId))) || 0;
  } catch {
    // 新用户默认版本为 0；KV 仅用于升级兼容，故障不能阻断正常鉴权。
  }
  await db
    .update(users)
    .set({ authVersion: Math.max(row.authVersion, legacy), authVersionMigrated: true })
    .where(and(eq(users.id, userId), eq(users.authVersionMigrated, false), eq(users.authVersion, row.authVersion)));
  const current = await db.select({ version: users.authVersion }).from(users).where(eq(users.id, userId)).get();
  return current?.version ?? 0;
}

export async function bumpUserEpoch(env: Env, userId: number, ctx?: ExecCtx | null): Promise<number> {
  const db = createDb(env);
  const updated = await db
    .update(users)
    .set({ authVersion: sql`${users.authVersion} + 1`, authVersionMigrated: true })
    .where(eq(users.id, userId))
    .returning({ authVersion: users.authVersion })
    .get();
  const next = updated?.authVersion ?? ((Number(await env.kv.get(uepochKey(userId))) || 0) + 1);
  await mirrorUserEpoch(env, userId, next, ctx);
  return next;
}

/** 用户鉴权版本的 KV 兼容镜像（D1 是真源） */
export async function mirrorUserEpoch(env: Env, userId: number, next: number, ctx?: ExecCtx | null): Promise<void> {
  await mirrorToKv(ctx, '用户鉴权版本 KV 兼容写入失败:', () => env.kv.put(uepochKey(userId), String(next)));
}

/** 实例代（清库全员下线）；缺省视为 0 */
export async function getInstanceEpoch(env: Env): Promise<number> {
  const v = await env.kv.get(INSTANCE_EPOCH_KEY);
  return v ? Number(v) || 0 : 0;
}

export { SESSION_TTL_SECONDS };
