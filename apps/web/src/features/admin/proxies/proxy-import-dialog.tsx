import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { MAX_PROXY_IMPORT_LINES, PROXY_PROTOCOLS, type ProxyImportFormat, type ProxyImportResult, type ProxyProtocol } from '@hpc-mail/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { adminProxyApi, invalidateProxyData } from './proxies-api';
import { localInputToIso } from './proxy-form-dialog';
import { errorMessage, Field, NativeSelect } from '../shared/vendor-ui';

const FORMAT_LABELS: Record<ProxyImportFormat, string> = {
  auto: '自动识别',
  url: 'URL（http://user:pass@host:port）',
  host_port_user_pass: 'host:port:user:pass',
  user_pass_at_host_port: 'user:pass@host:port',
};

export function countImportLines(text: string): number {
  return text.split(/\r?\n/).filter((line) => line.trim() !== '').length;
}

function ImportSummary({ result }: { result: ProxyImportResult }) {
  return (
    <div role="status" className="flex flex-col gap-2 rounded-md border border-line bg-canvas p-3 text-sm">
      <p className="font-medium text-ink">
        {result.dryRun ? '预览' : '导入完成'}：{result.dryRun ? '可新增' : '新增'} {result.created} 个，重复 {result.duplicates} 个，无效{' '}
        {result.invalid.length} 行
      </p>
      {result.invalid.length > 0 && (
        <ul className="max-h-40 overflow-y-auto text-[13px] text-critical">
          {result.invalid.slice(0, 50).map((item) => (
            <li key={item.line}>
              第 {item.line} 行：{item.reason}
            </li>
          ))}
          {result.invalid.length > 50 && <li>…另有 {result.invalid.length - 50} 行</li>}
        </ul>
      )}
    </div>
  );
}

/** 批量导入：先预览（dryRun），确认无误再导入 */
export function ProxyImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [format, setFormat] = useState<ProxyImportFormat>('auto');
  const [provider, setProvider] = useState('');
  const [protocol, setProtocol] = useState<ProxyProtocol | ''>('');
  const [product, setProduct] = useState('');
  const [country, setCountry] = useState('');
  const [label, setLabel] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [maxBindings, setMaxBindings] = useState('');
  const [preview, setPreview] = useState<ProxyImportResult | null>(null);

  useEffect(() => {
    if (!open) return;
    setText('');
    setPreview(null);
  }, [open]);

  const lines = countImportLines(text);
  const tooMany = lines > MAX_PROXY_IMPORT_LINES;

  const defaults = () => {
    const d: Record<string, unknown> = {};
    if (provider.trim()) d.provider = provider.trim().toLowerCase();
    if (protocol) d.protocol = protocol;
    if (product.trim()) d.product = product.trim();
    if (country.trim()) d.country = country.trim().toUpperCase();
    if (label.trim()) d.label = label.trim();
    const iso = localInputToIso(expiresAt);
    if (iso) d.expiresAt = iso;
    if (maxBindings) d.maxBindings = Number(maxBindings);
    return d;
  };

  const run = useMutation({
    mutationFn: (dryRun: boolean) => adminProxyApi.importLines({ text, format, defaults: defaults(), dryRun }),
    onSuccess: (result) => {
      setPreview(result);
      if (!result.dryRun) {
        invalidateProxyData(queryClient);
        toast({ title: `已导入 ${result.created} 个代理`, variant: 'success' });
      }
    },
    onError: (err) => toast({ title: errorMessage(err, '导入失败'), variant: 'error' }),
  });

  const imported = preview !== null && !preview.dryRun;

  // 任何输入变化都让旧预览失效，必须重新预览后才能导入
  const touch = <T,>(setter: (value: T) => void) => (value: T) => {
    setter(value);
    setPreview(null);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !run.isPending && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader title="批量导入代理" description={`每行一个代理，最多 ${MAX_PROXY_IMPORT_LINES} 行；与已有代理（主机+端口+用户名）重复的行会跳过。`} />
        <DialogBody className="flex flex-col gap-3">
          <Field label="代理列表" hint={`${lines} 行${tooMany ? `，超过上限 ${MAX_PROXY_IMPORT_LINES}` : ''}`}>
            {(id) => (
              <Textarea
                id={id}
                rows={8}
                className="font-mono text-[13px]"
                placeholder={'http://user:pass@1.2.3.4:8080\n1.2.3.4:8080:user:pass'}
                value={text}
                invalid={tooMany}
                onChange={(e) => touch(setText)(e.target.value)}
              />
            )}
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="格式">
              {(id) => (
                <NativeSelect id={id} value={format} onChange={(e) => touch(setFormat)(e.target.value as ProxyImportFormat)}>
                  {(Object.keys(FORMAT_LABELS) as ProxyImportFormat[]).map((f) => (
                    <option key={f} value={f}>
                      {FORMAT_LABELS[f]}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
            <Field label="默认协议" hint="URL 格式自带协议">
              {(id) => (
                <NativeSelect id={id} value={protocol} onChange={(e) => touch(setProtocol)(e.target.value as ProxyProtocol | '')}>
                  <option value="">http（缺省）</option>
                  {PROXY_PROTOCOLS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
            <Field label="供应商">
              {(id) => <Input id={id} value={provider} placeholder="manual" maxLength={64} onChange={(e) => touch(setProvider)(e.target.value)} />}
            </Field>
            <Field label="国家">
              {(id) => <Input id={id} value={country} maxLength={2} placeholder="US" onChange={(e) => touch(setCountry)(e.target.value)} />}
            </Field>
            <Field label="产品类型">
              {(id) => <Input id={id} value={product} maxLength={64} onChange={(e) => touch(setProduct)(e.target.value)} />}
            </Field>
            <Field label="备注名">
              {(id) => <Input id={id} value={label} maxLength={100} onChange={(e) => touch(setLabel)(e.target.value)} />}
            </Field>
            <Field label="到期时间">
              {(id) => <Input id={id} type="datetime-local" value={expiresAt} onChange={(e) => touch(setExpiresAt)(e.target.value)} />}
            </Field>
            <Field label="每个代理最多绑定">
              {(id) => <Input id={id} value={maxBindings} inputMode="numeric" placeholder="1" onChange={(e) => touch(setMaxBindings)(e.target.value.replace(/\D/g, ''))} />}
            </Field>
          </div>
          {preview && <ImportSummary result={preview} />}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={run.isPending}>
            {imported ? '完成' : '取消'}
          </Button>
          {!imported && (
            <>
              <Button variant="secondary" loading={run.isPending && run.variables === true} disabled={!lines || tooMany || run.isPending} onClick={() => run.mutate(true)}>
                预览
              </Button>
              <Button
                loading={run.isPending && run.variables === false}
                disabled={!preview?.dryRun || preview.created === 0 || run.isPending}
                onClick={() => run.mutate(false)}
              >
                导入 {preview?.dryRun ? preview.created : ''} 个
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
