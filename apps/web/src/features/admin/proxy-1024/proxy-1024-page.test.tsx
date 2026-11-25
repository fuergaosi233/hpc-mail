import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type ProxyOrderView, SECRET_MASK, type Settings } from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  captcha: vi.fn(),
  login: vi.fn(),
  catalogue: vi.fn(),
  subUsers: vi.fn(),
  quote: vi.fn(),
  orders: vi.fn(),
  order: vi.fn(),
  confirm: vi.fn(),
  cancel: vi.fn(),
  refresh: vi.fn(),
  resolve: vi.fn(),
  allocate: vi.fn(),
  sync: vi.fn(),
  generateSticky: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('./proxy-1024-api', () => ({ proxy1024Api: mocks }));
vi.mock('@/api/resources', () => ({ adminApi: { getSettings: mocks.getSettings, updateSettings: mocks.updateSettings } }));
vi.mock('@/components/ui/toast', () => ({ toast: mocks.toast }));
import { Proxy1024Page } from './proxy-1024-page';

vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

const settings = (): Settings => ({
  ...structuredClone(DEFAULT_SETTINGS),
  proxy1024: {
    enabled: true,
    email: 'ops@example.com',
    password: SECRET_MASK,
    sessionToken: SECRET_MASK,
    lang: 'en',
    maxOrderCents: 50_00,
    maxDailyCents: 200_00,
    quoteTtlMinutes: 15,
  },
});

const order = (patch: Partial<ProxyOrderView> = {}): ProxyOrderView => ({
  id: 11,
  status: 'quoted',
  product: 'static_isp',
  sku: '',
  quantity: 3,
  orderSpec: 'US-30-2,KR-7-1',
  estimateCents: 15_00,
  capBasisCents: 17_00,
  actualCents: null,
  balanceCentsAtQuote: 100_00,
  quoteExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  orderNo: null,
  checkoutUrl: null,
  lastError: '',
  materializedCount: 0,
  createdBy: 1,
  confirmedBy: null,
  confirmedAt: null,
  orderedAt: null,
  paidAt: null,
  checkedAt: null,
  createdAt: '2026-11-25T00:00:00Z',
  updatedAt: '2026-11-25T00:00:00Z',
  warnings: [],
  ...patch,
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Proxy1024Page />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.status.mockResolvedValue({
    enabled: true, configured: true, session: 'ok', email: 'ops@example.com', balanceCents: 100_00, checkedAt: null, lastError: '',
    caps: { maxOrderCents: 50_00, maxDailyCents: 200_00, spentLast24hCents: 30_00 }, purchasingAllowed: true,
  });
  mocks.catalogue.mockResolvedValue({
    fetchedAt: '2026-11-25T00:00:00Z',
    source: 'pricing_pages',
    items: [
      { product: 'static_isp', sku: '', label: 'US 30d', days: 30, country: 'US', unitPriceCents: 6_00, minQuantity: 1, maxQuantity: 500 },
      { product: 'static_isp', sku: '', label: 'KR 7d', days: 7, country: 'KR', unitPriceCents: 4_00, minQuantity: 1, maxQuantity: 500 },
      { product: 'residential_flow', sku: 'flow-10', label: '住宅流量 10GB 包', days: null, country: null, unitPriceCents: 2_50, minQuantity: 1, maxQuantity: 1000 },
    ],
  });
  mocks.orders.mockResolvedValue({ items: [], nextCursor: null });
  mocks.getSettings.mockResolvedValue(settings());
});

async function openQuote(client: QueryClient) {
  mocks.quote.mockResolvedValue(order());
  mocks.order.mockResolvedValue(order());
  // 状态加载完（允许采购）后报价按钮才可用
  await screen.findByText('$30.00 / $200.00');
  const country = await screen.findByLabelText('国家/地区 1');
  fireEvent.change(country, { target: { value: 'us' } });
  fireEvent.change(screen.getByLabelText('数量'), { target: { value: '2' } });
  await waitFor(() => expect(screen.getByRole('button', { name: '获取报价' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '获取报价' }));
  await waitFor(() => expect(mocks.quote).toHaveBeenCalledWith({ product: 'static_isp', items: [{ country: 'US', days: 30, count: 2 }] }));
  return { client, dialog: within(await screen.findByRole('dialog')) };
}

describe('1024 购买', () => {
  it('显示会话、余额与 24 小时额度', async () => {
    const client = mount();
    expect(await screen.findByText('$30.00 / $200.00')).toBeInTheDocument();
    expect(screen.getByText('有效')).toBeInTheDocument();
    expect(screen.getAllByText('$100.00').length).toBeGreaterThan(0);
    client.clear();
  });

  it('确认弹窗逐项列出费用与总额，确认时回传报价总额', async () => {
    const client = mount();
    const { dialog } = await openQuote(client);
    const breakdown = within(await dialog.findByRole('table', { name: '费用明细' }));
    const us = breakdown.getByText('US · 30 天').closest('tr')!;
    expect(within(us).getByText('2 个 IP')).toBeInTheDocument();
    expect(within(us).getByText('$6.00')).toBeInTheDocument();
    expect(within(us).getByText('$12.00')).toBeInTheDocument();
    const kr = breakdown.getByText('KR · 7 天').closest('tr')!;
    expect(within(kr).getAllByText('$4.00')).toHaveLength(2);
    expect(dialog.getByTestId('order-total')).toHaveTextContent('$15.00');
    expect(dialog.getByText('$17.00')).toBeInTheDocument();
    expect(dialog.getByText('$85.00')).toBeInTheDocument();
    expect(dialog.getByText(/报价剩余/)).toBeInTheDocument();

    mocks.confirm.mockResolvedValue(
      order({ status: 'awaiting_payment', orderNo: 'N1', checkoutUrl: 'https://1024proxy.com/checkout?o=N1', warnings: ['payment_manual'] }),
    );
    fireEvent.click(dialog.getByRole('button', { name: '确认下单 $15.00' }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledWith(11, { expectedCents: 15_00 }));
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    const link = await dialog.findByRole('link', { name: /打开 1024 结算页/ });
    expect(link).toHaveAttribute('href', 'https://1024proxy.com/checkout?o=N1');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
    client.clear();
  });

  it('价格变化返回 409：刷新报价并要求按新总额重新确认', async () => {
    const client = mount();
    const { dialog } = await openQuote(client);
    await dialog.findByTestId('order-total');
    mocks.confirm.mockRejectedValue(new ApiError('价格已变化，请重新确认', { code: 'conflict', httpStatus: 409 }));
    mocks.order.mockResolvedValue(order({ estimateCents: 18_00, capBasisCents: 20_00 }));
    fireEvent.click(dialog.getByRole('button', { name: '确认下单 $15.00' }));
    expect(await dialog.findByText(/价格已变化，请重新确认/)).toBeInTheDocument();
    expect(await dialog.findByRole('button', { name: '确认下单 $18.00' })).toBeEnabled();
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    client.clear();
  });

  it('结果不明 / 待支付的订单醒目提示，结算链接不带 referrer', async () => {
    mocks.orders.mockResolvedValue({
      items: [
        order({ id: 21, status: 'unknown', checkoutUrl: null }),
        order({ id: 22, status: 'awaiting_payment', checkoutUrl: 'https://1024proxy.com/pay/22' }),
        order({ id: 23, status: 'quoted', checkoutUrl: 'javascript:alert(1)' }),
      ],
      nextCursor: null,
    });
    const client = mount();
    expect(await screen.findByText('可能已产生订单')).toBeInTheDocument();
    expect(screen.getByText('已下单，待支付')).toBeInTheDocument();
    const links = screen.getAllByRole('link', { name: /打开 1024 结算页/ });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
    expect(screen.getAllByRole('button', { name: '处理' })).toHaveLength(2);
    client.clear();
  });

  it('配置卡片：密文字段显示已配置，保存只提交 proxy1024 且保留掩码', async () => {
    mocks.updateSettings.mockImplementation(async (body: { proxy1024: Settings['proxy1024'] }) => ({ ...settings(), proxy1024: body.proxy1024 }));
    const client = mount();
    const token = await screen.findByLabelText('会话令牌（zero_sid）');
    expect(token).toHaveValue('');
    expect(token).toHaveAttribute('placeholder', '已配置（输入可替换，清除请用按钮）');
    fireEvent.change(screen.getByLabelText('登录邮箱'), { target: { value: 'new@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => expect(mocks.updateSettings).toHaveBeenCalledTimes(1));
    const body = mocks.updateSettings.mock.calls[0]![0];
    expect(Object.keys(body)).toEqual(['proxy1024']);
    expect(body.proxy1024).toMatchObject({ email: 'new@example.com', password: SECRET_MASK, sessionToken: SECRET_MASK, maxOrderCents: 50_00 });
    client.clear();
  });

  it('上限金额按美元输入、以美分保存', async () => {
    mocks.updateSettings.mockImplementation(async (body: { proxy1024: Settings['proxy1024'] }) => ({ ...settings(), proxy1024: body.proxy1024 }));
    const client = mount();
    fireEvent.change(await screen.findByLabelText('单笔上限'), { target: { value: '12.34' } });
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => expect(mocks.updateSettings.mock.calls[0]![0].proxy1024.maxOrderCents).toBe(12_34));
    client.clear();
  });
});
