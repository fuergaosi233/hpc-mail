import { focusManager, onlineManager, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ListMessagesQuery } from '@hpc-mail/shared';
import { queryKeys } from '@/api/query-keys';
import { messageApi } from '@/api/resources';
import { mergeHeadPage, type MessageListData } from './message-cache';
import { messageListQueryOptions } from './message-queries';
import { pauseUnreadCountPolling } from './use-unread-count';

const POLL_INTERVAL_MS = 20_000;
type ListQuery = { state: { data?: MessageListData } };
const singlePage = (query: ListQuery) => (query.state.data?.pages.length ?? 0) <= 1;
const withoutData = (query: ListQuery) => query.state.data === undefined;

export function useMessagesQuery(query: Partial<ListMessagesQuery>) {
  const queryClient = useQueryClient();
  // Once loaded, polling, focus and reconnect go through /messages/sync below and refetch only when the head changed.
  // Until the first page arrives (e.g. the initial load failed) the list keeps retrying as a whole.
  const { data, isLoading, isError, error, fetchNextPage, hasNextPage, isFetchingNextPage, refetch } = useInfiniteQuery({
    ...messageListQueryOptions(query),
    refetchInterval: (current) => (withoutData(current) ? POLL_INTERVAL_MS : false),
    refetchOnWindowFocus: withoutData,
    refetchOnReconnect: withoutData,
    refetchOnMount: singlePage,
  });
  const latestQuery = useRef(query);
  latestQuery.current = query;
  const [pollError, setPollError] = useState<Error | null>(null);
  const hasData = data !== undefined;
  const queryIdentity = JSON.stringify(query);

  useEffect(() => {
    setPollError(null);
    if (!hasData) return;
    const queryKey = queryKeys.messages.list(latestQuery.current);
    const controller = new AbortController();
    // sync carries the unread count every round, so the unread-count query stops polling on its own meanwhile.
    const resumeUnreadPolling = pauseUnreadCountPolling(queryClient);
    let pending = false;
    // Paging, refetching, an optimistic write or a pending mutation happened meanwhile: drop this round's result.
    const untouched = (since: number) => {
      const latest = queryClient.getQueryState(queryKey);
      return latest?.fetchStatus === 'idle' && latest.dataUpdatedAt === since && queryClient.isMutating() === 0;
    };
    const check = async ({ probeOnly = false } = {}) => {
      const state = queryClient.getQueryState<MessageListData>(queryKey);
      if (pending || document.visibilityState === 'hidden' || !state?.data || state.fetchStatus !== 'idle') return;
      pending = true;
      const since = state.dataUpdatedAt;
      try {
        if (!probeOnly) {
          const unreadSince = queryClient.getQueryState(queryKeys.messages.unreadCount)?.dataUpdatedAt;
          const sync = await messageApi.sync(latestQuery.current, controller.signal);
          if (controller.signal.aborted) return;
          setPollError(null);
          if (!untouched(since)) return;
          const unread = queryClient.getQueryState(queryKeys.messages.unreadCount);
          if (unread?.dataUpdatedAt === unreadSince && unread?.fetchStatus !== 'fetching') {
            queryClient.setQueryData(queryKeys.messages.unreadCount, { unread: sync.unread });
          }
          const latest = queryClient.getQueryState<MessageListData>(queryKey);
          // A first page without head (persisted by an older build) or a failed refetch counts as changed.
          if (!latest?.data || (latest.status !== 'error' && latest.data.pages[0]?.head === sync.head)) return;
          if (latest.data.pages.length <= 1) {
            await queryClient.refetchQueries({ queryKey, exact: true });
            return;
          }
        }
        // Multi-page lists fetch only the head page and merge it in place instead of refetching every cursor.
        const head = await messageApi.list(latestQuery.current, controller.signal);
        if (controller.signal.aborted) return;
        setPollError(null);
        if (!untouched(since)) return;
        queryClient.setQueryData<MessageListData>(queryKey, (current) => current && mergeHeadPage(current, head));
      } catch (pollFailure) {
        if (!controller.signal.aborted) setPollError(pollFailure instanceof Error ? pollFailure : new Error('刷新邮件失败'));
      } finally {
        pending = false;
      }
    };
    const timer = globalThis.setInterval(() => void check(), POLL_INTERVAL_MS);
    const unsubscribeFocus = focusManager.subscribe((focused) => {
      if (focused) void check();
    });
    const unsubscribeOnline = onlineManager.subscribe((online) => {
      if (online) void check();
    });
    // Stale multi-page list on mount (e.g. back from a mail after marking it read): one head request instead of
    // N page refetches. Stale single-page lists are refetched by refetchOnMount.
    const cached = queryClient.getQueryCache().find<MessageListData>({ queryKey, exact: true });
    if ((cached?.state.data?.pages.length ?? 0) > 1 && cached?.isStale()) void check({ probeOnly: true });
    return () => {
      globalThis.clearInterval(timer);
      unsubscribeFocus();
      unsubscribeOnline();
      controller.abort();
      resumeUnreadPolling();
    };
  }, [queryClient, queryIdentity, hasData]);

  const refetchAll = useCallback(
    (...args: Parameters<typeof refetch>) => {
      setPollError(null);
      return refetch(...args);
    },
    [refetch],
  );

  // Only destructured fields are tracked, so background fetch-status flips no longer re-render the list.
  return {
    data,
    isLoading,
    isError: isError || pollError !== null,
    error: error ?? pollError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    refetch: refetchAll,
  };
}
