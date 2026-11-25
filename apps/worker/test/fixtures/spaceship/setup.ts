import { env } from 'cloudflare:test';
import type { SpaceshipSetting } from '@hpc-mail/shared';
import { eq } from 'drizzle-orm';
import { createDb } from '../../../src/db/client.js';
import { domainPurchaseBatches, domainPurchaseItems } from '../../../src/db/schema.js';
import { getSettingsFresh, updateSettings } from '../../../src/services/setting.js';
import type { Env } from '../../../src/types.js';
import { CF_ACCOUNT, CONTACT_ID } from './fake-vendors.js';

export const INGRESS = 'hpc-mail-ingress-test';
/** k3s 形态：Cloudflare 凭据 + 显式的收件 Worker 名称 */
export const runtime: Env = { ...env, cf_api_token: 'test-token', cf_account_id: CF_ACCOUNT, worker_name: INGRESS };
export const admin = { id: 1, username: 'admin' };

let sequence = 0;

/** 清空采购台账与 poll 计数，写入一份可采购的 spaceship 设置；返回本用例专用的域名前缀 */
export async function setupPurchase(over: Partial<SpaceshipSetting> = {}, domains: string[] = []) {
  const prefix = `dp${++sequence}x${Math.floor(Math.random() * 1e6)}`;
  await env.db.prepare('DELETE FROM domain_purchase_items').run();
  await env.db.prepare('DELETE FROM domain_purchase_batches').run();
  await env.db.prepare("DELETE FROM rate_counters WHERE scope = 'spaceship.poll'").run();
  const current = await getSettingsFresh(env);
  await updateSettings(env, {
    domains: { list: domains.map((domain) => ({ domain, public: false, perUserLimit: 0 })) },
    expectedDomainsRevision: current.domains.revision ?? 0,
    spaceship: {
      enabled: true, apiKey: 'test-key', apiSecret: 'test-secret', registrantContactId: CONTACT_ID, years: 1, autoRenew: false,
      privacyLevel: 'high', allowPremium: false, maxDomainCents: 5_000, maxBatchCents: 20_000, maxDailyCents: 50_000,
      maxBatchDomains: 30, quoteTtlMinutes: 15, ingressWorkerName: '', ...over,
    },
  });
  return { prefix, domain: (name: string) => `${prefix}-${name}.com` };
}

export async function itemsOf(batchId: number) {
  return createDb(env).select().from(domainPurchaseItems).where(eq(domainPurchaseItems.batchId, batchId)).orderBy(domainPurchaseItems.id).all();
}

export async function batchRow(batchId: number) {
  return (await createDb(env).select().from(domainPurchaseBatches).where(eq(domainPurchaseBatches.id, batchId)).get())!;
}

export async function itemByDomain(domain: string) {
  return (await createDb(env).select().from(domainPurchaseItems).where(eq(domainPurchaseItems.domain, domain)).get())!;
}

export async function expectAppError(promise: Promise<unknown>, code: string): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; message?: string };
    if (e.code !== code) throw new Error(`expected ${code}, got ${e.code}: ${e.message}`);
    return e.message ?? '';
  }
  throw new Error(`expected AppError ${code}`);
}
