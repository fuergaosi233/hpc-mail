import type { Page } from '@hpc-mail/shared';
import { sha256Hex } from './crypto.js';

/** 游标 = base64(id)，仅编码自增主键 */
export function encodeCursor(id: number): string {
  return btoa(String(id));
}

export function decodeCursor(cursor: string | undefined): number | null {
  if (!cursor) return null;
  try {
    const decoded = atob(cursor);
    const id = Number(decoded);
    if (!Number.isInteger(id) || id <= 0) return null;
    return id;
  } catch {
    return null;
  }
}

/**
 * 首页指纹：对首页序列化结果（条目 + nextCursor）取 SHA-256。
 * 条目里任何对用户可见的字段（已读、星标、验证码、状态等）或翻页游标变化都会改变它；
 * 只用于比较是否相等，不承载含义。
 */
export function pageHead(page: Page<unknown>): Promise<string> {
  return sha256Hex(JSON.stringify([page.items, page.nextCursor]));
}
