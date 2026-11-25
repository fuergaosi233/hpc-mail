import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ProxyOrderView } from '@hpc-mail/shared';
import { queryKeys } from '@/api/query-keys';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { money, OrderStatusBadge, orderLineItems, PRODUCT_LABELS, WARNING_LABELS } from './order-meta';
import { proxy1024Api } from './proxy-1024-api';
import { useProxy1024Catalogue } from './proxy-1024-quote-form';
import { CountdownText, errorMessage, isConflict, useCountdown } from '../shared/vendor-ui';

/** 只允许 http(s) 结算链接 */
export function safeCheckoutUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function CheckoutLink({ order }: { order: Pick<ProxyOrderView, 'checkoutUrl'> }) {
  const href = safeCheckoutUrl(order.checkoutUrl);
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-accent hover:underline">
      打开 1024 结算页
      <ExternalLink className="size-3.5" />
    </a>
  );
}

function OrderBreakdown({ order }: { order: ProxyOrderView }) {
  const catalogue = useProxy1024Catalogue();
  const lines = orderLineItems(order, catalogue.data);
  const balanceAfter = order.balanceCentsAtQuote === null ? null : order.balanceCentsAtQuote - order.estimateCents;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink">
        {PRODUCT_LABELS[order.product]}
        {order.sku ? ` · ${order.sku}` : ''}
      </p>
      <Table aria-label="费用明细">
        <TableHeader>
          <TableRow>
            <TableHead>项目</TableHead>
            <TableHead className="text-right">数量</TableHead>
            <TableHead className="text-right">目录单价</TableHead>
            <TableHead className="text-right">小计</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {lines.map((line) => (
            <TableRow key={line.key}>
              <TableCell>{line.label}</TableCell>
              <TableCell className="text-right tabular-nums">
                {line.quantity} {line.unit}
              </TableCell>
              <TableCell className="text-right tabular-nums">{money(line.unitCents)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(line.subtotalCents)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
        <dt className="text-ink-secondary">报价总额（含批量折扣）</dt>
        <dd className="text-right text-base font-semibold tabular-nums text-ink" data-testid="order-total">
          {money(order.estimateCents)}
        </dd>
        <dt className="text-ink-secondary">上限核算基数（未折扣）</dt>
        <dd className="text-right tabular-nums">{money(order.capBasisCents)}</dd>
        <dt className="text-ink-secondary">报价时账户余额</dt>
        <dd className="text-right tabular-nums">{money(order.balanceCentsAtQuote)}</dd>
        {balanceAfter !== null && (
          <>
            <dt className="text-ink-secondary">支付后预计余额</dt>
            <dd className={balanceAfter < 0 ? 'text-right tabular-nums text-critical' : 'text-right tabular-nums'}>{money(balanceAfter)}</dd>
          </>
        )}
      </dl>
      <p className="text-xs text-ink-tertiary">明细按公开价目表单价计算，仅供核对；以报价总额为准，确认时服务端会再次核对价格与余额。</p>
    </div>
  );
}

/**
 * 报价确认 = 下单：展示逐项明细与总额，确认时回传 expectedCents（= 报价总额）。
 * 下单只生成待支付订单，付款需管理员在 1024 结算页完成。
 */
export function ProxyOrderConfirmDialog({ orderId, onClose }: { orderId: number | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const order = useQuery({
    queryKey: queryKeys.admin.proxyOrder(orderId ?? 0),
    queryFn: () => proxy1024Api.order(orderId as number),
    enabled: orderId !== null,
  });
  const [notice, setNotice] = useState('');
  const [result, setResult] = useState<ProxyOrderView | null>(null);
  useEffect(() => {
    setNotice('');
    setResult(null);
  }, [orderId]);

  const confirm = useMutation({
    mutationFn: (view: ProxyOrderView) => proxy1024Api.confirm(view.id, { expectedCents: view.estimateCents }),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.admin.proxyOrder(updated.id), updated);
      setResult(updated);
    },
    onError: (err) => {
      setNotice(isConflict(err) ? `${errorMessage(err)}（已刷新报价，请核对后重新确认）` : errorMessage(err, '下单失败'));
    },
    onSettled: () => {
      // 价格变化时服务端已改写报价单；无论成败都刷新订单、状态与 24 小时额度
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.proxyOrdersRoot });
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.proxy1024Status });
    },
  });

  const view = order.data;
  const left = useCountdown(view?.quoteExpiresAt);
  const expired = left !== null && left <= 0;
  const close = () => !confirm.isPending && onClose();

  return (
    <Dialog open={orderId !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-w-xl">
        <DialogHeader title={result ? `订单 #${result.id}` : `确认下单 · 报价 #${orderId ?? ''}`} />
        <DialogBody className="flex flex-col gap-4">
          {order.isPending ? (
            <Skeleton className="h-48 w-full rounded-md" />
          ) : order.isError || !view ? (
            <p className="text-sm text-critical">{errorMessage(order.error, '报价加载失败')}</p>
          ) : result ? (
            <div className="flex flex-col gap-3 text-sm">
              <p className="flex items-center gap-2">
                状态 <OrderStatusBadge status={result.status} />
              </p>
              {result.status === 'awaiting_payment' && (
                <div className="rounded-md border border-caution/40 bg-caution-soft p-3">
                  <p className="font-medium text-caution">订单已在 1024 创建，待支付 {money(result.estimateCents)}</p>
                  <p className="mt-1 text-ink-secondary">请在 1024 结算页用账户余额完成支付；支付后定时任务会自动对账并入库。</p>
                  <div className="mt-2">
                    <CheckoutLink order={result} />
                  </div>
                </div>
              )}
              {result.status === 'unknown' && (
                <p className="rounded-md border border-critical/40 bg-critical-soft p-3 text-critical">
                  下单结果不明：1024 可能已经生成订单。系统不会自动重试，请先到 1024 控制台核对后在订单列表中处理。
                </p>
              )}
              {result.status === 'failed' && <p className="text-critical">下单被拒绝：{result.lastError || '未知原因'}（未产生订单）</p>}
              {result.warnings.filter((w) => w !== 'payment_manual' && w !== 'maybe_charged').map((w) => (
                <p key={w} className="text-xs text-ink-tertiary">
                  {WARNING_LABELS[w] ?? w}
                </p>
              ))}
            </div>
          ) : view.status !== 'quoted' ? (
            <p className="flex items-center gap-2 text-sm">
              该报价当前状态 <OrderStatusBadge status={view.status} />，不能再确认。
            </p>
          ) : (
            <>
              <OrderBreakdown order={view} />
              <div className="flex items-center justify-between text-sm">
                <CountdownText expiresAt={view.quoteExpiresAt} expiredText="报价已过期，请重新报价" />
              </div>
              <p className="flex items-start gap-2 rounded-md border border-caution/40 bg-caution-soft p-3 text-[13px] text-ink">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-caution" />
                确认后将立即在 1024 下单。付款需你在 1024 结算页手动完成；若网络中断导致结果不明，订单会标为「结果不明」且不会自动重试。
              </p>
            </>
          )}
          {notice && (
            <p role="alert" className="text-sm text-critical">
              {notice}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={close} disabled={confirm.isPending}>
            {result ? '关闭' : '取消'}
          </Button>
          {!result && view?.status === 'quoted' && (
            <Button loading={confirm.isPending} disabled={expired || order.isFetching} onClick={() => view && confirm.mutate(view)}>
              确认下单 {money(view.estimateCents)}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
