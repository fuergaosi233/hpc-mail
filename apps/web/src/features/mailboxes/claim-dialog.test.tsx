import { onlineManager, QueryClient, type QueryClientConfig, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ClaimPlan, SessionUser } from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';
import { CurrentUserContext } from '@/lib/use-session';
type Draft = { localPart: string; domain: string };
const mocks = vi.hoisted(() => {
  /** 后端给每个地址分配的邮箱 id：同一地址固定，用来核对共享时提交的 mailboxIds */
  const ids = new Map<string, number>();
  const idOf = (address: string) => {
    if (!ids.has(address)) ids.set(address, 100 + ids.size);
    return ids.get(address)!;
  };
  const mailbox = (body: Draft) => ({ id: idOf(`${body.localPart}@${body.domain}`), address: `${body.localPart}@${body.domain}` });
  /** 后端对单个地址的认领结果：单个认领接口与批量认领的模拟共用这一份 */
  const claimOne = vi.fn(async (body: Draft) => mailbox(body));
  /** 后端对单个地址的可用性结果：单个与批量查询共用 */
  const availableOf = vi.fn(
    async (_localPart = '', _domain = ''): Promise<{ available: boolean; reason?: string }> => ({ available: true }),
  );
  return {
    idOf,
    mailbox,
    claimOne,
    availableOf,
    claim: vi.fn((body: Draft) => claimOne(body)),
    /** 模拟后端批量认领：按顺序逐个处理，被占用的跳过，其他错误停止 */
    batchClaim: vi.fn(async (items: Draft[]) => {
      const result = {
        claimed: [] as Array<{ id: number; address: string }>,
        taken: [] as Draft[],
        notAttempted: [] as Draft[],
        stoppedBy: null as { code: string; message: string } | null,
      };
      for (let i = 0; i < items.length; i++) {
        try {
          result.claimed.push(await claimOne(items[i]!));
        } catch (error) {
          const { code, message } = error as { code: string; message: string };
          if (code === 'address_taken') {
            result.taken.push(items[i]!);
            continue;
          }
          result.notAttempted = items.slice(i);
          result.stoppedBy = { code, message };
          break;
        }
      }
      return result;
    }),
    availability: vi.fn((localPart: string, domain: string) => availableOf(localPart, domain)),
    batchAvailability: vi.fn((items: Draft[]) => Promise.all(items.map((item) => availableOf(item.localPart, item.domain)))),
    /** 后端随机后缀分配：默认按 a/b/c 轮流分配、都没有封号记录 */
    randomPlan: vi.fn(async (count: number, strategy: 'uniform' | 'claude') => ({
      strategy,
      items: Array.from({ length: count }, (_, i) => ({ domain: ['a.test', 'b.test', 'c.test'][i % 3]!, suspended: 0 })),
      pool: ['a.test', 'b.test', 'c.test'],
      shortfall: 0,
      reason: null as ClaimPlan['reason'],
    })),
    /** 管理员的用户列表：含自己（root）、已禁用的 carol */
    listUsers: vi.fn(async () => [
      { id: 1, username: 'root', role: 'admin', status: 'active' },
      { id: 2, username: 'alice', role: 'user', status: 'active' },
      { id: 3, username: 'bob', role: 'user', status: 'active' },
      { id: 4, username: 'carol', role: 'user', status: 'disabled' },
      { id: 5, username: 'ops', role: 'admin', status: 'active' },
    ]),
    batchShare: vi.fn(async (body: { mailboxIds: number[]; userIds: number[] }) =>
      body.mailboxIds.map((mailboxId) => ({ mailboxId, grantees: body.userIds.map((userId) => ({ userId })) }))),
    toast: vi.fn(),
    writeClipboard: vi.fn(async () => true),
  };
});
vi.mock('@/api/resources', () => ({
  mailboxApi: {
    claim: mocks.claim,
    batchClaim: mocks.batchClaim,
    availability: mocks.availability,
    batchAvailability: mocks.batchAvailability,
    randomPlan: mocks.randomPlan,
    batchShare: mocks.batchShare,
  },
  adminApi: { listUsers: mocks.listUsers },
}));
vi.mock('@/components/ui/toast', () => ({ toast: mocks.toast }));
vi.mock('@/components/ui/copy-button', () => ({ writeClipboard: mocks.writeClipboard }));
import { ClaimDialog } from './claim-dialog';
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
});

/** 默认以普通用户渲染；管理员相关用例传入 user */
const member: SessionUser = { id: 6, username: 'member', role: 'user', createdAt: '', avatarUrl: null, twoFactorEnabled: false };

function renderDialog(
  domains = ['example.com'],
  onOpenChange = vi.fn(),
  {
    defaultOptions = { queries: { retry: false } },
    user = member,
  }: { defaultOptions?: QueryClientConfig['defaultOptions']; user?: SessionUser } = {},
) {
  const client = new QueryClient({ defaultOptions });
  const wrap = (list: string[]) => (
    <QueryClientProvider client={client}>
      <CurrentUserContext.Provider value={user}>
        <ClaimDialog open onOpenChange={onOpenChange} domains={list} />
      </CurrentUserContext.Provider>
    </QueryClientProvider>
  );
  const view = render(wrap(domains));
  return { client, view, rerender: (list: string[]) => view.rerender(wrap(list)) };
}

afterEach(() => vi.clearAllMocks());

describe('claim selected domain retention', () => {
  it('chooses an available domain when the previous selection is removed', async () => {
    const { client, rerender } = renderDialog(['old.example', 'new.example']);
    fireEvent.change(screen.getByPlaceholderText('例如 hello'), { target: { value: 'test' } });
    rerender(['new.example']);
    fireEvent.click(screen.getByRole('button', { name: '认领' }));
    await waitFor(() => expect(mocks.claim).toHaveBeenCalledWith({ localPart: 'test', domain: 'new.example' }));
    client.clear();
  });
});

describe('认领可用性原因', () => {
  it.each([
    ['taken', '该地址已被占用'],
    ['reserved', '该前缀为系统保留'],
    ['quota', '已达个人上限'],
    ['domain_limit', '该域名下的认领数已达上限'],
    ['domain_unavailable', '该域名当前不可认领'],
  ])('reason=%s 显示对应提示并禁用提交', async (reason, text) => {
    mocks.availableOf.mockResolvedValueOnce({ available: false, reason });
    const { client } = renderDialog();
    fireEvent.change(screen.getByPlaceholderText('例如 hello'), { target: { value: 'hello' } });
    expect(await screen.findByText(new RegExp(text), {}, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '认领' })).toBeDisabled();
    expect(screen.getByLabelText('前缀')).toHaveAttribute('aria-invalid', 'true');
    client.clear();
  });

  it('可认领时提示完整地址', async () => {
    const { client } = renderDialog();
    fireEvent.change(screen.getByPlaceholderText('例如 hello'), { target: { value: 'hello' } });
    expect(await screen.findByText('hello@example.com 可以认领', {}, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '认领' })).toBeEnabled();
    client.clear();
  });
});

describe('随机生成与认领成功', () => {
  it('随机生成立即填入合法前缀并跳过防抖查询可用性', async () => {
    const { client } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: '随机生成' }));
    const value = (screen.getByLabelText('前缀') as HTMLInputElement).value;
    expect(value).toMatch(/^[a-z][a-z2-9]{7}$/);
    await waitFor(() => expect(mocks.availability).toHaveBeenCalledWith(value, 'example.com'));
    client.clear();
  });

  it('成功 toast 带「复制地址」操作，点击复制完整地址', async () => {
    const onOpenChange = vi.fn();
    const { client } = renderDialog(['example.com'], onOpenChange);
    fireEvent.change(screen.getByPlaceholderText('例如 hello'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: '认领' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    const success = mocks.toast.mock.calls.map(([input]) => input).find((input) => input.title === '地址认领成功');
    expect(success).toMatchObject({ description: 'hello@example.com', action: { label: '复制地址' } });
    success.action.onClick();
    await waitFor(() => expect(mocks.writeClipboard).toHaveBeenCalledWith('hello@example.com'));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith({ title: '已复制到剪贴板', variant: 'success' }));
    client.clear();
  });
});

describe('随机生成：先预览、可编辑，确认后才认领', () => {
  const setCount = (value: string) => fireEvent.change(screen.getByLabelText('随机生成个数'), { target: { value } });
  const prefixes = () => screen.getAllByLabelText(/^前缀/).map((input) => (input as HTMLInputElement).value);
  const RANDOM = /^[a-z][a-z2-9]{7}$/;

  it('个数默认 1：随机生成只填入前缀，不会认领', async () => {
    const { client } = renderDialog();
    expect(screen.getByLabelText('随机生成个数')).toHaveValue('1');
    fireEvent.click(screen.getByRole('button', { name: '随机生成' }));
    expect(prefixes()).toHaveLength(1);
    expect(prefixes()[0]).toMatch(RANDOM);
    await waitFor(() => expect(mocks.availability).toHaveBeenCalled());
    expect(mocks.batchAvailability).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
    client.clear();
  });

  it('个数为 3：点随机生成只展示 3 个可编辑地址，一次批量检查可用性，确认前不会发认领请求', async () => {
    const { client } = renderDialog(['one.test']);
    setCount('3');
    fireEvent.click(screen.getByRole('button', { name: '随机生成' }));
    const values = prefixes();
    expect(values).toHaveLength(3);
    expect(new Set(values).size).toBe(3);
    values.forEach((value) => expect(value).toMatch(RANDOM));
    expect(screen.getByRole('button', { name: '认领 3 个' })).toBeInTheDocument();
    for (const value of values) expect(await screen.findByText(`${value}@one.test 可以认领`)).toBeInTheDocument();
    expect(mocks.batchAvailability).toHaveBeenCalledTimes(1);
    expect(mocks.batchAvailability).toHaveBeenCalledWith(values.map((value) => ({ localPart: value, domain: 'one.test' })));
    expect(mocks.availability).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.batchClaim).not.toHaveBeenCalled();
    client.clear();
  });

  it('999 个地址一次生成、一次批量检查并认领；超过共享上限时提示前往我的邮箱', async () => {
    const { client } = renderDialog(['one.test'], vi.fn(), { user: { ...member, role: 'admin' } });
    const countInput = screen.getByLabelText('随机生成个数');
    const form = countInput.closest('form')!;
    setCount('999');
    expect(countInput).toHaveValue('999');
    fireEvent.click(screen.getByRole('button', { name: '随机生成' }));
    // 大批量用标签定位输入，避免 getByRole 对数千节点逐个计算可访问名称与可见性。
    const values = Array.from(form.querySelectorAll<HTMLInputElement>('input[aria-label^="前缀"]'), (input) => input.value);
    expect(values).toHaveLength(999);
    expect(new Set(values).size).toBe(999);
    expect(values.every((value) => RANDOM.test(value))).toBe(true);
    await waitFor(() => expect(mocks.batchAvailability).toHaveBeenCalledTimes(1));
    expect(mocks.batchAvailability.mock.calls[0]![0]).toHaveLength(999);
    expect(mocks.availability).not.toHaveBeenCalled();
    expect(within(form).getByText('认领 999 个', { selector: 'button' })).toBeEnabled();
    fireEvent.submit(form);
    await screen.findByText('已认领 999 个地址', { selector: '[role="status"]' });
    expect(mocks.batchClaim).toHaveBeenCalledTimes(1);
    expect(mocks.batchClaim.mock.calls[0]![0]).toHaveLength(999);
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(screen.queryByText('共享给…', { selector: 'button' })).not.toBeInTheDocument();
    expect(screen.getByText('一次最多共享 100 个邮箱，请前往「我的邮箱」管理共享。', { selector: 'p' })).toBeInTheDocument();
    expect(mocks.batchShare).not.toHaveBeenCalled();
    client.clear();
  }, 60000);

  it('不满意可以反复点随机生成，每次换一批新的', () => {
    const { client } = renderDialog();
    setCount('3');
    fireEvent.click(screen.getByRole('button', { name: '随机生成' }));
    const first = prefixes();
    fireEvent.click(screen.getByRole('button', { name: '随机生成' }));
    const second = prefixes();
    expect(second).toHaveLength(3);
    expect(second.some((value) => first.includes(value))).toBe(false);
    client.clear();
  });

  it('随机出来的地址可以手动修改，确认后认领的是修改后的内容', async () => {
    const { client } = renderDialog(['one.test']);
    setCount('3');
    fireEvent.click(screen.getByRole('button', { name: '随机生成' }));
    const before = prefixes();
    fireEvent.change(screen.getByLabelText('前缀 2'), { target: { value: 'My-Pick' } });
    expect(prefixes()).toEqual([before[0], 'my-pick', before[2]]);
    fireEvent.click(screen.getByRole('button', { name: '认领 3 个' }));
    await screen.findByText('已认领 3 个地址');
    expect(mocks.batchClaim).toHaveBeenCalledTimes(1);
    expect(mocks.batchClaim).toHaveBeenCalledWith([
      { localPart: before[0], domain: 'one.test' },
      { localPart: 'my-pick', domain: 'one.test' },
      { localPart: before[2], domain: 'one.test' },
    ]);
    expect(mocks.claim).not.toHaveBeenCalled();
    client.clear();
  });

  it('可单独重新随机某一个，也可移除某一个；认领个数随之变化', async () => {
    const { client } = renderDialog(['one.test']);
    setCount('3');
    fireEvent.click(screen.getByRole('button', { name: '随机生成' }));
    const before = prefixes();
    fireEvent.click(screen.getByRole('button', { name: '重新随机第 2 个' }));
    const rerolled = prefixes();
    expect(rerolled[0]).toBe(before[0]);
    expect(rerolled[2]).toBe(before[2]);
    expect(rerolled[1]).not.toBe(before[1]);
    fireEvent.click(screen.getByRole('button', { name: '移除第 1 个' }));
    expect(prefixes()).toEqual([rerolled[1], rerolled[2]]);
    fireEvent.click(screen.getByRole('button', { name: '认领 2 个' }));
    await screen.findByText('已认领 2 个地址');
    expect(mocks.batchClaim).toHaveBeenCalledWith([rerolled[1], rerolled[2]].map((value) => ({ localPart: value, domain: 'one.test' })));
    expect(mocks.claim).not.toHaveBeenCalled();
    client.clear();
  });

  it('认领全部成功后列出结果，可复制全部、点「完成」关闭，并刷新我的邮箱缓存', async () => {
    const onOpenChange = vi.fn();
    const { client } = renderDialog(['one.test'], onOpenChange);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    setCount('2');
    fireEvent.click(screen.getByRole('button', { name: '随机生成' }));
    const values = prefixes();
    fireEvent.click(screen.getByRole('button', { name: '认领 2 个' }));
    await screen.findByText('已认领 2 个地址');
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual(values.map((value) => `${value}@one.test`));
    fireEvent.click(screen.getByRole('button', { name: '复制全部地址' }));
    await waitFor(() => expect(mocks.writeClipboard).toHaveBeenCalledWith(values.map((value) => `${value}@one.test`).join('\n')));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['mailboxes'] });
    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    client.clear();
  });

  it('某个地址刚被别人占用：其余照常认领，可返回修改只保留未认领的', async () => {
    mocks.claimOne.mockImplementation(async (body) => {
      if (body.localPart === 'taken-one') throw new ApiError('该地址已被占用', { code: 'address_taken', httpStatus: 409 });
      return mocks.mailbox(body);
    });
    const { client } = renderDialog(['one.test']);
    setCount('2');
    fireEvent.click(screen.getByRole('button', { name: '随机生成' }));
    fireEvent.change(screen.getByLabelText('前缀 1'), { target: { value: 'taken-one' } });
    fireEvent.click(screen.getByRole('button', { name: '认领 2 个' }));
    await screen.findByText('已认领 1 个地址，还有 1 个未认领');
    expect(screen.getByRole('alert')).toHaveTextContent('1 个地址刚被别人认领');
    fireEvent.click(screen.getByRole('button', { name: '返回修改' }));
    expect(prefixes()).toEqual(['taken-one']);
    expect(screen.getByRole('button', { name: '认领' })).toBeInTheDocument();
    client.clear();
  });

  it('中途配额用尽：保留已认领的并说明原因，不再继续请求，也不提供返回修改', async () => {
    mocks.claimOne
      .mockImplementationOnce(async (body) => mocks.mailbox(body))
      .mockRejectedValueOnce(new ApiError('认领地址数已达上限（1）', { code: 'forbidden', httpStatus: 403 }));
    const { client } = renderDialog(['one.test']);
    setCount('5');
    fireEvent.click(screen.getByRole('button', { name: '随机生成' }));
    fireEvent.click(screen.getByRole('button', { name: '认领 5 个' }));
    await screen.findByText('已认领 1 个地址，还有 4 个未认领');
    expect(screen.getByRole('alert')).toHaveTextContent('未能认领满：认领地址数已达上限（1）');
    expect(screen.queryByRole('button', { name: '返回修改' })).toBeNull();
    expect(mocks.batchClaim).toHaveBeenCalledTimes(1);
    expect(mocks.claim).not.toHaveBeenCalled();
    client.clear();
  });

  it('一个都没认领成功：留在表单里保留所有地址并显示原因', async () => {
    mocks.claimOne.mockRejectedValueOnce(new ApiError('认领地址数已达上限（1）', { code: 'forbidden', httpStatus: 403 }));
    const { client } = renderDialog(['one.test']);
    setCount('3');
    fireEvent.click(screen.getByRole('button', { name: '随机生成' }));
    const values = prefixes();
    fireEvent.click(screen.getByRole('button', { name: '认领 3 个' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('认领地址数已达上限（1）');
    expect(prefixes()).toEqual(values);
    expect(screen.queryByText(/已认领 \d+ 个地址/)).toBeNull();
    client.clear();
  });

  it('批量认领整单失败、结果未知（服务端已提交后断网）：照样刷新我的邮箱，提示以邮箱列表为准', async () => {
    mocks.batchClaim.mockRejectedValueOnce(new ApiError('网络连接失败，请检查网络后重试', { code: 'network' }));
    const { client } = renderDialog(['one.test']);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const reset = vi.spyOn(client, 'resetQueries');
    setCount('3');
    fireEvent.click(screen.getByRole('button', { name: '随机生成' }));
    const values = prefixes();
    fireEvent.click(screen.getByRole('button', { name: '认领 3 个' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('网络连接失败，请检查网络后重试。部分地址可能已认领，请以邮箱列表为准');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['mailboxes'] });
    expect(reset).toHaveBeenCalledWith({ queryKey: ['messages'] });
    expect(prefixes()).toEqual(values);
    client.clear();
  });

  it('单个认领遇到服务端异常、结果未知：同样刷新我的邮箱，提示以邮箱列表为准', async () => {
    mocks.claim.mockRejectedValueOnce(new ApiError('服务器内部错误', { code: 'internal', httpStatus: 500 }));
    const { client } = renderDialog(['one.test']);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    fireEvent.change(screen.getByPlaceholderText('例如 hello'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: '认领' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('服务器内部错误。该地址可能已认领，请以邮箱列表为准');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['mailboxes'] });
    expect(mocks.batchClaim).not.toHaveBeenCalled();
    client.clear();
  });

  it('批量认领后端中途非业务错误停止（internal）：出错那项可能已提交，照样刷新我的邮箱', async () => {
    mocks.batchClaim.mockResolvedValueOnce({
      claimed: [], taken: [], notAttempted: [],
      stoppedBy: { code: 'internal', message: '认领中断，部分地址可能已认领，请以邮箱列表为准' },
    });
    const { client } = renderDialog(['one.test']);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    setCount('2');
    fireEvent.click(screen.getByRole('button', { name: '随机生成' }));
    fireEvent.click(screen.getByRole('button', { name: '认领 2 个' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('认领中断，部分地址可能已认领，请以邮箱列表为准');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['mailboxes'] });
    client.clear();
  });

  it('批量可用性检查失败：只整批重试一次，不会退化成逐行的单个请求', async () => {
    const offline = new ApiError('网络连接失败', { code: 'network' });
    mocks.batchAvailability.mockRejectedValueOnce(offline).mockRejectedValueOnce(offline);
    // 与线上一致：非 4xx 错误默认会按行重试（这里把延迟调短，逐行重试若存在会很快暴露）
    const { client } = renderDialog(['one.test'], vi.fn(), {
      defaultOptions: { queries: { retry: (count) => count < 2, retryDelay: 10 } },
    });
    setCount('3');
    fireEvent.click(screen.getByRole('button', { name: '随机生成' }));
    await waitFor(() => expect(mocks.batchAvailability).toHaveBeenCalledTimes(2), { timeout: 3000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(mocks.batchAvailability).toHaveBeenCalledTimes(2);
    expect(mocks.availability).not.toHaveBeenCalled();
    client.clear();
  });

  it('批量认领在处理前被拒绝（4xx）：确定一个都没认领，只重新核对可用性', async () => {
    mocks.batchClaim.mockRejectedValueOnce(new ApiError('请求过于频繁', { code: 'rate_limited', httpStatus: 429 }));
    const { client } = renderDialog(['one.test']);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    setCount('2');
    fireEvent.click(screen.getByRole('button', { name: '随机生成' }));
    fireEvent.click(screen.getByRole('button', { name: '认领 2 个' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/^请求过于频繁$/);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['mailboxes', 'availability'] });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['mailboxes'] });
    client.clear();
  });

  it('有地址不可认领或重复时标红该行并禁用认领，修复后恢复', async () => {
    mocks.availableOf.mockImplementation(async (localPart = '') =>
      localPart === 'busy' ? { available: false, reason: 'taken' } : { available: true },
    );
    const { client } = renderDialog(['one.test']);
    setCount('2');
    fireEvent.click(screen.getByRole('button', { name: '随机生成' }));
    fireEvent.change(screen.getByLabelText('前缀 1'), { target: { value: 'busy' } });
    expect(await screen.findByText('该地址已被占用，换一个前缀试试', {}, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '认领 2 个' })).toBeDisabled();
    expect(screen.getByLabelText('前缀 1')).toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(screen.getByLabelText('前缀 1'), { target: { value: 'fine' } });
    fireEvent.change(screen.getByLabelText('前缀 2'), { target: { value: 'fine' } });
    expect(screen.getAllByText('与其他地址重复')).toHaveLength(2);
    expect(screen.getByRole('button', { name: '认领 2 个' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('前缀 2'), { target: { value: 'fine2' } });
    await waitFor(() => expect(screen.getByRole('button', { name: '认领 2 个' })).toBeEnabled(), { timeout: 2000 });
    mocks.availableOf.mockImplementation(async () => ({ available: true }));
    client.clear();
  });

  it('个数框只收数字，999 可输入，1000 夹到 999，失焦后归一到 1~999', () => {
    const { client } = renderDialog();
    const input = screen.getByLabelText('随机生成个数');
    setCount('a1b2');
    expect(input).toHaveValue('12');
    setCount('999');
    fireEvent.blur(input);
    expect(input).toHaveValue('999');
    setCount('1000');
    expect(input).toHaveValue('999');
    fireEvent.blur(input);
    expect(input).toHaveValue('999');
    setCount('');
    fireEvent.blur(input);
    expect(input).toHaveValue('1');
    client.clear();
  });

  it('在个数框按回车只是随机生成，不会认领', () => {
    const { client } = renderDialog(['one.test']);
    setCount('2');
    fireEvent.keyDown(screen.getByLabelText('随机生成个数'), { key: 'Enter' });
    expect(prefixes()).toHaveLength(2);
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.batchClaim).not.toHaveBeenCalled();
    client.clear();
  });

  it('认领进行中不能关闭对话框，也不能重复提交', async () => {
    let release!: () => void;
    mocks.batchClaim.mockImplementationOnce(
      (items) => new Promise((resolve) => {
        release = () => resolve({
          claimed: items.map((item) => mocks.mailbox(item)),
          taken: [], notAttempted: [], stoppedBy: null,
        });
      }),
    );
    const onOpenChange = vi.fn();
    const { client } = renderDialog(['one.test'], onOpenChange);
    setCount('2');
    fireEvent.click(screen.getByRole('button', { name: '随机生成' }));
    fireEvent.click(screen.getByRole('button', { name: '认领 2 个' }));
    expect(await screen.findByText('正在认领 2 个地址…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '随机生成' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /认领 2 个/ }));
    expect(mocks.batchClaim).toHaveBeenCalledTimes(1);
    release();
    await screen.findByText('已认领 2 个地址');
    expect(mocks.claim).not.toHaveBeenCalled();
    client.clear();
  });
});

describe('随机后缀模式', () => {
  const DOMAINS = ['a.test', 'b.test', 'c.test'];
  const RANDOM = /^[a-z][a-z2-9]{7}$/;
  const setCount = (value: string) => fireEvent.change(screen.getByLabelText('随机生成个数'), { target: { value } });
  const randomize = () => fireEvent.click(screen.getByRole('button', { name: '随机生成' }));
  const selectMode = (label: string) => fireEvent.click(screen.getByRole('radio', { name: label }));
  /** 各行当前显示的域名（每行一个域名下拉） */
  const rowDomains = () => screen.getAllByRole('combobox').map((box) => box.textContent);
  const prefixes = () => screen.getAllByLabelText(/^前缀/).map((input) => (input as HTMLInputElement).value);
  const pickDomainOfRow = async (row: number, domain: string) => {
    fireEvent.click(screen.getByRole('combobox', { name: `域名 ${row}` }));
    fireEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: domain }));
  };
  /** 后端返回的分配结果 */
  const planOf = (
    strategy: 'uniform' | 'claude',
    items: Array<[string, number]>,
    extra: { pool?: string[]; shortfall?: number; reason?: ClaimPlan['reason'] } = {},
  ) => ({
    strategy,
    items: items.map(([domain, suspended]) => ({ domain, suspended })),
    pool: extra.pool ?? DOMAINS,
    shortfall: extra.shortfall ?? 0,
    reason: extra.reason ?? null,
  });
  /** 等后端分配返回、各行换成指定的域名 */
  const waitRows = (domains: string[]) => waitFor(() => expect(rowDomains()).toEqual(domains));

  it('只有一个可见域名时没有模式选项，行尾直接显示域名', () => {
    const { client } = renderDialog(['only.test']);
    expect(screen.queryByRole('radiogroup', { name: '随机后缀模式' })).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByText('only.test')).toBeInTheDocument();
    client.clear();
  });

  it('有多个可见域名时出现三种模式，默认固定后缀', () => {
    const { client } = renderDialog(DOMAINS);
    expect(screen.getAllByRole('radio').map((radio) => radio.textContent)).toEqual(['固定后缀', '均匀随机', 'Claude 低风险']);
    expect(screen.getByRole('radio', { name: '固定后缀' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('都用当前选择的域名')).toBeInTheDocument();
    client.clear();
  });

  it('固定后缀：批量生成的地址都用同一个域名（默认第一个），不请求后端分配', () => {
    const { client } = renderDialog(DOMAINS);
    setCount('10');
    randomize();
    expect(new Set(rowDomains())).toEqual(new Set(['a.test']));
    expect(mocks.randomPlan).not.toHaveBeenCalled();
    client.clear();
  });

  it('均匀随机：按个数向后端要分配，逐行用返回的域名，前缀随机且不认领', async () => {
    mocks.randomPlan.mockResolvedValueOnce(planOf('uniform', [['b.test', 0], ['c.test', 0], ['b.test', 0]]));
    const { client } = renderDialog(DOMAINS);
    selectMode('均匀随机');
    setCount('3');
    randomize();
    await waitRows(['b.test', 'c.test', 'b.test']);
    expect(mocks.randomPlan).toHaveBeenCalledWith(3, 'uniform');
    const values = prefixes();
    values.forEach((value) => expect(value).toMatch(RANDOM));
    expect(new Set(values).size).toBe(3);
    await waitFor(() => expect(mocks.availableOf).toHaveBeenCalledWith(values[1], 'c.test'));
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.batchClaim).not.toHaveBeenCalled();
    client.clear();
  });

  it('后端一个都没分到时保留现有的行，并说明原因', async () => {
    mocks.randomPlan.mockResolvedValueOnce(planOf('uniform', [], { pool: [], shortfall: 3, reason: 'no_candidates' }));
    const { client } = renderDialog(DOMAINS);
    selectMode('均匀随机');
    setCount('3');
    randomize();
    expect(await screen.findByText('没有参与随机的可用域名，可手动选择域名')).toBeInTheDocument();
    expect(screen.getAllByLabelText(/^前缀/)).toHaveLength(1);
    client.clear();
  });

  it('确认认领时，每个地址用它自己显示的域名', async () => {
    const { client } = renderDialog(DOMAINS);
    selectMode('均匀随机');
    setCount('8');
    randomize();
    await waitFor(() => expect(prefixes()).toHaveLength(8));
    const shown = prefixes().map((prefix, index) => ({ localPart: prefix, domain: rowDomains()[index]! }));
    fireEvent.click(screen.getByRole('button', { name: '认领 8 个' }));
    await screen.findByText('已认领 8 个地址');
    expect(mocks.batchClaim).toHaveBeenCalledWith(shown);
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual(
      shown.map((item) => `${item.localPart}@${item.domain}`),
    );
    client.clear();
  });

  it('随机出来的后缀也可以手动改：改哪一行就只影响哪一行', async () => {
    const { client } = renderDialog(DOMAINS);
    selectMode('均匀随机');
    setCount('3');
    randomize();
    await waitRows(['a.test', 'b.test', 'c.test']);
    await pickDomainOfRow(2, 'c.test');
    expect(rowDomains()).toEqual(['a.test', 'c.test', 'c.test']);
    const typed = prefixes();
    await waitFor(() => expect(mocks.availability).toHaveBeenCalledWith(typed[1], 'c.test'));
    fireEvent.click(screen.getByRole('button', { name: '认领 3 个' }));
    await screen.findByText('已认领 3 个地址');
    expect(mocks.batchClaim).toHaveBeenCalledWith([
      { localPart: typed[0], domain: 'a.test' },
      { localPart: typed[1], domain: 'c.test' },
      { localPart: typed[2], domain: 'c.test' },
    ]);
    client.clear();
  });

  it('同一前缀在不同域名下不算重复，在同一个域名下才算', async () => {
    const { client } = renderDialog(DOMAINS);
    setCount('2');
    randomize();
    fireEvent.change(screen.getByLabelText('前缀 1'), { target: { value: 'same' } });
    fireEvent.change(screen.getByLabelText('前缀 2'), { target: { value: 'same' } });
    expect(screen.getAllByText('与其他地址重复')).toHaveLength(2);
    await pickDomainOfRow(2, 'b.test');
    expect(screen.queryByText('与其他地址重复')).toBeNull();
    client.clear();
  });

  it('单个重新随机：固定后缀只换前缀、保留这一行的域名；均匀随机从上次返回的候选里换后缀', async () => {
    mocks.randomPlan.mockResolvedValueOnce(planOf('uniform', [['b.test', 0], ['b.test', 0]], { pool: ['b.test', 'c.test'] }));
    const { client } = renderDialog(DOMAINS);
    setCount('2');
    randomize();
    // 第 1 行 b.test、第 2 行 c.test：此时「最近选的域名」是 c.test，与第 1 行不同
    await pickDomainOfRow(1, 'b.test');
    await pickDomainOfRow(2, 'c.test');
    const [firstPrefix] = prefixes();
    for (let i = 0; i < 15; i++) fireEvent.click(screen.getByRole('button', { name: '重新随机第 1 个' }));
    await waitFor(() => expect(prefixes()[0]).not.toBe(firstPrefix));
    expect(rowDomains()).toEqual(['b.test', 'c.test']);

    selectMode('均匀随机');
    randomize();
    await waitRows(['b.test', 'b.test']);
    // 两个候选都出现即可停；上限 40 次，漏掉其中一个的概率约 2^-40
    const seen = new Set<string>();
    for (let i = 0; i < 40 && seen.size < 2; i++) {
      fireEvent.click(screen.getByRole('button', { name: '重新随机第 1 个' }));
      await waitFor(() => expect(screen.getByRole('button', { name: '重新随机第 1 个' })).toBeEnabled());
      seen.add(rowDomains()[0]!);
    }
    expect([...seen].sort()).toEqual(['b.test', 'c.test']);
    expect(mocks.randomPlan).toHaveBeenCalledTimes(1);
    client.clear();
  });

  it('切回固定后缀再生成，回到统一域名（最近一次手动选的域名）', async () => {
    const { client } = renderDialog(DOMAINS);
    selectMode('均匀随机');
    setCount('6');
    randomize();
    await waitFor(() => expect(prefixes()).toHaveLength(6));
    selectMode('固定后缀');
    const picked = rowDomains()[0] === 'c.test' ? 'b.test' : 'c.test';
    await pickDomainOfRow(1, picked);
    randomize();
    expect(new Set(rowDomains())).toEqual(new Set([picked]));
    expect(mocks.randomPlan).toHaveBeenCalledTimes(1);
    client.clear();
  });

  it('某行域名被占用时，提示换域名可行，并保持其余行不受影响', async () => {
    mocks.availableOf.mockImplementation(async (_localPart = '', domain = '') =>
      domain === 'b.test' ? { available: false, reason: 'domain_limit' } : { available: true },
    );
    const { client } = renderDialog(DOMAINS);
    setCount('2');
    randomize();
    await pickDomainOfRow(2, 'b.test');
    expect(await screen.findByText(/该域名下的认领数已达上限/, {}, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '认领 2 个' })).toBeDisabled();
    expect(screen.getByLabelText('前缀 1')).not.toHaveAttribute('aria-invalid', 'true');
    mocks.availableOf.mockImplementation(async () => ({ available: true }));
    client.clear();
  });

  it('认领中途被占用后「返回修改」，保留各自的域名', async () => {
    mocks.claimOne.mockImplementation(async (body) => {
      if (body.localPart === 'busy') throw new ApiError('该地址已被占用', { code: 'address_taken', httpStatus: 409 });
      return mocks.mailbox(body);
    });
    const { client } = renderDialog(DOMAINS);
    setCount('2');
    randomize();
    // 被占用的第 1 行用 c.test，而「最近选的域名」是第 2 行的 b.test：返回修改后必须仍是 c.test
    await pickDomainOfRow(1, 'c.test');
    await pickDomainOfRow(2, 'b.test');
    fireEvent.change(screen.getByLabelText('前缀 1'), { target: { value: 'busy' } });
    fireEvent.click(screen.getByRole('button', { name: '认领 2 个' }));
    await screen.findByText('已认领 1 个地址，还有 1 个未认领');
    expect(mocks.batchClaim.mock.calls[0]![0].map((item) => item.domain)).toEqual(['c.test', 'b.test']);
    fireEvent.click(screen.getByRole('button', { name: '返回修改' }));
    expect(prefixes()).toEqual(['busy']);
    expect(rowDomains()).toEqual(['c.test']);
    mocks.claimOne.mockImplementation(async (body) => mocks.mailbox(body));
    client.clear();
  });

  it('关闭再打开后，模式恢复为固定后缀', async () => {
    mocks.randomPlan.mockResolvedValueOnce(planOf('claude', [['b.test', 3], ['a.test', 0]]));
    const { client, view } = renderDialog(DOMAINS);
    selectMode('Claude 低风险');
    setCount('2');
    randomize();
    expect(await screen.findByText('其中 1 个落在有封号记录的后缀')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.getByRole('radio', { name: '固定后缀' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByText('其中 1 个落在有封号记录的后缀')).toBeNull();
    view.unmount();
    client.clear();
  });

  describe('Claude 低风险', () => {
    it('按个数向后端要 Claude 分配，有封号记录的后缀在行内标出并统计个数', async () => {
      mocks.randomPlan.mockResolvedValueOnce(planOf('claude', [['a.test', 0], ['b.test', 2], ['c.test', 0], ['b.test', 2]]));
      const { client } = renderDialog(DOMAINS);
      selectMode('Claude 低风险');
      expect(screen.getByText('排除高风险后缀，按 Claude 封号数、账号数从少到多分配，每个后缀每天限量')).toBeInTheDocument();
      setCount('4');
      randomize();
      await waitRows(['a.test', 'b.test', 'c.test', 'b.test']);
      expect(mocks.randomPlan).toHaveBeenCalledWith(4, 'claude');
      const badges = screen.getAllByText('封 2');
      expect(badges).toHaveLength(2);
      expect(badges[0]).toHaveAttribute('title', '该后缀历史上有 2 个地址收到 Claude 封号信');
      expect(screen.getByText('其中 2 个落在有封号记录的后缀')).toBeInTheDocument();
      client.clear();
    });

    it('全部落在 0 封号后缀时不显示风险提示', async () => {
      const { client } = renderDialog(DOMAINS);
      selectMode('Claude 低风险');
      setCount('3');
      randomize();
      await waitRows(['a.test', 'b.test', 'c.test']);
      expect(screen.queryByText(/落在有封号记录的后缀/)).toBeNull();
      expect(screen.queryByText(/^封 /)).toBeNull();
      client.clear();
    });

    it('额度不足只分到一部分时，按分到的个数生成并说明', async () => {
      mocks.randomPlan.mockResolvedValueOnce(planOf('claude', [['a.test', 0], ['c.test', 0]], { shortfall: 3, reason: 'quota' }));
      const { client } = renderDialog(DOMAINS);
      selectMode('Claude 低风险');
      setCount('5');
      randomize();
      await waitRows(['a.test', 'c.test']);
      expect(screen.getByText('额度不足，只分配了 2 个')).toBeInTheDocument();
      client.clear();
    });

    it('低风险后缀今天的名额或每域名额用完时说明原因', async () => {
      mocks.randomPlan.mockResolvedValueOnce(planOf('claude', [['a.test', 0]], { shortfall: 2, reason: 'daily_limit' }));
      const { client } = renderDialog(DOMAINS);
      selectMode('Claude 低风险');
      setCount('3');
      randomize();
      await waitRows(['a.test']);
      expect(screen.getByText('低风险后缀今天的新增名额已用完，只分配了 1 个，可稍后再试或手动选择域名')).toBeInTheDocument();
      mocks.randomPlan.mockResolvedValueOnce(planOf('claude', [], { shortfall: 3, reason: 'domain_quota' }));
      randomize();
      expect(await screen.findByText('可选后缀的每域名额已用完，可手动选择其他域名')).toBeInTheDocument();
      client.clear();
    });

    it('没有可用的低风险后缀时保留现有的行，提示手动选择', async () => {
      mocks.randomPlan.mockResolvedValueOnce(planOf('claude', [], { pool: DOMAINS, shortfall: 2, reason: 'no_candidates' }));
      const { client } = renderDialog(DOMAINS);
      selectMode('Claude 低风险');
      setCount('2');
      randomize();
      expect(await screen.findByText('没有可用于 Claude 的低风险后缀，可手动选择域名')).toBeInTheDocument();
      expect(rowDomains()).toEqual(['a.test']);
      client.clear();
    });

    it('分配请求失败时显示原因，不改动现有的行', async () => {
      mocks.randomPlan.mockRejectedValueOnce(new ApiError('服务暂时不可用', { code: 'internal', httpStatus: 500 }));
      const { client } = renderDialog(DOMAINS);
      selectMode('Claude 低风险');
      setCount('3');
      randomize();
      expect(await screen.findByRole('alert')).toHaveTextContent('服务暂时不可用');
      expect(prefixes()).toEqual(['']);
      client.clear();
    });

    it('分配进行中按钮禁用，连点不会重复请求', async () => {
      let resolve: (value: ReturnType<typeof planOf>) => void = () => {};
      mocks.randomPlan.mockImplementationOnce(() => new Promise((done) => (resolve = done)));
      const { client } = renderDialog(DOMAINS);
      selectMode('Claude 低风险');
      setCount('2');
      randomize();
      // 加载中按钮名带上转圈的「加载中」
      await waitFor(() => expect(screen.getByRole('button', { name: /随机生成/ })).toBeDisabled());
      fireEvent.click(screen.getByRole('button', { name: /随机生成/ }));
      fireEvent.keyDown(screen.getByLabelText('随机生成个数'), { key: 'Enter' });
      expect(mocks.randomPlan).toHaveBeenCalledTimes(1);
      resolve(planOf('claude', [['b.test', 0], ['c.test', 0]]));
      await waitRows(['b.test', 'c.test']);
      client.clear();
    });

    it('单个重新随机只换前缀、保留分配好的后缀，不再请求后端', async () => {
      mocks.randomPlan.mockResolvedValueOnce(planOf('claude', [['a.test', 0], ['c.test', 1]]));
      const { client } = renderDialog(DOMAINS);
      selectMode('Claude 低风险');
      setCount('2');
      randomize();
      await waitRows(['a.test', 'c.test']);
      const [, second] = prefixes();
      for (let i = 0; i < 10; i++) fireEvent.click(screen.getByRole('button', { name: '重新随机第 2 个' }));
      await waitFor(() => expect(prefixes()[1]).not.toBe(second));
      expect(rowDomains()).toEqual(['a.test', 'c.test']);
      expect(screen.getByText('封 1')).toBeInTheDocument();
      expect(mocks.randomPlan).toHaveBeenCalledTimes(1);
      client.clear();
    });
  });
});

describe('管理员把认领结果一键共享给其他人', () => {
  const admin: SessionUser = { ...member, id: 1, username: 'root', role: 'admin' };
  const SHARE_KEYS = [{ queryKey: ['mailboxes', 'shares'] }, { queryKey: ['admin', 'mailbox-shares'] }];
  const setCount = (value: string) => fireEvent.change(screen.getByLabelText('随机生成个数'), { target: { value } });
  const claimedAddresses = () => screen.getAllByRole('listitem').map((item) => item.textContent!);
  const userOptions = () => screen.getAllByRole('checkbox').map((box) => box.closest('label')!.textContent);
  const shareStep = (count: number) => screen.queryByRole('dialog', { name: `把刚认领的 ${count} 个邮箱共享给…` });
  const shareButton = () => screen.getByRole('button', { name: '共享给…' });
  const submit = (count: number) => fireEvent.click(screen.getByRole('button', { name: `共享 ${count} 个邮箱` }));
  /** 「已共享给」播报区：结果页出现时就挂载，此时为空 */
  /** 点遮罩：Radix 在主键按下后等到 click 才判定点在弹窗外 */
  const clickOverlay = () => {
    const overlay = document.querySelector('.bg-scrim')!;
    fireEvent.pointerDown(overlay);
    fireEvent.click(overlay);
  };
  const sharedRegion = () => screen.getAllByRole('status').find((node) => !node.textContent?.startsWith('已认领'))!;

  afterEach(() => onlineManager.setOnline(true));

  /** 以管理员身份打开认领弹窗；spy 在渲染后创建，调用方按需在认领完成后清空 */
  function renderAdmin(onOpenChange = vi.fn()) {
    const { client } = renderDialog(['one.test'], onOpenChange, { user: admin });
    return { client, onOpenChange, invalidate: vi.spyOn(client, 'invalidateQueries'), resetQueries: vi.spyOn(client, 'resetQueries') };
  }

  /** 随机生成 count 个并认领，停在结果页 */
  async function claimBatch(count: number, edit?: () => void) {
    setCount(String(count));
    fireEvent.click(screen.getByRole('button', { name: '随机生成' }));
    edit?.();
    fireEvent.click(screen.getByRole('button', { name: `认领 ${count} 个` }));
    await screen.findByText(/^已认领 \d+ 个地址/);
  }

  async function openShare(count: number) {
    fireEvent.click(shareButton());
    expect(await screen.findByRole('dialog', { name: `把刚认领的 ${count} 个邮箱共享给…` })).toBeInTheDocument();
    await screen.findByRole('checkbox', { name: 'alice' });
  }

  it('批量认领后可共享给选中的用户：候选只含启用中的其他用户，提交认领成功的邮箱 id', async () => {
    const { client, invalidate, resetQueries } = renderAdmin();
    await claimBatch(3);
    const addresses = claimedAddresses();
    const region = sharedRegion();
    expect(region).toHaveTextContent(/^$/);
    // 认领本身也会刷新缓存：清掉，只核对共享带来的刷新
    invalidate.mockClear();
    resetQueries.mockClear();
    await openShare(3);
    expect(screen.getByText(/全部未删除来信/)).toBeInTheDocument();
    // 排除自己（root）与已禁用的 carol
    expect(userOptions()).toEqual(['alice', 'bob', 'ops']);
    expect(screen.getByRole('button', { name: '共享 3 个邮箱' })).toBeDisabled();
    const search = screen.getByRole('textbox', { name: '搜索共享用户' });
    fireEvent.change(search, { target: { value: 'BO' } });
    expect(userOptions()).toEqual(['bob']);
    fireEvent.click(screen.getByRole('checkbox', { name: 'bob' }));
    fireEvent.change(search, { target: { value: 'ali' } });
    // 已选的人在搜索别人时仍保留
    expect(userOptions()).toEqual(['alice', 'bob']);
    fireEvent.click(screen.getByRole('checkbox', { name: 'alice' }));
    expect(screen.getByText('已选 2/100 人，已有的共享成员会保留。')).toBeInTheDocument();
    submit(3);

    await waitFor(() => expect(region).toHaveTextContent('已共享给：alice、bob'));
    // 播报区一直是同一个节点，名单更新时读屏能播报
    expect(sharedRegion()).toBe(region);
    expect(mocks.batchShare).toHaveBeenCalledTimes(1);
    expect(mocks.batchShare).toHaveBeenCalledWith({ mailboxIds: addresses.map(mocks.idOf), userIds: [2, 3] });
    // 结果页已显示名单，不再弹 toast；只刷新共享名单，不动邮件与归属缓存
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(invalidate.mock.calls.map(([filters]) => filters)).toEqual(SHARE_KEYS);
    expect(resetQueries).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: '认领邮箱地址' })).toBeInTheDocument();
    expect(claimedAddresses()).toEqual(addresses);
    expect(shareButton()).toHaveFocus();

    // 可以再共享给其他人，结果页的名单随之累加
    await openShare(3);
    fireEvent.click(screen.getByRole('checkbox', { name: 'ops' }));
    submit(3);
    await waitFor(() => expect(region).toHaveTextContent('已共享给：alice、bob、ops'));
    expect(mocks.batchShare).toHaveBeenLastCalledWith({ mailboxIds: addresses.map(mocks.idOf), userIds: [5] });
    client.clear();
  });

  it('普通用户批量认领后，结果页没有「共享给…」', async () => {
    const { client } = renderDialog(['one.test']);
    await claimBatch(2);
    expect(screen.getByRole('button', { name: '复制全部地址' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '共享给…' })).toBeNull();
    expect(mocks.listUsers).not.toHaveBeenCalled();
    client.clear();
  });

  it('部分认领（有未认领的）时只共享已认领的邮箱；结果页在共享期间只隐藏不重建', async () => {
    mocks.claimOne.mockImplementation(async (body) => {
      if (body.localPart === 'taken-two') throw new ApiError('该地址已被占用', { code: 'address_taken', httpStatus: 409 });
      return mocks.mailbox(body);
    });
    const { client } = renderAdmin();
    await claimBatch(3, () => fireEvent.change(screen.getByLabelText('前缀 2'), { target: { value: 'taken-two' } }));
    expect(screen.getByText('已认领 2 个地址，还有 1 个未认领')).toBeInTheDocument();
    const addresses = claimedAddresses();
    expect(addresses).toHaveLength(2);
    const alert = screen.getByRole('alert');
    expect(screen.getByRole('button', { name: '返回修改' })).toBeInTheDocument();
    await openShare(2);
    // 共享步骤里结果页不可见，但节点仍在
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(alert).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'alice' }));
    submit(2);
    await waitFor(() => expect(sharedRegion()).toHaveTextContent('已共享给：alice'));
    expect(mocks.batchShare).toHaveBeenCalledWith({ mailboxIds: addresses.map(mocks.idOf), userIds: [2] });
    // 回到结果页还是原来的提示节点，不会被重建后重复播报
    expect(screen.getByRole('alert')).toBe(alert);
    mocks.claimOne.mockImplementation(async (body) => mocks.mailbox(body));
    client.clear();
  });

  it('冲突（409）时留在共享步骤显示原因、刷新邮箱归属，可重试', async () => {
    mocks.batchShare.mockRejectedValueOnce(new ApiError('邮箱归属已变化，请刷新后重试', { code: 'conflict', httpStatus: 409 }));
    const { client, invalidate } = renderAdmin();
    await claimBatch(2);
    invalidate.mockClear();
    await openShare(2);
    fireEvent.click(screen.getByRole('checkbox', { name: 'bob' }));
    submit(2);
    // 4xx 整单未写入：不提示「可能已生效」
    expect(await screen.findByRole('alert')).toHaveTextContent(/^邮箱归属已变化，请刷新后重试$/);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['mailboxes'] });
    expect(shareStep(2)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'bob' })).toBeChecked();
    submit(2);
    await waitFor(() => expect(sharedRegion()).toHaveTextContent('已共享给：bob'));
    expect(mocks.batchShare).toHaveBeenCalledTimes(2);
    client.clear();
  });

  it('校验失败（选中的人刚被禁用）时刷新用户名单，失效的人移出已选后重试成功', async () => {
    mocks.batchShare.mockRejectedValueOnce(new ApiError('部分用户不可共享', { code: 'validation_failed', httpStatus: 400 }));
    const { client, invalidate } = renderAdmin();
    await claimBatch(2);
    invalidate.mockClear();
    await openShare(2);
    fireEvent.click(screen.getByRole('checkbox', { name: 'alice' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'bob' }));
    const users = await mocks.listUsers();
    mocks.listUsers.mockResolvedValueOnce(users.map((user) => (user.id === 3 ? { ...user, status: 'disabled' } : user)));
    submit(2);
    expect(await screen.findByRole('alert')).toHaveTextContent(/^部分用户不可共享$/);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['admin', 'users'] });
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'bob' })).toBeNull());
    expect(screen.getByText('已选 1/100 人，已有的共享成员会保留。')).toBeInTheDocument();
    submit(2);
    await waitFor(() => expect(sharedRegion()).toHaveTextContent('已共享给：alice'));
    expect(mocks.batchShare).toHaveBeenLastCalledWith(expect.objectContaining({ userIds: [2] }));
    client.clear();
  });

  it('被禁用而隐藏的人之后重新启用，不会以已勾选状态回来、也不会被提交', async () => {
    const { client } = renderAdmin();
    await claimBatch(2);
    await openShare(2);
    fireEvent.click(screen.getByRole('checkbox', { name: 'alice' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'bob' }));
    const users = await mocks.listUsers();
    mocks.listUsers.mockResolvedValueOnce(users.map((user) => (user.id === 3 ? { ...user, status: 'disabled' } : user)));
    void client.invalidateQueries({ queryKey: ['admin', 'users'] });
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'bob' })).toBeNull());
    void client.invalidateQueries({ queryKey: ['admin', 'users'] });
    const bob = await screen.findByRole('checkbox', { name: 'bob' });
    expect(bob).not.toBeChecked();
    expect(screen.getByText('已选 1/100 人，已有的共享成员会保留。')).toBeInTheDocument();
    submit(2);
    await waitFor(() => expect(mocks.batchShare).toHaveBeenCalledWith(expect.objectContaining({ userIds: [2] })));
    client.clear();
  });

  it.each([
    ['网络中断', new ApiError('网络连接失败', { code: 'network' }), '网络连接失败'],
    ['服务端异常 5xx', new ApiError('服务器内部错误', { code: 'internal', httpStatus: 502 }), '服务器内部错误'],
  ])('结果不明（%s）：提示共享可能已生效，并刷新共享名单', async (_name, error, message) => {
    mocks.batchShare.mockRejectedValueOnce(error);
    const { client, invalidate } = renderAdmin();
    await claimBatch(2);
    invalidate.mockClear();
    await openShare(2);
    fireEvent.click(screen.getByRole('checkbox', { name: 'alice' }));
    submit(2);
    expect(await screen.findByRole('alert')).toHaveTextContent(`${message}。共享可能已生效，可在「我的邮箱」中查看各邮箱的共享名单`);
    expect(invalidate.mock.calls.map(([filters]) => filters)).toEqual(SHARE_KEYS);
    expect(shareStep(2)).toBeInTheDocument();
    client.clear();
  });

  it('离线时也立即发出请求并快速失败，失败后仍可按 Esc 回到结果页', async () => {
    const { client, onOpenChange } = renderAdmin();
    await claimBatch(2);
    await openShare(2);
    fireEvent.click(screen.getByRole('checkbox', { name: 'alice' }));
    onlineManager.setOnline(false);
    mocks.batchShare.mockRejectedValueOnce(new ApiError('网络连接失败', { code: 'network' }));
    submit(2);
    expect(await screen.findByRole('alert')).toHaveTextContent('网络连接失败');
    expect(mocks.batchShare).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: '认领邮箱地址' })).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
    client.clear();
  });

  it('离线且没有缓存时显示加载中与离线提示，而不是「没有匹配」；恢复网络后自动加载', async () => {
    const { client } = renderAdmin();
    await claimBatch(2);
    onlineManager.setOnline(false);
    fireEvent.click(shareButton());
    expect(await screen.findByText('当前处于离线状态，恢复网络后会自动加载用户列表。')).toBeInTheDocument();
    expect(screen.getByText('正在加载用户…')).toBeInTheDocument();
    expect(screen.queryByText('没有匹配的启用用户')).toBeNull();
    onlineManager.setOnline(true);
    expect(await screen.findByRole('checkbox', { name: 'alice' })).toBeInTheDocument();
    expect(screen.queryByText(/当前处于离线状态/)).toBeNull();
    client.clear();
  });

  it.each([
    ['点「返回」', () => fireEvent.click(screen.getByRole('button', { name: '返回' }))],
    ['按 Esc', () => fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })],
    ['点遮罩', () => clickOverlay()],
  ])('共享步骤里%s只回到结果页，保留认领结果，焦点回到「共享给…」', async (_name, leave) => {
    const { client, onOpenChange } = renderAdmin();
    await claimBatch(2);
    const addresses = claimedAddresses();
    expect(screen.getByRole('button', { name: '关闭' })).toBeInTheDocument();
    await openShare(2);
    // 共享步骤不显示右上角关闭，避免误以为会关掉整个弹窗
    expect(screen.queryByRole('button', { name: '关闭' })).toBeNull();
    leave();
    expect(screen.getByRole('dialog', { name: '认领邮箱地址' })).toBeInTheDocument();
    expect(claimedAddresses()).toEqual(addresses);
    expect(shareButton()).toHaveFocus();
    expect(screen.getByRole('button', { name: '关闭' })).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(mocks.batchShare).not.toHaveBeenCalled();
    // 结果页上才真正关闭
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    client.clear();
  });

  it('共享进行中 Esc、点遮罩、返回都不响应；完成后关闭弹窗会清空共享状态', async () => {
    let release!: () => void;
    mocks.batchShare.mockImplementationOnce(
      (body) => new Promise((resolve) => {
        release = () => resolve(body.mailboxIds.map((mailboxId) => ({ mailboxId, grantees: [] })));
      }),
    );
    const { client, onOpenChange } = renderAdmin();
    await claimBatch(2);
    await openShare(2);
    fireEvent.click(screen.getByRole('checkbox', { name: 'alice' }));
    submit(2);
    await waitFor(() => expect(screen.getByRole('button', { name: /共享 2 个邮箱/ })).toBeDisabled());
    expect(screen.getByRole('button', { name: '返回' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'alice' })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    clickOverlay();
    expect(shareStep(2)).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
    release();
    await waitFor(() => expect(sharedRegion()).toHaveTextContent('已共享给：alice'));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // 弹窗由外部保持打开时，关闭动作已把对话框重置回空白表单
    expect(screen.queryByText(/已共享给/)).toBeNull();
    expect(screen.getByRole('button', { name: '认领' })).toBeInTheDocument();
    client.clear();
  });

  it('用户列表加载失败时可重新加载', async () => {
    mocks.listUsers.mockRejectedValueOnce(new ApiError('服务暂时不可用', { code: 'internal', httpStatus: 503 }));
    const { client } = renderAdmin();
    await claimBatch(2);
    fireEvent.click(shareButton());
    expect(await screen.findByText('服务暂时不可用')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '共享 2 个邮箱' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
    expect(await screen.findByRole('checkbox', { name: 'alice' })).toBeInTheDocument();
    client.clear();
  });
});
