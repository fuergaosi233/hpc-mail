import { LOCAL_PART_REGEX, DEFAULT_RESERVED_LOCAL_PARTS } from '@hpc-mail/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/errors';
import {
  claimList,
  MAX_BATCH_CLAIM,
  parseBatchCount,
  randomAddresses,
  randomLocalPart,
  randomPick,
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

describe('randomPick', () => {
  it('按随机源取下标，结果总在候选里', () => {
    const list = ['a.test', 'b.test', 'c.test'];
    expect(randomPick(list, () => new Uint32Array([0]))).toBe('a.test');
    expect(randomPick(list, () => new Uint32Array([4]))).toBe('b.test');
    for (let i = 0; i < 100; i++) expect(list).toContain(randomPick(list));
  });

  it('候选足够多时每个都有机会被选中', () => {
    const list = ['a.test', 'b.test', 'c.test'];
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) seen.add(randomPick(list));
    expect([...seen].sort()).toEqual(list);
  });
});

describe('randomAddresses', () => {
  it('生成指定个数、互不相同的合法地址；域名由 pickDomain 决定', () => {
    const drafts = randomAddresses(5, () => 'a.test');
    expect(drafts).toHaveLength(5);
    expect(new Set(drafts.map((d) => d.localPart)).size).toBe(5);
    for (const d of drafts) {
      expect(d.localPart).toMatch(LOCAL_PART_REGEX);
      expect(d.domain).toBe('a.test');
    }
  });

  it('同一前缀可以出现在不同域名下，完全相同的地址才算撞车而继续取', () => {
    const prefixes = ['aa', 'aa', 'aa', 'bb'];
    const domains = ['x.test', 'x.test', 'y.test', 'x.test'];
    let i = 0;
    let j = 0;
    expect(randomAddresses(3, () => domains[j++]!, () => prefixes[i++]!)).toEqual([
      { localPart: 'aa', domain: 'x.test' },
      { localPart: 'aa', domain: 'y.test' },
      { localPart: 'bb', domain: 'x.test' },
    ]);
  });

  it('每次取域名都调用 pickDomain，所以随机域名是逐个地址独立的', () => {
    const pick = vi.fn(() => 'a.test');
    randomAddresses(4, pick);
    expect(pick).toHaveBeenCalledTimes(4);
  });
});

describe('claimList', () => {
  const taken = () => new ApiError('该地址已被占用', { code: 'address_taken', httpStatus: 409 });
  const ok = (body: { localPart: string; domain: string }) => Promise.resolve({ address: `${body.localPart}@${body.domain}` });
  const d = (localPart: string, domain = 'a.test') => ({ localPart, domain });

  it('按给定顺序、各用各自的域名逐个认领，并逐个汇报进度', async () => {
    const claim = vi.fn(ok);
    const progress = vi.fn();
    const result = await claimList([d('one', 'a.test'), d('two', 'b.test'), d('three', 'a.test')], claim, progress);
    expect(result).toEqual({ claimed: ['one@a.test', 'two@b.test', 'three@a.test'], remaining: [], stoppedBy: null });
    expect(claim.mock.calls.map(([body]) => body)).toEqual([d('one', 'a.test'), d('two', 'b.test'), d('three', 'a.test')]);
    expect(progress.mock.calls.map(([n]) => n)).toEqual([1, 2, 3]);
  });

  it('某个地址被抢先占用：只跳过它、不替用户改名，其余照常认领', async () => {
    const claim = vi.fn((body: { localPart: string; domain: string }) => (body.localPart === 'two' ? Promise.reject(taken()) : ok(body)));
    const result = await claimList([d('one'), d('two', 'b.test'), d('three')], claim);
    expect(result).toEqual({ claimed: ['one@a.test', 'three@a.test'], remaining: [d('two', 'b.test')], stoppedBy: null });
    expect(claim).toHaveBeenCalledTimes(3);
  });

  it('配额用尽等其他错误立即停止：带出后端原因，未尝试的与被占用的都留在 remaining（含各自域名），不再继续请求', async () => {
    const claim = vi.fn((body: { localPart: string; domain: string }) => {
      if (body.localPart === 'one') return Promise.reject(taken());
      if (body.localPart === 'three') return Promise.reject(new ApiError('认领地址数已达上限（2）', { code: 'forbidden', httpStatus: 403 }));
      return ok(body);
    });
    const result = await claimList([d('one'), d('two', 'b.test'), d('three', 'b.test'), d('four')], claim);
    expect(result).toEqual({
      claimed: ['two@b.test'],
      remaining: [d('one'), d('three', 'b.test'), d('four')],
      stoppedBy: '认领地址数已达上限（2）',
    });
    expect(claim).toHaveBeenCalledTimes(3);
  });

  it('非 ApiError 的异常也不会抛出，给通用提示', async () => {
    const claim = vi.fn().mockRejectedValue(new TypeError('boom'));
    expect(await claimList([d('one'), d('two')], claim)).toEqual({
      claimed: [],
      remaining: [d('one'), d('two')],
      stoppedBy: '认领失败，请重试',
    });
  });
});
