import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { Hono } from 'hono';
import { expect } from 'vitest';
import { createDb } from '../../../src/db/client.js';
import { mailboxes, users } from '../../../src/db/schema.js';
import { signToken } from '../../../src/lib/jwt.js';
import { AppError } from '../../../src/lib/errors.js';
import { onError, requestId } from '../../../src/middleware/error.js';
import adminProxies from '../../../src/routes/admin/proxies.js';
import adminProxy1024 from '../../../src/routes/admin/proxy-1024.js';
import proxies from '../../../src/routes/proxies.js';
import v1Proxies from '../../../src/routes/v1/proxies.js';
import { createApiKey } from '../../../src/services/api-key.js';
import { createSession } from '../../../src/services/session.js';
import type { AppContext } from '../../../src/types.js';

/** 本切片的路由挂在本地 Hono 上测试（不改 app.ts；集成由 INTEGRATOR 完成） */
export function proxyTestApp() {
  const app = new Hono<AppContext>();
  app.use('*', requestId);
  app.onError(onError);
  app.notFound((c) => onError(new AppError('not_found', '接口不存在'), c));
  app.route('/api/admin/proxies', adminProxies);
  app.route('/api/admin/proxy-1024', adminProxy1024);
  app.route('/api/proxies', proxies);
  app.route('/v1/proxies', v1Proxies);
  return app;
}

const app = proxyTestApp();
const rand = () => crypto.randomUUID().slice(0, 8);

export async function call(method: string, path: string, token: string, body?: unknown) {
  const ctx = createExecutionContext();
  const response = await app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

export async function data<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json() as { data: T; error?: { code: string; message: string } };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body.data;
}

export async function failure(response: Response, status: number, code?: string): Promise<string> {
  const body = await response.json() as { error: { code: string; message: string } };
  expect(response.status, JSON.stringify(body)).toBe(status);
  if (code) expect(body.error.code).toBe(code);
  return body.error.message;
}

export interface TestActor { id: number; username: string; role: 'admin' | 'user'; jwt: string }

export async function makeUser(prefix: string, role: 'admin' | 'user' = 'user'): Promise<TestActor> {
  const user = (await createDb(env).insert(users).values({ username: `${prefix}-${rand()}`, role, passwordHash: 'x', status: 'active', authVersionMigrated: true }).returning().get())!;
  const sid = await createSession(env, user.id);
  const jwt = await signToken(env.jwt_secret, { sub: user.id, sid, epoch: 0, uepoch: 0 });
  return { id: user.id, username: user.username, role, jwt };
}

export async function claim(userId: number, address: string): Promise<number> {
  const domain = address.slice(address.indexOf('@') + 1);
  const row = await createDb(env).insert(mailboxes).values({ address, domain, userId }).returning({ id: mailboxes.id }).get();
  return row!.id;
}

export async function apiKey(userId: number, scopes: ('proxy.read' | 'mail.read' | 'mailbox.read')[]): Promise<string> {
  const created = await createApiKey(env, userId, { name: `proxy-${rand()}`, scopes, rateLimit: 1000, allowedIps: [] });
  return created.key;
}

export { rand };
