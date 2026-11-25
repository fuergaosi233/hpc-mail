import { useMutation, useQueryClient } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { DomainPurchaseBatchView, DomainPurchaseItemView } from '@hpc-mail/shared';
import { queryKeys } from '@/api/query-keys';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import { SKIP_REASON_LABELS } from './domain-meta';
import { domainPurchaseApi } from './domain-purchases-api';
import { CountdownText, errorMessage, isConflict, money, useCountdown } from '../shared/vendor-ui';

const sum = (items: DomainPurchaseItemView[], pick: (i: DomainPurchaseItemView) => number | null) =>
  items.reduce((total, item) => total + (pick(item) ?? 0), 0);

function skipText(item: DomainPurchaseItemView): string {
  const reason = item.skipReason || item.availability;
  return SKIP_REASON_LABELS[reason] ?? reason ?? '';
}

function ConfirmPurchaseDialog({
  open,
  batch,
  selected,
  onClose,
}: {
  open: boolean;
  batch: DomainPurchaseBatchView;
  selected: DomainPurchaseItemView[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const total = sum(selected, (i) => i.capBasisCents);
  const finalTotal = sum(selected, (i) => i.finalCents);
  const left = useCountdown(batch.quoteExpiresAt);
  const expired = left !== null && left <= 0;

  const confirm = useMutation({
    mutationFn: () =>
      domainPurchaseApi.confirm(batch.id, { domains: selected.map((i) => i.domain), expectedTotalCents: total }),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.admin.domainBatch(updated.id), updated);
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.domainPurchaseStatus });
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.domainBatches({}) });
      toast({ title: `已确认采购 ${selected.length} 个域名，开始注册`, variant: 'success' });
      onClose();
    },
    onError: (err) => {
      if (isConflict(err)) {
        // 价格/可用性变了或报价过期：服务端已更新批次，重新拉取后让管理员重新核对
        void queryClient.invalidateQueries({ queryKey: queryKeys.admin.domainBatch(batch.id) });
        toast({ title: '报价已变化', description: errorMessage(err, '请核对后重新确认'), variant: 'error' });
        onClose();
      } else {
        toast({ title: errorMessage(err, '确认失败'), variant: 'error' });
      }
    },
  });

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !confirm.isPending && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader title={`确认购买 ${selected.length} 个域名`} description={`注册 ${batch.years} 年 · 隐私保护${batch.privacyLevel === 'high' ? '开启' : '关闭'} · 自动续费${batch.autoRenew ? '开启' : '关闭'}`} />
        <DialogBody className="flex flex-col gap-3">
          <Table aria-label="购买明细">
            <TableHeader>
              <TableRow>
                <TableHead>域名</TableHead>
                <TableHead className="text-right">实价</TableHead>
                <TableHead className="text-right">上限核算</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {selected.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    {item.domain}
                    {item.priceClass === 'premium' && (
                      <Badge tone="caution" className="ml-1.5">
                        溢价
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{money(item.finalCents)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(item.capBasisCents)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
            <dt className="text-ink-secondary">域名数</dt>
            <dd className="text-right tabular-nums">{selected.length}</dd>
            <dt className="text-ink-secondary">预计实付合计</dt>
            <dd className="text-right tabular-nums">{money(finalTotal)}</dd>
            <dt className="font-medium text-ink">确认总额（上限核算）</dt>
            <dd className="text-right text-base font-semibold tabular-nums text-ink" data-testid="confirm-total">
              {money(total)}
            </dd>
          </dl>
          <CountdownText expiresAt={batch.quoteExpiresAt} expiredText="报价已过期，请重新报价" />
          <p className="flex items-start gap-2 rounded-md border border-caution/40 bg-caution-soft p-3 text-[13px] text-ink">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-caution" />
            确认后服务端会再次核对可用性与价格（有上涨则不购买并要求重新确认），然后逐个向 Spaceship 注册，费用从 Spaceship 账户扣除。注册结果不明的域名不会自动重试。
          </p>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={confirm.isPending}>
            取消
          </Button>
          <Button loading={confirm.isPending} disabled={expired || selected.length === 0 || total <= 0} onClick={() => confirm.mutate()}>
            确认购买 {money(total)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 报价表：勾选要买的域名，实时合计；确认弹窗重复明细与总额 */
export function DomainQuoteTable({ batch }: { batch: DomainPurchaseBatchView }) {
  const items = useMemo(() => batch.items ?? [], [batch.items]);
  const buyable = useMemo(() => items.filter((i) => i.status === 'quoted' && i.capBasisCents !== null), [items]);
  const signature = buyable.map((i) => `${i.domain}:${i.capBasisCents}`).join(',');
  const [selected, setSelected] = useState<Set<string>>(() => new Set(buyable.map((i) => i.domain)));
  const [confirmOpen, setConfirmOpen] = useState(false);
  // 重新报价（409 后）价格或可用性变化：选择重置为当前可购买的全部
  useEffect(() => {
    setSelected(new Set(buyable.map((i) => i.domain)));
  }, [signature]);

  const chosen = buyable.filter((i) => selected.has(i.domain));
  const total = sum(chosen, (i) => i.capBasisCents);
  const isQuoted = batch.status === 'quoted';
  const allChecked = buyable.length > 0 && chosen.length === buyable.length;
  const toggle = (domain: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(domain);
      else next.delete(domain);
      return next;
    });

  return (
    <div className="flex flex-col gap-3">
      <Table aria-label="报价">
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">
              <Checkbox
                aria-label="全选可购买域名"
                disabled={!isQuoted || buyable.length === 0}
                checked={allChecked ? true : chosen.length > 0 ? 'indeterminate' : false}
                onCheckedChange={(value) => setSelected(value === true ? new Set(buyable.map((i) => i.domain)) : new Set())}
              />
            </TableHead>
            <TableHead>域名</TableHead>
            <TableHead>价格类型</TableHead>
            <TableHead className="text-right">实价</TableHead>
            <TableHead className="text-right">常规价</TableHead>
            <TableHead className="text-right">上限核算</TableHead>
            <TableHead>说明</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => {
            const canBuy = item.status === 'quoted' && item.capBasisCents !== null;
            return (
              <TableRow key={item.id} className={canBuy ? undefined : 'text-ink-tertiary'}>
                <TableCell>
                  {canBuy && (
                    <Checkbox
                      aria-label={`选择 ${item.domain}`}
                      disabled={!isQuoted}
                      checked={selected.has(item.domain)}
                      onCheckedChange={(value) => toggle(item.domain, value === true)}
                    />
                  )}
                </TableCell>
                <TableCell className="font-medium">{item.domain}</TableCell>
                <TableCell>
                  {item.priceClass === 'premium' ? <Badge tone="caution">溢价</Badge> : item.priceClass === 'standard' ? '标准' : '—'}
                </TableCell>
                <TableCell className="text-right tabular-nums">{money(item.finalCents)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(item.regularCents)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(item.capBasisCents)}</TableCell>
                <TableCell className="text-xs">{canBuy ? '可购买' : skipText(item)}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {isQuoted && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface p-4">
          <div className="flex flex-col gap-0.5 text-sm">
            <span>
              已选 <b className="tabular-nums">{chosen.length}</b> 个，合计（上限核算）
              <b className="ml-1 text-base tabular-nums" data-testid="selection-total">
                {money(total)}
              </b>
            </span>
            <CountdownText expiresAt={batch.quoteExpiresAt} expiredText="报价已过期，请重新报价" />
          </div>
          <Button disabled={chosen.length === 0} onClick={() => setConfirmOpen(true)}>
            确认购买…
          </Button>
        </div>
      )}
      <ConfirmPurchaseDialog open={confirmOpen} batch={batch} selected={chosen} onClose={() => setConfirmOpen(false)} />
    </div>
  );
}
