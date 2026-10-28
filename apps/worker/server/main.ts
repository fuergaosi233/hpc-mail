import { serve } from '@hono/node-server';
import { SMTPServer } from 'smtp-server';
import nodemailer from 'nodemailer';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { randomBytes, pbkdf2Sync, createHash } from 'node:crypto';
import { isIP } from 'node:net';
import worker from '../src/index.js';
import { handleInbound } from '../src/services/inbound.js';
import { runScheduled } from '../src/services/scheduled.js';
import { getRoutableDomains } from '../src/services/domain.js';
import { updateSettings } from '../src/services/setting.js';
import { claimMailbox } from '../src/services/mailbox.js';
import { receiveRelay } from './inbound-relay.js';
import { PostgresDatabase } from './postgres.js';
import { FileBucket, PostgresKV } from './storage.js';
import type { Env } from '../src/types.js';

if (!process.env.DATABASE_URL || !process.env.JWT_SECRET) throw new Error('DATABASE_URL and JWT_SECRET are required');
const db = new PostgresDatabase(process.env.DATABASE_URL);
await db.migrate(process.env.MIGRATIONS_DIR ?? new URL('../migrations', import.meta.url).pathname);
const allowedDomains = (process.env.MAIL_DOMAINS ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
const staticRoot = resolve(process.env.ASSETS_DIR ?? new URL('../dist', import.meta.url).pathname);
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2' };
const transport = process.env.SMTP_RELAY_URL ? nodemailer.createTransport(process.env.SMTP_RELAY_URL) : null;
async function send(message: { from: string; to: string; raw: string | ReadableStream }) {
  if (!transport) throw new Error('External delivery requires an SMTP relay; SMTP_RELAY_URL is not configured');
  const raw = typeof message.raw === 'string' ? message.raw : Buffer.from(await new Response(message.raw).arrayBuffer());
  await transport.sendMail({ envelope: { from: message.from, to: message.to }, raw });
}
const env = {
  db, kv: new PostgresKV(db), r2: new FileBucket(process.env.OBJECTS_DIR ?? '/data/objects'),
  jwt_secret: process.env.JWT_SECRET, site_origin: process.env.SITE_ORIGIN,
  build_sha: process.env.BUILD_SHA ?? 'k3s-postgres', email: { send },
  assets: { async fetch(request: Request) {
    let pathname: string;
    try { pathname = decodeURIComponent(new URL(request.url).pathname); } catch { return new Response('Bad Request', { status: 400 }); }
    const file = resolve(staticRoot, '.' + pathname);
    if (file !== staticRoot && !file.startsWith(staticRoot + sep)) return new Response('Forbidden', { status: 403 });
    try {
      if (!(await stat(file)).isFile()) throw new Error('Not a file');
      const data = await readFile(file);
      const body = (pathname.endsWith('.md') || pathname === '/llms.txt') && process.env.SITE_ORIGIN
        ? data.toString('utf8').replaceAll('https://hpc.email', process.env.SITE_ORIGIN)
        : data;
      return new Response(body, { headers: { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream' } });
    } catch {
      if (pathname.startsWith('/assets/')) return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      return new Response(await readFile(resolve(staticRoot, 'index.html')), { headers: { 'Content-Type': mime['.html']! } });
    }
  } },
} as unknown as Env;

const adminName = process.env.ADMIN_USERNAME ?? 'holegots';
let admin = (await db.prepare("SELECT id, username FROM users WHERE role='admin' ORDER BY id LIMIT 1").all<{ id: number; username: string }>()).results[0];
if (!admin) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password || password.length < 12) throw new Error('ADMIN_PASSWORD must contain at least 12 characters for first boot');
  const salt = randomBytes(16), digest = pbkdf2Sync(password, salt, 100000, 32, 'sha256');
  const hash = `pbkdf2-sha256$100000$${salt.toString('base64url')}$${digest.toString('base64url')}`;
  admin = (await db.prepare("INSERT INTO users (username,password_hash,role,status) VALUES (?,?, 'admin','active') RETURNING id,username").bind(adminName, hash).first()) as typeof admin;
  await updateSettings(env, { site: { title: 'HPC Mail' }, register_mode: 'closed', hosted_domains: { enabled: false, maxPerUser: 3, maxPendingPerUser: 1, maxPendingTotal: 10, pendingDays: 7, autoClaimLimit: 0 }, domains: { list: allowedDomains.map((domain) => ({ domain, public: false, perUserLimit: 0 })) } });
  for (const domain of allowedDomains) await claimMailbox(env, admin!.id, 'admin', { localPart: adminName, domain });
  console.log(JSON.stringify({ event: 'initialized', admin: adminName, domains: allowedDomains }));
}

function context() {
  return { waitUntil(promise: Promise<unknown>) { void promise.catch((e) => console.error('background_task_failed', e instanceof Error ? e.message : String(e))); }, passThroughOnException() {} };
}
let shuttingDown = false;
const trustedProxies = new Set((process.env.TRUSTED_PROXY_IPS ?? '127.0.0.1,::1,10.42.3.0,10.42.3.1,100.109.114.77').split(','));
const server = serve({ port: Number(process.env.PORT ?? 8080), hostname: '0.0.0.0', fetch: async (request, bindings) => {
  const path = new URL(request.url).pathname;
  if (path === '/internal/email') return receiveRelay(request, env, process.env.INBOUND_RELAY_SECRET, context());
  if (path === '/healthz') {
    if (shuttingDown) return new Response('Stopping', { status: 503 });
    try { await db.pool.query('SELECT 1'); return Response.json({ ok: true, database: 'postgresql' }); } catch { return new Response('Database unavailable', { status: 503 }); }
  }
  const peer = (bindings.incoming.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  const forwarded = request.headers.get('x-real-ip') ?? '';
  const clientIp = trustedProxies.has(peer) && isIP(forwarded) ? forwarded : peer;
  const headers = new Headers(request.headers);
  // Workers normally supplies this header. On Node only the configured ingress
  // may supply client identity; a direct caller cannot forge an API IP allowlist.
  headers.set('cf-connecting-ip', clientIp);
  const url = new URL(request.url);
  const publicUrl = new URL(url.pathname + url.search, env.site_origin ?? url.origin);
  const normalized = new Request(publicUrl, { method: request.method, headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    signal: request.signal, duplex: 'half',
  } as RequestInit);
  return worker.fetch(normalized, env, context() as unknown as ExecutionContext);
} });

let tls: { key?: Buffer; cert?: Buffer } = {};
try { tls = { key: await readFile('/tls/tls.key'), cert: await readFile('/tls/tls.crt') }; } catch { /* TLS becomes available after first certificate issuance. */ }
const smtp = new SMTPServer({
  ...tls, name: process.env.SMTP_HOSTNAME ?? 'mx.multi-agent.wiki', size: 32 * 1024 * 1024,
  authOptional: true, disabledCommands: ['AUTH'], disableReverseLookup: true, hideSTARTTLS: !tls.key, maxClients: 4, socketTimeout: 60000,
  onRcptTo(address, session, callback) {
    if (session.envelope.rcptTo.length >= 10) { callback(Object.assign(new Error('Too many recipients'), { responseCode: 452 })); return; }
    const domain = address.address.toLowerCase().split('@')[1];
    void getRoutableDomains(env).then((domains) => {
      if (domain && domains.includes(domain)) callback();
      else callback(Object.assign(new Error('Relay denied: recipient domain is not hosted here'), { responseCode: 550 }));
    }).catch(() => callback(Object.assign(new Error('Mailbox service temporarily unavailable'), { responseCode: 451 })));
  },
  onData(stream, session, callback) {
    const chunks: Buffer[] = []; let size = 0, overflow = false;
    stream.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 32 * 1024 * 1024) overflow = true; else chunks.push(chunk); });
    stream.on('error', callback);
    stream.on('end', () => {
      if (overflow || stream.sizeExceeded) { callback(Object.assign(new Error('Message exceeds 32 MiB'), { responseCode: 552 })); return; }
      const raw = Buffer.concat(chunks);
      void (async () => {
        for (const recipient of session.envelope.rcptTo) {
          let rejection = '';
          await handleInbound({ from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '', to: recipient.address,
            headers: new Headers(), raw: new Response(raw).body!, rawSize: raw.length,
            setReject(reason: string) { rejection = reason; },
            async forward(to: string) { await send({ from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '', to, raw: raw.toString() }); },
          } as unknown as ForwardableEmailMessage, env, context());
          if (rejection) throw Object.assign(new Error(rejection), { responseCode: 550 });
        }
      })().then(() => callback()).catch((error: Error) => callback(Object.assign(error, { responseCode: (error as Error & { responseCode?: number }).responseCode ?? 451 })));
    });
  },
});
smtp.listen(Number(process.env.SMTP_PORT ?? 2525), '0.0.0.0');
let certificateFingerprint = tls.cert ? createHash('sha256').update(tls.cert).digest('hex') : '';
const tlsTimer = setInterval(() => {
  void Promise.all([readFile('/tls/tls.key'), readFile('/tls/tls.crt')]).then(([key, cert]) => {
    const fingerprint = createHash('sha256').update(cert).digest('hex');
    if (fingerprint !== certificateFingerprint) {
      smtp.updateSecureContext({ key, cert });
      smtp.options.hideSTARTTLS = false;
      certificateFingerprint = fingerprint;
      console.log(JSON.stringify({ event: 'smtp_certificate_reloaded' }));
    }
  }).catch(() => { /* Retain the current certificate while its volume is updating. */ });
}, 60000);
let scheduled = false;
const timer = setInterval(() => {
  if (scheduled) return;
  scheduled = true;
  void runScheduled(env, new Date().getUTCHours() === 16 && new Date().getUTCMinutes() < 5).catch((e) => console.error('scheduled_task_failed', e instanceof Error ? e.message : String(e))).finally(() => { scheduled = false; });
}, 5 * 60 * 1000);
console.log(JSON.stringify({ event: 'listening', http: process.env.PORT ?? 8080, smtp: process.env.SMTP_PORT ?? 2525, smtpTls: !!tls.key, externalRelay: !!transport }));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  shuttingDown = true; clearInterval(timer); clearInterval(tlsTimer);
  smtp.close(() => { server.close(() => { void db.pool.end().then(() => process.exit(0)); }); });
  setTimeout(() => process.exit(1), 25000).unref();
});
