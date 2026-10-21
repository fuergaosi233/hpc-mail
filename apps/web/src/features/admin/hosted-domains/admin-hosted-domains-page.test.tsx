import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostedDomain } from '@hpc-mail/shared';

const mocks = vi.hoisted(() => ({ list: vi.fn(), health: vi.fn(), suspend: vi.fn(), resume: vi.fn(), toast: vi.fn() }));
vi.mock('@/features/hosted-domains/hosted-domains-api', () => ({
  adminHostedDomainApi: { list: mocks.list, health: mocks.health, suspend: mocks.suspend, resume: mocks.resume },
}));
vi.mock('@/components/ui/toast', () => ({ toast: mocks.toast }));
import { AdminHostedDomainsPage } from './admin-hosted-domains-page';

vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

const domain = (patch: Partial<HostedDomain>): HostedDomain => ({
  id: 1, domain: 'mine.example', status: 'active', role: 'admin', ownerUserId: 2, ownerUsername: 'bob',
  nameServers: [], originalNameServers: [], originalRegistrar: '',
  steps: { nameServers: 'ready', routing: 'ready', catchAll: 'ready', sending: 'ready' }, warnings: [], lastError: '',
  memberLimit: 0, memberCount: 3, mailboxCount: 7, createdAt: '2026-10-20T00:00:00Z', activatedAt: null, checkedAt: null,
  expiresAt: null, ...patch,
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter><AdminHostedDomainsPage /></MemoryRouter></QueryClientProvider>);
  return client;
}

describe('管理员托管域名', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.health.mockResolvedValue({ enabled: true, configured: true, tokenValid: true, error: '', accountZones: 12, accountPendingZones: 3 });
  });

  it('显示运行状态与全站域名，按关键词搜索', async () => {
    mocks.list.mockResolvedValue([domain({}), domain({ id: 2, domain: 'wait.example', status: 'pending', ownerUsername: 'carol' })]);
    const client = mount();
    expect(await screen.findByText('共 12 个，等待生效 3 个')).toBeInTheDocument();
    expect(screen.getByText('已开启')).toBeInTheDocument();
    expect(screen.getByText('有效')).toBeInTheDocument();
    const row = (await screen.findByText('mine.example')).closest('tr')!;
    expect(within(row).getByText('bob')).toBeInTheDocument();
    expect(within(row).getByText('已生效')).toBeInTheDocument();
    expect(within(row).getByText('3')).toBeInTheDocument();
    expect(within(row).getByText('7')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'wait.example' })).toHaveAttribute('href', '/domains/2');
    expect(mocks.list).toHaveBeenCalledWith({ status: undefined, q: undefined });

    fireEvent.change(screen.getByRole('textbox', { name: '搜索托管域名' }), { target: { value: ' Wait ' } });
    await waitFor(() => expect(mocks.list).toHaveBeenCalledWith({ status: undefined, q: 'wait' }));
    client.clear();
  });

  it('凭据未配置时提示用户无法添加', async () => {
    mocks.health.mockResolvedValue({ enabled: true, configured: false, tokenValid: null, error: '', accountZones: null, accountPendingZones: null });
    mocks.list.mockResolvedValue([]);
    const client = mount();
    expect(await screen.findByText('未配置')).toBeInTheDocument();
    expect(screen.getByText(/用户无法添加托管域名/)).toBeInTheDocument();
    expect(await screen.findByText('还没有用户托管域名')).toBeInTheDocument();
    client.clear();
  });

  it('暂停需确认，成功后更新状态', async () => {
    // 暂停后列表随失效重拉，服务端返回新状态
    mocks.list.mockResolvedValueOnce([domain({})]).mockResolvedValue([domain({ status: 'suspended' })]);
    mocks.suspend.mockResolvedValue(domain({ status: 'suspended' }));
    const client = mount();
    fireEvent.keyDown(await screen.findByRole('button', { name: 'mine.example 的更多操作' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: '暂停' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText(/拒收来信，禁止发信和新认领/)).toBeInTheDocument();
    fireEvent.click(dialog.getByRole('button', { name: '暂停' }));
    await waitFor(() => expect(mocks.suspend).toHaveBeenCalledWith(1));
    expect(await screen.findByText('已暂停')).toBeInTheDocument();
    client.clear();
  });
});
