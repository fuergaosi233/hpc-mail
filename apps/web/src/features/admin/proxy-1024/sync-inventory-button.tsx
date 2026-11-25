import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DatabaseZap } from 'lucide-react';
import { queryKeys } from '@/api/query-keys';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { invalidateProxyData } from '../proxies/proxies-api';
import { proxy1024Api } from './proxy-1024-api';
import { errorMessage } from '../shared/vendor-ui';

/** 把 1024 账户里已有的静态 IP / 不限量服务器同步进代理池（只读调用，不花钱） */
export function SyncInventoryButton({ disabled, orderId }: { disabled?: boolean; orderId?: number }) {
  const queryClient = useQueryClient();
  const sync = useMutation({
    mutationFn: () => proxy1024Api.sync(orderId ? { orderId } : {}),
    onSuccess: (result) => {
      invalidateProxyData(queryClient);
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.proxyOrdersRoot });
      toast({ title: `同步完成：新增 ${result.created}，更新 ${result.updated}，过期 ${result.expired}`, variant: 'success' });
    },
    onError: (err) => toast({ title: errorMessage(err, '同步失败'), variant: 'error' }),
  });
  return (
    <Button variant="secondary" size="sm" disabled={disabled} loading={sync.isPending} onClick={() => sync.mutate()}>
      <DatabaseZap className="size-4" />
      同步库存
    </Button>
  );
}
