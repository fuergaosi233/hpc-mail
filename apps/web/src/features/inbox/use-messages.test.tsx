import { QueryClient, QueryClientProvider, focusManager, onlineManager } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListMessagesQuery, MessageListPage, MessageSummary } from '@hpc-mail/shared';
const api = vi.hoisted(() => ({ list: vi.fn(), sync: vi.fn(), unreadCount: vi.fn() }));
vi.mock('@/api/resources', () => ({ messageApi: api }));
import { queryKeys } from '@/api/query-keys';
import type { MessageListData } from './message-cache';
import { useMessagesQuery } from './use-messages';
import { useUnreadCount } from './use-unread-count';

const query: Partial<ListMessagesQuery> = { direction: 'inbound' };
const listKey = queryKeys.messages.list(query);
const mail = (id: number, extra: Partial<MessageSummary> = {}) =>
  ({ id, isRead: false, isStarred: false, status: 'received', ...extra }) as MessageSummary;
const page = (ids: number[], nextCursor: string | null, head?: string): MessageListPage => ({
  items: ids.map((id) => mail(id)),
  nextCursor,
  ...(head === undefined ? {} : { head }),
});
const ids = (data: { pages: MessageListPage[] } | undefined) => data?.pages.map((p) => p.items.map((m) => m.id));

const clients: QueryClient[] = [];
function createClient() {
  // 与生产一致：刚取到的列表挂载时不重拉，只由轮询驱动
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
  clients.push(client);
  return client;
}
const wrapperOf = (client: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
const renderList = (client: QueryClient) => renderHook(() => useMessagesQuery(query), { wrapper: wrapperOf(client) });

// 接管所有 20 秒的定时器（列表的 sync 轮询与未读数自身的 refetchInterval），由 tick() 手动推进
const pollTimers = new Map<number, () => void>();
let nextTimerId = -1;
/** 走过一个 20 秒轮询周期 */
const tick = () => act(() => {
  [...pollTimers.values()].forEach((callback) => callback());
});
// 失败后的静默重试延迟（2.5 秒）同样接管，由 fireRetry() 手动推进
const retryTimers = new Map<number, () => void>();
const fireRetry = () => act(() => {
  const callbacks = [...retryTimers.values()];
  retryTimers.clear();
  callbacks.forEach((callback) => callback());
});
/** 让已发出的请求与随后的缓存写入落定 */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

beforeEach(() => {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, delay?: number, ...args: unknown[]) => {
    if (delay !== 20_000) return realSetInterval(callback, delay, ...args);
    const id = nextTimerId--;
    pollTimers.set(id, callback);
    return id;
  }) as typeof setInterval);
  vi.spyOn(globalThis, 'clearInterval').mockImplementation(((id?: number) => {
    if (id === undefined || !pollTimers.delete(id)) realClearInterval(id);
  }) as typeof clearInterval);
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay?: number, ...args: unknown[]) => {
    if (delay !== 2_500) return realSetTimeout(callback, delay, ...args);
    const id = nextTimerId--;
    retryTimers.set(id, callback);
    return id;
  }) as typeof setTimeout);
  vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((id?: number) => {
    if (id === undefined || !retryTimers.delete(id)) realClearTimeout(id);
  }) as typeof clearTimeout);
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  pollTimers.clear();
  retryTimers.clear();
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
  Object.values(api).forEach((mock) => mock.mockReset());
});

describe('list polling via /messages/sync', () => {
  it('sends only the sync request while the head is unchanged and writes its unread count', async () => {
    api.list.mockResolvedValue(page([3, 2], null, 'h1'));
    api.sync.mockResolvedValue({ unread: 4, head: 'h1' });
    const client = createClient();
    const { result } = renderList(client);
    await waitFor(() => expect(ids(result.current.data)).toEqual([[3, 2]]));

    await tick();
    await waitFor(() => expect(api.sync).toHaveBeenCalledTimes(1));
    await settle();
    expect(api.sync).toHaveBeenCalledWith(query, expect.any(AbortSignal));
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(queryKeys.messages.unreadCount)).toEqual({ unread: 4 });
  });

  it('refetches a single-page list as a whole when the head changed, then stays quiet', async () => {
    api.list.mockResolvedValueOnce(page([3, 2], null, 'h1')).mockResolvedValue(page([4, 3, 2], null, 'h2'));
    api.sync.mockResolvedValue({ unread: 1, head: 'h2' });
    const client = createClient();
    const { result } = renderList(client);
    await waitFor(() => expect(ids(result.current.data)).toEqual([[3, 2]]));

    await tick();
    await waitFor(() => expect(ids(result.current.data)).toEqual([[4, 3, 2]]));
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(api.list.mock.calls[1]?.[0].cursor).toBeUndefined();

    await tick();
    await waitFor(() => expect(api.sync).toHaveBeenCalledTimes(2));
    await settle();
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it('merges the head page into a multi-page list instead of refetching every cursor', async () => {
    let head = page([3], 'older', 'h1');
    api.list.mockImplementation(async (params: { cursor?: string }) => (params.cursor === 'older' ? page([2], null) : head));
    api.sync.mockResolvedValue({ unread: 0, head: 'h1' });
    const client = createClient();
    const { result } = renderList(client);
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(1));
    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
    const olderItem = result.current.data!.pages[1]!.items[0];
    const baseline = api.list.mock.calls.length;

    await tick();
    await waitFor(() => expect(api.sync).toHaveBeenCalledTimes(1));
    await settle();
    expect(api.list).toHaveBeenCalledTimes(baseline);

    // 新邮件到达 + 首条状态变化
    head = { items: [mail(4), mail(3, { isRead: true })], nextCursor: 'older', head: 'h2' };
    api.sync.mockResolvedValue({ unread: 0, head: 'h2' });
    await tick();
    await waitFor(() => expect(ids(result.current.data)).toEqual([[4, 3], [2]]));
    expect(result.current.data?.pages[0]?.items[1]?.isRead).toBe(true);
    expect(result.current.data?.pages[1]?.items[0]).toBe(olderItem);
    expect(result.current.data?.pages[0]?.head).toBe('h2');
    // 只发了 1 个首页探测请求，没有按游标重拉后续页
    expect(api.list.mock.calls.slice(baseline).map(([params]) => params.cursor)).toEqual([undefined]);

    await tick();
    await waitFor(() => expect(api.sync).toHaveBeenCalledTimes(3));
    await settle();
    expect(api.list).toHaveBeenCalledTimes(baseline + 1);
  });

  it('treats a first page without head (persisted by an older build) as changed once', async () => {
    const client = createClient();
    client.setQueryData<MessageListData>(listKey, { pages: [page([3], null)], pageParams: [''] });
    api.list.mockResolvedValue(page([3], null, 'h1'));
    api.sync.mockResolvedValue({ unread: 0, head: 'h1' });
    const { result } = renderList(client);
    await settle();
    expect(api.list).not.toHaveBeenCalled();

    await tick();
    await waitFor(() => expect(result.current.data?.pages[0]?.head).toBe('h1'));
    expect(api.list).toHaveBeenCalledTimes(1);

    await tick();
    await waitFor(() => expect(api.sync).toHaveBeenCalledTimes(2));
    await settle();
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it('pauses the unread-count polling while a list view polls, and resumes it afterwards', async () => {
    const client = createClient();
    api.unreadCount.mockResolvedValue({ unread: 1 });
    api.list.mockResolvedValue(page([3], null, 'h1'));
    api.sync.mockResolvedValue({ unread: 5, head: 'h1' });
    const unread = renderHook(() => useUnreadCount(), { wrapper: wrapperOf(client) });
    await waitFor(() => expect(unread.result.current.data).toEqual({ unread: 1 }));
    const list = renderList(client);
    await waitFor(() => expect(list.result.current.data).toBeDefined());

    await tick();
    await waitFor(() => expect(unread.result.current.data).toEqual({ unread: 5 }));
    // 聚焦时同样只检查一次 sync
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await waitFor(() => expect(api.sync).toHaveBeenCalledTimes(2));
    await settle();
    expect(api.unreadCount).toHaveBeenCalledTimes(1);
    expect(api.list).toHaveBeenCalledTimes(1);

    // 离开列表视图后未读数恢复自己的轮询
    list.unmount();
    await tick();
    await waitFor(() => expect(api.unreadCount).toHaveBeenCalledTimes(2));
    expect(api.sync).toHaveBeenCalledTimes(2);
  });

  it('drops the round while a mutation is pending, and skips hidden tabs', async () => {
    api.list.mockResolvedValue(page([3], null, 'h1'));
    api.sync.mockResolvedValue({ unread: 9, head: 'h2' });
    const client = createClient();
    client.setQueryData(queryKeys.messages.unreadCount, { unread: 1 });
    const { result } = renderList(client);
    await waitFor(() => expect(result.current.data).toBeDefined());

    const mutation = client.getMutationCache().build(client, { mutationFn: () => new Promise<never>(() => {}) });
    void mutation.execute(undefined);
    await waitFor(() => expect(client.isMutating()).toBe(1));
    await tick();
    await waitFor(() => expect(api.sync).toHaveBeenCalledTimes(1));
    await settle();
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(queryKeys.messages.unreadCount)).toEqual({ unread: 1 });
    client.getMutationCache().clear();

    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await tick();
    await settle();
    expect(api.sync).toHaveBeenCalledTimes(1);
    visibility.mockRestore();
  });

  it('retries a single failed sync quietly after a short delay without overlapping the next round', async () => {
    api.list.mockResolvedValue(page([3], null, 'h1'));
    api.sync.mockRejectedValueOnce(new Error('网络异常')).mockResolvedValue({ unread: 2, head: 'h1' });
    const client = createClient();
    const { result } = renderList(client);
    await waitFor(() => expect(result.current.data).toBeDefined());

    await tick();
    await waitFor(() => expect(retryTimers.size).toBe(1));
    expect(result.current.isError).toBe(false);
    // 重试等待期间定时器到点：沿用 pending，不并发再发一次
    await tick();
    await settle();
    expect(api.sync).toHaveBeenCalledTimes(1);

    await fireRetry();
    await waitFor(() => expect(client.getQueryData(queryKeys.messages.unreadCount)).toEqual({ unread: 2 }));
    expect(api.sync).toHaveBeenCalledTimes(2);
    expect(result.current.isError).toBe(false);
  });

  it('reports two consecutive failures and clears the error on the next successful round', async () => {
    api.list.mockResolvedValue(page([3], null, 'h1'));
    api.sync
      .mockRejectedValueOnce(new Error('网络异常'))
      .mockRejectedValueOnce(new Error('网络异常'))
      .mockResolvedValue({ unread: 0, head: 'h1' });
    const client = createClient();
    const { result } = renderList(client);
    await waitFor(() => expect(result.current.data).toBeDefined());

    await tick();
    await waitFor(() => expect(retryTimers.size).toBe(1));
    await fireRetry();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('网络异常');
    expect(result.current.data?.pages[0]?.items).toHaveLength(1);

    await tick();
    await waitFor(() => expect(result.current.isError).toBe(false));
    expect(api.sync).toHaveBeenCalledTimes(3);
  });

  it('skips rounds while offline and checks once the connection is back', async () => {
    api.list.mockResolvedValue(page([3], null, 'h1'));
    api.sync.mockResolvedValue({ unread: 0, head: 'h1' });
    const client = createClient();
    const { result } = renderList(client);
    await waitFor(() => expect(result.current.data).toBeDefined());

    act(() => onlineManager.setOnline(false));
    await tick();
    await settle();
    expect(api.sync).not.toHaveBeenCalled();
    expect(result.current.isError).toBe(false);

    act(() => onlineManager.setOnline(true));
    await waitFor(() => expect(api.sync).toHaveBeenCalledTimes(1));
  });

  it('retries the head probe of a stale multi-page list the same way', async () => {
    api.list.mockRejectedValueOnce(new Error('网络异常')).mockResolvedValue(page([4, 3], 'older', 'h2'));
    const client = createClient();
    client.setQueryData<MessageListData>(listKey, { pages: [page([3], 'older', 'h1'), page([2], null)], pageParams: ['', 'older'] });
    await client.invalidateQueries({ queryKey: queryKeys.messages.lists, refetchType: 'none' });
    const { result } = renderList(client);
    await waitFor(() => expect(retryTimers.size).toBe(1));
    expect(result.current.isError).toBe(false);

    await fireRetry();
    await waitFor(() => expect(ids(result.current.data)).toEqual([[4, 3], [2]]));
    expect(api.list.mock.calls.map(([params]) => params.cursor)).toEqual([undefined, undefined]);
    expect(api.sync).not.toHaveBeenCalled();
    expect(result.current.isError).toBe(false);
  });

  it('probes the head once when a stale multi-page list mounts, then checks sync on focus', async () => {
    api.list.mockResolvedValue(page([3], 'older', 'h1'));
    api.sync.mockResolvedValue({ unread: 0, head: 'h1' });
    const client = createClient();
    client.setQueryData<MessageListData>(listKey, { pages: [page([3], 'older', 'h1'), page([2], null)], pageParams: ['', 'older'] });
    await client.invalidateQueries({ queryKey: queryKeys.messages.lists, refetchType: 'none' });
    const { result } = renderList(client);
    expect(result.current.data?.pages).toHaveLength(2);
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(1));
    expect(api.list.mock.calls[0]?.[0].cursor).toBeUndefined();
    expect(api.sync).not.toHaveBeenCalled();
    await waitFor(() => expect(client.getQueryState(listKey)?.isInvalidated).toBe(false));

    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await waitFor(() => expect(api.sync).toHaveBeenCalledTimes(1));
    await settle();
    expect(api.list).toHaveBeenCalledTimes(1);
  });
});
