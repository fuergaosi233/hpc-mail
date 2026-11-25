import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { queryKeys } from '@/api/query-keys';
import { PageHeader } from '@/components/page-header';
import { QueryErrorState } from '@/components/query-error-state';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { formatDateTime } from '@/lib/format';
import { NotFoundPage } from '@/app/not-found-page';
import { BATCH_IN_FLIGHT, BatchStatusBadge } from './domain-meta';
import { DomainProgressTable } from './domain-progress-table';
import { DomainQuoteTable } from './domain-quote-table';
import { domainPurchaseApi } from './domain-purchases-api';
import { errorMessage, InfoItem, money, Panel } from '../shared/vendor-ui';

/** 单个采购批次：报价阶段勾选确认；确认后逐域名显示进度，处理中每 10 秒刷新 */
export function DomainBatchPage() {
  const params = useParams();
  const id = Number(params.id);
  const valid = Number.isInteger(id) && id > 0;
  const queryClient = useQueryClient();
  const [cancelOpen, setCancelOpen] = useState(false);
  const batch = useQuery({
    queryKey: queryKeys.admin.domainBatch(id),
    queryFn: () => domainPurchaseApi.batch(id),
    enabled: valid,
    refetchInterval: (query) => (query.state.data && BATCH_IN_FLIGHT.includes(query.state.data.status) ? 10_000 : false),
  });
  const cancel = useMutation({
    mutationFn: () => domainPurchaseApi.cancel(id),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.admin.domainBatch(id), updated);
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.domainBatches({}) });
      toast({ title: `批次 #${id} 已取消`, variant: 'success' });
      setCancelOpen(false);
    },
    onError: (err) => toast({ title: errorMessage(err, '取消失败'), variant: 'error' }),
  });

  if (!valid) return <NotFoundPage />;

  const back = (
    <Button asChild variant="ghost" size="sm">
      <Link to="/admin/domain-purchases">
        <ArrowLeft className="size-4" />
        返回域名采购
      </Link>
    </Button>
  );

  if (batch.isPending) {
    return (
      <div className="mx-auto max-w-5xl space-y-4">
        {back}
        <Skeleton className="h-64 w-full rounded-lg" />
      </div>
    );
  }
  if (batch.isError) {
    return (
      <div className="mx-auto max-w-5xl space-y-4">
        {back}
        <QueryErrorState error={batch.error} onRetry={() => void batch.refetch()} />
      </div>
    );
  }

  const b = batch.data;
  const quoting = b.status === 'quoted';
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <div>{back}</div>
      <PageHeader
        title={`采购批次 #${b.id}`}
        description={quoting ? '勾选要购买的域名，确认弹窗会再次列出明细与总额。' : '确认后由定时任务逐个推进；注册结果不明的域名不会自动重试。'}
        actions={
          quoting && (
            <Button variant="secondary" onClick={() => setCancelOpen(true)}>
              取消批次
            </Button>
          )
        }
      />
      <Panel title="概况">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <InfoItem label="状态">
            <BatchStatusBadge status={b.status} />
          </InfoItem>
          <InfoItem label="注册年限">{b.years} 年</InfoItem>
          <InfoItem label={b.confirmedTotalCents > 0 ? '已确认总额' : '报价总额（可购买部分）'}>
            <span className="tabular-nums">{money(b.confirmedTotalCents > 0 ? b.confirmedTotalCents : b.quoteTotalCents)}</span>
          </InfoItem>
          <InfoItem label={b.confirmedAt ? '确认时间' : '报价有效至'}>
            {formatDateTime(b.confirmedAt ?? b.quoteExpiresAt)}
          </InfoItem>
        </dl>
        {b.lastError && <p className="break-words text-[13px] text-critical">{b.lastError}</p>}
      </Panel>
      {quoting ? <DomainQuoteTable batch={b} /> : <DomainProgressTable batch={b} />}
      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={(open) => !open && !cancel.isPending && setCancelOpen(false)}
        title={`取消批次 #${b.id}？`}
        description="报价阶段尚未注册任何域名，取消不会产生费用。"
        confirmLabel="取消批次"
        tone="danger"
        loading={cancel.isPending}
        onConfirm={() => cancel.mutate()}
      />
    </div>
  );
}
