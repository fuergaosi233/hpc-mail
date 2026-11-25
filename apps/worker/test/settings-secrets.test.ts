import { SECRET_MASK, type Settings } from '@hpc-mail/shared';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { desc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { adminAuditLogs, settings as settingsTable, users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import { isSealed, openSecret } from '../src/lib/secret-box.js';
import { createSession } from '../src/services/session.js';
import { getSettingsFresh, maskSettings, readVendorSecrets, updateSettings, writeVendorSecret } from '../src/services/setting.js';

const app = createApp();
const db = createDb(env);

const proxy1024 = (patch: Partial<Settings['proxy1024']> = {}): Settings['proxy1024'] => ({
  enabled: true, email: 'buyer@example.com', password: 'pw-plain-1024', sessionToken: 'zero-sid-plain', lang: 'en',
  maxOrderCents: 5000, maxDailyCents: 20000, quoteTtlMinutes: 15, ...patch,
});
const spaceship = (patch: Partial<Settings['spaceship']> = {}): Settings['spaceship'] => ({
  enabled: true, apiKey: 'ss-key-plain', apiSecret: 'ss-secret-plain', registrantContactId: '', years: 1, autoRenew: false,
  privacyLevel: 'high', allowPremium: false, maxDomainCents: 2000, maxBatchCents: 10000, maxDailyCents: 20000,
  maxBatchDomains: 20, quoteTtlMinutes: 15, ingressWorkerName: 'hpc-mail-ingress-test', ...patch,
});

async function storedRaw(key: string): Promise<string> {
  return (await db.select().from(settingsTable).where(eq(settingsTable.key, key)).get())!.value;
}

let seq = 0;
async function admin() {
  const user = (await db.insert(users).values({ username: `secrets-admin-${++seq}`, role: 'admin', passwordHash: 'test', authVersionMigrated: true }).returning().get())!;
  const sid = await createSession(env, user.id);
  return signToken(env.jwt_secret, { sub: user.id, sid, epoch: 0, uepoch: 0 });
}

async function putSettings(jwt: string, body: unknown) {
  const ctx = createExecutionContext();
  const response = await app.request('/api/admin/settings', {
    method: 'PUT', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe('采购设置的密文字段', () => {
  it('落库为密文，读取时可解密；SECRET_MASK 保留、空串清除', async () => {
    await updateSettings(env, { proxy1024: proxy1024(), spaceship: spaceship() });
    const raw1024 = await storedRaw('proxy1024');
    const rawSpaceship = await storedRaw('spaceship');
    for (const plain of ['pw-plain-1024', 'zero-sid-plain']) expect(raw1024).not.toContain(plain);
    for (const plain of ['ss-key-plain', 'ss-secret-plain']) expect(rawSpaceship).not.toContain(plain);
    const stored = await getSettingsFresh(env);
    expect(isSealed(stored.proxy1024.password) && isSealed(stored.proxy1024.sessionToken)).toBe(true);
    expect(stored.proxy1024.email).toBe('buyer@example.com');

    expect(await readVendorSecrets(env, 'proxy1024')).toMatchObject({ password: 'pw-plain-1024', sessionToken: 'zero-sid-plain' });
    expect(await readVendorSecrets(env, 'spaceship')).toMatchObject({ apiKey: 'ss-key-plain', apiSecret: 'ss-secret-plain' });

    // 回显掩码；未配置的密文字段回显空串
    const masked = maskSettings(stored);
    expect(masked.proxy1024).toMatchObject({ password: SECRET_MASK, sessionToken: SECRET_MASK, email: 'buyer@example.com' });
    expect(masked.spaceship).toMatchObject({ apiKey: SECRET_MASK, apiSecret: SECRET_MASK });

    // 提交掩码保留原密文（逐字节不变），空串清除，改其他字段不影响密文
    await updateSettings(env, { proxy1024: proxy1024({ password: SECRET_MASK, sessionToken: '', maxOrderCents: 100 }) });
    const after = await getSettingsFresh(env);
    expect(after.proxy1024.password).toBe(stored.proxy1024.password);
    expect(after.proxy1024.sessionToken).toBe('');
    expect(after.proxy1024.maxOrderCents).toBe(100);
    expect(maskSettings(after).proxy1024.sessionToken).toBe('');
    expect(await readVendorSecrets(env, 'proxy1024')).toMatchObject({ password: 'pw-plain-1024', sessionToken: '' });
  });

  it('不接受看起来像密文的输入', async () => {
    await expect(updateSettings(env, { spaceship: spaceship({ apiKey: 'enc:v1:k1:abc:def' }) })).rejects.toThrow('enc:v1:');
  });

  it('writeVendorSecret 只改会话 token，不动其他字段', async () => {
    await updateSettings(env, { proxy1024: proxy1024({ password: 'pw-keep', sessionToken: 'old-token' }) });
    const before = await getSettingsFresh(env);
    await writeVendorSecret(env, 'proxy1024', 'sessionToken', 'fresh-token');
    const after = await getSettingsFresh(env);
    expect(after.proxy1024.password).toBe(before.proxy1024.password);
    expect(after.proxy1024.maxDailyCents).toBe(before.proxy1024.maxDailyCents);
    expect(isSealed(after.proxy1024.sessionToken)).toBe(true);
    expect(await openSecret(env, after.proxy1024.sessionToken)).toBe('fresh-token');
    expect(await storedRaw('proxy1024')).not.toContain('fresh-token');
  });

  it('writeVendorSecret 在设置行不存在时插入默认值', async () => {
    await db.delete(settingsTable).where(eq(settingsTable.key, 'proxy1024'));
    await writeVendorSecret(env, 'proxy1024', 'sessionToken', 'first-token');
    const { settings, sessionToken } = await readVendorSecrets(env, 'proxy1024');
    expect(sessionToken).toBe('first-token');
    expect(settings.enabled).toBe(false);
    expect(settings.maxOrderCents).toBe(0);
  });

  it('管理接口回显掩码，审计不含明文', async () => {
    const jwt = await admin();
    const response = await putSettings(jwt, { proxy1024: proxy1024({ password: 'audit-pw-plain', sessionToken: 'audit-token-plain' }), spaceship: spaceship({ apiKey: 'audit-key-plain', apiSecret: SECRET_MASK }) });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    for (const plain of ['audit-pw-plain', 'audit-token-plain', 'audit-key-plain']) expect(text).not.toContain(plain);
    const body = JSON.parse(text) as { data: Settings };
    expect(body.data.proxy1024.password).toBe(SECRET_MASK);
    expect(body.data.spaceship.apiKey).toBe(SECRET_MASK);
    const log = (await db.select().from(adminAuditLogs).where(eq(adminAuditLogs.action, 'settings.update')).orderBy(desc(adminAuditLogs.id)).get())!;
    const logged = `${log.target} ${log.detail}`;
    for (const plain of ['audit-pw-plain', 'audit-token-plain', 'audit-key-plain', 'enc:v1:']) expect(logged).not.toContain(plain);
    expect(logged).toContain('proxy1024.password 已更新');

    // GET 同样只回显掩码
    const ctx = createExecutionContext();
    const get = await app.request('/api/admin/settings', { headers: { Authorization: `Bearer ${jwt}` } }, env, ctx);
    await waitOnExecutionContext(ctx);
    const got = await get.text();
    expect(got).not.toContain('enc:v1:');
    expect((JSON.parse(got) as { data: Settings }).data.spaceship.apiSecret).toBe(SECRET_MASK);
  });
});
