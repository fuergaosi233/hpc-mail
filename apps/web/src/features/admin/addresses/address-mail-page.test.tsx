import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mailboxes: vi.fn(),
  lastQuery: { current: null as Record<string, unknown> | null },
  lastProps: { current: null as { readOnly?: boolean; hasActiveFilters?: boolean } | null },
}));
const box = {
  id: 42,
  address: 'existing@example.com',
  domain: 'example.com',
  userId: 10,
  ownerUsername: 'old-owner',
  displayName: '',
  messageCount: 12,
  createdAt: '2026-10-06T00:00:00Z',
};
vi.mock('@/features/mailboxes/use-mailboxes', () => ({ useMailboxesQuery: () => mocks.mailboxes() }));
vi.mock('@/features/inbox/mail-list', () => ({
  MailList: (props: { query: Record<string, unknown>; readOnly?: boolean; hasActiveFilters?: boolean; emptyTitle: string }) => {
    mocks.lastQuery.current = props.query;
    mocks.lastProps.current = props;
    return <p data-testid="mail-list">{props.emptyTitle}</p>;
  },
}));

import { AdminAddressMailPage } from './address-mail-page';

function Probe() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname + location.search}</p>;
}

function mount(initial: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      { path: '/admin/addresses', element: <Probe /> },
      { path: '/admin/users/:userId/mail', element: <Probe /> },
      { path: '/admin/addresses/:mailboxId/mail', element: <AdminAddressMailPage /> },
    ],
    { initialEntries: [initial] },
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { client, router };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lastQuery.current = null;
  mocks.lastProps.current = null;
  mocks.mailboxes.mockReturnValue({ data: [box], isLoading: false, isError: false, refetch: vi.fn() });
});

describe('管理员查看单个地址的收发件', () => {
  it('以只读方式按归属人 + 固定地址查询收件箱，并展示归属与邮件数', () => {
    const { client } = mount('/admin/addresses/42/mail');
    expect(screen.getByRole('heading', { name: 'existing@example.com' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'old-owner' })).toHaveAttribute('href', '/admin/users/10/mail');
    expect(screen.getByText(/共 12 封邮件/)).toBeInTheDocument();
    expect(mocks.lastQuery.current).toEqual({
      direction: 'inbound',
      scope: 'user',
      userId: 10,
      address: 'existing@example.com',
      unread: undefined,
      q: undefined,
    });
    expect(mocks.lastProps.current?.readOnly).toBe(true);
    client.clear();
  });

  it('切到已发送后只换方向，仍锁定同一地址，并清掉对发件无意义的未读筛选', () => {
    const { client, router } = mount('/admin/addresses/42/mail?unread=1');
    expect(mocks.lastQuery.current).toMatchObject({ direction: 'inbound', unread: true });
    fireEvent.click(screen.getByRole('radio', { name: '已发送' }));
    expect(router.state.location.search).toContain('direction=outbound');
    expect(mocks.lastQuery.current).toMatchObject({
      direction: 'outbound',
      scope: 'user',
      userId: 10,
      address: 'existing@example.com',
      unread: undefined,
    });
    expect(screen.getByTestId('mail-list')).toHaveTextContent('该地址还没有发送记录');
    client.clear();
  });

  it('URL 里的 address/domain 不能改变被查看的地址', () => {
    const { client } = mount('/admin/addresses/42/mail?address=other@example.com&domain=other.test&q=验证码');
    expect(mocks.lastQuery.current).toMatchObject({
      address: 'existing@example.com',
      userId: 10,
      q: '验证码',
    });
    expect(mocks.lastQuery.current).not.toHaveProperty('domain');
    expect(mocks.lastProps.current?.hasActiveFilters).toBe(true);
    // 地址固定，URL 里夹带的 domain/address 也不能被当成已选筛选计数
    expect(screen.getByRole('button', { name: '筛选' })).toBeInTheDocument();
    client.clear();
  });

  it('地址已释放或不存在时给出空态，并能回到全站地址', async () => {
    const { client, router } = mount('/admin/addresses/999/mail');
    expect(screen.getByText('没有找到这个地址')).toBeInTheDocument();
    expect(screen.queryByTestId('mail-list')).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: /返回全站地址/ }));
    expect(await screen.findByTestId('where')).toHaveTextContent('/admin/addresses');
    expect(router.state.location.pathname).toBe('/admin/addresses');
    client.clear();
  });

  it('地址 id 非法时不请求邮件列表', () => {
    const { client } = mount('/admin/addresses/abc/mail');
    expect(screen.getByText('无效的地址 id。')).toBeInTheDocument();
    expect(mocks.lastQuery.current).toBeNull();
    client.clear();
  });

  it('地址列表加载失败时展示错误并可重试，不渲染邮件列表', () => {
    const refetch = vi.fn();
    mocks.mailboxes.mockReturnValue({ data: undefined, isLoading: false, isError: true, error: new Error('boom'), refetch });
    const { client } = mount('/admin/addresses/42/mail');
    expect(mocks.lastQuery.current).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
    expect(refetch).toHaveBeenCalled();
    client.clear();
  });
});
