import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { MailboxShareGrant } from '@hpc-mail/shared';

const mocks = vi.hoisted(() => ({ list: vi.fn(), replace: vi.fn(), toast: vi.fn(), mobile: false }));
const grants: MailboxShareGrant[] = [
  {
    mailboxId: 1, address: 'first@example.com', domain: 'example.com', displayName: '',
    ownerUserId: 99, ownerUsername: 'first-owner',
    grantees: [{ userId: 2, username: 'disabled-old', status: 'disabled', grantedAt: '2026-10-01' }],
  },
  {
    mailboxId: 7, address: 'second@example.com', domain: 'example.com', displayName: '',
    ownerUserId: 100, ownerUsername: 'second-owner',
    grantees: [{ userId: 3, username: 'active-member', status: 'active', grantedAt: '2026-10-01' }],
  },
];
vi.mock('@/api/resources', () => ({
  adminApi: {
    listMailboxShares: mocks.list,
    listUsers: vi.fn(async () => [
      { id: 2, username: 'disabled-old', role: 'user', status: 'disabled' },
      { id: 3, username: 'active-member', role: 'user', status: 'active' },
      { id: 4, username: 'active-admin', role: 'admin', status: 'active' },
    ]),
    replaceMailboxShares: mocks.replace,
  },
  mailboxApi: { release: vi.fn() },
}));
vi.mock('@/components/ui/toast', () => ({ toast: mocks.toast }));
vi.mock('@/lib/use-media-query', () => ({ useIsMobile: () => mocks.mobile }));
vi.mock('@/features/mailboxes/use-mailboxes', () => ({
  useMailboxesQuery: () => ({
    data: grants.map(grant => ({ id: grant.mailboxId, address: grant.address, userId: grant.ownerUserId,
      ownerUsername: grant.ownerUsername, messageCount: 12 })),
    isLoading: false, isError: false,
  }),
}));
import { AddressesPage } from './addresses-page';

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><MemoryRouter><AddressesPage /></MemoryRouter></QueryClientProvider>);
  return { client, view };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mobile = false;
  mocks.list.mockResolvedValue(grants);
  mocks.replace.mockImplementation(async ({ userIds }: { userIds: number[] }) => ({ grantees: userIds.map(userId => ({ userId })) }));
});

describe('按地址行共享邮箱', () => {
  it('点击第二行直接编辑该邮箱，保留现有成员并只提交该邮箱的共享', async () => {
    const { client, view } = mount();
    expect(mocks.list).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '共享邮箱 second@example.com' }));
    const member = await screen.findByRole('checkbox', { name: 'active-member' });
    const dialog = screen.getByRole('dialog', { name: '共享邮箱' });
    expect(within(dialog).getByText('second@example.com')).toBeInTheDocument();
    expect(within(dialog).queryByText('first@example.com')).toBeNull();
    expect(within(dialog).queryByRole('combobox')).toBeNull();
    expect(member).toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'active-admin' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith({ mailboxId: 7, userIds: [3, 4], expectedOwnerId: 100 }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    view.unmount(); client.clear();
  });

  it('关闭后保留地址筛选并将焦点还给当前行按钮', async () => {
    const user = userEvent.setup();
    const { client, view } = mount();
    await user.type(screen.getByPlaceholderText('搜索地址或用户名'), 'second-owner');
    await user.click(screen.getByRole('button', { name: '共享邮箱 second@example.com' }));
    await screen.findByRole('checkbox', { name: 'active-member' });
    await user.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByPlaceholderText('搜索地址或用户名')).toHaveValue('second-owner');
    await waitFor(() => expect(screen.getByRole('button', { name: '共享邮箱 second@example.com' })).toHaveFocus());
    view.unmount(); client.clear();
  });

  it('切换到另一行不会沿用之前未保存的成员，允许移除失效成员', async () => {
    const { client, view } = mount();
    fireEvent.click(screen.getByRole('button', { name: '共享邮箱 second@example.com' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'active-admin' }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    fireEvent.click(screen.getByRole('button', { name: '共享邮箱 first@example.com' }));
    const invalid = await screen.findByRole('checkbox', { name: /disabled-old/ });
    expect(invalid).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'active-admin' })).not.toBeChecked();
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
    fireEvent.click(invalid);
    fireEvent.click(screen.getByRole('checkbox', { name: 'active-member' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith({ mailboxId: 1, userIds: [3], expectedOwnerId: 99 }));
    view.unmount(); client.clear();
  });

  it('可取消全部成员来撤销当前邮箱的共享', async () => {
    const { client, view } = mount();
    fireEvent.click(screen.getByRole('button', { name: '共享邮箱 second@example.com' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'active-member' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith({ mailboxId: 7, userIds: [], expectedOwnerId: 100 }));
    view.unmount(); client.clear();
  });

  it('名单加载失败不能用空名单覆盖，重试后仍打开指定邮箱', async () => {
    mocks.list.mockRejectedValueOnce(new Error('network unavailable')).mockResolvedValue(grants);
    const { client, view } = mount();
    fireEvent.click(screen.getByRole('button', { name: '共享邮箱 second@example.com' }));
    await screen.findByRole('button', { name: '重新加载' });
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull();
    expect(mocks.replace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
    expect(await screen.findByRole('checkbox', { name: 'active-member' })).toBeChecked();
    view.unmount(); client.clear();
  });

  it('窄屏卡片的共享操作直接打开当前邮箱', async () => {
    mocks.mobile = true;
    const { client, view } = mount();
    fireEvent.keyDown(screen.getAllByRole('button', { name: '更多操作' })[1]!, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: '共享邮箱' }));
    await screen.findByRole('checkbox', { name: 'active-member' });
    expect(within(screen.getByRole('dialog')).getByText('second@example.com')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    view.unmount(); client.clear();
  });
});
