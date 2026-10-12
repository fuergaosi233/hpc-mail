import { LOCAL_PART_REGEX, DEFAULT_RESERVED_LOCAL_PARTS } from '@hpc-mail/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/errors';
import { claimRandomBatch, MAX_BATCH_CLAIM, parseBatchCount, randomLocalPart, unavailableMessage } from './claim-helpers';

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

describe('claimRandomBatch', () => {
  const taken = () => new ApiError('该地址已被占用', { code: 'address_taken', httpStatus: 409 });
  const sequence = () => {
    let n = 0;
    return () => `p${++n}`;
  };

  it('顺序认领 count 个，用所选域名，并逐个汇报进度', async () => {
    const claim = vi.fn(async (body: { localPart: string; domain: string }) => ({ address: `${body.localPart}@${body.domain}` }));
    const progress = vi.fn();
    const result = await claimRandomBatch(3, 'a.test', claim, progress, sequence());
    expect(result).toEqual({ claimed: ['p1@a.test', 'p2@a.test', 'p3@a.test'], stoppedBy: null });
    expect(claim.mock.calls.map(([body]) => body)).toEqual([
      { localPart: 'p1', domain: 'a.test' },
      { localPart: 'p2', domain: 'a.test' },
      { localPart: 'p3', domain: 'a.test' },
    ]);
    expect(progress.mock.calls.map(([n]) => n)).toEqual([1, 2, 3]);
  });

  it('前缀被占用时同一个名额换前缀重试，不多占名额', async () => {
    const claim = vi
      .fn()
      .mockRejectedValueOnce(taken())
      .mockImplementation(async (body: { localPart: string; domain: string }) => ({ address: `${body.localPart}@${body.domain}` }));
    const result = await claimRandomBatch(2, 'a.test', claim, undefined, sequence());
    expect(result.claimed).toEqual(['p2@a.test', 'p3@a.test']);
    expect(result.stoppedBy).toBeNull();
  });

  it('连续冲突超过重试次数就停止并保留已认领的', async () => {
    const claim = vi.fn(async (body: { localPart: string; domain: string }) => {
      if (body.localPart === 'p1') return { address: 'p1@a.test' };
      throw taken();
    });
    const result = await claimRandomBatch(3, 'a.test', claim, undefined, sequence());
    expect(result.claimed).toEqual(['p1@a.test']);
    expect(result.stoppedBy).toContain('多次冲突');
    expect(claim).toHaveBeenCalledTimes(1 + 5);
  });

  it('配额用尽等其他错误立即停止，带出后端原因，不再继续请求', async () => {
    const claim = vi
      .fn()
      .mockResolvedValueOnce({ address: 'p1@a.test' })
      .mockRejectedValueOnce(new ApiError('认领地址数已达上限（2）', { code: 'forbidden', httpStatus: 403 }));
    const result = await claimRandomBatch(5, 'a.test', claim, undefined, sequence());
    expect(result).toEqual({ claimed: ['p1@a.test'], stoppedBy: '认领地址数已达上限（2）' });
    expect(claim).toHaveBeenCalledTimes(2);
  });

  it('非 ApiError 的异常也不会抛出，给通用提示', async () => {
    const claim = vi.fn().mockRejectedValue(new TypeError('boom'));
    expect(await claimRandomBatch(2, 'a.test', claim, undefined, sequence())).toEqual({
      claimed: [],
      stoppedBy: '认领失败，请重试',
    });
  });
});
