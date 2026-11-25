import { useInfiniteQuery } from '@tanstack/react-query';
import { Globe2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { DomainBatchStatus, DomainPurchaseBatchView } from '@hpc-mail/shared';
import { queryKeys } from '@/api/query-keys';
import { QueryErrorState } from '@/components/query-error-state';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDateTime } from '@/lib/format';
import { BATCH_IN_FLIGHT, BATCH_STATUS_OPTIONS, BatchStatusBadge } from './domain-meta';
import { domainPurchaseApi } from './domain-purchases-api';
import { money, NativeSelect } from '../shared/vendor-ui';

function countsSummary(batch: DomainPurchaseBatchView): string {
  const c = batch.counts;
  const parts: string[] = [];
  if (c.quoted) parts.push(`可购买 ${c.quoted}`);
  if (c.domain_added) parts.push(`可收件 ${c.domain_added}`);
  const inFlight = (['confirmed', 'registering', 'registered', 'zone_created', 'ns_set', 'zone_active', 'routing_ready'] as const).reduce(
    (sum, key) => sum + (c[key] ?? 0),
    0,
  );
  if (inFlight) parts.push(`进行中 ${inFlight}`);
  if (c.unknown) parts.push(`结果不明 ${c.unknown}`);
  if (c.failed) parts.push(`失败 ${c.failed}`);
  if (c.skipped) parts.push(`跳过 ${c.skipped}`);
  return parts.join(' · ') || '—';
}

export function DomainBatchesTable() {
  const [status, setStatus] = useState<DomainBatchStatus | ''>('');
  const filters = useMemo(() => ({ status: status || undefined }), [status]);
  const list = useInfiniteQuery({
    queryKey: queryKeys.admin.domainBatches(filters),
    queryFn: ({ pageParam }) => domainPurchaseApi.batches(filters, pageParam || undefined),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: (query) =>
      query.state.data?.pages.some((p) => p.items.some((b) => BATCH_IN_FLIGHT.includes(b.status))) ? 30_000 : false,
  });
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);

  return (
    <div className="flex flex-col gap-3">
      <NativeSelect aria-label="按批次状态筛选" className="w-40" value={status} onChange={(e) => setStatus(e.target.value as DomainBatchStatus | '')}>
        <option value="">全部状态</option>
        {BATCH_STATUS_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </NativeSelect>
      {list.isPending ? (
        <Skeleton className="h-40 w-full rounded-lg" />
      ) : list.isError ? (
        <QueryErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState icon={Globe2} title={status ? '没有该状态的批次' : '还没有采购批次'} className="rounded-lg border border-line bg-surface" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>批次</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>域名</TableHead>
              <TableHead className="text-right">金额</TableHead>
              <TableHead>创建时间</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((batch) => (
              <TableRow key={batch.id}>
                <TableCell>
                  <Link to={`/admin/domain-purchases/${batch.id}`} className="font-medium text-ink hover:text-accent hover:underline">
                    批次 #{batch.id}
                  </Link>
                </TableCell>
                <TableCell>
                  <BatchStatusBadge status={batch.status} />
                </TableCell>
                <TableCell className="text-xs text-ink-secondary">{countsSummary(batch)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {batch.confirmedTotalCents > 0 ? money(batch.confirmedTotalCents) : money(batch.quoteTotalCents)}
                  <span className="block text-xs text-ink-tertiary">{batch.confirmedTotalCents > 0 ? '已确认' : '报价'}</span>
                </TableCell>
                <TableCell className="text-ink-tertiary">{formatDateTime(batch.createdAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {list.hasNextPage && (
        <div className="flex justify-center">
          <Button variant="secondary" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
            加载更多
          </Button>
        </div>
      )}
    </div>
  );
}
