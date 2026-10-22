import { z } from 'zod';

/**
 * 托管域名的 DNS 解析：所有者与管理员在站长 Cloudflare 账户里该域名的 zone 中维护常用记录。
 * 邮箱收发占用的记录只读，新增或修改的记录也不能与之冲突；只做 DNS 解析，不开启 Cloudflare 代理。
 */
export const HOSTED_DNS_RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'SRV', 'CAA'] as const;
export type HostedDnsRecordType = (typeof HOSTED_DNS_RECORD_TYPES)[number];

/** 每个托管域名最多的非邮箱记录数 */
export const MAX_HOSTED_DNS_RECORDS = 100;
/** 每位用户每分钟最多的解析接口请求数（每次请求都会调用站长的 Cloudflare 接口） */
export const MAX_HOSTED_DNS_REQUESTS_PER_MINUTE = 30;
/** TTL 为 1 表示由 Cloudflare 自动决定 */
export const HOSTED_DNS_TTL_AUTO = 1;
export const HOSTED_DNS_CAA_TAGS = ['issue', 'issuewild', 'iodef'] as const;

/**
 * user：可以在本站修改；mail：邮箱收发使用，只读；
 * readonly：本站不支持编辑的记录（类型不在支持范围或已开启 Cloudflare 代理），只读展示
 */
export type HostedDnsRecordKind = 'user' | 'mail' | 'readonly';

export interface HostedDnsSrvData {
  priority: number;
  weight: number;
  port: number;
  target: string;
}

export interface HostedDnsCaaData {
  flags: number;
  tag: (typeof HOSTED_DNS_CAA_TAGS)[number];
  value: string;
}

export interface HostedDnsRecord {
  /** Cloudflare 记录 ID */
  id: string;
  /** Cloudflare 返回的类型，readonly 记录可能是支持范围以外的类型 */
  type: string;
  /** 相对名称：根域为 @，其余去掉域名后缀，例如 www、_acme-challenge、*.dev */
  name: string;
  /** 完整域名 */
  fqdn: string;
  /** Cloudflare 返回的记录值（TXT 可能带引号；SRV 为「weight port target」，CAA 为「flags tag "value"」） */
  content: string;
  /** 1 为自动 */
  ttl: number;
  /** MX 优先级；其他类型为 null */
  priority: number | null;
  srv: HostedDnsSrvData | null;
  caa: HostedDnsCaaData | null;
  proxied: boolean;
  comment: string;
  kind: HostedDnsRecordKind;
  /** kind 不是 user 时说明为何只读；可修改时为空串 */
  lockedReason: string;
  modifiedAt: string | null;
}

const LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;

/** 记录名：@ 表示根域；可以是相对名称（www、_dmarc、*.dev），也可以是以本域名结尾的完整域名 */
export function isHostedDnsName(value: string): boolean {
  if (value === '@') return true;
  const labels = value.split('.');
  return labels.every((label, index) => (label === '*' ? index === 0 : LABEL.test(label)));
}

/** 记录名转完整域名；name 已是本域名或其子域时原样返回 */
export function hostedDnsFqdn(name: string, domain: string): string {
  const value = name.trim().toLowerCase().replace(/\.$/, '');
  if (value === '' || value === '@' || value === domain) return domain;
  return value.endsWith(`.${domain}`) ? value : `${value}.${domain}`;
}

/** 完整域名转相对名称：根域为 @ */
export function hostedDnsRelativeName(fqdn: string, domain: string): string {
  const value = fqdn.toLowerCase().replace(/\.$/, '');
  if (value === domain) return '@';
  if (!value.endsWith(`.${domain}`)) return value;
  const relative = value.slice(0, -domain.length - 1);
  // 去掉后缀后仍是本域名或其子域（如 www.example.com.example.com）时保留完整域名，
  // 否则 hostedDnsFqdn 会把相对名当作完整域名，编辑保存时记录被改名
  return relative === domain || relative.endsWith(`.${domain}`) ? value : relative;
}

/**
 * 保守判断 SPF：多段字符串解析时直接拼接（"v=sp" "f1 -all"），还可能有 RFC 1035 转义（\118 即 v，部分实现对超过 255 的值取模），
 * 所以解码转义、去掉引号与空白后以 v=spf1 开头的一律算作 SPF
 */
function isSpf(content: string): boolean {
  const decoded = content
    .replace(/\\(\d{3})/g, (_, code: string) => String.fromCharCode(Number(code) % 256))
    .replace(/\\(.)/g, '$1');
  return decoded.replace(/["\s]/g, '').toLowerCase().startsWith('v=spf1');
}

/**
 * 邮箱收发占用的记录：返回只读原因，其他记录返回空串。
 * 根域 MX 与 SPF 用于收件；_domainkey 为收件与发信的 DKIM；_dmarc 与 cf-bounce 子域用于发信。
 */
export function hostedDnsMailReason(record: { type: string; fqdn: string; content: string }, domain: string): string {
  const fqdn = record.fqdn.toLowerCase().replace(/\.$/, '');
  const type = record.type.toUpperCase();
  if (fqdn === domain && type === 'MX') return '根域的 MX 记录用于本站收件，由系统维护';
  if (fqdn === domain && type === 'TXT' && isSpf(record.content)) return '根域的 SPF 记录用于本站收发，由系统维护';
  if (fqdn === `_dmarc.${domain}`) return 'DMARC 记录用于本站发信，由系统维护';
  if (fqdn === `_domainkey.${domain}` || fqdn.endsWith(`._domainkey.${domain}`)) return 'DKIM（_domainkey）记录用于本站收发，由系统维护';
  if (fqdn === `cf-bounce.${domain}` || fqdn.endsWith(`.cf-bounce.${domain}`)) return 'cf-bounce 子域用于本站发信退信，由系统维护';
  return '';
}

/** 新增或修改后的记录与邮箱冲突的原因；不冲突返回空串 */
export function hostedDnsConflictReason(record: { type: string; fqdn: string; content: string }, domain: string): string {
  const mail = hostedDnsMailReason(record, domain);
  if (mail) return `${mail}，不能添加或修改`;
  if (record.fqdn.toLowerCase().replace(/\.$/, '') === domain && record.type.toUpperCase() === 'CNAME') {
    return '根域已有收件所需的 MX、TXT 记录，不能设置 CNAME，请改用 A 或 AAAA 记录';
  }
  return '';
}

const nameSchema = z.string().trim().toLowerCase().min(1, '请填写记录名').max(253)
  .transform((value) => value.replace(/\.$/, '') || '@')
  .refine(isHostedDnsName, '记录名只能包含字母、数字、连字符、下划线，用 @ 表示根域，通配符 * 只能在最前面');

const hostnameSchema = z.string().trim().toLowerCase().min(1, '请填写目标域名').max(253)
  .transform((value) => value.replace(/\.$/, ''))
  .refine((value) => value.includes('.') && value.split('.').every((label) => LABEL.test(label)), '请填写完整的域名，例如 target.example.com');

const ttlSchema = z.number().int()
  .refine((value) => value === HOSTED_DNS_TTL_AUTO || (value >= 60 && value <= 86400), 'TTL 为自动或 60–86400 秒');

const IPV4_MESSAGE = '请填写 IPv4 地址，例如 203.0.113.10';
const IPV6_MESSAGE = '请填写 IPv6 地址，例如 2001:db8::1';

const base = {
  name: nameSchema,
  ttl: ttlSchema,
  comment: z.string().trim().max(100, '备注最多 100 个字符').optional().default(''),
};

/** 新增与修改共用；修改时 type 必须与原记录一致 */
export const hostedDnsRecordInputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('A'), ...base, content: z.string().trim().pipe(z.ipv4(IPV4_MESSAGE)) }),
  // zod 的 IPv6 校验基于 URL 解析，会忽略中间的制表符与换行，先限定字符集
  z.object({ type: z.literal('AAAA'), ...base, content: z.string().trim().regex(/^[0-9a-f:.]+$/i, IPV6_MESSAGE).pipe(z.ipv6(IPV6_MESSAGE)) }),
  z.object({ type: z.literal('CNAME'), ...base, content: hostnameSchema }),
  z.object({ type: z.literal('TXT'), ...base, content: z.string().trim().min(1, '请填写记录值').max(2048, '记录值最多 2048 个字符') }),
  z.object({ type: z.literal('MX'), ...base, content: hostnameSchema, priority: z.number().int().min(0).max(65535) }),
  z.object({
    type: z.literal('SRV'), ...base,
    srv: z.object({
      priority: z.number().int().min(0).max(65535),
      weight: z.number().int().min(0).max(65535),
      port: z.number().int().min(0).max(65535),
      target: hostnameSchema,
    }),
  }),
  z.object({
    type: z.literal('CAA'), ...base,
    caa: z.object({
      flags: z.union([z.literal(0), z.literal(128)]),
      tag: z.enum(HOSTED_DNS_CAA_TAGS),
      value: z.string().trim().min(1, '请填写 CA 域名或报告地址').max(255),
    }),
  }),
]);
export type HostedDnsRecordInput = z.input<typeof hostedDnsRecordInputSchema>;
export type HostedDnsRecordParsed = z.output<typeof hostedDnsRecordInputSchema>;
