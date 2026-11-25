import {
  listProxyOrdersQuerySchema,
  proxy1024ConfirmRequestSchema,
  proxy1024GenerateStickyRequestSchema,
  proxy1024LoginRequestSchema,
  proxy1024QuoteRequestSchema,
  proxy1024ResolveRequestSchema,
  proxy1024SyncRequestSchema,
} from '@hpc-mail/shared';
import { Hono, type Context } from 'hono';
import { AppError } from '../../lib/errors.js';
import { clientIp, ok, parseBody, parseBooleanFlag, parseId, parseQuery } from '../../lib/http.js';
import { requireAdmin, requireAuth } from '../../middleware/auth.js';
import {
  allocateStaticForOrder, cancelProxyOrder, completeProxy1024Login, confirmProxyOrder, generateStickyProxies, getProxy1024Catalogue,
  getProxyOrder, listProxy1024SubUsers, listProxyOrders, proxy1024Status, quoteProxyOrder, refreshProxyOrder, resolveProxyOrder,
  startProxy1024Login, syncProxy1024Inventory,
} from '../../services/proxy-purchase.js';
import type { ProxyRateScope } from '../../services/proxy-inventory.js';
import { bumpCounter, minuteWindow } from '../../services/rate-counter.js';
import type { AppContext } from '../../types.js';

async function limitPerMinute(c: Context<AppContext>, scope: ProxyRateScope, max: number): Promise<void> {
  const { count } = await bumpCounter(c.env, scope, String(c.get('user')!.id), minuteWindow(1));
  if (count > max) throw new AppError('rate_limited', '操作过于频繁，请稍后再试');
}

/** 1024proxy 采购（管理员 JWT；/v1 上没有任何采购接口） */
const app = new Hono<AppContext>();
app.use('*', requireAuth, requireAdmin);

app.get('/status', async (c) => {
  const live = parseBooleanFlag(c.req.query('live'));
  if (live) await limitPerMinute(c, 'proxy_1024.status', 6);
  return ok(c, await proxy1024Status(c.env, { live }));
});

app.post('/login/captcha', async (c) => {
  await limitPerMinute(c, 'proxy_1024.login', 6);
  c.header('Cache-Control', 'no-store');
  return ok(c, await startProxy1024Login(c.env, c.get('user')!));
});

app.post('/login', async (c) => {
  const req = await parseBody(c, proxy1024LoginRequestSchema);
  await limitPerMinute(c, 'proxy_1024.login', 6);
  return ok(c, await completeProxy1024Login(c.env, c.get('user')!, req, clientIp(c)));
});

app.get('/catalogue', async (c) => ok(c, await getProxy1024Catalogue(c.env)));

app.get('/sub-users', async (c) => ok(c, { items: await listProxy1024SubUsers(c.env) }));

app.post('/quotes', async (c) => {
  const req = await parseBody(c, proxy1024QuoteRequestSchema);
  await limitPerMinute(c, 'proxy_1024.quote', 10);
  return ok(c, await quoteProxyOrder(c.env, c.get('user')!, req, clientIp(c)), 201);
});

app.get('/orders', async (c) => ok(c, await listProxyOrders(c.env, parseQuery(c, listProxyOrdersQuerySchema))));

app.get('/orders/:id', async (c) => {
  c.header('Cache-Control', 'no-store');
  return ok(c, await getProxyOrder(c.env, parseId(c.req.param('id'))));
});

app.post('/orders/:id/confirm', async (c) => {
  const id = parseId(c.req.param('id'));
  const req = await parseBody(c, proxy1024ConfirmRequestSchema);
  await limitPerMinute(c, 'proxy_1024.confirm', 5);
  return ok(c, await confirmProxyOrder(c.env, c.get('user')!, id, req, clientIp(c)));
});

app.post('/orders/:id/cancel', async (c) => ok(c, await cancelProxyOrder(c.env, c.get('user')!, parseId(c.req.param('id')), clientIp(c))));

app.post('/orders/:id/refresh', async (c) => {
  const id = parseId(c.req.param('id'));
  await limitPerMinute(c, 'proxy_1024.refresh', 10);
  return ok(c, await refreshProxyOrder(c.env, c.get('user')!, id));
});

app.post('/orders/:id/resolve', async (c) => {
  const id = parseId(c.req.param('id'));
  const req = await parseBody(c, proxy1024ResolveRequestSchema);
  return ok(c, await resolveProxyOrder(c.env, c.get('user')!, id, req, clientIp(c)));
});

app.post('/orders/:id/allocate', async (c) => {
  const id = parseId(c.req.param('id'));
  await limitPerMinute(c, 'proxy_1024.allocate', 3);
  return ok(c, await allocateStaticForOrder(c.env, c.get('user')!, id, clientIp(c)));
});

app.post('/sync', async (c) => {
  const req = await parseBody(c, proxy1024SyncRequestSchema);
  await limitPerMinute(c, 'proxy_1024.sync', 3);
  return ok(c, await syncProxy1024Inventory(c.env, c.get('user')!, req, clientIp(c)));
});

app.post('/generate-sticky', async (c) => {
  const req = await parseBody(c, proxy1024GenerateStickyRequestSchema);
  return ok(c, await generateStickyProxies(c.env, c.get('user')!, req, clientIp(c)), 201);
});

export default app;
