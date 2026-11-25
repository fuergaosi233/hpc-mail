import { SEALED_SECRET_PREFIX } from '@hpc-mail/shared';
import { AppError } from './errors.js';
import type { Env } from '../types.js';

/**
 * Secret box：采购凭据、代理密码等落库前用 AES-256-GCM 加密。
 * 格式 `enc:v1:<kid>:<iv b64url>:<ct b64url>`，kid：
 * - k1：env.secret_box_key（32 字节随机数的 base64 / base64url）
 * - j1：未配置 secret_box_key 时由 jwt_secret 经 HKDF-SHA256 派生（info 'hpc-mail/secret-box/v1'）
 * 解密按密文里的 kid 选密钥，所以后来补配 secret_box_key 不影响已有 j1 密文；新写入一律用 k1。
 * 不带前缀的值视为历史明文原样返回。kid 作为 AAD 参与认证，篡改 kid 也会解密失败。
 */
export const SEALED_PREFIX = SEALED_SECRET_PREFIX;

type KeyEnv = Pick<Env, 'secret_box_key' | 'jwt_secret'>;
type Kid = 'k1' | 'j1';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const HKDF_INFO = encoder.encode('hpc-mail/secret-box/v1');
const HKDF_SALT = encoder.encode('hpc-mail/secret-box');

/** 每个 isolate 按 kid + 密钥材料缓存导入后的 CryptoKey */
const keyCache = new Map<string, Promise<CryptoKey>>();

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.trim().replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function isSealed(value: string): boolean {
  return value.startsWith(SEALED_PREFIX);
}

function keyMaterial(env: KeyEnv, kid: Kid): string {
  const material = kid === 'k1' ? env.secret_box_key?.trim() : env.jwt_secret;
  if (!material) {
    throw new AppError('internal', kid === 'k1' ? '密文由 SECRET_BOX_KEY 加密，但当前未配置该密钥' : '缺少 jwt_secret，无法派生加密密钥');
  }
  return material;
}

function importKey(env: KeyEnv, kid: Kid): Promise<CryptoKey> {
  const material = keyMaterial(env, kid);
  const cacheKey = `${kid}:${material}`;
  let cached = keyCache.get(cacheKey);
  if (!cached) {
    cached = (async () => {
      if (kid === 'k1') {
        let raw: Uint8Array<ArrayBuffer>;
        try {
          raw = fromBase64(material);
        } catch {
          throw new AppError('internal', 'SECRET_BOX_KEY 不是合法的 base64');
        }
        if (raw.length !== 32) throw new AppError('internal', 'SECRET_BOX_KEY 需为 32 字节随机数的 base64');
        return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
      }
      const base = await crypto.subtle.importKey('raw', encoder.encode(material), 'HKDF', false, ['deriveKey']);
      return crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: HKDF_INFO },
        base,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      );
    })();
    // 失败不缓存，配置修好后可重试
    cached.catch(() => keyCache.delete(cacheKey));
    keyCache.set(cacheKey, cached);
  }
  return cached;
}

/** 新写入使用的 kid：配置了 secret_box_key 用 k1，否则 j1 */
export function currentKid(env: KeyEnv): Kid {
  return env.secret_box_key?.trim() ? 'k1' : 'j1';
}

/** '' → ''；其余 AES-256-GCM 加密（12 字节随机 IV） */
export async function sealSecret(env: KeyEnv, plaintext: string): Promise<string> {
  if (plaintext === '') return '';
  const kid = currentKid(env);
  const key = await importKey(env, kid);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(SEALED_PREFIX + kid) },
    key,
    encoder.encode(plaintext),
  );
  return `${SEALED_PREFIX}${kid}:${toBase64Url(iv)}:${toBase64Url(new Uint8Array(ct))}`;
}

/** '' → ''；不带前缀 → 原样返回（历史明文）；密钥不对或被篡改 → AppError('internal') */
export async function openSecret(env: KeyEnv, sealed: string): Promise<string> {
  if (sealed === '') return '';
  if (!isSealed(sealed)) return sealed;
  const fail = () => new AppError('internal', '密文无法解密：加密密钥可能已更换（SECRET_BOX_KEY / jwt_secret），请重新填写该凭据');
  const parts = sealed.slice(SEALED_PREFIX.length).split(':');
  if (parts.length !== 3) throw fail();
  const [kid, ivText, ctText] = parts as [string, string, string];
  if (kid !== 'k1' && kid !== 'j1') throw fail();
  const key = await importKey(env, kid);
  try {
    const iv = fromBase64(ivText);
    if (iv.length !== 12) throw fail();
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(SEALED_PREFIX + kid) },
      key,
      fromBase64(ctText),
    );
    return decoder.decode(plain);
  } catch {
    throw fail();
  }
}
