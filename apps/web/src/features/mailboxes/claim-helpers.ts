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

/** 单次随机批量认领的个数上限 */
export const MAX_BATCH_CLAIM = 20;

/** 个数输入框文本 → 1..MAX_BATCH_CLAIM 的整数；空或非法按 1 */
export function parseBatchCount(text: string): number {
  const value = Number.parseInt(text, 10);
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.min(value, MAX_BATCH_CLAIM);
}

/** 随机前缀撞上已被占用的地址时，同一个名额最多换几次前缀 */
const MAX_TAKEN_RETRIES = 5;

export interface BatchClaimResult {
  claimed: string[];
  /** 没认领满的原因；全部认领成功为 null */
  stoppedBy: string | null;
}

/**
 * 顺序随机认领 count 个地址。逐个调用单个认领接口，配额、域名与权限校验沿用后端那一份：
 * 前缀被占用就换一个重试；遇到配额用尽、权限、网络等其他错误立即停止并保留已认领的，不再硬撞。
 */
export async function claimRandomBatch(
  count: number,
  domain: string,
  claim: (body: ClaimMailboxRequest) => Promise<Pick<Mailbox, 'address'> | undefined>,
  onProgress: (claimed: number) => void = () => {},
  random: () => string = randomLocalPart,
): Promise<BatchClaimResult> {
  const claimed: string[] = [];
  for (let slot = 0; slot < count; slot++) {
    let done = false;
    for (let attempt = 0; attempt < MAX_TAKEN_RETRIES && !done; attempt++) {
      const localPart = random();
      try {
        const created = await claim({ localPart, domain });
        claimed.push(created?.address ?? `${localPart}@${domain}`);
        onProgress(claimed.length);
        done = true;
      } catch (error) {
        if (error instanceof ApiError && error.code === 'address_taken') continue;
        return { claimed, stoppedBy: error instanceof ApiError ? error.message : '认领失败，请重试' };
      }
    }
    if (!done) return { claimed, stoppedBy: '随机地址多次冲突，请稍后重试' };
  }
  return { claimed, stoppedBy: null };
}
