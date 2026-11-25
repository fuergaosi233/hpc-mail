import * as PopoverPrimitive from '@radix-ui/react-popover';
import { Waypoints } from 'lucide-react';
import type { MyProxyBinding } from '@hpc-mail/shared';
import { CopyButton } from '@/components/ui/copy-button';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';

const STATUS_TEXT: Record<string, string> = { active: '可用', disabled: '已停用', expired: '已过期' };

/** 地址旁的「代理」小徽标：点开显示该地址绑定的代理 URL，可一键复制 */
export function MyProxyBadge({ binding }: { binding: MyProxyBinding }) {
  const { proxy } = binding;
  const inactive = proxy.status !== 'active';
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          aria-label={`${binding.address} 的代理`}
          className={cn(
            'inline-flex h-6 shrink-0 items-center gap-1 rounded-sm px-1.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
            inactive ? 'bg-critical-soft text-critical' : 'bg-accent-soft text-accent',
          )}
        >
          <Waypoints className="size-3.5" aria-hidden />
          代理
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={6}
          className="z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-lg border border-line bg-surface p-3 text-sm shadow-lg"
        >
          <p className="font-medium text-ink">
            {proxy.protocol.toUpperCase()} · {[proxy.country, proxy.city].filter(Boolean).join(' · ') || '未知地区'}
            {inactive && <span className="ml-1.5 text-xs text-critical">{STATUS_TEXT[proxy.status] ?? proxy.status}</span>}
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-md bg-canvas px-2 py-1 text-[12px]">{proxy.url}</code>
            <CopyButton value={proxy.url} ariaLabel={`复制 ${binding.address} 的代理 URL`} size="sm" />
          </div>
          {proxy.expiresAt && <p className="text-xs text-ink-tertiary">到期：{formatDateTime(proxy.expiresAt)}</p>}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
