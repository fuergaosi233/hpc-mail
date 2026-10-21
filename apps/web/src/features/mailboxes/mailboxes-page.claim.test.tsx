import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@hpc-mail/shared';
import { CurrentUserContext } from '@/lib/use-session';
vi.mock('@/api/resources', () => ({ mailboxApi: { availability: vi.fn(async () => ({ available: true })) } }));
const domains = vi.hoisted(() => ({ data: ['example.com'] }));
vi.mock('@/lib/use-config', () => ({ useDomains: () => domains }));
vi.mock('./use-mailboxes', () => ({
  useSharedMailboxesQuery: () => ({ data: [{ mailboxId: 10, address: 'shared@example.com', domain: 'example.com', ownerUsername: 'other-owner', displayName: '' }], isLoading: false, isError: false }),
  useMailboxesQuery: () => ({
    data: [{ id: 9, address: 'me+tag@example.com', domain: 'example.com', displayName: '', messageCount: 3, createdAt: '2026-10-05T00:00:00Z' }],
    isLoading: false,
    isError: false,
  }),
}));
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
import { MailboxesPage } from './mailboxes-page';

const user: SessionUser = { id: 1, username: 'me', role: 'user', createdAt: '', avatarUrl: null, twoFactorEnabled: false };

function renderPage(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: '/mailboxes', element: <MailboxesPage /> }], { initialEntries: [path] });
  render(
    <QueryClientProvider client={client}>
      <CurrentUserContext.Provider value={user}>
        <RouterProvider router={router} />
      </CurrentUserContext.Provider>
    </QueryClientProvider>,
  );
  return { client, router };
}

describe('我的邮箱', () => {
  it('?claim=1 自动打开认领对话框并从 URL 去掉参数', async () => {
    const { client, router } = renderPage('/mailboxes?claim=1');
    expect(await screen.findByRole('dialog', { name: '认领邮箱地址' })).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.search).toBe(''));
    client.clear();
  });

  it('?claim=1&domain= 打开认领对话框并预选该域名（托管域名详情页的入口）', async () => {
    domains.data = ['example.com', 'hosted.example'];
    try {
      const { client, router } = renderPage('/mailboxes?claim=1&domain=hosted.example');
      const dialog = await screen.findByRole('dialog', { name: '认领邮箱地址' });
      await waitFor(() => expect(within(dialog).getByRole('combobox', { name: '域名' })).toHaveTextContent('hosted.example'));
      await waitFor(() => expect(router.state.location.search).toBe(''));
      client.clear();
    } finally {
      domains.data = ['example.com'];
    }
  });

  it('地址链接到只看该地址的收件箱，旁边可复制', () => {
    const { client } = renderPage('/mailboxes');
    expect(screen.getByRole('link', { name: 'me+tag@example.com' })).toHaveAttribute(
      'href',
      '/inbox?address=me%2Btag%40example.com',
    );
    expect(screen.getByRole('button', { name: '复制 me+tag@example.com' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '共享给我的邮箱' })).toHaveTextContent('所有者：other-owner');
    expect(screen.getByRole('link', { name: '查看来信' })).toHaveAttribute('href', '/inbox?address=shared%40example.com');
    expect(screen.queryByRole('button', { name: '共享 shared@example.com' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    client.clear();
  });
});
