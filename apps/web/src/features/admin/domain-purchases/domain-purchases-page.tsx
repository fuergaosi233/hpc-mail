import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/api/query-keys';
import { adminApi } from '@/api/resources';
import { PageHeader } from '@/components/page-header';
import { DomainBatchesTable } from './domain-batches-table';
import { DomainPurchaseSettingsCard } from './domain-purchase-settings-card';
import { DomainPurchaseStatusCard, useDomainPurchaseStatus } from './domain-purchase-status-card';
import { DomainQuoteForm } from './domain-quote-form';
import { Panel } from '../shared/vendor-ui';

/** Spaceship 批量采购域名：报价 → 确认 → 逐个注册并自动开通收件 */
export function DomainPurchasesPage() {
  const status = useDomainPurchaseStatus();
  const settings = useQuery({ queryKey: queryKeys.admin.settings, queryFn: () => adminApi.getSettings() });
  const spaceship = settings.data?.spaceship;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <PageHeader title="域名采购" description="通过 Spaceship 批量购买域名，注册后自动接入 Cloudflare 收件并加入系统域名列表。" />
      <DomainPurchaseStatusCard />
      <DomainQuoteForm
        disabled={!status.data?.purchasingAllowed}
        maxBatchDomains={status.data?.caps.maxBatchDomains ?? spaceship?.maxBatchDomains ?? 20}
        defaultYears={spaceship?.years ?? 1}
      />
      <Panel title="采购批次">
        <DomainBatchesTable />
      </Panel>
      <DomainPurchaseSettingsCard />
    </div>
  );
}
