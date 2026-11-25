import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { isSealed, openSecret, sealSecret, SEALED_PREFIX } from '../src/lib/secret-box.js';

const BOX_KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 1)));
const k1 = { jwt_secret: env.jwt_secret, secret_box_key: BOX_KEY };
const j1 = { jwt_secret: env.jwt_secret };

describe('secret box', () => {
  it('两种 kid 均可往返，且每次密文不同', async () => {
    for (const keys of [k1, j1]) {
      const first = await sealSecret(keys, 'pässwörd-🔐');
      const second = await sealSecret(keys, 'pässwörd-🔐');
      expect(isSealed(first)).toBe(true);
      expect(first).not.toBe(second);
      expect(first).not.toContain('pässwörd');
      expect(first.startsWith(`${SEALED_PREFIX}${keys === k1 ? 'k1' : 'j1'}:`)).toBe(true);
      expect(await openSecret(keys, first)).toBe('pässwörd-🔐');
    }
  });

  it('空串与历史明文原样返回', async () => {
    expect(await sealSecret(k1, '')).toBe('');
    expect(await openSecret(k1, '')).toBe('');
    expect(await openSecret(k1, 'legacy-plaintext')).toBe('legacy-plaintext');
  });

  it('补配 secret_box_key 后仍能解开 j1 密文；新写入改用 k1', async () => {
    const legacy = await sealSecret(j1, 'token');
    expect(await openSecret(k1, legacy)).toBe('token');
    expect((await sealSecret(k1, 'token')).startsWith(`${SEALED_PREFIX}k1:`)).toBe(true);
  });

  it('篡改、换密钥或缺密钥时报错', async () => {
    const sealed = await sealSecret(k1, 'secret');
    const [prefix, ct] = [sealed.slice(0, sealed.lastIndexOf(':') + 1), sealed.slice(sealed.lastIndexOf(':') + 1)];
    const flipped = prefix + (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1);
    await expect(openSecret(k1, flipped)).rejects.toThrow('密文无法解密');
    // kid 作为 AAD：把 k1 改成 j1 也不能解开
    await expect(openSecret(k1, sealed.replace(':k1:', ':j1:'))).rejects.toThrow('密文无法解密');
    const otherKey = btoa(String.fromCharCode(...Array.from({ length: 32 }, () => 7)));
    await expect(openSecret({ ...k1, secret_box_key: otherKey }, sealed)).rejects.toThrow('密文无法解密');
    await expect(openSecret(j1, sealed)).rejects.toThrow('SECRET_BOX_KEY');
    const jSealed = await sealSecret(j1, 'secret');
    await expect(openSecret({ jwt_secret: 'rotated-secret' }, jSealed)).rejects.toThrow('密文无法解密');
    await expect(openSecret(k1, `${SEALED_PREFIX}k1:garbage`)).rejects.toThrow('密文无法解密');
  });

  it('secret_box_key 不是 32 字节时拒绝加密', async () => {
    await expect(sealSecret({ jwt_secret: env.jwt_secret, secret_box_key: btoa('short') }, 'x')).rejects.toThrow('32 字节');
  });
});
