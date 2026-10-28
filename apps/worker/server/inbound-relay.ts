import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { handleInbound } from '../src/services/inbound.js';
import { getRoutableDomains } from '../src/services/domain.js';
import type { Env, ExecCtx } from '../src/types.js';

export async function receiveRelay(request: Request, env: Env, secret: string | undefined, ctx: ExecCtx): Promise<Response> {
  if (!secret || request.method !== 'POST') return new Response('Not Found', { status: 404 });
  const timestamp = request.headers.get('x-hpc-timestamp') ?? '';
  const signature = request.headers.get('x-hpc-signature') ?? '';
  const claimedDigest = request.headers.get('x-hpc-content-sha256') ?? '';
  if (!/^\d{13}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 300000 || !/^[a-f0-9]{64}$/.test(signature) || !/^[a-f0-9]{64}$/.test(claimedDigest)) return new Response('Unauthorized', { status: 401 });
  let from: string, to: string;
  try { from = decodeURIComponent(request.headers.get('x-hpc-from') ?? ''); to = decodeURIComponent(request.headers.get('x-hpc-to') ?? ''); } catch { return new Response('Bad envelope', { status: 400 }); }
  if (from.length > 320 || to.length > 320 || /[\r\n]/.test(from + to) || !/^[^\s@<>]+@[^\s@<>]+$/.test(to)) return new Response('Bad envelope', { status: 400 });
  const expected = createHmac('sha256', secret).update(`${timestamp}\n${from}\n${to}\n${claimedDigest}`).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) return new Response('Unauthorized', { status: 401 });
  const limit = 32 * 1024 * 1024;
  if (Number(request.headers.get('content-length') ?? 0) > limit) return new Response('Too large', { status: 413 });
  const chunks: Uint8Array[] = []; let size = 0;
  const reader = request.body?.getReader();
  if (!reader) return new Response('Empty message', { status: 400 });
  while (true) {
    const next = await reader.read(); if (next.done) break;
    size += next.value.length;
    if (size > limit) { await reader.cancel(); return new Response('Too large', { status: 413 }); }
    chunks.push(next.value);
  }
  const raw = Buffer.concat(chunks);
  const digest = createHash('sha256').update(raw).digest('hex');
  if (!timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(claimedDigest, 'hex'))) return new Response('Unauthorized', { status: 401 });
  let rejected = '';
  try {
    if (!(await getRoutableDomains(env)).includes(to.toLowerCase().split('@')[1]!)) return new Response('Recipient unavailable', { status: 422 });
    await handleInbound({ from, to, headers: new Headers(), raw: new Response(raw).body!, rawSize: raw.length,
      setReject(reason: string) { rejected = reason; },
      async forward() { throw new Error('Native forwarding is unavailable on the HTTP relay; configure SMTP_RELAY_URL'); },
    } as unknown as ForwardableEmailMessage, env, ctx);
  } catch { return new Response('Temporary storage failure', { status: 503 }); }
  return rejected ? new Response('Recipient unavailable', { status: 422 }) : Response.json({ accepted: true });
}
