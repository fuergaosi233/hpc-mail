import type {
  CursorPage,
  DomainBatchStatus,
  DomainConfirmRequest,
  DomainItemResolveRequest,
  DomainPurchaseBatchView,
  DomainPurchaseItemView,
  DomainPurchaseStatus,
  DomainQuoteRequest,
  RegistrantContactRequest,
  SpaceshipCredentialTest,
} from '@hpc-mail/shared';
import { api } from '@/api/client';

/** 报价/确认会同步调用 Spaceship（每 20 个域名一次可用性 + 价格查询），给足时间 */
const VENDOR_TIMEOUT_MS = 90_000;

export interface DomainBatchFilters {
  status?: DomainBatchStatus;
}

/** Spaceship 域名采购接口（/api/admin/domain-purchases） */
export const domainPurchaseApi = {
  status: () => api.get<DomainPurchaseStatus>('/admin/domain-purchases/status'),
  testCredentials: () =>
    api.post<SpaceshipCredentialTest>('/admin/domain-purchases/test-credentials', undefined, { timeoutMs: VENDOR_TIMEOUT_MS }),
  saveContact: (body: RegistrantContactRequest) =>
    api.post<{ contactId: string }, RegistrantContactRequest>('/admin/domain-purchases/contact', body, {
      timeoutMs: VENDOR_TIMEOUT_MS,
    }),
  quote: (body: DomainQuoteRequest) =>
    api.post<DomainPurchaseBatchView, DomainQuoteRequest>('/admin/domain-purchases/quotes', body, {
      timeoutMs: VENDOR_TIMEOUT_MS,
    }),
  batches: (filters: DomainBatchFilters, cursor?: string) =>
    api.get<CursorPage<DomainPurchaseBatchView>>('/admin/domain-purchases', { query: { ...filters, cursor, limit: 50 } }),
  batch: (id: number) => api.get<DomainPurchaseBatchView>(`/admin/domain-purchases/${id}`),
  confirm: (id: number, body: DomainConfirmRequest) =>
    api.post<DomainPurchaseBatchView, DomainConfirmRequest>(`/admin/domain-purchases/${id}/confirm`, body, {
      timeoutMs: VENDOR_TIMEOUT_MS,
    }),
  cancel: (id: number) => api.post<DomainPurchaseBatchView>(`/admin/domain-purchases/${id}/cancel`),
  retryItem: (itemId: number) => api.post<DomainPurchaseItemView>(`/admin/domain-purchases/items/${itemId}/retry`),
  resolveItem: (itemId: number, body: DomainItemResolveRequest) =>
    api.post<DomainPurchaseItemView, DomainItemResolveRequest>(`/admin/domain-purchases/items/${itemId}/resolve`, body, {
      timeoutMs: VENDOR_TIMEOUT_MS,
    }),
  refreshItem: (itemId: number) =>
    api.post<DomainPurchaseItemView>(`/admin/domain-purchases/items/${itemId}/refresh`, undefined, {
      timeoutMs: VENDOR_TIMEOUT_MS,
    }),
};
