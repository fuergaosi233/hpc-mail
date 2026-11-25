import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/api/query-keys';
import { QueryErrorState } from '@/components/query-error-state';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { domainPurchaseApi } from './domain-purchases-api';
import { InfoItem, money, Panel } from '../shared/vendor-ui';

export function useDomainPurchaseStatus() {
  return useQuery({ queryKey: queryKeys.admin.domainPurchaseStatus, queryFn: () => domainPurchaseApi.status(), staleTime: 30_000 });
}

export function DomainPurchaseStatusCard() {
  const status = useDomainPurchaseStatus();
  if (status.isPending) return <Skeleton className="h-36 w-full rounded-lg" />;
  if (status.isError) return <QueryErrorState error={status.error} onRetry={() => void status.refetch()} />;
  const s = status.data;
  const { caps, systemDomains } = s;
  return (
    <Panel title="运行状态">
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <InfoItem label="功能">
          <Badge tone={s.enabled ? 'positive' : 'neutral'}>{s.enabled ? '已启用' : '未启用'}</Badge>
        </InfoItem>
        <InfoItem label="Spaceship 凭据与联系人">
          <Badge tone={s.configured ? 'positive' : 'caution'}>{s.configured ? '已配置' : '未配置'}</Badge>
        </InfoItem>
        <InfoItem label="Cloudflare 凭据">
          <Badge tone={s.cloudflareConfigured ? 'positive' : 'caution'}>{s.cloudflareConfigured ? '已配置' : '未配置'}</Badge>
        </InfoItem>
        <InfoItem label="收件 Worker">
          {s.ingressWorker ? (
            <>
              <code className="text-[13px]">{s.ingressWorker}</code>
              <span className="text-xs text-ink-tertiary">{s.ingressWorkerSource === 'setting' ? '（本页配置）' : '（部署环境）'}</span>
            </>
          ) : (
            <Badge tone="caution">未配置</Badge>
          )}
        </InfoItem>
        <InfoItem label="系统域名名额">
          <span className="tabular-nums">
            已用 {systemDomains.used} · 采购中 {systemDomains.inFlight} · 上限 {systemDomains.max}
          </span>
        </InfoItem>
        <InfoItem label="24 小时已用 / 上限">
          <span className="tabular-nums">
            {money(caps.spentLast24hCents)} / {money(caps.maxDailyCents)}
          </span>
        </InfoItem>
        <InfoItem label="单域名 / 单批次上限">
          <span className="tabular-nums">
            {money(caps.maxDomainCents)} / {money(caps.maxBatchCents)}
          </span>
        </InfoItem>
        <InfoItem label="采购">
          <Badge tone={s.purchasingAllowed ? 'positive' : 'caution'}>{s.purchasingAllowed ? '允许' : '不可用'}</Badge>
        </InfoItem>
      </dl>
      {!s.purchasingAllowed && s.reasons.length > 0 && (
        <ul aria-label="不可采购原因" className="list-disc pl-5 text-[13px] text-caution">
          {s.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
      <p className="text-xs text-ink-tertiary">
        注册成功后自动：建 Cloudflare zone → 把 Spaceship NS 改为 Cloudflare 分配的 NS → 开启 Email Routing 与 catch-all（指向收件 Worker）→ 加入系统域名列表。注册结果不明的域名不会自动重新注册。
      </p>
    </Panel>
  );
}
