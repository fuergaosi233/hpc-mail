import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { Mailbox, MailboxShareGrant } from '@hpc-mail/shared';
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
  // 打开时等首次结果；打开那一刻缓存已过期（如刚过户、释放）则等这次刷新完成，免得拿旧名单编辑
  const settled = shares.isSuccess && !shares.isFetching;
  // 进入编辑后固定用这份名单：之后的后台刷新不卸载、不改写编辑中的弹窗，
  // 期间归属若有变化，保存时由 expectedOwnerId 与 409 兜底
  const [editing, setEditing] = useState<MailboxShareGrant | null>(null);
  if (!editing && settled && grant) setEditing(grant);
  const current = editing ?? (settled ? grant : undefined);

  if (current) {
    return <MailboxShareDialog grant={current} grants={[current]} onClose={onClose} />;
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader title="共享邮箱" description={mailbox.address} />
        <DialogBody>
          {shares.isError ? (
            <QueryErrorState error={shares.error} onRetry={() => void shares.refetch()} />
          ) : settled ? (
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
