import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostedDomain } from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';

const mocks = vi.hoisted(() => ({ create: vi.fn(), toast: vi.fn() }));
vi.mock('./hosted-domains-api', () => ({ hostedDomainApi: { create: mocks.create } }));
vi.mock('@/components/ui/toast', () => ({ toast: mocks.toast }));
import { AddHostedDomainDialog } from './add-hosted-domain-dialog';

const created = { id: 5, domain: 'example.com', status: 'pending', role: 'owner' } as HostedDomain;

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(['hosted-domains', 'list'], [] as HostedDomain[]);
  const onOpenChange = vi.fn();
  const router = createMemoryRouter(
    [
      { path: '/domains', element: <AddHostedDomainDialog open onOpenChange={onOpenChange} /> },
      { path: '/domains/:id', element: <p>域名详情页</p> },
    ],
    { initialEntries: ['/domains'] },
  );
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  return { client, router, onOpenChange };
}

describe('添加托管域名', () => {
  beforeEach(() => vi.clearAllMocks());

  it('说明只用于邮箱、原有 DNS 失效与先关闭 DNSSEC', () => {
    const { client } = mount();
    expect(screen.getByText(/只用于邮箱/)).toBeInTheDocument();
    expect(screen.getByText(/原有网站、解析等其他 DNS/)).toBeInTheDocument();
    expect(screen.getByText(/关闭 DNSSEC/)).toBeInTheDocument();
    expect(screen.getByText(/超过等待期限仍未生效会自动删除/)).toBeInTheDocument();
    client.clear();
  });

  it('域名格式不合法时就地提示，不发请求', () => {
    const { client } = mount();
    fireEvent.change(screen.getByRole('textbox', { name: /域名/ }), { target: { value: 'not a domain' } });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    expect(screen.getByRole('alert')).toHaveTextContent('域名格式非法');
    expect(mocks.create).not.toHaveBeenCalled();
    client.clear();
  });

  it('规范化后提交，成功后写入列表缓存并进入详情页', async () => {
    mocks.create.mockResolvedValue(created);
    const { client, router, onOpenChange } = mount();
    fireEvent.change(screen.getByRole('textbox', { name: /域名/ }), { target: { value: ' Example.COM ' } });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith({ domain: 'example.com' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/domains/5'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(client.getQueryData(['hosted-domains', 'list'])).toEqual([created]);
    expect(client.getQueryData(['hosted-domains', 'detail', 5])).toEqual(created);
    client.clear();
  });

  it('服务端拒绝时显示原因，留在弹窗', async () => {
    mocks.create.mockRejectedValue(new ApiError('同时等待生效的域名已达上限', { code: 'conflict', httpStatus: 409 }));
    const { client, router } = mount();
    fireEvent.change(screen.getByRole('textbox', { name: /域名/ }), { target: { value: 'example.com' } });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('同时等待生效的域名已达上限');
    expect(router.state.location.pathname).toBe('/domains');
    client.clear();
  });
});
