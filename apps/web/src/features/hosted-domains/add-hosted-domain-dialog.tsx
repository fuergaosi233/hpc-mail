import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createHostedDomainRequestSchema, type HostedDomain } from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';
import { queryKeys } from '@/api/query-keys';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { hostedDomainApi } from './hosted-domains-api';
import { NsPropagationNotice } from './hosted-domain-meta';

export function AddHostedDomainDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [domain, setDomain] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDomain('');
    setError(null);
  }, [open]);

  const create = useMutation({
    mutationFn: (value: string) => hostedDomainApi.create({ domain: value }),
    onSuccess: (created) => {
      queryClient.setQueryData(queryKeys.hostedDomains.detail(created.id), created);
      queryClient.setQueryData<HostedDomain[]>(
        queryKeys.hostedDomains.list,
        (list) => list && [created, ...list.filter((item) => item.id !== created.id)],
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.hostedDomains });
      toast({ title: `已添加 ${created.domain}`, description: '请按页面指引到注册商修改名称服务器。', variant: 'success' });
      onOpenChange(false);
      navigate(`/domains/${created.id}`);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : '添加失败，请重试'),
  });

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (create.isPending) return;
    const parsed = createHostedDomainRequestSchema.safeParse({ domain });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '域名格式非法');
      return;
    }
    setError(null);
    create.mutate(parsed.data.domain);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !create.isPending && onOpenChange(next)}>
      <DialogContent className="max-w-md">
        <DialogHeader title="添加域名" description="提交后系统为该域名分配两条名称服务器（NS），改好后自动开通收件和发信。" />
        <form onSubmit={handleSubmit}>
          <DialogBody className="flex flex-col gap-4">
            <FormField label="域名" required error={error ?? undefined} description="填写在注册商购买的根域名，例如 example.com。">
              {(field) => (
                <Input
                  {...field}
                  autoFocus
                  autoComplete="off"
                  inputMode="url"
                  placeholder="example.com"
                  value={domain}
                  invalid={error !== null}
                  disabled={create.isPending}
                  onChange={(event) => {
                    setDomain(event.target.value);
                    if (error) setError(null);
                  }}
                />
              )}
            </FormField>
            <div className="rounded-md border border-caution/40 bg-caution-soft/40 p-3 text-sm">
              <p className="flex items-center gap-1.5 font-medium text-caution">
                <AlertTriangle aria-hidden className="size-4 shrink-0" />
                提交前请确认
              </p>
              <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-5 text-ink-secondary">
                <li>
                  本站会<b className="text-ink">接管该域名根域的邮件</b>，根域 MX、SPF、DMARC 和 DKIM 记录由系统维护。如果正在使用其他邮箱服务（如
                  Google Workspace、腾讯企业邮），切换后原邮箱会停止收信。
                </li>
                <li>
                  网站等其他 DNS 记录<b className="text-ink">不会自动迁移</b>，添加后可以在域名详情的「DNS
                  解析」里补上，建议在修改名称服务器之前完成。
                </li>
                <li>修改名称服务器前，请先在注册商处<b className="text-ink">关闭 DNSSEC</b>，否则域名会解析失败。</li>
                <li>提交后请尽快修改名称服务器，超过等待期限仍未生效会自动删除，截止时间见详情页。</li>
              </ul>
            </div>
            <NsPropagationNotice className="mt-3" />
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" disabled={create.isPending} onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" loading={create.isPending}>
              添加
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
