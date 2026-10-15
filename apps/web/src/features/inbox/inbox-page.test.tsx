import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
const retry = vi.hoisted(() => vi.fn());
vi.mock('@/features/mailboxes/use-mailboxes', () => ({
  useMailboxesQuery: () => ({ data: undefined, isLoading: false, isError: true, error: new Error('network failed'), refetch: retry }),
  useSharedMailboxesQuery: () => ({ data: [], isLoading: false, isError: false, refetch: retry }),
}));
vi.mock('@/lib/use-config', () => ({ useDomains: () => ({ data: ['example.com'] }) }));
const unread = vi.hoisted(() => ({ value: 0 }));
vi.mock('@/features/inbox/use-unread-count', () => ({ useUnreadCount: () => ({ data: { unread: unread.value } }) }));
import { InboxPage } from './inbox-page';
describe('Inbox mailbox API errors', () => {
  it('shows the load error and retries both mailbox visibility queries', () => {
    const client = new QueryClient();
    const view = render(<QueryClientProvider client={client}><MemoryRouter><InboxPage /></MemoryRouter></QueryClientProvider>);
    expect(screen.getByText('收件箱')).toBeInTheDocument();
    expect(view.container.querySelector('.animate-pulse')).toBeNull();
    expect(screen.getByText('network failed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {name: '重新加载'}));
    expect(retry).toHaveBeenCalledTimes(2);
    client.clear();
  });
});
describe('read-all confirmation', () => {
  it.each([
    [999, '共有 999 封未读邮件'],
    // 服务端未读数封顶 1000：到顶只能说「1000+」
    [1000, '共有 1000+ 封未读邮件'],
  ])('unread=%i shows %s', (count, text) => {
    unread.value = count;
    const client = new QueryClient();
    render(<QueryClientProvider client={client}><MemoryRouter><InboxPage /></MemoryRouter></QueryClientProvider>);
    fireEvent.click(screen.getByRole('button', { name: '全部已读' }));
    expect(screen.getByText(text, { exact: false })).toBeInTheDocument();
    unread.value = 0;
    client.clear();
  });
});
