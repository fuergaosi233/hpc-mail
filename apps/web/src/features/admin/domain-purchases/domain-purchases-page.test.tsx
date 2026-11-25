import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type DomainPurchaseStatus, SECRET_MASK, type Settings } from '@hpc-mail/shared';

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  testCredentials: vi.fn(),
  saveContact: vi.fn(),
  quote: vi.fn(),
  batches: vi.fn(),
  batch: vi.fn(),
  confirm: vi.fn(),
  cancel: vi.fn(),
  retryItem: vi.fn(),
  resolveItem: vi.fn(),
  refreshItem: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('./domain-purchases-api', () => ({ domainPurchaseApi: mocks }));
vi.mock('@/api/resources', () => ({ adminApi: { getSettings: mocks.getSettings, updateSettings: mocks.updateSettings } }));
vi.mock('@/components/ui/toast', () => ({ toast: mocks.toast }));
import { DomainPurchasesPage } from './domain-purchases-page';

vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

const status = (patch: Partial<DomainPurchaseStatus> = {}): DomainPurchaseStatus => ({
  enabled: true,
  configured: true,
  cloudflareConfigured: true,
  ingressWorker: 'hpc-mail-ingress-20261028',
  ingressWorkerSource: 'env',
  caps: { maxDomainCents: 20_00, maxBatchCents: 100_00, maxDailyCents: 200_00, maxBatchDomains: 20, spentLast24hCents: 0 },
  systemDomains: { used: 10, inFlight: 2, max: 64 },
  purchasingAllowed: true,
  reasons: [],
  ...patch,
});

const settings = (): Settings => ({
  ...structuredClone(DEFAULT_SETTINGS),
  spaceship: { ...DEFAULT_SETTINGS.spaceship, enabled: true, apiKey: SECRET_MASK, apiSecret: SECRET_MASK, maxDomainCents: 20_00 },
});

function BatchStub() {
  return <p>批次页 {useParams().id}</p>;
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const router = createMemoryRouter(
    [
      { path: '/admin/domain-purchases', element: <DomainPurchasesPage /> },
      { path: '/admin/domain-purchases/:id', element: <BatchStub /> },
    ],
    { initialEntries: ['/admin/domain-purchases'] },
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.status.mockResolvedValue(status());
  mocks.batches.mockResolvedValue({ items: [], nextCursor: null });
  mocks.getSettings.mockResolvedValue(settings());
});

describe('域名采购', () => {
  it('显示收件 Worker、系统域名名额，不可采购时列出原因并禁用报价', async () => {
    mocks.status.mockResolvedValue(
      status({ purchasingAllowed: false, ingressWorker: null, ingressWorkerSource: null, reasons: ['未配置收件 Worker', '单批次上限为 0'] }),
    );
    const client = mount();
    expect(await screen.findByText('已用 10 · 采购中 2 · 上限 64')).toBeInTheDocument();
    expect(screen.getByText('未配置收件 Worker')).toBeInTheDocument();
    expect(screen.getByText('单批次上限为 0')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('域名列表'), { target: { value: 'a.com' } });
    expect(screen.getByRole('button', { name: '获取报价' })).toBeDisabled();
    expect(await screen.findByText('还没有采购批次')).toBeInTheDocument();
    client.clear();
  });

  it('粘贴域名报价后进入批次页', async () => {
    mocks.quote.mockResolvedValue({ id: 5, status: 'quoted', items: [] });
    const client = mount();
    expect(await screen.findByText('hpc-mail-ingress-20261028')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('域名列表'), { target: { value: 'One.com, two.net\nOne.com' } });
    expect(screen.getByText(/已识别 2 个/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: '获取报价' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '获取报价' }));
    await waitFor(() => expect(mocks.quote).toHaveBeenCalledWith({ domains: 'One.com, two.net\nOne.com', years: undefined }));
    expect(await screen.findByText('批次页 5')).toBeInTheDocument();
    client.clear();
  });

  it('配置卡片：API 凭据显示已配置，保存只提交 spaceship 且保留掩码', async () => {
    mocks.updateSettings.mockImplementation(async (body: { spaceship: Settings['spaceship'] }) => ({ ...settings(), spaceship: body.spaceship }));
    const client = mount();
    const key = await screen.findByLabelText('API Key');
    expect(key).toHaveValue('');
    expect(key).toHaveAttribute('placeholder', '已配置（输入可替换，清除请用按钮）');
    fireEvent.change(screen.getByLabelText('收件 Worker 名称'), { target: { value: 'hpc-mail-ingress-x' } });
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => expect(mocks.updateSettings).toHaveBeenCalledTimes(1));
    const body = mocks.updateSettings.mock.calls[0]![0];
    expect(Object.keys(body)).toEqual(['spaceship']);
    expect(body.spaceship).toMatchObject({ apiKey: SECRET_MASK, apiSecret: SECRET_MASK, ingressWorkerName: 'hpc-mail-ingress-x' });
    client.clear();
  });

  it('清除密文字段提交空串', async () => {
    mocks.updateSettings.mockImplementation(async (body: { spaceship: Settings['spaceship'] }) => ({ ...settings(), spaceship: body.spaceship }));
    const client = mount();
    fireEvent.click(await screen.findByRole('button', { name: '清除API Secret' }));
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => expect(mocks.updateSettings.mock.calls[0]![0].spaceship).toMatchObject({ apiKey: SECRET_MASK, apiSecret: '' }));
    client.clear();
  });
});
