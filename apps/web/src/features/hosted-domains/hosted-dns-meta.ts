import { HOSTED_DNS_TTL_AUTO, type HostedDnsRecord, type HostedDnsRecordType } from '@hpc-mail/shared';

/** 新增/编辑时可选的 TTL（秒），1 为自动 */
export const HOSTED_DNS_TTL_OPTIONS = [HOSTED_DNS_TTL_AUTO, 60, 300, 1800, 3600, 43200, 86400] as const;

export function formatDnsTtl(ttl: number): string {
  if (ttl === HOSTED_DNS_TTL_AUTO) return '自动';
  if (ttl % 86400 === 0) return `${ttl / 86400} 天`;
  if (ttl % 3600 === 0) return `${ttl / 3600} 小时`;
  if (ttl % 60 === 0) return `${ttl / 60} 分钟`;
  return `${ttl} 秒`;
}

export const HOSTED_DNS_TYPE_HINTS: Record<HostedDnsRecordType, string> = {
  A: '指向 IPv4 地址',
  AAAA: '指向 IPv6 地址',
  CNAME: '指向另一个域名',
  TXT: '文本，常用于域名验证',
  MX: '子域名的邮件服务器',
  SRV: '服务定位',
  CAA: '限制可签发证书的机构',
};

/** MX 的优先级在 priority，SRV 的在 srv；其他类型没有 */
export function dnsRecordPriority(record: HostedDnsRecord): number | null {
  return record.priority ?? record.srv?.priority ?? null;
}
