import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { type AutoAssignRequest, type AutoAssignResult, autoAssignRequestSchema, MAX_PROXY_LOOKUP_ADDRESSES } from '@hpc-mail/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { adminProxyApi, invalidateProxyData } from './proxies-api';
import { errorMessage, Field, NativeSelect } from '../shared/vendor-ui';

export function splitAddresses(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];
}

function ResultView({ result }: { result: AutoAssignResult }) {
  return (
    <div role="status" className="flex flex-col gap-2 rounded-md border border-line bg-canvas p-3 text-sm">
      <p className="font-medium text-ink">
        {result.dryRun ? '预览' : '已分配'}：{result.assigned.length} 个地址
        {result.unassigned.length > 0 && `，${result.unassigned.length} 个未分到代理`}，剩余空闲代理 {result.freeProxiesLeft} 个
      </p>
      {result.assigned.length > 0 && (
        <ul className="max-h-48 overflow-y-auto text-[13px] text-ink-secondary">
          {result.assigned.slice(0, 200).map((pair) => (
            <li key={pair.address}>
              {pair.address} → 代理 #{pair.proxyId}
            </li>
          ))}
        </ul>
      )}
      {result.unassigned.length > 0 && (
        <p className="break-words text-[13px] text-caution">未分配：{result.unassigned.slice(0, 50).join('、')}</p>
      )}
    </div>
  );
}

/** 给未绑定的地址批量分配空闲代理：先预览配对，再执行（执行时服务端重新配对，手工绑定优先） */
export function AutoAssignDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<'claimed' | 'addresses'>('claimed');
  const [domain, setDomain] = useState('');
  const [addresses, setAddresses] = useState('');
  const [limit, setLimit] = useState('100');
  const [provider, setProvider] = useState('');
  const [country, setCountry] = useState('');
  const [product, setProduct] = useState('');
  const [result, setResult] = useState<AutoAssignResult | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setResult(null);
    setError('');
  }, [open]);

  const build = (dryRun: boolean): AutoAssignRequest | null => {
    const filter: AutoAssignRequest['filter'] = {};
    if (provider.trim()) filter.provider = provider.trim();
    if (country.trim()) filter.country = country.trim();
    if (product.trim()) filter.product = product.trim();
    const raw = {
      target,
      domain: target === 'claimed' && domain.trim() ? domain.trim().toLowerCase() : undefined,
      addresses: target === 'addresses' ? splitAddresses(addresses) : undefined,
      limit: Number(limit) || 100,
      filter,
      dryRun,
    };
    const parsed = autoAssignRequestSchema.safeParse(raw);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '输入有误');
      return null;
    }
    return parsed.data;
  };

  const run = useMutation({
    mutationFn: (body: AutoAssignRequest) => adminProxyApi.autoAssign(body),
    onSuccess: (data) => {
      setResult(data);
      if (!data.dryRun) {
        invalidateProxyData(queryClient);
        toast({ title: `已为 ${data.assigned.length} 个地址分配代理`, variant: 'success' });
      }
    },
    onError: (err) => setError(errorMessage(err, '分配失败')),
  });

  const start = (dryRun: boolean) => {
    setError('');
    const body = build(dryRun);
    if (body) run.mutate(body);
  };
  const reset = <T,>(setter: (v: T) => void) => (v: T) => {
    setter(v);
    setResult(null);
  };
  const applied = result !== null && !result.dryRun;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !run.isPending && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader title="自动分配代理" description="按代理 id 顺序把空闲代理分给尚未绑定的地址；已绑定的地址不受影响。" />
        <DialogBody className="flex flex-col gap-3">
          <Field label="分配对象">
            {(id) => (
              <NativeSelect id={id} value={target} onChange={(e) => reset(setTarget)(e.target.value as 'claimed' | 'addresses')}>
                <option value="claimed">已认领但未绑定代理的地址</option>
                <option value="addresses">指定地址（可含未认领地址）</option>
              </NativeSelect>
            )}
          </Field>
          {target === 'claimed' ? (
            <Field label="限定域名（可选）">
              {(id) => <Input id={id} value={domain} placeholder="example.com" onChange={(e) => reset(setDomain)(e.target.value)} />}
            </Field>
          ) : (
            <Field label="地址列表" hint={`空白、逗号或分号分隔，最多 ${MAX_PROXY_LOOKUP_ADDRESSES} 个`}>
              {(id) => <Textarea id={id} rows={5} value={addresses} onChange={(e) => reset(setAddresses)(e.target.value)} />}
            </Field>
          )}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label="最多分配">
              {(id) => <Input id={id} value={limit} inputMode="numeric" onChange={(e) => reset(setLimit)(e.target.value.replace(/\D/g, ''))} />}
            </Field>
            <Field label="供应商">
              {(id) => <Input id={id} value={provider} onChange={(e) => reset(setProvider)(e.target.value)} />}
            </Field>
            <Field label="国家">
              {(id) => <Input id={id} value={country} maxLength={2} onChange={(e) => reset(setCountry)(e.target.value)} />}
            </Field>
            <Field label="产品">
              {(id) => <Input id={id} value={product} onChange={(e) => reset(setProduct)(e.target.value)} />}
            </Field>
          </div>
          {result && <ResultView result={result} />}
          {error && (
            <p role="alert" className="text-sm text-critical">
              {error}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={run.isPending}>
            {applied ? '完成' : '取消'}
          </Button>
          {!applied && (
            <>
              <Button variant="secondary" disabled={run.isPending} loading={run.isPending && run.variables?.dryRun === true} onClick={() => start(true)}>
                预览
              </Button>
              <Button
                disabled={run.isPending || !result?.dryRun || result.assigned.length === 0}
                loading={run.isPending && run.variables?.dryRun === false}
                onClick={() => start(false)}
              >
                执行分配
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
