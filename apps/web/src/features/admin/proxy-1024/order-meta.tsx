import { type Proxy1024Catalogue, type Proxy1024Product, type ProxyOrderStatus, type ProxyOrderView, type ProxyOrderWarning } from '@hpc-mail/shared';
import { Badge, type BadgeTone } from '@/components/ui/badge';

export const PRODUCT_LABELS: Record<Proxy1024Product, string> = {
  static_isp: '静态 ISP',
  unlimited_port: '不限量（按端口）',
  unlimited_bandwidth: '不限量（按带宽）',
  residential_flow: '动态住宅流量',
};

/** 各产品数量的单位 */
export const QUANTITY_UNITS: Record<Proxy1024Product, string> = {
  static_isp: '个 IP',
  unlimited_port: '个端口',
  unlimited_bandwidth: '套',
  residential_flow: 'GB',
};

const STATUS_META: Record<ProxyOrderStatus, { label: string; tone: BadgeTone }> = {
  quoted: { label: '待确认', tone: 'accent' },
  ordering: { label: '下单中', tone: 'caution' },
  awaiting_payment: { label: '待支付', tone: 'caution' },
  paid: { label: '已支付', tone: 'positive' },
  fulfilled: { label: '已入库', tone: 'positive' },
  failed: { label: '失败', tone: 'critical' },
  unknown: { label: '结果不明', tone: 'critical' },
  expired: { label: '报价过期', tone: 'neutral' },
  cancelled: { label: '已取消', tone: 'neutral' },
  abandoned: { label: '已放弃', tone: 'neutral' },
};

export const ORDER_STATUS_OPTIONS = (Object.keys(STATUS_META) as ProxyOrderStatus[]).map((value) => ({
  value,
  label: STATUS_META[value].label,
}));

export function OrderStatusBadge({ status }: { status: ProxyOrderStatus }) {
  const meta = STATUS_META[status] ?? { label: status, tone: 'neutral' as const };
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

/** 可能已在 1024 产生订单、尚未支付或结果不明：界面必须醒目提示 */
export function orderMaybeCharged(order: Pick<ProxyOrderView, 'status'>): boolean {
  return order.status === 'unknown' || order.status === 'awaiting_payment' || order.status === 'ordering';
}

/** 订单仍在推进、需要轮询的状态 */
export const ORDER_IN_FLIGHT: readonly ProxyOrderStatus[] = ['ordering', 'awaiting_payment', 'paid', 'unknown'];

export const WARNING_LABELS: Record<ProxyOrderWarning, string> = {
  payment_manual: '需在 1024 结算页手动完成支付',
  maybe_charged: '可能已产生订单',
  actual_exceeds_estimate: '实付金额高于确认时的估价',
  checkout_url_unreadable: '结算链接无法读取（密钥已更换）',
};

export interface OrderLineItem {
  key: string;
  label: string;
  quantity: number;
  unit: string;
  /** 目录单价（美分）；目录里找不到时为 null */
  unitCents: number | null;
  subtotalCents: number | null;
}

/** "KR-30-2,US-30-5" → [{country:'KR',days:30,count:2}, …] */
export function parseStaticOrderSpec(spec: string): { country: string; days: number; count: number }[] {
  return spec
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [country = '', days = '0', count = '0'] = part.split('-');
      return { country, days: Number(days), count: Number(count) };
    })
    .filter((row) => row.country && Number.isFinite(row.days) && Number.isFinite(row.count));
}

/** 逐项明细（按目录单价，未含批量折扣）；总价以服务端报价 estimateCents 为准 */
export function orderLineItems(
  order: Pick<ProxyOrderView, 'product' | 'sku' | 'quantity' | 'orderSpec'>,
  catalogue: Proxy1024Catalogue | undefined,
): OrderLineItem[] {
  const items = catalogue?.items ?? [];
  if (order.product === 'static_isp') {
    return parseStaticOrderSpec(order.orderSpec).map((row, index) => {
      const match = items.find((i) => i.product === 'static_isp' && i.country === row.country && i.days === row.days);
      const unitCents = match?.unitPriceCents ?? null;
      return {
        key: `${row.country}-${row.days}-${index}`,
        label: `${row.country} · ${row.days} 天`,
        quantity: row.count,
        unit: QUANTITY_UNITS.static_isp,
        unitCents,
        subtotalCents: unitCents === null ? null : unitCents * row.count,
      };
    });
  }
  const match = items.find((i) => i.product === order.product && i.sku === order.sku);
  const unitCents = match?.unitPriceCents ?? null;
  return [
    {
      key: order.sku || order.product,
      label: match?.label || `${PRODUCT_LABELS[order.product]} ${order.sku}`.trim(),
      quantity: order.quantity,
      unit: QUANTITY_UNITS[order.product],
      unitCents,
      subtotalCents: unitCents === null ? null : unitCents * order.quantity,
    },
  ];
}

export { money } from '../shared/vendor-ui';
