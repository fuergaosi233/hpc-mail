import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ShoppingCart } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ProxyOrderStatus, ProxyOrderView } from '@hpc-mail/shared';
import { queryKeys } from '@/api/query-keys';
import { QueryErrorState } from '@/components/query-error-state';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import { formatDateTime } from '@/lib/format';
import { invalidateProxyData } from '../proxies/proxies-api';
import { money, ORDER_IN_FLIGHT, ORDER_STATUS_OPTIONS, OrderStatusBadge, orderMaybeCharged, PRODUCT_LABELS, QUANTITY_UNITS, WARNING_LABELS } from './order-meta';
import { proxy1024Api } from './proxy-1024-api';
import { CheckoutLink } from './proxy-order-confirm-dialog';
import { errorMessage, Field, NativeSelect } from '../shared/vendor-ui';

type RowAction = 'cancel' | 'refresh' | 'allocate';

type ResolveMode = 'attach_order_no' | 'abandon' | 'mark_fulfilled';

const RESOLVE_LABELS: Record<ResolveMode, { button: string; done: (id: number) => string }> = {
  attach_order_no: { button: '关联订单号', done: () => '已关联订单号' },
  abandon: { button: '放弃订单', done: (id) => `订单 #${id} 已放弃` },
  mark_fulfilled: { button: '标记已交付', done: (id) => `订单 #${id} 已标记交付` },
};

function ResolveDialog({ order, onClose }: { order: ProxyOrderView | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const paid = order?.status === 'paid';
  const [mode, setMode] = useState<ResolveMode>(paid ? 'mark_fulfilled' : 'attach_order_no');
  const [orderNo, setOrderNo] = useState('');
  const resolve = useMutation({
    mutationFn: () =>
      proxy1024Api.resolve(
        order!.id,
        mode === 'attach_order_no' ? { action: 'attach_order_no', orderNo: orderNo.trim() } : { action: mode },
      ),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.admin.proxyOrder(updated.id), updated);
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.proxyOrdersRoot });
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.proxy1024Status });
      toast({ title: RESOLVE_LABELS[mode].done(updated.id), variant: 'success' });
      onClose();
    },
    onError: (err) => toast({ title: errorMessage(err, '处理失败'), variant: 'error' }),
  });
  if (paid) {
    return (
      <Dialog open={order !== null} onOpenChange={(open) => !open && !resolve.isPending && onClose()}>
        <DialogContent className="max-w-md">
          <DialogHeader title={`处理订单 #${order?.id ?? ''}`} description="订单已付款，但还没有识别到属于它的代理。" />
          <DialogBody className="flex flex-col gap-2 text-sm">
            <p className="text-ink">先「同步库存」并在代理库存里核对这笔订单的服务器。核对无误后标记已交付，系统不再为它自动同步。</p>
            <p className="text-xs text-ink-tertiary">只改本站记录，不调用 1024 接口，也不会退款或重新下单。</p>
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={onClose} disabled={resolve.isPending}>
              取消
            </Button>
            <Button loading={resolve.isPending} onClick={() => resolve.mutate()}>
              {RESOLVE_LABELS.mark_fulfilled.button}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <Dialog open={order !== null} onOpenChange={(open) => !open && !resolve.isPending && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader title={`处理订单 #${order?.id ?? ''}`} description="先到 1024 控制台的消费记录核对是否真的产生了订单。" />
        <DialogBody className="flex flex-col gap-3 text-sm">
          <label className="flex items-start gap-2">
            <input type="radio" name="resolve" className="mt-1" checked={mode === 'attach_order_no'} onChange={() => setMode('attach_order_no')} />
            <span>
              <span className="font-medium text-ink">关联 1024 订单号</span>
              <span className="block text-xs text-ink-tertiary">
                找到了对应订单：填入订单号，之后按该订单对账入库。{order?.orderNo ? '当前订单号在消费记录里查不到时可替换。' : ''}
              </span>
            </span>
          </label>
          {mode === 'attach_order_no' && (
            <Field label="订单号">
              {(id) => <Input id={id} value={orderNo} maxLength={64} onChange={(e) => setOrderNo(e.target.value)} />}
            </Field>
          )}
          <label className="flex items-start gap-2">
            <input type="radio" name="resolve" className="mt-1" checked={mode === 'abandon'} onChange={() => setMode('abandon')} />
            <span>
              <span className="font-medium text-ink">放弃该订单</span>
              <span className="block text-xs text-ink-tertiary">确认 1024 没有扣费或不再支付。不会调用 1024 接口。</span>
            </span>
          </label>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={resolve.isPending}>
            取消
          </Button>
          <Button
            variant={mode === 'abandon' ? 'danger' : 'primary'}
            loading={resolve.isPending}
            disabled={mode === 'attach_order_no' && !orderNo.trim()}
            onClick={() => resolve.mutate()}
          >
            {RESOLVE_LABELS[mode].button}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 订单列表：结果不明 / 待支付醒目标红；仅在有进行中的订单时轮询 */
export function ProxyOrdersTable({ onConfirm }: { onConfirm: (orderId: number) => void }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<ProxyOrderStatus | ''>('');
  const [resolving, setResolving] = useState<ProxyOrderView | null>(null);
  const [cancelling, setCancelling] = useState<ProxyOrderView | null>(null);
  const filters = useMemo(() => ({ status: status || undefined }), [status]);

  const list = useInfiniteQuery({
    queryKey: queryKeys.admin.proxyOrders(filters),
    queryFn: ({ pageParam }) => proxy1024Api.orders(filters, pageParam || undefined),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: (query) =>
      query.state.data?.pages.some((p) => p.items.some((o) => ORDER_IN_FLIGHT.includes(o.status))) ? 30_000 : false,
  });
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);

  const act = useMutation({
    mutationFn: async ({ order, action }: { order: ProxyOrderView; action: RowAction }) => {
      if (action === 'cancel') return { order: await proxy1024Api.cancel(order.id), action };
      if (action === 'refresh') return { order: await proxy1024Api.refresh(order.id), action };
      const result = await proxy1024Api.allocate(order.id);
      return { order, action, result };
    },
    onSuccess: ({ order, action, ...rest }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.proxyOrdersRoot });
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.proxy1024Status });
      if (action === 'allocate') {
        invalidateProxyData(queryClient);
        const r = 'result' in rest ? rest.result : undefined;
        toast({ title: `已分配：新增 ${r?.created ?? 0} 个代理`, variant: 'success' });
      } else if (action === 'cancel') {
        toast({ title: `报价 #${order.id} 已取消`, variant: 'success' });
        setCancelling(null);
      } else {
        if (order.status === 'fulfilled') invalidateProxyData(queryClient);
        toast({ title: `订单 #${order.id} 已刷新`, variant: 'success' });
      }
    },
    onError: (err) => toast({ title: errorMessage(err), variant: 'error' }),
  });
  const busy = (order: ProxyOrderView, action: RowAction) =>
    act.isPending && act.variables?.order.id === order.id && act.variables.action === action;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <NativeSelect aria-label="按订单状态筛选" className="w-40" value={status} onChange={(e) => setStatus(e.target.value as ProxyOrderStatus | '')}>
          <option value="">全部状态</option>
          {ORDER_STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </NativeSelect>
      </div>
      {list.isPending ? (
        <Skeleton className="h-40 w-full rounded-lg" />
      ) : list.isError ? (
        <QueryErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState icon={ShoppingCart} title={status ? '没有该状态的订单' : '还没有报价或订单'} className="rounded-lg border border-line bg-surface" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>#</TableHead>
              <TableHead>内容</TableHead>
              <TableHead className="text-right">金额</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>时间</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((order) => (
              <TableRow key={order.id}>
                <TableCell className="tabular-nums text-ink-secondary">{order.id}</TableCell>
                <TableCell className="max-w-64">
                  <span className="block text-ink">{PRODUCT_LABELS[order.product]}</span>
                  <span className="block truncate text-xs text-ink-tertiary">
                    {order.orderSpec || `${order.sku} × ${order.quantity} ${QUANTITY_UNITS[order.product]}`}
                    {order.orderNo ? ` · 订单号 ${order.orderNo}` : ''}
                  </span>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {money(order.estimateCents)}
                  {order.actualCents !== null && <span className="block text-xs text-ink-tertiary">实付 {money(order.actualCents)}</span>}
                </TableCell>
                <TableCell>
                  <div className="flex flex-col items-start gap-1">
                    <OrderStatusBadge status={order.status} />
                    {orderMaybeCharged(order) && (
                      <span className="text-xs font-medium text-critical">
                        {order.status === 'awaiting_payment' ? '已下单，待支付' : '可能已产生订单'}
                      </span>
                    )}
                    {(order.status === 'awaiting_payment' || order.status === 'unknown') && (
                      <span className="text-xs">
                        <CheckoutLink order={order} />
                      </span>
                    )}
                    {order.lastError && <span className="max-w-56 break-words text-xs text-critical">{order.lastError}</span>}
                    {order.warnings
                      // 这两项已由上面的状态提示与结算链接表达
                      .filter((w) => w !== 'payment_manual' && w !== 'maybe_charged')
                      .map((w) => (
                        <span key={w} className="text-xs text-caution">
                          {WARNING_LABELS[w] ?? w}
                        </span>
                      ))}
                  </div>
                </TableCell>
                <TableCell className="text-xs text-ink-tertiary">
                  {formatDateTime(order.createdAt)}
                  {order.paidAt && <span className="block">支付 {formatDateTime(order.paidAt)}</span>}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap justify-end gap-1">
                    {order.status === 'quoted' && (
                      <>
                        <Button size="sm" onClick={() => onConfirm(order.id)}>
                          确认下单
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setCancelling(order)}>
                          取消
                        </Button>
                      </>
                    )}
                    {ORDER_IN_FLIGHT.includes(order.status) && order.status !== 'ordering' && (
                      <Button size="sm" variant="secondary" loading={busy(order, 'refresh')} onClick={() => act.mutate({ order, action: 'refresh' })}>
                        刷新
                      </Button>
                    )}
                    {(order.status === 'unknown' || order.status === 'awaiting_payment' || order.status === 'paid') && (
                      <Button size="sm" variant="secondary" onClick={() => setResolving(order)}>
                        处理
                      </Button>
                    )}
                    {order.status === 'paid' && order.product === 'static_isp' && (
                      <Button size="sm" variant="secondary" loading={busy(order, 'allocate')} onClick={() => act.mutate({ order, action: 'allocate' })}>
                        分配 IP
                      </Button>
                    )}
                  </div>
                </TableCell>
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
      <ResolveDialog key={resolving?.id ?? 0} order={resolving} onClose={() => setResolving(null)} />
      <ConfirmDialog
        open={cancelling !== null}
        onOpenChange={(open) => !open && setCancelling(null)}
        title={`取消报价 #${cancelling?.id ?? ''}？`}
        description="报价尚未下单，取消不会调用 1024。"
        confirmLabel="取消报价"
        tone="danger"
        loading={act.isPending && act.variables?.action === 'cancel'}
        onConfirm={() => cancelling && act.mutate({ order: cancelling, action: 'cancel' })}
      />
    </div>
  );
}
