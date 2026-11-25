import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mailbox, ProxyBindingView, ProxyView } from '@hpc-mail/shared';
import { chunkAddresses } from './use-address-proxies';

// jsdom 未实现 scrollTo：窗口虚拟列表挂载时会把滚动位置同步一次
window.scrollTo = vi.fn() as typeof window.scrollTo;

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), list: vi.fn(), bind: vi.fn(), toast: vi.fn(), boxes: [] as Mailbox[] }));
vi.mock('@/features/admin/proxies/proxies-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/admin/proxies/proxies-api')>()),
  adminProxyApi: { lookup: mocks.lookup, list: mocks.list, bind: mocks.bind },
}));
vi.mock('@/api/resources', () => ({ adminApi: { searchUsers: vi.fn(), transferMailbox: vi.fn() }, mailboxApi: { release: vi.fn() } }));
vi.mock('@/components/ui/toast', () => ({ toast: mocks.toast }));
vi.mock('@/features/mailboxes/use-mailboxes', () => ({
  useMailboxesQuery: () => ({ data: mocks.boxes, isLoading: false, isError: false }),
}));
import { AddressesPage } from './addresses-page';

const box = (id: number, address: string): Mailbox =>
  ({ id, address, domain: 'example.com', userId: 10, ownerUsername: 'owner', displayName: '', messageCount: 0, createdAt: '2026-10-06T00:00:00Z' }) as Mailbox;

const proxy = (patch: Partial<ProxyView> = {}): ProxyView => ({
  id: 7, label: '', provider: 'manual', source: 'manual', protocol: 'http', host: '1.2.3.4', port: 8080, username: 'u', hasPassword: true,
  product: '', country: 'US', region: '', city: '', providerRef: null, orderId: null, expiresAt: null, status: 'active', maxBindings: 1,
  bindingCount: 0, health: { status: 'unknown', checkedAt: null, latencyMs: null, error: '' }, notes: '', createdAt: '', updatedAt: '', ...patch,
});

const binding = (address: string, p: ProxyView): ProxyBindingView => ({
  address, domain: 'example.com', proxyId: p.id, source: 'manual', boundBy: 1, createdAt: '', updatedAt: '', proxy: p, ownerUserId: 10, ownerUsername: 'owner',
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AddressesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { client, view };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.boxes = [box(1, 'a@example.com'), box(2, 'b@example.com')];
  mocks.lookup.mockImplementation(async (addresses: string[]) => ({
    items: addresses.map((address) => ({ address, binding: address === 'a@example.com' ? binding(address, proxy()) : null })),
  }));
});

describe('全站地址的代理列', () => {
  it('整页地址只发一次批量查询，绑定的显示代理编号', async () => {
    const { client, view } = mount();
    const row = (await screen.findByRole('link', { name: 'a@example.com' })).closest('tr')!;
    expect(await within(row).findByText('#7 US')).toBeInTheDocument();
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
    expect(mocks.lookup).toHaveBeenCalledWith(['a@example.com', 'b@example.com']);
    // 搜索只在前端过滤，不重新请求
    fireEvent.change(screen.getByPlaceholderText('搜索地址或用户名'), { target: { value: 'b@' } });
    await waitFor(() => expect(screen.queryByRole('link', { name: 'a@example.com' })).toBeNull());
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
    view.unmount();
    client.clear();
  });

  it('超过 500 个地址按批拆分', () => {
    const many = Array.from({ length: 1201 }, (_, i) => `u${i}@example.com`);
    expect(chunkAddresses(many).map((c) => c.length)).toEqual([500, 500, 201]);
  });

  it('行操作「绑定代理」只列可用空闲代理，提交到该地址', async () => {
    mocks.list.mockResolvedValue({
      items: [proxy({ id: 8, label: '空闲', bindingCount: 0 }), proxy({ id: 9, label: '已满', bindingCount: 1, maxBindings: 1 })],
      nextCursor: null,
    });
    mocks.bind.mockResolvedValue(binding('b@example.com', proxy({ id: 8 })));
    const { client, view } = mount();
    fireEvent.click(await screen.findByRole('button', { name: '绑定代理 b@example.com' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText('b@example.com')).toBeInTheDocument();
    fireEvent.click(await dialog.findByRole('radio', { name: '#8 空闲' }));
    expect(dialog.queryByRole('radio', { name: '#9 已满' })).toBeNull();
    expect(mocks.list).toHaveBeenCalledWith({ status: 'active', q: undefined });
    fireEvent.click(dialog.getByRole('button', { name: '绑定' }));
    await waitFor(() => expect(mocks.bind).toHaveBeenCalledWith('b@example.com', 8));
    view.unmount();
    client.clear();
  });
});
