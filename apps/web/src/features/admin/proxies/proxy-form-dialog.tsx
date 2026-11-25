import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import {
  PROXY_PROTOCOLS,
  proxyInputSchema,
  type ProxyProtocol,
  type ProxyView,
  type UpdateProxyRequest,
  updateProxyRequestSchema,
} from '@hpc-mail/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { adminProxyApi, invalidateProxyData } from './proxies-api';
import { errorMessage, Field, NativeSelect } from '../shared/vendor-ui';

interface FormState {
  label: string;
  provider: string;
  protocol: ProxyProtocol;
  host: string;
  port: string;
  username: string;
  /** 编辑时空串 = 保持原密码（除非勾选清除） */
  password: string;
  clearPassword: boolean;
  product: string;
  country: string;
  region: string;
  city: string;
  /** datetime-local 文本，空 = 不过期 */
  expiresAt: string;
  status: 'active' | 'disabled';
  maxBindings: string;
  notes: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** ISO → datetime-local（本地时区） */
export function isoToLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** datetime-local → ISO（UTC）；空 → null */
export function localInputToIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function initialState(proxy: ProxyView | null): FormState {
  return {
    label: proxy?.label ?? '',
    provider: proxy?.provider ?? 'manual',
    protocol: proxy?.protocol ?? 'http',
    host: proxy?.host ?? '',
    port: proxy ? String(proxy.port) : '',
    username: proxy?.username ?? '',
    password: '',
    clearPassword: false,
    product: proxy?.product ?? '',
    country: proxy?.country ?? '',
    region: proxy?.region ?? '',
    city: proxy?.city ?? '',
    expiresAt: isoToLocalInput(proxy?.expiresAt ?? null),
    status: proxy?.status === 'disabled' ? 'disabled' : 'active',
    maxBindings: String(proxy?.maxBindings ?? 1),
    notes: proxy?.notes ?? '',
  };
}

function toInput(form: FormState) {
  return {
    label: form.label,
    provider: form.provider || 'manual',
    protocol: form.protocol,
    host: form.host,
    port: Number(form.port),
    username: form.username,
    password: form.password,
    product: form.product,
    country: form.country,
    region: form.region,
    city: form.city,
    expiresAt: localInputToIso(form.expiresAt),
    status: form.status,
    maxBindings: Number(form.maxBindings),
    notes: form.notes,
  };
}

/** 编辑：只提交改动过的字段；密码留空表示保持原值 */
export function buildProxyPatch(proxy: ProxyView, form: FormState): UpdateProxyRequest {
  const next = toInput(form);
  const patch: Record<string, unknown> = {};
  const before: Record<string, unknown> = {
    label: proxy.label,
    provider: proxy.provider,
    protocol: proxy.protocol,
    host: proxy.host,
    port: proxy.port,
    username: proxy.username,
    product: proxy.product,
    country: proxy.country,
    region: proxy.region,
    city: proxy.city,
    expiresAt: localInputToIso(isoToLocalInput(proxy.expiresAt)),
    status: proxy.status === 'disabled' ? 'disabled' : 'active',
    maxBindings: proxy.maxBindings,
    notes: proxy.notes,
  };
  for (const [key, value] of Object.entries(next)) {
    if (key === 'password') continue;
    if (before[key] !== value) patch[key] = value;
  }
  // 已过期的代理改了到期时间且选了「可用」：一并提交状态，重新启用
  if (proxy.status === 'expired' && 'expiresAt' in patch && form.status === 'active') patch.status = 'active';
  if (form.clearPassword) patch.password = '';
  else if (form.password) patch.password = form.password;
  return patch as UpdateProxyRequest;
}

export function ProxyFormDialog({
  open,
  proxy,
  onClose,
}: {
  open: boolean;
  /** null = 新增 */
  proxy: ProxyView | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(() => initialState(proxy));
  const [error, setError] = useState('');
  useEffect(() => {
    if (open) {
      setForm(initialState(proxy));
      setError('');
    }
  }, [open, proxy]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((prev) => ({ ...prev, [key]: value }));

  const save = useMutation({
    mutationFn: async () => {
      if (proxy) {
        const patch = buildProxyPatch(proxy, form);
        if (Object.keys(patch).length === 0) return proxy;
        const parsed = updateProxyRequestSchema.safeParse(patch);
        if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? '输入有误');
        return adminProxyApi.update(proxy.id, patch);
      }
      const parsed = proxyInputSchema.safeParse(toInput(form));
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(issue ? `${issue.path.join('.') || '输入'}：${issue.message}` : '输入有误');
      }
      return adminProxyApi.create(parsed.data);
    },
    onSuccess: (saved) => {
      invalidateProxyData(queryClient);
      toast({ title: proxy ? '代理已更新' : `已添加代理 #${saved.id}`, variant: 'success' });
      onClose();
    },
    onError: (err) => setError(errorMessage(err, '保存失败')),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError('');
    save.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !save.isPending && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader title={proxy ? `编辑代理 #${proxy.id}` : '添加代理'} description="任意供应商均可手工添加；密码加密存储，列表不返回密码。" />
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <DialogBody className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="协议">
              {(id) => (
                <NativeSelect id={id} value={form.protocol} onChange={(e) => set('protocol', e.target.value as ProxyProtocol)}>
                  {PROXY_PROTOCOLS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
            <Field label="供应商" hint="小写字母、数字、. _ -">
              {(id) => <Input id={id} value={form.provider} maxLength={64} onChange={(e) => set('provider', e.target.value)} />}
            </Field>
            <Field label="主机">
              {(id) => <Input id={id} value={form.host} required maxLength={255} placeholder="1.2.3.4 或 proxy.example.com" onChange={(e) => set('host', e.target.value)} />}
            </Field>
            <Field label="端口">
              {(id) => <Input id={id} value={form.port} required inputMode="numeric" onChange={(e) => set('port', e.target.value.replace(/\D/g, ''))} />}
            </Field>
            <Field label="用户名">
              {(id) => <Input id={id} value={form.username} maxLength={255} autoComplete="off" onChange={(e) => set('username', e.target.value)} />}
            </Field>
            <Field
              label="密码"
              hint={proxy?.hasPassword ? '已配置密码：留空保持不变' : undefined}
            >
              {(id) => (
                <PasswordInput
                  id={id}
                  autoComplete="new-password"
                  maxLength={255}
                  disabled={form.clearPassword}
                  placeholder={proxy?.hasPassword ? '已配置（输入可替换）' : '无密码'}
                  value={form.password}
                  onChange={(e) => set('password', e.target.value)}
                />
              )}
            </Field>
            {proxy?.hasPassword && (
              <label className="flex items-center gap-2 text-sm text-ink sm:col-span-2">
                <input type="checkbox" className="size-4" checked={form.clearPassword} onChange={(e) => set('clearPassword', e.target.checked)} />
                清除已保存的密码
              </label>
            )}
            <Field label="备注名">
              {(id) => <Input id={id} value={form.label} maxLength={100} onChange={(e) => set('label', e.target.value)} />}
            </Field>
            <Field label="产品类型" hint="如 static_isp、residential_sticky，可留空">
              {(id) => <Input id={id} value={form.product} maxLength={64} onChange={(e) => set('product', e.target.value)} />}
            </Field>
            <Field label="国家（两位代码）">
              {(id) => <Input id={id} value={form.country} maxLength={2} placeholder="US" onChange={(e) => set('country', e.target.value.toUpperCase())} />}
            </Field>
            <Field label="城市">
              {(id) => <Input id={id} value={form.city} maxLength={100} onChange={(e) => set('city', e.target.value)} />}
            </Field>
            <Field label="地区/州">
              {(id) => <Input id={id} value={form.region} maxLength={100} onChange={(e) => set('region', e.target.value)} />}
            </Field>
            <Field label="到期时间" hint="留空表示不过期；到期后自动标记为已过期">
              {(id) => <Input id={id} type="datetime-local" value={form.expiresAt} onChange={(e) => set('expiresAt', e.target.value)} />}
            </Field>
            <Field label="状态">
              {(id) => (
                <NativeSelect id={id} value={form.status} onChange={(e) => set('status', e.target.value as 'active' | 'disabled')}>
                  <option value="active">可用</option>
                  <option value="disabled">停用</option>
                </NativeSelect>
              )}
            </Field>
            <Field label="最多绑定地址数" hint="1–1000；默认一个代理只给一个邮箱">
              {(id) => <Input id={id} value={form.maxBindings} inputMode="numeric" onChange={(e) => set('maxBindings', e.target.value.replace(/\D/g, ''))} />}
            </Field>
            <Field label="备注" className="sm:col-span-2">
              {(id) => <Textarea id={id} rows={2} maxLength={1000} value={form.notes} onChange={(e) => set('notes', e.target.value)} />}
            </Field>
            {error && (
              <p role="alert" className="text-sm text-critical sm:col-span-2">
                {error}
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={save.isPending}>
              取消
            </Button>
            <Button type="submit" loading={save.isPending}>
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
