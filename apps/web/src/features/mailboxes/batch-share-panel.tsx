import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { AdminUser } from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';
import { invalidateMailboxOwnership, queryKeys } from '@/api/query-keys';
import { adminApi, mailboxApi } from '@/api/resources';
import { QueryErrorState } from '@/components/query-error-state';
import { Button } from '@/components/ui/button';
import { DialogBody, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';

/** 一次最多选多少人，与后端每只邮箱的共享名单上限一致 */
const MAX_SHARE_USERS = 100;
const BATCH_SHARE_MUTATION = ['mailboxes', 'shares', 'batch'] as const;

/** 批量共享请求进行中：所在弹窗据此禁止关闭 */
export const useBatchSharePending = () => useIsMutating({ mutationKey: BATCH_SHARE_MUTATION }) > 0;

/** toast 标题里名单太长时只列前几位 */
function nameSummary(names: string[]): string {
  return names.length <= 3 ? names.join('、') : `${names.slice(0, 3).join('、')} 等 ${names.length} 人`;
}

export interface BatchSharePanelProps {
  /** 要共享的邮箱（刚认领成功的那些），须属于当前用户 */
  mailboxIds: number[];
  /** 当前用户 id：不能共享给自己，从候选中排除 */
  currentUserId: number;
  onBack: () => void;
  /** 共享成功，带回这次共享的用户名 */
  onShared: (usernames: string[]) => void;
}

/**
 * 管理员把一批自己的邮箱一次共享给选中的用户：追加到各邮箱名单，不移除已有成员。
 * 渲染为对话框的标题、正文与底栏，由所在弹窗切换步骤，不再叠一层对话框。
 */
export function BatchSharePanel({ mailboxIds, currentUserId, onBack, onShared }: BatchSharePanelProps) {
  const queryClient = useQueryClient();
  const [userQuery, setUserQuery] = useState('');
  const [selected, setSelected] = useState<number[]>([]);
  const users = useQuery({ queryKey: queryKeys.admin.users, queryFn: () => adminApi.listUsers() });

  // 只列启用中的用户、排除自己；名单刷新后失效的人随之移出已选
  const candidates = (users.data ?? []).filter((user) => user.status === 'active' && user.id !== currentUserId);
  const chosen = candidates.filter((user) => selected.includes(user.id));
  const term = userQuery.trim().toLowerCase();
  const visible = candidates.filter((user) => selected.includes(user.id) || user.username.toLowerCase().includes(term));

  const share = useMutation({
    mutationKey: BATCH_SHARE_MUTATION,
    mutationFn: (targets: AdminUser[]) => mailboxApi.batchShare({ mailboxIds, userIds: targets.map((user) => user.id) }),
    onSuccess: (_grants, targets) => {
      const names = targets.map((user) => user.username);
      toast({ title: `已将 ${mailboxIds.length} 个邮箱共享给 ${nameSummary(names)}`, variant: 'success' });
      invalidateMailboxOwnership(queryClient);
      onShared(names);
    },
    onError: (error) => {
      // 期间邮箱被过户、释放或用户被禁用，整单未写入：刷新归属与用户名单后可重选
      if (error instanceof ApiError && error.code === 'conflict') invalidateMailboxOwnership(queryClient);
    },
  });
  const pending = share.isPending;

  const toggle = (userId: number) =>
    setSelected((prev) => (prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId]));

  return (
    <>
      <DialogHeader
        title={`把刚认领的 ${mailboxIds.length} 个邮箱共享给…`}
        description="成员可只读查看这些邮箱的全部来信、验证码及附件，已读状态仍由你管理；共享不授予发信、删除权限，也不触发成员通知。"
      />
      <DialogBody className="flex flex-col gap-3">
        <Input
          aria-label="搜索共享用户"
          autoFocus
          disabled={pending}
          maxLength={32}
          value={userQuery}
          onChange={(event) => setUserQuery(event.target.value)}
          placeholder="搜索用户名"
        />
        <div className="max-h-64 overflow-y-auto rounded-md border border-line">
          {users.isLoading ? (
            <p className="px-3 py-4 text-sm text-ink-tertiary">正在加载用户…</p>
          ) : users.isError ? (
            <QueryErrorState error={users.error} onRetry={() => void users.refetch()} />
          ) : visible.length === 0 ? (
            <p className="px-3 py-4 text-sm text-ink-tertiary">没有匹配的启用用户</p>
          ) : (
            visible.map((user) => (
              <label
                key={user.id}
                className="flex cursor-pointer items-center gap-2 border-b border-line px-3 py-2 text-sm last:border-b-0 hover:bg-surface-hover"
              >
                <input
                  type="checkbox"
                  className="size-4 accent-accent"
                  disabled={pending || (!selected.includes(user.id) && chosen.length >= MAX_SHARE_USERS)}
                  checked={selected.includes(user.id)}
                  onChange={() => toggle(user.id)}
                />
                <span className="text-ink">{user.username}</span>
              </label>
            ))
          )}
        </div>
        <p className="text-xs text-ink-tertiary">已选 {chosen.length}/{MAX_SHARE_USERS} 人，已有的共享成员会保留。</p>
        {share.isError && (
          <p role="alert" className="text-sm text-critical">
            {share.error instanceof ApiError ? share.error.message : '共享失败，请重试'}
          </p>
        )}
      </DialogBody>
      <DialogFooter className="flex-wrap">
        <Button type="button" variant="secondary" disabled={pending} onClick={onBack}>
          返回
        </Button>
        <Button type="button" loading={pending} disabled={chosen.length === 0} onClick={() => share.mutate(chosen)}>
          共享 {mailboxIds.length} 个邮箱
        </Button>
      </DialogFooter>
    </>
  );
}
