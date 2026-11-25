import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/api/query-keys';
import { QueryErrorState } from '@/components/query-error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { adminProxyApi } from './proxies-api';
import { InfoItem } from '../shared/vendor-ui';

export function ProxyStatsCard() {
  const stats = useQuery({ queryKey: queryKeys.admin.proxyStats, queryFn: () => adminProxyApi.stats() });
  if (stats.isPending) return <Skeleton className="h-24 w-full rounded-lg" />;
  if (stats.isError) return <QueryErrorState error={stats.error} onRetry={() => void stats.refetch()} />;
  const s = stats.data;
  const providers = Object.entries(s.byProvider).sort((a, b) => b[1] - a[1]);
  return (
    <section aria-label="代理池统计" className="rounded-lg border border-line bg-surface p-5">
      <dl className="grid grid-cols-3 gap-4 sm:grid-cols-6">
        <InfoItem label="总数">{s.total}</InfoItem>
        <InfoItem label="可用">{s.active}</InfoItem>
        <InfoItem label="空闲可分配">{s.free}</InfoItem>
        <InfoItem label="已绑定">{s.bound}</InfoItem>
        <InfoItem label="已过期">{s.expired}</InfoItem>
        <InfoItem label="已停用">{s.disabled}</InfoItem>
      </dl>
      {providers.length > 0 && (
        <p className="mt-3 text-xs text-ink-tertiary">
          按供应商：{providers.map(([name, count]) => `${name} ${count}`).join(' · ')}
        </p>
      )}
    </section>
  );
}
