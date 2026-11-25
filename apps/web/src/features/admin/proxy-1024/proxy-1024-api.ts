import type {
  CursorPage,
  Proxy1024Captcha,
  Proxy1024Catalogue,
  Proxy1024ConfirmRequest,
  Proxy1024GenerateStickyRequest,
  Proxy1024LoginRequest,
  Proxy1024QuoteRequest,
  Proxy1024ResolveRequest,
  Proxy1024Status,
  Proxy1024SubUser,
  Proxy1024SyncRequest,
  Proxy1024SyncResult,
  ProxyOrderStatus,
  ProxyOrderView,
} from '@hpc-mail/shared';
import { api } from '@/api/client';

/** 涉及 1024 控制台的请求会同步调用供应商接口，给足时间 */
const VENDOR_TIMEOUT_MS = 60_000;

export interface ProxyOrderFilters {
  status?: ProxyOrderStatus;
}

/** 1024proxy 采购接口（/api/admin/proxy-1024） */
export const proxy1024Api = {
  status: (live = false) =>
    api.get<Proxy1024Status>('/admin/proxy-1024/status', {
      query: { live: live ? 1 : undefined },
      timeoutMs: live ? VENDOR_TIMEOUT_MS : undefined,
    }),
  captcha: () => api.post<Proxy1024Captcha>('/admin/proxy-1024/login/captcha', undefined, { timeoutMs: VENDOR_TIMEOUT_MS }),
  login: (body: Proxy1024LoginRequest) =>
    api.post<Proxy1024Status, Proxy1024LoginRequest>('/admin/proxy-1024/login', body, { timeoutMs: VENDOR_TIMEOUT_MS }),
  catalogue: () => api.get<Proxy1024Catalogue>('/admin/proxy-1024/catalogue', { timeoutMs: VENDOR_TIMEOUT_MS }),
  subUsers: () => api.get<{ items: Proxy1024SubUser[] }>('/admin/proxy-1024/sub-users', { timeoutMs: VENDOR_TIMEOUT_MS }),
  quote: (body: Proxy1024QuoteRequest) =>
    api.post<ProxyOrderView, Proxy1024QuoteRequest>('/admin/proxy-1024/quotes', body, { timeoutMs: VENDOR_TIMEOUT_MS }),
  orders: (filters: ProxyOrderFilters, cursor?: string) =>
    api.get<CursorPage<ProxyOrderView>>('/admin/proxy-1024/orders', { query: { ...filters, cursor, limit: 50 } }),
  order: (id: number) => api.get<ProxyOrderView>(`/admin/proxy-1024/orders/${id}`),
  confirm: (id: number, body: Proxy1024ConfirmRequest) =>
    api.post<ProxyOrderView, Proxy1024ConfirmRequest>(`/admin/proxy-1024/orders/${id}/confirm`, body, {
      timeoutMs: VENDOR_TIMEOUT_MS,
    }),
  cancel: (id: number) => api.post<ProxyOrderView>(`/admin/proxy-1024/orders/${id}/cancel`),
  refresh: (id: number) =>
    api.post<ProxyOrderView>(`/admin/proxy-1024/orders/${id}/refresh`, undefined, { timeoutMs: VENDOR_TIMEOUT_MS }),
  resolve: (id: number, body: Proxy1024ResolveRequest) =>
    api.post<ProxyOrderView, Proxy1024ResolveRequest>(`/admin/proxy-1024/orders/${id}/resolve`, body),
  allocate: (id: number) =>
    api.post<Proxy1024SyncResult>(`/admin/proxy-1024/orders/${id}/allocate`, undefined, { timeoutMs: VENDOR_TIMEOUT_MS }),
  sync: (body: Partial<Proxy1024SyncRequest>) =>
    api.post<Proxy1024SyncResult>('/admin/proxy-1024/sync', body, { timeoutMs: VENDOR_TIMEOUT_MS }),
  generateSticky: (body: Partial<Proxy1024GenerateStickyRequest> & Pick<Proxy1024GenerateStickyRequest, 'subUser' | 'country' | 'count'>) =>
    api.post<{ created: number }>('/admin/proxy-1024/generate-sticky', body, { timeoutMs: VENDOR_TIMEOUT_MS }),
};
