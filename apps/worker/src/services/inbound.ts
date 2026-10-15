import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_TOTAL_BYTES,
} from '@hpc-mail/shared';
import PostalMime, { type Address } from 'postal-mime';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { attachments as attachmentsTable, messages, settings as settingsTable, users } from '../db/schema.js';
import { d1Statement } from '../lib/d1.js';
import { getEmailDomain, getNameFromEmail, normalizeEmail } from '../lib/email-address.js';
import { sha256Hex } from '../lib/crypto.js';
import { mailText } from '../lib/text.js';
import type { Env, ExecCtx } from '../types.js';
import { isAiModelConfigured } from './ai-provider.js';
import { extractCodeByAi, extractCodeByRegex, wantsAiCode } from './code-extract.js';
import { extractVerificationLink } from './link-extract.js';
import {
  LEGACY_NOTIFY_KEYS,
  loadNotifyOwners,
  notifyOwnersFromRows,
  type NotifyOwner,
  type NotifyOwnerRawRow,
} from './notify-prefs.js';
import { bumpCounter, dayWindow } from './rate-counter.js';
import { getSettings } from './setting.js';
import { bodyBytes, D1_BODY_LIMIT, storeMailBody } from './mail-body.js';
import { forwardReceivedMail } from './forwarding.js';
import { NOTIFY_OWNER_IDS_SQL } from './mailbox.js';
import { enqueueMailNotifications } from './notification-jobs.js';
import { attachmentKey, getExt, putObject, sha256Hex16 } from './storage.js';
import { referencedSql } from './storage-cleanup.js';
import { DEFAULT_USER_NOTIFY_PREFS } from '@hpc-mail/shared';

/** 未认领 catch-all 转发必须按稳定主体限额，不能让随机 local-part 刷新额度。 */
const DAILY_AI_EXTRACT_LIMIT = 500;

const encoder = new TextEncoder();

/** 附件并行写 R2 的并发上限 */
const ATTACHMENT_UPLOAD_CONCURRENCY = 4;
/** 附件元数据每行 7 个绑定参数，单条 INSERT 不超过 D1 的 100 参数上限 */
const ATTACHMENT_INSERT_BATCH = 12;

/** 有限并发执行；任一失败整体 reject（与串行时「任一失败即抛出」语义一致） */
async function runLimited<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await task(items[next++]!);
  }));
}

interface ParsedAttachment {
  seq: number;
  content: Uint8Array;
  filename: string;
  mimeType: string;
  contentId: string;
  disposition: string;
  size: number;
}

const duplicateColumns = {
  id: messages.id,
  status: messages.status,
  errorDetail: messages.errorDetail,
  rawR2Key: messages.rawR2Key,
  bodyR2Key: messages.bodyR2Key,
  deletedAt: messages.deletedAt,
  notifyOwnerIds: messages.notifyOwnerIds,
};

/** 同一 ingestKey 已落库的那一行（合批读取时按原始列名映射，并发竞争时由 drizzle 重读） */
interface DuplicateRow {
  id: number;
  status: string;
  errorDetail: string;
  rawR2Key: string | null;
  bodyR2Key: string | null;
  deletedAt: unknown;
  notifyOwnerIds: number[] | null;
}

interface InboundLookup {
  duplicate: DuplicateRow | undefined;
  ownerIds: number[];
  ownerRows: NotifyOwnerRawRow[];
  legacyRows: { key: string; value: string }[];
}

/**
 * Ack 前唯一一次 D1 读：去重行、收信当时的归属人、归属人的状态与偏好、旧全局通知设置，
 * 合成一个 batch 往返。偏好行只在邮件完整落库后才解析。
 */
async function lookupInbound(env: Env, ingestKey: string, address: string): Promise<InboundLookup> {
  const db = createDb(env);
  // 外层由 drizzle 生成（无绑定参数），子查询沿用 NOTIFY_OWNER_IDS_SQL 的 ?1
  const ownerUsers = db.select({ id: users.id, status: users.status, role: users.role, notifyPrefs: users.notifyPrefs })
    .from(users).where(sql`${users.id} IN (${sql.raw(NOTIFY_OWNER_IDS_SQL)})`).toSQL();
  const [dup, owners, ownerUserRows, legacy] = await env.db.batch([
    d1Statement(env, db.select(duplicateColumns).from(messages).where(eq(messages.ingestKey, ingestKey))),
    env.db.prepare(NOTIFY_OWNER_IDS_SQL).bind(address),
    env.db.prepare(ownerUsers.sql).bind(address),
    d1Statement(env, db.select({ key: settingsTable.key, value: settingsTable.value }).from(settingsTable)
      .where(inArray(settingsTable.key, [...LEGACY_NOTIFY_KEYS]))),
  ]);
  const row = dup?.results[0] as {
    id: number; status: string; error_detail: string; raw_r2_key: string | null; body_r2_key: string | null;
    deleted_at: number | null; notify_owner_ids: string | null;
  } | undefined;
  return {
    duplicate: row && {
      id: Number(row.id), status: row.status, errorDetail: row.error_detail ?? '',
      rawR2Key: row.raw_r2_key, bodyR2Key: row.body_r2_key, deletedAt: row.deleted_at,
      notifyOwnerIds: row.notify_owner_ids === null ? null : JSON.parse(row.notify_owner_ids) as number[],
    },
    ownerIds: (owners?.results ?? []).map((item) => Number((item as { id: number }).id)),
    ownerRows: (ownerUserRows?.results ?? []) as NotifyOwnerRawRow[],
    legacyRows: (legacy?.results ?? []) as { key: string; value: string }[],
  };
}

/**
 * 收件链路：解析 → 一层并行 I/O（去重 + 归属人 + 偏好的 D1 batch、原文/大正文写 R2，期间完成提码与摘要）
 * → 落库 → 附件落 R2 → waitUntil(邮箱转发、AI 兜底 + 通知队列)。原文/正文/附件未完整保存则 SMTP 重试。
 */
export async function handleInbound(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecCtx,
): Promise<void> {
  // 设置读取（内存缓存未命中时走 KV/D1）与原文缓冲、解析重叠，提码前才等待
  const settingsReady = getSettings(env, ctx);

  // 先缓冲原始 .eml（stream 只能读一次），解析与幂等摘要共用这一份字节。
  const rawBytes = new Uint8Array(await new Response(message.raw).arrayBuffer());
  const rawDigest = await sha256Hex(rawBytes);

  // 解析失败降级为最小记录，不再 throw：抛出去会让 SMTP 一直重投直到超时退信，
  // 这封信一次都进不了库，管理员看不到任何痕迹。原文已在 R2，可下载排查
  let email: Awaited<ReturnType<typeof PostalMime.parse>>;
  try {
    email = await PostalMime.parse(rawBytes);
  } catch (e) {
    console.error('MIME 解析失败，按最小记录落库:', e);
    email = {
      from: { address: '', name: '' },
      to: [],
      cc: [],
      bcc: [],
      subject: '(邮件解析失败)',
      text: '原始邮件无法解析，请下载 .eml 原文查看。',
      html: '',
      attachments: [],
      headers: [],
    } as unknown as Awaited<ReturnType<typeof PostalMime.parse>>;
  }

  const toAddress = normalizeEmail(message.to);
  const domain = getEmailDomain(toAddress);
  const fromAddress = normalizeEmail(email.from?.address);
  const fromName = (email.from?.name || getNameFromEmail(fromAddress)).trim().slice(0, 512);

  const mapAddrs = (list: Address[] | undefined): string[] =>
    [...new Set((list ?? []).flatMap(item => item.group ?? [item])
      .map(item => normalizeEmail(item.address)).filter(Boolean))].slice(0, 200);
  const toList = mapAddrs(email.to);
  const recipients = { to: toList.length ? toList : [toAddress], cc: mapAddrs(email.cc), bcc: mapAddrs(email.bcc) };
  const replyTo = mapAddrs(email.replyTo);

  const subject = (email.subject || '').slice(0, 2048);
  const text = email.text || '';
  const html = email.html || '';
  const sourceMessageId = (email.messageId || '').slice(0, 998);
  const sourceReferences = (email.references || '').slice(0, 4096);
  const ingestKey = await sha256Hex(`${toAddress}\n${sourceMessageId}\n${rawDigest}`);
  const db = createDb(env);
  const bodySize = bodyBytes(text, html);

  // Ack 前第一层 I/O 同时发出：D1 读与原文（及 >256KB 正文）写 R2 重叠。
  // R2 key 只由 ingestKey 决定、内容相同，重复投递时覆盖写幂等；两者都成功之后才落库，
  // 任一失败向上抛出触发 SMTP 重试，不会留下完整状态的邮件。
  const rawR2Key = `raw/${ingestKey}.eml`;
  const lookupReady = lookupInbound(env, ingestKey, toAddress);
  const rawSaved = (async () => {
    await env.r2.put(rawR2Key, rawBytes, { httpMetadata: { contentType: 'message/rfc822' } });
  })();
  const bodySaved = storeMailBody(env, text, html, ingestKey, bodySize);
  // 下方按顺序 await；先失败的一方在轮到它之前不能成为未处理的 rejection
  for (const pending of [lookupReady, rawSaved, bodySaved]) pending.catch(() => {});

  // I/O 进行中完成 CPU 部分。HTML → 纯文本只转换一次，提码、摘要、AI 兜底、通知与转发共用。
  const settings = await settingsReady;
  const body = mailText(text, html);
  // 同步正则提码 + 验证链接识别（同受「自动提取」开关控制）
  let code = '';
  let verificationLink = '';
  if (settings.code_extract.enabled) {
    code = extractCodeByRegex(subject, body.plain);
    verificationLink = extractVerificationLink({ subject, text, html, fromAddress });
  }
  const preview = body.preview();

  // 附件落 R2 前先算内容
  let attachmentBytes = 0;
  let attachmentsDropped = false;
  const parsedAttachments: ParsedAttachment[] = [];
  for (const [seq, att] of (email.attachments ?? []).entries()) {
    const raw = att.content as string | ArrayBuffer;
    const content = typeof raw === 'string' ? encoder.encode(raw) : new Uint8Array(raw);
    if (
      parsedAttachments.length >= MAX_ATTACHMENTS ||
      attachmentBytes + content.byteLength > MAX_ATTACHMENT_TOTAL_BYTES
    ) {
      attachmentsDropped = true;
      continue;
    }
    attachmentBytes += content.byteLength;
    parsedAttachments.push({
      seq,
      content,
      filename: att.filename || 'download',
      mimeType: att.mimeType || 'application/octet-stream',
      contentId: (att.contentId || '').replace(/^<|>$/g, ''),
      disposition: att.disposition === 'inline' ? 'inline' : 'attachment',
      size: content.byteLength,
    });
  }
  const attachmentsSize = parsedAttachments.reduce((sum, a) => sum + a.size, 0);
  const attachmentHashes = await Promise.all(parsedAttachments.map((att) => sha256Hex16(att.content)));

  const lookup = await lookupReady;
  let duplicate = lookup.duplicate;
  // 已删除或已完整的重复投递：同 key 同内容的 R2 覆盖写交给 waitUntil 收尾，不拖慢 Ack。
  // 去重读之后这封信可能被永久删除、对象已被清理，迟到的覆盖写会把它重建成孤儿，写完补登清理台账。
  if (duplicate?.deletedAt || (duplicate && (duplicate.status === 'received' ||
    (duplicate.status === 'degraded' && !duplicate.errorDetail.includes('保存失败'))) && duplicate.rawR2Key &&
    (bodySize <= D1_BODY_LIMIT || duplicate.bodyR2Key))) {
    ctx.waitUntil(ledgerUnreferencedWrites(env, rawR2Key, rawSaved, bodySaved));
    return;
  }

  // 接受 SMTP 投递前必须保存原文与完整正文；存储故障由 SMTP 重投恢复，不能接受丢失正文。
  await rawSaved;
  const { bodyText, bodyHtml, bodyR2Key } = await bodySaved;

  const size = bodySize + attachmentsSize;
  const ownerIds = duplicate?.notifyOwnerIds ?? lookup.ownerIds;

  const finalState = {
    status: attachmentsDropped ? 'degraded' : 'received',
    errorDetail: attachmentsDropped ? '部分附件超过数量或总大小上限，请下载原始邮件查看' : '',
  };
  // 无附件的新邮件在插入时就已完整（原文/正文已落 R2），直接写最终状态，省掉 pending → 完整的回写；
  // 有附件时仍先写 pending，附件保存成功后再原子转为完整状态。
  const completeOnInsert = !duplicate && parsedAttachments.length === 0;

  // 消息落库：失败向上抛出触发 SMTP 重试。
  // 补投修复的字段回写与「pending → 完整」切换在下方同一事务里提交，不单独往返。
  let inserted: { id: number } | undefined;
  let repair: ReturnType<typeof repairStatement> | undefined;
  if (duplicate) {
    repair = repairStatement(db, duplicate.id, { bodyText, bodyHtml, bodyR2Key, rawR2Key, replyTo, notifyOwnerIds: ownerIds });
    inserted = { id: duplicate.id };
  } else try {
    inserted = await db.insert(messages).values({
      direction: 'inbound',
      address: toAddress,
      domain,
      fromAddress,
      fromName,
      recipients,
      replyTo,
      notifyOwnerIds: ownerIds,
      subject,
      preview,
      bodyText,
      bodyHtml,
      bodyR2Key,
      rawR2Key,
      ingestKey,
      verificationCode: code,
      verificationLink,
      messageId: sourceMessageId || null,
      inReplyTo: (email.inReplyTo || '').slice(0, 998) || null,
      references: sourceReferences,
      status: completeOnInsert ? finalState.status : 'pending',
      errorDetail: attachmentsDropped ? '部分附件超过数量或总大小上限，请下载原始邮件查看' : '',
      isRead: false,
      size,
      createdAt: new Date(),
    }).returning({ id: messages.id }).get();
  } catch (error) {
    // 并发重复投递：另一请求已成功落库，确定性 R2 key 属于那条记录，不能删除。
    const raced = await db
      .select(duplicateColumns)
      .from(messages)
      .where(eq(messages.ingestKey, ingestKey))
      .get();
    if (raced && (raced.status === 'received' || raced.status === 'degraded')) return;
    if (!raced) throw error;
    duplicate = raced;
    inserted = { id: raced.id };
  }
  if (!inserted) throw new Error('入站邮件落库未返回 id');
  const messageId = inserted!.id;

  // 附件上传 + 落库：失败保留 pending，下次原始邮件重投修复同一条记录。
  // R2 并行写（并发 4）；附件元数据与「pending → 完整」状态切换同一个 D1 事务往返。
  const pendingRecovery = !duplicate || duplicate.status === 'pending';
  const markComplete = db.update(messages).set(finalState).where(pendingRecovery
    ? and(eq(messages.id, messageId), eq(messages.status, 'pending'))
    : eq(messages.id, messageId)).returning({ id: messages.id });
  let completed: boolean;
  if (completeOnInsert && !duplicate) {
    completed = true;
  } else if (parsedAttachments.length) {
    try {
      const rows: typeof attachmentsTable.$inferInsert[] = parsedAttachments.map((att, index) => ({
        messageId,
        r2Key: attachmentKey(messageId, att.seq, attachmentHashes[index]!, getExt(att.filename)),
        filename: att.filename,
        mimeType: att.mimeType,
        size: att.size,
        contentId: att.contentId,
        disposition: att.disposition,
      }));
      await runLimited(rows.map((row, index) => ({ row, att: parsedAttachments[index]! })), ATTACHMENT_UPLOAD_CONCURRENCY,
        ({ row, att }) => putObject(env, row.r2Key, att.content, att.mimeType));
      // 补偿重投不重复增加附件行：(message_id, r2_key) 唯一索引去重，每个已保存对象有稳定 key。
      const inserts = [];
      for (let start = 0; start < rows.length; start += ATTACHMENT_INSERT_BATCH) {
        inserts.push(db.insert(attachmentsTable).values(rows.slice(start, start + ATTACHMENT_INSERT_BATCH)).onConflictDoNothing());
      }
      // batch 是事务：任一附件行写入失败，状态切换一并回滚，邮件保持 pending
      const [marked] = await db.batch([markComplete, ...(repair ? [repair] : []), ...inserts]);
      completed = marked.length > 0;
    } catch (e) {
      console.error('附件入库失败:', e);
      try {
        await db.update(messages).set({ status: 'pending', errorDetail: '附件保存失败，等待投递重试恢复' })
          .where(eq(messages.id, messageId));
      } catch (updateError) { console.error('附件降级状态保存失败:', updateError); }
      throw e;
    }
  } else if (repair) {
    const [marked] = await db.batch([markComplete, repair]);
    completed = marked.length > 0;
  } else {
    completed = !!(await markComplete.get());
  }
  // 并发修复只有将 pending 原子转为完整状态的一方执行转发与通知。
  if (!completed) return;
  // 旧完整消息补存原文时不重复转发；pending 消息从未进入后处理，恢复后正常通知。
  if (duplicate && duplicate.status !== 'pending') return;

  // 转发偏好来自收件时保存的 owner 快照：状态与偏好已随去重查询读出，转发、入队与即时投递共用；
  // 修复投递的快照里有当时不再是归属人的用户时补读一次。偏好读取失败不影响已经可靠落库的邮件。
  const resolvedOwners = new Set(lookup.ownerIds);
  const ownersReady = (async (): Promise<Map<number, NotifyOwner> | undefined> => {
    try {
      return ownerIds.every((id) => resolvedOwners.has(id))
        ? notifyOwnersFromRows(lookup.ownerRows, lookup.legacyRows)
        : await loadNotifyOwners(env, ownerIds);
    } catch (e) {
      console.error('通知偏好解析失败，跳过转发（邮件与归属快照已入库）:', e);
      return undefined;
    }
  })();

  ctx.waitUntil(ownersReady.then((owners) => forwardReceivedMail(env, {
    messageId, ownerIds,
    fromAddress, fromName, toAddress, domain, subject, text, html, replyTo,
    attachments: parsedAttachments, mailText: body,
  }, owners ? ownerIds.map((id) => owners.get(id)?.prefs ?? DEFAULT_USER_NOTIFY_PREFS) : [], message))
    .catch(error => console.error('入站转发后处理失败:', error)));

  // 异步后处理：AI 兜底提码 + 按 owner 个人偏好的飞书/通用 webhook（各自 try/catch 隔离）
  ctx.waitUntil(
    (async () => {
      let finalCode = code;
      let codeSaved: Promise<void> | undefined;
      // 模型未配置、或邮件里没有验证码相关词时不外发、也不占每域额度
      if (!finalCode && settings.code_extract.enabled && settings.code_extract.aiEnabled
        && isAiModelConfigured(settings.ai_model) && wantsAiCode({ subject, text, html, plain: body.plain })) {
        try {
          const usage = await bumpCounter(env, 'ai-extract', domain, dayWindow(), 1);
          if (usage.count <= DAILY_AI_EXTRACT_LIMIT) {
            const aiCode = await extractCodeByAi(settings.ai_model, { subject, text, html, plain: body.plain });
            if (aiCode) {
              finalCode = aiCode;
              // 回写验证码与通知入队并行，各自失败互不影响
              codeSaved = Promise.resolve(db
                .update(messages)
                .set({ verificationCode: aiCode })
                .where(eq(messages.id, messageId)))
                .then(() => undefined, (e: unknown) => console.error('AI 提码失败:', e));
            }
          } else {
            console.warn(`域名 ${domain} 今日 AI 提码额度已用尽，跳过兜底识别`);
          }
        } catch (e) {
          console.error('AI 提码失败:', e);
        }
      }
      await Promise.all([codeSaved, enqueueMailNotifications(env, ctx, {
        ownerIds,
        owners: await ownersReady,
        message: { id: messageId, address: toAddress, fromAddress, fromName, subject,
          verificationCode: finalCode, verificationLink, preview, createdAt: new Date().toISOString() },
        text, html, mailText: body,
      })]);
    })(),
  );
}

/**
 * 提前返回的重复投递在 R2 写入落定后，为不再被任何行引用的 key 补一条清理台账（已有台账则忽略），
 * 由存储清理按引用复核后删除。仍被引用的 key 不登记，与正常删除路径互不干扰。
 */
async function ledgerUnreferencedWrites(
  env: Env,
  rawR2Key: string,
  rawSaved: Promise<void>,
  bodySaved: Promise<{ bodyR2Key: string | null }>,
): Promise<void> {
  const [, body] = await Promise.allSettled([rawSaved, bodySaved]);
  const keys = [rawR2Key];
  if (body.status === 'fulfilled' && body.value.bodyR2Key) keys.push(body.value.bodyR2Key);
  try {
    await env.db.batch(keys.map((key) => env.db.prepare(`INSERT OR IGNORE INTO storage_cleanup_jobs (r2_key)
      SELECT ?1 WHERE NOT ${referencedSql('?1')}`).bind(key)));
  } catch (error) {
    console.error('重复投递的 R2 清理台账保存失败:', error);
  }
}

/** 补投修复：补存原文/正文 key 与收件快照（与状态切换同一 batch 提交） */
function repairStatement(db: ReturnType<typeof createDb>, id: number, fields: Pick<typeof messages.$inferInsert,
  'bodyText' | 'bodyHtml' | 'bodyR2Key' | 'rawR2Key' | 'replyTo' | 'notifyOwnerIds'>) {
  return db.update(messages).set(fields).where(eq(messages.id, id));
}
