import type { ClaimMailboxRequest, Mailbox, MailboxAvailability, MailboxUnavailableReason } from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';

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
};

/** 不可认领时给用户看的原因；后端未给出 reason 时回退到通用提示 */
export function unavailableMessage(availability: Pick<MailboxAvailability, 'available' | 'reason'>): string | null {
  if (availability.available) return null;
  return availability.reason ? REASON_MESSAGES[availability.reason] : '该地址暂不可认领';
}

/** 单次最多生成/认领的地址个数 */
export const MAX_BATCH_CLAIM = 20;

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

export interface ClaimListResult {
  claimed: string[];
  /** 没能认领的地址（被占用的 + 因中途停止而没试的），保持用户给出的顺序 */
  remaining: AddressDraft[];
  /** 中途因配额、权限、网络等停止时的原因；仅「被占用」导致的未认领不算 */
  stoppedBy: string | null;
}

/**
 * 按用户确认的地址列表顺序认领。逐个调用单个认领接口，配额、域名与权限校验沿用后端那一份：
 * 地址恰好被别人占用只跳过这一个（不替用户改名），其余错误立即停止并保留已认领的，不再硬撞。
 */
export async function claimList(
  drafts: AddressDraft[],
  claim: (body: ClaimMailboxRequest) => Promise<Pick<Mailbox, 'address'> | undefined>,
  onProgress: (done: number) => void = () => {},
): Promise<ClaimListResult> {
  const claimed: string[] = [];
  const remaining: AddressDraft[] = [];
  for (let i = 0; i < drafts.length; i++) {
    const draft = drafts[i]!;
    try {
      const created = await claim({ localPart: draft.localPart, domain: draft.domain });
      claimed.push(created?.address ?? `${draft.localPart}@${draft.domain}`);
      onProgress(claimed.length);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'address_taken') {
        remaining.push(draft);
        continue;
      }
      return {
        claimed,
        remaining: [...remaining, ...drafts.slice(i)],
        stoppedBy: error instanceof ApiError ? error.message : '认领失败，请重试',
      };
    }
  }
  return { claimed, remaining, stoppedBy: null };
}
