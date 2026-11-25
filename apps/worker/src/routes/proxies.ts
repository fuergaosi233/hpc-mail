import { Hono } from 'hono';
import { ok } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { listMyProxies } from '../services/proxy-inventory.js';
import type { AppContext } from '../types.js';

/** 当前用户自己认领地址绑定的代理（共享给我的邮箱不含代理凭据） */
const app = new Hono<AppContext>();
app.use('*', requireAuth);

app.get('/mine', async (c) => {
  c.header('Cache-Control', 'no-store');
  return ok(c, { items: await listMyProxies(c.env, c.get('user')!.id) });
});

export default app;
