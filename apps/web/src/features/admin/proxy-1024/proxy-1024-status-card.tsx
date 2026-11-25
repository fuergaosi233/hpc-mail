import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LogIn, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import type { Proxy1024SessionState } from '@hpc-mail/shared';
import { queryKeys } from '@/api/query-keys';
import { QueryErrorState } from '@/components/query-error-state';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { formatDateTime } from '@/lib/format';
import { money } from './order-meta';
import { proxy1024Api } from './proxy-1024-api';
import { SlideCaptchaDialog } from './slide-captcha-dialog';
import { SyncInventoryButton } from './sync-inventory-button';
import { errorMessage, InfoItem, Panel } from '../shared/vendor-ui';

const SESSION_META: Record<Proxy1024SessionState, { label: string; tone: BadgeTone }> = {
  ok: { label: '有效', tone: 'positive' },
  missing: { label: '未登录', tone: 'caution' },
  invalid: { label: '已失效', tone: 'critical' },
  error: { label: '检查出错', tone: 'critical' },
  unknown: { label: '未检查', tone: 'neutral' },
};

export function useProxy1024Status() {
  return useQuery({ queryKey: queryKeys.admin.proxy1024Status, queryFn: () => proxy1024Api.status(), staleTime: 30_000 });
}

export function Proxy1024StatusCard() {
  const queryClient = useQueryClient();
  const status = useProxy1024Status();
  const [loginOpen, setLoginOpen] = useState(false);
  const live = useMutation({
    mutationFn: () => proxy1024Api.status(true),
    onSuccess: (data) => queryClient.setQueryData(queryKeys.admin.proxy1024Status, data),
    onError: (err) => toast({ title: errorMessage(err, '刷新失败'), variant: 'error' }),
  });

  if (status.isPending) return <Skeleton className="h-36 w-full rounded-lg" />;
  if (status.isError) return <QueryErrorState error={status.error} onRetry={() => void status.refetch()} />;
  const s = status.data;
  const session = SESSION_META[s.session] ?? SESSION_META.unknown;
  const { caps } = s;

  return (
    <Panel
      title="运行状态"
      actions={
        <>
          <Button variant="secondary" size="sm" loading={live.isPending} disabled={!s.enabled} onClick={() => live.mutate()}>
            <RefreshCw className="size-4" />
            刷新
          </Button>
          <Button variant="secondary" size="sm" disabled={!s.enabled} onClick={() => setLoginOpen(true)}>
            <LogIn className="size-4" />
            登录 1024
          </Button>
          <SyncInventoryButton disabled={!s.enabled || s.session !== 'ok'} />
        </>
      }
    >
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <InfoItem label="功能">
          <Badge tone={s.enabled ? 'positive' : 'neutral'}>{s.enabled ? '已启用' : '未启用'}</Badge>
          {!s.configured && <Badge tone="caution">未配置完整</Badge>}
        </InfoItem>
        <InfoItem label="会话">
          <Badge tone={session.tone}>{session.label}</Badge>
          {s.email && <span className="text-ink-secondary">{s.email}</span>}
        </InfoItem>
        <InfoItem label="账户余额">{money(s.balanceCents)}</InfoItem>
        <InfoItem label="最近检查">{s.checkedAt ? formatDateTime(s.checkedAt) : '—'}</InfoItem>
        <InfoItem label="24 小时已用 / 上限">
          <span className="tabular-nums">
            {money(caps.spentLast24hCents)} / {money(caps.maxDailyCents)}
          </span>
        </InfoItem>
        <InfoItem label="单笔上限">{money(caps.maxOrderCents)}</InfoItem>
        <InfoItem label="采购">
          <Badge tone={s.purchasingAllowed ? 'positive' : 'caution'}>{s.purchasingAllowed ? '允许' : '不可用'}</Badge>
        </InfoItem>
      </dl>
      {!s.purchasingAllowed && (
        <p className="text-[13px] text-ink-secondary">采购需要：启用功能、会话有效，且单笔与每日上限都大于 0。</p>
      )}
      {s.lastError && <p className="break-words text-[13px] text-critical">{s.lastError}</p>}
      <p className="text-xs text-ink-tertiary">
        下单后需在 1024 结算页用余额手动完成支付；本站不自动付款、不自动充值。结果不明的下单不会自动重试。
      </p>
      <SlideCaptchaDialog open={loginOpen} onClose={() => setLoginOpen(false)} />
    </Panel>
  );
}
