import { DEFAULT_SETTINGS, SETTING_SCHEMAS, userMailboxPolicySchema, type Settings, type UserMailboxPolicy } from '@hpc-mail/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { users } from '../db/schema.js';
import { AppError } from '../lib/errors.js';

export type MailboxPolicyUser = Pick<typeof users.$inferSelect, 'id' | 'role' | 'status' | 'mailboxPolicy' | 'mailboxPolicyRevision'>;

/** 认领规则只依赖这两项设置 */
export type ClaimSettings = Pick<Settings, 'domains' | 'mailbox_policy'>;

export interface EffectiveMailboxPolicy {
  perUserLimit: number;
  domains: UserMailboxPolicy['domains'];
  reservedLocalParts: string[];
}

/** 唯一的权限解析：专属配置替代公共域名及额度，但仍需域名存在于系统中。 */
export function resolveMailboxPolicy(settings: ClaimSettings, user: MailboxPolicyUser): EffectiveMailboxPolicy {
  if (user.role === 'admin') {
    return { perUserLimit: 0, domains: settings.domains.list.map(({ domain }) => ({ domain, perUserLimit: 0 })), reservedLocalParts: [] };
  }
  if (user.mailboxPolicy !== null) {
    const parsed = userMailboxPolicySchema.safeParse(user.mailboxPolicy);
    // 存储损坏不能降级成更宽松的公共权限。
    if (!parsed.success) throw new AppError('internal', '邮箱权限配置无效，请联系管理员');
    const configured = new Set(settings.domains.list.map(({ domain }) => domain));
    return { ...parsed.data, domains: parsed.data.domains.filter(({ domain }) => configured.has(domain)),
      reservedLocalParts: settings.mailbox_policy.reservedLocalParts };
  }
  return { perUserLimit: settings.mailbox_policy.perUserLimit,
    domains: settings.domains.list.filter((entry) => entry.public).map(({ domain, perUserLimit }) => ({ domain, perUserLimit })),
    reservedLocalParts: settings.mailbox_policy.reservedLocalParts };
}

export async function loadMailboxPolicyUser(db: Db, userId: number): Promise<MailboxPolicyUser> {
  const user = await db.select({ id: users.id, role: users.role, status: users.status,
    mailboxPolicy: users.mailboxPolicy, mailboxPolicyRevision: users.mailboxPolicyRevision })
    .from(users).where(eq(users.id, userId)).get();
  return assertActivePolicyUser(user);
}

function assertActivePolicyUser(user: MailboxPolicyUser | undefined): MailboxPolicyUser {
  if (!user) throw new AppError('not_found', '用户不存在');
  if (user.status !== 'active') throw new AppError('user_disabled', '用户已被禁用');
  return user;
}

// ---- 合并进 D1 batch 的读取：与上面两处读取同一份字段与校验，只是把往返交给调用方合并 ----

interface PolicyUserRow {
  id: number;
  role: MailboxPolicyUser['role'];
  status: MailboxPolicyUser['status'];
  mailbox_policy: string | null;
  mailbox_policy_revision: number;
}

/** 与 loadMailboxPolicyUser 读取同一行 */
export function mailboxPolicyUserStatement(db: D1Database, userId: number): D1PreparedStatement {
  return db.prepare('SELECT id, role, status, mailbox_policy, mailbox_policy_revision FROM users WHERE id = ?').bind(userId);
}

/** 用户缺失/禁用的报错与 loadMailboxPolicyUser 一致 */
export function mailboxPolicyUserFromResult(result: D1Result | undefined): MailboxPolicyUser {
  const row = result?.results?.[0] as PolicyUserRow | undefined;
  return assertActivePolicyUser(row && {
    id: Number(row.id),
    role: row.role,
    status: row.status,
    mailboxPolicy: row.mailbox_policy === null ? null : JSON.parse(row.mailbox_policy) as UserMailboxPolicy,
    mailboxPolicyRevision: Number(row.mailbox_policy_revision),
  });
}

/** 直读 D1 的认领设置（强一致，等价于 getSettingsFresh 的这两项） */
export function claimSettingsStatement(db: D1Database): D1PreparedStatement {
  return db.prepare(`SELECT key, value FROM settings WHERE key IN ('domains', 'mailbox_policy')`);
}

/** 解析语义与 getSettingsFresh 相同：逐 key safeParse，缺失或非法回落默认值 */
export function claimSettingsFromResult(result: D1Result | undefined): ClaimSettings {
  const stored = new Map(((result?.results ?? []) as { key: string; value: string }[]).map((row) => [row.key, row.value]));
  const read = <K extends keyof ClaimSettings>(key: K): ClaimSettings[K] => {
    const raw = stored.get(key);
    if (raw === undefined) return DEFAULT_SETTINGS[key];
    try {
      const parsed = SETTING_SCHEMAS[key].safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data as ClaimSettings[K] : DEFAULT_SETTINGS[key];
    } catch {
      return DEFAULT_SETTINGS[key];
    }
  };
  return { domains: read('domains'), mailbox_policy: read('mailbox_policy') };
}
