/** 成功：HTTP 2xx + { data }；失败：HTTP 4xx/5xx + { error, requestId } */
export interface ApiSuccess<T> {
  data: T;
}

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
  };
  requestId: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** 游标分页的别名（代理池 / 采购接口沿用 Page 形状） */
export type CursorPage<T> = Page<T>;

export const ERROR_CODES = [
  'validation_failed',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'bad_credentials',
  'user_disabled',
  'totp_required',
  /** 站点强制两步验证但该账号尚未绑定：403（不是 401——401 会让前端清 token 把人踢出登录态，反而没法去绑定） */
  'totp_setup_required',
  'registration_closed',
  'invite_invalid',
  'address_taken',
  'payload_too_large',
  'internal',
  /** 功能未启用，或凭据/上限未配置：503 */
  'not_configured',
  /** 供应商返回了明确错误：502（message 带供应商原因，绝不含凭据） */
  'upstream_failed',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** 各错误码的默认 HTTP 状态 */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  validation_failed: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  bad_credentials: 401,
  user_disabled: 403,
  totp_required: 401,
  totp_setup_required: 403,
  registration_closed: 403,
  invite_invalid: 400,
  address_taken: 409,
  payload_too_large: 413,
  internal: 500,
  not_configured: 503,
  upstream_failed: 502,
};
