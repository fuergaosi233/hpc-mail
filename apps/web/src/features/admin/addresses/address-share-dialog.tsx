import { useQuery } from '@tanstack/react-query';
import type { Mailbox } from '@hpc-mail/shared';
import { queryKeys } from '@/api/query-keys';
import { adminApi } from '@/api/resources';
import { QueryErrorState } from '@/components/query-error-state';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { MailboxShareDialog } from '@/features/mailboxes/mailbox-share-dialog';

export function AddressShareDialog({ mailbox, onClose }: { mailbox: Mailbox; onClose: () => void }) {
  const shares = useQuery({
    queryKey: queryKeys.admin.mailboxShares,
    queryFn: () => adminApi.listMailboxShares(),
  });
  const grant = shares.data?.find((item) => item.mailboxId === mailbox.id);

  if (shares.isSuccess && grant) {
    return <MailboxShareDialog grant={grant} grants={[grant]} onClose={onClose} />;
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader title="共享邮箱" description={mailbox.address} />
        <DialogBody>
          {shares.isError ? (
            <QueryErrorState error={shares.error} onRetry={() => void shares.refetch()} />
          ) : shares.isSuccess ? (
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
