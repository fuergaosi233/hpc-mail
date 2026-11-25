import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { ok } from '../../lib/http.js';
import { apiKeyAuth, requireScope } from '../../middleware/api-key-auth.js';
import { getVisibleDomains } from '../../services/domain.js';
import type { AppContext } from '../../types.js';
import { createUploadRoutes } from '../uploads.js';
import v1Mailboxes from './mailboxes.js';
import v1Messages from './messages.js';
import v1Proxies from './proxies.js';
import { buildOpenApiSpec } from './openapi.js';

const app = new Hono<AppContext>();

// 仅对 /v1 开 CORS（允许 Authorization 头）
app.use(
  '*',
  cors({
    origin: '*',
    allowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    exposeHeaders: ['Link', 'X-Request-ID', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
  }),
);

app.get('/status', apiKeyAuth, (c) => {
  const key = c.get('apiKey')!;
  return ok(c, { status: 'operational', userId: key.userId, role: key.role, scopes: key.scopes });
});

// 与网页及认领校验共用用户的公共/专属规则。
app.get('/domains', apiKeyAuth, async (c) => {
  const key = c.get('apiKey')!;
  return ok(c, { domains: await getVisibleDomains(c.env, key.userId) });
});

/** OpenAPI 描述（公开，无需 key） */
app.get('/openapi.json', (c) => c.json(buildOpenApiSpec(new URL(c.req.url).origin)));

app.route('/mailboxes', v1Mailboxes);
app.route('/messages', v1Messages);
app.route('/proxies', v1Proxies);
app.route('/uploads', createUploadRoutes(apiKeyAuth, async (c, next) => {
  requireScope(c, 'mail.send');
  await next();
}));

export default app;
