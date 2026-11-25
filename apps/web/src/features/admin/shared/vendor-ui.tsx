import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ComponentPropsWithRef, type ReactNode, useEffect, useId, useState } from 'react';
import { formatCents, SECRET_MASK, type Settings, type UpdateSettingsRequest } from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';
import { queryKeys } from '@/api/query-keys';
import { adminApi } from '@/api/resources';
import { Button } from '@/components/ui/button';
import { inputClassName } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';

/** 代理池 / 1024 采购 / 域名采购三个管理页共用的小部件 */

export function errorMessage(error: unknown, fallback = '操作失败，请重试'): string {
  return error instanceof ApiError || error instanceof Error ? error.message || fallback : fallback;
}

/** 美分 → $x.xx；null 显示 — */
export const money = (cents: number | null | undefined) => (cents === null || cents === undefined ? '—' : formatCents(cents));

export function isConflict(error: unknown): boolean {
  return error instanceof ApiError && (error.code === 'conflict' || error.httpStatus === 409);
}

export function Panel({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('flex flex-col gap-4 rounded-lg border border-line bg-surface p-5', className)}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {description && <p className="mt-0.5 text-[13px] text-ink-secondary">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export function InfoItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-xs text-ink-tertiary">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-1.5 break-words text-sm text-ink">{children}</dd>
    </div>
  );
}

/** 原生下拉：管理页表单用，便于键盘操作与测试 */
export function NativeSelect({ className, ...props }: ComponentPropsWithRef<'select'>) {
  return (
    <select
      className={cn(inputClassName, 'border-line-strong pr-8 focus:border-accent focus:ring-2 focus:ring-accent/20', className)}
      {...props}
    />
  );
}

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: (id: string) => ReactNode; className?: string }) {
  const id = useId();
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </label>
      {children(id)}
      {hint && <p className="text-xs text-ink-tertiary">{hint}</p>}
    </div>
  );
}

export function ToggleField({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex flex-col gap-0.5">
        <label htmlFor={id} className="text-sm font-medium text-ink">
          {label}
        </label>
        {description && <span className="text-xs text-ink-tertiary">{description}</span>}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

/**
 * 密文设置字段：服务端回显 SECRET_MASK 表示已配置。输入框显示为空 + 「已配置」占位；
 * 输入后再删空回到「保持原值」（提交 SECRET_MASK）；删除已保存值用「清除」按钮（提交空串）。
 */
export function SecretField({
  label,
  hint,
  value,
  saved,
  onChange,
}: {
  label: string;
  hint?: ReactNode;
  value: string;
  /** 已保存的值（掩码或空） */
  saved: string | undefined;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const savedSecret = saved === SECRET_MASK;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </label>
      <PasswordInput
        id={id}
        autoComplete="off"
        placeholder={value === SECRET_MASK ? '已配置（输入可替换，清除请用按钮）' : savedSecret ? '保存后将删除已配置的值' : '未配置'}
        value={value === SECRET_MASK ? '' : value}
        onChange={(event) => {
          const next = event.target.value.trim();
          onChange(next === '' && savedSecret ? SECRET_MASK : next);
        }}
      />
      {hint && <p className="text-xs text-ink-tertiary">{hint}</p>}
      {value && (
        <div>
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange('')}>
            清除{label}
          </Button>
        </div>
      )}
    </div>
  );
}

const centsToDollarText = (cents: number) => (cents / 100).toFixed(2);

/** 美元输入，内部以整数美分保存；0 表示禁止采购 */
export function MoneyField({
  label,
  hint,
  cents,
  maxCents,
  onChange,
}: {
  label: string;
  hint?: ReactNode;
  cents: number;
  maxCents: number;
  onChange: (cents: number) => void;
}) {
  const [text, setText] = useState(() => centsToDollarText(cents));
  useEffect(() => {
    // 外部重置草稿时同步；正在输入的文本若等值则保留原样
    setText((current) => (Math.round(Number(current) * 100) === cents ? current : centsToDollarText(cents)));
  }, [cents]);
  return (
    <Field label={label} hint={hint}>
      {(id) => (
        <div className="flex items-center gap-1.5">
          <span className="text-sm text-ink-tertiary">$</span>
          <input
            id={id}
            inputMode="decimal"
            className={cn(inputClassName, 'w-36 border-line-strong text-right focus:border-accent focus:ring-2 focus:ring-accent/20')}
            value={text}
            onChange={(event) => {
              const raw = event.target.value.trim();
              setText(raw);
              if (!/^\d*(?:\.\d{0,2})?$/.test(raw)) return;
              const next = Math.round(Number(raw || '0') * 100);
              if (Number.isFinite(next)) onChange(Math.max(0, Math.min(maxCents, next)));
            }}
            onBlur={() => setText(centsToDollarText(cents))}
          />
        </div>
      )}
    </Field>
  );
}

export function IntField({
  label,
  hint,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  hint?: ReactNode;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <Field label={label} hint={hint}>
      {(id) => (
        <input
          id={id}
          type="number"
          min={min}
          max={max}
          className={cn(inputClassName, 'w-28 border-line-strong text-right focus:border-accent focus:ring-2 focus:ring-accent/20')}
          value={String(value)}
          onChange={(event) => {
            const n = Math.floor(Number(event.target.value));
            if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, n)));
          }}
        />
      )}
    </Field>
  );
}

/** 距 expiresAt 的剩余秒数（每秒刷新）；已过期为 0 */
export function useCountdown(expiresAt: string | null | undefined): number | null {
  const target = expiresAt ? new Date(expiresAt).getTime() : NaN;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!Number.isFinite(target)) return;
    const timer = globalThis.setInterval(() => setNow(Date.now()), 1000);
    return () => globalThis.clearInterval(timer);
  }, [target]);
  if (!Number.isFinite(target)) return null;
  return Math.max(0, Math.floor((target - now) / 1000));
}

export function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function CountdownText({ expiresAt, expiredText = '报价已过期' }: { expiresAt: string; expiredText?: string }) {
  const left = useCountdown(expiresAt);
  if (left === null) return null;
  return left > 0 ? (
    <span className="tabular-nums text-ink-secondary">报价剩余 {formatCountdown(left)}</span>
  ) : (
    <span className="text-critical">{expiredText}</span>
  );
}

type VendorKey = 'proxy1024' | 'spaceship';

/**
 * 功能页自己的「配置」卡片：只读写 settings 的一个 key（PUT 只带该 key），不经过系统设置页。
 * 返回已保存值（掩码）与可编辑草稿。
 */
export function useVendorSettings<K extends VendorKey>(key: K, onSaved?: () => void) {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: queryKeys.admin.settings, queryFn: () => adminApi.getSettings() });
  const saved = query.data?.[key] as Settings[K] | undefined;
  const [draft, setDraft] = useState<Settings[K] | null>(null);
  const savedJson = saved ? JSON.stringify(saved) : '';
  useEffect(() => {
    if (savedJson) setDraft(JSON.parse(savedJson) as Settings[K]);
  }, [savedJson]);

  const save = useMutation({
    mutationFn: (value: Settings[K]) => adminApi.updateSettings({ [key]: value } as UpdateSettingsRequest),
    onSuccess: (settings) => {
      queryClient.setQueryData(queryKeys.admin.settings, settings);
      toast({ title: '配置已保存', variant: 'success' });
      onSaved?.();
    },
    onError: (err) => toast({ title: errorMessage(err, '保存失败，请重试'), variant: 'error' }),
  });

  const patch = (updater: (value: Settings[K]) => void) =>
    setDraft((prev) => {
      if (!prev) return prev;
      const next = structuredClone(prev);
      updater(next);
      return next;
    });

  const dirty = draft !== null && JSON.stringify(draft) !== savedJson;
  return { query, saved, draft, patch, save, dirty, reset: () => savedJson && setDraft(JSON.parse(savedJson) as Settings[K]) };
}

/** 下载文本文件（导出代理） */
export function downloadText(filename: string, content: string, mime = 'text/plain'): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
