/** RFC 6238 TOTP（SHA-1、6 位、30s 步长）+ base32 + 恢复码，纯 Web Crypto 实现 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIOD = 30;
const DIGITS = 6;

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(input: string): Uint8Array {
  const clean = input.replace(/=+$/, '').toUpperCase().replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** 生成随机 TOTP 密钥（base32，20 字节熵） */
export function generateTotpSecret(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return base32Encode(bytes);
}

async function hmacSha1(key: Uint8Array, msg: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(key),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new Uint8Array(msg));
  return new Uint8Array(sig);
}

export async function generateCode(secret: string, counter: number): Promise<string> {
  const key = base32Decode(secret);
  const msg = new Uint8Array(8);
  // 8 字节大端计数器
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    msg[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  const hash = await hmacSha1(key, msg);
  const offset = hash[hash.length - 1]! & 0x0f;
  const bin =
    ((hash[offset]! & 0x7f) << 24) |
    ((hash[offset + 1]! & 0xff) << 16) |
    ((hash[offset + 2]! & 0xff) << 8) |
    (hash[offset + 3]! & 0xff);
  return (bin % 10 ** DIGITS).toString().padStart(DIGITS, '0');
}

/** 校验 TOTP 码：容忍 ±window 个时间步（默认 ±1，即前后 30s） */
export async function verifyTotp(secret: string, token: string, window = 1): Promise<boolean> {
  const normalized = token.replace(/\s/g, '');
  if (!/^\d{6}$/.test(normalized)) return false;
  const counter = Math.floor(Date.now() / 1000 / PERIOD);
  for (let w = -window; w <= window; w++) {
    if ((await generateCode(secret, counter + w)) === normalized) return true;
  }
  return false;
}

/** 生成 otpauth:// URI 供 Authenticator 扫码 */
export function otpauthUri(secret: string, account: string, issuer = 'HPC Mail'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** 生成 N 个恢复码（明文一次性返回）+ 其 SHA-256 哈希（落库） */
export async function generateRecoveryCodes(
  count = 10,
): Promise<{ plain: string[]; hashes: string[] }> {
  const plain: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < count; i++) {
    const bytes = new Uint8Array(5);
    crypto.getRandomValues(bytes);
    const code = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    const formatted = `${code.slice(0, 5)}-${code.slice(5)}`;
    plain.push(formatted);
    hashes.push(await sha256Hex(formatted));
  }
  return { plain, hashes };
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export { sha256Hex as hashRecoveryCode };
