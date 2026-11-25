import {
  autoAssignRequestSchema,
  bindProxyRequestSchema,
  exportProxiesQuerySchema,
  importProxiesRequestSchema,
  listBindingsQuerySchema,
  listProxiesQuerySchema,
  lookupBindingsRequestSchema,
  proxyHealthReportSchema,
  proxyInputSchema,
  updateProxyRequestSchema,
} from '@hpc-mail/shared';
import { Hono, type Context } from 'hono';
import { AppError } from '../../lib/errors.js';
import { clientIp, ok, parseBody, parseBooleanFlag, parseId, parseQuery } from '../../lib/http.js';
import { requireAdmin, requireAuth } from '../../middleware/auth.js';
import {
  autoAssignProxies, bindAddress, createProxy, deleteProxy, exportProxies, getProxy, importProxies, listBindings, listProxies,
  lookupBindings, proxyPoolStats, reportProxyHealth, revealProxy, unbindAddress, updateProxy, type ProxyRateScope,
} from '../../services/proxy-inventory.js';
import { bumpCounter, minuteWindow } from '../../services/rate-counter.js';
import type { AppContext } from '../../types.js';

/** 每位管理员每分钟限额（rate_counters，跨副本共享） */
async function limitPerMinute(c: Context<AppContext>, scope: ProxyRateScope, max: number): Promise<void> {
  const { count } = await bumpCounter(c.env, scope, String(c.get('user')!.id), minuteWindow(1));
  if (count > max) throw new AppError('rate_limited', '操作过于频繁，请稍后再试');
}

/** :address 路径参数（URL 编码的完整邮箱地址） */
function addressParam(c: Context<AppContext>): string {
  const raw = c.req.param('address') ?? '';
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new AppError('validation_failed', '邮箱地址格式非法');
  }
}

/** 代理库存与地址绑定（管理员 JWT）。静态路径先于 /:id 注册。 */
const app = new Hono<AppContext>();
app.use('*', requireAuth, requireAdmin);

app.get('/', async (c) => ok(c, await listProxies(c.env, parseQuery(c, listProxiesQuerySchema))));

app.get('/stats', async (c) => ok(c, await proxyPoolStats(c.env)));

app.post('/', async (c) => ok(c, await createProxy(c.env, c.get('user')!, await parseBody(c, proxyInputSchema), clientIp(c)), 201));

app.post('/import', async (c) => ok(c, await importProxies(c.env, c.get('user')!, await parseBody(c, importProxiesRequestSchema), clientIp(c))));

app.get('/export', async (c) => {
  const query = parseQuery(c, exportProxiesQuerySchema);
  await limitPerMinute(c, 'proxy.export', 6);
  return ok(c, await exportProxies(c.env, c.get('user')!, query, clientIp(c)));
});

app.post('/auto-assign', async (c) => {
  const req = await parseBody(c, autoAssignRequestSchema);
  await limitPerMinute(c, 'proxy.auto_assign', 10);
  return ok(c, await autoAssignProxies(c.env, c.get('user')!, req, clientIp(c)));
});

app.get('/bindings', async (c) => ok(c, await listBindings(c.env, parseQuery(c, listBindingsQuerySchema))));

app.post('/bindings/lookup', async (c) => {
  const req = await parseBody(c, lookupBindingsRequestSchema);
  return ok(c, { items: await lookupBindings(c.env, req.addresses) });
});

app.put('/bindings/:address', async (c) => {
  const req = await parseBody(c, bindProxyRequestSchema);
  return ok(c, await bindAddress(c.env, c.get('user')!, addressParam(c), req.proxyId, clientIp(c)));
});

app.delete('/bindings/:address', async (c) => {
  await unbindAddress(c.env, c.get('user')!, addressParam(c), clientIp(c));
  return ok(c, { ok: true as const });
});

app.get('/:id', async (c) => ok(c, await getProxy(c.env, parseId(c.req.param('id')))));

app.put('/:id', async (c) => {
  const id = parseId(c.req.param('id'));
  return ok(c, await updateProxy(c.env, c.get('user')!, id, await parseBody(c, updateProxyRequestSchema), clientIp(c)));
});

app.delete('/:id', async (c) => {
  const id = parseId(c.req.param('id'));
  await deleteProxy(c.env, c.get('user')!, id, parseBooleanFlag(c.req.query('force')), clientIp(c));
  return ok(c, { ok: true as const });
});

app.post('/:id/reveal', async (c) => {
  const id = parseId(c.req.param('id'));
  await limitPerMinute(c, 'proxy.reveal', 30);
  c.header('Cache-Control', 'no-store');
  return ok(c, await revealProxy(c.env, c.get('user')!, id, clientIp(c)));
});

app.post('/:id/health', async (c) => {
  const id = parseId(c.req.param('id'));
  return ok(c, await reportProxyHealth(c.env, id, await parseBody(c, proxyHealthReportSchema)));
});

export default app;
