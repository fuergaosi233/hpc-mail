import { LOCAL_PART_REGEX, DEFAULT_RESERVED_LOCAL_PARTS } from '@hpc-mail/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/errors';
import {
  claimList,
  MAX_BATCH_CLAIM,
  parseBatchCount,
  randomLocalPart,
  randomLocalParts,
  unavailableMessage,
} from './claim-helpers';

describe('randomLocalPart', () => {
  it('生成 8 位、字母开头、符合 LOCAL_PART 规则且不含易混字符的前缀', () => {
    for (let i = 0; i < 200; i++) {
      const value = randomLocalPart();
      expect(value).toHaveLength(8);
      expect(value).toMatch(LOCAL_PART_REGEX);
      expect(value).toMatch(/^[a-z]/);
      expect(value).not.toMatch(/[01ilo]/);
      expect(DEFAULT_RESERVED_LOCAL_PARTS as readonly string[]).not.toContain(value);
    }
  });

  it('按注入的随机源取字符，长度可配置', () => {
    const zeros = (n: number) => new Uint32Array(n);
    expect(randomLocalPart(4, zeros)).toBe('aaaa');
  });
});

describe('unavailableMessage', () => {
  it('按后端 reason 给出准确提示', () => {
    expect(unavailableMessage({ available: false, reason: 'taken' })).toContain('已被占用');
    expect(unavailableMessage({ available: false, reason: 'reserved' })).toContain('系统保留');
    expect(unavailableMessage({ available: false, reason: 'quota' })).toContain('个人上限');
    expect(unavailableMessage({ available: false, reason: 'domain_limit' })).toContain('该域名下');
    expect(unavailableMessage({ available: false, reason: 'domain_unavailable' })).toContain('域名当前不可认领');
  });

  it('可认领时为空；旧后端缺 reason 时回退通用提示', () => {
    expect(unavailableMessage({ available: true })).toBeNull();
    expect(unavailableMessage({ available: false })).toBe('该地址暂不可认领');
  });
});

describe('parseBatchCount', () => {
  it('空、0、非数字按 1，超过上限按上限，其余取整数', () => {
    expect(parseBatchCount('')).toBe(1);
    expect(parseBatchCount('0')).toBe(1);
    expect(parseBatchCount('abc')).toBe(1);
    expect(parseBatchCount('7')).toBe(7);
    expect(parseBatchCount('007')).toBe(7);
    expect(parseBatchCount('99')).toBe(MAX_BATCH_CLAIM);
  });
});

describe('randomLocalParts', () => {
  it('生成指定个数、互不相同的合法前缀；随机源撞车时继续取', () => {
    const values = randomLocalParts(5);
    expect(values).toHaveLength(5);
    expect(new Set(values).size).toBe(5);
    for (const value of values) expect(value).toMatch(LOCAL_PART_REGEX);
    const seq = ['aa', 'aa', 'bb', 'aa', 'cc'];
    let n = 0;
    expect(randomLocalParts(3, () => seq[n++]!)).toEqual(['aa', 'bb', 'cc']);
  });
});

describe('claimList', () => {
  const taken = () => new ApiError('该地址已被占用', { code: 'address_taken', httpStatus: 409 });
  const ok = (body: { localPart: string; domain: string }) => Promise.resolve({ address: `${body.localPart}@${body.domain}` });

  it('按给定顺序、用所选域名逐个认领，并逐个汇报进度', async () => {
    const claim = vi.fn(ok);
    const progress = vi.fn();
    const result = await claimList(['one', 'two', 'three'], 'a.test', claim, progress);
    expect(result).toEqual({ claimed: ['one@a.test', 'two@a.test', 'three@a.test'], remaining: [], stoppedBy: null });
    expect(claim.mock.calls.map(([body]) => body)).toEqual([
      { localPart: 'one', domain: 'a.test' },
      { localPart: 'two', domain: 'a.test' },
      { localPart: 'three', domain: 'a.test' },
    ]);
    expect(progress.mock.calls.map(([n]) => n)).toEqual([1, 2, 3]);
  });

  it('某个前缀被抢先占用：只跳过它、不替用户改名，其余照常认领', async () => {
    const claim = vi.fn((body: { localPart: string; domain: string }) => (body.localPart === 'two' ? Promise.reject(taken()) : ok(body)));
    const result = await claimList(['one', 'two', 'three'], 'a.test', claim);
    expect(result).toEqual({ claimed: ['one@a.test', 'three@a.test'], remaining: ['two'], stoppedBy: null });
    expect(claim).toHaveBeenCalledTimes(3);
  });

  it('配额用尽等其他错误立即停止：带出后端原因，未尝试的与被占用的都留在 remaining，不再继续请求', async () => {
    const claim = vi.fn((body: { localPart: string; domain: string }) => {
      if (body.localPart === 'one') return Promise.reject(taken());
      if (body.localPart === 'three') return Promise.reject(new ApiError('认领地址数已达上限（2）', { code: 'forbidden', httpStatus: 403 }));
      return ok(body);
    });
    const result = await claimList(['one', 'two', 'three', 'four'], 'a.test', claim);
    expect(result).toEqual({
      claimed: ['two@a.test'],
      remaining: ['one', 'three', 'four'],
      stoppedBy: '认领地址数已达上限（2）',
    });
    expect(claim).toHaveBeenCalledTimes(3);
  });

  it('非 ApiError 的异常也不会抛出，给通用提示', async () => {
    const claim = vi.fn().mockRejectedValue(new TypeError('boom'));
    expect(await claimList(['one', 'two'], 'a.test', claim)).toEqual({
      claimed: [],
      remaining: ['one', 'two'],
      stoppedBy: '认领失败，请重试',
    });
  });
});
