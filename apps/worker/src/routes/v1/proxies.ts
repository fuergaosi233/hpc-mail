import { v1ProxyListQuerySchema, v1ProxyLookupQuerySchema } from '@hpc-mail/shared';
import { Hono } from 'hono';
import { ok, parseQuery } from '../../lib/http.js';
import { apiKeyAuth, requireScope } from '../../middleware/api-key-auth.js';
import { listViewerProxies, lookupProxyForViewer } from '../../services/proxy-inventory.js';
import type { AppContext } from '../../types.js';

/**
 * /v1/proxies（API Key，scope proxy.read）：只读。
 * 非管理员 Key 只能看自己认领的地址（共享给我的不算）；管理员 Key 可查任意地址，all=1 列全站。
 */
const app = new Hono<AppContext>();
app.use('*', apiKeyAuth);

app.get('/lookup', async (c) => {
  requireScope(c, 'proxy.read');
  const key = c.get('apiKey')!;
  const { address } = parseQuery(c, v1ProxyLookupQuerySchema);
  c.header('Cache-Control', 'no-store');
  return ok(c, await lookupProxyForViewer(c.env, { userId: key.userId, role: key.role }, address));
});

app.get('/', async (c) => {
  requireScope(c, 'proxy.read');
  const key = c.get('apiKey')!;
  const query = parseQuery(c, v1ProxyListQuerySchema);
  c.header('Cache-Control', 'no-store');
  return ok(c, await listViewerProxies(c.env, { userId: key.userId, role: key.role }, query));
});

export default app;
