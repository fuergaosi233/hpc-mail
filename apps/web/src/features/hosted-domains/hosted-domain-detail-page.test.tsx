import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostedDomain, SessionUser } from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';
import { CurrentUserContext } from '@/lib/use-session';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  check: vi.fn(),
  members: vi.fn(),
  dnsRecords: vi.fn(),
  replaceMembers: vi.fn(),
  removeMember: vi.fn(),
  transfer: vi.fn(),
  remove: vi.fn(),
  search: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('./hosted-domains-api', () => ({
  hostedDomainApi: {
    get: mocks.get,
    check: mocks.check,
    members: mocks.members,
    dnsRecords: mocks.dnsRecords,
    replaceMembers: mocks.replaceMembers,
    removeMember: mocks.removeMember,
    transfer: mocks.transfer,
    remove: mocks.remove,
  },
}));
vi.mock('@/api/resources', () => ({ mailboxApi: { searchShareUsers: mocks.search } }));
vi.mock('@/components/ui/toast', () => ({ toast: mocks.toast }));
vi.mock('@/lib/use-config', () => ({ usePublicConfig: () => ({ data: { hostedDomainsEnabled: true } }) }));
import { HostedDomainDetailPage } from './hosted-domain-detail-page';

const alice: SessionUser = { id: 1, username: 'alice', role: 'user', createdAt: '', avatarUrl: null, twoFactorEnabled: false };
const carol: SessionUser = { ...alice, id: 3, username: 'carol' };

const domain = (patch: Partial<HostedDomain> = {}): HostedDomain => ({
  id: 1, domain: 'mine.example', status: 'active', role: 'owner', ownerUserId: 1, ownerUsername: 'alice',
  nameServers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'],
  originalNameServers: ['ns1.registrar.example', 'ns2.registrar.example'], originalRegistrar: 'Example Registrar',
  steps: { nameServers: 'ready', routing: 'ready', catchAll: 'ready', sending: 'ready' }, warnings: [], lastError: '',
  memberLimit: 0, memberCount: 1, mailboxCount: 2, createdAt: '2026-10-20T00:00:00Z', activatedAt: '2026-10-20T01:00:00Z',
  checkedAt: '2026-10-21T00:00:00Z', expiresAt: null, ...patch,
});

const pending = () =>
  domain({
    status: 'pending',
    steps: { nameServers: 'waiting', routing: 'waiting', catchAll: 'waiting', sending: 'waiting' },
    warnings: ['检测到 DNSSEC 仍开启，请先在注册商处关闭'],
    activatedAt: null,
    expiresAt: '2026-10-28T00:00:00Z',
  });

function mount(user: SessionUser = alice) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const router = createMemoryRouter(
    [
      { path: '/domains/:id', element: <HostedDomainDetailPage /> },
      { path: '/domains', element: <p>域名列表页</p> },
      { path: '/admin/hosted-domains', element: <p>托管域名管理页</p> },
    ],
    { initialEntries: ['/domains/1'] },
  );
  render(
    <QueryClientProvider client={client}>
      <CurrentUserContext.Provider value={user}>
        <RouterProvider router={router} />
      </CurrentUserContext.Provider>
    </QueryClientProvider>,
  );
  return { client, router };
}

describe('托管域名详情', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dnsRecords.mockResolvedValue([]);
    mocks.members.mockResolvedValue([
      { userId: 3, username: 'carol', status: 'active', grantedAt: '2026-10-20T02:00:00Z', mailboxCount: 4 },
    ]);
  });

  it('等待修改 NS：四个环节均等待中，突出名称服务器指引、提醒与截止时间', async () => {
    mocks.get.mockResolvedValue(pending());
    const { client } = mount();
    expect(await screen.findByRole('heading', { name: 'mine.example', level: 1 })).toBeInTheDocument();

    const steps = within(screen.getByRole('list', { name: '开通环节' }));
    expect(steps.getAllByText('等待中')).toHaveLength(4);
    expect(steps.getByText('名称服务器已生效')).toBeInTheDocument();
    expect(steps.getByText('全部地址投递到本站')).toBeInTheDocument();
    expect(screen.getByText(/等待生效期间本页每 30 秒自动刷新/)).toBeInTheDocument();
    expect(screen.getByText(/逾期仍未生效会自动删除/)).toBeInTheDocument();
    expect(screen.getByText('检测到 DNSSEC 仍开启，请先在注册商处关闭')).toBeInTheDocument();
    // 等待生效期间只在生效进度里出现一次红字提醒
    expect(screen.getAllByText(/修改名称服务器后不会立即生效/)).toHaveLength(1);

    expect(screen.getByRole('button', { name: /修改名称服务器/ })).toHaveAttribute('aria-expanded', 'true');
    const nameServers = within(screen.getByRole('list', { name: '本站分配的名称服务器' }));
    expect(nameServers.getByText('ada.ns.cloudflare.com')).toBeInTheDocument();
    expect(nameServers.getByRole('button', { name: '复制 bob.ns.cloudflare.com' })).toBeInTheDocument();
    expect(screen.getByText('ns1.registrar.example、ns2.registrar.example')).toBeInTheDocument();
    expect(screen.getByText('改为自定义，只填这两条')).toBeInTheDocument();
    client.clear();
  });

  it('立即检测：用返回结果刷新生效进度', async () => {
    mocks.get.mockResolvedValue(pending());
    mocks.check.mockResolvedValue(domain({ checkedAt: '2026-10-21T00:05:00Z' }));
    const { client } = mount();
    fireEvent.click(await screen.findByRole('button', { name: '立即检测' }));
    await waitFor(() => expect(mocks.check).toHaveBeenCalledWith(1));
    const steps = within(screen.getByRole('list', { name: '开通环节' }));
    await waitFor(() => expect(steps.getAllByText('已生效')).toHaveLength(4));
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: '收发均已生效' }));
    // 已生效后名称服务器指引折叠备查
    expect(screen.getByRole('button', { name: /修改名称服务器/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/最近一次错误/)).toBeNull();
    client.clear();
  });

  it('服务端跳过了太频繁的检测时提示稍后再试', async () => {
    mocks.get.mockResolvedValue(pending());
    mocks.check.mockResolvedValue(pending());
    const { client } = mount();
    fireEvent.click(await screen.findByRole('button', { name: '立即检测' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith({ title: '刚检测过，请稍后再试' }));
    client.clear();
  });

  it('暂停的域名不提供立即检测', async () => {
    mocks.get.mockResolvedValue(domain({ status: 'suspended' }));
    const { client } = mount();
    expect(await screen.findByText(/管理员已暂停该域名/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '立即检测' })).toBeNull();
    expect(screen.getByRole('button', { name: '过户' })).toBeInTheDocument();
    client.clear();
  });

  it('开通异常时显示最近一次错误', async () => {
    mocks.get.mockResolvedValue(domain({ status: 'error', steps: { nameServers: 'ready', routing: 'ready', catchAll: 'error', sending: 'waiting' }, lastError: 'catch-all 规则写入失败' }));
    const { client } = mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('最近一次错误：catch-all 规则写入失败');
    const steps = within(screen.getByRole('list', { name: '开通环节' }));
    expect(steps.getByText('异常')).toBeInTheDocument();
    expect(steps.getByText('等待中')).toBeInTheDocument();
    client.clear();
  });

  it('所有者可见检测、名称服务器、成员、过户与删除', async () => {
    mocks.get.mockResolvedValue(domain());
    const { client } = mount();
    expect(await screen.findByRole('button', { name: '立即检测' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /修改名称服务器/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '成员' })).toBeInTheDocument();
    expect(await screen.findByText('carol')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '过户' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '删除托管' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '退出共享' })).toBeNull();
    // 认领入口带上域名，认领弹窗打开时预选它
    expect(screen.getByRole('link', { name: '认领地址' })).toHaveAttribute('href', '/mailboxes?claim=1&domain=mine.example');
    client.clear();
  });

  it('成员视角只读：隐藏管理操作，可以退出共享', async () => {
    mocks.get.mockResolvedValue(domain({ role: 'member', ownerUserId: 9, ownerUsername: 'bob' }));
    mocks.removeMember.mockResolvedValue({ success: true });
    const { client, router } = mount(carol);
    expect(await screen.findByRole('heading', { name: 'mine.example', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('共享给我')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: '开通环节' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '立即检测' })).toBeNull();
    expect(screen.queryByRole('button', { name: /修改名称服务器/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: '成员' })).toBeNull();
    expect(screen.queryByRole('button', { name: '过户' })).toBeNull();
    expect(screen.queryByRole('button', { name: '删除托管' })).toBeNull();
    expect(mocks.members).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '退出共享' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '退出共享' }));
    await waitFor(() => expect(mocks.removeMember).toHaveBeenCalledWith(1, 3));
    expect(await screen.findByText('域名列表页')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/domains');
    client.clear();
  });

  it('搜索添加成员：提交完整名单与当前所有者', async () => {
    mocks.get.mockResolvedValue(domain());
    mocks.search.mockResolvedValue({ items: [{ id: 3, username: 'carol', role: 'user' }, { id: 4, username: 'dave', role: 'user' }], hasMore: false });
    mocks.replaceMembers.mockResolvedValue([
      { userId: 3, username: 'carol', status: 'active', grantedAt: '2026-10-20T02:00:00Z', mailboxCount: 4 },
      { userId: 4, username: 'dave', status: 'active', grantedAt: '2026-10-21T02:00:00Z', mailboxCount: 0 },
    ]);
    const { client } = mount();
    await screen.findByText('carol');
    fireEvent.change(screen.getByRole('textbox', { name: '搜索要添加的成员' }), { target: { value: 'a' } });
    const add = await screen.findByRole('button', { name: '添加 dave' });
    // 已是成员的人不再出现在候选里
    expect(screen.queryByRole('button', { name: '添加 carol' })).toBeNull();
    expect(mocks.search).toHaveBeenCalledWith('a', 1, expect.anything());
    fireEvent.click(add);
    await waitFor(() => expect(mocks.replaceMembers).toHaveBeenCalledWith(1, { userIds: [3, 4], expectedOwnerId: 1 }));
    expect(await screen.findByText('dave')).toBeInTheDocument();
    client.clear();
  });

  it('已禁用的成员标记出来，仍可继续添加新成员', async () => {
    mocks.get.mockResolvedValue(domain());
    mocks.members.mockResolvedValue([
      { userId: 3, username: 'carol', status: 'disabled', grantedAt: '2026-10-20T02:00:00Z', mailboxCount: 4 },
    ]);
    const { client } = mount();
    expect(await screen.findByText('已禁用')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '搜索要添加的成员' })).not.toBeDisabled();
    client.clear();
  });

  it('删除托管：展示原名称服务器，输入域名确认后删除并回到列表', async () => {
    mocks.get.mockResolvedValue(domain());
    mocks.remove.mockResolvedValue({ success: true });
    const { client, router } = mount();
    fireEvent.click(await screen.findByRole('button', { name: '删除托管' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText('ns1.registrar.example')).toBeInTheDocument();
    expect(dialog.getByText(/永久删除/)).toBeInTheDocument();
    const confirm = dialog.getByRole('button', { name: '删除托管' });
    expect(confirm).toBeDisabled();
    fireEvent.change(dialog.getByRole('textbox', { name: '输入 mine.example 确认删除' }), { target: { value: 'mine.example' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith(1));
    expect(await screen.findByText('域名列表页')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/domains');
    client.clear();
  });

  it('过户：默认连同地址一起过户，输入域名确认；失去权限后回到列表', async () => {
    mocks.get.mockResolvedValue(domain());
    mocks.search.mockResolvedValue({ items: [{ id: 5, username: 'erin', role: 'user' }], hasMore: false });
    // 原所有者过户后不再有权限，服务端返回 null
    mocks.transfer.mockResolvedValue({ domain: null, previousUserId: 1, transferred: true, movedMailboxes: 2 });
    const { client, router } = mount();
    fireEvent.click(await screen.findByRole('button', { name: '过户' }));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByRole('textbox', { name: '搜索目标用户' }), { target: { value: 'erin' } });
    fireEvent.click(await dialog.findByRole('button', { name: '选择 erin' }));
    expect(dialog.getByText('已选择：erin')).toBeInTheDocument();
    expect(dialog.getByRole('checkbox', { name: /连同我在该域名下的地址/ })).toBeChecked();
    const confirm = dialog.getByRole('button', { name: '确认过户' });
    expect(confirm).toBeDisabled();
    fireEvent.change(dialog.getByRole('textbox', { name: '输入 mine.example 确认过户' }), { target: { value: 'mine.example' } });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(mocks.transfer).toHaveBeenCalledWith(1, { userId: 5, expectedOwnerId: 1, includeMailboxes: true }),
    );
    expect(await screen.findByText('域名列表页')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/domains');
    client.clear();
  });

  it('过户后仍有权限（管理员）时留在详情页，用返回结果更新', async () => {
    const admin: SessionUser = { ...alice, id: 7, username: 'root', role: 'admin' };
    mocks.get.mockResolvedValue(domain({ role: 'admin' }));
    mocks.search.mockResolvedValue({ items: [{ id: 5, username: 'erin', role: 'user' }], hasMore: false });
    mocks.transfer.mockResolvedValue({
      domain: domain({ role: 'admin', ownerUserId: 5, ownerUsername: 'erin' }), previousUserId: 1, transferred: true, movedMailboxes: 0,
    });
    const { client, router } = mount(admin);
    fireEvent.click(await screen.findByRole('button', { name: '过户' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByRole('checkbox', { name: /连同 alice 在该域名下的地址/ })).toBeChecked();
    fireEvent.change(dialog.getByRole('textbox', { name: '搜索目标用户' }), { target: { value: 'erin' } });
    fireEvent.click(await dialog.findByRole('button', { name: '选择 erin' }));
    fireEvent.change(dialog.getByRole('textbox', { name: '输入 mine.example 确认过户' }), { target: { value: 'mine.example' } });
    fireEvent.click(dialog.getByRole('button', { name: '确认过户' }));
    await waitFor(() => expect(mocks.transfer).toHaveBeenCalledWith(1, { userId: 5, expectedOwnerId: 1, includeMailboxes: true }));
    await waitFor(() => expect(client.getQueryData<HostedDomain>(['hosted-domains', 'detail', 1])?.ownerUsername).toBe('erin'));
    expect(router.state.location.pathname).toBe('/domains/1');
    client.clear();
  });

  it('域名不存在或已无权限时给出说明', async () => {
    mocks.get.mockRejectedValue(new ApiError('托管域名不存在', { code: 'not_found', httpStatus: 404 }));
    const { client } = mount();
    expect(await screen.findByText('没有找到这个域名')).toBeInTheDocument();
    client.clear();
  });
});
