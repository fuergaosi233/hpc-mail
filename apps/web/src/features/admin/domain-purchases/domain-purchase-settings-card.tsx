import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { queryKeys } from '@/api/query-keys';
import { QueryErrorState } from '@/components/query-error-state';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { domainPurchaseApi } from './domain-purchases-api';
import { RegistrantContactDialog } from './registrant-contact-dialog';
import { errorMessage, Field, IntField, MoneyField, NativeSelect, Panel, SecretField, ToggleField, useVendorSettings } from '../shared/vendor-ui';

/** settings.spaceship：只 PUT 这一个 key；API Key/Secret 回显掩码 */
export function DomainPurchaseSettingsCard() {
  const queryClient = useQueryClient();
  const [contactOpen, setContactOpen] = useState(false);
  const { query, saved, draft, patch, save, dirty, reset } = useVendorSettings('spaceship', () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.admin.domainPurchaseStatus });
  });
  const test = useMutation({ mutationFn: () => domainPurchaseApi.testCredentials() });

  if (query.isPending) return <Skeleton className="h-64 w-full rounded-lg" />;
  if (query.isError) return <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (!draft) return null;

  return (
    <Panel title="配置" description="Spaceship API 凭据与采购上限。上限为 0 时禁止采购；测试凭据只做只读调用。">
      <ToggleField
        label="启用域名采购"
        description="关闭时不调用 Spaceship，定时推进也会跳过。"
        checked={draft.enabled}
        onChange={(value) => patch((s) => void (s.enabled = value))}
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <SecretField label="API Key" value={draft.apiKey} saved={saved?.apiKey} onChange={(value) => patch((s) => void (s.apiKey = value))} />
        <SecretField
          label="API Secret"
          value={draft.apiSecret}
          saved={saved?.apiSecret}
          onChange={(value) => patch((s) => void (s.apiSecret = value))}
        />
        <Field label="注册人联系人 ID" hint="可直接填 Spaceship 联系人 ID，或点「填写联系人」创建">
          {(id) => (
            <div className="flex gap-2">
              <Input id={id} value={draft.registrantContactId} maxLength={32} onChange={(e) => patch((s) => void (s.registrantContactId = e.target.value.trim()))} />
              <Button type="button" variant="secondary" onClick={() => setContactOpen(true)}>
                填写联系人
              </Button>
            </div>
          )}
        </Field>
        <Field label="收件 Worker 名称" hint="新域名 catch-all 的目标 Worker；k3s 部署为独立的收件 Worker。留空则用部署环境显式配置的值">
          {(id) => (
            <Input
              id={id}
              value={draft.ingressWorkerName}
              maxLength={63}
              placeholder="hpc-mail-ingress-…"
              onChange={(e) => patch((s) => void (s.ingressWorkerName = e.target.value.trim()))}
            />
          )}
        </Field>
        <IntField label="注册年限" value={draft.years} min={1} max={10} onChange={(value) => patch((s) => void (s.years = value))} />
        <Field label="隐私保护">
          {(id) => (
            <NativeSelect id={id} value={draft.privacyLevel} onChange={(e) => patch((s) => void (s.privacyLevel = e.target.value as 'public' | 'high'))}>
              <option value="high">高（隐藏注册人信息）</option>
              <option value="public">公开</option>
            </NativeSelect>
          )}
        </Field>
        <ToggleField label="自动续费" checked={draft.autoRenew} onChange={(value) => patch((s) => void (s.autoRenew = value))} />
        <ToggleField
          label="允许溢价域名"
          description="关闭时报价自动跳过 premium 域名"
          checked={draft.allowPremium}
          onChange={(value) => patch((s) => void (s.allowPremium = value))}
        />
        <MoneyField
          label="单域名上限"
          hint="按 max(实价, 常规价) × 年限比较；0 = 禁止采购"
          cents={draft.maxDomainCents}
          maxCents={1_000_000}
          onChange={(value) => patch((s) => void (s.maxDomainCents = value))}
        />
        <MoneyField label="单批次上限" hint="0 = 禁止采购" cents={draft.maxBatchCents} maxCents={10_000_000} onChange={(value) => patch((s) => void (s.maxBatchCents = value))} />
        <MoneyField
          label="24 小时滚动上限"
          hint="按本站采购台账统计；0 = 禁止采购"
          cents={draft.maxDailyCents}
          maxCents={10_000_000}
          onChange={(value) => patch((s) => void (s.maxDailyCents = value))}
        />
        <IntField label="每批最多域名数" value={draft.maxBatchDomains} min={1} max={100} onChange={(value) => patch((s) => void (s.maxBatchDomains = value))} />
        <IntField label="报价有效期（分钟）" value={draft.quoteTtlMinutes} min={1} max={60} onChange={(value) => patch((s) => void (s.quoteTtlMinutes = value))} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm">
          <Button type="button" variant="secondary" size="sm" loading={test.isPending} disabled={dirty} onClick={() => test.mutate()}>
            测试凭据
          </Button>
          {dirty && <span className="text-xs text-ink-tertiary">保存后才能测试</span>}
          {!dirty && test.isSuccess && (
            <span role="status" className="text-positive">
              凭据有效 · 账户内 {test.data.domainCount} 个域名
            </span>
          )}
          {!dirty && test.isError && (
            <span role="alert" className="text-critical">
              {errorMessage(test.error, '凭据无效')}
            </span>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" disabled={!dirty || save.isPending} onClick={reset}>
            撤销
          </Button>
          <Button disabled={!dirty} loading={save.isPending} onClick={() => save.mutate(draft)}>
            保存配置
          </Button>
        </div>
      </div>
      <RegistrantContactDialog open={contactOpen} onClose={() => setContactOpen(false)} />
    </Panel>
  );
}
