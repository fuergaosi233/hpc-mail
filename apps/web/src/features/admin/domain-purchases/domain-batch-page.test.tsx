import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DomainPurchaseBatchView, DomainPurchaseItemView } from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';

const mocks = vi.hoisted(() => ({
  batch: vi.fn(),
  confirm: vi.fn(),
  cancel: vi.fn(),
  retryItem: vi.fn(),
  resolveItem: vi.fn(),
  refreshItem: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('./domain-purchases-api', () => ({ domainPurchaseApi: mocks }));
vi.mock('@/components/ui/toast', () => ({ toast: mocks.toast }));
import { DomainBatchPage } from './domain-batch-page';

vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

let nextId = 100;
const item = (patch: Partial<DomainPurchaseItemView>): DomainPurchaseItemView => ({
  id: nextId++,
  batchId: 9,
  domain: 'x.com',
  status: 'quoted',
  availability: 'available',
  skipReason: '',
  priceClass: 'standard',
  finalCents: 9_00,
  regularCents: 10_00,
  capBasisCents: 10_00,
  operationId: null,
  opStatus: '',
  nameServers: [],
  zoneStatus: '',
  routingStatus: '',
  lifecycleStatus: '',
  verificationStatus: '',
  suspensions: [],
  failedStep: '',
  lastError: '',
  errorCode: '',
  vendorOperationId: '',
  actions: [],
  maybeCharged: false,
  registeredAt: null,
  readyAt: null,
  updatedAt: '2026-11-25T00:00:00Z',
  ...patch,
});

const batch = (patch: Partial<DomainPurchaseBatchView> = {}): DomainPurchaseBatchView => ({
  id: 9,
  status: 'quoted',
  years: 1,
  autoRenew: false,
  privacyLevel: 'high',
  quoteTotalCents: 25_00,
  confirmedTotalCents: 0,
  quoteExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  lastError: '',
  createdBy: 1,
  confirmedBy: null,
  confirmedAt: null,
  completedAt: null,
  createdAt: '2026-11-25T00:00:00Z',
  counts: {},
  items: [
    item({ domain: 'alpha.com', finalCents: 9_00, regularCents: 10_00, capBasisCents: 10_00 }),
    item({ domain: 'beta.net', priceClass: 'premium', finalCents: 15_00, regularCents: 12_00, capBasisCents: 15_00 }),
    item({ domain: 'taken.org', status: 'skipped', availability: 'taken', skipReason: 'taken', finalCents: null, regularCents: null, capBasisCents: null }),
  ],
  ...patch,
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/admin/domain-purchases/9']}>
        <Routes>
          <Route path="/admin/domain-purchases/:id" element={<DomainBatchPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.batch.mockResolvedValue(batch());
});

describe('采购批次', () => {
  it('勾选合计实时更新，确认弹窗逐项列出并回传总额', async () => {
    const client = mount();
    expect(await screen.findByTestId('selection-total')).toHaveTextContent('$25.00');
    expect(screen.getByText('已被注册')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: '选择 taken.org' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 beta.net' }));
    expect(screen.getByTestId('selection-total')).toHaveTextContent('$10.00');
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 beta.net' }));

    fireEvent.click(screen.getByRole('button', { name: '确认购买…' }));
    const dialog = within(await screen.findByRole('dialog'));
    const table = within(dialog.getByRole('table', { name: '购买明细' }));
    expect(within(table.getByText('alpha.com').closest('tr')!).getByText('$10.00')).toBeInTheDocument();
    expect(within(table.getByText('beta.net').closest('tr')!).getAllByText('$15.00')).toHaveLength(2);
    expect(dialog.getByText('$24.00')).toBeInTheDocument();
    expect(dialog.getByTestId('confirm-total')).toHaveTextContent('$25.00');

    mocks.confirm.mockResolvedValue(batch({ status: 'processing', confirmedTotalCents: 25_00, items: [] }));
    fireEvent.click(dialog.getByRole('button', { name: '确认购买 $25.00' }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledWith(9, { domains: ['alpha.com', 'beta.net'], expectedTotalCents: 25_00 }));
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    client.clear();
  });

  it('报价变化返回 409：重新拉取批次并按新价格重置勾选', async () => {
    const client = mount();
    await screen.findByTestId('selection-total');
    mocks.confirm.mockRejectedValue(new ApiError('报价已变化，请核对后重新确认', { code: 'conflict', httpStatus: 409 }));
    mocks.batch.mockResolvedValue(
      batch({
        items: [
          item({ domain: 'alpha.com', capBasisCents: 12_00, finalCents: 12_00 }),
          item({ domain: 'beta.net', status: 'skipped', skipReason: 'taken', capBasisCents: null }),
        ],
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: '确认购买…' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '确认购买 $25.00' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: '报价已变化' })));
    await waitFor(() => expect(screen.getByTestId('selection-total')).toHaveTextContent('$12.00'));
    expect(mocks.batch).toHaveBeenCalledTimes(2);
    client.clear();
  });

  it('处理中：显示进度、可能扣费警示与可用操作', async () => {
    mocks.batch.mockResolvedValue(
      batch({
        status: 'processing',
        confirmedTotalCents: 25_00,
        items: [
          item({ domain: 'alpha.com', status: 'unknown', maybeCharged: true, actions: ['resolve'], lastError: '注册请求超时', errorCode: '500', vendorOperationId: 'op-1' }),
          item({ domain: 'beta.net', status: 'failed', failedStep: 'nameservers', actions: ['retry', 'refresh'], lastError: 'NS 未生效' }),
          item({ domain: 'gamma.io', status: 'domain_added', readyAt: '2026-11-25T01:00:00Z' }),
        ],
      }),
    );
    mocks.retryItem.mockResolvedValue(item({ batchId: 9, domain: 'beta.net', status: 'zone_created' }));
    const client = mount();
    const alpha = (await screen.findByText('alpha.com')).closest('tr')!;
    expect(within(alpha).getByText('可能已扣费，结果待核实')).toBeInTheDocument();
    expect(within(alpha).getByText(/错误码 500 · 操作 ID op-1/)).toBeInTheDocument();
    expect(within(alpha).queryByRole('button', { name: '重试' })).toBeNull();
    const beta = screen.getByText('beta.net').closest('tr')!;
    expect(within(beta).getByText('失败于：设置 NS')).toBeInTheDocument();
    fireEvent.click(within(beta).getByRole('button', { name: '重试' }));
    await waitFor(() => expect(mocks.retryItem).toHaveBeenCalledWith(expect.any(Number)));

    fireEvent.click(within(alpha).getByRole('button', { name: '处理' }));
    mocks.resolveItem.mockResolvedValue(item({ batchId: 9, domain: 'alpha.com', status: 'registered' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '确认已注册' }));
    await waitFor(() => expect(mocks.resolveItem).toHaveBeenCalledWith(expect.any(Number), { action: 'mark_registered' }));
    expect(screen.queryByRole('checkbox')).toBeNull();
    client.clear();
  });
});
