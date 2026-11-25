import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { Proxy1024Captcha } from '@hpc-mail/shared';
import { queryKeys } from '@/api/query-keys';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { proxy1024Api } from './proxy-1024-api';
import { errorMessage } from '../shared/vendor-ui';

/** 只接受 data:image/…;base64 图片，避免把服务端字段当任意 URL 加载 */
export function safeImageSrc(src: string): string | null {
  return /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=\s]+$/.test(src) ? src : null;
}

/**
 * 1024 登录的滑块验证：服务端代取验证码图片，管理员在这里拖动拼图块（不做自动识别），
 * 提交的 x 为拼图块左上角在原图上的横坐标，y 沿用验证码给出的 initialY。
 */
export function SlideCaptchaDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [captcha, setCaptcha] = useState<Proxy1024Captcha | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [x, setX] = useState(0);
  const [imageWidth, setImageWidth] = useState(0);

  /** keepError：登录失败后自动换图时保留失败原因 */
  const load = useCallback(async (keepError = false) => {
    setLoading(true);
    if (!keepError) setError('');
    setCaptcha(null);
    try {
      const next = await proxy1024Api.captcha();
      setCaptcha(next);
      setX(next.initialX);
    } catch (err) {
      setError(errorMessage(err, '获取验证码失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
    else {
      setCaptcha(null);
      setError('');
    }
  }, [open, load]);

  const submit = async () => {
    if (!captcha) return;
    setSubmitting(true);
    setError('');
    try {
      const status = await proxy1024Api.login({ captchaId: captcha.captchaId, x: Math.round(x), y: captcha.initialY });
      queryClient.setQueryData(queryKeys.admin.proxy1024Status, status);
      toast({ title: status.session === 'ok' ? `已登录 1024：${status.email}` : '登录已提交', variant: 'success' });
      onClose();
    } catch (err) {
      setError(errorMessage(err, '登录失败'));
      // 验证码一次性：失败后换一张
      void load(true);
    } finally {
      setSubmitting(false);
    }
  };

  const master = captcha ? safeImageSrc(captcha.masterImage) : null;
  const tile = captcha ? safeImageSrc(captcha.tileImage) : null;
  const maxX = Math.max(0, (imageWidth || 300) - (captcha?.tileWidth ?? 0));

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !submitting && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader title="登录 1024proxy" description="拖动下方滑块，把拼图块移到缺口位置后提交。" />
        <DialogBody className="flex flex-col gap-3">
          {loading || (!captcha && !error) ? (
            <Skeleton className="h-40 w-full rounded-md" />
          ) : captcha && master && tile ? (
            <>
              <div className="relative self-start overflow-hidden rounded-md border border-line" data-testid="captcha-stage">
                <img
                  src={master}
                  alt="验证码背景"
                  className="block max-w-none select-none"
                  draggable={false}
                  onLoad={(event) => setImageWidth(event.currentTarget.naturalWidth)}
                />
                <img
                  src={tile}
                  alt="拼图块"
                  draggable={false}
                  className="pointer-events-none absolute max-w-none select-none"
                  style={{ left: x, top: captcha.initialY, width: captcha.tileWidth, height: captcha.tileHeight }}
                />
              </div>
              <input
                type="range"
                aria-label="拼图块位置"
                min={0}
                max={maxX}
                step={1}
                value={x}
                onChange={(event) => setX(Number(event.target.value))}
                className="w-full"
              />
            </>
          ) : captcha ? (
            <p className="text-sm text-critical">验证码图片格式无法识别，请换一张。</p>
          ) : null}
          {error && (
            <p role="alert" className="text-sm text-critical">
              {error}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => void load(false)} disabled={loading || submitting}>
            <RefreshCw className="size-4" />
            换一张
          </Button>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button loading={submitting} disabled={!captcha || !master || !tile || loading} onClick={() => void submit()}>
            提交登录
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
