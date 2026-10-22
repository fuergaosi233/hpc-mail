import {
  type BatchClaimMailboxResult,
  type ClaimMailboxRequest,
  type Mailbox,
  type MailboxAvailability,
  type MailboxUnavailableReason,
  MAX_BATCH_CLAIM,
} from '@hpc-mail/shared';
import { ApiError, isRejectedRequest } from '@/api/errors';

/** 去掉易混字符（0/o、1/l/i）的小写字母表，读出来、抄下来都不容易错 */
const LETTERS = 'abcdefghjkmnpqrstuvwxyz';
const ALPHANUMERIC = `${LETTERS}23456789`;

/** 随机前缀：字母开头、其余字母数字，满足 LOCAL_PART 规则且不会撞上保留前缀 */
export function randomLocalPart(length = 8, random: (n: number) => Uint32Array = randomValues): string {
  const values = random(length);
  let result = '';
  for (let i = 0; i < length; i++) {
    const alphabet = i === 0 ? LETTERS : ALPHANUMERIC;
    result += alphabet[values[i]! % alphabet.length];
  }
  return result;
}

function randomValues(n: number): Uint32Array {
  return globalThis.crypto.getRandomValues(new Uint32Array(n));
}

const REASON_MESSAGES: Record<MailboxUnavailableReason, string> = {
  taken: '该地址已被占用，换一个前缀试试',
  reserved: '该前缀为系统保留，不能认领',
  quota: '你认领的地址数已达个人上限，释放不用的地址后再试',
  domain_limit: '你在该域名下的认领数已达上限，可换一个域名',
  domain_unavailable: '该域名当前不可认领（不存在或未对你开放）',
  claude_suspended: '该域名有 Claude 封号记录，不能在 Claude 0 封号模式下认领',
};

/** 不可认领时给用户看的原因；后端未给出 reason 时回退到通用提示 */
export function unavailableMessage(availability: Pick<MailboxAvailability, 'available' | 'reason'>): string | null {
  if (availability.available) return null;
  return availability.reason ? REASON_MESSAGES[availability.reason] : '该地址暂不可认领';
}

/** 个数输入框文本 → 1..MAX_BATCH_CLAIM 的整数；空或非法按 1 */
export function parseBatchCount(text: string): number {
  const value = Number.parseInt(text, 10);
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.min(value, MAX_BATCH_CLAIM);
}

/** 一个待认领的地址：前缀 + 域名 */
export interface AddressDraft {
  localPart: string;
  domain: string;
}

/** 从候选里随机取一个 */
export function randomPick<T>(list: readonly T[], random: (n: number) => Uint32Array = randomValues): T {
  return list[random(1)[0]! % list.length]!;
}

/** 一次生成 count 个互不相同的随机地址；域名由 pickDomain 决定（固定一个，或每次从候选里随机） */
export function randomAddresses(
  count: number,
  pickDomain: () => string,
  random: () => string = randomLocalPart,
): AddressDraft[] {
  const seen = new Set<string>();
  const drafts: AddressDraft[] = [];
  while (drafts.length < count) {
    const draft = { localPart: random(), domain: pickDomain() };
    const key = `${draft.localPart}@${draft.domain}`;
    if (seen.has(key)) continue;
    seen.add(key);
    drafts.push(draft);
  }
  return drafts;
}

/** 认领成功的邮箱：地址用于展示与复制，id 用于后续共享 */
export type ClaimedMailbox = Pick<Mailbox, 'id' | 'address'>;

export interface ClaimListResult {
  claimed: ClaimedMailbox[];
  /** 没能认领的地址（被占用的 + 因中途停止而没试的），保持用户给出的顺序 */
  remaining: AddressDraft[];
  /** 中途因配额、权限、网络等停止时的原因；仅「被占用」导致的未认领不算 */
  stoppedBy: string | null;
  /** 认领请求失败且结果未知（网络中断、超时、服务端异常）：后端可能已经提交，地址可能已认领 */
  uncertain?: true;
}

const draftKey = (draft: AddressDraft) => `${draft.localPart}@${draft.domain}`;
const failureText = (error: unknown) => (error instanceof ApiError ? error.message : '认领失败，请重试');

/**
 * 认领请求失败：4xx 是请求在处理前就被拒绝（校验、鉴权、配额、限流），确定一个都没认领；
 * 网络中断、超时或服务端异常时结果未知，后端可能已经提交，标为 uncertain 让调用方以邮箱列表为准。
 */
function claimFailure(items: AddressDraft[], error: unknown, hint: string): ClaimListResult {
  if (isRejectedRequest(error)) return { claimed: [], remaining: items, stoppedBy: failureText(error) };
  return { claimed: [], remaining: items, stoppedBy: `${failureText(error)}。${hint}`, uncertain: true };
}

/**
 * 批量认领结果映射回 ClaimListResult：被占用的与没尝试的按用户给出的顺序合并。
 * stoppedBy.code 为 internal 表示后端中途遇到非业务错误，出错那一项可能已经提交：按结果未知处理。
 */
export function fromBatchResult(drafts: AddressDraft[], result: BatchClaimMailboxResult): ClaimListResult {
  const order = new Map(drafts.map((draft, index) => [draftKey(draft), index]));
  const position = (draft: AddressDraft) => order.get(draftKey(draft)) ?? drafts.length;
  const remaining = [...result.taken, ...result.notAttempted]
    .map(({ localPart, domain }) => ({ localPart, domain }))
    .sort((a, b) => position(a) - position(b));
  return {
    claimed: result.claimed.map(({ id, address }) => ({ id, address })),
    remaining,
    stoppedBy: result.stoppedBy?.message ?? null,
    ...(result.stoppedBy?.code === 'internal' ? { uncertain: true as const } : {}),
  };
}

/**
 * 按用户确认的地址列表顺序认领，配额、域名与权限校验沿用后端那一份：
 * 地址恰好被别人占用只跳过这一个（不替用户改名），其余错误立即停止并保留已认领的，不再硬撞。
 * 只有一个地址时走单个认领接口；多个地址一次批量请求，后端按同一套规则逐个处理。
 */
export async function claimList(
  drafts: AddressDraft[],
  api: {
    claim: (body: ClaimMailboxRequest) => Promise<ClaimedMailbox>;
    batchClaim: (items: ClaimMailboxRequest[]) => Promise<BatchClaimMailboxResult>;
  },
  strategy?: ClaimMailboxRequest['strategy'],
): Promise<ClaimListResult> {
  const items = drafts.map(({ localPart, domain }) => ({ localPart, domain, ...(strategy ? { strategy } : {}) }));
  if (items.length === 1) {
    const draft = items[0]!;
    try {
      const { id, address } = await api.claim(draft);
      return { claimed: [{ id, address }], remaining: [], stoppedBy: null };
    } catch (error) {
      if (error instanceof ApiError && error.code === 'address_taken') return { claimed: [], remaining: [draft], stoppedBy: null };
      return claimFailure([draft], error, '该地址可能已认领，请以邮箱列表为准');
    }
  }
  try {
    return fromBatchResult(items, await api.batchClaim(items));
  } catch (error) {
    // 后端逐个提交：结果未知时，失败前认领的那部分已经生效
    return claimFailure(items, error, '部分地址可能已认领，请以邮箱列表为准');
  }
}

/**
 * 可用性查询合批：同一轮同步代码里发起的查询（随机生成一批、失效后一起重查）合成一次批量请求，
 * 每次最多 MAX_BATCH_CLAIM 个；只有一个时仍走单个查询接口。结果按请求顺序对应回各自的调用。
 * 失败由这里整批重试一次（4xx 不重试），调用方的查询应关闭逐个重试，否则各自的重试定时器会绕过合批。
 */
export function createAvailabilityLoader(
  api: {
    one: (item: ClaimMailboxRequest) => Promise<MailboxAvailability>;
    many: (items: ClaimMailboxRequest[]) => Promise<MailboxAvailability[]>;
  },
  { retryDelayMs = 1000 }: { retryDelayMs?: number } = {},
): (item: ClaimMailboxRequest) => Promise<MailboxAvailability> {
  interface Pending {
    item: ClaimMailboxRequest;
    resolve: (value: MailboxAvailability) => void;
    reject: (error: unknown) => void;
  }
  let queue: Pending[] = [];

  const request = async (items: ClaimMailboxRequest[]) =>
    items.length === 1 ? [await api.one(items[0]!)] : api.many(items);
  const retryable = (error: unknown) => !isRejectedRequest(error);

  const run = async (batch: Pending[]) => {
    const items = batch.map((pending) => pending.item);
    try {
      let results: MailboxAvailability[];
      try {
        results = await request(items);
      } catch (error) {
        if (!retryable(error)) throw error;
        await new Promise((resolve) => globalThis.setTimeout(resolve, retryDelayMs));
        results = await request(items);
      }
      if (results.length !== batch.length) throw new Error('可用性检查结果数量不符');
      batch.forEach((pending, index) => pending.resolve(results[index]!));
    } catch (error) {
      for (const pending of batch) pending.reject(error);
    }
  };

  const flush = () => {
    const pending = queue;
    queue = [];
    for (let i = 0; i < pending.length; i += MAX_BATCH_CLAIM) void run(pending.slice(i, i + MAX_BATCH_CLAIM));
  };

  return (item) =>
    new Promise<MailboxAvailability>((resolve, reject) => {
      if (queue.length === 0) queueMicrotask(flush);
      queue.push({ item, resolve, reject });
    });
}
