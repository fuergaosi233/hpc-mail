import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ROW_HEIGHT = 57;
const TOTAL = 625;
const mocks = vi.hoisted(() => ({ mobile: false, listShares: vi.fn() }));
const boxes = Array.from({ length: TOTAL }, (_, i) => ({
  id: 1000 + i,
  address: `user${i}@example.com`,
  domain: 'example.com',
  userId: 10 + (i % 7),
  ownerUsername: `owner${i % 7}`,
  displayName: '',
  messageCount: i,
  createdAt: '2026-10-06T00:00:00Z',
}));
vi.mock('@/api/resources', () => ({
  adminApi: { searchUsers: vi.fn(), transferMailbox: vi.fn(), listMailboxShares: mocks.listShares, listUsers: vi.fn(async () => []) },
  mailboxApi: { release: vi.fn() },
}));
vi.mock('@/lib/use-media-query', () => ({ useIsMobile: () => mocks.mobile }));
vi.mock('@/features/mailboxes/use-mailboxes', () => ({
  useMailboxesQuery: () => ({ data: boxes, isLoading: false, isError: false }),
}));

import { AddressesPage } from './addresses-page';

// jsdom 未实现 scrollTo：窗口虚拟列表挂载时会把滚动位置同步一次
window.scrollTo = vi.fn() as typeof window.scrollTo;

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><MemoryRouter><AddressesPage /></MemoryRouter></QueryClientProvider>);
  return { client, view };
}

/** 页面实际渲染出来的地址（只算对读屏可见的行，不含占位） */
const renderedAddresses = () => screen.getAllByRole('link').map((link) => link.textContent);

function scrollWindowTo(y: number) {
  Object.defineProperty(window, 'scrollY', { configurable: true, value: y });
  act(() => {
    window.dispatchEvent(new Event('scroll'));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mobile = false;
  mocks.listShares.mockImplementation(async (mailboxId: number) => {
    const box = boxes.find((item) => item.id === mailboxId)!;
    return [{ mailboxId, address: box.address, domain: box.domain, displayName: '', ownerUserId: box.userId,
      ownerUsername: box.ownerUsername, grantees: [] }];
  });
  // jsdom 不做布局：给每个被虚拟列表测量的行一个固定高度，视口高度沿用 jsdom 默认的 768
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute('data-index') ? ROW_HEIGHT : 0;
  });
  scrollWindowTo(0);
});

afterEach(() => {
  vi.restoreAllMocks();
  scrollWindowTo(0);
});

describe('全站地址：大量地址时只渲染视口附近的行', () => {
  it(`${TOTAL} 个地址只渲染首屏附近的行，表格仍声明总行数`, () => {
    const { client, view } = mount();
    const addresses = renderedAddresses();
    expect(addresses.length).toBeGreaterThan(10);
    expect(addresses.length).toBeLessThan(40);
    expect(addresses[0]).toBe('user0@example.com');
    expect(screen.queryByRole('link', { name: 'user600@example.com' })).toBeNull();
    const table = screen.getByRole('table');
    expect(table).toHaveAttribute('aria-rowcount', String(TOTAL + 1));
    const rows = within(table).getAllByRole('row');
    expect(rows[1]).toHaveAttribute('aria-rowindex', '2');
    view.unmount(); client.clear();
  });

  it('实测行高与估计不同（如窄屏时间折行）时，未渲染部分按实测行高撑开，总高度准确', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute('data-index') ? 65 : 0;
    });
    const { client, view } = mount();
    const rendered = renderedAddresses().length;
    const spacer = view.container.querySelector<HTMLElement>('tbody tr[aria-hidden="true"] td')!;
    expect(spacer.style.height).toBe(`${(TOTAL - rendered) * 65}px`);
    view.unmount(); client.clear();
  });

  it('滚动后渲染新位置附近的行，离开视口的行被回收', () => {
    const { client, view } = mount();
    scrollWindowTo(ROW_HEIGHT * 300);
    const addresses = renderedAddresses();
    expect(addresses).toContain('user300@example.com');
    expect(addresses).not.toContain('user0@example.com');
    expect(addresses.length).toBeLessThan(40);
    const row = screen.getByRole('link', { name: 'user300@example.com' }).closest('tr')!;
    expect(row).toHaveAttribute('aria-rowindex', '302');
    view.unmount(); client.clear();
  });

  it('搜索能找到首屏外的地址，行内操作作用于该地址', async () => {
    const { client, view } = mount();
    fireEvent.change(screen.getByPlaceholderText('搜索地址或用户名'), { target: { value: 'user600@' } });
    expect(await screen.findByRole('link', { name: 'user600@example.com' })).toHaveAttribute('href', '/admin/addresses/1600/mail');
    expect(renderedAddresses()).toEqual(['user600@example.com']);
    expect(screen.getByRole('table')).toHaveAttribute('aria-rowcount', '2');
    fireEvent.click(screen.getByRole('button', { name: '强制释放' }));
    const dialog = await screen.findByRole('dialog', { name: '强制释放地址' });
    expect(within(dialog).getByText('user600@example.com')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));

    fireEvent.change(screen.getByPlaceholderText('搜索地址或用户名'), { target: { value: 'owner3' } });
    expect(await screen.findByRole('table')).toHaveAttribute('aria-rowcount', String(Math.ceil((TOTAL - 3) / 7) + 1));
    expect(renderedAddresses().every((address) => Number(address!.match(/\d+/)![0]) % 7 === 3)).toBe(true);
    view.unmount(); client.clear();
  });

  it('滚到下方后共享某行，读取的是该邮箱的共享名单', async () => {
    const { client, view } = mount();
    scrollWindowTo(ROW_HEIGHT * 500);
    fireEvent.click(screen.getByRole('button', { name: '共享邮箱 user500@example.com' }));
    expect(await screen.findByText('邮箱所有者：owner3')).toBeInTheDocument();
    expect(within(screen.getByRole('dialog', { name: '共享邮箱' })).getByText('user500@example.com')).toBeInTheDocument();
    expect(mocks.listShares.mock.calls).toEqual([[1500]]);
    view.unmount(); client.clear();
  });

  it('窄屏卡片同样只渲染视口附近的卡片，搜索后更多菜单作用于该地址', async () => {
    mocks.mobile = true;
    const { client, view } = mount();
    expect(screen.queryByRole('table')).toBeNull();
    const cards = screen.getAllByRole('listitem');
    expect(cards.length).toBeGreaterThan(5);
    expect(cards.length).toBeLessThan(40);
    expect(cards[0]).toHaveAttribute('aria-posinset', '1');
    expect(cards[0]).toHaveAttribute('aria-setsize', String(TOTAL));
    expect(screen.queryByRole('link', { name: 'user600@example.com' })).toBeNull();

    fireEvent.change(screen.getByPlaceholderText('搜索地址或用户名'), { target: { value: 'user600@' } });
    await screen.findByRole('link', { name: 'user600@example.com' });
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    fireEvent.keyDown(screen.getByRole('button', { name: '更多操作' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: '强制释放' }));
    const dialog = await screen.findByRole('dialog', { name: '强制释放地址' });
    expect(within(dialog).getByText('user600@example.com')).toBeInTheDocument();
    view.unmount(); client.clear();
  });
});
