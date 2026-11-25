import type { DomainBatchStatus, DomainItemStatus, DomainPurchaseItemView, DomainSkipReason } from '@hpc-mail/shared';
import { Badge, type BadgeTone } from '@/components/ui/badge';

const BATCH_META: Record<DomainBatchStatus, { label: string; tone: BadgeTone }> = {
  quoted: { label: '待确认', tone: 'accent' },
  confirming: { label: '确认中', tone: 'caution' },
  processing: { label: '处理中', tone: 'caution' },
  completed: { label: '已完成', tone: 'positive' },
  expired: { label: '报价过期', tone: 'neutral' },
  cancelled: { label: '已取消', tone: 'neutral' },
};

export const BATCH_STATUS_OPTIONS = (Object.keys(BATCH_META) as DomainBatchStatus[]).map((value) => ({
  value,
  label: BATCH_META[value].label,
}));

export function BatchStatusBadge({ status }: { status: DomainBatchStatus }) {
  const meta = BATCH_META[status] ?? { label: status, tone: 'neutral' as const };
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

const ITEM_META: Record<DomainItemStatus, { label: string; tone: BadgeTone }> = {
  quoted: { label: '可购买', tone: 'accent' },
  skipped: { label: '已跳过', tone: 'neutral' },
  confirmed: { label: '排队注册', tone: 'caution' },
  registering: { label: '注册中', tone: 'caution' },
  registered: { label: '已注册', tone: 'caution' },
  zone_created: { label: '已建 zone', tone: 'caution' },
  ns_set: { label: '已改 NS', tone: 'caution' },
  zone_active: { label: 'zone 已生效', tone: 'caution' },
  routing_ready: { label: '收件已配置', tone: 'caution' },
  domain_added: { label: '可收件', tone: 'positive' },
  failed: { label: '失败', tone: 'critical' },
  unknown: { label: '注册结果不明', tone: 'critical' },
  cancelled: { label: '已取消', tone: 'neutral' },
};

export function ItemStatusBadge({ status }: { status: DomainItemStatus }) {
  const meta = ITEM_META[status] ?? { label: status, tone: 'neutral' as const };
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

/** 覆盖 DOMAIN_SKIP_REASONS 全部取值；未知值由调用方回退显示原文 */
export const SKIP_REASON_LABELS: Record<DomainSkipReason, string> & Record<string, string> = {
  taken: '已被注册',
  premium: '溢价域名（未允许购买溢价）',
  over_domain_cap: '超过单域名上限',
  already_listed: '已在系统域名列表',
  hosted: '已被用户托管',
  has_history: '本站有该域历史地址或邮件',
  in_flight: '另一批次正在采购',
  duplicate: '重复',
  not_selected: '确认时未选中',
  invalid: '域名格式非法',
  invalidDomainName: '域名格式非法',
  tldNotSupported: '不支持该后缀',
  unexpectedError: '查询出错',
  no_price: '无可用注册价',
};

export const STEP_LABELS: Record<string, string> = {
  register: '注册',
  poll: '注册结果',
  zone: '创建 Cloudflare zone',
  nameservers: '设置 NS',
  routing: '开启 Email Routing',
  catch_all: '配置 catch-all',
  domain_add: '加入系统域名',
};

/** 从确认到可收件的推进顺序（步进条） */
export const PROGRESS_STEPS: { status: DomainItemStatus; label: string }[] = [
  { status: 'confirmed', label: '排队' },
  { status: 'registering', label: '注册' },
  { status: 'registered', label: '已注册' },
  { status: 'zone_created', label: '建 zone' },
  { status: 'ns_set', label: '改 NS' },
  { status: 'zone_active', label: 'zone 生效' },
  { status: 'routing_ready', label: '收件路由' },
  { status: 'domain_added', label: '可收件' },
];

/** 失败步骤对应的进度位置（失败时停在该步） */
const STEP_TO_STATUS: Record<string, DomainItemStatus> = {
  register: 'registering',
  poll: 'registering',
  zone: 'zone_created',
  nameservers: 'ns_set',
  routing: 'routing_ready',
  catch_all: 'routing_ready',
  domain_add: 'domain_added',
};

/** 当前所在步骤下标；未进入流程（quoted/skipped/cancelled）为 -1 */
export function progressIndex(item: Pick<DomainPurchaseItemView, 'status' | 'failedStep'>): number {
  if (item.status === 'failed') {
    const at = STEP_TO_STATUS[item.failedStep];
    return at ? PROGRESS_STEPS.findIndex((s) => s.status === at) : 0;
  }
  if (item.status === 'unknown') return PROGRESS_STEPS.findIndex((s) => s.status === 'registering');
  return PROGRESS_STEPS.findIndex((s) => s.status === item.status);
}

/** 批次仍在推进、需要轮询 */
export const BATCH_IN_FLIGHT: readonly DomainBatchStatus[] = ['confirming', 'processing'];

/** 拆分粘贴的域名：空白/逗号/分号分隔、去空、去重（仅用于前端计数，规范化以服务端为准） */
export function splitDomains(text: string): string[] {
  return [...new Set(text.split(/[\s,;，；]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];
}
