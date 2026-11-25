import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { proxyAddressSchema, type ProxyBindingView } from '@hpc-mail/shared';
import { queryKeys } from '@/api/query-keys';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { adminProxyApi, invalidateProxyData } from './proxies-api';
import { proxyEndpoint, proxyHasCapacity, proxyLocation, proxyTitle } from './proxy-meta';
import { errorMessage, Field } from '../shared/vendor-ui';

/**
 * 把一个邮箱地址绑定到代理（已绑定则改绑）。地址可预置（全站地址页的行操作），
 * 代理从可用库存中挑选：只能选 active、未过期、仍有绑定余量的代理。
 */
export function BindProxyDialog({
  open,
  address: presetAddress,
  currentProxyId,
  onClose,
  onBound,
}: {
  open: boolean;
  address?: string;
  currentProxyId?: number | null;
  onClose: () => void;
  onBound?: (binding: ProxyBindingView) => void;
}) {
  const queryClient = useQueryClient();
  const [address, setAddress] = useState(presetAddress ?? '');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setAddress(presetAddress ?? '');
    setSearch('');
    setDebounced('');
    setSelected(null);
    setError('');
  }, [open, presetAddress]);
  useEffect(() => {
    const timer = globalThis.setTimeout(() => setDebounced(search.trim()), 250);
    return () => globalThis.clearTimeout(timer);
  }, [search]);

  const filters = { status: 'active' as const, q: debounced || undefined, picker: true };
  const candidates = useQuery({
    queryKey: queryKeys.admin.proxies(filters),
    queryFn: () => adminProxyApi.list({ status: 'active', q: debounced || undefined }),
    enabled: open,
    placeholderData: (previous) => previous,
  });
  const items = (candidates.data?.items ?? []).filter((p) => proxyHasCapacity(p) || p.id === currentProxyId);

  const bind = useMutation({
    mutationFn: ({ target, proxyId }: { target: string; proxyId: number }) => adminProxyApi.bind(target, proxyId),
    onSuccess: (binding) => {
      invalidateProxyData(queryClient);
      toast({ title: `已绑定 ${binding.address}`, variant: 'success' });
      onBound?.(binding);
      onClose();
    },
    onError: (err) => setError(errorMessage(err, '绑定失败')),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError('');
    const parsed = proxyAddressSchema.safeParse(address);
    if (!parsed.success) return setError('请输入完整的邮箱地址');
    if (selected === null) return setError('请选择一个代理');
    bind.mutate({ target: parsed.data, proxyId: selected });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !bind.isPending && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader
          title={currentProxyId ? '更换绑定代理' : '绑定代理'}
          description={presetAddress ?? '绑定以地址为准：未认领地址同样可绑，释放或过户不影响绑定。'}
        />
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <DialogBody className="flex flex-col gap-3">
            {!presetAddress && (
              <Field label="邮箱地址">
                {(id) => <Input id={id} value={address} placeholder="user@example.com" onChange={(e) => setAddress(e.target.value)} />}
              </Field>
            )}
            <Field label="选择代理" hint="只列出可用且仍有绑定余量的代理">
              {(id) => <Input id={id} value={search} placeholder="搜索备注、主机或用户名" onChange={(e) => setSearch(e.target.value)} />}
            </Field>
            {candidates.isPending ? (
              <Skeleton className="h-32 w-full rounded-md" />
            ) : candidates.isError ? (
              <p className="text-sm text-critical">{errorMessage(candidates.error, '代理列表加载失败')}</p>
            ) : items.length === 0 ? (
              <p className="text-sm text-ink-tertiary">没有可用的空闲代理。可先到「代理池」添加或导入。</p>
            ) : (
              <ul role="radiogroup" aria-label="可选代理" className="flex max-h-64 flex-col gap-1 overflow-y-auto">
                {items.map((proxy) => (
                  <li key={proxy.id}>
                    <label
                      className={cn(
                        'flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm',
                        selected === proxy.id ? 'border-accent bg-accent-soft' : 'border-line hover:bg-surface-hover',
                      )}
                    >
                      <input
                        type="radio"
                        name="proxy"
                        className="mt-1"
                        checked={selected === proxy.id}
                        onChange={() => setSelected(proxy.id)}
                        aria-label={`#${proxy.id} ${proxyTitle(proxy)}`}
                      />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate font-medium text-ink">
                          #{proxy.id} {proxyTitle(proxy)}
                          {proxy.id === currentProxyId && <span className="ml-1 text-xs text-ink-tertiary">（当前）</span>}
                        </span>
                        <span className="truncate text-xs text-ink-tertiary">
                          {proxyEndpoint(proxy)} · {proxy.provider} · {proxyLocation(proxy)} · 已绑 {proxy.bindingCount}/{proxy.maxBindings}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {error && (
              <p role="alert" className="text-sm text-critical">
                {error}
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={bind.isPending}>
              取消
            </Button>
            <Button type="submit" loading={bind.isPending} disabled={selected === null}>
              绑定
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
