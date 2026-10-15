import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/errors';
type Draft = { localPart: string; domain: string };
const mocks = vi.hoisted(() => {
  /** 后端对单个地址的认领结果：单个认领接口与批量认领的模拟共用这一份 */
  const claimOne = vi.fn(async (body: Draft) => ({ address: `${body.localPart}@${body.domain}` }));
  /** 后端对单个地址的可用性结果：单个与批量查询共用 */
  const availableOf = vi.fn(
    async (_localPart = '', _domain = ''): Promise<{ available: boolean; reason?: string }> => ({ available: true }),
  );
  return {
    claimOne,
    availableOf,
    claim: vi.fn((body: Draft) => claimOne(body)),
    /** 模拟后端批量认领：按顺序逐个处理，被占用的跳过，其他错误停止 */
    batchClaim: vi.fn(async (items: Draft[]) => {
      const result = {
        claimed: [] as Array<{ address: string }>,
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
  },
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

function renderDialog(domains = ['example.com'], onOpenChange = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (list: string[]) => (
    <QueryClientProvider client={client}>
      <ClaimDialog open onOpenChange={onOpenChange} domains={list} />
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
      return { address: `${body.localPart}@${body.domain}` };
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
      .mockImplementationOnce(async (body) => ({ address: `${body.localPart}@${body.domain}` }))
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

  it('个数框只收数字，失焦后归一到 1~20', () => {
    const { client } = renderDialog();
    const input = screen.getByLabelText('随机生成个数');
    setCount('a1b2');
    expect(input).toHaveValue('12');
    setCount('99');
    fireEvent.blur(input);
    expect(input).toHaveValue('20');
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
          claimed: items.map((item) => ({ address: `${item.localPart}@${item.domain}` })),
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

describe('随机邮箱后缀', () => {
  const DOMAINS = ['a.test', 'b.test', 'c.test'];
  const setCount = (value: string) => fireEvent.change(screen.getByLabelText('随机生成个数'), { target: { value } });
  const randomize = () => fireEvent.click(screen.getByRole('button', { name: '随机生成' }));
  const toggle = () => fireEvent.click(screen.getByRole('checkbox', { name: /随机邮箱后缀/ }));
  /** 各行当前显示的域名（每行一个域名下拉） */
  const rowDomains = () => screen.getAllByRole('combobox').map((box) => box.textContent);
  const prefixes = () => screen.getAllByLabelText(/^前缀/).map((input) => (input as HTMLInputElement).value);
  const pickDomainOfRow = async (row: number, domain: string) => {
    fireEvent.click(screen.getByRole('combobox', { name: `域名 ${row}` }));
    fireEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: domain }));
  };

  it('只有一个可见域名时没有这个选项，行尾直接显示域名', () => {
    const { client } = renderDialog(['only.test']);
    expect(screen.queryByRole('checkbox', { name: /随机邮箱后缀/ })).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByText('only.test')).toBeInTheDocument();
    client.clear();
  });

  it('有多个可见域名时出现该选项，默认不勾选，并说明候选个数', () => {
    const { client } = renderDialog(DOMAINS);
    expect(screen.getByRole('checkbox', { name: /随机邮箱后缀/ })).not.toBeChecked();
    expect(screen.getByText('（每个地址从 3 个可用域名中随机选）')).toBeInTheDocument();
    client.clear();
  });

  it('不勾选时，批量生成的地址都用同一个域名（默认第一个）', () => {
    const { client } = renderDialog(DOMAINS);
    setCount('10');
    randomize();
    expect(new Set(rowDomains())).toEqual(new Set(['a.test']));
    client.clear();
  });

  it('勾选后，生成的地址后缀从可见域名里随机取，且不会出现候选之外的域名', () => {
    const { client } = renderDialog(DOMAINS);
    toggle();
    setCount('20');
    randomize();
    const used = rowDomains();
    expect(used).toHaveLength(20);
    for (const domain of used) expect(DOMAINS).toContain(domain);
    expect(new Set(used).size).toBeGreaterThan(1);
    client.clear();
  });

  it('候选严格取决于传入的可见域名：只有两个时只会出现这两个', () => {
    const { client } = renderDialog(['x.test', 'y.test']);
    toggle();
    setCount('20');
    randomize();
    expect([...new Set(rowDomains())].sort()).toEqual(['x.test', 'y.test']);
    client.clear();
  });

  it('勾选后个数为 1 也会随机后缀；点生成只展示并按地址查可用性，不会认领', async () => {
    const { client } = renderDialog(DOMAINS);
    toggle();
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      randomize();
      seen.add(rowDomains()[0]!);
    }
    expect(seen.size).toBeGreaterThan(1);
    const [domain] = rowDomains();
    const [prefix] = prefixes();
    // 同一轮里连点 40 次生成的查询会合批，这里只关心最终显示的地址查过可用性
    await waitFor(() => expect(mocks.availableOf).toHaveBeenCalledWith(prefix, domain));
    expect(await screen.findByText(`${prefix}@${domain} 可以认领`)).toBeInTheDocument();
    expect(mocks.claim).not.toHaveBeenCalled();
    client.clear();
  });

  it('确认认领时，每个地址用它自己显示的域名', async () => {
    const { client } = renderDialog(DOMAINS);
    toggle();
    setCount('8');
    randomize();
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
    toggle();
    setCount('3');
    randomize();
    const before = rowDomains();
    const target = before[1] === 'c.test' ? 'a.test' : 'c.test';
    fireEvent.click(screen.getByRole('combobox', { name: '域名 2' }));
    fireEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: target }));
    expect(rowDomains()).toEqual([before[0], target, before[2]]);
    const typed = prefixes();
    await waitFor(() => expect(mocks.availability).toHaveBeenCalledWith(typed[1], target));
    fireEvent.click(screen.getByRole('button', { name: '认领 3 个' }));
    await screen.findByText('已认领 3 个地址');
    expect(mocks.batchClaim).toHaveBeenCalledWith([
      { localPart: typed[0], domain: before[0] },
      { localPart: typed[1], domain: target },
      { localPart: typed[2], domain: before[2] },
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
    fireEvent.click(screen.getByRole('combobox', { name: '域名 2' }));
    fireEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: 'b.test' }));
    expect(screen.queryByText('与其他地址重复')).toBeNull();
    client.clear();
  });

  it('单个重新随机：勾选时连后缀一起换，不勾选时只换前缀、保留这一行的域名', async () => {
    const { client } = renderDialog(DOMAINS);
    setCount('2');
    randomize();
    // 第 1 行 b.test、第 2 行 c.test：此时「最近选的域名」是 c.test，与第 1 行不同
    await pickDomainOfRow(1, 'b.test');
    await pickDomainOfRow(2, 'c.test');
    const [firstPrefix] = prefixes();
    for (let i = 0; i < 15; i++) fireEvent.click(screen.getByRole('button', { name: '重新随机第 1 个' }));
    expect(prefixes()[0]).not.toBe(firstPrefix);
    expect(rowDomains()).toEqual(['b.test', 'c.test']);

    toggle();
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      fireEvent.click(screen.getByRole('button', { name: '重新随机第 1 个' }));
      seen.add(rowDomains()[0]!);
    }
    expect(seen.size).toBeGreaterThan(1);
    client.clear();
  });

  it('取消勾选后再生成，回到统一域名（最近一次手动选的域名）', async () => {
    const { client } = renderDialog(DOMAINS);
    toggle();
    setCount('10');
    randomize();
    toggle();
    // 选一个与第 1 行当前随机结果不同的域名，保证一定触发变更
    const picked = rowDomains()[0] === 'c.test' ? 'b.test' : 'c.test';
    fireEvent.click(screen.getByRole('combobox', { name: '域名 1' }));
    fireEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: picked }));
    randomize();
    expect(new Set(rowDomains())).toEqual(new Set([picked]));
    client.clear();
  });

  it('某行域名被占用时，提示换域名可行，并保持其余行不受影响', async () => {
    mocks.availableOf.mockImplementation(async (_localPart = '', domain = '') =>
      domain === 'b.test' ? { available: false, reason: 'domain_limit' } : { available: true },
    );
    const { client } = renderDialog(DOMAINS);
    setCount('2');
    randomize();
    fireEvent.click(screen.getByRole('combobox', { name: '域名 2' }));
    fireEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: 'b.test' }));
    expect(await screen.findByText(/该域名下的认领数已达上限/, {}, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '认领 2 个' })).toBeDisabled();
    expect(screen.getByLabelText('前缀 1')).not.toHaveAttribute('aria-invalid', 'true');
    mocks.availableOf.mockImplementation(async () => ({ available: true }));
    client.clear();
  });

  it('认领中途被占用后「返回修改」，保留各自的域名', async () => {
    mocks.claimOne.mockImplementation(async (body) => {
      if (body.localPart === 'busy') throw new ApiError('该地址已被占用', { code: 'address_taken', httpStatus: 409 });
      return { address: `${body.localPart}@${body.domain}` };
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
    mocks.claimOne.mockImplementation(async (body) => ({ address: `${body.localPart}@${body.domain}` }));
    client.clear();
  });

  it('关闭再打开后，选项恢复为不勾选', () => {
    const { client, view } = renderDialog(DOMAINS);
    toggle();
    expect(screen.getByRole('checkbox', { name: /随机邮箱后缀/ })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.getByRole('checkbox', { name: /随机邮箱后缀/ })).not.toBeChecked();
    view.unmount();
    client.clear();
  });
});
