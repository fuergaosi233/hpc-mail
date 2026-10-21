import {
  createHostedDomainRequestSchema, replaceHostedDomainMembersRequestSchema, transferHostedDomainRequestSchema,
  updateHostedDomainRequestSchema,
} from '@hpc-mail/shared';
import { Hono } from 'hono';
import { clientIp, execCtx, ok, parseBody, parseId } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import {
  checkHostedDomain, createHostedDomain, deleteHostedDomain, getHostedDomain, listHostedDomainMembers, listMyHostedDomains,
  removeHostedDomainMember, replaceHostedDomainMembers, transferHostedDomain, updateHostedDomain,
} from '../services/hosted-domain.js';
import type { AppContext } from '../types.js';

/** 托管域名（JWT）：所有者与管理员管理，成员只读并可退出共享；没有权限的域名一律 404 */
const app = new Hono<AppContext>();
app.use('*', requireAuth);

app.get('/', async (c) => ok(c, await listMyHostedDomains(c.env, c.get('user')!)));

app.post('/', async (c) => {
  const req = await parseBody(c, createHostedDomainRequestSchema);
  return ok(c, await createHostedDomain(c.env, c.get('user')!, req.domain, execCtx(c), clientIp(c)), 201);
});

app.get('/:id', async (c) => ok(c, await getHostedDomain(c.env, c.get('user')!, parseId(c.req.param('id')))));

app.post('/:id/check', async (c) => ok(c, await checkHostedDomain(c.env, c.get('user')!, parseId(c.req.param('id')))));

app.put('/:id', async (c) => {
  const req = await parseBody(c, updateHostedDomainRequestSchema);
  return ok(c, await updateHostedDomain(c.env, c.get('user')!, parseId(c.req.param('id')), req.memberLimit, clientIp(c)));
});

app.delete('/:id', async (c) => {
  await deleteHostedDomain(c.env, c.get('user')!, parseId(c.req.param('id')), execCtx(c), clientIp(c));
  return ok(c, { success: true });
});

app.get('/:id/members', async (c) => ok(c, await listHostedDomainMembers(c.env, c.get('user')!, parseId(c.req.param('id')))));

app.put('/:id/members', async (c) => {
  const req = await parseBody(c, replaceHostedDomainMembersRequestSchema);
  return ok(c, await replaceHostedDomainMembers(c.env, c.get('user')!, parseId(c.req.param('id')),
    req.userIds, req.expectedOwnerId, clientIp(c)));
});

app.delete('/:id/members/:userId', async (c) => {
  await removeHostedDomainMember(c.env, c.get('user')!, parseId(c.req.param('id')), parseId(c.req.param('userId')), clientIp(c));
  return ok(c, { success: true });
});

app.post('/:id/transfer', async (c) => {
  const req = await parseBody(c, transferHostedDomainRequestSchema);
  return ok(c, await transferHostedDomain(c.env, c.get('user')!, parseId(c.req.param('id')), req, clientIp(c)));
});

export default app;
