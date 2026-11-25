import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { proxy1024GenerateStickyRequestSchema } from '@hpc-mail/shared';
import { queryKeys } from '@/api/query-keys';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { invalidateProxyData } from '../proxies/proxies-api';
import { proxy1024Api } from './proxy-1024-api';
import { errorMessage, Field, NativeSelect } from '../shared/vendor-ui';

/** 用已购流量的子账号生成粘性住宅代理（不下单、不花钱，只消耗已有流量） */
export function StickyGenerateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const subUsers = useQuery({
    queryKey: queryKeys.admin.proxy1024SubUsers,
    queryFn: () => proxy1024Api.subUsers(),
    enabled: open,
    retry: false,
  });
  const [subUser, setSubUser] = useState('');
  const [gateway, setGateway] = useState('');
  const [country, setCountry] = useState('US');
  const [state, setState] = useState('');
  const [city, setCity] = useState('');
  const [minutes, setMinutes] = useState('30');
  const [count, setCount] = useState('10');
  const [protocol, setProtocol] = useState<'http' | 'socks5'>('http');
  const [maxBindings, setMaxBindings] = useState('1');
  const [error, setError] = useState('');
  useEffect(() => {
    if (open) setError('');
  }, [open]);

  const generate = useMutation({
    mutationFn: (body: Parameters<typeof proxy1024Api.generateSticky>[0]) => proxy1024Api.generateSticky(body),
    onSuccess: (result) => {
      invalidateProxyData(queryClient);
      toast({ title: `已生成 ${result.created} 个粘性代理`, variant: 'success' });
      onClose();
    },
    onError: (err) => setError(errorMessage(err, '生成失败')),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError('');
    const parsed = proxy1024GenerateStickyRequestSchema.safeParse({
      subUser,
      gateway: gateway.trim() || undefined,
      country,
      state: state.trim() || undefined,
      city: city.trim() || undefined,
      minutes: Number(minutes),
      count: Number(count),
      protocol,
      maxBindings: Number(maxBindings),
    });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? '输入有误');
    generate.mutate(parsed.data);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !generate.isPending && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader title="生成粘性住宅代理" description="按 1024 子账号 + 地区 + 会话时长拼出代理用户名，写入代理池。" />
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <DialogBody className="grid grid-cols-2 gap-3">
            <Field label="子账号" className="col-span-2">
              {(id) => (
                <NativeSelect id={id} value={subUser} onChange={(e) => setSubUser(e.target.value)}>
                  <option value="">{subUsers.isPending ? '加载中…' : subUsers.isError ? '加载失败' : '请选择'}</option>
                  {(subUsers.data?.items ?? []).map((u) => (
                    <option key={u.username} value={u.username}>
                      {u.username}
                      {u.title ? ` · ${u.title}` : ''}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
            <Field label="网关（可选）" hint="host:port；缺省用 1024 的第一个网关" className="col-span-2">
              {(id) => <Input id={id} value={gateway} onChange={(e) => setGateway(e.target.value)} />}
            </Field>
            <Field label="国家">
              {(id) => <Input id={id} value={country} maxLength={2} onChange={(e) => setCountry(e.target.value.toUpperCase())} />}
            </Field>
            <Field label="州/省（可选）">
              {(id) => <Input id={id} value={state} onChange={(e) => setState(e.target.value)} />}
            </Field>
            <Field label="城市（可选）">
              {(id) => <Input id={id} value={city} onChange={(e) => setCity(e.target.value)} />}
            </Field>
            <Field label="会话时长（分钟）">
              {(id) => <Input id={id} value={minutes} inputMode="numeric" onChange={(e) => setMinutes(e.target.value.replace(/\D/g, ''))} />}
            </Field>
            <Field label="生成数量">
              {(id) => <Input id={id} value={count} inputMode="numeric" onChange={(e) => setCount(e.target.value.replace(/\D/g, ''))} />}
            </Field>
            <Field label="协议">
              {(id) => (
                <NativeSelect id={id} value={protocol} onChange={(e) => setProtocol(e.target.value as 'http' | 'socks5')}>
                  <option value="http">http</option>
                  <option value="socks5">socks5</option>
                </NativeSelect>
              )}
            </Field>
            <Field label="每个代理最多绑定">
              {(id) => <Input id={id} value={maxBindings} inputMode="numeric" onChange={(e) => setMaxBindings(e.target.value.replace(/\D/g, ''))} />}
            </Field>
            {error && (
              <p role="alert" className="col-span-2 text-sm text-critical">
                {error}
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={generate.isPending}>
              取消
            </Button>
            <Button type="submit" loading={generate.isPending} disabled={!subUser}>
              生成
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
