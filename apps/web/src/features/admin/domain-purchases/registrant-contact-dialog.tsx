import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { type RegistrantContactRequest, registrantContactRequestSchema } from '@hpc-mail/shared';
import { queryKeys } from '@/api/query-keys';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { domainPurchaseApi } from './domain-purchases-api';
import { errorMessage, Field } from '../shared/vendor-ui';

type ContactForm = Record<keyof RegistrantContactRequest, string>;

const EMPTY: ContactForm = {
  firstName: '',
  lastName: '',
  organization: '',
  email: '',
  address1: '',
  address2: '',
  city: '',
  stateProvince: '',
  postalCode: '',
  country: '',
  phone: '',
  phoneExt: '',
};

const FIELDS: { key: keyof RegistrantContactRequest; label: string; hint?: string; wide?: boolean; required?: boolean }[] = [
  { key: 'firstName', label: '名', required: true },
  { key: 'lastName', label: '姓', required: true },
  { key: 'organization', label: '组织（可选）', wide: true },
  { key: 'email', label: '邮箱', required: true, wide: true },
  { key: 'address1', label: '地址', required: true, wide: true },
  { key: 'address2', label: '地址第二行（可选）', wide: true },
  { key: 'city', label: '城市', required: true },
  { key: 'stateProvince', label: '州/省（可选）' },
  { key: 'postalCode', label: '邮编（可选）' },
  { key: 'country', label: '国家（两位代码）', required: true },
  { key: 'phone', label: '电话', hint: '格式 +国家码.号码，例如 +1.4155550100', required: true },
  { key: 'phoneExt', label: '分机（可选）' },
];

/** 在 Spaceship 创建注册人联系人，并把返回的 contactId 存进 settings.spaceship.registrantContactId */
export function RegistrantContactDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<ContactForm>(EMPTY);
  const [error, setError] = useState('');
  useEffect(() => {
    if (open) setError('');
  }, [open]);

  const save = useMutation({
    mutationFn: (body: RegistrantContactRequest) => domainPurchaseApi.saveContact(body),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.settings });
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.domainPurchaseStatus });
      toast({ title: `已保存注册人联系人 ${result.contactId}`, variant: 'success' });
      onClose();
    },
    onError: (err) => setError(errorMessage(err, '保存失败')),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError('');
    const raw = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v.trim() === '' ? undefined : v.trim()]));
    const parsed = registrantContactRequestSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const label = FIELDS.find((f) => f.key === issue?.path[0])?.label;
      return setError(`${label ? `${label}：` : ''}${issue?.message ?? '输入有误'}`);
    }
    save.mutate(parsed.data);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !save.isPending && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader title="注册人联系人" description="用于所有新注册域名的注册人/管理/技术/账单联系人（Spaceship 联系人）。" />
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <DialogBody className="grid grid-cols-2 gap-3">
            {FIELDS.map((f) => (
              <Field key={f.key} label={f.label} hint={f.hint} className={f.wide ? 'col-span-2' : undefined}>
                {(id) => (
                  <Input
                    id={id}
                    required={f.required}
                    value={form[f.key]}
                    onChange={(e) => setForm((prev) => ({ ...prev, [f.key]: f.key === 'country' ? e.target.value.toUpperCase() : e.target.value }))}
                  />
                )}
              </Field>
            ))}
            {error && (
              <p role="alert" className="col-span-2 text-sm text-critical">
                {error}
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={save.isPending}>
              取消
            </Button>
            <Button type="submit" loading={save.isPending}>
              保存到 Spaceship
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
