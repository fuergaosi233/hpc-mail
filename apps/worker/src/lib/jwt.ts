const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64url(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64urlDecode(str: string): Uint8Array<ArrayBuffer> {
  let normalized = str.replace(/-/g, '+').replace(/_/g, '/');
  while (normalized.length % 4) normalized += '=';
  return Uint8Array.from(atob(normalized), (c) => c.charCodeAt(0));
}

/** JWT claims：sub=userId, sid=会话 id, epoch=实例代, uepoch=用户代 */
export interface JwtClaims {
  sub: number;
  sid: string;
  epoch: number;
  uepoch: number;
  iat: number;
  exp: number;
}

// 7 天：本系统是「验证码聚合器」，账号价值高，缩短 token 生命周期降低泄露后暴露窗口
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 7;

async function importKey(secret: string, usage: ('sign' | 'verify')[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usage,
  );
}

export async function signToken(
  secret: string,
  payload: Pick<JwtClaims, 'sub' | 'sid' | 'epoch' | 'uepoch'>,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: JwtClaims = { ...payload, iat: now, exp: now + ttlSeconds };
  const headerStr = base64url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payloadStr = base64url(encoder.encode(JSON.stringify(fullPayload)));
  const data = `${headerStr}.${payloadStr}`;
  const key = await importKey(secret, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return `${data}.${base64url(signature)}`;
}

export async function verifyToken(secret: string, token: string): Promise<JwtClaims | null> {
  try {
    const [headerB64, payloadB64, signatureB64] = token.split('.');
    if (!headerB64 || !payloadB64 || !signatureB64) return null;
    const data = `${headerB64}.${payloadB64}`;
    const key = await importKey(secret, ['verify']);
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      base64urlDecode(signatureB64),
      encoder.encode(data),
    );
    if (!valid) return null;
    const payload = JSON.parse(decoder.decode(base64urlDecode(payloadB64))) as JwtClaims;
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(payload.exp) || payload.exp <= now) return null;
    return payload;
  } catch {
    return null;
  }
}
