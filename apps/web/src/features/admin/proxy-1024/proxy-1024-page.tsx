import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Proxy1024QuoteForm } from './proxy-1024-quote-form';
import { Proxy1024SettingsCard } from './proxy-1024-settings-card';
import { Proxy1024StatusCard, useProxy1024Status } from './proxy-1024-status-card';
import { ProxyOrderConfirmDialog } from './proxy-order-confirm-dialog';
import { ProxyOrdersTable } from './proxy-orders-table';
import { StickyGenerateDialog } from './sticky-generate-dialog';
import { Panel } from '../shared/vendor-ui';

/** 1024proxy 采购：报价 → 管理员确认（下单）→ 在 1024 结算页手动支付 → 对账入库到代理池 */
export function Proxy1024Page() {
  const status = useProxy1024Status();
  const [confirming, setConfirming] = useState<number | null>(null);
  const [stickyOpen, setStickyOpen] = useState(false);
  const purchasingAllowed = status.data?.purchasingAllowed ?? false;
  const sessionOk = status.data?.enabled === true && status.data.session === 'ok';

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <PageHeader
        title="1024 购买"
        description="通过 1024proxy 控制台采购代理，支付后自动同步进代理池。所有下单都需管理员逐笔确认。"
        actions={
          <Button variant="secondary" disabled={!sessionOk} onClick={() => setStickyOpen(true)}>
            <Sparkles className="size-4" />
            生成粘性代理
          </Button>
        }
      />
      <Proxy1024StatusCard />
      <Proxy1024QuoteForm disabled={!purchasingAllowed} onQuoted={(order) => setConfirming(order.id)} />
      <Panel title="订单">
        <ProxyOrdersTable onConfirm={setConfirming} />
      </Panel>
      <Proxy1024SettingsCard />

      <ProxyOrderConfirmDialog orderId={confirming} onClose={() => setConfirming(null)} />
      <StickyGenerateDialog open={stickyOpen} onClose={() => setStickyOpen(false)} />
    </div>
  );
}
