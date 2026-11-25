import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, Search, Trash2, Waypoints } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { ProxyStatus, ProxyView } from '@hpc-mail/shared';
import { queryKeys } from '@/api/query-keys';
import { QueryErrorState } from '@/components/query-error-state';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import { formatDateTime } from '@/lib/format';
import { adminProxyApi, invalidateProxyData, type ProxyListFilters } from './proxies-api';
import { ProxyFormDialog } from './proxy-form-dialog';
import { PROXY_STATUS_OPTIONS, ProxyHealthBadge, proxyEndpoint, proxyLocation, ProxyStatusBadge } from './proxy-meta';
import { ProxyRevealButton } from './proxy-reveal-button';
import { errorMessage, NativeSelect } from '../shared/vendor-ui';

function useDebounced(value: string, ms = 250): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = globalThis.setTimeout(() => setDebounced(value), ms);
    return () => globalThis.clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** 库存列表：服务端筛选 + 游标分页「加载更多」 */
export function ProxyTable() {
  const queryClient = useQueryClient();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<ProxyStatus | ''>('');
  const [provider, setProvider] = useState('');
  const [country, setCountry] = useState('');
  const [bound, setBound] = useState<'yes' | 'no' | ''>('');
  const [editing, setEditing] = useState<ProxyView | null>(null);
  const [deleting, setDeleting] = useState<ProxyView | null>(null);

  const dq = useDebounced(q.trim());
  const dProvider = useDebounced(provider.trim().toLowerCase());
  const dCountry = useDebounced(country.trim().toUpperCase());
  const filters: ProxyListFilters = useMemo(
    () => ({
      q: dq || undefined,
      status: status || undefined,
      provider: dProvider || undefined,
      country: /^[A-Z]{2}$/.test(dCountry) ? dCountry : undefined,
      bound: bound || undefined,
    }),
    [dq, status, dProvider, dCountry, bound],
  );

  const list = useInfiniteQuery({
    queryKey: queryKeys.admin.proxies(filters),
    queryFn: ({ pageParam }) => adminProxyApi.list(filters, pageParam || undefined),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: (previous) => previous,
  });
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const filtered = Object.values(filters).some((v) => v !== undefined);

  const remove = useMutation({
    mutationFn: (proxy: ProxyView) => adminProxyApi.remove(proxy.id, proxy.bindingCount > 0),
    onSuccess: (_data, proxy) => {
      invalidateProxyData(queryClient);
      toast({ title: `已删除代理 #${proxy.id}`, variant: 'success' });
      setDeleting(null);
    },
    onError: (err) => toast({ title: errorMessage(err, '删除失败'), variant: 'error' }),
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-tertiary" />
          <Input aria-label="搜索代理" value={q} onChange={(e) => setQ(e.target.value)} placeholder="备注、主机、用户名" className="pl-9" />
        </div>
        <NativeSelect aria-label="按状态筛选" className="w-32" value={status} onChange={(e) => setStatus(e.target.value as ProxyStatus | '')}>
          <option value="">全部状态</option>
          {PROXY_STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect aria-label="按绑定筛选" className="w-32" value={bound} onChange={(e) => setBound(e.target.value as 'yes' | 'no' | '')}>
          <option value="">绑定不限</option>
          <option value="yes">已绑定</option>
          <option value="no">未绑定</option>
        </NativeSelect>
        <Input aria-label="按供应商筛选" className="w-32" value={provider} placeholder="供应商" onChange={(e) => setProvider(e.target.value)} />
        <Input aria-label="按国家筛选" className="w-24" value={country} maxLength={2} placeholder="国家" onChange={(e) => setCountry(e.target.value)} />
      </div>

      {list.isPending ? (
        <Skeleton className="h-48 w-full rounded-lg" />
      ) : list.isError ? (
        <QueryErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={Waypoints}
          title={filtered ? '没有符合条件的代理' : '代理池还是空的'}
          description={filtered ? '换个筛选条件再试。' : '手工添加、批量导入，或在「1024 购买」采购后同步到这里。'}
          className="rounded-lg border border-line bg-surface"
        />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>代理</TableHead>
                <TableHead>供应商</TableHead>
                <TableHead>位置</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>绑定</TableHead>
                <TableHead>健康</TableHead>
                <TableHead>到期</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((proxy) => (
                <TableRow key={proxy.id}>
                  <TableCell className="max-w-64">
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate font-medium text-ink" title={proxy.label || undefined}>
                        #{proxy.id} {proxy.label}
                      </span>
                      <span className="truncate text-xs text-ink-tertiary" title={proxyEndpoint(proxy)}>
                        {proxyEndpoint(proxy)}
                        {proxy.username ? ` · ${proxy.username}` : ''}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-ink-secondary">
                    {proxy.provider}
                    {proxy.product && <span className="block text-xs text-ink-tertiary">{proxy.product}</span>}
                  </TableCell>
                  <TableCell className="text-ink-secondary">{proxyLocation(proxy)}</TableCell>
                  <TableCell>
                    <ProxyStatusBadge status={proxy.status} />
                  </TableCell>
                  <TableCell className="tabular-nums text-ink-secondary">
                    {proxy.bindingCount}/{proxy.maxBindings}
                  </TableCell>
                  <TableCell>
                    <ProxyHealthBadge health={proxy.health} />
                  </TableCell>
                  <TableCell className="text-ink-tertiary">{proxy.expiresAt ? formatDateTime(proxy.expiresAt) : '不过期'}</TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <ProxyRevealButton proxyId={proxy.id} label={`#${proxy.id}`} />
                      <IconButton size="sm" aria-label={`编辑代理 #${proxy.id}`} onClick={() => setEditing(proxy)}>
                        <Pencil className="size-4" />
                      </IconButton>
                      <IconButton size="sm" aria-label={`删除代理 #${proxy.id}`} onClick={() => setDeleting(proxy)}>
                        <Trash2 className="size-4 text-critical" />
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

      <ProxyFormDialog open={editing !== null} proxy={editing} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && !remove.isPending && setDeleting(null)}
        title={`删除代理 #${deleting?.id ?? ''}？`}
        description={
          deleting && deleting.bindingCount > 0
            ? `该代理绑定了 ${deleting.bindingCount} 个地址，删除会同时解除这些绑定，依赖它的流程将取不到代理。`
            : '删除后不可恢复。'
        }
        confirmLabel={deleting && deleting.bindingCount > 0 ? '解除绑定并删除' : '删除'}
        tone="danger"
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </div>
  );
}
