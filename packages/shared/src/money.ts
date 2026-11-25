/**
 * 金额统一用整数美分（*_cents 列、*Cents 字段）。供应商给的十进制字符串/数字经 usdToCents 换算，
 * 不足一分的部分向上取整（宁可多估，不少算上限）。
 */

/** 非负十进制：整数部分 + 可选小数部分；不接受指数、符号与千分位 */
const DECIMAL = /^(\d+)(?:\.(\d*))?$|^\.(\d+)$/;

/** "5.98" | 5.98 → 598；不足一分向上取整；NaN/负数/非数字抛错 */
export function usdToCents(value: string | number): number {
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new Error(`金额非法：${value}`);
    // 数字先转成定点串，避免 0.1+0.2 这类浮点误差被向上取整成多一分
    text = value.toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
  } else if (typeof value === 'string') {
    text = value.trim();
  } else {
    throw new Error('金额非法');
  }
  const match = DECIMAL.exec(text);
  if (!match) throw new Error(`金额非法：${String(value)}`);
  const whole = match[1] ?? '0';
  const fraction = match[2] ?? match[3] ?? '';
  const cents = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
  const rest = fraction.slice(2);
  const result = cents + (/[1-9]/.test(rest) ? 1 : 0);
  if (!Number.isSafeInteger(result)) throw new Error(`金额超出范围：${String(value)}`);
  return result;
}

/** 598 → "$5.98"；123456 → "$1,234.56"；负数 → "-$5.98" */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(cents));
  const dollars = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}
