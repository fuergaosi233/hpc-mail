import type {
  BatchClaimMailboxResult, ClaimMailboxRequest, Mailbox, MailboxAvailability, MailboxTransferResult, MailboxUnavailableReason, Role,
  TransferMailboxRequest,
} from '@hpc-mail/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { mailboxes, messages, users } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import type { AuthUser, Env, ExecCtx } from '../types.js';
import {
  claimSettingsStatement, mailboxPolicyUserFromResult, mailboxPolicyUserStatement, resolveMailboxPolicy,
  type ClaimSettings, type MailboxPolicyUser,
} from './mailbox-policy.js';
import { getSettingsFresh, mergeSettingRows } from './setting.js';
import { PURGE_MESSAGES_INDEX, purgeStatements } from './message-lifecycle.js';
import { scheduleStorageCleanup } from './storage-cleanup.js';

type MailboxRow = typeof mailboxes.$inferSelect;

const messageCountSql = sql<number>`(SELECT COUNT(*) FROM messages WHERE messages.address = mailboxes.address)`;

function serialize(row: MailboxRow, messageCount: number, ownerUsername?: string): Mailbox {
  return {
    id: row.id,
    address: row.address,
    domain: row.domain,
    userId: row.userId,
    displayName: row.displayName,
    messageCount,
    createdAt: row.createdAt.toISOString(),
    ...(ownerUsername !== undefined ? { ownerUsername } : {}),
  };
}

export async function listMailboxes(
  env: Env,
  opts: { userId?: number; all?: boolean },
): Promise<Mailbox[]> {
  const db = createDb(env);
  if (opts.all) {
    const rows = await db
      .select({ mailbox: mailboxes, username: users.username, messageCount: messageCountSql })
      .from(mailboxes)
      .leftJoin(users, eq(users.id, mailboxes.userId))
      .orderBy(desc(mailboxes.id))
      .all();
    return rows.map((r) => serialize(r.mailbox, Number(r.messageCount), r.username ?? ''));
  }
  const rows = await db
    .select({ mailbox: mailboxes, messageCount: messageCountSql })
    .from(mailboxes)
    .where(eq(mailboxes.userId, opts.userId!))
    .orderBy(desc(mailboxes.id))
    .all();
  return rows.map((r) => serialize(r.mailbox, Number(r.messageCount)));
}

/** 管理员按 id 读任意邮箱：与 ?all=1 列表同形（含所有者用户名与邮件数），一次查询 */
export async function getMailbox(env: Env, id: number): Promise<Mailbox> {
  const row = await createDb(env)
    .select({ mailbox: mailboxes, username: users.username, messageCount: messageCountSql })
    .from(mailboxes)
    .leftJoin(users, eq(users.id, mailboxes.userId))
    .where(eq(mailboxes.id, id))
    .get();
  if (!row) throw new AppError('not_found', '邮箱不存在');
  return serialize(row.mailbox, Number(row.messageCount), row.username ?? '');
}

interface ClaimPolicy {
  /** 普通用户的全局/按域认领上限（0=不限；管理员恒为 0），供 INSERT 时原子复核 */
  perUserLimit: number;
  perDomainLimit: number;
  /** 第一条不满足的规则；null 表示规则层面可认领（地址占用另判） */
  blocked: { reason: MailboxUnavailableReason; error: AppError } | null;
}

/** 用户已认领的地址数：合计与按域名分布 */
interface OwnedCounts {
  total: number;
  byDomain: Map<string, number>;
}

/** 一条 GROUP BY 同时给出合计与按域计数（走 idx_mailboxes_user） */
export function ownedCountsStatement(db: D1Database, userId: number): D1PreparedStatement {
  return db.prepare('SELECT domain, COUNT(*) AS n FROM mailboxes WHERE user_id = ? GROUP BY domain').bind(userId);
}

export function ownedCountsFromResult(result: D1Result | undefined): OwnedCounts {
  const byDomain = new Map<string, number>();
  let total = 0;
  for (const row of (result?.results ?? []) as { domain: string; n: number }[]) {
    byDomain.set(row.domain, Number(row.n));
    total += Number(row.n);
  }
  return { total, byDomain };
}

/**
 * 认领规则唯一来源：认领、批量认领、可用性检查与过户共用，避免几处判定漂移。
 * 顺序：域名可用 → 保留前缀 → 全局上限 → 按域名上限（管理员只受域名存在性约束）。
 * 纯函数：所需数据由调用方一次读齐。
 */
function evaluateClaimPolicy(
  settings: ClaimSettings,
  user: MailboxPolicyUser,
  owned: OwnedCounts,
  localPart: string,
  domain: string,
): ClaimPolicy {
  const allow = (perUserLimit = 0, perDomainLimit = 0): ClaimPolicy => ({ perUserLimit, perDomainLimit, blocked: null });
  const block = (reason: MailboxUnavailableReason, error: AppError): ClaimPolicy => ({ perUserLimit: 0, perDomainLimit: 0, blocked: { reason, error } });
  if (!settings.domains.list.some((entry) => entry.domain === domain)) {
    return block('domain_unavailable', new AppError('validation_failed', '域名不在系统域名列表内'));
  }
  const policy = resolveMailboxPolicy(settings, user);
  if (user.role === 'admin') return allow();
  const domainPolicy = policy.domains.find((entry) => entry.domain === domain);
  if (!domainPolicy) {
    return block('domain_unavailable', new AppError('forbidden', '当前用户无权认领该域名'));
  }
  // 保留前缀禁止认领（防冒充官方身份）
  if (policy.reservedLocalParts.includes(localPart)) {
    return block('reserved', new AppError('forbidden', `前缀 ${localPart} 为系统保留，无法认领`));
  }
  // 全局每用户认领上限（跨域名合计，防囤积）
  if (policy.perUserLimit > 0 && owned.total >= policy.perUserLimit) {
    return block('quota', new AppError('forbidden', `认领地址数已达上限（${policy.perUserLimit}）`));
  }
  // 按域名上限：统计该用户在此域名下已认领数
  const domainLimit = domainPolicy.perUserLimit;
  if (domainLimit > 0 && (owned.byDomain.get(domain) ?? 0) >= domainLimit) {
    return block('domain_limit', new AppError('forbidden', `在该域名下最多认领 ${domainLimit} 个地址`));
  }
  return allow(policy.perUserLimit, domainLimit);
}

/** 认领与可用性检查的规则输入。批量认领时每成功一个就地累加，后续地址按最新计数判定。 */
interface ClaimContext {
  userId: number;
  settings: ClaimSettings;
  user: MailboxPolicyUser;
  owned: OwnedCounts;
  /** 已被认领的地址：读取时已存在的，加上本批刚认领的 */
  taken: Set<string>;
}

const addressOf = (req: ClaimMailboxRequest) => `${req.localPart}@${req.domain}`;

/** 与 getSettingsFresh 同一个合并函数（只读回 domains / mailbox_policy 两行，其余项为默认值且不使用） */
const claimSettingsFrom = (result: D1Result | undefined): ClaimSettings =>
  mergeSettingRows((result?.results ?? []) as { key: string; value: string }[]);

/** 规则所需的全部读取合成一个 D1 batch：认领设置（强一致直读）、用户权限、已认领数、地址占用。 */
async function loadClaimContext(env: Env, actor: { userId: number; role: Role }, addresses: string[]): Promise<ClaimContext> {
  const unique = [...new Set(addresses)];
  const [settingsResult, userResult, ownedResult, takenResult] = await env.db.batch([
    claimSettingsStatement(env.db),
    mailboxPolicyUserStatement(env.db, actor.userId),
    ownedCountsStatement(env.db, actor.userId),
    env.db.prepare('SELECT address FROM mailboxes WHERE address IN (SELECT value FROM json_each(?))').bind(JSON.stringify(unique)),
  ]);
  return {
    userId: actor.userId,
    settings: claimSettingsFrom(settingsResult),
    user: mailboxPolicyUserFromResult(userResult),
    owned: ownedCountsFromResult(ownedResult),
    taken: new Set(((takenResult?.results ?? []) as { address: string }[]).map((row) => row.address)),
  };
}

interface InsertedMailboxRow {
  id: number;
  address: string;
  domain: string;
  user_id: number;
  display_name: string;
  created_at: number;
  message_count: number;
}

/** 规则判定 → 占用判定 → 带守卫的 INSERT（RETURNING 直接带回整行与历史邮件数）。成功后更新 context。 */
async function claimWithContext(env: Env, context: ClaimContext, req: ClaimMailboxRequest): Promise<Mailbox> {
  const { settings, user: policyUser, userId } = context;
  const policy = evaluateClaimPolicy(settings, policyUser, context.owned, req.localPart, req.domain);
  if (policy.blocked) throw policy.blocked.error;
  const { perUserLimit, perDomainLimit } = policy;

  const address = addressOf(req);
  if (context.taken.has(address)) throw new AppError('address_taken', '该地址已被占用');
  try {
    // Domain revision and quotas are checked in the same write as INSERT. A
    // concurrent domain removal/private toggle must not create a stale claim.
    const inserted = await env.db
      .prepare(
        `INSERT INTO mailboxes (address, domain, user_id, display_name)
         SELECT ?, ?, ?, ''
         WHERE (? = 0 OR (SELECT COUNT(*) FROM mailboxes WHERE user_id = ?) < ?)
           AND (? = 0 OR (SELECT COUNT(*) FROM mailboxes WHERE user_id = ? AND domain = ?) < ?)
           AND COALESCE((SELECT json_extract(value, '$.revision') FROM settings WHERE key = 'domains'), 0) = ?
           AND EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'active' AND role = ? AND mailbox_policy_revision = ?)
           AND EXISTS (SELECT 1 FROM settings, json_each(settings.value, '$.list') AS configured
             WHERE settings.key = 'domains'
               AND lower(trim(CASE WHEN configured.type = 'text' THEN configured.value
                 ELSE json_extract(configured.value, '$.domain') END)) = ?)
         RETURNING id, address, domain, user_id, display_name, created_at,
           (SELECT COUNT(*) FROM messages WHERE messages.address = mailboxes.address) AS message_count`,
      )
      .bind(
        address,
        req.domain,
        userId,
        perUserLimit,
        userId,
        perUserLimit,
        perDomainLimit,
        userId,
        req.domain,
        perDomainLimit,
        settings.domains.revision ?? 0,
        userId,
        policyUser.role,
        policyUser.mailboxPolicyRevision,
        req.domain,
      )
      .first<InsertedMailboxRow>();
    if (!inserted) throw await claimGuardError(env, context);
    context.taken.add(address);
    context.owned.total += 1;
    context.owned.byDomain.set(req.domain, (context.owned.byDomain.get(req.domain) ?? 0) + 1);
    return serialize({
      id: Number(inserted.id),
      address: inserted.address,
      domain: inserted.domain,
      userId: Number(inserted.user_id),
      displayName: inserted.display_name,
      createdAt: new Date(Number(inserted.created_at)),
    }, Number(inserted.message_count));
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed: mailboxes.address')) {
      throw new AppError('address_taken', '该地址已被占用');
    }
    throw error;
  }
}

/** INSERT 守卫未通过：一次读回当前域名修订与用户权限，区分是配置变化还是并发用尽了配额 */
async function claimGuardError(env: Env, context: ClaimContext): Promise<AppError> {
  const [settingsResult, userResult] = await env.db.batch([
    claimSettingsStatement(env.db),
    mailboxPolicyUserStatement(env.db, context.userId),
  ]);
  const current = claimSettingsFrom(settingsResult);
  if ((current.domains.revision ?? 0) !== (context.settings.domains.revision ?? 0)) {
    return new AppError('conflict', '域名配置已改变，请刷新后重试');
  }
  const currentUser = mailboxPolicyUserFromResult(userResult);
  if (currentUser.mailboxPolicyRevision !== context.user.mailboxPolicyRevision || currentUser.role !== context.user.role) {
    return new AppError('conflict', '邮箱权限已改变，请刷新后重试');
  }
  return new AppError('forbidden', '认领配额已在并发请求中用尽，请刷新后重试');
}

/** 认领地址：domain 必须 ∈ 系统域名，address 全局唯一，普通用户受保留前缀/配额限制 */
export async function claimMailbox(
  env: Env,
  userId: number,
  role: Role,
  req: ClaimMailboxRequest,
): Promise<Mailbox> {
  const context = await loadClaimContext(env, { userId, role }, [addressOf(req)]);
  // await：规则不通过时 claimWithContext 在首个 await 前就已 reject，直接 return 会被 workerd 记为未处理
  return await claimWithContext(env, context, req);
}

/** 每块两条 SQL、一次事务；999 个地址也不超过 D1 Free 的每调用查询数限制。 */
const CLAIM_CHUNK_SIZE = 100;

/**
 * 先标记已有/重复地址，再按输入顺序累计新地址，找出第一条不满足规则的记录。
 * SELECT 计划和 INSERT 使用相同 CTE，放在同一 D1 batch 事务中，其他写入不能插到两者之间。
 */
const BATCH_CLAIM_PLAN_SQL = `WITH
  input AS (
    SELECT CAST(key AS INTEGER) AS position,
      json_extract(value, '$.address') AS address,
      json_extract(value, '$.domain') AS domain,
      json_extract(value, '$.perUserLimit') AS user_limit,
      json_extract(value, '$.perDomainLimit') AS domain_limit,
      json_extract(value, '$.ownedDomain') AS owned_domain,
      json_extract(value, '$.wasTaken') AS was_taken,
      json_extract(value, '$.code') AS policy_code,
      json_extract(value, '$.message') AS policy_message
    FROM json_each(?1)
  ),
  numbered AS (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY address ORDER BY position) AS occurrence,
      EXISTS (SELECT 1 FROM mailboxes WHERE mailboxes.address = input.address) AS existing
    FROM input
  ),
  counted AS (
    SELECT *, (was_taken = 0 AND existing = 0 AND occurrence = 1) AS is_new,
      COALESCE(SUM(was_taken = 0 AND existing = 0 AND occurrence = 1) OVER (
        ORDER BY position ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS added,
      COALESCE(SUM(was_taken = 0 AND existing = 0 AND occurrence = 1) OVER (
        PARTITION BY domain ORDER BY position ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS domain_added
    FROM numbered
  ),
  checked AS (
    SELECT *, CASE
      WHEN policy_code IS NOT NULL THEN policy_code
      WHEN user_limit > 0 AND ?3 + added >= user_limit THEN 'quota'
      WHEN domain_limit > 0 AND owned_domain + domain_added >= domain_limit THEN 'domain_limit'
      WHEN was_taken = 0 AND (existing OR occurrence = 1) AND (
        (user_limit > 0 AND (SELECT COUNT(*) FROM mailboxes WHERE user_id = ?2) + added >= user_limit)
        OR (domain_limit > 0 AND (SELECT COUNT(*) FROM mailboxes WHERE user_id = ?2 AND mailboxes.domain = counted.domain) + domain_added >= domain_limit)
        OR COALESCE((SELECT json_extract(value, '$.revision') FROM settings WHERE key = 'domains'), 0) != ?4
        OR NOT EXISTS (SELECT 1 FROM users WHERE id = ?2 AND status = 'active' AND role = ?5 AND mailbox_policy_revision = ?6)
        OR NOT EXISTS (SELECT 1 FROM settings, json_each(settings.value, '$.list') AS configured
          WHERE settings.key = 'domains' AND lower(trim(CASE WHEN configured.type = 'text' THEN configured.value
            ELSE json_extract(configured.value, '$.domain') END)) = counted.domain)
      ) THEN 'guard'
      ELSE NULL END AS blocked
    FROM counted
  ),
  planned AS (
    SELECT * FROM checked WHERE position <= COALESCE((SELECT MIN(position) FROM checked WHERE blocked IS NOT NULL), 2147483647)
  )`;

interface PlannedClaimRow {
  position: number;
  address: string;
  is_new: number;
  blocked: string | null;
  policy_message: string | null;
  user_limit: number;
  domain_limit: number;
}

async function claimChunk(env: Env, context: ClaimContext, items: ClaimMailboxRequest[]) {
  const inputs = items.map((item) => {
    // 配额在事务内按实际成功的前缀累计；这里仅冻结域名、权限和保留前缀规则。
    const policy = evaluateClaimPolicy(context.settings, context.user, { total: 0, byDomain: new Map() }, item.localPart, item.domain);
    return {
      address: addressOf(item), domain: item.domain,
      perUserLimit: policy.perUserLimit, perDomainLimit: policy.perDomainLimit,
      ownedDomain: context.owned.byDomain.get(item.domain) ?? 0,
      wasTaken: context.taken.has(addressOf(item)) ? 1 : 0,
      code: policy.blocked?.error.code ?? null, message: policy.blocked?.error.message ?? null,
    };
  });
  const bindings = [JSON.stringify(inputs), context.userId, context.owned.total, context.settings.domains.revision ?? 0,
    context.user.role, context.user.mailboxPolicyRevision];
  const [plan, inserted] = await env.db.batch([
    env.db.prepare(`${BATCH_CLAIM_PLAN_SQL} SELECT position, address, is_new, blocked, policy_message, user_limit, domain_limit FROM planned ORDER BY position`).bind(...bindings),
    env.db.prepare(`${BATCH_CLAIM_PLAN_SQL}
      INSERT INTO mailboxes (address, domain, user_id, display_name)
      SELECT address, domain, ?2, '' FROM planned WHERE blocked IS NULL AND is_new ORDER BY position
      RETURNING id, address, domain, user_id, display_name, created_at,
        (SELECT COUNT(*) FROM messages WHERE messages.address = mailboxes.address) AS message_count`).bind(...bindings),
  ]);
  return {
    plan: plan!.results as unknown as PlannedClaimRow[],
    inserted: new Map((inserted!.results as unknown as InsertedMailboxRow[]).map((row) => [row.address, row])),
  };
}

/** 按顺序分块认领：占用跳过；首个业务错误停止，之前完成的块和本块前缀保留。 */
export async function claimMailboxes(
  env: Env,
  userId: number,
  role: Role,
  items: ClaimMailboxRequest[],
): Promise<BatchClaimMailboxResult> {
  const result: BatchClaimMailboxResult = { claimed: [], taken: [], notAttempted: [], stoppedBy: null };
  let index = 0;
  let started = false;
  try {
    const context = await loadClaimContext(env, { userId, role }, items.map(addressOf));
    started = true;
    while (index < items.length) {
      const chunk = items.slice(index, index + CLAIM_CHUNK_SIZE);
      const { plan, inserted } = await claimChunk(env, context, chunk);
      for (const row of plan) {
        const item = items[index]!;
        if (row.blocked) {
          if (row.blocked === 'guard') throw await claimGuardError(env, context);
          if (row.blocked === 'quota') throw new AppError('forbidden', `认领地址数已达上限（${row.user_limit}）`);
          if (row.blocked === 'domain_limit') throw new AppError('forbidden', `在该域名下最多认领 ${row.domain_limit} 个地址`);
          throw new AppError(row.blocked as AppError['code'], row.policy_message!);
        }
        if (!row.is_new) {
          result.taken.push(item);
        } else {
          const mailbox = inserted.get(row.address);
          if (!mailbox) throw new Error('批量认领写入结果缺失');
          result.claimed.push(serialize({
            id: Number(mailbox.id), address: mailbox.address, domain: mailbox.domain,
            userId: Number(mailbox.user_id), displayName: mailbox.display_name,
            createdAt: new Date(Number(mailbox.created_at)),
          }, Number(mailbox.message_count)));
          context.taken.add(row.address);
          context.owned.total++;
          context.owned.byDomain.set(item.domain, (context.owned.byDomain.get(item.domain) ?? 0) + 1);
        }
        index++;
      }
    }
  } catch (error) {
    if (error instanceof AppError) {
      result.stoppedBy = { code: error.code, message: error.message };
    } else if (started) {
      // 已有地址提交后不能变成 500：调用方需要知道哪些已认领。出错那项结果不确定，与其后各项一起列入 notAttempted。
      console.error('批量认领中断:', error);
      result.stoppedBy = { code: 'internal', message: '认领中断，部分地址可能已认领，请以邮箱列表为准' };
    } else {
      throw error;
    }
    result.notAttempted = items.slice(index);
  }
  return result;
}

function availabilityOf(context: ClaimContext, req: ClaimMailboxRequest): MailboxAvailability {
  const address = addressOf(req);
  const policy = evaluateClaimPolicy(context.settings, context.user, context.owned, req.localPart, req.domain);
  if (policy.blocked) return { address, available: false, reason: policy.blocked.reason };
  return context.taken.has(address) ? { address, available: false, reason: 'taken' } : { address, available: true };
}

export async function updateMailbox(
  env: Env,
  userId: number,
  id: number,
  displayName: string,
  isAdmin: boolean,
): Promise<Mailbox> {
  const db = createDb(env);
  const row = await db.select().from(mailboxes).where(eq(mailboxes.id, id)).get();
  if (!row || (!isAdmin && row.userId !== userId)) throw new AppError('not_found', '邮箱不存在');
  const result = await db.update(mailboxes).set({ displayName })
    .where(and(eq(mailboxes.id, id), eq(mailboxes.userId, row.userId))).run();
  if (!result.meta.changes) throw new AppError('conflict', '邮箱归属已改变，请刷新后重试');
  const [updated] = await db
    .select({ mailbox: mailboxes, messageCount: messageCountSql })
    .from(mailboxes)
    .where(eq(mailboxes.id, id))
    .all();
  return serialize(updated!.mailbox, Number(updated!.messageCount));
}

/** 不经过释放/重新认领：所有权、审计及旧共享撤销在同一个 D1 事务内完成。 */
export async function transferMailbox(
  env: Env,
  actor: Pick<AuthUser, 'id' | 'username' | 'role'>,
  id: number,
  req: TransferMailboxRequest,
  ip = '',
): Promise<MailboxTransferResult> {
  if (actor.role !== 'admin') throw new AppError('forbidden', '需要管理员权限');
  const db = createDb(env);
  const row = await db.select().from(mailboxes).where(eq(mailboxes.id, id)).get();
  if (!row) throw new AppError('not_found', '邮箱不存在');
  const target = await db.select().from(users).where(eq(users.id, req.userId)).get();
  if (!target) throw new AppError('not_found', '目标用户不存在');
  if (target.status !== 'active') throw new AppError('validation_failed', '只能过户给启用中的用户');
  const resultFor = async (box: MailboxRow, transferred: boolean, revokedShares = 0): Promise<MailboxTransferResult> => {
    const count = await db.select({ value: sql<number>`COUNT(*)` }).from(messages).where(eq(messages.address, box.address)).get();
    return { mailbox: serialize(box, Number(count?.value ?? 0), target.username),
      previousUserId: transferred ? row.userId : box.userId, transferred, revokedShares };
  };
  // 重试已完成的过户不清理新主人后来建立的共享，也不重复记审计。
  if (row.userId === target.id) return resultFor(row, false);
  if (row.userId !== req.expectedOwnerId) throw new AppError('conflict', '邮箱归属已改变，请刷新后重新确认');
  // 公共配置用户保留管理员强制过户行为；专属用户的新增归属遵守其完整认领规则。
  const settings = target.role === 'user' && target.mailboxPolicy !== null ? await getSettingsFresh(env) : undefined;
  const policy = settings ? evaluateClaimPolicy(settings, target, ownedCountsFromResult(await ownedCountsStatement(env.db, target.id).all()),
    row.address.slice(0, row.address.lastIndexOf('@')), row.domain) : undefined;
  if (policy?.blocked) throw policy.blocked.error;
  const totalLimit = policy?.perUserLimit ?? 0;
  const domainLimit = policy?.perDomainLimit ?? 0;
  const previous = await db.select({ username: users.username }).from(users).where(eq(users.id, row.userId)).get();
  const detail = `${previous?.username ?? `user#${row.userId}`} (#${row.userId}) → ${target.username} (#${target.id})；保留全部历史并撤销旧共享`;
  const results = await env.db.batch([
    env.db.prepare(`UPDATE mailboxes SET user_id = ? WHERE id = ? AND user_id = ? AND user_id <> ?
      AND EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'active' AND role = ? AND mailbox_policy_revision = ?)
      AND (? = 0 OR (SELECT COUNT(*) FROM mailboxes WHERE user_id = ?) < ?)
      AND (? = 0 OR (SELECT COUNT(*) FROM mailboxes WHERE user_id = ? AND domain = ?) < ?)
      AND (? = 0 OR COALESCE((SELECT json_extract(value, '$.revision') FROM settings WHERE key = 'domains'), 0) = ?)`)
      .bind(target.id, id, req.expectedOwnerId, target.id, target.id, target.role, target.mailboxPolicyRevision,
        totalLimit, target.id, totalLimit, domainLimit, target.id, row.domain, domainLimit,
        settings ? 1 : 0, settings?.domains.revision ?? 0),
    // changes() 关联事务内紧邻的上一条写入；CAS 失败时后续审计和共享删除均不执行。
    env.db.prepare(`INSERT INTO admin_audit_logs (actor_id, actor_name, action, target, detail, ip)
      SELECT ?, ?, 'mailbox.transfer', ?, ?, ? WHERE changes() = 1`)
      .bind(actor.id, actor.username, row.address, detail, ip),
    env.db.prepare('DELETE FROM mailbox_shares WHERE mailbox_id = ? AND changes() = 1').bind(id),
  ]);
  const updated = await db.select().from(mailboxes).where(eq(mailboxes.id, id)).get();
  if (!updated) throw new AppError('not_found', '邮箱已被释放，请刷新后重试');
  if (!results[0]?.meta.changes) {
    if (updated.userId === target.id) return resultFor(updated, false);
    throw new AppError('conflict', '邮箱归属、目标用户权限或额度已改变，请刷新后重新确认');
  }
  // 返回本次提交的结果；若另一管理员随后再次过户，客户端读回列表即可发现。
  return resultFor({ ...row, userId: target.id }, true, results[2]?.meta.changes ?? 0);
}

/**
 * 释放地址。默认历史邮件不动（随地址回到未认领态，下一个认领者可见）；
 * deleteHistory=true 时同时删除该地址名下全部邮件——堵住「释放后被他人继承验证码/账单」的隐私路径。
 * 元数据与清理台账同一事务提交；传入 ctx 时 R2 删除放进 waitUntil，不阻塞响应。
 */
export async function releaseMailbox(
  env: Env,
  userId: number,
  id: number,
  isAdmin: boolean,
  deleteHistory = false,
  ctx?: ExecCtx | null,
): Promise<{ deletedMessages: number }> {
  const db = createDb(env);
  const row = await db.select().from(mailboxes).where(eq(mailboxes.id, id)).get();
  if (!row || (!isAdmin && row.userId !== userId)) throw new AppError('not_found', '邮箱不存在');
  const token = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [];
  if (deleteHistory) {
    statements.push(env.db.prepare(`UPDATE messages SET purge_token = ? WHERE address = ?
      AND EXISTS (SELECT 1 FROM mailboxes WHERE id = ? AND user_id = ?)`)
      .bind(token, row.address, row.id, row.userId));
    statements.push(...purgeStatements(env, token));
  }
  statements.push(env.db.prepare(`DELETE FROM mailbox_shares WHERE mailbox_id = ?
    AND EXISTS (SELECT 1 FROM mailboxes WHERE id = ? AND user_id = ?)`).bind(row.id, row.id, row.userId));
  statements.push(env.db.prepare('DELETE FROM mailboxes WHERE id = ? AND user_id = ?').bind(row.id, row.userId));
  // One D1 transaction includes every message present at release, including concurrent inbound.
  const result = await env.db.batch(statements);
  if (!result[result.length - 1]?.meta.changes) throw new AppError('conflict', '邮箱归属已改变，请刷新后重试');
  const deletedMessages = deleteHistory ? (result[1 + PURGE_MESSAGES_INDEX]?.meta.changes ?? 0) : 0;
  if (deleteHistory) await scheduleStorageCleanup(env, ctx, 100);
  return { deletedMessages };
}

/** 可用性提示：与认领同一套规则（evaluateClaimPolicy），不可用时给出 reason；不预订地址 */
export async function checkAvailability(
  env: Env,
  actor: { userId: number; role: Role },
  localPart: string,
  domain: string,
): Promise<MailboxAvailability> {
  const req = { localPart, domain };
  return availabilityOf(await loadClaimContext(env, actor, [addressOf(req)]), req);
}

/** 批量可用性提示：全部读取合成一个 D1 batch，逐项结果与单个检查相同，保持请求顺序 */
export async function checkAvailabilityBatch(
  env: Env,
  actor: { userId: number; role: Role },
  items: ClaimMailboxRequest[],
): Promise<MailboxAvailability[]> {
  const context = await loadClaimContext(env, actor, items.map(addressOf));
  return items.map((item) => availabilityOf(context, item));
}

/** 取用户认领的全部地址（用于 messages 可见性过滤） */
export async function userAddresses(env: Env, userId: number): Promise<string[]> {
  const db = createDb(env);
  const rows = await db
    .select({ address: mailboxes.address })
    .from(mailboxes)
    .where(eq(mailboxes.userId, userId))
    .all();
  return rows.map((r) => r.address);
}

/** 地址 → 认领它的用户 id（地址全局唯一，至多一个 owner）；未认领返回 null */
export async function getMailboxOwner(env: Env, address: string): Promise<number | null> {
  const db = createDb(env);
  const row = await db
    .select({ userId: mailboxes.userId })
    .from(mailboxes)
    .where(eq(mailboxes.address, address))
    .get();
  return row?.userId ?? null;
}

/** 通知归属 SQL（?1 = 收件地址）：收件链路把它并进自己的 batch，必须与 resolveNotifyOwnerIds 同源 */
export const NOTIFY_OWNER_IDS_SQL = `SELECT user_id AS id FROM mailboxes WHERE address = ?1
    UNION ALL
    SELECT id FROM users WHERE role = 'admin' AND status = 'active'
      AND NOT EXISTS (SELECT 1 FROM mailboxes WHERE address = ?1)`;

/** 通知归属：已认领 → 主人；未认领 → 全部启用中的管理员。收信当时结算，一次查询完成。 */
export async function resolveNotifyOwnerIds(env: Env, address: string): Promise<number[]> {
  const rows = await env.db.prepare(NOTIFY_OWNER_IDS_SQL).bind(address).all<{ id: number }>();
  return rows.results.map((row) => Number(row.id));
}

/** 校验地址归属（发件身份校验用） */
export async function userOwnsAddress(env: Env, userId: number, address: string): Promise<boolean> {
  const db = createDb(env);
  const row = await db
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(and(eq(mailboxes.userId, userId), eq(mailboxes.address, address)))
    .get();
  return row !== undefined;
}
