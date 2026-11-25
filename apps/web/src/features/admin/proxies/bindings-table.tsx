import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link2, Link2Off, Plus, Repeat, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { ProxyBindingSource, ProxyBindingView } from '@hpc-mail/shared';
import { queryKeys } from '@/api/query-keys';
import { QueryErrorState } from '@/components/query-error-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import { formatDateTime } from '@/lib/format';
import { BindProxyDialog } from './bind-proxy-dialog';
import { adminProxyApi, type BindingListFilters, invalidateProxyData } from './proxies-api';
import { proxyEndpoint, ProxyStatusBadge, proxyTitle } from './proxy-meta';
import { ProxyRevealButton } from './proxy-reveal-button';
import { errorMessage } from '../shared/vendor-ui';

const SOURCE_LABELS: Record<ProxyBindingSource, string> = { manual: '手工', auto: '自动分配', import: '导入' };

interface BindTarget {
  address?: string;
  currentProxyId?: number | null;
}

export function BindingsTable() {
  const queryClient = useQueryClient();
  const [q, setQ] = useState('');
  const [domain, setDomain] = useState('');
  const [debounced, setDebounced] = useState({ q: '', domain: '' });
  const [binding, setBinding] = useState<BindTarget | null>(null);
  const [unbinding, setUnbinding] = useState<ProxyBindingView | null>(null);
  useEffect(() => {
    const timer = globalThis.setTimeout(() => setDebounced({ q: q.trim().toLowerCase(), domain: domain.trim().toLowerCase() }), 250);
    return () => globalThis.clearTimeout(timer);
  }, [q, domain]);

  const filters: BindingListFilters = useMemo(
    () => ({
      q: debounced.q || undefined,
      // 只在形似域名时提交，避免输入一半被服务端判为非法
      domain: /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(debounced.domain) ? debounced.domain : undefined,
    }),
    [debounced],
  );
  const list = useInfiniteQuery({
    queryKey: queryKeys.admin.proxyBindings(filters),
    queryFn: ({ pageParam }) => adminProxyApi.bindings(filters, pageParam || undefined),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: (previous) => previous,
  });
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const filtered = filters.q !== undefined || filters.domain !== undefined;

  const unbind = useMutation({
    mutationFn: (address: string) => adminProxyApi.unbind(address),
    onSuccess: (_data, address) => {
      invalidateProxyData(queryClient);
      toast({ title: `已解除 ${address} 的代理绑定`, variant: 'success' });
      setUnbinding(null);
    },
    onError: (err) => toast({ title: errorMessage(err, '解绑失败'), variant: 'error' }),
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-tertiary" />
          <Input aria-label="搜索地址" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索地址" className="pl-9" />
        </div>
        <Input aria-label="按域名筛选" className="w-44" value={domain} placeholder="域名" onChange={(e) => setDomain(e.target.value)} />
        <Button variant="secondary" className="ml-auto" onClick={() => setBinding({})}>
          <Plus className="size-4" />
          绑定地址
        </Button>
      </div>

      {list.isPending ? (
        <Skeleton className="h-48 w-full rounded-lg" />
      ) : list.isError ? (
        <QueryErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={Link2}
          title={filtered ? '没有符合条件的绑定' : '还没有地址绑定代理'}
          description={filtered ? '换个关键词再试。' : '可在这里或「全站地址」逐个绑定，也可用「自动分配」批量分配空闲代理。'}
          className="rounded-lg border border-line bg-surface"
        />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>地址</TableHead>
                <TableHead>认领人</TableHead>
                <TableHead>代理</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>来源</TableHead>
                <TableHead>更新时间</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((b) => (
                <TableRow key={b.address}>
                  <TableCell className="max-w-64 truncate font-medium" title={b.address}>
                    {b.address}
                  </TableCell>
                  <TableCell className="text-ink-secondary">{b.ownerUsername ?? <span className="text-ink-tertiary">未认领</span>}</TableCell>
                  <TableCell className="max-w-56">
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-ink">
                        #{b.proxy.id} {proxyTitle(b.proxy)}
                      </span>
                      <span className="truncate text-xs text-ink-tertiary">
                        {proxyEndpoint(b.proxy)} · {b.proxy.provider}
                        {b.proxy.country ? ` · ${b.proxy.country}` : ''}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <ProxyStatusBadge status={b.proxy.status} />
                  </TableCell>
                  <TableCell>
                    <Badge>{SOURCE_LABELS[b.source] ?? b.source}</Badge>
                  </TableCell>
                  <TableCell className="text-ink-tertiary">{formatDateTime(b.updatedAt)}</TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <ProxyRevealButton proxyId={b.proxyId} label={b.address} />
                      <IconButton size="sm" aria-label={`更换代理 ${b.address}`} onClick={() => setBinding({ address: b.address, currentProxyId: b.proxyId })}>
                        <Repeat className="size-4" />
                      </IconButton>
                      <IconButton size="sm" aria-label={`解除绑定 ${b.address}`} onClick={() => setUnbinding(b)}>
                        <Link2Off className="size-4 text-critical" />
                      </IconButton>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {list.hasNextPage && (
        <div className="flex justify-center">
          <Button variant="secondary" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
            加载更多
          </Button>
        </div>
      )}

      <BindProxyDialog
        open={binding !== null}
        address={binding?.address}
        currentProxyId={binding?.currentProxyId}
        onClose={() => setBinding(null)}
      />
      <ConfirmDialog
        open={unbinding !== null}
        onOpenChange={(open) => !open && !unbind.isPending && setUnbinding(null)}
        title={`解除 ${unbinding?.address ?? ''} 的代理绑定？`}
        description="解除后该地址取不到代理，代理回到空闲库存（可再分配给其他地址）。"
        confirmLabel="解除绑定"
        tone="danger"
        loading={unbind.isPending}
        onConfirm={() => unbinding && unbind.mutate(unbinding.address)}
      />
    </div>
  );
}
