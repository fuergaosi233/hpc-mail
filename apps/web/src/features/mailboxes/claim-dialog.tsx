import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Shuffle, X } from 'lucide-react';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { claimMailboxRequestSchema, domainSchema, localPartSchema } from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';
import { invalidateMailboxOwnership, queryKeys } from '@/api/query-keys';
import { mailboxApi } from '@/api/resources';
import { Button } from '@/components/ui/button';
import { writeClipboard } from '@/components/ui/copy-button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import {
  type BatchClaimResult,
  claimRandomBatch,
  MAX_BATCH_CLAIM,
  parseBatchCount,
  randomLocalPart,
  unavailableMessage,
} from './claim-helpers';

export interface ClaimDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  domains: string[];
}

function announceClaimed(address: string) {
  toast({
    title: '地址认领成功',
    description: address,
    variant: 'success',
    action: {
      label: '复制地址',
      onClick: () =>
        void writeClipboard(address).then((ok) =>
          toast(ok ? { title: '已复制到剪贴板', variant: 'success' } : { title: '复制失败，请手动选择', variant: 'error' }),
        ),
    },
  });
}

export function ClaimDialog({ open, onOpenChange, domains }: ClaimDialogProps) {
  const queryClient = useQueryClient();
  const inputId = useId();
  const statusId = `${inputId}-status`;
  const [localPart, setLocalPart] = useState('');
  const [domain, setDomain] = useState(domains[0] ?? '');
  const [debounced, setDebounced] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [countText, setCountText] = useState('1');
  /** 批量认领进行中已认领的个数；null 表示没有在批量认领 */
  const [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<(BatchClaimResult & { requested: number }) | null>(null);
  const count = parseBatchCount(countText);
  const batching = progress !== null;

  useEffect(() => {
    if (!domains.includes(domain)) setDomain(domains[0] ?? '');
  }, [open, domain, domains]);

  useEffect(() => {
    const timer = globalThis.setTimeout(() => setDebounced(localPart), 400);
    return () => globalThis.clearTimeout(timer);
  }, [localPart]);

  const localValid = localPartSchema.safeParse(localPart).success;
  const domainValid = domains.includes(domain) && domainSchema.safeParse(domain).success;

  const availability = useQuery({
    queryKey: queryKeys.mailboxes.availability(debounced, domain),
    queryFn: () => mailboxApi.availability(debounced, domain),
    enabled: open && localValid && domainValid && debounced.length > 0 && debounced === localPart,
  });

  const claim = useMutation({
    mutationFn: () => mailboxApi.claim({ localPart, domain }),
    onSuccess: (created) => {
      announceClaimed(created?.address ?? `${localPart}@${domain}`);
      invalidateMailboxOwnership(queryClient);
      onOpenChange(false);
      reset();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : '认领失败，请重试'),
  });

  function reset() {
    setLocalPart('');
    setDebounced('');
    setError(null);
    setCountText('1');
    setResult(null);
  }

  function close() {
    onOpenChange(false);
    reset();
  }

  const claimBatch = async () => {
    setError(null);
    if (!domainValid) {
      setError('可用域名已变更，请重新选择');
      return;
    }
    setProgress(0);
    const outcome = await claimRandomBatch(count, domain, mailboxApi.claim, setProgress);
    setProgress(null);
    if (outcome.claimed.length === 0) {
      setError(outcome.stoppedBy ?? '认领失败，请重试');
      return;
    }
    invalidateMailboxOwnership(queryClient);
    setResult({ ...outcome, requested: count });
  };

  const copyAll = () =>
    void writeClipboard(result?.claimed.join('\n') ?? '').then((ok) =>
      toast(ok ? { title: '已复制全部地址', variant: 'success' } : { title: '复制失败，请手动选择', variant: 'error' }),
    );

  const changeLocalPart = (value: string) => {
    setLocalPart(value);
    setError(null);
  };

  const randomize = () => {
    const next = randomLocalPart();
    changeLocalPart(next);
    // 随机值无需等防抖，立即查可用性
    setDebounced(next);
  };

  const settled = debounced === localPart && !availability.isFetching;
  const checking = localValid && debounced === localPart && availability.isFetching;
  const showAvailable = localValid && settled && availability.data?.available === true;
  const unavailable = localValid && settled && availability.data ? unavailableMessage(availability.data) : null;
  const formatError = localPart.length > 0 && !localValid ? localPartSchema.safeParse(localPart).error?.issues[0]?.message : null;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!domainValid) {
      setError('可用域名已变更，请重新选择');
      return;
    }
    const parsed = claimMailboxRequestSchema.safeParse({ localPart, domain });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '请检查输入');
      return;
    }
    if (unavailable) {
      setError(unavailable);
      return;
    }
    claim.mutate();
  };

  const statusText = formatError ?? unavailable ?? (showAvailable ? `${localPart}@${domain} 可以认领` : null);
  const statusTone = formatError || unavailable ? 'text-critical' : showAvailable ? 'text-positive' : 'text-ink-tertiary';

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // 批量认领进行中不允许关闭，否则结果无处可看
        if (!next && batching) return;
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader
          title="认领邮箱地址"
          description={result ? '新认领的地址已加入「我的邮箱」。' : '认领后即可收发该地址的邮件，并可见其全部历史邮件。'}
        />
        {result ? (
          <>
            <DialogBody className="flex flex-col gap-3">
              <p role="status" className="text-sm text-ink">
                已认领 {result.claimed.length} 个地址
                {result.claimed.length < result.requested && `（计划 ${result.requested} 个）`}
              </p>
              <ul className="max-h-60 divide-y divide-line overflow-y-auto rounded-lg border border-line bg-surface">
                {result.claimed.map((address) => (
                  <li key={address} className="break-all px-3 py-2 text-sm text-ink">
                    {address}
                  </li>
                ))}
              </ul>
              {result.stoppedBy && (
                <p role="alert" className="text-sm text-critical">
                  未能认领满：{result.stoppedBy}
                </p>
              )}
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={copyAll}>
                复制全部地址
              </Button>
              <Button type="button" onClick={close}>
                完成
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={handleSubmit}>
            <DialogBody className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor={inputId} className="text-sm font-medium text-ink">
                    邮箱地址
                    <span className="ml-0.5 text-critical">*</span>
                  </label>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={batching}
                      onClick={count > 1 ? () => void claimBatch() : randomize}
                    >
                      <Shuffle className="size-4" />
                      {count > 1 ? '随机生成并认领' : '随机生成'}
                    </Button>
                    <Input
                      aria-label="随机生成个数"
                      inputMode="numeric"
                      autoComplete="off"
                      value={countText}
                      disabled={batching}
                      className="h-8 w-12 px-1 text-center"
                      onChange={(event) => setCountText(event.target.value.replace(/\D/g, '').slice(0, 2))}
                      onBlur={() => setCountText(String(count))}
                      onKeyDown={(event) => {
                        // 回车不提交表单（那会去认领前缀框里的内容），等同点击旁边的随机按钮
                        if (event.key !== 'Enter') return;
                        event.preventDefault();
                        if (count > 1) void claimBatch();
                        else randomize();
                      }}
                    />
                    <span className="text-sm text-ink-secondary">个</span>
                  </div>
                </div>
                {(count > 1 || batching) && (
                  <p role="status" aria-live="polite" className="text-xs text-ink-tertiary">
                    {batching
                      ? `正在认领 ${progress}/${count}…`
                      : `将在 @${domain} 下随机生成 ${count} 个地址并直接全部认领（最多 ${MAX_BATCH_CLAIM} 个）`}
                  </p>
                )}
                <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
                  <div className="relative">
                    <Input
                      id={inputId}
                      aria-label="前缀"
                      aria-describedby={statusText ? statusId : undefined}
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      placeholder="例如 hello"
                      value={localPart}
                      invalid={Boolean(formatError || unavailable)}
                      className="pr-8"
                      onChange={(event) => changeLocalPart(event.target.value.trim().toLowerCase())}
                    />
                    <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2">
                      {checking && <Spinner className="size-4 text-ink-tertiary" />}
                      {showAvailable && <Check className="size-4 text-positive" />}
                      {unavailable && <X className="size-4 text-critical" />}
                    </span>
                  </div>
                  <span className="text-sm text-ink-tertiary" aria-hidden>
                    @
                  </span>
                  <Select value={domain} onValueChange={setDomain}>
                    <SelectTrigger aria-label="域名">
                      <SelectValue placeholder="选择域名" />
                    </SelectTrigger>
                    <SelectContent>
                      {domains.map((item) => (
                        <SelectItem key={item} value={item}>
                          {item}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <p id={statusId} role="status" aria-live="polite" className={cn('min-h-5 text-xs', statusTone)}>
                  {statusText ?? (checking ? '正在检查是否可认领…' : '')}
                </p>
              </div>
              {error && error !== unavailable && (
                <p role="alert" className="text-sm text-critical">
                  {error}
                </p>
              )}
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="secondary" disabled={batching} onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button
                type="submit"
                loading={claim.isPending}
                disabled={batching || !localValid || !domainValid || unavailable !== null}
              >
                认领
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
