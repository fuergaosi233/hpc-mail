import { useQueries, useQueryClient } from '@tanstack/react-query';
import { Check, Share2, Shuffle, X } from 'lucide-react';
import { type FormEvent, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { type ClaimPlan, type ClaimPlanStrategy, claimMailboxRequestSchema, localPartSchema, MAX_BATCH_CLAIM, MAX_BATCH_SHARE_MAILBOXES } from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';
import { invalidateMailboxOwnership, queryKeys } from '@/api/query-keys';
import { mailboxApi } from '@/api/resources';
import { Button } from '@/components/ui/button';
import { writeClipboard } from '@/components/ui/copy-button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { SegmentedControl, type SegmentedOption } from '@/components/ui/segmented-control';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { useCurrentUser } from '@/lib/use-session';
import { BATCH_SHARE_DESCRIPTION, BatchSharePanel, batchShareTitle } from './batch-share-panel';
import {
  type AddressDraft,
  claimList,
  type ClaimListResult,
  createAvailabilityLoader,
  parseBatchCount,
  randomAddresses,
  randomLocalPart,
  randomPick,
  unavailableMessage,
} from './claim-helpers';

export interface ClaimDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  domains: string[];
  /** 打开时预选的域名（如从托管域名详情页进入）；不在可认领列表里时忽略 */
  initialDomain?: string;
}

interface Row extends AddressDraft {
  id: number;
}

const sameAddress = (a: AddressDraft | undefined, b: AddressDraft) =>
  a !== undefined && a.localPart === b.localPart && a.domain === b.domain;
const addressOf = (draft: AddressDraft) => `${draft.localPart}@${draft.domain}`;
const settledOf = (rows: Row[]): Record<number, AddressDraft> =>
  Object.fromEntries(rows.map((row) => [row.id, { localPart: row.localPart, domain: row.domain }]));

/** 前缀输入停手多久后才去查可用性 */
const CHECK_DEBOUNCE_MS = 400;

/** 随机生成时后缀怎么定：固定用最近选的域名，另两种由后端按参与随机的域名分配 */
type SuffixMode = 'fixed' | ClaimPlanStrategy;

const SUFFIX_MODES: readonly SegmentedOption<SuffixMode>[] = [
  { value: 'fixed', label: '固定后缀' },
  { value: 'uniform', label: '均匀随机' },
  { value: 'claude', label: 'Claude 0 封号' },
];

const SUFFIX_HINTS: Record<SuffixMode, string> = {
  fixed: '都用当前选择的域名',
  uniform: '从参与随机的可用域名中等概率选',
  claude: '有历史 Claude 封号记录的域名禁止认领，其余按账号数分配、每天限量；0 封号不保证未来不会封号',
};

/** 后端没能分配满时的说明 */
function shortfallText(plan: ClaimPlan): string | null {
  if (plan.shortfall === 0) return null;
  const allocated = plan.items.length;
  const partial = allocated > 0 ? `，只分配了 ${allocated} 个` : '';
  if (plan.reason === 'quota') return allocated > 0 ? `额度不足，只分配了 ${allocated} 个` : '认领额度已用完，无法再分配';
  if (plan.reason === 'daily_limit') return `0 封号后缀今天的新增名额已用完${partial}，可稍后再试`;
  if (plan.reason === 'domain_quota') return `可选后缀的每域名额已用完${partial}${plan.strategy === 'claude' ? '；有历史封号记录的域名在此模式下禁止认领' : '，可手动选择其他域名'}`;
  if (allocated > 0) return `可用后缀的名额不足，只分配了 ${allocated} 个`;
  return plan.strategy === 'claude' ? '没有可分配的 Claude 0 封号后缀；有历史封号记录的域名在此模式下禁止认领' : '没有参与随机的可用域名，可手动选择域名';
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

/** 仅展开的那一行挂载域名选项，避免大批量地址把隐藏选项重复渲染数万次。 */
function DomainSelect({ value, domains, label, disabled, onValueChange }: {
  value: string;
  domains: string[];
  label: string;
  disabled: boolean;
  onValueChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selectDomain = (next: string) => {
    // 隐藏选项卸载时 Radix 的原生表单桥接可能发出空值，不把它当成域名选择。
    if (domains.includes(next)) onValueChange(next);
  };
  return (
    <Select value={value} onValueChange={selectDomain} disabled={disabled} open={open} onOpenChange={setOpen}>
      <SelectTrigger aria-label={label} className="h-9 w-auto min-w-0 max-w-full gap-1.5 px-2.5">
        <SelectValue placeholder="选择域名">{value}</SelectValue>
      </SelectTrigger>
      {open && (
        <SelectContent>
          {domains.map((domain) => <SelectItem key={domain} value={domain}>{domain}</SelectItem>)}
        </SelectContent>
      )}
    </Select>
  );
}

export function ClaimDialog({ open, onOpenChange, domains, initialDomain }: ClaimDialogProps) {
  const queryClient = useQueryClient();
  const baseId = useId();
  const nextRowId = useRef(1);
  /** 最近选的域名：非随机后缀时，新生成的地址都用它 */
  const [domain, setDomain] = useState(domains[0] ?? '');
  const newRow = (draft: AddressDraft = { localPart: '', domain }): Row => ({ id: nextRowId.current++, ...draft });

  const [rows, setRows] = useState<Row[]>(() => [newRow()]);
  /** 每行已「停手」的地址：与当前输入一致时才发可用性查询 */
  const [settled, setSettled] = useState<Record<number, AddressDraft>>({});
  const [error, setError] = useState<string | null>(null);
  const [countText, setCountText] = useState('1');
  const [mode, setMode] = useState<SuffixMode>('fixed');
  /** 最近一次后端分配：单个重新随机的候选与未分配满的说明 */
  const [plan, setPlan] = useState<ClaimPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  /** 关闭对话框后返回的分配结果作废 */
  const planRequest = useRef(0);
  /** 认领请求进行中：多个地址一次批量请求，只显示整体进行中状态 */
  const [claiming, setClaiming] = useState(false);
  const [result, setResult] = useState<ClaimListResult | null>(null);
  /** 结果页切到「共享」步骤，及这批邮箱已共享给的用户名 */
  const [sharing, setSharing] = useState(false);
  const [sharedWith, setSharedWith] = useState<string[]>([]);
  const [sharePending, setSharePending] = useState(false);
  /** 回到结果页后把焦点还给「共享给…」，否则落在对话框容器上 */
  const shareButton = useRef<HTMLButtonElement>(null);
  const refocusShare = useRef(false);
  const currentUser = useCurrentUser();
  const count = parseBatchCount(countText);
  const strategy = mode === 'claude' ? 'claude' : undefined;
  /** 同一轮发起的可用性查询（随机生成一批）合成一次批量请求 */
  const [checkAvailability] = useState(() =>
    createAvailabilityLoader({
      one: (item) => mailboxApi.availability(item.localPart, item.domain, item.strategy),
      many: (items) => mailboxApi.batchAvailability(items),
    }),
  );

  // 域名列表变化后，已选的域名可能不再可用：回退到第一个
  useEffect(() => {
    const fallback = domains[0] ?? '';
    if (!domains.includes(domain)) setDomain(fallback);
    setRows((current) =>
      current.some((row) => row.domain !== fallback && !domains.includes(row.domain))
        ? current.map((row) => (domains.includes(row.domain) ? row : { ...row, domain: fallback }))
        : current,
    );
  }, [open, domain, domains]);

  // 带着域名打开：预选它，尚未填写前缀的行一并换成该域名
  useEffect(() => {
    if (!open || !initialDomain || !domains.includes(initialDomain)) return;
    setDomain(initialDomain);
    setRows((current) => current.map((row) => (row.localPart ? row : { ...row, domain: initialDomain })));
  }, [open, initialDomain, domains]);

  useEffect(() => {
    const timer = globalThis.setTimeout(
      () => setSettled(settledOf(rows)),
      CHECK_DEBOUNCE_MS,
    );
    return () => globalThis.clearTimeout(timer);
  }, [rows]);

  const checks = useQueries({
    queries: rows.map((row) => {
      const target = settled[row.id] ?? { localPart: '', domain: row.domain };
      return {
        queryKey: [...queryKeys.mailboxes.availability(target.localPart, target.domain), strategy ?? 'uniform'],
        queryFn: () => checkAvailability({ ...target, ...(strategy ? { strategy } : {}) }),
        notifyOnChangeProps: ['data', 'isFetching'] as const,
        // 失败由 loader 整批重试；逐行重试各有定时器，会绕过合批变成一串单个请求
        retry: false,
        enabled:
          open &&
          !result &&
          domains.includes(row.domain) &&
          sameAddress(settled[row.id], row) &&
          localPartSchema.safeParse(row.localPart).success,
      };
    }),
  });

  const addressCounts = new Map<string, number>();
  for (const row of rows) addressCounts.set(addressOf(row), (addressCounts.get(addressOf(row)) ?? 0) + 1);

  const states = rows.map((row, index) => {
    const parsed = localPartSchema.safeParse(row.localPart);
    const valid = parsed.success;
    const domainOk = domains.includes(row.domain);
    const check = checks[index]!;
    const isSettled = sameAddress(settled[row.id], row);
    const settledNow = isSettled && !check.isFetching;
    const formatError = row.localPart.length > 0 && !valid ? parsed.error?.issues[0]?.message : null;
    const unavailable = valid && settledNow && check.data ? unavailableMessage(check.data) : null;
    const duplicate = row.localPart && (addressCounts.get(addressOf(row)) ?? 0) > 1 ? '与其他地址重复' : null;
    return {
      valid: valid && domainOk,
      checking: valid && isSettled && check.isFetching,
      available: valid && settledNow && check.data?.available === true,
      error: formatError ?? duplicate ?? unavailable,
    };
  });
  const canSubmit = !claiming && !planning && states.every((state) => state.valid && state.error === null);

  function reset() {
    setRows([newRow()]);
    setSettled({});
    setError(null);
    setCountText('1');
    setMode('fixed');
    setPlan(null);
    setPlanning(false);
    planRequest.current++;
    setClaiming(false);
    setResult(null);
    setSharing(false);
    setSharedWith([]);
    setSharePending(false);
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
    setSettled(settledOf(next));
    setError(null);
  };

  /** 向后端要 n 个后缀；失败显示原因并返回 null */
  const requestPlan = async (n: number, strategy: ClaimPlanStrategy): Promise<ClaimPlan | null> => {
    const request = ++planRequest.current;
    setPlanning(true);
    setError(null);
    try {
      const next = await mailboxApi.randomPlan(n, strategy);
      if (request !== planRequest.current) return null;
      setPlan(next);
      return next;
    } catch (err) {
      if (request === planRequest.current) setError(err instanceof ApiError ? err.message : '随机分配失败，请重试');
      return null;
    } finally {
      if (request === planRequest.current) setPlanning(false);
    }
  };

  const changeMode = (value: SuffixMode) => {
    if (claiming || value === mode) return;
    // 模式切换立即作废旧规划；旧请求稍后返回也不能覆盖当前地址或提示。
    planRequest.current++;
    setPlanning(false);
    setPlan(null);
    setError(null);
    setMode(value);
  };

  const randomizeAll = async () => {
    if (mode === 'fixed') {
      fillRows(randomAddresses(count, () => domain).map((draft) => newRow(draft)));
      return;
    }
    const next = await requestPlan(count, mode);
    // 一个都没分到时保留现有的行，只显示原因
    if (!next || next.items.length === 0) return;
    const seen = new Set<string>();
    fillRows(
      next.items.map(({ domain: itemDomain }) => {
        let draft: AddressDraft = { localPart: randomLocalPart(), domain: itemDomain };
        while (seen.has(addressOf(draft))) draft = { ...draft, localPart: randomLocalPart() };
        seen.add(addressOf(draft));
        return newRow(draft);
      }),
    );
  };

  /** 单个重新随机：均匀模式从参与随机的域名里换后缀；Claude 模式与固定后缀只换前缀，保持整批分配 */
  const rerollRow = async (id: number) => {
    let pool: string[] | null = null;
    if (mode === 'uniform') {
      pool = (plan ?? (await requestPlan(1, 'uniform')))?.pool.filter((item) => domains.includes(item)) ?? [];
      if (pool.length === 0) return;
    }
    const taken = new Set(rows.map(addressOf));
    const current = rows.find((row) => row.id === id);
    let next: AddressDraft = { localPart: randomLocalPart(), domain: pool ? randomPick(pool) : (current?.domain ?? domain) };
    while (taken.has(addressOf(next))) next = { ...next, localPart: randomLocalPart() };
    // 随机值无需等防抖；等待分配期间其他行可能已被修改，只替换这一行
    setRows((latest) => latest.map((row) => (row.id === id ? { ...row, ...next } : row)));
    setSettled((latest) => ({ ...latest, [id]: next }));
    setError(null);
  };

  const changeDomain = (id: number, value: string) => {
    setDomain(value);
    fillRows(rows.map((row) => (row.id === id ? { ...row, domain: value } : row)));
  };

  const removeRow = (id: number) => fillRows(rows.filter((row) => row.id !== id));

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (rows.some((row) => !domains.includes(row.domain))) {
      setError('可用域名已变更，请重新选择');
      return;
    }
    for (const row of rows) {
      const parsed = claimMailboxRequestSchema.safeParse({ localPart: row.localPart, domain: row.domain, strategy });
      if (!parsed.success) {
        setError(parsed.error.issues[0]?.message ?? '请检查输入');
        return;
      }
    }
    if (!canSubmit) return;

    setClaiming(true);
    const outcome = await claimList(rows, mailboxApi, strategy);
    setClaiming(false);

    // 结果未知时也可能已认领了一部分：同样刷新邮箱列表与归属相关缓存
    if (outcome.claimed.length > 0 || outcome.uncertain) {
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
      announceClaimed(outcome.claimed[0]!.address);
      close();
      return;
    }
    setResult(outcome);
  };

  /** 回到表单，只保留没认领成功的前缀继续修改 */
  const editRemaining = () => {
    if (!result) return;
    const next = result.remaining.map((draft) => newRow(draft));
    setResult(null);
    setSharedWith([]);
    setError(null);
    setCountText(String(next.length));
    fillRows(next);
  };

  const copyAll = () =>
    void writeClipboard(result?.claimed.map((mailbox) => mailbox.address).join('\n') ?? '').then((ok) =>
      toast(ok ? { title: '已复制全部地址', variant: 'success' } : { title: '复制失败，请手动选择', variant: 'error' }),
    );

  const multiple = rows.length > 1;
  const planShortfall = plan ? shortfallText(plan) : null;
  const busy = claiming || planning;
  /** 管理员认领多个后，可把认领成功的这批邮箱一键共享给其他人（结果页只在认领成功后出现） */
  const shareLimitExceeded = currentUser.role === 'admin' && result !== null && result.claimed.length > MAX_BATCH_SHARE_MAILBOXES;
  const canShare = currentUser.role === 'admin' && result !== null && !shareLimitExceeded;
  const leaveShare = () => {
    refocusShare.current = true;
    setSharing(false);
  };
  useLayoutEffect(() => {
    if (sharing || !refocusShare.current) return;
    refocusShare.current = false;
    shareButton.current?.focus();
  }, [sharing]);
  const header =
    sharing && result
      ? { title: batchShareTitle(result.claimed.length), description: BATCH_SHARE_DESCRIPTION }
      : {
          title: '认领邮箱地址',
          description: result ? '新认领的地址已加入「我的邮箱」。' : '认领后即可收发该地址的邮件，并可见其全部历史邮件。',
        };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // 认领或共享进行中不允许关闭，否则结果无处可看
        if (!next && (claiming || sharePending)) return;
        // 共享步骤里按 Esc 或点遮罩只回到结果页，不丢掉这批认领结果
        if (!next && sharing) {
          leaveShare();
          return;
        }
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className="max-w-lg" showClose={!sharing}>
        <DialogHeader {...header} />
        {result ? (
          <>
            {/* 共享结果的播报区放在两个步骤之外、始终挂载，名单更新时读屏才能可靠播报 */}
            <p
              role="status"
              className={cn(
                'break-words border-b border-line bg-canvas px-6 py-2 text-sm text-ink-secondary',
                sharedWith.length === 0 && 'sr-only',
              )}
            >
              {sharedWith.length > 0 && `已共享给：${sharedWith.join('、')}`}
            </p>
            {/* 共享步骤期间结果页只隐藏不卸载：回来时不重建，提示不会被重复播报 */}
            <DialogBody hidden={sharing} className="flex flex-col gap-3">
              <p role="status" className="text-sm text-ink">
                已认领 {result.claimed.length} 个地址
                {result.remaining.length > 0 && `，还有 ${result.remaining.length} 个未认领`}
              </p>
              <ul className="max-h-60 divide-y divide-line overflow-y-auto rounded-lg border border-line bg-surface">
                {result.claimed.map((mailbox) => (
                  <li key={mailbox.id} className="break-all px-3 py-2 text-sm text-ink">
                    {mailbox.address}
                  </li>
                ))}
              </ul>
              {shareLimitExceeded && (
                <p className="text-sm text-ink-secondary">
                  一次最多共享 {MAX_BATCH_SHARE_MAILBOXES} 个邮箱，请前往「我的邮箱」管理共享。
                </p>
              )}
              {result.remaining.length > 0 && (
                <p role="alert" className="text-sm text-critical">
                  {result.stoppedBy
                    ? `未能认领满：${result.stoppedBy}`
                    : `${result.remaining.length} 个地址刚被别人认领，可返回修改后重试。`}
                </p>
              )}
            </DialogBody>
            <DialogFooter hidden={sharing} className="flex-wrap">
              <Button type="button" variant="secondary" onClick={copyAll}>
                复制全部地址
              </Button>
              {result.remaining.length > 0 && !result.stoppedBy && (
                <Button type="button" variant="secondary" onClick={editRemaining}>
                  返回修改
                </Button>
              )}
              {canShare && (
                <Button ref={shareButton} type="button" variant="secondary" onClick={() => setSharing(true)}>
                  <Share2 className="size-4" />
                  共享给…
                </Button>
              )}
              <Button type="button" onClick={close}>
                完成
              </Button>
            </DialogFooter>
            {sharing && (
              <BatchSharePanel
                mailboxIds={result.claimed.map((mailbox) => mailbox.id)}
                currentUserId={currentUser.id}
                onBack={leaveShare}
                onShared={(names) => {
                  setSharedWith((prev) => [...new Set([...prev, ...names])]);
                  leaveShare();
                }}
                onPendingChange={setSharePending}
              />
            )}
          </>
        ) : (
          <form onSubmit={(event) => void handleSubmit(event)}>
            <DialogBody className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label htmlFor={`${baseId}-0`} className="text-sm font-medium text-ink">
                    邮箱地址
                    <span className="ml-0.5 text-critical">*</span>
                  </label>
                  <div className="flex items-center gap-1">
                    <Button type="button" variant="ghost" size="sm" loading={planning} disabled={busy} onClick={() => void randomizeAll()}>
                      {!planning && <Shuffle className="size-4" />}
                      随机生成
                    </Button>
                    <Input
                      aria-label="随机生成个数"
                      title={`一次最多 ${MAX_BATCH_CLAIM} 个`}
                      inputMode="numeric"
                      autoComplete="off"
                      value={countText}
                      disabled={busy}
                      className="h-8 w-12 px-1 text-center"
                      onChange={(event) => {
                        const digits = event.target.value.replace(/\D/g, '');
                        setCountText(Number(digits) > MAX_BATCH_CLAIM ? String(MAX_BATCH_CLAIM) : digits);
                      }}
                      onBlur={() => setCountText(String(count))}
                      onKeyDown={(event) => {
                        // 回车不提交表单（那会直接认领），等同点击旁边的随机生成
                        if (event.key !== 'Enter') return;
                        event.preventDefault();
                        if (!planning) void randomizeAll();
                      }}
                    />
                    <span className="text-sm text-ink-secondary">个</span>
                  </div>
                </div>

                {domains.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-secondary">
                      <span className="whitespace-nowrap">随机后缀</span>
                      <SegmentedControl
                        aria-label="随机后缀模式"
                        value={mode}
                        onValueChange={changeMode}
                        options={SUFFIX_MODES}
                        className="h-8"
                      />
                    </div>
                    <p className="text-xs text-ink-tertiary">{SUFFIX_HINTS[mode]}</p>
                  </div>
                )}
                {planShortfall && (
                  <p className="text-xs font-medium text-caution">{planShortfall}</p>
                )}

                <ul className={cn('flex flex-col gap-2', multiple && 'max-h-72 gap-3 overflow-y-auto p-1 -m-1 sm:gap-2')}>
                  {rows.map((row, index) => {
                    const state = states[index]!;
                    const errorId = `${baseId}-${index}-error`;
                    const address = addressOf(row);
                    return (
                      <li key={row.id} className="flex flex-col gap-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <div className={cn('relative flex-1', multiple ? 'order-1 min-w-[9rem]' : 'min-w-0')}>
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
                          <div className={cn('flex min-w-0 items-center gap-1.5', multiple && 'order-3 w-full sm:order-2 sm:w-auto')}>
                            <span className="text-sm text-ink-tertiary" aria-hidden>
                              @
                            </span>
                            {domains.length > 1 ? (
                              <DomainSelect
                                value={row.domain}
                                domains={domains}
                                label={multiple ? `域名 ${index + 1}` : '域名'}
                                disabled={claiming}
                                onValueChange={(value) => changeDomain(row.id, value)}
                              />
                            ) : (
                              <span className="truncate text-sm text-ink-tertiary" aria-hidden>
                                {row.domain}
                              </span>
                            )}
                          </div>
                          {multiple && (
                            <div className="order-2 flex items-center gap-1 sm:order-3">
                              <IconButton
                                size="sm"
                                aria-label={`重新随机第 ${index + 1} 个`}
                                disabled={busy}
                                onClick={() => void rerollRow(row.id)}
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
                            </div>
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
                    ? multiple ? `正在认领 ${rows.length} 个地址…` : '正在认领…'
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
