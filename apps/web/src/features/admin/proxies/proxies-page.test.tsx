import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProxyBindingView, ProxyView } from '@hpc-mail/shared';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  stats: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  importLines: vi.fn(),
  exportProxies: vi.fn(),
  autoAssign: vi.fn(),
  bindings: vi.fn(),
  lookup: vi.fn(),
  bind: vi.fn(),
  unbind: vi.fn(),
  reveal: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('./proxies-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./proxies-api')>()),
  adminProxyApi: mocks,
}));
vi.mock('@/components/ui/toast', () => ({ toast: mocks.toast }));
import { ProxiesPage } from './proxies-page';

vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

const proxyView = (patch: Partial<ProxyView> = {}): ProxyView => ({
  id: 7,
  label: '美国住宅',
  provider: 'manual',
  source: 'manual',
  protocol: 'http',
  host: '1.2.3.4',
  port: 8080,
  username: 'user1',
  hasPassword: true,
  product: 'static_isp',
  country: 'US',
  region: '',
  city: 'Dallas',
  providerRef: null,
  orderId: null,
  expiresAt: null,
  status: 'active',
  maxBindings: 1,
  bindingCount: 0,
  health: { status: 'unknown', checkedAt: null, latencyMs: null, error: '' },
  notes: '',
  createdAt: '2026-11-20T00:00:00Z',
  updatedAt: '2026-11-20T00:00:00Z',
  ...patch,
});

const binding = (patch: Partial<ProxyBindingView> = {}): ProxyBindingView => {
  const p = proxyView({ bindingCount: 1 });
  return {
    address: 'a@example.com',
    domain: 'example.com',
    proxyId: p.id,
    source: 'manual',
    boundBy: 1,
    createdAt: '2026-11-20T00:00:00Z',
    updatedAt: '2026-11-20T00:00:00Z',
    proxy: p,
    ownerUserId: 3,
    ownerUsername: 'carol',
    ...patch,
  };
};

function mount(path = '/admin/proxies') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <ProxiesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { client, view };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.stats.mockResolvedValue({ total: 3, active: 2, expired: 1, disabled: 0, bound: 1, free: 1, byProvider: { manual: 2, '1024proxy': 1 } });
  mocks.list.mockResolvedValue({ items: [proxyView(), proxyView({ id: 8, label: '', bindingCount: 2, maxBindings: 2 })], nextCursor: null });
  mocks.bindings.mockResolvedValue({ items: [binding()], nextCursor: null });
});

describe('代理池', () => {
  it('显示统计与库存，空筛选只请求一次', async () => {
    const { client } = mount();
    expect(await screen.findByText('按供应商：manual 2 · 1024proxy 1')).toBeInTheDocument();
    const row = (await screen.findByText(/#7 美国住宅/)).closest('tr')!;
    expect(within(row).getByText('http://1.2.3.4:8080 · user1')).toBeInTheDocument();
    expect(within(row).getByText('US · Dallas')).toBeInTheDocument();
    expect(within(row).getByText('0/1')).toBeInTheDocument();
    expect(mocks.list).toHaveBeenCalledWith({ q: undefined, status: undefined, provider: undefined, country: undefined, bound: undefined }, undefined);
    client.clear();
  });

  it('查看凭据每次都请求 reveal，明文不进 query 缓存，关闭后从页面清除', async () => {
    mocks.reveal.mockResolvedValue({
      proxyId: 7, protocol: 'http', host: '1.2.3.4', port: 8080, username: 'user1', password: 's3cret!',
      url: 'http://user1:s3cret!@1.2.3.4:8080', country: 'US', city: 'Dallas', product: '', status: 'active', expiresAt: null,
    });
    const { client } = mount();
    fireEvent.click(await screen.findByRole('button', { name: '查看凭据 #7' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText('http://user1:s3cret!@1.2.3.4:8080')).toBeInTheDocument();
    expect(mocks.reveal).toHaveBeenCalledWith(7);
    const cached = JSON.stringify(client.getQueryCache().getAll().map((q) => q.state.data));
    expect(cached).not.toContain('s3cret!');
    expect(JSON.stringify(client.getMutationCache().getAll().map((m) => m.state.data))).not.toContain('s3cret!');
    fireEvent.click(dialog.getAllByRole('button', { name: '关闭' })[0]!);
    await waitFor(() => expect(screen.queryByText(/s3cret!/)).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: '查看凭据 #7' }));
    await screen.findByRole('dialog');
    expect(mocks.reveal).toHaveBeenCalledTimes(2);
    client.clear();
  });

  it('编辑时密码显示「已配置」，未输入则不提交密码字段', async () => {
    mocks.update.mockResolvedValue(proxyView({ label: '改名' }));
    const { client } = mount();
    fireEvent.click(await screen.findByRole('button', { name: '编辑代理 #7' }));
    const dialog = within(await screen.findByRole('dialog'));
    const password = dialog.getByLabelText('密码');
    expect(password).toHaveValue('');
    expect(password).toHaveAttribute('placeholder', '已配置（输入可替换）');
    fireEvent.change(dialog.getByLabelText('备注名'), { target: { value: '改名' } });
    fireEvent.click(dialog.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith(7, { label: '改名' }));
    client.clear();
  });

  it('删除已绑定的代理需确认解除绑定，并带 force', async () => {
    mocks.remove.mockResolvedValue({ ok: true });
    const { client } = mount();
    fireEvent.click(await screen.findByRole('button', { name: '删除代理 #8' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText(/绑定了 2 个地址/)).toBeInTheDocument();
    fireEvent.click(dialog.getByRole('button', { name: '解除绑定并删除' }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith(8, true));
    client.clear();
  });

  it('导入先预览再导入，预览后修改文本需重新预览', async () => {
    mocks.importLines
      .mockResolvedValueOnce({ created: 1, duplicates: 1, invalid: [{ line: 3, reason: '缺少端口' }], dryRun: true })
      .mockResolvedValueOnce({ created: 1, duplicates: 1, invalid: [{ line: 3, reason: '缺少端口' }], dryRun: false });
    const { client } = mount();
    fireEvent.click(screen.getByRole('button', { name: '导入' }));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('代理列表'), { target: { value: 'http://u:p@1.1.1.1:80\n1.1.1.2:80\nbad' } });
    expect(dialog.getByRole('button', { name: /导入/ })).toBeDisabled();
    fireEvent.click(dialog.getByRole('button', { name: '预览' }));
    expect(await dialog.findByText('第 3 行：缺少端口')).toBeInTheDocument();
    expect(mocks.importLines).toHaveBeenLastCalledWith(expect.objectContaining({ dryRun: true, format: 'auto' }));
    fireEvent.click(dialog.getByRole('button', { name: '导入 1 个' }));
    await waitFor(() => expect(mocks.importLines).toHaveBeenLastCalledWith(expect.objectContaining({ dryRun: false })));
    expect(await dialog.findByText(/导入完成/)).toBeInTheDocument();
    client.clear();
  });

  it('绑定页签：显示地址与认领人，解绑需确认', async () => {
    mocks.unbind.mockResolvedValue({ ok: true });
    const { client } = mount('/admin/proxies?tab=bindings');
    const row = (await screen.findByText('a@example.com')).closest('tr')!;
    expect(within(row).getByText('carol')).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: '解除绑定 a@example.com' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '解除绑定' }));
    await waitFor(() => expect(mocks.unbind).toHaveBeenCalledWith('a@example.com'));
    client.clear();
  });

  it('自动分配：预览后执行，提交过滤条件', async () => {
    mocks.autoAssign
      .mockResolvedValueOnce({ assigned: [{ address: 'b@example.com', proxyId: 7 }], unassigned: [], freeProxiesLeft: 0, dryRun: true })
      .mockResolvedValueOnce({ assigned: [{ address: 'b@example.com', proxyId: 7 }], unassigned: [], freeProxiesLeft: 0, dryRun: false });
    const { client } = mount();
    fireEvent.click(screen.getByRole('button', { name: '自动分配' }));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('限定域名（可选）'), { target: { value: 'Example.com' } });
    fireEvent.change(dialog.getByLabelText('国家'), { target: { value: 'us' } });
    fireEvent.click(dialog.getByRole('button', { name: '预览' }));
    expect(await dialog.findByText('b@example.com → 代理 #7')).toBeInTheDocument();
    expect(mocks.autoAssign).toHaveBeenLastCalledWith(
      expect.objectContaining({ target: 'claimed', domain: 'example.com', filter: { country: 'US' }, dryRun: true }),
    );
    fireEvent.click(dialog.getByRole('button', { name: '执行分配' }));
    await waitFor(() => expect(mocks.autoAssign).toHaveBeenLastCalledWith(expect.objectContaining({ dryRun: false })));
    client.clear();
  });
});
