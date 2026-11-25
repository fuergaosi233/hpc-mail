import type { ProxyHealth, ProxyStatus, ProxyView } from '@hpc-mail/shared';
import { formatProxyHost } from '@hpc-mail/shared';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { formatDateTime } from '@/lib/format';

const STATUS_META: Record<ProxyStatus, { label: string; tone: BadgeTone }> = {
  active: { label: '可用', tone: 'positive' },
  disabled: { label: '已停用', tone: 'neutral' },
  expired: { label: '已过期', tone: 'critical' },
};

export const PROXY_STATUS_OPTIONS = (Object.keys(STATUS_META) as ProxyStatus[]).map((value) => ({
  value,
  label: STATUS_META[value].label,
}));

export function ProxyStatusBadge({ status }: { status: ProxyStatus }) {
  const meta = STATUS_META[status] ?? { label: status, tone: 'neutral' as const };
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

export function ProxyHealthBadge({ health }: { health: ProxyHealth }) {
  const title = [
    health.checkedAt ? `上报于 ${formatDateTime(health.checkedAt)}` : '',
    health.latencyMs !== null ? `延迟 ${health.latencyMs} ms` : '',
    health.error,
  ]
    .filter(Boolean)
    .join(' · ');
  if (health.status === 'ok') {
    return (
      <Badge tone="positive" title={title || undefined}>
        正常{health.latencyMs !== null ? ` ${health.latencyMs}ms` : ''}
      </Badge>
    );
  }
  if (health.status === 'fail') {
    return (
      <Badge tone="critical" title={title || undefined}>
        异常
      </Badge>
    );
  }
  return <Badge title="由自动化或管理员上报，服务端不主动探测">未检测</Badge>;
}

/** 列表里显示的端点：protocol://host:port（不含凭据） */
export function proxyEndpoint(proxy: Pick<ProxyView, 'protocol' | 'host' | 'port'>): string {
  return `${proxy.protocol}://${formatProxyHost(proxy.host)}:${proxy.port}`;
}

export function proxyTitle(proxy: Pick<ProxyView, 'label' | 'protocol' | 'host' | 'port'>): string {
  return proxy.label || proxyEndpoint(proxy);
}

export function proxyLocation(proxy: Pick<ProxyView, 'country' | 'city'>): string {
  return [proxy.country, proxy.city].filter(Boolean).join(' · ') || '—';
}

/** active 且未过期、未满 */
export function proxyHasCapacity(proxy: ProxyView, now = Date.now()): boolean {
  if (proxy.status !== 'active') return false;
  if (proxy.expiresAt && new Date(proxy.expiresAt).getTime() <= now) return false;
  return proxy.bindingCount < proxy.maxBindings;
}
