import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostedDnsRecord, HostedDomain, SessionUser } from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';
import { CurrentUserContext } from '@/lib/use-session';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  members: vi.fn(),
  dnsRecords: vi.fn(),
  createDnsRecord: vi.fn(),
  updateDnsRecord: vi.fn(),
  deleteDnsRecord: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('./hosted-domains-api', () => ({
  hostedDomainApi: {
    get: mocks.get,
    members: mocks.members,
    dnsRecords: mocks.dnsRecords,
    createDnsRecord: mocks.createDnsRecord,
    updateDnsRecord: mocks.updateDnsRecord,
    deleteDnsRecord: mocks.deleteDnsRecord,
  },
}));
vi.mock('@/api/resources', () => ({ mailboxApi: { searchShareUsers: vi.fn() } }));
vi.mock('@/components/ui/toast', () => ({ toast: mocks.toast }));
// 解析管理不受站点「允许添加托管域名」开关影响
vi.mock('@/lib/use-config', () => ({ usePublicConfig: () => ({ data: { hostedDomainsEnabled: false } }) }));
import { HostedDomainDetailPage } from './hosted-domain-detail-page';

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
});

const alice: SessionUser = { id: 1, username: 'alice', role: 'user', createdAt: '', avatarUrl: null, twoFactorEnabled: false };
const root: SessionUser = { ...alice, id: 7, username: 'root', role: 'admin' };

const domain = (patch: Partial<HostedDomain> = {}): HostedDomain => ({
  id: 1, domain: 'mine.example', status: 'active', role: 'owner', ownerUserId: 1, ownerUsername: 'alice',
  nameServers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'], originalNameServers: [], originalRegistrar: '',
  steps: { nameServers: 'ready', routing: 'ready', catchAll: 'ready', sending: 'ready' }, warnings: [], lastError: '',
  memberLimit: 0, memberCount: 0, mailboxCount: 0, createdAt: '2026-10-20T00:00:00Z', activatedAt: '2026-10-20T01:00:00Z',
  checkedAt: '2026-10-21T00:00:00Z', expiresAt: null, ...patch,
});

let seq = 0;
const record = (patch: Partial<HostedDnsRecord>): HostedDnsRecord => {
  const name = patch.name ?? '@';
  return {
    id: (++seq).toString(16).padStart(32, '0'), type: 'A', name, fqdn: name === '@' ? 'mine.example' : `${name}.mine.example`,
    content: '203.0.113.10', ttl: 1, priority: null, srv: null, caa: null, proxied: false, comment: '', kind: 'user',
    lockedReason: '', modifiedAt: null, ...patch,
  };
};

const apex = record({ comment: '主站' });
const www = record({ type: 'CNAME', name: 'www', content: 'x.vercel-dns.com', ttl: 3600, comment: '官网' });
const shop = record({ name: 'shop', content: '198.51.100.7', proxied: true, kind: 'readonly', lockedReason: '已开启 Cloudflare 代理，请联系管理员修改' });
const mailMx = record({ type: 'MX', content: 'route1.mx.cloudflare.net', priority: 10, kind: 'mail', lockedReason: '根域的 MX 记录用于本站收件，由系统维护' });
const spf = record({ type: 'TXT', content: '"v=spf1 include:_spf.mx.cloudflare.net ~all"', kind: 'mail', lockedReason: '根域的 SPF 记录用于本站收发，由系统维护' });
const dmarc = record({ type: 'TXT', name: '_dmarc', content: '"v=DMARC1; p=none"', kind: 'mail', lockedReason: 'DMARC 记录用于本站发信，由系统维护' });
/** 服务端顺序：名称（@ 最前）、类型、内容 */
const RECORDS = [apex, mailMx, spf, dmarc, shop, www];

const dnsKey = ['hosted-domains', 'dns-records', 1];

function mount(target: HostedDomain = domain(), user: SessionUser = alice) {
  mocks.get.mockResolvedValue(target);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const router = createMemoryRouter([{ path: '/domains/:id', element: <HostedDomainDetailPage /> }], {
    initialEntries: ['/domains/1'],
  });
  render(
    <QueryClientProvider client={client}>
      <CurrentUserContext.Provider value={user}>
        <RouterProvider router={router} />
      </CurrentUserContext.Provider>
    </QueryClientProvider>,
  );
  return client;
}

const dnsSection = async () => (await screen.findByRole('heading', { name: 'DNS 解析' })).closest('section')!;

async function openAddDialog() {
  // 记录加载完成后按钮才可用
  const add = await screen.findByRole('button', { name: '添加记录' });
  await waitFor(() => expect(add).toBeEnabled());
  fireEvent.click(add);
  return within(await screen.findByRole('dialog', { name: '添加解析记录' }));
}

async function choose(dialog: ReturnType<typeof within>, label: string, option: string) {
  fireEvent.click(dialog.getByRole('combobox', { name: label }));
  fireEvent.click(await screen.findByRole('option', { name: option }));
  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
}

const type = (dialog: ReturnType<typeof within>, name: string | RegExp, value: string) =>
  fireEvent.change(dialog.getByRole('textbox', { name }), { target: { value } });

describe('托管域名 DNS 解析', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.members.mockResolvedValue([]);
    mocks.dnsRecords.mockResolvedValue(RECORDS);
  });

  it('用户记录与只读记录同列表，邮箱记录折叠在只读分组里', async () => {
    const client = mount();
    const table = await screen.findByRole('table', { name: '解析记录' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);

    const [apexRow, shopRow, wwwRow] = rows as [HTMLElement, HTMLElement, HTMLElement];
    expect(within(apexRow).getByText('@')).toHaveAttribute('title', 'mine.example');
    expect(within(apexRow).getByText('自动')).toBeInTheDocument();
    expect(within(apexRow).getByText('主站')).toBeInTheDocument();
    expect(within(apexRow).getByRole('button', { name: '编辑 A 记录 @' })).toBeInTheDocument();
    expect(within(wwwRow).getByText('www')).toHaveAttribute('title', 'www.mine.example');
    expect(within(wwwRow).getByText('1 小时')).toBeInTheDocument();
    expect(within(wwwRow).getByRole('button', { name: '删除 CNAME 记录 www' })).toBeInTheDocument();
    // 已开启代理的记录只读：显示原因，没有操作
    expect(within(shopRow).getByText('已开启 Cloudflare 代理，请联系管理员修改')).toBeInTheDocument();
    expect(within(shopRow).queryByRole('button')).toBeNull();
    // 用量只计非邮箱记录
    expect(screen.getByText('已添加 3 / 100 条')).toBeInTheDocument();

    const toggle = screen.getByRole('button', { name: '邮箱记录（3 条，由系统维护）' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('table', { name: '邮箱记录' })).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const mail = screen.getByRole('table', { name: '邮箱记录' });
    expect(within(mail).getAllByRole('row').slice(1)).toHaveLength(3);
    expect(within(mail).getByText('route1.mx.cloudflare.net')).toBeInTheDocument();
    expect(within(mail).getByText('优先级 10')).toBeInTheDocument();
    expect(within(mail).getByText('根域的 MX 记录用于本站收件，由系统维护')).toBeInTheDocument();
    expect(within(mail).getByText('DMARC 记录用于本站发信，由系统维护')).toBeInTheDocument();
    expect(within(mail).queryByRole('button')).toBeNull();
    client.clear();
  });

  it('没有自己添加的记录时给出常用场景提示', async () => {
    mocks.dnsRecords.mockResolvedValue([mailMx, spf]);
    const client = mount();
    expect(await screen.findByText(/还没有添加解析记录，常见用法/)).toBeInTheDocument();
    expect(screen.getByText(/根域 @ 添加 A 记录指向服务器 IP/)).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: '解析记录' })).toBeNull();
    expect(screen.getByText('已添加 0 / 100 条')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '邮箱记录（2 条，由系统维护）' })).toBeInTheDocument();
    client.clear();
  });

  it('加载失败时可以重试', async () => {
    mocks.dnsRecords.mockRejectedValueOnce(new ApiError('域名还在创建中，请稍后再试', { code: 'conflict', httpStatus: 409 }));
    const client = mount();
    expect(await screen.findByText('域名还在创建中，请稍后再试')).toBeInTheDocument();
    fireEvent.click(within(await dnsSection()).getByRole('button', { name: '重新加载' }));
    expect(await screen.findByRole('table', { name: '解析记录' })).toBeInTheDocument();
    client.clear();
  });

  it('成员看不到解析管理', async () => {
    const client = mount(domain({ role: 'member', ownerUserId: 9, ownerUsername: 'bob' }), { ...alice, id: 3, username: 'carol' });
    expect(await screen.findByRole('heading', { name: 'mine.example', level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'DNS 解析' })).toBeNull();
    expect(mocks.dnsRecords).not.toHaveBeenCalled();
    client.clear();
  });

  it('删除中的域名不显示解析管理', async () => {
    const client = mount(domain({ status: 'deleting' }));
    expect(await screen.findByRole('heading', { name: 'mine.example', level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'DNS 解析' })).toBeNull();
    client.clear();
  });

  it('暂停的域名：所有者只读', async () => {
    const client = mount(domain({ status: 'suspended' }));
    const section = within(await dnsSection());
    expect(section.getByText('域名已被管理员暂停，解析只读。')).toBeInTheDocument();
    expect(await section.findByRole('table', { name: '解析记录' })).toBeInTheDocument();
    expect(section.queryByRole('button', { name: '添加记录' })).toBeNull();
    expect(section.queryByRole('button', { name: /^编辑/ })).toBeNull();
    expect(section.queryByRole('button', { name: /^删除/ })).toBeNull();
    client.clear();
  });

  it('暂停的域名：管理员仍可修改', async () => {
    const client = mount(domain({ status: 'suspended', role: 'admin' }), root);
    const section = within(await dnsSection());
    expect(await section.findByRole('button', { name: '编辑 A 记录 @' })).toBeInTheDocument();
    expect(section.getByRole('button', { name: '添加记录' })).toBeEnabled();
    expect(section.queryByText('域名已被管理员暂停，解析只读。')).toBeNull();
    client.clear();
  });

  it('名称服务器未生效时提示先补原有记录', async () => {
    const client = mount(domain({ status: 'pending', activatedAt: null, expiresAt: '2026-10-28T00:00:00Z' }));
    const section = within(await dnsSection());
    expect(section.getByText(/名称服务器生效前就可以添加解析/)).toBeInTheDocument();
    expect(await section.findByRole('button', { name: '添加记录' })).toBeEnabled();
    // 名称服务器指引里同样提醒
    expect(screen.getByText(/修改名称服务器前，先在下方「DNS 解析」补上网站等原有记录/)).toBeInTheDocument();
    client.clear();
  });

  it('非邮箱记录达到上限时不能再添加', async () => {
    mocks.dnsRecords.mockResolvedValue(Array.from({ length: 100 }, (_, i) => record({ name: `h${i}` })));
    const client = mount();
    expect(await screen.findByText(/已添加 100 \/ 100 条，已达上限/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '添加记录' })).toBeDisabled();
    client.clear();
  });

  it('新增表单按类型切换字段', async () => {
    const client = mount();
    const dialog = await openAddDialog();
    expect(dialog.getByText(/^\.mine\.example$/)).toBeInTheDocument();
    expect(dialog.getByRole('textbox', { name: /^名称/ })).toHaveAttribute('placeholder', '@ 表示根域，例如 www');
    expect(dialog.getByRole('textbox', { name: /^IPv4 地址/ })).toBeInTheDocument();

    await choose(dialog, '类型', 'AAAA');
    expect(dialog.getByRole('textbox', { name: /^IPv6 地址/ })).toBeInTheDocument();
    expect(dialog.queryByRole('textbox', { name: /^IPv4 地址/ })).toBeNull();

    await choose(dialog, '类型', 'TXT');
    expect(dialog.getByRole('textbox', { name: /^记录值/ }).tagName).toBe('TEXTAREA');

    await choose(dialog, '类型', 'MX');
    expect(dialog.getByRole('textbox', { name: /^邮件服务器/ })).toBeInTheDocument();
    expect(dialog.getByRole('spinbutton', { name: /^优先级/ })).toHaveValue(10);

    await choose(dialog, '类型', 'SRV');
    expect(dialog.queryByRole('textbox', { name: /^邮件服务器/ })).toBeNull();
    for (const name of [/^优先级/, /^权重/, /^端口/]) expect(dialog.getByRole('spinbutton', { name })).toBeInTheDocument();
    expect(dialog.getByRole('textbox', { name: /^目标主机/ })).toBeInTheDocument();

    await choose(dialog, '类型', 'CAA');
    expect(dialog.queryByRole('spinbutton')).toBeNull();
    expect(dialog.getByRole('combobox', { name: '标志' })).toHaveTextContent('0（默认）');
    expect(dialog.getByRole('combobox', { name: '标签' })).toHaveTextContent('issue（允许签发证书）');
    expect(dialog.getByRole('textbox', { name: /^值/ })).toBeInTheDocument();
    client.clear();
  });

  it('与邮箱冲突的记录在本地拦下，不发请求', async () => {
    const client = mount();
    const dialog = await openAddDialog();

    await choose(dialog, '类型', 'MX');
    type(dialog, /^名称/, '@');
    type(dialog, /^邮件服务器/, 'mx.other.example');
    fireEvent.click(dialog.getByRole('button', { name: '添加' }));
    expect(await dialog.findByText('根域的 MX 记录用于本站收件，由系统维护，不能添加或修改')).toBeInTheDocument();

    await choose(dialog, '类型', 'CNAME');
    type(dialog, /^目标域名/, 'x.vercel-dns.com');
    fireEvent.click(dialog.getByRole('button', { name: '添加' }));
    expect(await dialog.findByText(/根域已有收件所需的 MX、TXT 记录，不能设置 CNAME/)).toBeInTheDocument();

    await choose(dialog, '类型', 'TXT');
    type(dialog, /^名称/, '_dmarc');
    type(dialog, /^记录值/, 'v=DMARC1; p=reject');
    fireEvent.click(dialog.getByRole('button', { name: '添加' }));
    expect(await dialog.findByText('DMARC 记录用于本站发信，由系统维护，不能添加或修改')).toBeInTheDocument();

    expect(mocks.createDnsRecord).not.toHaveBeenCalled();
    client.clear();
  });

  it('字段不合法时就地提示，不发请求', async () => {
    const client = mount();
    const dialog = await openAddDialog();
    type(dialog, /^名称/, 'www');
    type(dialog, /^IPv4 地址/, '203.0.113');
    fireEvent.click(dialog.getByRole('button', { name: '添加' }));
    expect(await dialog.findByText('请填写 IPv4 地址，例如 203.0.113.10')).toBeInTheDocument();

    await choose(dialog, '类型', 'SRV');
    type(dialog, /^名称/, '_sip._tcp');
    type(dialog, /^目标主机/, 'sip.example.com');
    fireEvent.click(dialog.getByRole('button', { name: '添加' }));
    expect(await dialog.findByText('请填写 0–65535 的整数')).toBeInTheDocument();
    expect(mocks.createDnsRecord).not.toHaveBeenCalled();
    client.clear();
  });

  it('新增 A 记录：提交请求体，按服务端顺序插入缓存', async () => {
    const created = record({ name: 'blog', content: '203.0.113.20' });
    mocks.createDnsRecord.mockResolvedValue(created);
    const client = mount();
    const dialog = await openAddDialog();
    type(dialog, /^名称/, ' Blog ');
    type(dialog, /^IPv4 地址/, '203.0.113.20');
    fireEvent.click(dialog.getByRole('button', { name: '添加' }));
    await waitFor(() =>
      expect(mocks.createDnsRecord).toHaveBeenCalledWith(1, { type: 'A', name: 'blog', ttl: 1, comment: '', content: '203.0.113.20' }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(client.getQueryData<HostedDnsRecord[]>(dnsKey)?.map((item) => item.name)).toEqual(['@', '@', '@', '_dmarc', 'blog', 'shop', 'www']);
    expect(within(screen.getByRole('table', { name: '解析记录' })).getByText('203.0.113.20')).toBeInTheDocument();
    expect(screen.getByText('已添加 4 / 100 条')).toBeInTheDocument();
    expect(mocks.dnsRecords).toHaveBeenCalledTimes(1);
    client.clear();
  });

  it('新增 SRV 记录：数字字段与 TTL 组成 srv 请求体', async () => {
    mocks.createDnsRecord.mockResolvedValue(
      record({ type: 'SRV', name: '_sip._tcp', content: '5 5060 sip.example.com', ttl: 3600, srv: { priority: 20, weight: 5, port: 5060, target: 'sip.example.com' } }),
    );
    const client = mount();
    const dialog = await openAddDialog();
    await choose(dialog, '类型', 'SRV');
    type(dialog, /^名称/, '_sip._tcp');
    fireEvent.change(dialog.getByRole('spinbutton', { name: /^优先级/ }), { target: { value: '20' } });
    fireEvent.change(dialog.getByRole('spinbutton', { name: /^端口/ }), { target: { value: '5060' } });
    type(dialog, /^目标主机/, 'sip.example.com');
    await choose(dialog, 'TTL', '1 小时');
    type(dialog, /^备注/, 'VoIP');
    fireEvent.click(dialog.getByRole('button', { name: '添加' }));
    await waitFor(() =>
      expect(mocks.createDnsRecord).toHaveBeenCalledWith(1, {
        type: 'SRV', name: '_sip._tcp', ttl: 3600, comment: 'VoIP',
        srv: { priority: 20, weight: 5, port: 5060, target: 'sip.example.com' },
      }),
    );
    expect(await within(screen.getByRole('table', { name: '解析记录' })).findByText('5 5060 sip.example.com')).toBeInTheDocument();
    client.clear();
  });

  it('服务端拒绝时在表单内显示原因', async () => {
    mocks.createDnsRecord.mockRejectedValue(
      new ApiError('已存在冲突的记录：同名下已有相同或不能共存的记录', { code: 'conflict', httpStatus: 409 }),
    );
    const client = mount();
    const dialog = await openAddDialog();
    type(dialog, /^名称/, 'www');
    type(dialog, /^IPv4 地址/, '203.0.113.30');
    fireEvent.click(dialog.getByRole('button', { name: '添加' }));
    expect(await dialog.findByText('已存在冲突的记录：同名下已有相同或不能共存的记录')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: '添加解析记录' })).toBeInTheDocument();
    client.clear();
  });

  it('编辑：用现有值预填、类型不可改，保存后替换缓存', async () => {
    mocks.updateDnsRecord.mockResolvedValue({ ...www, content: 'cname.vercel-dns.com' });
    const client = mount();
    fireEvent.click(await screen.findByRole('button', { name: '编辑 CNAME 记录 www' }));
    const dialog = within(await screen.findByRole('dialog', { name: '编辑解析记录' }));
    const typeSelect = dialog.getByRole('combobox', { name: '类型' });
    expect(typeSelect).toBeDisabled();
    expect(typeSelect).toHaveTextContent('CNAME');
    expect(dialog.getByText('类型不能修改，请删除后重新添加')).toBeInTheDocument();
    expect(dialog.getByRole('textbox', { name: /^名称/ })).toHaveValue('www');
    expect(dialog.getByRole('textbox', { name: /^目标域名/ })).toHaveValue('x.vercel-dns.com');
    expect(dialog.getByRole('combobox', { name: 'TTL' })).toHaveTextContent('1 小时');
    expect(dialog.getByRole('textbox', { name: /^备注/ })).toHaveValue('官网');

    type(dialog, /^目标域名/, 'cname.vercel-dns.com');
    fireEvent.click(dialog.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(mocks.updateDnsRecord).toHaveBeenCalledWith(1, www.id, {
        type: 'CNAME', name: 'www', ttl: 3600, comment: '官网', content: 'cname.vercel-dns.com',
      }),
    );
    expect(await within(screen.getByRole('table', { name: '解析记录' })).findByText('cname.vercel-dns.com')).toBeInTheDocument();
    expect(client.getQueryData<HostedDnsRecord[]>(dnsKey)).toHaveLength(RECORDS.length);
    client.clear();
  });

  it('编辑 SRV、MX 记录：拆开预填各字段', async () => {
    const srv = record({ type: 'SRV', name: '_sip._tcp', content: '5 5060 sip.example.com', srv: { priority: 20, weight: 5, port: 5060, target: 'sip.example.com' } });
    const subMx = record({ type: 'MX', name: 'news', content: 'mx.mailgun.org', priority: 30 });
    mocks.dnsRecords.mockResolvedValue([...RECORDS, subMx, srv]);
    const client = mount();
    fireEvent.click(await screen.findByRole('button', { name: '编辑 SRV 记录 _sip._tcp' }));
    let dialog = within(await screen.findByRole('dialog', { name: '编辑解析记录' }));
    expect(dialog.getByRole('spinbutton', { name: /^优先级/ })).toHaveValue(20);
    expect(dialog.getByRole('spinbutton', { name: /^权重/ })).toHaveValue(5);
    expect(dialog.getByRole('spinbutton', { name: /^端口/ })).toHaveValue(5060);
    expect(dialog.getByRole('textbox', { name: /^目标主机/ })).toHaveValue('sip.example.com');
    fireEvent.click(dialog.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: '编辑 MX 记录 news' }));
    dialog = within(await screen.findByRole('dialog', { name: '编辑解析记录' }));
    expect(dialog.getByRole('textbox', { name: /^邮件服务器/ })).toHaveValue('mx.mailgun.org');
    expect(dialog.getByRole('spinbutton', { name: /^优先级/ })).toHaveValue(30);
    client.clear();
  });

  it('删除：确认框带上类型、名称与内容，确认后从缓存移除', async () => {
    mocks.deleteDnsRecord.mockResolvedValue({ success: true });
    const client = mount();
    fireEvent.click(await screen.findByRole('button', { name: '删除 A 记录 @' }));
    const dialog = within(await screen.findByRole('dialog', { name: '删除 A 记录 @？' }));
    expect(dialog.getByText(/mine\.example → 203\.0\.113\.10/)).toBeInTheDocument();
    fireEvent.click(dialog.getByRole('button', { name: '删除' }));
    await waitFor(() => expect(mocks.deleteDnsRecord).toHaveBeenCalledWith(1, apex.id));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(client.getQueryData<HostedDnsRecord[]>(dnsKey)?.map((item) => item.id)).not.toContain(apex.id);
    expect(within(screen.getByRole('table', { name: '解析记录' })).getAllByRole('row').slice(1)).toHaveLength(2);
    expect(screen.getByText('已添加 2 / 100 条')).toBeInTheDocument();
    client.clear();
  });
});
