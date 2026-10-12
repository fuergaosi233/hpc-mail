import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/errors';
const mocks = vi.hoisted(() => ({
  claim: vi.fn(async (body: { localPart: string; domain: string }) => ({ address: `${body.localPart}@${body.domain}` })),
  availability: vi.fn(async (_localPart = ''): Promise<{ available: boolean; reason?: string }> => ({ available: true })),
  toast: vi.fn(),
  writeClipboard: vi.fn(async () => true),
}));
vi.mock('@/api/resources', () => ({ mailboxApi: { claim: mocks.claim, availability: mocks.availability } }));
vi.mock('@/components/ui/toast', () => ({ toast: mocks.toast }));
vi.mock('@/components/ui/copy-button', () => ({ writeClipboard: mocks.writeClipboard }));
import { ClaimDialog } from './claim-dialog';
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

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
    mocks.availability.mockResolvedValueOnce({ available: false, reason });
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
    expect(mocks.claim).not.toHaveBeenCalled();
    client.clear();
  });

  it('个数为 3：点随机生成只展示 3 个可编辑地址，确认前不会发认领请求', async () => {
    const { client } = renderDialog(['one.test']);
    setCount('3');
    fireEvent.click(screen.getByRole('button', { name: '随机生成' }));
    const values = prefixes();
    expect(values).toHaveLength(3);
    expect(new Set(values).size).toBe(3);
    values.forEach((value) => expect(value).toMatch(RANDOM));
    expect(screen.getByRole('button', { name: '认领 3 个' })).toBeInTheDocument();
    for (const value of values) await waitFor(() => expect(mocks.availability).toHaveBeenCalledWith(value, 'one.test'));
    expect(mocks.claim).not.toHaveBeenCalled();
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
    expect(mocks.claim.mock.calls.map(([body]) => body)).toEqual([
      { localPart: before[0], domain: 'one.test' },
      { localPart: 'my-pick', domain: 'one.test' },
      { localPart: before[2], domain: 'one.test' },
    ]);
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
    expect(mocks.claim).toHaveBeenCalledTimes(2);
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
    mocks.claim.mockImplementation(async (body) => {
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
    mocks.claim
      .mockImplementationOnce(async (body) => ({ address: `${body.localPart}@${body.domain}` }))
      .mockRejectedValueOnce(new ApiError('认领地址数已达上限（1）', { code: 'forbidden', httpStatus: 403 }));
    const { client } = renderDialog(['one.test']);
    setCount('5');
    fireEvent.click(screen.getByRole('button', { name: '随机生成' }));
    fireEvent.click(screen.getByRole('button', { name: '认领 5 个' }));
    await screen.findByText('已认领 1 个地址，还有 4 个未认领');
    expect(screen.getByRole('alert')).toHaveTextContent('未能认领满：认领地址数已达上限（1）');
    expect(screen.queryByRole('button', { name: '返回修改' })).toBeNull();
    expect(mocks.claim).toHaveBeenCalledTimes(2);
    client.clear();
  });

  it('一个都没认领成功：留在表单里保留所有地址并显示原因', async () => {
    mocks.claim.mockRejectedValueOnce(new ApiError('认领地址数已达上限（1）', { code: 'forbidden', httpStatus: 403 }));
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

  it('有地址不可认领或重复时标红该行并禁用认领，修复后恢复', async () => {
    mocks.availability.mockImplementation(async (localPart = '') =>
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
    mocks.availability.mockImplementation(async () => ({ available: true }));
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
    client.clear();
  });

  it('认领进行中不能关闭对话框，也不能重复提交', async () => {
    let release!: () => void;
    mocks.claim.mockImplementation(
      (body) => new Promise((resolve) => { release = () => resolve({ address: `${body.localPart}@${body.domain}` }); }),
    );
    const onOpenChange = vi.fn();
    const { client } = renderDialog(['one.test'], onOpenChange);
    setCount('2');
    fireEvent.click(screen.getByRole('button', { name: '随机生成' }));
    fireEvent.click(screen.getByRole('button', { name: '认领 2 个' }));
    expect(await screen.findByText('正在认领 0/2…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '随机生成' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();
    release();
    await waitFor(() => expect(mocks.claim).toHaveBeenCalledTimes(2));
    release();
    await screen.findByText('已认领 2 个地址');
    mocks.claim.mockImplementation(async (body) => ({ address: `${body.localPart}@${body.domain}` }));
    client.clear();
  });
});
