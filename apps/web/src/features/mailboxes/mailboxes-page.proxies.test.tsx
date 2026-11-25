import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@hpc-mail/shared';
import { CurrentUserContext } from '@/lib/use-session';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/api/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/api/client')>();
  return { ...original, api: { ...original.api, get: mocks.get } };
});
vi.mock('@/api/resources', () => ({ mailboxApi: { release: vi.fn() } }));
vi.mock('@/lib/use-config', () => ({ useDomains: () => ({ data: ['example.com'] }) }));
vi.mock('./use-mailboxes', () => ({
  useSharedMailboxesQuery: () => ({ data: [], isLoading: false, isError: false }),
  useMailboxesQuery: () => ({
    data: [
      { id: 1, address: 'me@example.com', domain: 'example.com', displayName: '', messageCount: 0, createdAt: '2026-10-05T00:00:00Z' },
      { id: 2, address: 'plain@example.com', domain: 'example.com', displayName: '', messageCount: 0, createdAt: '2026-10-05T00:00:00Z' },
    ],
    isLoading: false,
    isError: false,
  }),
}));
import { queryKeys } from '@/api/query-keys';
import { MailboxesPage } from './mailboxes-page';

const user: SessionUser = { id: 1, username: 'me', role: 'user', createdAt: '', avatarUrl: null, twoFactorEnabled: false };

describe('我的邮箱的代理徽标', () => {
  it('一次请求取全部绑定，只给绑定了代理的地址显示徽标，点开可复制 URL', async () => {
    mocks.get.mockImplementation(async (path: string) => {
      if (path !== '/proxies/mine') throw new Error(`unexpected ${path}`);
      return {
        items: [
          {
            address: 'me@example.com',
            proxy: {
              proxyId: 7, protocol: 'socks5', host: '1.2.3.4', port: 1080, username: 'u', password: 'p',
              url: 'socks5://u:p@1.2.3.4:1080', country: 'US', city: 'Dallas', product: '', status: 'active', expiresAt: null,
            },
          },
        ],
      };
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <CurrentUserContext.Provider value={user}>
          <MemoryRouter>
            <MailboxesPage />
          </MemoryRouter>
        </CurrentUserContext.Provider>
      </QueryClientProvider>,
    );
    const badge = await screen.findByRole('button', { name: 'me@example.com 的代理' });
    expect(screen.queryByRole('button', { name: 'plain@example.com 的代理' })).toBeNull();
    expect(mocks.get).toHaveBeenCalledTimes(1);
    fireEvent.click(badge);
    expect(await screen.findByText('socks5://u:p@1.2.3.4:1080')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '复制 me@example.com 的代理 URL' })).toBeInTheDocument();
    await waitFor(() => expect(client.getQueryState(queryKeys.myProxies)?.status).toBe('success'));
    client.clear();
  });
});
