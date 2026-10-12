import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mailbox, MailboxShareGrant } from '@hpc-mail/shared';

const mocks = vi.hoisted(() => ({ list: vi.fn(), search: vi.fn(), replace: vi.fn(), adminUsers: vi.fn(), toast: vi.fn() }));
vi.mock('@/api/resources', () => ({
  mailboxApi: { listShares: mocks.list, searchShareUsers: mocks.search, replaceShares: mocks.replace },
  adminApi: { listUsers: mocks.adminUsers },
}));
vi.mock('@/components/ui/toast', () => ({ toast: mocks.toast }));
import { OwnMailboxShareDialog } from './mailbox-share-dialog';

vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
const mailbox: Mailbox = { id: 7, address: 'team@example.com', domain: 'example.com', userId: 1,
  displayName: '', messageCount: 0, createdAt: '2026-10-12T00:00:00Z' };
const grant: MailboxShareGrant = { mailboxId: 7, address: mailbox.address, domain: mailbox.domain,
  displayName: '', ownerUserId: 1, ownerUsername: 'owner', grantees: [] };

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const close = vi.fn();
  render(<QueryClientProvider client={client}><OwnMailboxShareDialog mailbox={mailbox} onClose={close} /></QueryClientProvider>);
  return { client, close };
}

describe('自有邮箱共享', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue([grant]);
    mocks.replace.mockResolvedValue({ ...grant, grantees: [{ userId: 2 }, { userId: 3 }] });
    mocks.search.mockImplementation(async (q: string) => ({ items: q === 'admin'
      ? [{ id: 2, username: 'admin', role: 'admin' }]
      : [{ id: 3, username: 'member', role: 'user' }], hasMore: false }));
  });

  it('搜索管理员和用户，切换搜索仍保留已选成员，通过所有者接口提交', async () => {
    const { client, close } = setup();
    await screen.findByText('邮箱所有者：owner');
    const search = screen.getByRole('textbox', { name: '搜索共享用户' });
    fireEvent.change(search, { target: { value: 'admin' } });
    fireEvent.click(await screen.findByRole('checkbox', { name: 'admin' }));
    fireEvent.change(search, { target: { value: 'member' } });
    fireEvent.click(await screen.findByRole('checkbox', { name: 'member' }));
    expect(screen.getByRole('checkbox', { name: 'admin' })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith({ mailboxId: 7, expectedOwnerId: 1, userIds: [2, 3] }));
    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(mocks.adminUsers).not.toHaveBeenCalled();
    client.clear();
  });

  it('取消禁用成员后可以保存空名单，撤销全部共享', async () => {
    mocks.list.mockResolvedValue([{ ...grant, grantees: [{ userId: 4, username: 'disabled', status: 'disabled', grantedAt: '2026-10-12' }] }]);
    const { client } = setup();
    const member = await screen.findByRole('checkbox', { name: /disabled/ });
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
    fireEvent.click(member);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith({ mailboxId: 7, expectedOwnerId: 1, userIds: [] }));
    client.clear();
  });

  it('共享名单加载失败时显示重试，不能提交空白名单覆盖已有授权', async () => {
    mocks.list.mockRejectedValueOnce(new Error('network unavailable')).mockResolvedValue([grant]);
    const { client } = setup();
    await screen.findByRole('button', { name: '重新加载' });
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull();
    expect(mocks.replace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
    await screen.findByRole('button', { name: '保存' });
    client.clear();
  });
});
