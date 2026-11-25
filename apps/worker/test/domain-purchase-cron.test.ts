import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/db/client.js';
import { adminAuditLogs } from '../src/db/schema.js';
import {
  confirmDomainBatch, getDomainBatch, quoteDomainPurchase, refreshDomainItem, resolveDomainItem, retryDomainItem, runDomainPurchaseCron,
} from '../src/services/domain-purchase.js';
import { SECRET_MASK, type SpaceshipSetting } from '@hpc-mail/shared';
import { getSettingsFresh, updateSettings } from '../src/services/setting.js';
import type { Env } from '../src/types.js';
import { CF_NS, fakeVendors } from './fixtures/spaceship/fake-vendors.js';
import { INGRESS, admin, batchRow, expectAppError, itemByDomain, runtime, setupPurchase } from './fixtures/spaceship/setup.js';

const db = createDb(env);
const MINUTE = 60_000;
let clock = Date.now();
const deps = () => ({ now: () => clock, sleep: async () => {} });

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 报价并确认给定域名（每个 $12.98 cap basis） */
async function purchase(domains: string[], envIn: Env = runtime) {
  const batch = await quoteDomainPurchase(envIn, admin, { domains }, '', deps());
  await confirmDomainBatch(envIn, admin, batch.id, { domains, expectedTotalCents: 1298 * domains.length }, '', null, deps());
  return batch.id;
}

/** 推进时钟后跑一次 cron */
async function tick(minutes = 6, envIn: Env = runtime) {
  clock += minutes * MINUTE;
  return runDomainPurchaseCron(envIn, { now: clock, deps: deps() });
}

const statusOf = async (domain: string) => (await itemByDomain(domain)).status;
const DAY_MIN = 24 * 60;

/** 只改部分 spaceship 设置（密文字段保持原值） */
async function patchSpaceship(patch: Partial<SpaceshipSetting>) {
  const current = (await getSettingsFresh(env)).spaceship;
  await updateSettings(env, { spaceship: { ...current, apiKey: SECRET_MASK, apiSecret: SECRET_MASK, ...patch } });
}

describe('域名采购 cron：状态机', () => {
  it('完整流程：注册 → 轮询 → 建 zone → 改 NS → zone 生效 → 路由 + catch-all → 加入系统域名', async () => {
    clock = Date.now();
    const t = await setupPurchase();
    const vendors = fakeVendors({ clock: () => clock });
    const names = [t.domain('a'), t.domain('b')];
    const batchId = await purchase(names);

    await tick(0);
    expect(vendors.ss.registerCalls).toEqual(names);
    for (const name of names) {
      const item = await itemByDomain(name);
      expect(item).toMatchObject({ status: 'registering', opStatus: 'pending' });
      expect(item.operationId).toBeTruthy();
    }
    expect((await getDomainBatch(runtime, batchId)).items!.every((item) => item.maybeCharged)).toBe(true);

    // 操作仍在进行：保持 registering
    await tick(2);
    expect(await statusOf(names[0]!)).toBe('registering');
    vendors.succeedAllOps();
    await tick();
    expect(await statusOf(names[0]!)).toBe('registered');
    await tick();
    expect(await statusOf(names[0]!)).toBe('zone_created');
    expect((await itemByDomain(names[0]!)).nameServers).toEqual(CF_NS);
    await tick();
    expect(await statusOf(names[0]!)).toBe('ns_set');
    expect(vendors.ss.nameserverCalls).toEqual(names.map((domain) => ({ domain, hosts: CF_NS })));
    vendors.activateZones();
    await tick();
    expect(await statusOf(names[0]!)).toBe('zone_active');
    await tick();
    expect(await statusOf(names[0]!)).toBe('routing_ready');
    for (const name of names) {
      const zone = vendors.zoneByName(name)!;
      expect(zone.routing.enabled).toBe(true);
      expect(zone.catchAll).toEqual({ enabled: true, actions: [{ type: 'worker', value: [INGRESS] }] });
    }
    await tick();
    for (const name of names) expect(await statusOf(name)).toBe('domain_added');
    const settings = await getSettingsFresh(env);
    expect(settings.domains.list.map((entry) => entry.domain)).toEqual(names);
    expect(settings.domains.list[0]).toMatchObject({ public: false, perUserLimit: 0 });
    const batch = await getDomainBatch(runtime, batchId);
    expect(batch.status).toBe('completed');
    expect(batch.items!.every((item) => item.readyAt && !item.maybeCharged && item.verificationStatus === 'verification')).toBe(true);

    // 之后再跑不会重复注册或重复加域名
    await tick();
    await tick();
    expect(vendors.ss.registerCalls).toEqual(names);
    expect((await getSettingsFresh(env)).domains.list).toHaveLength(2);
    const actions = (await db.select().from(adminAuditLogs).all()).filter((row) => names.includes(row.target)).map((row) => row.action);
    expect(actions.filter((a) => a === 'domain_purchase.register')).toHaveLength(2);
    expect(actions.filter((a) => a === 'domain_purchase.ready')).toHaveLength(2);
  });

  it('zone 未生效时一直等待（定期请求复查），生效后继续', async () => {
    clock = Date.now();
    const t = await setupPurchase();
    const vendors = fakeVendors({ clock: () => clock });
    vendors.ss.autoSucceed = true;
    const name = t.domain('pending');
    await purchase([name]);
    for (let i = 0; i < 4; i++) await tick();
    expect(await statusOf(name)).toBe('ns_set');
    for (let i = 0; i < 5; i++) await tick();
    const item = await itemByDomain(name);
    expect(item).toMatchObject({ status: 'ns_set', zoneStatus: 'pending', lastError: '' });
    expect(item.stepAttempts).toBeGreaterThanOrEqual(5);
    expect(vendors.cfCalls.filter((call) => call.endsWith('/activation_check'))).toHaveLength(1);
    expect(vendors.cfCalls.some((call) => call.includes('/email/routing'))).toBe(false);
    vendors.activateZones();
    await tick();
    expect(await statusOf(name)).toBe('zone_active');
  });

  it('异步操作失败 → failed(poll)，不算可能扣费，不允许重试，批次完成', async () => {
    clock = Date.now();
    const t = await setupPurchase();
    const vendors = fakeVendors({ clock: () => clock });
    const name = t.domain('opfail');
    const batchId = await purchase([name]);
    await tick(0);
    for (const op of vendors.ss.ops.values()) Object.assign(op, { status: 'failed', details: { reason: 'insufficientFunds' } });
    await tick();
    const view = (await getDomainBatch(runtime, batchId)).items![0]!;
    expect(view).toMatchObject({ status: 'failed', failedStep: 'poll', opStatus: 'failed', maybeCharged: false, actions: [] });
    expect(view.lastError).toContain('insufficientFunds');
    expect((await batchRow(batchId)).status).toBe('completed');
    expect(await expectAppError(retryDomainItem(runtime, admin, view.id), 'conflict')).toContain('重新报价');
    await tick();
    expect(vendors.ss.registerCalls).toEqual([name]);
  });

  it('注册明确被拒（422）→ failed(register)；429 退回 confirmed 稍后再试', async () => {
    clock = Date.now();
    const t = await setupPurchase();
    const vendors = fakeVendors({ clock: () => clock });
    const rejected = t.domain('rejected');
    const limited = t.domain('limited');
    vendors.ss.registerMode.set(rejected, '422');
    vendors.ss.registerMode.set(limited, '429');
    await purchase([rejected, limited]);
    await tick(0);
    expect(await itemByDomain(rejected)).toMatchObject({ status: 'failed', failedStep: 'register', errorCode: 'business.domainNotAvailable', vendorOperationId: 'abcdefgh12345678' });
    expect(await statusOf(limited)).toBe('confirmed');
    vendors.ss.registerMode.set(limited, 'ok');
    await tick(0.2);
    expect(await statusOf(limited)).toBe('confirmed');
    await tick(1);
    expect(await statusOf(limited)).toBe('registering');
    expect(vendors.ss.registerCalls).toEqual([rejected, limited, limited]);
  });

  it('注册超时 → unknown，永不自动重试；账户里查到后自动核对为 registered', async () => {
    clock = Date.now();
    const t = await setupPurchase();
    const vendors = fakeVendors({ clock: () => clock });
    const name = t.domain('timeout');
    vendors.ss.registerMode.set(name, 'timeout');
    const batchId = await purchase([name]);
    await tick(0);
    const view = (await getDomainBatch(runtime, batchId)).items![0]!;
    expect(view).toMatchObject({ status: 'unknown', maybeCharged: true, actions: ['resolve', 'refresh'] });
    expect(view.lastError).toContain('超时');
    for (let i = 0; i < 8; i++) await tick(31);
    expect(await statusOf(name)).toBe('unknown');
    expect(vendors.ss.registerCalls).toEqual([name]);
    expect(vendors.ss.calls.filter((call) => call === `GET /v1/domains/${name}`).length).toBeGreaterThanOrEqual(7);
    expect((await batchRow(batchId)).status).toBe('processing');

    vendors.ss.owned.set(name, { lifecycleStatus: 'registered', verificationStatus: null, suspensions: [], nameservers: [] });
    await tick(31);
    expect(await statusOf(name)).toBe('registered');
    expect(vendors.ss.registerCalls).toEqual([name]);
    const actions = (await db.select().from(adminAuditLogs).all()).filter((row) => row.target === name).map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(['domain_purchase.register', 'domain_purchase.register_unknown', 'domain_purchase.reconciled']));
  });

  it('5xx / 缺操作号 / CAS 后崩溃 → unknown，均只 POST 一次；管理员裁决需要实时证据', async () => {
    clock = Date.now();
    const t = await setupPurchase();
    const vendors = fakeVendors({ clock: () => clock });
    const fivexx = t.domain('fivexx');
    const noheader = t.domain('noheader');
    const crashed = t.domain('crashed');
    vendors.ss.registerMode.set(fivexx, '5xx');
    vendors.ss.registerMode.set(noheader, 'noheader');
    await purchase([fivexx, noheader, crashed]);
    // 模拟另一个副本在 CAS 之后、写回操作号之前崩溃
    const crashedItem = await itemByDomain(crashed);
    await env.db.prepare("UPDATE domain_purchase_items SET status = 'registering', register_attempted_at = ?1, lease_until = ?2 WHERE id = ?3")
      .bind(clock, clock + 300_000, crashedItem.id).run();
    await tick(0);
    expect(await statusOf(fivexx)).toBe('unknown');
    expect(await statusOf(noheader)).toBe('unknown');
    expect(await statusOf(crashed)).toBe('registering');
    await tick(6);
    expect(await statusOf(crashed)).toBe('unknown');
    for (let i = 0; i < 3; i++) await tick(31);
    expect(vendors.ss.registerCalls.sort()).toEqual([fivexx, noheader].sort());

    // mark_registered 需要账户里查得到
    const fiveItem = await itemByDomain(fivexx);
    await expectAppError(resolveDomainItem(runtime, admin, fiveItem.id, { action: 'mark_registered' }, '', deps()), 'conflict');
    // mark_not_registered 需要实时可注册
    const noheaderItem = await itemByDomain(noheader);
    vendors.ss.availability.set(noheader, 'taken');
    await expectAppError(resolveDomainItem(runtime, admin, noheaderItem.id, { action: 'mark_not_registered' }, '', deps()), 'conflict');
    vendors.ss.availability.delete(noheader);
    const resolved = await resolveDomainItem(runtime, admin, noheaderItem.id, { action: 'mark_not_registered' }, '', deps());
    expect(resolved).toMatchObject({ status: 'failed', failedStep: 'register', maybeCharged: false });
    vendors.ss.owned.set(fivexx, { lifecycleStatus: 'registered', verificationStatus: null, suspensions: [], nameservers: [] });
    expect((await resolveDomainItem(runtime, admin, fiveItem.id, { action: 'mark_registered' }, '', deps())).status).toBe('registered');
    expect(vendors.ss.registerCalls).toHaveLength(2);
  });

  it('账户里已有同名 zone → failed(zone) 拒绝接管；结果丢失后找回自己建的 zone 则接管；可重试', async () => {
    clock = Date.now();
    const t = await setupPurchase();
    const vendors = fakeVendors({ clock: () => clock });
    vendors.ss.autoSucceed = true;
    const foreign = t.domain('foreign');
    const ours = t.domain('ours');
    vendors.addExistingZone(foreign, clock - 30 * 24 * 60 * MINUTE);
    await purchase([foreign, ours]);
    await tick(0);
    await tick();
    expect(await statusOf(ours)).toBe('registered');
    // 我们的 zone 已建好但写回前「丢失」：假 CF 里有该 zone，条目记着刚尝试创建过
    const next = clock + 6 * MINUTE;
    vendors.addExistingZone(ours, next);
    const oursItem = await itemByDomain(ours);
    await env.db.prepare('UPDATE domain_purchase_items SET zone_create_attempted_at = ?1 WHERE id = ?2').bind(next, oursItem.id).run();
    await tick();
    const foreignItem = await itemByDomain(foreign);
    expect(foreignItem).toMatchObject({ status: 'failed', failedStep: 'zone' });
    expect(foreignItem.lastError).toContain('拒绝接管');
    expect(await itemByDomain(ours)).toMatchObject({ status: 'zone_created', cfZoneId: `zone-old-${ours}` });
    expect(vendors.cfCalls.filter((call) => call === 'POST /zones')).toHaveLength(0);

    // 已存在的 zone 被管理员删掉后重试即可继续
    vendors.zones.delete(`zone-old-${foreign}`);
    const retried = await retryDomainItem(runtime, admin, foreignItem.id);
    expect(retried.status).toBe('registered');
    await tick();
    expect(await statusOf(foreign)).toBe('zone_created');
    expect(vendors.cfCalls.filter((call) => call === 'POST /zones')).toHaveLength(1);
  });

  it('域名已在系统列表 → 直接视为完成，不重复添加', async () => {
    clock = Date.now();
    const t = await setupPurchase();
    const vendors = fakeVendors({ clock: () => clock });
    vendors.ss.autoSucceed = true;
    const name = t.domain('already');
    const other = `keep-${t.prefix}.com`;
    await purchase([name]);
    for (let i = 0; i < 4; i++) await tick();
    vendors.activateZones();
    await tick();
    await tick();
    expect(await statusOf(name)).toBe('routing_ready');
    // 管理员抢先手工加了这个域名
    const settings = await getSettingsFresh(env);
    await updateSettings(env, { domains: { list: [{ domain: other, public: true, perUserLimit: 0 }, { domain: name, public: true, perUserLimit: 3 }] }, expectedDomainsRevision: settings.domains.revision ?? 0 });
    await tick();
    expect(await statusOf(name)).toBe('domain_added');
    const after = await getSettingsFresh(env);
    expect(after.domains.list).toEqual([{ domain: other, public: true, perUserLimit: 0 }, { domain: name, public: true, perUserLimit: 3 }]);
    expect(after.domains.revision).toBe((settings.domains.revision ?? 0) + 1);
  });

  it('修订号冲突：重读后重试成功并保留并发写入；持续冲突则保持 routing_ready 下次再试', async () => {
    clock = Date.now();
    const t = await setupPurchase();
    const vendors = fakeVendors({ clock: () => clock });
    vendors.ss.autoSucceed = true;
    const name = t.domain('conflict');
    const concurrent = `concurrent-${t.prefix}.com`;
    await purchase([name]);
    for (let i = 0; i < 4; i++) await tick();
    vendors.activateZones();
    await tick();
    await tick();
    expect(await statusOf(name)).toBe('routing_ready');

    // 在 domains 的 CAS 语句执行前插入一次「管理员并发保存」，让本次修订号过期
    let interferences = 1;
    const realDb = env.db;
    const bumpRevision = async () => {
      const row = await realDb.prepare("SELECT value FROM settings WHERE key = 'domains'").first<{ value: string }>();
      const value = JSON.parse(row!.value) as { list: { domain: string }[]; revision?: number };
      if (!value.list.some((entry) => entry.domain === concurrent)) value.list.push({ domain: concurrent, public: false, perUserLimit: 0 } as never);
      value.revision = (value.revision ?? 0) + 1;
      await realDb.prepare("UPDATE settings SET value = ? WHERE key = 'domains'").bind(JSON.stringify(value)).run();
    };
    const racingDb = new Proxy(realDb, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!sql.includes("SELECT 'domains'")) return statement;
            return { bind: (...values: unknown[]) => ({ first: async () => {
              if (interferences-- > 0) await bumpRevision();
              return statement.bind(...values).first();
            } }) };
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as D1Database;
    const racing: Env = { ...runtime, db: racingDb };

    // 持续冲突（每次都被抢先）：保持 routing_ready，记错误，稍后再试
    interferences = 3;
    await tick(6, racing);
    const stuck = await itemByDomain(name);
    expect(stuck).toMatchObject({ status: 'routing_ready', stepAttempts: 1 });
    expect(stuck.lastError).toContain('并发');

    interferences = 1;
    await tick(6, racing);
    expect(await statusOf(name)).toBe('domain_added');
    const domains = (await getSettingsFresh(env)).domains.list.map((entry) => entry.domain);
    expect(domains).toContain(concurrent);
    expect(domains).toContain(name);
  });

  it('管理员刷新：一分钟内拒绝，之后推进一步且不发起注册；未启用时 cron 不做任何事', async () => {
    clock = Date.now();
    const t = await setupPurchase();
    const vendors = fakeVendors({ clock: () => clock });
    const name = t.domain('refresh');
    await purchase([name]);
    const item = await itemByDomain(name);
    await expectAppError(refreshDomainItem(runtime, admin, item.id, deps()), 'conflict');
    await tick(0);
    vendors.succeedAllOps();
    await expectAppError(refreshDomainItem(runtime, admin, item.id, deps()), 'rate_limited');
    clock += 2 * MINUTE;
    expect((await refreshDomainItem(runtime, admin, item.id, deps())).status).toBe('registered');
    expect(vendors.ss.registerCalls).toEqual([name]);

    await setupPurchase({ enabled: false });
    const before = vendors.fetchMock.mock.calls.length;
    expect(await tick()).toBe(0);
    expect(vendors.fetchMock.mock.calls.length).toBe(before);
  });
});

describe('域名采购 cron：确认后的有效期与复核', () => {
  it('确认后上限被设为 0：暂停不注册；恢复时已超报价有效期 → 注册前复核，涨价的作废（未扣费），未变的照常注册', async () => {
    clock = Date.now();
    const t = await setupPurchase();
    const vendors = fakeVendors({ clock: () => clock });
    const same = t.domain('same');
    const pricier = t.domain('pricier');
    const batchId = await purchase([same, pricier]);
    await patchSpaceship({ maxDailyCents: 0 });
    await tick(0);
    expect(vendors.ss.registerCalls).toEqual([]);
    expect(await itemByDomain(same)).toMatchObject({ status: 'confirmed', lastError: expect.stringContaining('暂停注册') });

    await patchSpaceship({ maxDailyCents: 50_000 });
    vendors.ss.prices.set(pricier, { final: '20.00', regular: '20.00' });
    await tick(20);
    expect(vendors.ss.registerCalls).toEqual([same]);
    expect(vendors.ss.availabilityCalls).toEqual(expect.arrayContaining([[same], [pricier]]));
    expect(await itemByDomain(pricier)).toMatchObject({ status: 'failed', failedStep: 'register', lastError: expect.stringContaining('价格已上涨') });
    expect(await statusOf(same)).toBe('registering');
    expect((await getDomainBatch(runtime, batchId)).items!.find((item) => item.domain === pricier)).toMatchObject({ maybeCharged: false, actions: [] });
  });

  it('确认后不再可注册 / 不再允许溢价 → 作废不注册', async () => {
    clock = Date.now();
    const t = await setupPurchase({ allowPremium: true });
    const vendors = fakeVendors({ clock: () => clock });
    const gone = t.domain('gone');
    const premium = t.domain('premium');
    vendors.ss.prices.set(premium, { final: '30.00', regular: '30.00', priceClass: 'premium' });
    const batch = await quoteDomainPurchase(runtime, admin, { domains: [gone, premium] }, '', deps());
    await confirmDomainBatch(runtime, admin, batch.id, { domains: [gone, premium], expectedTotalCents: 1298 + 3000 }, '', null, deps());
    await patchSpaceship({ enabled: false });
    clock += 20 * MINUTE;
    await patchSpaceship({ enabled: true, allowPremium: false });
    vendors.ss.availability.set(gone, 'taken');
    await tick(0);
    expect(vendors.ss.registerCalls).toEqual([]);
    expect(await itemByDomain(gone)).toMatchObject({ status: 'failed', failedStep: 'register', lastError: expect.stringContaining('不再可购买') });
    expect(await itemByDomain(premium)).toMatchObject({ status: 'failed', failedStep: 'register', lastError: expect.stringContaining('溢价') });
    expect((await batchRow(batch.id)).status).toBe('completed');
  });

  it('确认超过 24 小时仍未注册 → 作废；延后注册计入注册当时的 24 小时窗口', async () => {
    clock = Date.now();
    const t = await setupPurchase({ maxDailyCents: 3_000 });
    const vendors = fakeVendors({ clock: () => clock });
    const stale = t.domain('stale');
    const late = t.domain('late');
    await purchase([stale]);
    await patchSpaceship({ enabled: false });
    clock += 25 * 60 * MINUTE;
    await patchSpaceship({ enabled: true });
    await tick(0);
    expect(await itemByDomain(stale)).toMatchObject({ status: 'failed', failedStep: 'register', lastError: expect.stringContaining('超过 24 小时') });
    expect(vendors.ss.registerCalls).toEqual([]);

    // T 确认、T+23h 才注册：T+25h 时它仍在 24 小时台账里
    await purchase([late]);
    await patchSpaceship({ enabled: false });
    clock += 23 * 60 * MINUTE;
    await patchSpaceship({ enabled: true });
    await tick(0);
    expect(vendors.ss.registerCalls).toEqual([late]);
    clock += 2 * 60 * MINUTE;
    const next = [t.domain('next1'), t.domain('next2')];
    const batch = await quoteDomainPurchase(runtime, admin, { domains: next }, '', deps());
    expect(await expectAppError(confirmDomainBatch(runtime, admin, batch.id, { domains: next, expectedTotalCents: 2596 }, '', null, deps()), 'validation_failed'))
      .toContain('24 小时');
    await confirmDomainBatch(runtime, admin, batch.id, { domains: [next[0]!], expectedTotalCents: 1298 }, '', null, deps());
    expect((await batchRow(batch.id)).status).toBe('processing');
  });

  it('选中的域名全被其他批次抢先确认 → 本批次直接完成，不会永远停在 processing', async () => {
    clock = Date.now();
    const t = await setupPurchase();
    fakeVendors({ clock: () => clock });
    const name = t.domain('race');
    const first = await quoteDomainPurchase(runtime, admin, { domains: [name] }, '', deps());
    const second = await quoteDomainPurchase(runtime, admin, { domains: [name] }, '', deps());
    await confirmDomainBatch(runtime, admin, first.id, { domains: [name], expectedTotalCents: 1298 }, '', null, deps());
    const view = await confirmDomainBatch(runtime, admin, second.id, { domains: [name], expectedTotalCents: 1298 }, '', null, deps());
    expect(view.status).toBe('completed');
    expect(view.items![0]).toMatchObject({ status: 'skipped', skipReason: 'in_flight' });
    expect((await batchRow(first.id)).status).toBe('processing');
  });

  it('NS 超时从设置 NS 起算；超时失败后重试会重新设置 NS 并重新计时，生效后完成', async () => {
    clock = Date.now();
    const t = await setupPurchase();
    const vendors = fakeVendors({ clock: () => clock });
    vendors.ss.autoSucceed = true;
    const name = t.domain('nsretry');
    const batchId = await purchase([name]);
    for (let i = 0; i < 4; i++) await tick();
    expect(await statusOf(name)).toBe('ns_set');
    const setAt = (await itemByDomain(name)).nsSetAt!.getTime();
    expect(setAt).toBe(clock);

    await tick(7 * DAY_MIN - 60);
    expect(await statusOf(name)).toBe('ns_set');
    await tick(2 * 60);
    const failed = await itemByDomain(name);
    expect(failed).toMatchObject({ status: 'failed', failedStep: 'nameservers', lastError: expect.stringContaining('7 天') });
    expect((await batchRow(batchId)).status).toBe('completed');

    expect((await retryDomainItem(runtime, admin, failed.id)).status).toBe('zone_created');
    expect((await itemByDomain(name)).nsSetAt).toBeNull();
    expect((await batchRow(batchId)).status).toBe('processing');
    await tick();
    expect(await statusOf(name)).toBe('ns_set');
    expect(vendors.ss.nameserverCalls).toHaveLength(2);
    await tick();
    expect(await statusOf(name)).toBe('ns_set');
    vendors.activateZones();
    await tick();
    expect(await statusOf(name)).toBe('zone_active');
    await tick();
    await tick();
    expect(await statusOf(name)).toBe('domain_added');
    expect((await batchRow(batchId)).status).toBe('completed');
    expect(vendors.ss.registerCalls).toEqual([name]);
  });
});
