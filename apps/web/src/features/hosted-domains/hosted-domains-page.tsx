import { ChevronRight, Earth, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { HostedDomain } from '@hpc-mail/shared';
import { PageHeader } from '@/components/page-header';
import { QueryErrorState } from '@/components/query-error-state';
import { Button } from '@/components/ui/button';
import { CardList, CardListItem } from '@/components/ui/card-list';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDateTime } from '@/lib/format';
import { usePublicConfig } from '@/lib/use-config';
import { useIsMobile } from '@/lib/use-media-query';
import { AddHostedDomainDialog } from './add-hosted-domain-dialog';
import { HostedDomainRoleBadge, HostedDomainStatusBadge, NsPropagationNotice } from './hosted-domain-meta';
import { useHostedDomainsQuery } from './use-hosted-domains';

export const hostedDomainHref = (domain: Pick<HostedDomain, 'id'>) => `/domains/${domain.id}`;

function DomainLink({ domain }: { domain: HostedDomain }) {
  return (
    <Link
      to={hostedDomainHref(domain)}
      className="truncate font-medium text-ink underline-offset-4 hover:text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      {domain.domain}
    </Link>
  );
}

function DetailButton({ domain }: { domain: HostedDomain }) {
  return (
    <Button asChild size="sm" variant="secondary">
      <Link to={hostedDomainHref(domain)} aria-label={`查看 ${domain.domain} 详情`}>
        详情
        <ChevronRight className="size-4" />
      </Link>
    </Button>
  );
}

export function HostedDomainsPage() {
  const isMobile = useIsMobile();
  const { data: config } = usePublicConfig();
  const { data, isLoading, isError, error, refetch } = useHostedDomainsQuery();
  const [addOpen, setAddOpen] = useState(false);
  // 旧缓存里没有该字段时按未开启处理；关闭后已有域名仍可查看和管理
  const canAdd = config?.hostedDomainsEnabled === true;
  const items = data ?? [];

  const addButton = (
    <Button disabled={!canAdd} onClick={() => setAddOpen(true)}>
      <Plus className="size-4" />
      添加域名
    </Button>
  );

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="我的域名"
        description="把自己的域名托管到本站，用作邮箱后缀：在该域名下认领任意地址收发邮件，未认领地址的来信自动归你。"
        actions={addButton}
      />
      {config && !canAdd && (
        <p className="mb-4 rounded-md border border-line bg-canvas px-3 py-2 text-sm text-ink-secondary">
          管理员暂未开放域名托管，不能添加新域名；已有的域名照常显示。
        </p>
      )}
      {items.some((domain) => domain.status === 'pending' && domain.role !== 'member') && (
        <NsPropagationNotice className="mb-4 rounded-md border border-critical/40 bg-critical-soft px-3 py-2" />
      )}

      {isLoading ? (
        <Skeleton className="h-40 w-full rounded-lg" />
      ) : isError ? (
        <QueryErrorState error={error} onRetry={() => void refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={Earth}
          title="还没有托管域名"
          description="添加一个你自己的域名（如 example.com），按提示到域名注册商把名称服务器（NS）改为本站分配的两条。系统检测到生效后自动开通收件和发信，之后就能在该域名下认领地址，也可以共享给其他用户使用。生效后还可以在域名详情里管理网站等常用 DNS 解析。"
          action={addButton}
          className="rounded-lg border border-line bg-surface"
        />
      ) : isMobile ? (
        <CardList>
          {items.map((domain) => (
            <CardListItem
              key={domain.id}
              title={<DomainLink domain={domain} />}
              subtitle={domain.role === 'owner' ? undefined : `所有者：${domain.ownerUsername}`}
              meta={
                <>
                  <HostedDomainRoleBadge role={domain.role} />
                  <HostedDomainStatusBadge status={domain.status} />
                  <span>已认领 {domain.mailboxCount} 个地址</span>
                  <span>添加于 {formatDateTime(domain.createdAt)}</span>
                </>
              }
              actions={<DetailButton domain={domain} />}
            />
          ))}
        </CardList>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>域名</TableHead>
              <TableHead>身份</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>已认领地址</TableHead>
              <TableHead>添加时间</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((domain) => (
              <TableRow key={domain.id}>
                <TableCell>
                  <div className="flex min-w-0 flex-col">
                    <DomainLink domain={domain} />
                    {domain.role !== 'owner' && (
                      <span className="text-xs text-ink-tertiary">所有者：{domain.ownerUsername}</span>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <HostedDomainRoleBadge role={domain.role} />
                </TableCell>
                <TableCell>
                  <HostedDomainStatusBadge status={domain.status} />
                </TableCell>
                <TableCell className="text-ink-secondary">{domain.mailboxCount}</TableCell>
                <TableCell className="text-ink-tertiary">{formatDateTime(domain.createdAt)}</TableCell>
                <TableCell>
                  <div className="flex justify-end">
                    <DetailButton domain={domain} />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <AddHostedDomainDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}
