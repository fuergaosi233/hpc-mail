import { LOCAL_PART_REGEX, DEFAULT_RESERVED_LOCAL_PARTS, MAX_BATCH_CLAIM, type BatchClaimMailboxResult } from '@hpc-mail/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/errors';
import {
  claimList,
  createAvailabilityLoader,
  fromBatchResult,
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
  const d = (localPart: string, domain = 'a.test') => ({ localPart, domain });
  /** 后端返回的邮箱：每个前缀固定一个 id，用来核对 claimedIds 与 claimed 一一对应 */
  const ids: Record<string, number> = { one: 11, two: 12, three: 13, four: 14 };
  const box = (draft: { localPart: string; domain: string }) => ({
    id: ids[draft.localPart]!,
    address: `${draft.localPart}@${draft.domain}`,
  });
  const batch = (result: Partial<BatchClaimMailboxResult>) =>
    vi.fn(async (_items: Array<{ localPart: string; domain: string }>) => ({
      claimed: [], taken: [], notAttempted: [], stoppedBy: null, ...result,
    }) as BatchClaimMailboxResult);

  it('多个地址只发一次批量认领，按给定顺序、各用各自的域名', async () => {
    const drafts = [d('one', 'a.test'), d('two', 'b.test'), d('three', 'a.test')];
    const claim = vi.fn();
    const batchClaim = batch({ claimed: drafts.map(box) as never });
    const result = await claimList(drafts, { claim, batchClaim });
    expect(result).toEqual({
      claimed: ['one@a.test', 'two@b.test', 'three@a.test'], claimedIds: [11, 12, 13], remaining: [], stoppedBy: null,
    });
    expect(batchClaim).toHaveBeenCalledTimes(1);
    expect(batchClaim).toHaveBeenCalledWith(drafts);
    expect(claim).not.toHaveBeenCalled();
  });

  it('某个地址被抢先占用：只跳过它、不替用户改名，其余照常认领', async () => {
    const batchClaim = batch({ claimed: [box(d('one')), box(d('three'))] as never, taken: [d('two', 'b.test')] });
    const result = await claimList([d('one'), d('two', 'b.test'), d('three')], { claim: vi.fn(), batchClaim });
    expect(result).toEqual({
      claimed: ['one@a.test', 'three@a.test'], claimedIds: [11, 13], remaining: [d('two', 'b.test')], stoppedBy: null,
    });
  });

  it('配额用尽等其他错误中途停止：带出后端原因，被占用的与没尝试的按原顺序都留在 remaining（含各自域名）', async () => {
    const batchClaim = batch({
      claimed: [box(d('two', 'b.test'))] as never,
      taken: [d('one')],
      notAttempted: [d('three', 'b.test'), d('four')],
      stoppedBy: { code: 'forbidden', message: '认领地址数已达上限（2）' },
    });
    const result = await claimList([d('one'), d('two', 'b.test'), d('three', 'b.test'), d('four')], { claim: vi.fn(), batchClaim });
    expect(result).toEqual({
      claimed: ['two@b.test'],
      claimedIds: [12],
      remaining: [d('one'), d('three', 'b.test'), d('four')],
      stoppedBy: '认领地址数已达上限（2）',
    });
  });

  it('批量请求在处理前被拒绝（4xx）：一个都没认领，带出原因，不抛出', async () => {
    const limited = vi.fn().mockRejectedValue(new ApiError('请求过于频繁', { code: 'rate_limited', httpStatus: 429 }));
    const result = await claimList([d('one'), d('two')], { claim: vi.fn(), batchClaim: limited });
    expect(result).toEqual({ claimed: [], claimedIds: [], remaining: [d('one'), d('two')], stoppedBy: '请求过于频繁' });
    expect(result.uncertain).toBeUndefined();
  });

  it.each([
    ['网络在服务端提交后断开', new ApiError('网络连接失败', { code: 'network' }), '网络连接失败'],
    ['服务端异常 500', new ApiError('服务器内部错误', { code: 'internal', httpStatus: 500 }), '服务器内部错误'],
    ['非 ApiError 异常', new TypeError('boom'), '认领失败，请重试'],
  ])('批量请求整单失败且结果未知（%s）：标记可能已部分认领，提示以邮箱列表为准', async (_name, error, message) => {
    const batchClaim = vi.fn().mockRejectedValue(error);
    expect(await claimList([d('one'), d('two')], { claim: vi.fn(), batchClaim })).toEqual({
      claimed: [],
      claimedIds: [],
      remaining: [d('one'), d('two')],
      stoppedBy: `${message}。部分地址可能已认领，请以邮箱列表为准`,
      uncertain: true,
    });
  });

  it('只有一个地址时仍走单个认领接口：被占用不算停止，其他错误带出原因', async () => {
    const batchClaim = batch({});
    const ok = vi.fn(async (body: { localPart: string; domain: string }) => box(body));
    expect(await claimList([d('one', 'b.test')], { claim: ok, batchClaim })).toEqual({
      claimed: ['one@b.test'], claimedIds: [11], remaining: [], stoppedBy: null,
    });
    expect(ok).toHaveBeenCalledWith(d('one', 'b.test'));
    expect(await claimList([d('one')], { claim: vi.fn().mockRejectedValue(taken()), batchClaim })).toEqual({
      claimed: [], claimedIds: [], remaining: [d('one')], stoppedBy: null,
    });
    const quota = vi.fn().mockRejectedValue(new ApiError('认领地址数已达上限（1）', { code: 'forbidden', httpStatus: 403 }));
    const rejected = await claimList([d('one')], { claim: quota, batchClaim });
    expect(rejected).toEqual({ claimed: [], claimedIds: [], remaining: [d('one')], stoppedBy: '认领地址数已达上限（1）' });
    expect(rejected.uncertain).toBeUndefined();
    expect(batchClaim).not.toHaveBeenCalled();
  });

  it.each([
    ['网络错误', new ApiError('网络连接失败', { code: 'network' }), '网络连接失败'],
    ['超时', new ApiError('请求超时', { code: 'timeout' }), '请求超时'],
    ['服务端异常 5xx', new ApiError('服务器内部错误', { code: 'internal', httpStatus: 502 }), '服务器内部错误'],
  ])('单个认领结果未知（%s）：与批量同一规则，标记可能已认领并提示以邮箱列表为准', async (_name, error, message) => {
    const claim = vi.fn().mockRejectedValue(error);
    expect(await claimList([d('one')], { claim, batchClaim: batch({}) })).toEqual({
      claimed: [],
      claimedIds: [],
      remaining: [d('one')],
      stoppedBy: `${message}。该地址可能已认领，请以邮箱列表为准`,
      uncertain: true,
    });
  });
});

describe('fromBatchResult', () => {
  const d = (localPart: string) => ({ localPart, domain: 'a.test' });

  it('被占用的与没尝试的按用户给出的顺序合并，与后端返回的先后无关', () => {
    const drafts = [d('a'), d('b'), d('c'), d('d'), d('e')];
    expect(fromBatchResult(drafts, {
      claimed: [{ id: 5, address: 'a@a.test' }] as never,
      taken: [d('d'), d('b')],
      notAttempted: [d('e'), d('c')],
      stoppedBy: { code: 'forbidden', message: '已达上限' },
    })).toEqual({ claimed: ['a@a.test'], claimedIds: [5], remaining: [d('b'), d('c'), d('d'), d('e')], stoppedBy: '已达上限' });
  });

  it('业务错误停止时结果确定；后端中途非业务错误（internal）停止时，出错那项可能已提交，按结果未知处理', () => {
    const drafts = [d('a'), d('b'), d('c')];
    const business = fromBatchResult(drafts, {
      claimed: [], taken: [], notAttempted: drafts, stoppedBy: { code: 'forbidden', message: '已达上限' },
    });
    expect(business.uncertain).toBeUndefined();
    expect(fromBatchResult(drafts, {
      claimed: [{ id: 5, address: 'a@a.test' }] as never,
      taken: [],
      notAttempted: [d('b'), d('c')],
      stoppedBy: { code: 'internal', message: '认领中断，部分地址可能已认领，请以邮箱列表为准' },
    })).toEqual({
      claimed: ['a@a.test'],
      claimedIds: [5],
      remaining: [d('b'), d('c')],
      stoppedBy: '认领中断，部分地址可能已认领，请以邮箱列表为准',
      uncertain: true,
    });
  });
});

describe('createAvailabilityLoader', () => {
  type Draft = { localPart: string; domain: string };
  const d = (localPart: string, domain = 'a.test') => ({ localPart, domain });
  const free = (item: Draft) => ({ address: `${item.localPart}@${item.domain}`, available: true });

  it('同一轮发起的多个查询合成一次批量请求，结果按顺序对应回各自的调用', async () => {
    const one = vi.fn();
    const many = vi.fn(async (items: Draft[]) =>
      items.map((item) => (item.localPart === 'busy' ? { ...free(item), available: false, reason: 'taken' as const } : free(item))));
    const load = createAvailabilityLoader({ one, many });
    const results = await Promise.all([load(d('one')), load(d('busy', 'b.test')), load(d('three'))]);
    expect(many).toHaveBeenCalledTimes(1);
    expect(many).toHaveBeenCalledWith([d('one'), d('busy', 'b.test'), d('three')]);
    expect(one).not.toHaveBeenCalled();
    expect(results).toEqual([
      free(d('one')),
      { address: 'busy@b.test', available: false, reason: 'taken' },
      free(d('three')),
    ]);
  });

  it('只有一个查询时走单个查询接口；下一轮的查询另发请求', async () => {
    const one = vi.fn(async (item: Draft) => free(item));
    const many = vi.fn(async (items: Draft[]) => items.map(free));
    const load = createAvailabilityLoader({ one, many });
    await load(d('one'));
    expect(one).toHaveBeenCalledWith(d('one'));
    await Promise.all([load(d('two')), load(d('three'))]);
    expect(one).toHaveBeenCalledTimes(1);
    expect(many).toHaveBeenCalledTimes(1);
  });

  it(`超过 ${MAX_BATCH_CLAIM} 个时按上限分批`, async () => {
    const many = vi.fn(async (items: Draft[]) => items.map(free));
    const load = createAvailabilityLoader({ one: vi.fn(), many });
    await Promise.all(Array.from({ length: MAX_BATCH_CLAIM + 2 }, (_, i) => load(d(`p${i}`))));
    expect(many.mock.calls.map(([items]) => items.length)).toEqual([MAX_BATCH_CLAIM, 2]);
  });

  it('批量请求失败后整批重试一次（仍是一次批量请求），成功则各自拿到结果', async () => {
    const one = vi.fn();
    const many = vi.fn()
      .mockRejectedValueOnce(new ApiError('网络连接失败', { code: 'network' }))
      .mockImplementation(async (items: Draft[]) => items.map(free));
    const load = createAvailabilityLoader({ one, many }, { retryDelayMs: 0 });
    expect(await Promise.all([load(d('one')), load(d('two'))])).toEqual([free(d('one')), free(d('two'))]);
    expect(many).toHaveBeenCalledTimes(2);
    expect(many.mock.calls[1]![0]).toEqual([d('one'), d('two')]);
    expect(one).not.toHaveBeenCalled();
  });

  it('4xx 不重试；单个查询失败同样只整体重试一次', async () => {
    const rejected = vi.fn().mockRejectedValue(new ApiError('请求过于频繁', { code: 'rate_limited', httpStatus: 429 }));
    const limited = createAvailabilityLoader({ one: vi.fn(), many: rejected }, { retryDelayMs: 0 });
    await expect(Promise.all([limited(d('one')), limited(d('two'))])).rejects.toThrow('请求过于频繁');
    expect(rejected).toHaveBeenCalledTimes(1);
    const one = vi.fn().mockRejectedValue(new ApiError('服务器内部错误', { code: 'internal', httpStatus: 500 }));
    const single = createAvailabilityLoader({ one, many: vi.fn() }, { retryDelayMs: 0 });
    await expect(single(d('one'))).rejects.toThrow('服务器内部错误');
    expect(one).toHaveBeenCalledTimes(2);
  });

  it('批量请求重试后仍失败或结果数量不符时，这一批的每个查询都失败', async () => {
    const error = new ApiError('网络连接失败', { code: 'network' });
    const many = vi.fn().mockRejectedValue(error);
    const failing = createAvailabilityLoader({ one: vi.fn(), many }, { retryDelayMs: 0 });
    const settled = await Promise.allSettled([failing(d('one')), failing(d('two'))]);
    expect(settled).toEqual([{ status: 'rejected', reason: error }, { status: 'rejected', reason: error }]);
    expect(many).toHaveBeenCalledTimes(2);
    const short = createAvailabilityLoader({ one: vi.fn(), many: vi.fn(async () => [free(d('one'))]) });
    const mismatched = await Promise.allSettled([short(d('one')), short(d('two'))]);
    expect(mismatched.map((item) => item.status)).toEqual(['rejected', 'rejected']);
  });
});
