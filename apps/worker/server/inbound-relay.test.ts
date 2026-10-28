import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { receiveRelay } from './inbound-relay.js';
import { db, env, createExecutionContext, waitOnExecutionContext } from './test-env.js';
import { updateSettings } from '../src/services/setting.js';

const secret = 'test-inbound-relay-secret-not-a-production-credential';
const raw = 'From: sender@example.net\r\nTo: holegots@multi-agent.wiki\r\nSubject: Deployment test\r\nMessage-ID: <relay-test@example.net>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nYour verification code is 654987.\r\n';
function request(options: { timestamp?: string; to?: string; tamper?: boolean; signature?: string } = {}) {
  const timestamp = options.timestamp ?? String(Date.now()), from = 'sender@example.net', to = options.to ?? 'holegots@multi-agent.wiki';
  const signature = createHmac('sha256', secret).update(`${timestamp}\n${from}\n${to}\n${createHash('sha256').update(raw).digest('hex')}`).digest('hex');
  return new Request('https://mail.multi-agent.wiki/internal/email', { method: 'POST', body: options.tamper ? raw + 'tampered' : raw,
    headers: { 'x-hpc-timestamp': timestamp, 'x-hpc-from': encodeURIComponent(from), 'x-hpc-to': encodeURIComponent(to), 'x-hpc-content-sha256': createHash('sha256').update(raw).digest('hex'), 'x-hpc-signature': options.signature ?? signature } });
}
describe('Authenticated incoming mail relay', () => {
  it('rejects missing, invalid, stale and tampered authentication', async () => {
    for (const options of [{ signature: '' }, { signature: '0'.repeat(64) }, { timestamp: String(Date.now() - 301000) }, { tamper: true }]) {
      expect((await receiveRelay(request(options), env, secret, createExecutionContext())).status).toBe(401);
    }
    expect((await receiveRelay(request(), env, undefined, createExecutionContext())).status).toBe(404);
  });
  it('commits mail before acknowledging and deduplicates a delivery retry', async () => {
    await db.prepare("INSERT INTO users (username,password_hash,role,status) VALUES ('relay-admin','test','admin','active')").run();
    await updateSettings(env, { domains: { list: [{ domain: 'multi-agent.wiki', public: false, perUserLimit: 0 }] } });
    const ctx = createExecutionContext();
    expect((await receiveRelay(request(), env, secret, ctx)).status).toBe(200);
    expect((await db.prepare('SELECT verification_code FROM messages').all()).results).toEqual([{ verification_code: '654987' }]);
    expect((await receiveRelay(request(), env, secret, ctx)).status).toBe(200);
    expect((await db.prepare('SELECT COUNT(*) AS count FROM messages').first<{ count: number }>())!.count).toBe(1);
    await waitOnExecutionContext(ctx);
  });
  it('rejects a recipient outside the configured domains', async () => {
    expect((await receiveRelay(request({ to: 'someone@example.org' }), env, secret, createExecutionContext())).status).toBe(422);
  });
});
