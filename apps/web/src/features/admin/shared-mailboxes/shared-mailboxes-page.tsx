import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, Search, Share2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { MailboxShareGrant } from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';
import { invalidateMailboxOwnership, queryKeys } from '@/api/query-keys';
import { adminApi } from '@/api/resources';
import { PageHeader } from '@/components/page-header';
import { QueryErrorState } from '@/components/query-error-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CardList, CardListItem } from '@/components/ui/card-list';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import { useIsMobile } from '@/lib/use-media-query';
import { MailboxShareDialog } from '@/features/mailboxes/mailbox-share-dialog';

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}


export function SharedMailboxesPage() {
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  const shares = useQuery({
    queryKey: queryKeys.admin.mailboxShares,
    queryFn: () => adminApi.listMailboxShares(),
  });
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<MailboxShareGrant | null>(null);
  const [creating, setCreating] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<{
    mailboxId: number;
    userId: number;
    address: string;
    username: string;
  } | null>(null);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    const list = shares.data ?? [];
    if (!term) return list;
    return list.filter(
      (item) =>
        item.address.includes(term) ||
        item.ownerUsername.toLowerCase().includes(term) ||
        item.grantees.some((grantee) => grantee.username.toLowerCase().includes(term)),
    );
  }, [shares.data, q]);

  const revoke = useMutation({
    mutationFn: (target: NonNullable<typeof revokeTarget>) =>
      adminApi.revokeMailboxShare(target.mailboxId, target.userId),
    onSuccess: () => {
      toast({ title: '已取消共享', variant: 'success' });
      invalidateMailboxOwnership(queryClient);
      setRevokeTarget(null);
    },
    onError: (error) => toast({ title: errorText(error, '取消失败，请重试'), variant: 'error' }),
  });

  const dialogGrant = creating ? (shares.data?.[0] ?? null) : editing;

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="共享邮箱"
        description="管理全站已认领邮箱的共享名单，可把任意用户的邮箱共享给启用中的用户或管理员。成员拥有只读来信权限。"
        actions={
          <Button
            onClick={() => {
              setEditing(null);
              setCreating(true);
            }}
            disabled={!shares.data?.length}
          >
            <Share2 className="size-4" />
            分配共享
          </Button>
        }
      />
      <div className="relative mb-4">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-tertiary" />
        <Input value={q} onChange={(event) => setQ(event.target.value)} placeholder="搜索地址、所有者或共享成员" className="pl-9" />
      </div>

      {shares.isLoading ? (
        <Skeleton className="h-40 w-full rounded-lg" />
      ) : shares.isError ? (
        <QueryErrorState error={shares.error} onRetry={() => void shares.refetch()} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Share2}
          title={q ? '没有匹配的邮箱' : '暂无已认领邮箱'}
          description={q ? undefined : '用户认领邮箱后，即可在这里为其分配共享。'}
          className="rounded-lg border border-line bg-surface"
        />
      ) : isMobile ? (
        <CardList>
          {filtered.map((item) => (
            <CardListItem
              key={item.mailboxId}
              title={<span className="truncate">{item.address}</span>}
              subtitle={`所有者：${item.ownerUsername} · ${item.grantees.length === 0 ? '尚未共享' : `共享给 ${item.grantees.length} 人`}`}
              meta={
                item.grantees.length > 0 ? (
                  <>
                    {item.grantees.map((grantee) => (
                      <Badge key={grantee.userId} tone="neutral">
                        {grantee.username}
                      </Badge>
                    ))}
                  </>
                ) : undefined
              }
              actions={
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <IconButton size="sm" aria-label="更多操作">
                      <MoreHorizontal className="size-4" />
                    </IconButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    <DropdownMenuItem
                      onSelect={() => {
                        setCreating(false);
                        setEditing(item);
                      }}
                    >
                      编辑共享名单
                    </DropdownMenuItem>
                    {item.grantees.length > 0 && <DropdownMenuSeparator />}
                    {item.grantees.map((grantee) => (
                      <DropdownMenuItem
                        key={grantee.userId}
                        tone="danger"
                        onSelect={() =>
                          setRevokeTarget({
                            mailboxId: item.mailboxId,
                            userId: grantee.userId,
                            address: item.address,
                            username: grantee.username,
                          })
                        }
                      >
                        取消与 {grantee.username} 共享
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              }
            />
          ))}
        </CardList>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>地址</TableHead>
              <TableHead>所有者</TableHead>
              <TableHead>共享给</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((item) => (
              <TableRow key={item.mailboxId}>
                <TableCell className="font-medium">{item.address}</TableCell>
                <TableCell className="text-ink-secondary">{item.ownerUsername}</TableCell>
                <TableCell>
                  {item.grantees.length === 0 ? (
                    <span className="text-ink-tertiary">尚未共享</span>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {item.grantees.map((grantee) => (
                        <Badge key={grantee.userId} tone="neutral" className="gap-1">
                          {grantee.username}
                          <button
                            type="button"
                            aria-label={`取消与 ${grantee.username} 共享 ${item.address}`}
                            className="rounded-sm hover:text-critical"
                            onClick={() =>
                              setRevokeTarget({
                                mailboxId: item.mailboxId,
                                userId: grantee.userId,
                                address: item.address,
                                username: grantee.username,
                              })
                            }
                          >
                            <X className="size-3" />
                          </button>
                        </Badge>
                      ))}
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setCreating(false);
                        setEditing(item);
                      }}
                    >
                      编辑
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <MailboxShareDialog
        key={creating ? 'create' : String(editing?.mailboxId ?? 'closed')}
        grant={creating || editing ? dialogGrant : null}
        grants={shares.data ?? []}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      />
      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => !open && setRevokeTarget(null)}
        title="取消共享"
        description={
          revokeTarget
            ? `${revokeTarget.username} 将不能再看到 ${revokeTarget.address} 的邮件。地址和历史邮件都保留。`
            : undefined
        }
        confirmLabel="取消共享"
        tone="danger"
        loading={revoke.isPending}
        onConfirm={() => revokeTarget && revoke.mutate(revokeTarget)}
      />
    </div>
  );
}
