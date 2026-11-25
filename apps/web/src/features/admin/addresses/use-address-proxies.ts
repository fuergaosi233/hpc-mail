import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';
import { MAX_PROXY_LOOKUP_ADDRESSES, type ProxyBindingView } from '@hpc-mail/shared';
import { queryKeys } from '@/api/query-keys';
import { adminProxyApi } from '@/features/admin/proxies/proxies-api';

/** 按批次上限切分（保持原顺序，便于 queryKey 稳定） */
export function chunkAddresses(addresses: readonly string[], size = MAX_PROXY_LOOKUP_ADDRESSES): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < addresses.length; i += size) chunks.push(addresses.slice(i, i + size));
  return chunks;
}

/**
 * 全站地址页「代理」列：已加载的地址每 500 个合成一次 POST /bindings/lookup，绝不逐行请求。
 * 返回地址 → 绑定（未绑定为 null；尚未取到的地址不在 Map 里）。
 */
export function useAddressProxies(addresses: readonly string[]) {
  const chunks = useMemo(() => chunkAddresses([...new Set(addresses.map((a) => a.toLowerCase()))]), [addresses]);
  return useQueries({
    queries: chunks.map((chunk) => ({
      queryKey: queryKeys.admin.proxyLookup(chunk),
      queryFn: () => adminProxyApi.lookup(chunk),
      staleTime: 60_000,
      retry: false,
    })),
    combine: combineLookups,
  });
}

function combineLookups(results: { data?: { items: { address: string; binding: ProxyBindingView | null }[] }; isError: boolean }[]) {
  const byAddress = new Map<string, ProxyBindingView | null>();
  for (const result of results) for (const item of result.data?.items ?? []) byAddress.set(item.address.toLowerCase(), item.binding);
  return { byAddress, isError: results.some((r) => r.isError) };
}
