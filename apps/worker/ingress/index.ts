interface IngressEnv { BACKEND_URL: string; RELAY_SECRET: string; }
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (x) => x.toString(16).padStart(2, '0')).join('');
export default {
  async email(message: ForwardableEmailMessage, env: IngressEnv) {
    const endpoint = new URL('/internal/email', env.BACKEND_URL);
    if (endpoint.protocol !== 'https:' || !env.RELAY_SECRET) throw new Error('Ingress is not configured');
    if (message.rawSize > 32 * 1024 * 1024) { message.setReject('Message exceeds 32 MiB'); return; }
    const raw = await new Response(message.raw).arrayBuffer();
    const digest = hex(await crypto.subtle.digest('SHA-256', raw));
    const timestamp = String(Date.now());
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.RELAY_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}\n${message.from}\n${message.to}\n${digest}`)));
    const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(25000), body: raw, headers: {
      'Content-Type': 'message/rfc822', 'X-HPC-Timestamp': timestamp, 'X-HPC-Signature': signature,
      'X-HPC-Content-SHA256': digest,
      'X-HPC-From': encodeURIComponent(message.from), 'X-HPC-To': encodeURIComponent(message.to),
    } });
    if (response.status === 422) { message.setReject('Recipient unavailable'); return; }
    if (response.status !== 200) throw new Error('Mailbox storage temporarily unavailable');
  },
  async fetch() { return Response.json({ service: 'HPC Mail incoming relay' }); },
};
