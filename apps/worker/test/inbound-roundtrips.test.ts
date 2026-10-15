import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/db/client.js';
import { attachments, mailboxes, messages, notificationJobs, storageCleanupJobs, users } from '../src/db/schema.js';
import { htmlToText } from '../src/lib/text.js';
import { handleInbound } from '../src/services/inbound.js';
import { purgeMatchingMessages } from '../src/services/message-lifecycle.js';
import { updateUserNotifyPrefs } from '../src/services/notify-prefs.js';
import { getSettings, updateSettings } from '../src/services/setting.js';
import { processStorageCleanup } from '../src/services/storage-cleanup.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/**
 * 包装 env.db / env.r2：记录每次 D1 往返（batch 算一次），按「D1 从空闲转为忙」计串行层数
 * （并行发出的调用算同一层，与墙钟无关）；原文写 R2 时记录 D1 是否正在往返，并可注入 R2 故障。
 */
function instrumented(options: { failPut?: (key: string) => boolean } = {}) {
  const real = env.db;
  const sqls: string[] = [];
  let inFlight = 0;
  let layers = 0;
  const state = { rawPutWhileD1Busy: false };
  async function timed<T>(sql: string, run: () => Promise<T>): Promise<T> {
    sqls.push(sql);
    if (inFlight++ === 0) layers++;
    try { return await run(); } finally { inFlight--; }
  }
  const statement = (sql: string, params: unknown[] = []): D1PreparedStatement => ({
    __sql: sql, __params: params,
    bind: (...next: unknown[]) => statement(sql, next),
    all: () => timed(sql, () => real.prepare(sql).bind(...params).all()),
    run: () => timed(sql, () => real.prepare(sql).bind(...params).run()),
    raw: (opts?: { columnNames?: boolean }) => timed(sql, () => real.prepare(sql).bind(...params).raw(opts as never)),
    first: (column?: string) => timed(sql, () => real.prepare(sql).bind(...params).first(column as never)),
  }) as unknown as D1PreparedStatement;
  const db = {
    prepare: (sql: string) => statement(sql),
    batch: (list: D1PreparedStatement[]) => {
      const items = list as unknown as { __sql: string; __params: unknown[] }[];
      return timed(items.map((item) => item.__sql).join(' ;; '),
        () => real.batch(items.map((item) => real.prepare(item.__sql).bind(...item.__params))));
    },
    exec: (query: string) => real.exec(query),
  } as unknown as D1Database;
  const r2 = new Proxy(env.r2, { get(target, property) {
    if (property === 'put') return async (key: string, ...args: unknown[]) => {
      if (key.startsWith('raw/') && inFlight > 0) state.rawPutWhileD1Busy = true;
      if (options.failPut?.(key)) throw new Error(`injected R2 failure: ${key}`);
      return (target.put as (...a: unknown[]) => Promise<unknown>)(key, ...args);
    };
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return {
    env: { ...env, db, r2 }, sqls, layers: () => layers, calls: () => sqls.length, state,
    /**
     * handleInbound resolve 时的快照：waitUntil 任务在同一轮微任务里就会发出 D1，
     * 此刻仍在往返中的调用不属于 Ack 前（handler 自己 await 的调用都已完成）。
     */
    ack: () => ({ layers: layers - (inFlight > 0 ? 1 : 0), calls: sqls.length - inFlight }),
  };
}

async function seedOwner(name: string) {
  const [user] = await createDb(env).insert(users)
    .values({ username: name, passwordHash: 'x', role: 'user', status: 'active' }).returning({ id: users.id });
  const address = `${name}@roundtrip.test`;
  await createDb(env).insert(mailboxes).values({ address, domain: 'roundtrip.test', userId: user!.id, displayName: '' });
  return { userId: user!.id, address };
}

function incoming(to: string, raw: string, forward = vi.fn(async () => {})) {
  return { raw: new Response(raw).body!, headers: new Headers(), to, from: 'sender@example.net', forward, setReject: vi.fn() } as unknown as ForwardableEmailMessage;
}

const plainMail = (to: string, subject: string, body: string, id = crypto.randomUUID()) => [
  'From: Sender <sender@example.net>', `To: ${to}`, `Subject: ${subject}`, `Message-ID: <${id}@example.net>`,
  'Content-Type: text/plain; charset=utf-8', '', body, ''].join('\r\n');

/** 设置写入会清缓存；先预热，测的是线上常态（isolate 内存缓存命中）下的收件往返 */
async function settingsFor(patch: Parameters<typeof updateSettings>[1]) {
  await updateSettings(env, patch);
  await getSettings(env);
}

describe('收件链路 Ack 前往返', () => {
  it('普通信 Ack 前最多 2 层串行 D1，原文写 R2 与第一层 D1 重叠；即时投递逐条认领', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true })));
    await settingsFor({ code_extract: { enabled: true, aiEnabled: false } });
    const owner = await seedOwner('rt-plain');
    await updateUserNotifyPrefs(env, owner.userId, { webhook: { enabled: true, url: 'https://notify.example.com/mail', secret: '' } });
    const probe = instrumented();
    const ctx = createExecutionContext();
    await handleInbound(incoming(owner.address, plainMail(owner.address, 'Your login code', 'Your verification code is 482913.')), probe.env as never, ctx);
    const ack = probe.ack();
    expect(ack.layers).toBeLessThanOrEqual(2);
    expect(ack.calls).toBe(2);
    expect(probe.state.rawPutWhileD1Busy).toBe(true);
    await waitOnExecutionContext(ctx);
    // waitUntil：入队一个 batch、过期标记与候选查询一个 batch、逐条认领一次、结果回写一次
    expect(probe.calls() - ack.calls).toBe(4);
    const row = await createDb(env).select().from(messages).where(eq(messages.address, owner.address)).get();
    expect(row).toMatchObject({ status: 'received', verificationCode: '482913' });
    const jobs = await createDb(env).select().from(notificationJobs).where(eq(notificationJobs.messageId, row!.id)).all();
    expect(jobs.map((job) => [job.channel, job.status, job.attempts])).toEqual([['webhook', 'succeeded', 1]]);
  });

  it('原文写 R2 失败时向上抛出，新信不落库、修复中的信保持 pending', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await settingsFor({ code_extract: { enabled: false, aiEnabled: false } });
    const owner = await seedOwner('rt-raw-fail');
    const raw = plainMail(owner.address, 'rt-raw-fail', 'body that must not be lost');
    const failing = instrumented({ failPut: (key) => key.startsWith('raw/') });
    await expect(handleInbound(incoming(owner.address, raw), failing.env as never, createExecutionContext())).rejects.toThrow('injected R2 failure');
    expect(await createDb(env).select().from(messages).where(eq(messages.address, owner.address)).all()).toHaveLength(0);

    // 附件故障留下 pending 行后，再次投递时原文写入失败：仍然抛出，不能把这一行转为完整状态
    const withAttachment = [
      'From: Sender <sender@example.net>', `To: ${owner.address}`, 'Subject: rt-raw-fail-att', 'Message-ID: <rt-raw-fail-att@example.net>',
      'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="rt"', '',
      '--rt', 'Content-Type: text/plain; charset=utf-8', '', 'see attached',
      '--rt', 'Content-Type: application/pdf; name="a.pdf"', 'Content-Disposition: attachment; filename="a.pdf"',
      'Content-Transfer-Encoding: base64', '', 'JVBERi0xLjQK', '--rt--', ''].join('\r\n');
    await expect(handleInbound(incoming(owner.address, withAttachment), instrumented({ failPut: (key) => key.startsWith('att/') }).env as never,
      createExecutionContext())).rejects.toThrow('injected R2 failure');
    const rowOf = () => createDb(env).select().from(messages).where(eq(messages.subject, 'rt-raw-fail-att')).get();
    expect((await rowOf())?.status).toBe('pending');
    await expect(handleInbound(incoming(owner.address, withAttachment), failing.env as never, createExecutionContext())).rejects.toThrow('injected R2 failure');
    expect((await rowOf())?.status).toBe('pending');

    const ctx = createExecutionContext();
    await handleInbound(incoming(owner.address, withAttachment), env, ctx);
    await waitOnExecutionContext(ctx);
    const repaired = await rowOf();
    expect(repaired?.status).toBe('received');
    expect(await createDb(env).select().from(attachments).where(eq(attachments.messageId, repaired!.id)).all()).toHaveLength(1);
  });

  it('补投修复按首次收信的归属快照转发，快照里已不是归属人的用户单独补读偏好', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await settingsFor({ code_extract: { enabled: false, aiEnabled: false } });
    const first = await seedOwner('rt-snapshot-a');
    const [other] = await createDb(env).insert(users)
      .values({ username: 'rt-snapshot-b', passwordHash: 'x', role: 'user', status: 'active' }).returning({ id: users.id });
    await updateUserNotifyPrefs(env, first.userId, { forward: { enabled: true, addresses: ['rt-snapshot-a@example.net'] } });
    await updateUserNotifyPrefs(env, other!.id, { forward: { enabled: true, addresses: ['rt-snapshot-b@example.net'] } });
    const raw = [
      'From: Sender <sender@example.net>', `To: ${first.address}`, 'Subject: rt-snapshot', 'Message-ID: <rt-snapshot@example.net>',
      'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="rt"', '',
      '--rt', 'Content-Type: text/plain; charset=utf-8', '', 'see attached',
      '--rt', 'Content-Type: application/pdf; name="a.pdf"', 'Content-Disposition: attachment; filename="a.pdf"',
      'Content-Transfer-Encoding: base64', '', 'JVBERi0xLjQK', '--rt--', ''].join('\r\n');
    const forward = vi.fn(async () => {});
    await expect(handleInbound(incoming(first.address, raw, forward), instrumented({ failPut: (key) => key.startsWith('att/') }).env as never,
      createExecutionContext())).rejects.toThrow('injected R2 failure');
    // 首次投递之后地址换了主人；修复投递仍按当时的快照结算
    await createDb(env).update(mailboxes).set({ userId: other!.id }).where(eq(mailboxes.address, first.address));
    const ctx = createExecutionContext();
    await handleInbound(incoming(first.address, raw, forward), env, ctx);
    await waitOnExecutionContext(ctx);
    const row = await createDb(env).select().from(messages).where(eq(messages.subject, 'rt-snapshot')).get();
    expect(row).toMatchObject({ status: 'received', notifyOwnerIds: [first.userId] });
    expect(forward.mock.calls).toEqual([['rt-snapshot-a@example.net']]);
  });

  it('已完整的重复投递只 1 次 D1 往返即返回，不再转发或通知', async () => {
    await settingsFor({ code_extract: { enabled: false, aiEnabled: false } });
    const owner = await seedOwner('rt-dup');
    await updateUserNotifyPrefs(env, owner.userId, { forward: { enabled: true, addresses: ['rt-dup-target@example.net'] } });
    const raw = plainMail(owner.address, 'rt-dup', 'same delivery');
    const forward = vi.fn(async () => {});
    const first = createExecutionContext();
    await handleInbound(incoming(owner.address, raw, forward), env, first);
    await waitOnExecutionContext(first);

    const probe = instrumented();
    const ctx = createExecutionContext();
    await handleInbound(incoming(owner.address, raw, forward), probe.env as never, ctx);
    expect(probe.ack()).toEqual({ layers: 1, calls: 1 });
    await waitOnExecutionContext(ctx);
    // waitUntil 里只有覆盖写落定后的台账补登；对象仍被这封信引用，不登记
    expect(probe.calls()).toBe(2);
    expect(probe.sqls[1]).toContain('INSERT OR IGNORE INTO storage_cleanup_jobs');
    expect(forward).toHaveBeenCalledOnce();
    const rows = await createDb(env).select().from(messages).where(eq(messages.address, owner.address)).all();
    expect(rows).toHaveLength(1);
    expect(await createDb(env).select().from(storageCleanupJobs).where(eq(storageCleanupJobs.r2Key, rows[0]!.rawR2Key!)).all()).toHaveLength(0);
  });

  it('重复投递的覆盖写晚于永久删除清理落地时，补登清理台账，不留无引用无台账的对象', async () => {
    await settingsFor({ code_extract: { enabled: false, aiEnabled: false } });
    const owner = await seedOwner('rt-dup-purged');
    const raw = plainMail(owner.address, 'rt-dup-purged', 'deleted then redelivered');
    const first = createExecutionContext();
    await handleInbound(incoming(owner.address, raw), env, first);
    await waitOnExecutionContext(first);
    const row = await createDb(env).select().from(messages).where(eq(messages.address, owner.address)).get();
    const rawKey = row!.rawR2Key!;
    await createDb(env).update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, row!.id));

    // 重复投递读到回收站里的行之后，原文覆盖写卡住；此时用户永久删除，清理先删掉对象
    let releasePut!: () => void;
    const putGate = new Promise<void>((resolve) => { releasePut = resolve; });
    let lookupDone!: () => void;
    const lookupGate = new Promise<void>((resolve) => { lookupDone = resolve; });
    const r2 = new Proxy(env.r2, { get(target, property) {
      if (property === 'put') return async (key: string, ...args: unknown[]) => {
        if (key.startsWith('raw/')) await putGate;
        return (target.put as (...a: unknown[]) => Promise<unknown>)(key, ...args);
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const db = new Proxy(env.db, { get(target, property) {
      if (property === 'batch') return async (list: D1PreparedStatement[]) => {
        const out = await target.batch(list);
        lookupDone();
        return out;
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const ctx = createExecutionContext();
    const delivery = handleInbound(incoming(owner.address, raw), { ...env, r2, db } as never, ctx);
    await lookupGate;
    await purgeMatchingMessages(env, eq(messages.id, row!.id), 1);
    expect(await env.r2.head(rawKey)).toBeNull();
    releasePut();
    await delivery;
    await waitOnExecutionContext(ctx);

    const refs = await createDb(env).select({ id: messages.id }).from(messages).where(eq(messages.rawR2Key, rawKey)).all();
    const ledger = await createDb(env).select().from(storageCleanupJobs).where(eq(storageCleanupJobs.r2Key, rawKey)).all();
    expect({ objectExists: !!(await env.r2.head(rawKey)), refs: refs.length, ledger: ledger.length })
      .toEqual({ objectExists: true, refs: 0, ledger: 1 });
    await processStorageCleanup(env);
    expect(await env.r2.head(rawKey)).toBeNull();
    expect(await createDb(env).select().from(storageCleanupJobs).where(eq(storageCleanupJobs.r2Key, rawKey)).all()).toHaveLength(0);
  });

  it('同一封 HTML 信只做一次整段 htmlToText，提码、摘要、AI 兜底与通知正文共用', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn(async (input: string | URL | Request) => String(input).includes('/chat/completions')
      ? Response.json({ choices: [{ message: { content: '{"code":""}' } }] })
      : Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await settingsFor({
      code_extract: { enabled: true, aiEnabled: true },
      ai_model: { baseUrl: 'https://api.deepseek.com', apiKey: 'sk-synthetic-roundtrip', model: 'deepseek-flash' },
    });
    const owner = await seedOwner('rt-html');
    await updateUserNotifyPrefs(env, owner.userId, { webhook: { enabled: true, url: 'https://notify.example.com/mail', secret: '' } });
    const token = 'RTHTMLTOKEN';
    // 正则提不到码（数字离关键词太远）→ 进入 AI 兜底；锚点让链接提取走自己的标记文本
    const html = `<html><head><style>.x{color:red}</style></head><body><p>${token} Please verify your sign-in.</p>`
      + `${'<p>We noticed a new sign-in to your account from a new device.</p>'.repeat(40)}<p>58204716</p>`
      + '<a href="https://example.net/verify?t=abcdefghijklmnopqrstuvwxyz">Verify</a></body></html>';
    const raw = ['From: Example <no-reply@example.net>', `To: ${owner.address}`, 'Subject: Verify your sign-in', 'Message-ID: <rt-html@example.net>',
      'MIME-Version: 1.0', 'Content-Type: text/html; charset=utf-8', '', html, ''].join('\r\n');
    const scriptStrip = /^<\(script\|style\|head\|template\)/;
    const replace = vi.spyOn(String.prototype, 'replace');
    const ctx = createExecutionContext();
    await handleInbound(incoming(owner.address, raw), env, ctx);
    await waitOnExecutionContext(ctx);
    // htmlToText 的第一步对入参整体做脚本/样式剥离；只数作用于整份正文（含标记、非链接提取标记文本）的那一次
    const fullConversions = replace.mock.calls.filter(([pattern], index) => {
      const subject = String(replace.mock.contexts[index]);
      return pattern instanceof RegExp && scriptStrip.test(pattern.source) && subject.includes(token) && !subject.includes('\u0001');
    }).length;
    replace.mockRestore();
    expect(fullConversions).toBe(1);

    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/chat/completions'))).toBe(true);
    const row = await createDb(env).select().from(messages).where(eq(messages.address, owner.address)).get();
    const plain = htmlToText(html);
    expect(row!.preview).toBe(plain.replace(/\s+/g, ' ').trim().slice(0, 160));
    expect(row!.verificationLink).toBe('https://example.net/verify?t=abcdefghijklmnopqrstuvwxyz');
    const [job] = await createDb(env).select().from(notificationJobs).where(eq(notificationJobs.messageId, row!.id)).all();
    expect((job!.payload as { body: string }).body).toBe(plain.slice(0, 4000));
  });
});
