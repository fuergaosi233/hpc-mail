import { useQuery } from '@tanstack/react-query';
import type { Mailbox } from '@hpc-mail/shared';
import { queryKeys } from '@/api/query-keys';
import { adminApi } from '@/api/resources';
import { QueryErrorState } from '@/components/query-error-state';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { MailboxShareDialog } from '@/features/mailboxes/mailbox-share-dialog';

export function AddressShareDialog({ mailbox, onClose }: { mailbox: Mailbox; onClose: () => void }) {
  // 只读这一个邮箱的共享名单（0 或 1 项），不拉全站
  const shares = useQuery({
    queryKey: queryKeys.admin.mailboxSharesOf(mailbox.id),
    queryFn: () => adminApi.listMailboxShares(mailbox.id),
  });
  const grant = shares.data?.find((item) => item.mailboxId === mailbox.id);
  // 缓存可能早于过户、释放等写操作：后台刷新完成前不进入编辑，免得拿旧名单覆盖
  const ready = shares.isSuccess && !shares.isRefetching;

  if (ready && grant) {
    return <MailboxShareDialog grant={grant} grants={[grant]} onClose={onClose} />;
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader title="共享邮箱" description={mailbox.address} />
        <DialogBody>
          {shares.isError ? (
            <QueryErrorState error={shares.error} onRetry={() => void shares.refetch()} />
          ) : ready ? (
            <p className="text-sm text-critical">该邮箱已释放或不存在，请关闭并刷新地址列表。</p>
          ) : (
            <p role="status" className="text-sm text-ink-secondary">正在加载共享名单…</p>
          )}
        </DialogBody>
        <DialogFooter><Button variant="secondary" onClick={onClose}>关闭</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
