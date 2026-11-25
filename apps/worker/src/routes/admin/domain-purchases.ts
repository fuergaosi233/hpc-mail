import {
  domainConfirmRequestSchema, domainItemResolveRequestSchema, domainQuoteRequestSchema, listDomainBatchesQuerySchema,
  registrantContactRequestSchema,
} from '@hpc-mail/shared';
import { Hono, type MiddlewareHandler } from 'hono';
import { AppError } from '../../lib/errors.js';
import { clientIp, execCtx, ok, parseBody, parseId, parseQuery } from '../../lib/http.js';
import { requireAdmin, requireAuth } from '../../middleware/auth.js';
import {
  cancelDomainBatch, confirmDomainBatch, domainPurchaseStatus, getDomainBatch, listDomainBatches, quoteDomainPurchase,
  refreshDomainItem, resolveDomainItem, retryDomainItem, saveRegistrantContact, testSpaceshipCredentials,
  type DomainPurchaseRateScope,
} from '../../services/domain-purchase.js';
import { bumpCounter, minuteWindow } from '../../services/rate-counter.js';
import type { AppContext } from '../../types.js';

/** 每个管理员每分钟最多 max 次 */
function perMinute(name: DomainPurchaseRateScope extends `admin.domain_purchase.${infer N}` ? N : never, max: number): MiddlewareHandler<AppContext> {
  const scope: DomainPurchaseRateScope = `admin.domain_purchase.${name}`;
  return async (c, next) => {
    const value = await bumpCounter(c.env, scope, String(c.get('user')!.id), minuteWindow(1));
    if (value.count > max) throw new AppError('rate_limited', '操作过于频繁，请稍后再试');
    await next();
  };
}

/** Spaceship 批量采购域名（挂载到 /api/admin/domain-purchases；只用管理员 JWT，不进 /v1） */
const app = new Hono<AppContext>();
app.use('*', requireAuth, requireAdmin);

app.get('/status', async (c) => ok(c, await domainPurchaseStatus(c.env)));

app.post('/test-credentials', perMinute('test', 6), async (c) => ok(c, await testSpaceshipCredentials(c.env, c.get('user')!)));

app.post('/contact', perMinute('contact', 3), async (c) => {
  const body = await parseBody(c, registrantContactRequestSchema);
  return ok(c, await saveRegistrantContact(c.env, c.get('user')!, body, clientIp(c)));
});

app.post('/quotes', perMinute('quote', 10), async (c) => {
  const body = await parseBody(c, domainQuoteRequestSchema);
  return ok(c, await quoteDomainPurchase(c.env, c.get('user')!, body, clientIp(c)), 201);
});

app.post('/items/:itemId/retry', async (c) => ok(c, await retryDomainItem(c.env, c.get('user')!, parseId(c.req.param('itemId')), clientIp(c))));

app.post('/items/:itemId/resolve', async (c) => {
  const body = await parseBody(c, domainItemResolveRequestSchema);
  return ok(c, await resolveDomainItem(c.env, c.get('user')!, parseId(c.req.param('itemId')), body, clientIp(c)));
});

app.post('/items/:itemId/refresh', perMinute('refresh', 10), async (c) => (
  ok(c, await refreshDomainItem(c.env, c.get('user')!, parseId(c.req.param('itemId'))))
));

app.get('/', async (c) => ok(c, await listDomainBatches(c.env, parseQuery(c, listDomainBatchesQuerySchema))));

app.get('/:id', async (c) => ok(c, await getDomainBatch(c.env, parseId(c.req.param('id')))));

app.post('/:id/confirm', perMinute('confirm', 5), async (c) => {
  const body = await parseBody(c, domainConfirmRequestSchema);
  return ok(c, await confirmDomainBatch(c.env, c.get('user')!, parseId(c.req.param('id')), body, clientIp(c), execCtx(c)));
});

app.post('/:id/cancel', async (c) => ok(c, await cancelDomainBatch(c.env, c.get('user')!, parseId(c.req.param('id')), clientIp(c))));

export default app;
