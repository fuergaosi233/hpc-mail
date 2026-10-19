import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { type AdminUser, MAX_MAILBOX_GRANTEES } from '@hpc-mail/shared';
import { ApiError, isRejectedRequest } from '@/api/errors';
import { invalidateMailboxOwnership, queryKeys } from '@/api/query-keys';
import { adminApi, mailboxApi } from '@/api/resources';
import { QueryErrorState } from '@/components/query-error-state';
import { Button } from '@/components/ui/button';
import { DialogBody, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

/** 共享步骤的对话框标题与说明，由所在弹窗的标题栏显示 */
export const batchShareTitle = (count: number) => `把刚认领的 ${count} 个邮箱共享给…`;
export const BATCH_SHARE_DESCRIPTION =
  '成员可只读查看这些邮箱的全部未删除来信、验证码及附件，已读状态仍由你管理；共享不授予发信、删除权限，也不触发成员通知。';

/** 候选：启用中的用户，排除自己 */
const isCandidate = (user: AdminUser, currentUserId: number) => user.status === 'active' && user.id !== currentUserId;

/** 共享名单变化只影响这两处缓存，不涉及邮件、未读与归属 */
function invalidateShares(client: QueryClient) {
  void client.invalidateQueries({ queryKey: queryKeys.mailboxes.shares });
  void client.invalidateQueries({ queryKey: queryKeys.admin.mailboxShares });
}

/**
 * 失败文案：4xx 是请求被拒绝、整单未写入；网络中断、超时或服务端异常时结果未知，
 * 后端可能已经提交，提示以共享名单为准（与认领的 uncertain 处理一致）。
 */
function failureText(error: unknown): { message: string; uncertain: boolean } {
  const message = error instanceof ApiError ? error.message : '共享失败，请重试';
  return isRejectedRequest(error) ? { message, uncertain: false } : { message: `${message}。共享可能已生效，请以共享名单为准`, uncertain: true };
}

export interface BatchSharePanelProps {
  /** 要共享的邮箱（刚认领成功的那些），须属于当前用户 */
  mailboxIds: number[];
  /** 当前用户 id：不能共享给自己，从候选中排除 */
  currentUserId: number;
  onBack: () => void;
  /** 共享成功，带回这次共享的用户名 */
  onShared: (usernames: string[]) => void;
  /** 提交开始与结束时通知所在弹窗，进行中不允许关闭或返回 */
  onPendingChange: (pending: boolean) => void;
}

/**
 * 管理员把一批自己的邮箱一次共享给选中的用户：追加到各邮箱名单，不移除已有成员。
 * 渲染为对话框的正文与底栏，标题由所在弹窗切换，不再叠一层对话框。
 */
export function BatchSharePanel({ mailboxIds, currentUserId, onBack, onShared, onPendingChange }: BatchSharePanelProps) {
  const queryClient = useQueryClient();
  const [userQuery, setUserQuery] = useState('');
  const [selected, setSelected] = useState<number[]>([]);
  const users = useQuery({ queryKey: queryKeys.admin.users, queryFn: () => adminApi.listUsers() });

  const candidates = (users.data ?? []).filter((user) => isCandidate(user, currentUserId));
  const chosen = candidates.filter((user) => selected.includes(user.id));
  const term = userQuery.trim().toLowerCase();
  const visible = candidates.filter((user) => selected.includes(user.id) || user.username.toLowerCase().includes(term));

  // 名单刷新后把已选裁剪到当前候选：被禁用而隐藏的人之后重新启用，也不会以已勾选状态悄悄带回来
  useEffect(() => {
    if (!users.data) return;
    const ids = new Set(users.data.filter((user) => isCandidate(user, currentUserId)).map((user) => user.id));
    setSelected((prev) => (prev.every((id) => ids.has(id)) ? prev : prev.filter((id) => ids.has(id))));
  }, [users.data, currentUserId]);

  const share = useMutation({
    mutationFn: (targets: AdminUser[]) => mailboxApi.batchShare({ mailboxIds, userIds: targets.map((user) => user.id) }),
    // 离线时与认领一样直接发出、快速失败，不进入暂停的「进行中」把弹窗卡住
    networkMode: 'always',
    onMutate: () => onPendingChange(true),
    onSettled: () => onPendingChange(false),
    // 结果页会显示「已共享给」，不再弹 toast：点 toast 会被当成点击弹窗外部
    onSuccess: (_grants, targets) => {
      invalidateShares(queryClient);
      onShared(targets.map((user) => user.username));
    },
    onError: (error) => {
      if (failureText(error).uncertain) invalidateShares(queryClient);
      if (!(error instanceof ApiError)) return;
      // 期间邮箱被过户、释放或用户被禁用，整单未写入：刷新归属与用户名单后可重选
      if (error.code === 'conflict') invalidateMailboxOwnership(queryClient);
      // 选中的人刚被禁用等校验失败：刷新用户名单，失效的人随之移出已选，否则重试总是失败
      else if (error.code === 'validation_failed') void queryClient.invalidateQueries({ queryKey: queryKeys.admin.users });
    },
  });
  const pending = share.isPending;

  const toggle = (userId: number) =>
    setSelected((prev) => (prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId]));

  return (
    <>
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
        {users.isPaused && <p className="text-xs text-caution">当前处于离线状态，恢复网络后会自动加载用户列表。</p>}
        <div className="max-h-64 overflow-y-auto rounded-md border border-line">
          {users.isPending ? (
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
                  disabled={pending || (!selected.includes(user.id) && chosen.length >= MAX_MAILBOX_GRANTEES)}
                  checked={selected.includes(user.id)}
                  onChange={() => toggle(user.id)}
                />
                <span className="text-ink">{user.username}</span>
              </label>
            ))
          )}
        </div>
        <p className="text-xs text-ink-tertiary">已选 {chosen.length}/{MAX_MAILBOX_GRANTEES} 人，已有的共享成员会保留。</p>
        {share.isError && (
          <p role="alert" className="text-sm text-critical">
            {failureText(share.error).message}
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
