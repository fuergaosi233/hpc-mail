import { useQueries, useQueryClient } from '@tanstack/react-query';
import { Check, Shuffle, X } from 'lucide-react';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { claimMailboxRequestSchema, domainSchema, localPartSchema } from '@hpc-mail/shared';
import { invalidateMailboxOwnership, queryKeys } from '@/api/query-keys';
import { mailboxApi } from '@/api/resources';
import { Button } from '@/components/ui/button';
import { writeClipboard } from '@/components/ui/copy-button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import {
  claimList,
  type ClaimListResult,
  MAX_BATCH_CLAIM,
  parseBatchCount,
  randomLocalPart,
  randomLocalParts,
  unavailableMessage,
} from './claim-helpers';

export interface ClaimDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  domains: string[];
}

interface Row {
  id: number;
  localPart: string;
}

/** 前缀输入停手多久后才去查可用性 */
const CHECK_DEBOUNCE_MS = 400;

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
  const baseId = useId();
  const nextRowId = useRef(1);
  const newRow = (localPart = ''): Row => ({ id: nextRowId.current++, localPart });

  const [rows, setRows] = useState<Row[]>(() => [newRow()]);
  const [domain, setDomain] = useState(domains[0] ?? '');
  /** 每行已「停手」的前缀：与当前输入一致时才发可用性查询 */
  const [settled, setSettled] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [countText, setCountText] = useState('1');
  /** 认领进行中已认领的个数；null 表示没在认领 */
  const [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<ClaimListResult | null>(null);
  const count = parseBatchCount(countText);
  const claiming = progress !== null;

  useEffect(() => {
    if (!domains.includes(domain)) setDomain(domains[0] ?? '');
  }, [open, domain, domains]);

  useEffect(() => {
    const timer = globalThis.setTimeout(
      () => setSettled(Object.fromEntries(rows.map((row) => [row.id, row.localPart]))),
      CHECK_DEBOUNCE_MS,
    );
    return () => globalThis.clearTimeout(timer);
  }, [rows]);

  const domainValid = domains.includes(domain) && domainSchema.safeParse(domain).success;

  const checks = useQueries({
    queries: rows.map((row) => ({
      queryKey: queryKeys.mailboxes.availability(settled[row.id] ?? '', domain),
      queryFn: () => mailboxApi.availability(settled[row.id]!, domain),
      enabled:
        open &&
        !result &&
        domainValid &&
        settled[row.id] === row.localPart &&
        localPartSchema.safeParse(row.localPart).success,
    })),
  });

  const duplicates = new Set(
    rows.map((row) => row.localPart).filter((value, index, all) => value && all.indexOf(value) !== index),
  );

  const states = rows.map((row, index) => {
    const parsed = localPartSchema.safeParse(row.localPart);
    const valid = parsed.success;
    const check = checks[index]!;
    const settledNow = settled[row.id] === row.localPart && !check.isFetching;
    const formatError = row.localPart.length > 0 && !valid ? parsed.error?.issues[0]?.message : null;
    const unavailable = valid && settledNow && check.data ? unavailableMessage(check.data) : null;
    return {
      valid,
      checking: valid && settled[row.id] === row.localPart && check.isFetching,
      available: valid && settledNow && check.data?.available === true,
      error: formatError ?? (duplicates.has(row.localPart) ? '与其他地址重复' : null) ?? unavailable,
    };
  });
  const canSubmit = domainValid && !claiming && states.every((state) => state.valid && state.error === null);

  function reset() {
    setRows([newRow()]);
    setSettled({});
    setError(null);
    setCountText('1');
    setProgress(null);
    setResult(null);
  }

  function close() {
    onOpenChange(false);
    reset();
  }

  const editRow = (id: number, value: string) => {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, localPart: value } : row)));
    setError(null);
  };

  /** 随机值无需等防抖：直接视为已停手，立即查可用性 */
  const fillRows = (next: Row[]) => {
    setRows(next);
    setSettled(Object.fromEntries(next.map((row) => [row.id, row.localPart])));
    setError(null);
  };

  const randomizeAll = () => fillRows(randomLocalParts(count).map((value) => newRow(value)));

  const rerollRow = (id: number) => {
    const taken = new Set(rows.map((row) => row.localPart));
    let value = randomLocalPart();
    while (taken.has(value)) value = randomLocalPart();
    fillRows(rows.map((row) => (row.id === id ? { ...row, localPart: value } : row)));
  };

  const removeRow = (id: number) => fillRows(rows.filter((row) => row.id !== id));

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!domainValid) {
      setError('可用域名已变更，请重新选择');
      return;
    }
    for (const row of rows) {
      const parsed = claimMailboxRequestSchema.safeParse({ localPart: row.localPart, domain });
      if (!parsed.success) {
        setError(parsed.error.issues[0]?.message ?? '请检查输入');
        return;
      }
    }
    if (!canSubmit) return;

    setProgress(0);
    const outcome = await claimList(
      rows.map((row) => row.localPart),
      domain,
      mailboxApi.claim,
      setProgress,
    );
    setProgress(null);

    if (outcome.claimed.length > 0) {
      invalidateMailboxOwnership(queryClient);
    } else {
      // 一个都没认领上：只需让已缓存的可用性重新核对，被占用的行会随即标红
      void queryClient.invalidateQueries({ queryKey: [...queryKeys.mailboxes.root, 'availability'] });
    }
    if (outcome.claimed.length === 0) {
      setError(
        outcome.stoppedBy ??
          (rows.length === 1 ? '该地址已被占用，换一个前缀试试' : '这些地址刚被别人认领，请修改后重试'),
      );
      return;
    }
    if (rows.length === 1) {
      announceClaimed(outcome.claimed[0]!);
      close();
      return;
    }
    setResult(outcome);
  };

  /** 回到表单，只保留没认领成功的前缀继续修改 */
  const editRemaining = () => {
    if (!result) return;
    const next = result.remaining.map((value) => newRow(value));
    setResult(null);
    setError(null);
    setCountText(String(next.length));
    fillRows(next);
  };

  const copyAll = () =>
    void writeClipboard(result?.claimed.join('\n') ?? '').then((ok) =>
      toast(ok ? { title: '已复制全部地址', variant: 'success' } : { title: '复制失败，请手动选择', variant: 'error' }),
    );

  const multiple = rows.length > 1;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // 认领进行中不允许关闭，否则结果无处可看
        if (!next && claiming) return;
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
                {result.remaining.length > 0 && `，还有 ${result.remaining.length} 个未认领`}
              </p>
              <ul className="max-h-60 divide-y divide-line overflow-y-auto rounded-lg border border-line bg-surface">
                {result.claimed.map((address) => (
                  <li key={address} className="break-all px-3 py-2 text-sm text-ink">
                    {address}
                  </li>
                ))}
              </ul>
              {result.remaining.length > 0 && (
                <p role="alert" className="text-sm text-critical">
                  {result.stoppedBy
                    ? `未能认领满：${result.stoppedBy}`
                    : `${result.remaining.length} 个地址刚被别人认领，可返回修改后重试。`}
                </p>
              )}
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={copyAll}>
                复制全部地址
              </Button>
              {result.remaining.length > 0 && !result.stoppedBy && (
                <Button type="button" variant="secondary" onClick={editRemaining}>
                  返回修改
                </Button>
              )}
              <Button type="button" onClick={close}>
                完成
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={(event) => void handleSubmit(event)}>
            <DialogBody className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label htmlFor={`${baseId}-domain`} className="text-sm font-medium text-ink">
                  域名
                </label>
                <Select value={domain} onValueChange={setDomain}>
                  <SelectTrigger id={`${baseId}-domain`} aria-label="域名">
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

              <div className="flex flex-col gap-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label htmlFor={`${baseId}-0`} className="text-sm font-medium text-ink">
                    邮箱地址
                    <span className="ml-0.5 text-critical">*</span>
                  </label>
                  <div className="flex items-center gap-1">
                    <Button type="button" variant="ghost" size="sm" disabled={claiming} onClick={randomizeAll}>
                      <Shuffle className="size-4" />
                      随机生成
                    </Button>
                    <Input
                      aria-label="随机生成个数"
                      title={`一次最多 ${MAX_BATCH_CLAIM} 个`}
                      inputMode="numeric"
                      autoComplete="off"
                      value={countText}
                      disabled={claiming}
                      className="h-8 w-12 px-1 text-center"
                      onChange={(event) => setCountText(event.target.value.replace(/\D/g, '').slice(0, 2))}
                      onBlur={() => setCountText(String(count))}
                      onKeyDown={(event) => {
                        // 回车不提交表单（那会直接认领），等同点击旁边的随机生成
                        if (event.key !== 'Enter') return;
                        event.preventDefault();
                        randomizeAll();
                      }}
                    />
                    <span className="text-sm text-ink-secondary">个</span>
                  </div>
                </div>

                <ul className={cn('flex flex-col gap-2', multiple && 'max-h-72 overflow-y-auto p-1 -m-1')}>
                  {rows.map((row, index) => {
                    const state = states[index]!;
                    const errorId = `${baseId}-${index}-error`;
                    const address = `${row.localPart}@${domain}`;
                    return (
                      <li key={row.id} className="flex flex-col gap-1">
                        <div className="flex items-center gap-1.5">
                          <div className="relative min-w-0 flex-1">
                            <Input
                              id={`${baseId}-${index}`}
                              aria-label={multiple ? `前缀 ${index + 1}` : '前缀'}
                              aria-describedby={state.error ? errorId : undefined}
                              autoComplete="off"
                              autoCapitalize="none"
                              spellCheck={false}
                              placeholder="例如 hello"
                              value={row.localPart}
                              invalid={state.error !== null}
                              disabled={claiming}
                              className="pr-8"
                              onChange={(event) => editRow(row.id, event.target.value.trim().toLowerCase())}
                            />
                            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2">
                              {state.checking && <Spinner className="size-4 text-ink-tertiary" />}
                              {state.available && (
                                <>
                                  <Check className="size-4 text-positive" aria-hidden />
                                  <span className="sr-only">{address} 可以认领</span>
                                </>
                              )}
                              {state.error && <X className="size-4 text-critical" aria-hidden />}
                            </span>
                          </div>
                          <span className="max-w-[40%] shrink-0 truncate text-sm text-ink-tertiary" aria-hidden>
                            @{domain}
                          </span>
                          {multiple && (
                            <>
                              <IconButton
                                size="sm"
                                aria-label={`重新随机第 ${index + 1} 个`}
                                disabled={claiming}
                                onClick={() => rerollRow(row.id)}
                              >
                                <Shuffle className="size-4" />
                              </IconButton>
                              <IconButton
                                size="sm"
                                aria-label={`移除第 ${index + 1} 个`}
                                disabled={claiming}
                                onClick={() => removeRow(row.id)}
                              >
                                <X className="size-4" />
                              </IconButton>
                            </>
                          )}
                        </div>
                        {state.error && (
                          <p id={errorId} className="text-xs text-critical">
                            {state.error}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
                <p role="status" aria-live="polite" className="min-h-5 text-xs text-ink-tertiary">
                  {claiming
                    ? `正在认领 ${progress}/${rows.length}…`
                    : multiple
                      ? `共 ${rows.length} 个地址，可直接修改任一个，或再点「随机生成」换一批，确认无误后点「认领 ${rows.length} 个」。`
                      : ''}
                </p>
              </div>
              {error && (
                <p role="alert" className="text-sm text-critical">
                  {error}
                </p>
              )}
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="secondary" disabled={claiming} onClick={close}>
                取消
              </Button>
              <Button type="submit" loading={claiming} disabled={!canSubmit}>
                {multiple ? `认领 ${rows.length} 个` : '认领'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
