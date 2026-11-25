import type {
  AutoAssignRequest,
  AutoAssignResult,
  BindProxyRequest,
  CursorPage,
  ExportProxiesQuery,
  ImportProxiesRequest,
  ListBindingsQuery,
  ListProxiesQuery,
  LookupBindingsRequest,
  ProxyBindingLookupItem,
  ProxyBindingView,
  ProxyCredential,
  ProxyExport,
  ProxyHealthReport,
  ProxyImportResult,
  ProxyInput,
  ProxyPoolStats,
  ProxyView,
  UpdateProxyRequest,
} from '@hpc-mail/shared';
import type { QueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { queryKeys } from '@/api/query-keys';

/** 列表筛选（不含游标；游标由 useInfiniteQuery 管） */
export type ProxyListFilters = Partial<Omit<ListProxiesQuery, 'cursor' | 'limit'>>;
export type BindingListFilters = Partial<Omit<ListBindingsQuery, 'cursor' | 'limit'>>;

const PAGE_SIZE = 50;

/** 代理池管理接口（/api/admin/proxies）；只在懒加载的管理页用到，不放进入口的 api/resources.ts */
export const adminProxyApi = {
  list: (filters: ProxyListFilters, cursor?: string) =>
    api.get<CursorPage<ProxyView>>('/admin/proxies', { query: { ...filters, cursor, limit: PAGE_SIZE } }),
  stats: () => api.get<ProxyPoolStats>('/admin/proxies/stats'),
  get: (id: number) => api.get<ProxyView>(`/admin/proxies/${id}`),
  create: (body: Partial<ProxyInput> & Pick<ProxyInput, 'host' | 'port'>) =>
    api.post<ProxyView>('/admin/proxies', body),
  update: (id: number, body: UpdateProxyRequest) => api.put<ProxyView, UpdateProxyRequest>(`/admin/proxies/${id}`, body),
  remove: (id: number, force = false) =>
    api.delete<{ ok: true }>(`/admin/proxies/${id}`, undefined, { query: { force: force ? 1 : undefined } }),
  importLines: (body: Partial<ImportProxiesRequest> & Pick<ImportProxiesRequest, 'text'>) =>
    api.post<ProxyImportResult>('/admin/proxies/import', body, { timeoutMs: 60_000 }),
  exportProxies: (query: Partial<ExportProxiesQuery>) =>
    api.get<ProxyExport>('/admin/proxies/export', { query: { ...query }, timeoutMs: 60_000 }),
  autoAssign: (body: Partial<AutoAssignRequest> & Pick<AutoAssignRequest, 'target'>) =>
    api.post<AutoAssignResult>('/admin/proxies/auto-assign', body, { timeoutMs: 60_000 }),
  bindings: (filters: BindingListFilters, cursor?: string) =>
    api.get<CursorPage<ProxyBindingView>>('/admin/proxies/bindings', { query: { ...filters, cursor, limit: PAGE_SIZE } }),
  lookup: (addresses: string[]) =>
    api.post<{ items: ProxyBindingLookupItem[] }, LookupBindingsRequest>('/admin/proxies/bindings/lookup', { addresses }),
  bind: (address: string, proxyId: number) =>
    api.put<ProxyBindingView, BindProxyRequest>(`/admin/proxies/bindings/${encodeURIComponent(address)}`, { proxyId }),
  unbind: (address: string) => api.delete<{ ok: true }>(`/admin/proxies/bindings/${encodeURIComponent(address)}`),
  /** 明文凭据：只在调用处临时持有，绝不放进 query 缓存 */
  reveal: (id: number) => api.post<ProxyCredential>(`/admin/proxies/${id}/reveal`),
  reportHealth: (id: number, body: ProxyHealthReport) =>
    api.post<ProxyView, ProxyHealthReport>(`/admin/proxies/${id}/health`, body),
};


/** 库存或绑定变化后：管理端代理池各视图（含地址页的批量查询）与「我的邮箱」代理徽标一起失效 */
export function invalidateProxyData(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: queryKeys.admin.proxiesRoot });
  void client.invalidateQueries({ queryKey: queryKeys.myProxies });
}
