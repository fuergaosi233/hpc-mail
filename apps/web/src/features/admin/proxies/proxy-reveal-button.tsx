import { Eye } from 'lucide-react';
import { useState } from 'react';
import type { ProxyCredential } from '@hpc-mail/shared';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { IconButton } from '@/components/ui/icon-button';
import { toast } from '@/components/ui/toast';
import { adminProxyApi } from './proxies-api';
import { errorMessage } from '../shared/vendor-ui';

/**
 * 查看明文凭据：每次点击都 POST /reveal（服务端审计 proxy.reveal），结果只存在本组件状态里，
 * 关闭即丢弃，不进 TanStack Query 缓存（也不用 useMutation，避免留在 mutation 缓存里）。
 */
export function ProxyRevealButton({ proxyId, label }: { proxyId: number; label: string }) {
  const [credential, setCredential] = useState<ProxyCredential | null>(null);
  const [loading, setLoading] = useState(false);

  const reveal = async () => {
    setLoading(true);
    try {
      setCredential(await adminProxyApi.reveal(proxyId));
    } catch (error) {
      toast({ title: errorMessage(error, '读取凭据失败'), variant: 'error' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <IconButton size="sm" aria-label={`查看凭据 ${label}`} title="查看凭据" disabled={loading} onClick={() => void reveal()}>
        <Eye className="size-4" />
      </IconButton>
      <Dialog open={credential !== null} onOpenChange={(open) => !open && setCredential(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader title="代理凭据" description="已记录查看审计。关闭后凭据从页面清除。" />
          {credential && (
            <DialogBody className="flex flex-col gap-3 text-sm">
              <div className="flex flex-col gap-1">
                <span className="text-xs text-ink-tertiary">代理 URL</span>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 break-all rounded-md bg-canvas px-2 py-1.5 text-[13px]">{credential.url}</code>
                  <CopyButton value={credential.url} ariaLabel="复制代理 URL" size="sm" />
                </div>
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
                <dt className="text-ink-tertiary">主机</dt>
                <dd className="break-all">{credential.host}:{credential.port}</dd>
                <dt className="text-ink-tertiary">用户名</dt>
                <dd className="break-all">{credential.username || '—'}</dd>
                <dt className="text-ink-tertiary">密码</dt>
                <dd className="flex items-center gap-2 break-all">
                  {credential.password || '—'}
                  {credential.password && <CopyButton value={credential.password} ariaLabel="复制密码" size="sm" className="h-7 px-1.5" />}
                </dd>
              </dl>
            </DialogBody>
          )}
          <DialogFooter>
            <Button variant="secondary" onClick={() => setCredential(null)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
