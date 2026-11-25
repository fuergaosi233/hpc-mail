import { z } from 'zod';
import { domainSchema } from './mailbox.js';

/**
 * 代理库存与「邮箱地址 ↔ 代理」绑定。
 * - 代理可来自任意供应商（手工 / 批量导入 / 1024proxy 采购同步）；密码在库里加密，列表与详情接口永不返回密码。
 * - 绑定以地址为键（未认领地址同样可绑），与认领/释放/过户解耦；非管理员按当前认领关系可见。
 */
export const PROXY_PROTOCOLS = ['http', 'https', 'socks5'] as const;
export type ProxyProtocol = (typeof PROXY_PROTOCOLS)[number];
export const PROXY_STATUSES = ['active', 'disabled', 'expired'] as const;
export type ProxyStatus = (typeof PROXY_STATUSES)[number];
export const PROXY_SOURCES = ['manual', 'import', 'proxy1024'] as const;
export type ProxySource = (typeof PROXY_SOURCES)[number];
export const PROXY_HEALTH = ['unknown', 'ok', 'fail'] as const;
export type ProxyHealthStatus = (typeof PROXY_HEALTH)[number];
export const PROXY_BINDING_SOURCES = ['manual', 'auto', 'import'] as const;
export type ProxyBindingSource = (typeof PROXY_BINDING_SOURCES)[number];
export const PROXY_EXPORT_FORMATS = ['url', 'host_port_user_pass', 'user_pass_at_host_port', 'json'] as const;
export type ProxyExportFormat = (typeof PROXY_EXPORT_FORMATS)[number];
export const PROXY_IMPORT_FORMATS = ['auto', 'url', 'host_port_user_pass', 'user_pass_at_host_port'] as const;
export type ProxyImportFormat = (typeof PROXY_IMPORT_FORMATS)[number];

/** 单次导入最多处理的非空行数 */
export const MAX_PROXY_IMPORT_LINES = 2000;
/** 单次查询/自动分配最多处理的地址数 */
export const MAX_PROXY_LOOKUP_ADDRESSES = 500;
/** 单次导出最多行数 */
export const MAX_PROXY_EXPORT_ROWS = 10_000;

/** 查询参数里的空串按「没传」处理（与 mail.ts 同口径） */
function emptyAsUndefined<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
}

/** 布尔开关参数：接受 1/true/0/false，空串等同未传 */
function boolFlag() {
  return z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.union([z.literal('1'), z.literal('true'), z.literal('0'), z.literal('false')]).optional()
      .transform((v) => v === '1' || v === 'true'),
  );
}

const cursorQuery = emptyAsUndefined(z.string().max(320));
const limitQuery = emptyAsUndefined(z.coerce.number().int().min(1).max(200)).default(50);

/** 完整邮箱地址（小写）：local@domain，domain 需满足 domainSchema */
export const proxyAddressSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .refine((value) => {
    const at = value.lastIndexOf('@');
    if (at < 1 || at > 64 || /\s/.test(value)) return false;
    return domainSchema.safeParse(value.slice(at + 1)).success && !value.slice(0, at).includes('@');
  }, '邮箱地址格式非法');

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*$/;

/** 主机：域名、IPv4 或 IPv6 字面量（不带方括号） */
export function isProxyHost(host: string): boolean {
  if (IPV4.test(host)) return true;
  if (host.includes(':')) return /^[0-9a-f:.]+$/i.test(host) && host.split(':').length >= 3 && host.split(':').length <= 9;
  return HOSTNAME.test(host);
}

const hostSchema = z
  .string()
  .trim()
  .toLowerCase()
  .transform((v) => (v.startsWith('[') && v.endsWith(']') ? v.slice(1, -1) : v))
  .pipe(z.string().min(1).max(253).refine(isProxyHost, '主机需为域名、IPv4 或 IPv6 地址'));

export const proxyInputSchema = z.object({
  label: z.string().trim().max(100).default(''),
  provider: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{1,64}$/, '供应商名只能含小写字母、数字、. _ -').default('manual'),
  protocol: z.enum(PROXY_PROTOCOLS).default('http'),
  host: hostSchema,
  port: z.number().int().min(1).max(65535),
  username: z.string().max(255).default(''),
  /** 更新时提交 SECRET_MASK 表示保留原密码 */
  password: z.string().max(255).default(''),
  product: z.string().trim().max(64).default(''),
  country: z.string().trim().toUpperCase().regex(/^([A-Z]{2})?$/, '国家需为两位代码').default(''),
  region: z.string().trim().max(100).default(''),
  city: z.string().trim().max(100).default(''),
  expiresAt: z.iso.datetime().nullable().default(null),
  status: z.enum(['active', 'disabled']).default('active'),
  maxBindings: z.number().int().min(1).max(1000).default(1),
  notes: z.string().max(1000).default(''),
});
export type ProxyInput = z.infer<typeof proxyInputSchema>;

/** 局部更新：未提交的字段保持原值（不套用默认值） */
export const updateProxyRequestSchema = z
  .object({
    label: z.string().trim().max(100),
    provider: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{1,64}$/, '供应商名只能含小写字母、数字、. _ -'),
    protocol: z.enum(PROXY_PROTOCOLS),
    host: hostSchema,
    port: z.number().int().min(1).max(65535),
    username: z.string().max(255),
    password: z.string().max(255),
    product: z.string().trim().max(64),
    country: z.string().trim().toUpperCase().regex(/^([A-Z]{2})?$/, '国家需为两位代码'),
    region: z.string().trim().max(100),
    city: z.string().trim().max(100),
    expiresAt: z.iso.datetime().nullable(),
    status: z.enum(['active', 'disabled']),
    maxBindings: z.number().int().min(1).max(1000),
    notes: z.string().max(1000),
  })
  .partial()
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: '至少提供一个待更新字段' });
export type UpdateProxyRequest = z.infer<typeof updateProxyRequestSchema>;

export const listProxiesQuerySchema = z.object({
  cursor: cursorQuery,
  limit: limitQuery,
  /** 匹配 label / host / username / provider_ref / notes */
  q: emptyAsUndefined(z.string().trim().max(200)),
  status: emptyAsUndefined(z.enum(PROXY_STATUSES)),
  provider: emptyAsUndefined(z.string().trim().toLowerCase().max(64)),
  country: emptyAsUndefined(z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/)),
  bound: emptyAsUndefined(z.enum(['yes', 'no'])),
  orderId: emptyAsUndefined(z.coerce.number().int().positive()),
});
export type ListProxiesQuery = z.infer<typeof listProxiesQuerySchema>;

export const importProxiesRequestSchema = z.object({
  /** 每行一个代理；最多 MAX_PROXY_IMPORT_LINES 个非空行（服务端统计，超出整体拒绝） */
  text: z.string().max(500_000),
  format: z.enum(PROXY_IMPORT_FORMATS).default('auto'),
  defaults: proxyInputSchema
    .pick({ provider: true, protocol: true, product: true, country: true, label: true, expiresAt: true, maxBindings: true })
    .partial()
    .default({}),
  dryRun: z.boolean().default(false),
});
export type ImportProxiesRequest = z.infer<typeof importProxiesRequestSchema>;

/** 健康状态由自动化/管理员上报（服务端不主动探测） */
export const proxyHealthReportSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().int().min(0).max(600_000).optional(),
  error: z.string().max(500).optional(),
});
export type ProxyHealthReport = z.infer<typeof proxyHealthReportSchema>;

export const bindProxyRequestSchema = z.object({ proxyId: z.number().int().positive() });
export type BindProxyRequest = z.infer<typeof bindProxyRequestSchema>;

export const listBindingsQuerySchema = z.object({
  cursor: cursorQuery,
  limit: limitQuery,
  domain: emptyAsUndefined(domainSchema),
  /** 地址子串 */
  q: emptyAsUndefined(z.string().trim().toLowerCase().max(254)),
  proxyId: emptyAsUndefined(z.coerce.number().int().positive()),
});
export type ListBindingsQuery = z.infer<typeof listBindingsQuerySchema>;

export const lookupBindingsRequestSchema = z.object({
  addresses: z.array(proxyAddressSchema).min(1).max(MAX_PROXY_LOOKUP_ADDRESSES),
});
export type LookupBindingsRequest = z.infer<typeof lookupBindingsRequestSchema>;

export const autoAssignRequestSchema = z
  .object({
    /** 'claimed' = mailboxes 表里尚未绑定的地址；'addresses' = 显式列表（可含未认领地址） */
    target: z.enum(['claimed', 'addresses']),
    /** 仅 target=claimed 时按域名过滤 */
    domain: domainSchema.optional(),
    /** target=addresses 时必填 */
    addresses: z.array(proxyAddressSchema).max(MAX_PROXY_LOOKUP_ADDRESSES).optional(),
    limit: z.number().int().min(1).max(MAX_PROXY_LOOKUP_ADDRESSES).default(100),
    filter: z
      .object({
        provider: z.string().trim().toLowerCase().max(64).optional(),
        country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/).optional(),
        product: z.string().trim().max(64).optional(),
      })
      .default({}),
    dryRun: z.boolean().default(false),
  })
  .refine((v) => v.target !== 'addresses' || (v.addresses?.length ?? 0) > 0, {
    message: 'target=addresses 需要提供地址列表',
    path: ['addresses'],
  });
export type AutoAssignRequest = z.infer<typeof autoAssignRequestSchema>;

export const exportProxiesQuerySchema = z.object({
  format: emptyAsUndefined(z.enum(PROXY_EXPORT_FORMATS)).default('url'),
  scope: emptyAsUndefined(z.enum(['bindings', 'proxies'])).default('bindings'),
  domain: emptyAsUndefined(domainSchema),
  status: emptyAsUndefined(z.enum(PROXY_STATUSES)),
});
export type ExportProxiesQuery = z.infer<typeof exportProxiesQuerySchema>;

export const v1ProxyLookupQuerySchema = z.object({ address: proxyAddressSchema });
export type V1ProxyLookupQuery = z.infer<typeof v1ProxyLookupQuerySchema>;

export const v1ProxyListQuerySchema = z.object({
  cursor: cursorQuery,
  limit: limitQuery,
  /** 管理员 Key 专用：列出全站绑定（非管理员 403） */
  all: boolFlag(),
  domain: emptyAsUndefined(domainSchema),
});
export type V1ProxyListQuery = z.infer<typeof v1ProxyListQuerySchema>;

export interface ProxyHealth {
  status: ProxyHealthStatus;
  checkedAt: string | null;
  latencyMs: number | null;
  error: string;
}

/** 代理视图：永不包含密码 */
export interface ProxyView {
  id: number;
  label: string;
  provider: string;
  source: ProxySource;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username: string;
  hasPassword: boolean;
  product: string;
  country: string;
  region: string;
  city: string;
  providerRef: string | null;
  orderId: number | null;
  expiresAt: string | null;
  status: ProxyStatus;
  maxBindings: number;
  bindingCount: number;
  health: ProxyHealth;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

/** 明文凭据（reveal / 地址查询 / 导出时返回） */
export interface ProxyCredential {
  proxyId: number;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username: string;
  password: string;
  /** buildProxyUrl 的结果 */
  url: string;
  country: string;
  city: string;
  product: string;
  status: ProxyStatus;
  expiresAt: string | null;
}

export interface ProxyBindingView {
  address: string;
  domain: string;
  proxyId: number;
  source: ProxyBindingSource;
  boundBy: number;
  createdAt: string;
  updatedAt: string;
  proxy: Pick<ProxyView, 'id' | 'label' | 'provider' | 'protocol' | 'host' | 'port' | 'username' | 'country' | 'status' | 'expiresAt' | 'health'>;
  /** 当前认领人；未认领为 null */
  ownerUserId: number | null;
  ownerUsername: string | null;
}

export interface ProxyBindingLookupItem {
  address: string;
  binding: ProxyBindingView | null;
}

export interface ProxyImportResult {
  created: number;
  duplicates: number;
  invalid: { line: number; reason: string }[];
  dryRun: boolean;
}

export interface AutoAssignResult {
  assigned: { address: string; proxyId: number }[];
  unassigned: string[];
  freeProxiesLeft: number;
  dryRun: boolean;
}

/** 导出：content 为文本行（\n 分隔）或 JSON 字符串 */
export interface ProxyExport {
  format: ProxyExportFormat;
  count: number;
  content: string;
}

export interface ProxyPoolStats {
  total: number;
  active: number;
  expired: number;
  disabled: number;
  /** 至少有一个绑定的代理数 */
  bound: number;
  /** active 且仍有剩余绑定额度的代理数 */
  free: number;
  byProvider: Record<string, number>;
}

export interface V1ProxyLookup {
  address: string;
  proxy: ProxyCredential | null;
}

export interface MyProxyBinding {
  address: string;
  proxy: ProxyCredential;
}

/** 解析出的单行代理（protocol 仅 url 格式能给出） */
export interface ParsedProxyLine {
  protocol?: ProxyProtocol;
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface ProxyEndpointParts {
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username: string;
  password: string;
}

/** IPv6 字面量加方括号 */
export function formatProxyHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/** `${protocol}://${user}:${pass}@${host}:${port}`；用户名与密码 URL 编码，均为空时不带 userinfo */
export function buildProxyUrl(p: ProxyEndpointParts): string {
  const auth = p.username || p.password
    ? `${encodeURIComponent(p.username)}${p.password ? ':' + encodeURIComponent(p.password) : ''}@`
    : '';
  return `${p.protocol}://${auth}${formatProxyHost(p.host)}:${p.port}`;
}

/** 按导出格式格式化一行 */
export function formatProxyLine(p: ProxyEndpointParts, format: ProxyExportFormat): string {
  const host = formatProxyHost(p.host);
  switch (format) {
    case 'url':
      return buildProxyUrl(p);
    case 'host_port_user_pass':
      return p.username || p.password ? `${host}:${p.port}:${p.username}:${p.password}` : `${host}:${p.port}`;
    case 'user_pass_at_host_port':
      return p.username || p.password ? `${p.username}:${p.password}@${host}:${p.port}` : `${host}:${p.port}`;
    case 'json':
      return JSON.stringify({ protocol: p.protocol, host: p.host, port: p.port, username: p.username, password: p.password, url: buildProxyUrl(p) });
  }
}

function parsePort(text: string): number | null {
  if (!/^\d{1,5}$/.test(text)) return null;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : null;
}

/** 解析 host:port（IPv6 需方括号）；返回剩余部分（':' 之后） */
function parseHostPort(text: string): { host: string; port: number; rest: string | null } | { error: string } {
  let host: string;
  let after: string;
  if (text.startsWith('[')) {
    const end = text.indexOf(']');
    if (end < 0) return { error: 'IPv6 地址缺少右方括号' };
    host = text.slice(1, end);
    after = text.slice(end + 1);
    if (!after.startsWith(':')) return { error: '缺少端口' };
    after = after.slice(1);
  } else {
    const colon = text.indexOf(':');
    if (colon < 0) return { error: '缺少端口' };
    host = text.slice(0, colon);
    after = text.slice(colon + 1);
  }
  host = host.toLowerCase();
  if (!host || !isProxyHost(host)) return { error: '主机格式非法' };
  const colon = after.indexOf(':');
  const portText = colon < 0 ? after : after.slice(0, colon);
  const port = parsePort(portText);
  if (port === null) return { error: '端口需为 1-65535' };
  return { host, port, rest: colon < 0 ? null : after.slice(colon + 1) };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const SCHEMES: Record<string, ProxyProtocol> = { http: 'http', https: 'https', socks5: 'socks5', socks5h: 'socks5' };

function parseUrlLine(line: string): ParsedProxyLine | { error: string } {
  const match = /^([a-z0-9]+):\/\/(.*)$/i.exec(line);
  if (!match) return { error: '不是 URL 格式' };
  const protocol = SCHEMES[match[1]!.toLowerCase()];
  if (!protocol) return { error: `不支持的协议 ${match[1]}` };
  let rest = match[2]!.replace(/\/+$/, '');
  if (rest.includes('/')) return { error: 'URL 不能带路径' };
  let username = '';
  let password = '';
  const at = rest.lastIndexOf('@');
  if (at >= 0) {
    const userinfo = rest.slice(0, at);
    rest = rest.slice(at + 1);
    const colon = userinfo.indexOf(':');
    username = safeDecode(colon < 0 ? userinfo : userinfo.slice(0, colon));
    password = colon < 0 ? '' : safeDecode(userinfo.slice(colon + 1));
  }
  const hp = parseHostPort(rest);
  if ('error' in hp) return hp;
  if (hp.rest !== null) return { error: '端口后有多余内容' };
  return { protocol, host: hp.host, port: hp.port, username, password };
}

function parseUserPassAtLine(line: string): ParsedProxyLine | { error: string } {
  const at = line.lastIndexOf('@');
  if (at < 0) {
    // 无凭据的代理只写 host:port
    const hp = parseHostPort(line);
    if ('error' in hp) return hp;
    if (hp.rest !== null) return { error: '需为 用户名:密码@host:port' };
    return { host: hp.host, port: hp.port, username: '', password: '' };
  }
  const userinfo = line.slice(0, at);
  const colon = userinfo.indexOf(':');
  if (colon < 0) return { error: '缺少 用户名:密码' };
  const hp = parseHostPort(line.slice(at + 1));
  if ('error' in hp) return hp;
  if (hp.rest !== null) return { error: '端口后有多余内容' };
  return { host: hp.host, port: hp.port, username: userinfo.slice(0, colon), password: userinfo.slice(colon + 1) };
}

function parseHostPortLine(line: string): ParsedProxyLine | { error: string } {
  const hp = parseHostPort(line);
  if ('error' in hp) return hp;
  if (hp.rest === null) return { host: hp.host, port: hp.port, username: '', password: '' };
  const colon = hp.rest.indexOf(':');
  if (colon < 0) return { error: '需为 host:port:用户名:密码' };
  // 密码允许含冒号：第一个冒号之后全部是密码
  return { host: hp.host, port: hp.port, username: hp.rest.slice(0, colon), password: hp.rest.slice(colon + 1) };
}

/**
 * 解析一行代理：
 * - url：http(s)/socks5(h)://[user[:pass]@]host:port
 * - host_port_user_pass：host:port[:user:pass]
 * - user_pass_at_host_port：user:pass@host:port
 * - auto：依次尝试 url → user_pass_at → host_port
 * 用户名可含空格（如 1024 的 `user-region-US-city-New Orleans`）；行首尾空白去掉。
 */
export function parseProxyLine(line: string, format: ProxyImportFormat): ParsedProxyLine | { error: string } {
  const text = line.trim();
  if (!text) return { error: '空行' };
  if (text.length > 1024) return { error: '行过长' };
  switch (format) {
    case 'url':
      return parseUrlLine(text);
    case 'host_port_user_pass':
      return parseHostPortLine(text);
    case 'user_pass_at_host_port':
      return parseUserPassAtLine(text);
    case 'auto': {
      if (/^[a-z0-9]+:\/\//i.test(text)) return parseUrlLine(text);
      if (text.includes('@')) {
        const parsed = parseUserPassAtLine(text);
        if (!('error' in parsed)) return parsed;
        // 密码里含 @ 的 host:port:user:pass 行
        const fallback = parseHostPortLine(text);
        return 'error' in fallback ? parsed : fallback;
      }
      return parseHostPortLine(text);
    }
  }
}
