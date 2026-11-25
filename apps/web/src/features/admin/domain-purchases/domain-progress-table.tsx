import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { DomainItemResolveRequest, DomainPurchaseBatchView, DomainPurchaseItemView } from '@hpc-mail/shared';
import { queryKeys } from '@/api/query-keys';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import { ItemStatusBadge, PROGRESS_STEPS, progressIndex, SKIP_REASON_LABELS, STEP_LABELS } from './domain-meta';
import { domainPurchaseApi } from './domain-purchases-api';
import { errorMessage, money } from '../shared/vendor-ui';

/** 步进条：已完成实心、当前步骤描边，失败步骤标红 */
export function ItemStepper({ item }: { item: DomainPurchaseItemView }) {
  const at = progressIndex(item);
  const failed = item.status === 'failed' || item.status === 'unknown';
  const done = item.status === 'domain_added';
  return (
    <ol className="flex items-center gap-1" aria-label={`${item.domain} 进度`}>
      {PROGRESS_STEPS.map((step, index) => {
        const complete = done || index < at;
        const current = !done && index === at;
        return (
          <li
            key={step.status}
            title={step.label}
            aria-current={current ? 'step' : undefined}
            className={cn(
              'h-1.5 w-5 rounded-full',
              complete ? 'bg-positive' : current ? (failed ? 'bg-critical' : 'bg-caution') : 'bg-line-strong',
            )}
          >
            <span className="sr-only">
              {step.label}
              {complete ? '（完成）' : current ? '（当前）' : ''}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function ResolveItemDialog({ item, onClose }: { item: DomainPurchaseItemView | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const resolve = useMutation({
    mutationFn: (body: DomainItemResolveRequest) => domainPurchaseApi.resolveItem(item!.id, body),
    onSuccess: (updated) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.domainBatch(updated.batchId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.domainPurchaseStatus });
      toast({ title: `${updated.domain} 已处理`, variant: 'success' });
      onClose();
    },
    onError: (err) => toast({ title: errorMessage(err, '处理失败'), variant: 'error' }),
  });
  return (
    <Dialog open={item !== null} onOpenChange={(open) => !open && !resolve.isPending && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader title={`处理 ${item?.domain ?? ''}`} description="注册请求的结果不明（可能已扣费）。服务端会实时向 Spaceship 核实你的选择。" />
        <DialogBody className="flex flex-col gap-2 text-sm text-ink-secondary">
          <p>「已注册」：Spaceship 账户里能查到该域名时继续开通收件。</p>
          <p>「未注册」：该域名当前仍可注册时标记为注册失败（不会重新注册，需要的话重新报价）。</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={resolve.isPending}>
            取消
          </Button>
          <Button
            variant="secondary"
            loading={resolve.isPending && resolve.variables?.action === 'mark_not_registered'}
            disabled={resolve.isPending}
            onClick={() => resolve.mutate({ action: 'mark_not_registered' })}
          >
            确认未注册
          </Button>
          <Button
            loading={resolve.isPending && resolve.variables?.action === 'mark_registered'}
            disabled={resolve.isPending}
            onClick={() => resolve.mutate({ action: 'mark_registered' })}
          >
            确认已注册
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 确认后的逐域名进度：步骤、可能扣费提示、错误详情与可用操作 */
export function DomainProgressTable({ batch }: { batch: DomainPurchaseBatchView }) {
  const queryClient = useQueryClient();
  const [resolving, setResolving] = useState<DomainPurchaseItemView | null>(null);
  const items = batch.items ?? [];
  const act = useMutation({
    mutationFn: ({ item, action }: { item: DomainPurchaseItemView; action: 'retry' | 'refresh' }) =>
      action === 'retry' ? domainPurchaseApi.retryItem(item.id) : domainPurchaseApi.refreshItem(item.id),
    onSuccess: (updated, { action }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.domainBatch(updated.batchId) });
      toast({ title: action === 'retry' ? `${updated.domain} 已重新排队` : `${updated.domain} 已刷新`, variant: 'success' });
    },
    onError: (err) => toast({ title: errorMessage(err), variant: 'error' }),
  });
  const busy = (item: DomainPurchaseItemView, action: 'retry' | 'refresh') =>
    act.isPending && act.variables?.item.id === item.id && act.variables.action === action;

  return (
    <>
      <Table aria-label="采购进度">
        <TableHeader>
          <TableRow>
            <TableHead>域名</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>进度</TableHead>
            <TableHead className="text-right">金额</TableHead>
            <TableHead>详情</TableHead>
            <TableHead className="text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => (
            <TableRow key={item.id}>
              <TableCell className="font-medium">{item.domain}</TableCell>
              <TableCell>
                <div className="flex flex-col items-start gap-1">
                  <ItemStatusBadge status={item.status} />
                  {item.maybeCharged && <span className="text-xs font-medium text-critical">可能已扣费，结果待核实</span>}
                  {item.status === 'failed' && item.failedStep && (
                    <span className="text-xs text-critical">失败于：{STEP_LABELS[item.failedStep] ?? item.failedStep}</span>
                  )}
                </div>
              </TableCell>
              <TableCell>{item.status === 'skipped' || item.status === 'cancelled' || item.status === 'quoted' ? '—' : <ItemStepper item={item} />}</TableCell>
              <TableCell className="text-right tabular-nums">{money(item.capBasisCents)}</TableCell>
              <TableCell className="max-w-72 text-xs">
                <div className="flex flex-col gap-0.5 break-words">
                  {item.status === 'skipped' && <span className="text-ink-tertiary">{SKIP_REASON_LABELS[item.skipReason] ?? item.skipReason}</span>}
                  {item.nameServers.length > 0 && <span className="text-ink-tertiary">NS：{item.nameServers.join(', ')}</span>}
                  {item.verificationStatus && <Badge tone={item.verificationStatus === 'success' ? 'positive' : 'caution'}>注册人验证：{item.verificationStatus}</Badge>}
                  {item.suspensions.length > 0 && <Badge tone="critical">暂停：{item.suspensions.join(', ')}</Badge>}
                  {item.lastError && <span className="text-critical">{item.lastError}</span>}
                  {(item.errorCode || item.vendorOperationId) && (
                    <span className="text-ink-tertiary">
                      {item.errorCode && `错误码 ${item.errorCode}`}
                      {item.vendorOperationId && ` · 操作 ID ${item.vendorOperationId}`}
                    </span>
                  )}
                  {item.readyAt && <span className="text-positive">{formatDateTime(item.readyAt)} 起可收件</span>}
                </div>
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap justify-end gap-1">
                  {item.actions.includes('refresh') && (
                    <Button size="sm" variant="secondary" loading={busy(item, 'refresh')} onClick={() => act.mutate({ item, action: 'refresh' })}>
                      刷新
                    </Button>
                  )}
                  {item.actions.includes('retry') && (
                    <Button size="sm" variant="secondary" loading={busy(item, 'retry')} onClick={() => act.mutate({ item, action: 'retry' })}>
                      重试
                    </Button>
                  )}
                  {item.actions.includes('resolve') && (
                    <Button size="sm" variant="secondary" onClick={() => setResolving(item)}>
                      处理
                    </Button>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <ResolveItemDialog item={resolving} onClose={() => setResolving(null)} />
    </>
  );
}
