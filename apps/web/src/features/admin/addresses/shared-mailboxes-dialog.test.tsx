import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import type { MailboxShareGrant } from '@hpc-mail/shared';

const mocks = vi.hoisted(() => ({
  list: vi.fn(), replace: vi.fn(), revoke: vi.fn(), toast: vi.fn(), mobile: false,
}));
const grant: MailboxShareGrant = {
  mailboxId: 1, address: 'shared@example.com', domain: 'example.com', displayName: '',
  ownerUserId: 99, ownerUsername: 'other-owner',
  grantees: [{ userId: 2, username: 'disabled-old', status: 'disabled', grantedAt: '2026-10-01' }],
};
vi.mock('@/api/resources', () => ({
  adminApi: {
    listMailboxShares: mocks.list,
    listUsers: vi.fn(async () => [
      { id: 2, username: 'disabled-old', role: 'user', status: 'disabled' },
      { id: 3, username: 'active-new', role: 'user', status: 'active' },
    ]),
    replaceMailboxShares: mocks.replace,
    revokeMailboxShare: mocks.revoke,
  },
  mailboxApi: { release: vi.fn() },
}));
vi.mock('@/components/ui/toast', () => ({ toast: mocks.toast }));
vi.mock('@/lib/use-media-query', () => ({ useIsMobile: () => mocks.mobile }));
vi.mock('@/features/mailboxes/use-mailboxes', () => ({
  useMailboxesQuery: () => ({
    data: [{ id: 1, address: 'shared@example.com', ownerUsername: 'other-owner', messageCount: 12 }],
    isLoading: false, isError: false,
  }),
}));
import { AddressesPage } from './addresses-page';

function mount(path = '/admin/addresses?keep=1') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: '/admin/addresses', element: <AddressesPage /> }], {
    initialEntries: [path],
  });
  const view = render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  return { client, router, view };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mobile = false;
  mocks.list.mockResolvedValue([grant]);
  mocks.replace.mockResolvedValue({ ...grant, grantees: [{ userId: 3 }] });
  mocks.revoke.mockImplementation(async () => {
    mocks.list.mockResolvedValue([{ ...grant, grantees: [] }]);
  });
});

describe('全站地址中的共享邮箱', () => {
  it('按需加载共享，关闭后保留地址筛选并将焦点还给入口按钮', async () => {
    const user = userEvent.setup();
    const { client, router, view } = mount();
    await user.type(screen.getByPlaceholderText('搜索地址或用户名'), 'other-owner');
    expect(mocks.list).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '共享邮箱' }));
    const dialog = await screen.findByRole('dialog', { name: '共享邮箱' });
    await within(dialog).findByRole('button', { name: '编辑' });
    expect(router.state.location.search).toBe('?keep=1&sharing=1');
    await user.click(within(dialog).getByRole('button', { name: '关闭' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByPlaceholderText('搜索地址或用户名')).toHaveValue('other-owner');
    expect(router.state.location.search).toBe('?keep=1');
    expect(screen.getByRole('button', { name: '共享邮箱' })).toHaveFocus();
    view.unmount();
    client.clear();
  });

  it('弹窗内可移除失效成员并保存新成员，保存后回到共享列表', async () => {
    const { client, view } = mount();
    fireEvent.click(screen.getByRole('button', { name: '共享邮箱' }));
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }));
    await screen.findByRole('checkbox', { name: 'active-new' });
    expect(screen.getByRole('checkbox', { name: /disabled-old/ })).toBeChecked();
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /disabled-old/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'active-new' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith({ mailboxId: 1, userIds: [3], expectedOwnerId: 99 }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '分配共享' })).toBeNull());
    expect(screen.getByRole('dialog', { name: '共享邮箱' })).toBeInTheDocument();
    view.unmount();
    client.clear();
  });

  it('支持直接打开共享弹窗并在确认撤销后刷新名单', async () => {
    const { client, view } = mount('/admin/addresses?sharing=1');
    fireEvent.click(await screen.findByRole('button', { name: '取消与 disabled-old 共享 shared@example.com' }));
    fireEvent.click(screen.getByRole('button', { name: '取消共享' }));
    await waitFor(() => expect(mocks.revoke).toHaveBeenCalledWith(1, 2));
    expect(await screen.findByText('尚未共享')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: '共享邮箱' })).toBeInTheDocument();
    view.unmount();
    client.clear();
  });

  it('窄屏使用卡片并可从更多菜单打开编辑，再返回共享列表', async () => {
    mocks.mobile = true;
    const { client, view } = mount();
    fireEvent.click(screen.getByRole('button', { name: '共享邮箱' }));
    const dialog = await screen.findByRole('dialog', { name: '共享邮箱' });
    const more = await within(dialog).findByRole('button', { name: '更多操作' });
    expect(within(dialog).queryByRole('table')).toBeNull();
    fireEvent.keyDown(more, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: '编辑共享名单' }));
    await screen.findByRole('checkbox', { name: 'active-new' });
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.getByRole('dialog', { name: '共享邮箱' })).toBeInTheDocument();
    view.unmount();
    client.clear();
  });
});
