import { useState } from 'react';
import { PROXY_EXPORT_FORMATS, type ProxyExportFormat, type ProxyStatus } from '@hpc-mail/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { adminProxyApi } from './proxies-api';
import { PROXY_STATUS_OPTIONS } from './proxy-meta';
import { downloadText, errorMessage, Field, NativeSelect } from '../shared/vendor-ui';

const FORMAT_LABELS: Record<ProxyExportFormat, string> = {
  url: 'URL',
  host_port_user_pass: 'host:port:user:pass',
  user_pass_at_host_port: 'user:pass@host:port',
  json: 'JSON',
};

/** 导出含明文密码：结果直接下载为文件，不进页面状态与缓存（服务端审计 proxy.export） */
export function ExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [format, setFormat] = useState<ProxyExportFormat>('url');
  const [scope, setScope] = useState<'bindings' | 'proxies'>('bindings');
  const [domain, setDomain] = useState('');
  const [status, setStatus] = useState<ProxyStatus | ''>('');
  const [loading, setLoading] = useState(false);

  const run = async () => {
    setLoading(true);
    try {
      const result = await adminProxyApi.exportProxies({
        format,
        scope,
        domain: domain.trim().toLowerCase() || undefined,
        status: status || undefined,
      });
      const stamp = new Date().toISOString().slice(0, 10);
      const json = result.format === 'json';
      downloadText(`proxies-${scope}-${stamp}.${json ? 'json' : 'txt'}`, result.content, json ? 'application/json' : 'text/plain');
      toast({ title: `已导出 ${result.count} 条`, variant: 'success' });
      onClose();
    } catch (error) {
      toast({ title: errorMessage(error, '导出失败'), variant: 'error' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !loading && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader title="导出代理" description="导出文件包含明文密码，请妥善保管。" />
        <DialogBody className="flex flex-col gap-3">
          <Field label="范围" hint={scope === 'bindings' ? '每行带邮箱地址，便于其他流程按地址取代理' : '导出库存中的代理（不含地址）'}>
            {(id) => (
              <NativeSelect id={id} value={scope} onChange={(e) => setScope(e.target.value as 'bindings' | 'proxies')}>
                <option value="bindings">按绑定（地址 → 代理）</option>
                <option value="proxies">全部代理</option>
              </NativeSelect>
            )}
          </Field>
          <Field label="格式">
            {(id) => (
              <NativeSelect id={id} value={format} onChange={(e) => setFormat(e.target.value as ProxyExportFormat)}>
                {PROXY_EXPORT_FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {FORMAT_LABELS[f]}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field label="域名（可选）">
            {(id) => <Input id={id} value={domain} placeholder="example.com" onChange={(e) => setDomain(e.target.value)} />}
          </Field>
          <Field label="代理状态（可选）">
            {(id) => (
              <NativeSelect id={id} value={status} onChange={(e) => setStatus(e.target.value as ProxyStatus | '')}>
                <option value="">全部</option>
                {PROXY_STATUS_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            取消
          </Button>
          <Button loading={loading} onClick={() => void run()}>
            下载
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
