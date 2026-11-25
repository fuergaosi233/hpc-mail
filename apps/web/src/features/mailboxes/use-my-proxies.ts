import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { MyProxyBinding } from '@hpc-mail/shared';
import { api } from '@/api/client';
import { queryKeys } from '@/api/query-keys';

/** 普通用户：自己认领地址绑定的代理（/api/proxies/mine）；共享给我的邮箱不含代理 */
export const myProxyApi = {
  mine: () => api.get<{ items: MyProxyBinding[] }>('/proxies/mine'),
};

/**
 * 「我的邮箱」页的代理徽标数据：一次请求取全部，按地址建索引。
 * staleTime 5 分钟；不进 boot-prefetch，也不在持久化白名单里（含代理密码，不落盘）。
 * 旧版服务端没有该接口时（404）静默视为无绑定。
 */
export function useMyProxies() {
  const query = useQuery({
    queryKey: queryKeys.myProxies,
    queryFn: () => myProxyApi.mine(),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const byAddress = useMemo(() => {
    const map = new Map<string, MyProxyBinding>();
    for (const item of query.data?.items ?? []) map.set(item.address.toLowerCase(), item);
    return map;
  }, [query.data]);
  return { ...query, byAddress };
}
