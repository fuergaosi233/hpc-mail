import { describe, expect, it } from 'vitest';
import { ApiError, isRejectedRequest, isUncertainSendError, NETWORK_ERROR_MESSAGE, toApiError } from './errors';

describe('toApiError', () => {
  it.each([
    ['Chrome', 'Failed to fetch'],
    ['Safari', 'Load failed'],
    ['Firefox', 'NetworkError when attempting to fetch resource.'],
  ])('%s 的 fetch 网络失败统一为中文提示', (_browser, message) => {
    const error = toApiError(new TypeError(message));
    expect(error.code).toBe('network');
    expect(error.message).toBe(NETWORK_ERROR_MESSAGE);
  });

  it('超时与业务错误保持原样', () => {
    expect(toApiError(new DOMException('aborted', 'AbortError')).code).toBe('timeout');
    const original = new ApiError('无权限', { code: 'forbidden', httpStatus: 403 });
    expect(toApiError(original)).toBe(original);
  });

  it('其他异常保留原文，空文案退回网络提示', () => {
    expect(toApiError(new Error('boom')).message).toBe('boom');
    expect(toApiError(new Error('')).message).toBe(NETWORK_ERROR_MESSAGE);
  });
});

describe('isUncertainSendError', () => {
  it('网络、超时与 5xx 结果不确定，4xx 业务错误是明确失败', () => {
    expect(isUncertainSendError(toApiError(new TypeError('Failed to fetch')))).toBe(true);
    expect(isUncertainSendError(new ApiError('t', { code: 'timeout' }))).toBe(true);
    expect(isUncertainSendError(new ApiError('g', { code: 'internal', httpStatus: 503 }))).toBe(true);
    expect(isUncertainSendError(new ApiError('v', { code: 'validation_failed', httpStatus: 400 }))).toBe(false);
  });
});

describe('isRejectedRequest', () => {
  it('只有服务端明确拒绝的 4xx 算确定未写入，408 与网络失败、5xx 都算结果未知', () => {
    expect(isRejectedRequest(new ApiError('冲突', { code: 'conflict', httpStatus: 409 }))).toBe(true);
    expect(isRejectedRequest(new ApiError('校验', { code: 'validation_failed', httpStatus: 400 }))).toBe(true);
    expect(isRejectedRequest(new ApiError('超时', { code: 'timeout', httpStatus: 408 }))).toBe(false);
    expect(isRejectedRequest(new ApiError('g', { code: 'internal', httpStatus: 502 }))).toBe(false);
    expect(isRejectedRequest(toApiError(new TypeError('Failed to fetch')))).toBe(false);
    expect(isRejectedRequest(new TypeError('boom'))).toBe(false);
  });
});
