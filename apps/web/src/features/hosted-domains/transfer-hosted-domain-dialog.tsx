import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { HostedDomain, UserSearchResult } from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';
import { invalidateMailboxOwnership, queryKeys } from '@/api/query-keys';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { hostedDomainApi } from './hosted-domains-api';
import { forgetHostedDomain, storeHostedDomain } from './use-hosted-domains';
import { UserSearch } from './user-search';

export function TransferHostedDomainDialog({
  domain,
  open,
  onOpenChange,
}: {
  domain: HostedDomain;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [target, setTarget] = useState<UserSearchResult | null>(null);
  const [includeMailboxes, setIncludeMailboxes] = useState(true);
  const [confirmText, setConfirmText] = useState('');

  useEffect(() => {
    if (!open) return;
    setTarget(null);
    setIncludeMailboxes(true);
    setConfirmText('');
  }, [open]);

  const confirmed = confirmText.trim().toLowerCase() === domain.domain;
  const self = domain.role === 'owner';

  const transfer = useMutation({
    mutationFn: (user: UserSearchResult) =>
      hostedDomainApi.transfer(domain.id, { userId: user.id, expectedOwnerId: domain.ownerUserId, includeMailboxes }),
    onSuccess: (result, user) => {
      toast({
        title: result.transferred
          ? `已过户给 ${user.username}${result.movedMailboxes > 0 ? `，随同过户 ${result.movedMailboxes} 个地址` : ''}`
          : '域名已属于目标用户',
        variant: 'success',
      });
      // 地址随域名过户时，邮件可见性与邮箱列表都会变化
      invalidateMailboxOwnership(queryClient);
      onOpenChange(false);
      // 过户后不再有权限查看（原所有者且不是管理员或成员）时服务端返回 null
      if (!result.domain) {
        navigate('/domains', { replace: true });
        forgetHostedDomain(queryClient, domain.id);
        return;
      }
      storeHostedDomain(queryClient, result.domain);
      // 详情已是最新；成员名单（新所有者不再是成员）与「我的域名」列表随之变化
      void queryClient.invalidateQueries({ queryKey: queryKeys.hostedDomains.members(domain.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.hostedDomains.list });
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.hostedDomains });
    },
    onError: (error) => {
      toast({ title: error instanceof ApiError ? error.message : '过户失败，请重试', variant: 'error' });
      if (error instanceof ApiError && error.code === 'conflict') {
        void queryClient.invalidateQueries({ queryKey: queryKeys.hostedDomains.root });
        onOpenChange(false);
      }
    },
  });

  return (
    <Dialog open={open} onOpenChange={(next) => !transfer.isPending && onOpenChange(next)}>
      <DialogContent className="max-w-md">
        <DialogHeader title="过户域名" description={domain.domain} />
        <DialogBody className="flex flex-col gap-4">
          <p className="text-sm text-ink-secondary">
            当前所有者：<b className="text-ink">{domain.ownerUsername}</b>。过户后目标用户成为所有者，获得该域名的全部管理权限，
            此后未认领地址的来信归新所有者。
          </p>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-ink">
              目标用户
              <span className="ml-0.5 text-critical">*</span>
            </span>
            {target ? (
              <div className="flex items-center justify-between gap-3 rounded-md border border-line bg-canvas px-3 py-2">
                <span className="flex min-w-0 items-center gap-1 text-sm text-accent">
                  <Check className="size-4 shrink-0" />
                  <span className="truncate">
                    已选择：{target.username}
                    {target.role === 'admin' ? '（管理员）' : ''}
                  </span>
                </span>
                <Button size="sm" variant="ghost" disabled={transfer.isPending} onClick={() => setTarget(null)}>
                  重新选择
                </Button>
              </div>
            ) : (
              <UserSearch
                label="搜索目标用户"
                actionLabel="选择"
                autoFocus
                excludeUserId={domain.ownerUserId}
                onPick={setTarget}
              />
            )}
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-accent"
              checked={includeMailboxes}
              disabled={transfer.isPending}
              onChange={(event) => setIncludeMailboxes(event.target.checked)}
            />
            <span className="flex flex-col gap-0.5">
              <span className="text-ink">
                {self ? '连同我' : `连同 ${domain.ownerUsername} `}在该域名下的地址及其历史邮件一起过户
              </span>
              <span className="text-xs text-ink-tertiary">不勾选时，这些地址仍归原所有者。</span>
            </span>
          </label>
          <FormField label={`输入 ${domain.domain} 确认过户`}>
            {(field) => (
              <Input
                {...field}
                autoComplete="off"
                placeholder={domain.domain}
                value={confirmText}
                disabled={transfer.isPending}
                onChange={(event) => setConfirmText(event.target.value)}
              />
            )}
          </FormField>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" disabled={transfer.isPending} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            loading={transfer.isPending}
            disabled={!target || !confirmed}
            onClick={() => target && transfer.mutate(target)}
          >
            确认过户
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
