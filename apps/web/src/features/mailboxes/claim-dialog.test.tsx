import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/errors';
const mocks = vi.hoisted(() => ({
  claim: vi.fn(async (body: { localPart: string; domain: string }) => ({ address: `${body.localPart}@${body.domain}` })),
  availability: vi.fn(async (): Promise<{ available: boolean; reason?: string }> => ({ available: true })),
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

describe('随机批量认领', () => {
  const setCount = (value: string) => fireEvent.change(screen.getByLabelText('随机生成个数'), { target: { value } });
  const addressesOf = () => screen.getAllByRole('listitem').map((item) => item.textContent);

  it('个数默认 1，此时仍是填入前缀的随机生成，不会直接认领', () => {
    const { client } = renderDialog();
    expect(screen.getByLabelText('随机生成个数')).toHaveValue('1');
    fireEvent.click(screen.getByRole('button', { name: '随机生成' }));
    expect(mocks.claim).not.toHaveBeenCalled();
    client.clear();
  });

  it('个数大于 1 时按钮变为「随机生成并认领」，点击后用所选域名认领全部并列出结果', async () => {
    const { client } = renderDialog(['one.test', 'two.test']);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    setCount('3');
    expect(screen.getByText(/将在 @one\.test 下随机生成 3 个地址并直接全部认领/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '随机生成并认领' }));
    await screen.findByText('已认领 3 个地址');
    expect(mocks.claim).toHaveBeenCalledTimes(3);
    for (const [body] of mocks.claim.mock.calls) {
      expect(body.domain).toBe('one.test');
      expect(body.localPart).toMatch(/^[a-z][a-z2-9]{7}$/);
    }
    expect(addressesOf()).toEqual(mocks.claim.mock.calls.map(([body]) => `${body.localPart}@${body.domain}`));
    fireEvent.click(screen.getByRole('button', { name: '复制全部地址' }));
    await waitFor(() => expect(mocks.writeClipboard).toHaveBeenCalledWith(addressesOf().join('\n')));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['mailboxes'] });
    client.clear();
  });

  it('点「完成」关闭对话框', async () => {
    const onOpenChange = vi.fn();
    const { client } = renderDialog(['one.test'], onOpenChange);
    setCount('2');
    fireEvent.click(screen.getByRole('button', { name: '随机生成并认领' }));
    fireEvent.click(await screen.findByRole('button', { name: '完成' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    client.clear();
  });

  it('中途配额用尽：保留已认领的并说明原因，不再继续请求', async () => {
    mocks.claim
      .mockImplementationOnce(async (body) => ({ address: `${body.localPart}@${body.domain}` }))
      .mockRejectedValueOnce(new ApiError('认领地址数已达上限（1）', { code: 'forbidden', httpStatus: 403 }));
    const { client } = renderDialog(['one.test']);
    setCount('5');
    fireEvent.click(screen.getByRole('button', { name: '随机生成并认领' }));
    await screen.findByText('已认领 1 个地址（计划 5 个）');
    expect(screen.getByRole('alert')).toHaveTextContent('未能认领满：认领地址数已达上限（1）');
    expect(mocks.claim).toHaveBeenCalledTimes(2);
    client.clear();
  });

  it('一个都没认领成功：留在表单里显示原因', async () => {
    mocks.claim.mockRejectedValueOnce(new ApiError('认领地址数已达上限（1）', { code: 'forbidden', httpStatus: 403 }));
    const { client } = renderDialog(['one.test']);
    setCount('3');
    fireEvent.click(screen.getByRole('button', { name: '随机生成并认领' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('认领地址数已达上限（1）');
    expect(screen.queryByText(/已认领 \d+ 个地址/)).toBeNull();
    expect(screen.getByLabelText('随机生成个数')).toBeEnabled();
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

  it('在个数框按回车触发随机生成，不会提交前缀框里的内容', async () => {
    const { client } = renderDialog(['one.test']);
    fireEvent.change(screen.getByPlaceholderText('例如 hello'), { target: { value: 'typed' } });
    const input = screen.getByLabelText('随机生成个数');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect((screen.getByLabelText('前缀') as HTMLInputElement).value).toMatch(/^[a-z][a-z2-9]{7}$/);
    setCount('2');
    fireEvent.keyDown(input, { key: 'Enter' });
    await screen.findByText('已认领 2 个地址');
    expect(mocks.claim.mock.calls.every(([body]) => body.localPart !== 'typed')).toBe(true);
    client.clear();
  });

  it('批量认领进行中不能关闭对话框，也不能重复触发', async () => {
    let release!: () => void;
    mocks.claim.mockImplementation(
      (body) => new Promise((resolve) => { release = () => resolve({ address: `${body.localPart}@${body.domain}` }); }),
    );
    const onOpenChange = vi.fn();
    const { client } = renderDialog(['one.test'], onOpenChange);
    setCount('2');
    fireEvent.click(screen.getByRole('button', { name: '随机生成并认领' }));
    expect(await screen.findByText('正在认领 0/2…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '随机生成并认领' })).toBeDisabled();
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
