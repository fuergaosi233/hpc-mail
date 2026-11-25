import { DEFAULT_SETTINGS, SECRET_MASK, type Settings } from '@hpc-mail/shared';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import { minuteWindow } from '../src/services/rate-counter.js';
import { runScheduled } from '../src/services/scheduled.js';
import { createSession } from '../src/services/session.js';
import { updateSettings } from '../src/services/setting.js';

/** INTEGRATOR wiring: mounted routes, scheduled steps, counter cleanup and the 1024 session-state reset. */
const app = createApp();
const db = createDb(env);

const proxy1024 = (patch: Partial<Settings['proxy1024']> = {}): Settings['proxy1024'] => ({
  enabled: false, email: '', password: '', sessionToken: '', lang: 'en', maxOrderCents: 0, maxDailyCents: 0, quoteTtlMinutes: 15, ...patch,
});

let seq = 0;
async function jwtFor(role: 'admin' | 'user') {
  const user = (await db.insert(users).values({ username: `integ-${role}-${++seq}`, role, passwordHash: 'test', authVersionMigrated: true }).returning().get())!;
  const sid = await createSession(env, user.id);
  return signToken(env.jwt_secret, { sub: user.id, sid, epoch: 0, uepoch: 0 });
}

async function request(path: string, jwt?: string) {
  const ctx = createExecutionContext();
  const response = await app.request(path, { headers: jwt ? { Authorization: `Bearer ${jwt}` } : {} }, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function integrationState(): Promise<string | null> {
  const row = await env.db.prepare("SELECT state FROM integration_status WHERE provider = 'proxy1024'").first<{ state: string }>();
  return row?.state ?? null;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('procurement routes are mounted', () => {
  it('serves the admin, user and /v1 routers with their own authentication', async () => {
    const adminJwt = await jwtFor('admin');
    const userJwt = await jwtFor('user');

    for (const path of ['/api/admin/proxies', '/api/admin/proxies/stats', '/api/admin/proxy-1024/orders', '/api/admin/domain-purchases', '/api/admin/domain-purchases/status']) {
      const response = await request(path, adminJwt);
      expect(response.status, path).toBe(200);
      expect(await response.json(), path).toHaveProperty('data');
      expect((await request(path, userJwt)).status, path).toBe(403);
      expect((await request(path)).status, path).toBe(401);
    }

    const mine = await request('/api/proxies/mine', userJwt);
    expect(mine.status).toBe(200);
    expect(await mine.json()).toEqual({ data: { items: [] } });

    // /v1 takes API keys only; a JWT is not an API key
    expect((await request('/v1/proxies/lookup?address=a@example.com')).status).toBe(401);
    expect((await request('/v1/proxies', userJwt)).status).toBe(401);
  });
});

describe('scheduled hooks', () => {
  it('runs the three procurement steps without any vendor call while the features are off', async () => {
    await updateSettings(env, { proxy1024: proxy1024(), spaceship: { ...DEFAULT_SETTINGS.spaceship } });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      throw new Error(`unexpected fetch ${String(input instanceof Request ? input.url : input)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runScheduled(env, false);

    const report = log.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('"event":"scheduled"')).map((line) => JSON.parse(line) as {
      steps: { step: string; failed?: true }[];
    }).at(-1)!;
    const steps = report.steps.filter((entry) => ['proxy.expire', 'proxy_1024.reconcile', 'domain_purchase.advance'].includes(entry.step));
    expect(steps.map((entry) => entry.step)).toEqual(['proxy.expire', 'proxy_1024.reconcile', 'domain_purchase.advance']);
    expect(steps.every((entry) => !entry.failed)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('daily maintenance purges stale proxy and domain-purchase rate counters', async () => {
    const stale = minuteWindow(1) - 500;
    const fresh = minuteWindow(1);
    const scopes = ['proxy.export', 'proxy_1024.confirm', 'admin.domain_purchase.quote', 'admin.domain_purchase.confirm'];
    for (const scope of scopes) {
      for (const window of [stale, fresh]) {
        await env.db.prepare('INSERT INTO rate_counters (scope, subject, "window", count, units) VALUES (?, ?, ?, 1, 0)').bind(scope, 'integ', window).run();
      }
    }
    await env.db.prepare('INSERT INTO rate_counters (scope, subject, "window", count, units) VALUES (?, ?, ?, 1, 0)')
      .bind('spaceship.poll', 'integ', minuteWindow(5) - 100).run();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unexpected fetch'); }));

    await runScheduled(env, true);

    // 排序放在 JS 里：PostgreSQL 的排序规则与 SQLite 的二进制比较对 '.' / '_' 的先后不同
    const { results } = await env.db.prepare(`SELECT scope, "window" AS w FROM rate_counters WHERE subject = 'integ'`).all<{ scope: string; w: number }>();
    const remaining = results.map((row) => `${row.scope}@${Number(row.w)}`).sort();
    expect(remaining).toEqual(scopes.map((scope) => `${scope}@${fresh}`).sort());
  });
});

describe('1024 session state after a token change', () => {
  it('clears the invalid marker when a new token is saved, and keeps it when the token is unchanged', async () => {
    await updateSettings(env, { proxy1024: proxy1024({ enabled: true, sessionToken: 'first-token' }) });
    await env.db.prepare(`INSERT INTO integration_status (provider, state, detail, balance_cents, checked_at) VALUES ('proxy1024', 'invalid', 'expired', 1234, ?)
      ON CONFLICT(provider) DO UPDATE SET state = excluded.state, detail = excluded.detail`).bind(Date.now()).run();

    // Masked echo or an unrelated edit keeps the stored token: the cron must keep treating it as invalid
    await updateSettings(env, { proxy1024: proxy1024({ enabled: true, sessionToken: SECRET_MASK, maxOrderCents: 100 }) });
    expect(await integrationState()).toBe('invalid');

    await updateSettings(env, { proxy1024: proxy1024({ enabled: true, sessionToken: 'second-token' }) });
    expect(await integrationState()).toBe('unknown');
    const row = await env.db.prepare("SELECT detail, balance_cents FROM integration_status WHERE provider = 'proxy1024'").first<{ detail: string; balance_cents: number }>();
    expect(row).toMatchObject({ detail: '' });
    expect(Number(row!.balance_cents)).toBe(1234);
  });
});
