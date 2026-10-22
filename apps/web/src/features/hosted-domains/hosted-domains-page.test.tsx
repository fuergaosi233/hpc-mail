import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostedDomain } from '@hpc-mail/shared';

const mocks = vi.hoisted(() => ({ list: vi.fn(), config: { hostedDomainsEnabled: true } }));
vi.mock('./hosted-domains-api', () => ({ hostedDomainApi: { list: mocks.list, create: vi.fn() } }));
vi.mock('@/lib/use-config', () => ({ usePublicConfig: () => ({ data: mocks.config }) }));
vi.mock('@/components/ui/toast', () => ({ toast: vi.fn() }));
import { HostedDomainsPage } from './hosted-domains-page';

const domain = (patch: Partial<HostedDomain>): HostedDomain => ({
  id: 1, domain: 'mine.example', status: 'active', role: 'owner', ownerUserId: 1, ownerUsername: 'alice',
  nameServers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'], originalNameServers: [], originalRegistrar: '',
  steps: { nameServers: 'ready', routing: 'ready', catchAll: 'ready', sending: 'ready' }, warnings: [], lastError: '',
  memberLimit: 0, memberCount: 0, mailboxCount: 2, createdAt: '2026-10-20T00:00:00Z', activatedAt: null, checkedAt: null,
  expiresAt: null, ...patch,
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      { path: '/domains', element: <HostedDomainsPage /> },
      { path: '/domains/:id', element: <p>域名详情页</p> },
    ],
    { initialEntries: ['/domains'] },
  );
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  return { client, router };
}

describe('我的域名列表', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.config.hostedDomainsEnabled = true;
  });

  it('列出我的与共享给我的域名：身份、状态中文名、已认领地址数，点击进入详情', async () => {
    mocks.list.mockResolvedValue([
      domain({ id: 1, mailboxCount: 12 }),
      domain({ id: 2, domain: 'team.example', status: 'pending', role: 'member', ownerUserId: 9, ownerUsername: 'bob', mailboxCount: 0 }),
    ]);
    const { client, router } = mount();
    expect(await screen.findByText('mine.example')).toBeInTheDocument();
    expect(screen.getByText('我的')).toBeInTheDocument();
    expect(screen.getByText('共享给我')).toBeInTheDocument();
    expect(screen.getByText('已生效')).toBeInTheDocument();
    expect(screen.getByText('等待修改 NS')).toBeInTheDocument();
    expect(screen.getByText('所有者：bob')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: 'team.example' }));
    expect(await screen.findByText('域名详情页')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/domains/2');
    client.clear();
  });

  it('没有域名时空状态说明功能用途，可直接添加', async () => {
    mocks.list.mockResolvedValue([]);
    const { client } = mount();
    expect(await screen.findByText('还没有托管域名')).toBeInTheDocument();
    expect(screen.getByText(/名称服务器（NS）改为本站分配的两条/)).toBeInTheDocument();
    expect(screen.getByText(/添加后即可在域名详情里管理网站等常用 DNS 解析，建议在修改名称服务器前补好原有记录/)).toBeInTheDocument();
    const buttons = screen.getAllByRole('button', { name: '添加域名' });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]!);
    expect(await screen.findByRole('dialog', { name: '添加域名' })).toBeInTheDocument();
    client.clear();
  });

  it('站点未开放托管时不能添加，已有域名照常显示', async () => {
    mocks.config.hostedDomainsEnabled = false;
    mocks.list.mockResolvedValue([domain({})]);
    const { client } = mount();
    expect(await screen.findByText('mine.example')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '添加域名' })).toBeDisabled();
    expect(screen.getByText(/管理员暂未开放域名托管/)).toBeInTheDocument();
    client.clear();
  });
});
