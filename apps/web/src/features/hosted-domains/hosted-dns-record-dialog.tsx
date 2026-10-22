import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import {
  HOSTED_DNS_CAA_TAGS,
  HOSTED_DNS_RECORD_TYPES,
  HOSTED_DNS_TTL_AUTO,
  type HostedDnsRecord,
  type HostedDnsRecordInput,
  type HostedDnsRecordType,
  type HostedDomain,
  hostedDnsConflictReason,
  hostedDnsFqdn,
  hostedDnsRecordInputSchema,
} from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { HOSTED_DNS_TTL_OPTIONS, HOSTED_DNS_TYPE_HINTS, formatDnsTtl } from './hosted-dns-meta';
import { hostedDomainApi } from './hosted-domains-api';
import { refreshAfterDnsWriteError, storeDnsRecord } from './use-hosted-domains';

type CaaTag = (typeof HOSTED_DNS_CAA_TAGS)[number];

/** 表单草稿：数字也按字符串保存，提交时统一交给共享 schema 校验 */
interface Draft {
  type: HostedDnsRecordType;
  name: string;
  content: string;
  priority: string;
  weight: string;
  port: string;
  target: string;
  flags: '0' | '128';
  tag: CaaTag;
  value: string;
  ttl: string;
  comment: string;
}

const EMPTY: Draft = {
  type: 'A',
  name: '',
  content: '',
  priority: '10',
  weight: '5',
  port: '',
  target: '',
  flags: '0',
  tag: 'issue',
  value: '',
  ttl: String(HOSTED_DNS_TTL_AUTO),
  comment: '',
};

const CONTENT_FIELDS: Partial<Record<HostedDnsRecordType, { label: string; placeholder: string }>> = {
  A: { label: 'IPv4 地址', placeholder: '203.0.113.10' },
  AAAA: { label: 'IPv6 地址', placeholder: '2001:db8::1' },
  CNAME: { label: '目标域名', placeholder: 'target.example.com' },
  TXT: { label: '记录值', placeholder: '例如服务商提供的验证字符串' },
  MX: { label: '邮件服务器', placeholder: 'mx.example.com' },
};

const CAA_TAG_LABELS: Record<CaaTag, string> = {
  issue: 'issue（允许签发证书）',
  issuewild: 'issuewild（允许签发通配符证书）',
  iodef: 'iodef（违规报告地址）',
};

const NUMBER_FIELDS = new Set(['priority', 'srv.priority', 'srv.weight', 'srv.port']);

function draftFrom(record: HostedDnsRecord): Draft {
  return {
    ...EMPTY,
    type: record.type as HostedDnsRecordType,
    name: record.name,
    content: record.srv || record.caa ? '' : record.content,
    priority: String(record.priority ?? record.srv?.priority ?? EMPTY.priority),
    weight: String(record.srv?.weight ?? EMPTY.weight),
    port: record.srv ? String(record.srv.port) : '',
    target: record.srv?.target ?? '',
    flags: record.caa?.flags === 128 ? '128' : '0',
    tag: record.caa?.tag ?? EMPTY.tag,
    value: record.caa?.value ?? '',
    ttl: String(record.ttl),
    comment: record.comment,
  };
}

const int = (value: string) => (value.trim() === '' ? Number.NaN : Number(value));

function toInput(draft: Draft): HostedDnsRecordInput {
  const base = { name: draft.name, ttl: Number(draft.ttl), comment: draft.comment };
  switch (draft.type) {
    case 'MX':
      return { type: 'MX', ...base, content: draft.content, priority: int(draft.priority) };
    case 'SRV':
      return {
        type: 'SRV',
        ...base,
        srv: { priority: int(draft.priority), weight: int(draft.weight), port: int(draft.port), target: draft.target },
      };
    case 'CAA':
      return { type: 'CAA', ...base, caa: { flags: draft.flags === '128' ? 128 : 0, tag: draft.tag, value: draft.value } };
    default:
      return { type: draft.type, ...base, content: draft.content };
  }
}

/** zod 错误按字段路径归位；数字字段的英文默认文案换成统一说明 */
function fieldErrors(issues: { path: PropertyKey[]; message: string }[]): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path.map(String).join('.');
    errors[key] ??= NUMBER_FIELDS.has(key) ? '请填写 0–65535 的整数' : issue.message;
  }
  return errors;
}

/** 新增或编辑一条解析；record 为空时新增 */
export function HostedDnsRecordDialog({
  domain,
  record,
  open,
  onOpenChange,
}: {
  domain: HostedDomain;
  record?: HostedDnsRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const editing = Boolean(record);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(record ? draftFrom(record) : EMPTY);
    setErrors({});
    setFormError(null);
  }, [open, record]);

  const save = useMutation({
    mutationFn: (body: HostedDnsRecordInput) =>
      record
        ? hostedDomainApi.updateDnsRecord(domain.id, record.id, body)
        : hostedDomainApi.createDnsRecord(domain.id, body),
    onSuccess: (saved) => {
      storeDnsRecord(queryClient, domain.id, saved);
      toast({ title: record ? '解析记录已保存' : '解析记录已添加', variant: 'success' });
      onOpenChange(false);
    },
    onError: (error) => {
      setFormError(error instanceof ApiError ? error.message : '保存失败，请重试');
      refreshAfterDnsWriteError(queryClient, domain.id, error);
    },
  });

  const update = (patch: Partial<Draft>, ...keys: string[]) => {
    setDraft((prev) => ({ ...prev, ...patch }));
    setFormError(null);
    if (keys.some((key) => errors[key])) {
      setErrors((prev) => Object.fromEntries(Object.entries(prev).filter(([key]) => !keys.includes(key))));
    }
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (save.isPending) return;
    const parsed = hostedDnsRecordInputSchema.safeParse(toInput(draft));
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error.issues));
      setFormError(null);
      return;
    }
    const data = parsed.data;
    setErrors({});
    // 与邮箱记录冲突的组合在本地先拦下，不发请求
    const conflict = hostedDnsConflictReason(
      { type: data.type, fqdn: hostedDnsFqdn(data.name, domain.domain), content: 'content' in data ? data.content : '' },
      domain.domain,
    );
    if (conflict) {
      setFormError(conflict);
      return;
    }
    setFormError(null);
    save.mutate(data);
  };

  const pending = save.isPending;
  const contentField = CONTENT_FIELDS[draft.type];
  const ttlOptions: number[] = [...HOSTED_DNS_TTL_OPTIONS];
  if (!ttlOptions.includes(Number(draft.ttl))) ttlOptions.push(Number(draft.ttl));

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader
          title={editing ? '编辑解析记录' : '添加解析记录'}
          description={`修改直接写入 ${domain.domain} 的 DNS，保存后通常几分钟内生效。`}
        />
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-col" noValidate>
          <DialogBody className="flex flex-col gap-4">
            <FormField
              label="类型"
              description={editing ? '类型不能修改，请删除后重新添加' : HOSTED_DNS_TYPE_HINTS[draft.type]}
            >
              {(field) => (
                <Select
                  value={draft.type}
                  disabled={editing || pending}
                  onValueChange={(type) => {
                    setDraft((prev) => ({ ...prev, type: type as HostedDnsRecordType }));
                    setErrors({});
                    setFormError(null);
                  }}
                >
                  <SelectTrigger {...field}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {HOSTED_DNS_RECORD_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {type}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </FormField>

            <FormField
              label="名称"
              required
              error={errors.name}
              description={draft.type === 'SRV' ? '格式为 _服务._协议，例如 _sip._tcp' : '@ 表示根域，* 开头表示通配'}
            >
              {(field) => (
                <div className="flex min-w-0 items-stretch">
                  <Input
                    {...field}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="@ 表示根域，例如 www"
                    className="min-w-0 flex-1 rounded-r-none"
                    value={draft.name}
                    invalid={Boolean(errors.name)}
                    disabled={pending}
                    onChange={(event) => update({ name: event.target.value }, 'name')}
                  />
                  <span
                    title={`.${domain.domain}`}
                    className="flex max-w-[55%] items-center rounded-r-md border border-l-0 border-line-strong bg-canvas px-3 text-sm text-ink-tertiary"
                  >
                    <span className="truncate">.{domain.domain}</span>
                  </span>
                </div>
              )}
            </FormField>

            {contentField && (
              <FormField label={contentField.label} required error={errors.content}>
                {(field) =>
                  draft.type === 'TXT' ? (
                    <Textarea
                      {...field}
                      rows={3}
                      spellCheck={false}
                      placeholder={contentField.placeholder}
                      className="break-all"
                      value={draft.content}
                      invalid={Boolean(errors.content)}
                      disabled={pending}
                      onChange={(event) => update({ content: event.target.value }, 'content')}
                    />
                  ) : (
                    <Input
                      {...field}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={contentField.placeholder}
                      value={draft.content}
                      invalid={Boolean(errors.content)}
                      disabled={pending}
                      onChange={(event) => update({ content: event.target.value }, 'content')}
                    />
                  )
                }
              </FormField>
            )}

            {draft.type === 'MX' && (
              <NumberField
                label="优先级"
                description="数字越小越优先"
                value={draft.priority}
                error={errors.priority}
                disabled={pending}
                onChange={(priority) => update({ priority }, 'priority')}
              />
            )}

            {draft.type === 'SRV' && (
              <div className="grid grid-cols-3 gap-x-3 gap-y-4">
                <NumberField
                  label="优先级"
                  value={draft.priority}
                  error={errors['srv.priority']}
                  disabled={pending}
                  onChange={(priority) => update({ priority }, 'srv.priority')}
                />
                <NumberField
                  label="权重"
                  value={draft.weight}
                  error={errors['srv.weight']}
                  disabled={pending}
                  onChange={(weight) => update({ weight }, 'srv.weight')}
                />
                <NumberField
                  label="端口"
                  value={draft.port}
                  error={errors['srv.port']}
                  disabled={pending}
                  onChange={(port) => update({ port }, 'srv.port')}
                />
                <FormField label="目标主机" required error={errors['srv.target']} className="col-span-3">
                  {(field) => (
                    <Input
                      {...field}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="sip.example.com"
                      value={draft.target}
                      invalid={Boolean(errors['srv.target'])}
                      disabled={pending}
                      onChange={(event) => update({ target: event.target.value }, 'srv.target')}
                    />
                  )}
                </FormField>
              </div>
            )}

            {draft.type === 'CAA' && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <FormField label="标志">
                  {(field) => (
                    <Select
                      value={draft.flags}
                      disabled={pending}
                      onValueChange={(flags) => update({ flags: flags as Draft['flags'] })}
                    >
                      <SelectTrigger {...field}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="0">0（默认）</SelectItem>
                        <SelectItem value="128">128（关键）</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                </FormField>
                <FormField label="标签">
                  {(field) => (
                    <Select value={draft.tag} disabled={pending} onValueChange={(tag) => update({ tag: tag as CaaTag })}>
                      <SelectTrigger {...field}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {HOSTED_DNS_CAA_TAGS.map((tag) => (
                          <SelectItem key={tag} value={tag}>
                            {CAA_TAG_LABELS[tag]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </FormField>
                <FormField label="值" required error={errors['caa.value']} className="sm:col-span-2">
                  {(field) => (
                    <Input
                      {...field}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={draft.tag === 'iodef' ? 'mailto:security@example.com' : 'letsencrypt.org'}
                      value={draft.value}
                      invalid={Boolean(errors['caa.value'])}
                      disabled={pending}
                      onChange={(event) => update({ value: event.target.value }, 'caa.value')}
                    />
                  )}
                </FormField>
              </div>
            )}

            <FormField label="TTL" error={errors.ttl}>
              {(field) => (
                <Select value={draft.ttl} disabled={pending} onValueChange={(ttl) => update({ ttl }, 'ttl')}>
                  <SelectTrigger {...field}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ttlOptions.map((ttl) => (
                      <SelectItem key={ttl} value={String(ttl)}>
                        {formatDnsTtl(ttl)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </FormField>

            <FormField label="备注" error={errors.comment} description="可选，最多 100 个字符，仅供备忘，不会被解析">
              {(field) => (
                <Input
                  {...field}
                  autoComplete="off"
                  value={draft.comment}
                  invalid={Boolean(errors.comment)}
                  disabled={pending}
                  onChange={(event) => update({ comment: event.target.value }, 'comment')}
                />
              )}
            </FormField>

            {formError && (
              <p role="alert" className="break-words rounded-md border border-critical/40 bg-critical-soft p-3 text-sm text-critical">
                {formError}
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" disabled={pending} onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" loading={pending}>
              {editing ? '保存' : '添加'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function NumberField({
  label,
  description,
  value,
  error,
  disabled,
  onChange,
}: {
  label: string;
  description?: ReactNode;
  value: string;
  error?: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <FormField label={label} required description={description} error={error}>
      {(field) => (
        <Input
          {...field}
          type="number"
          inputMode="numeric"
          min={0}
          max={65535}
          value={value}
          invalid={Boolean(error)}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </FormField>
  );
}
