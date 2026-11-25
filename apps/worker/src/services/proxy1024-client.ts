import {
  usdToCents,
  type Proxy1024Captcha,
  type Proxy1024CatalogueItem,
  type Proxy1024Product,
  type Proxy1024SubUser,
} from '@hpc-mail/shared';

/**
 * 1024proxy 控制台私有接口客户端（docs/integrations/1024proxy-dashboard-api.md，下称 P§）。
 *
 * - 只允许白名单里的路径（PROXY1024_ALLOWED_PATHS），没有通用 call(path)；P§9 的危险接口永不出现。
 * - 传输：POST application/x-www-form-urlencoded，body 带 token + lang，头 Accept-Protocol: https，
 *   redirect: 'manual'（3xx 视为失败），14 秒超时，响应 { code, msg, data }。
 * - 永不记录请求体（含 token / 密码）。客户端内两次调用间隔 ≥ minIntervalMs（默认 300ms）。
 * - 错误分类：下单（order*）与分配（static_use）这类有副作用的调用，网络错误/超时/5xx/非 JSON/3xx → 'unknown'
 *   （订单可能已创建，绝不重试）；只读调用 → 'transient'。code 300 → 'session_invalid'；其他非 0 → 'rejected'。
 *
 * UNVERIFIED（只有真实账号抓包能确认，P§11）：下单响应是否带 order_no（#1）、余额支付（#1，未实现）、
 * static_use 的部分失败语义（#8）、各列表接口的字段名（M 置信度，解析时做了多种兼容）。
 */

export const PROXY1024_API = 'https://api.1024proxy.com';
export const PROXY1024_SITE = 'https://1024proxy.com';

/** 客户端可以 POST 的全部路径。单测断言其中不含 P§9 的任何禁用路径。 */
export const PROXY1024_ALLOWED_PATHS = [
  '/get/v1/captcha/drag', '/add/v1/signin', '/add/v1/webauto', '/get/v1/member',
  '/get/v1/1024/static_index', '/get/v1/static/list', '/add/v1/1024/static_use', '/get/v1/1024/static_use_list',
  '/get/v2/unlimit/portServers', '/get/v3/unlimit/bandwidthServers', '/get/v1/availableSubUsers', '/get/v1/1024/subUsers',
  '/get/v1/traffic/server', '/add/v2/1024/orderStatic', '/add/v1/1024/orderUnlimit', '/add/v1/1024/orderFlow',
  '/get/v1/1024/get_recharge_record',
] as const;
export type Proxy1024Path = (typeof PROXY1024_ALLOWED_PATHS)[number];

/** P§9：任何情况下都不能调用的接口（白名单不得包含，测试断言） */
export const PROXY1024_FORBIDDEN_PATHS = [
  '/del/v1/cancel', '/del/v1/signout', '/update/v1/upPwd', '/update/v1/change_email',
  '/update/v1/secureMail', '/add/v1/mfaSecret', '/update/v1/bindMFa', '/del/v1/unbindMFa', '/update/v1/upAccessKey',
  '/update/v1/upShareCode', '/add/v1/getProfit', '/add/v1/cdkeyMake', '/update/v1/cdkeyUse', '/update/v1/upTokenCache', '/1024Recharge',
] as const;

/** 有副作用的路径：传输层失败时结果不明（unknown），绝不自动重试 */
const SIDE_EFFECT_PATHS = new Set<string>(['/add/v2/1024/orderStatic', '/add/v1/1024/orderUnlimit', '/add/v1/1024/orderFlow', '/add/v1/1024/static_use']);

/** 公开定价页（GET，无凭据） */
export const PROXY1024_PRICING_PAGES = {
  residential: `${PROXY1024_SITE}/pricing/residential/`,
  static: `${PROXY1024_SITE}/pricing/static/`,
  unlimited: `${PROXY1024_SITE}/pricing/unlimited/`,
} as const;

export type Proxy1024ErrorKind = 'session_invalid' | 'captcha_image_required' | 'rejected' | 'rate_limited' | 'transient' | 'unknown' | 'unsupported';

export class Proxy1024Error extends Error {
  readonly kind: Proxy1024ErrorKind;
  readonly code: number | null;
  /** 供应商返回的 msg（不含任何凭据） */
  readonly vendorMessage: string;

  constructor(kind: Proxy1024ErrorKind, message: string, code: number | null = null, vendorMessage = '') {
    super(message);
    this.name = 'Proxy1024Error';
    this.kind = kind;
    this.code = code;
    this.vendorMessage = vendorMessage;
  }
}

/** 无限端口 / 无限带宽服务器行 */
export interface Unlimited1024Row {
  id: string;
  ip: string;
  /** 'unlimit.1024proxy.io:NNNN' 或 'bwxxx.1024proxy.io' */
  domain: string;
  port: number | null;
  username: string;
  password: string;
  region: string;
  expiresAt: number | null;
  isDemo: boolean;
}

export interface Proxy1024StaticIp {
  id: string;
  ip: string;
  port: number;
  username: string;
  password: string;
  country: string;
  city: string;
  region: string;
  expiresAt: number | null;
}

export interface Proxy1024PurchaseRecord {
  orderNo: string;
  name: string;
  trueCents: number | null;
  payStatus: 'paid' | 'refunded' | 'pending';
  payTime: string | null;
}

/** 目录项 + 计算上限用的未折扣单价（static 的 data-costprice） */
export interface Proxy1024CatalogueEntry extends Proxy1024CatalogueItem {
  capUnitCents: number;
}

export interface Proxy1024Client {
  getSlideCaptcha(): Promise<Proxy1024Captcha>;
  signin(i: { email: string; password: string; captchaId: string; x: number; y: number }): Promise<{ token: string; tokenCacheDays: number | null }>;
  validateSession(): Promise<{ email: string }>;
  getMember(): Promise<{ email: string; balanceCents: number | null; totalBalanceCents: number | null; mfaBound: boolean; multiLogin: boolean | null }>;
  fetchCatalogue(): Promise<Proxy1024CatalogueEntry[]>;
  createOrder(o: { product: Proxy1024Product; sku: string; quantity: number; orderSpec: string }): Promise<{ checkoutUrl: string; orderNo: string | null; raw: unknown }>;
  /** UNVERIFIED（P§11 #1）：恒抛 Proxy1024Error('unsupported') */
  payOrderWithBalance(checkoutUrl: string): Promise<never>;
  getPurchaseRecords(q: { orderNo?: string; page: number; limit: number; start?: string; end?: string }): Promise<{ items: Proxy1024PurchaseRecord[]; total: number }>;
  listStaticIps(q: { page: number; size: number }): Promise<{ items: Proxy1024StaticIp[]; total: number }>;
  listStaticInventory(q: { code: string; city?: string }): Promise<{ id: string }[]>;
  /** UNVERIFIED 部分失败语义（P§11 #8）；消耗的是已付费的 IP 余额，不是钱 */
  allocateStaticIps(a: { code: string; ids: string[]; day: 7 | 30 | 90 }): Promise<void>;
  listPortServers(q: { page: number; pageSize: number }): Promise<{ items: Unlimited1024Row[]; total: number }>;
  listBandwidthServers(q: { page: number; pageSize: number }): Promise<{ items: Unlimited1024Row[]; total: number }>;
  listSubUsers(): Promise<Proxy1024SubUser[]>;
  getSubUserPassword(username: string): Promise<string>;
  listTrafficGateways(): Promise<{ hostname: string; title: string }[]>;
}

export interface Proxy1024ClientOptions {
  token: string;
  lang: 'en' | 'zh';
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** 同一客户端两次调用的最小间隔（默认 300ms；测试可设 0） */
  minIntervalMs?: number;
}

const DEFAULT_TIMEOUT_MS = 14_000;
const DEFAULT_MIN_INTERVAL_MS = 300;

// ───────────────────────────── 解析工具 ─────────────────────────────

function str(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
}

function intOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function centsOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  try {
    return usdToCents(typeof value === 'number' ? value : String(value).replace(/^\$\s*/, '').replace(/,/g, ''));
  } catch {
    return null;
  }
}

/**
 * 供应商时间 → 毫秒。数字：< 1e12 视为秒；'YYYY-MM-DD HH:mm:ss' 无时区：按 UTC+8 解析
 * （UNVERIFIED；1024 为中国团队，按 +8 解析得到更早的过期时间，宁早勿晚）。
 */
export function parseVendorTime(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || value === 0 || value === '0') return null;
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n < 1e12 ? n * 1000 : n;
  }
  const text = String(value).trim();
  const local = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (local) {
    const [, y, mo, d, h = '00', mi = '00', s = '00'] = local;
    return Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}+08:00`);
  }
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

/** 列表响应：data.list / data.lists / data.rows / data 本身为数组 */
function listOf(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    for (const key of ['list', 'lists', 'rows', 'data']) if (Array.isArray(d[key])) return d[key] as Record<string, unknown>[];
  }
  return [];
}

function totalOf(data: unknown, fallback: number): number {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const total = intOrNull((data as Record<string, unknown>).total ?? (data as Record<string, unknown>).count);
    if (total !== null) return total;
  }
  return fallback;
}

function dataUri(image: unknown): string {
  const text = str(image);
  if (!text || text.startsWith('data:')) return text;
  return `data:image/png;base64,${text}`;
}

function toUnlimitedRow(r: Record<string, unknown>): Unlimited1024Row {
  return {
    id: str(r.id),
    ip: str(r.ip),
    domain: str(r.domain),
    port: intOrNull(r.port),
    username: str(r.username ?? r.user),
    password: str(r.password ?? r.pass ?? r.pwd),
    region: str(r.region),
    expiresAt: parseVendorTime(r.expired ?? r.expire_time ?? r.expired_at),
    isDemo: r.is_demo === 1 || r.is_demo === '1' || r.is_demo === true,
  };
}

// ───────────────────────────── 定价页解析 ─────────────────────────────

interface HtmlTag {
  index: number;
  name: string;
  attrs: Record<string, string>;
}

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of source.matchAll(/([a-zA-Z_:][\w:.-]*)\s*=\s*"([^"]*)"/g)) attrs[m[1]!.toLowerCase()] = m[2]!;
  return attrs;
}

/** 扫描开始标签（属性可跨行），跳过 HTML 注释 */
function scanTags(html: string): HtmlTag[] {
  const clean = html.replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length));
  const tags: HtmlTag[] = [];
  for (const m of clean.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g)) {
    tags.push({ index: m.index!, name: m[1]!.toLowerCase(), attrs: parseAttrs(m[2]!) });
  }
  return tags;
}

function hasClass(tag: HtmlTag, cls: string): boolean {
  return (tag.attrs.class ?? '').split(/\s+/).includes(cls);
}

function textAfter(html: string, index: number): string {
  const close = html.indexOf('>', index);
  const end = html.indexOf('<', close + 1);
  return html.slice(close + 1, end < 0 ? undefined : end).replace(/\s+/g, ' ').trim();
}

/** 在 [from, to) 区间内找最后一个满足条件的 <p class=...> 的文本 */
function lastTextIn(html: string, tags: HtmlTag[], from: number, to: number, cls: string): string {
  let text = '';
  for (const tag of tags) {
    if (tag.index < from || tag.index >= to) continue;
    if (tag.name === 'p' && hasClass(tag, cls)) text = textAfter(html, tag.index);
  }
  return text;
}

/** 区间内第一个 <p class=...> 的文本 */
function firstTextIn(html: string, tags: HtmlTag[], from: number, to: number, cls: string): string {
  const tag = tags.find((t) => t.index >= from && t.index < to && t.name === 'p' && hasClass(t, cls));
  return tag ? textAfter(html, tag.index) : '';
}

function priceCents(text: string): number | null {
  const m = /\$\s*([\d,]+(?:\.\d+)?)/.exec(text);
  return m ? centsOrNull(m[1]!) : null;
}

/** /pricing/residential/：buy-btn[data-sn][data-num]；同一套餐内有 calculate-content 时按 GB 计价（单价 × num） */
export function parseResidentialPricing(html: string): Proxy1024CatalogueEntry[] {
  const tags = scanTags(html);
  const buttons = tags.filter((t) => hasClass(t, 'buy-btn') && t.attrs['data-sn']);
  const items: Proxy1024CatalogueEntry[] = [];
  buttons.forEach((btn, i) => {
    const prev = i > 0 ? buttons[i - 1]!.index : 0;
    const next = buttons[i + 1]?.index ?? html.length;
    const calc = tags.find((t) => t.index > btn.index && t.index < next && hasClass(t, 'calculate-content'));
    const title = lastTextIn(html, tags, prev, btn.index, 'title');
    const sku = btn.attrs['data-sn']!;
    if (calc) {
      const unit = centsOrNull(calc.attrs['data-price']);
      const min = intOrNull(calc.attrs['data-min']) ?? 1;
      const max = intOrNull(calc.attrs['data-max']) ?? min;
      if (unit === null || unit <= 0) return;
      items.push({ product: 'residential_flow', sku, label: title || sku, days: null, country: null, unitPriceCents: unit, capUnitCents: unit, minQuantity: min, maxQuantity: max });
    } else {
      const unit = priceCents(lastTextIn(html, tags, prev, btn.index, 'price'));
      if (unit === null || unit <= 0) return;
      // 固定套餐：num 固定为按钮上的 data-num（通常 1）
      const fixed = intOrNull(btn.attrs['data-num']) ?? 1;
      items.push({ product: 'residential_flow', sku, label: title || sku, days: null, country: null, unitPriceCents: unit, capUnitCents: unit, minQuantity: fixed, maxQuantity: fixed });
    }
  });
  return items;
}

/** /pricing/unlimited/：端口套餐 = calculate-content.unlimit-calculate[min,max] + 其后的 li.select-item[data-sn,data-day,data-price]；带宽 = li[data-sn][data-money] */
export function parseUnlimitedPricing(html: string): Proxy1024CatalogueEntry[] {
  const tags = scanTags(html);
  const items: Proxy1024CatalogueEntry[] = [];
  const calcs = tags.filter((t) => hasClass(t, 'unlimit-calculate'));
  calcs.forEach((calc, i) => {
    const next = calcs[i + 1]?.index ?? html.length;
    const min = intOrNull(calc.attrs['data-min']) ?? 1;
    const max = intOrNull(calc.attrs['data-max']) ?? min;
    for (const li of tags) {
      if (li.index <= calc.index || li.index >= next || li.name !== 'li' || !hasClass(li, 'select-item') || !li.attrs['data-sn']) continue;
      const unit = centsOrNull(li.attrs['data-price']);
      const days = intOrNull(li.attrs['data-day']);
      if (unit === null || unit <= 0) continue;
      items.push({
        product: 'unlimited_port', sku: li.attrs['data-sn']!, label: `${min}-${max} 端口 · ${days ?? '?'} 天`, days, country: null,
        unitPriceCents: unit, capUnitCents: unit, minQuantity: min, maxQuantity: max,
      });
    }
  });
  const blocks = tags.filter((t) => hasClass(t, 'bind-width-content'));
  blocks.forEach((block, i) => {
    const next = blocks[i + 1]?.index ?? html.length;
    const title = firstTextIn(html, tags, block.index, next, 'title');
    for (const li of tags) {
      if (li.index <= block.index || li.index >= next || li.name !== 'li' || !li.attrs['data-sn'] || li.attrs['data-money'] === undefined) continue;
      const money = centsOrNull(li.attrs['data-money']);
      if (money === null || money <= 0) continue;
      const days = intOrNull(li.attrs['data-day']);
      const hours = intOrNull(li.attrs['data-hour']);
      const duration = days && days > 0 ? `${days} 天` : `${hours ?? '?'} 小时`;
      items.push({
        product: 'unlimited_bandwidth', sku: li.attrs['data-sn']!, label: `${title || '带宽'} · ${duration}`, days: days && days > 0 ? days : null,
        country: null, unitPriceCents: money, capUnitCents: money, minQuantity: 1, maxQuantity: 1,
      });
    }
  });
  return items;
}

/** /pricing/static/：.country_lists[data-day] > .country_lists_detail[data-code][data-price][data-costprice] */
export function parseStaticPricing(html: string): Proxy1024CatalogueEntry[] {
  const tags = scanTags(html);
  const lists = tags.filter((t) => hasClass(t, 'country_lists') && t.attrs['data-day']);
  const items: Proxy1024CatalogueEntry[] = [];
  lists.forEach((list, i) => {
    const next = lists[i + 1]?.index ?? html.length;
    const days = intOrNull(list.attrs['data-day']);
    if (days === null) return;
    for (const tag of tags) {
      if (tag.index <= list.index || tag.index >= next || !hasClass(tag, 'country_lists_detail')) continue;
      const code = (tag.attrs['data-code'] ?? '').toUpperCase();
      const unit = centsOrNull(tag.attrs['data-price']);
      if (!/^[A-Z0-9]{2,4}$/.test(code) || unit === null || unit <= 0) continue;
      const cost = centsOrNull(tag.attrs['data-costprice']);
      items.push({
        product: 'static_isp', sku: '', label: `${code} · ${days} 天${tag.attrs['data-region'] ? ` · ${tag.attrs['data-region']}` : ''}`,
        days, country: code, unitPriceCents: unit, capUnitCents: Math.max(unit, cost ?? 0), minQuantity: 1, maxQuantity: 500,
      });
    }
  });
  return items;
}

// ───────────────────────────── 客户端 ─────────────────────────────

const ORDER_PATHS: Record<Proxy1024Product, Proxy1024Path> = {
  static_isp: '/add/v2/1024/orderStatic',
  unlimited_port: '/add/v1/1024/orderUnlimit',
  unlimited_bandwidth: '/add/v1/1024/orderUnlimit',
  residential_flow: '/add/v1/1024/orderFlow',
};

function orderBody(o: { product: Proxy1024Product; sku: string; quantity: number; orderSpec: string }): Record<string, string> {
  switch (o.product) {
    case 'static_isp': return { data: o.orderSpec, coupon_code: '' };
    case 'unlimited_port': return { sn: o.sku, cate: 'ports', num: String(o.quantity) };
    case 'unlimited_bandwidth': return { sn: o.sku, cate: 'bandwidth', num: String(o.quantity) };
    case 'residential_flow': return { sn: o.sku, num: String(o.quantity) };
  }
}

/**
 * 从下单响应 / 结账链接里尽力取订单号（UNVERIFIED：响应与链接格式未知）。
 * 只认明确的订单号字段；不能用 `sn`——它在这套接口里是 SKU 编码（请求字段 sn=flowmax100 等），响应回显时会被误当订单号。
 */
function orderNoFrom(data: Record<string, unknown>, url: string): string | null {
  const direct = str(data.order_no ?? data.orderNo ?? data.order_sn ?? data.out_trade_no).trim();
  if (direct) return direct.slice(0, 64);
  try {
    const parsed = new URL(url);
    for (const key of ['order_no', 'orderNo', 'order_sn', 'out_trade_no']) {
      const value = parsed.searchParams.get(key);
      if (value) return value.slice(0, 64);
    }
  } catch {
    // 非法 URL 交给调用方判定
  }
  return null;
}

export function createProxy1024Client(opts: Proxy1024ClientOptions): Proxy1024Client {
  const doFetch = opts.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const minInterval = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const allowed = new Set<string>(PROXY1024_ALLOWED_PATHS);
  let lastCallAt = 0;

  async function throttle(): Promise<void> {
    const wait = lastCallAt + minInterval - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastCallAt = Date.now();
  }

  async function timed(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await doFetch(url, { ...init, redirect: 'manual', signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function post(path: Proxy1024Path, fields: Record<string, string> = {}, auth = true): Promise<unknown> {
    if (!allowed.has(path)) throw new Proxy1024Error('unsupported', `路径不在白名单：${path}`);
    const sideEffect = SIDE_EFFECT_PATHS.has(path);
    const lost = (message: string) => new Proxy1024Error(sideEffect ? 'unknown' : 'transient', message);
    await throttle();
    const body = new URLSearchParams({ ...fields, lang: opts.lang, token: auth ? opts.token : '' });
    let response: Response;
    try {
      response = await timed(`${PROXY1024_API}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'Accept-Protocol': 'https', Accept: 'application/json' },
        body: body.toString(),
      });
    } catch (e) {
      const aborted = e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError');
      throw lost(aborted ? '1024proxy 请求超时' : '1024proxy 网络错误');
    }
    if (response.status === 429 && !sideEffect) throw new Proxy1024Error('rate_limited', '1024proxy 限流');
    if (response.status >= 300) throw lost(`1024proxy 返回 HTTP ${response.status}`);
    let payload: { code?: unknown; msg?: unknown; data?: unknown };
    try {
      payload = await response.json() as typeof payload;
    } catch {
      throw lost('1024proxy 返回了非 JSON 响应');
    }
    if (!payload || typeof payload !== 'object') throw lost('1024proxy 响应格式异常');
    const code = intOrNull(payload.code);
    const msg = str(payload.msg).slice(0, 300);
    if (code === 0) return payload.data;
    if (code === 300) throw new Proxy1024Error('session_invalid', '1024proxy 会话已失效，请重新登录', 300, msg);
    if (code === 30) throw new Proxy1024Error('captcha_image_required', '请先在 1024proxy 官网登录一次后再试', 30, msg);
    if (code === null) throw lost('1024proxy 响应缺少 code');
    throw new Proxy1024Error('rejected', msg || `1024proxy 拒绝了请求（code ${code}）`, code, msg);
  }

  async function getPage(url: string): Promise<string> {
    await throttle();
    let response: Response;
    try {
      response = await timed(url, { method: 'GET', headers: { Accept: 'text/html' } });
    } catch {
      throw new Proxy1024Error('transient', '读取 1024proxy 定价页失败');
    }
    if (!response.ok) throw new Proxy1024Error('transient', `读取 1024proxy 定价页失败（HTTP ${response.status}）`);
    return response.text();
  }

  const record = (r: Record<string, unknown>): Proxy1024PurchaseRecord => {
    const status = intOrNull(r.pay_status);
    return {
      orderNo: str(r.order_no),
      name: str(r.name),
      trueCents: centsOrNull(r.true_money),
      payStatus: status === 1 ? 'paid' : status === 2 ? 'refunded' : 'pending',
      payTime: str(r.pay_time) || null,
    };
  };

  return {
    async getSlideCaptcha() {
      const d = (await post('/get/v1/captcha/drag', {}, false) ?? {}) as Record<string, unknown>;
      const captchaId = str(d.id);
      if (!captchaId) throw new Proxy1024Error('transient', '1024proxy 验证码响应缺少 id');
      return {
        captchaId,
        masterImage: dataUri(d.master_image),
        tileImage: dataUri(d.tile_image),
        tileWidth: intOrNull(d.tile_width) ?? 0,
        tileHeight: intOrNull(d.tile_height) ?? 0,
        initialX: intOrNull(d.initial_x) ?? 0,
        initialY: intOrNull(d.initial_y) ?? 0,
      };
    },

    async signin(i) {
      const d = (await post('/add/v1/signin', { email: i.email, pwd: i.password, pcode: '', idkey: i.captchaId, x: String(i.x), y: String(i.y) }, false) ?? {}) as Record<string, unknown>;
      const token = str(d.token);
      if (!token) throw new Proxy1024Error('transient', '1024proxy 登录响应缺少 token');
      return { token, tokenCacheDays: intOrNull(d.token_cache) };
    },

    async validateSession() {
      const d = (await post('/add/v1/webauto', { session: opts.token }) ?? {}) as Record<string, unknown>;
      return { email: str(d.email) };
    },

    async getMember() {
      const d = (await post('/get/v1/member') ?? {}) as Record<string, unknown>;
      return {
        email: str(d.email),
        balanceCents: centsOrNull(d.balance),
        totalBalanceCents: centsOrNull(d.total_balance),
        mfaBound: str(d.mfa_bind) === 'bind',
        multiLogin: d.morelogin === undefined || d.morelogin === null ? null : intOrNull(d.morelogin) === 1,
      };
    },

    async fetchCatalogue() {
      const [residential, unlimited, statics] = await Promise.all([
        getPage(PROXY1024_PRICING_PAGES.residential),
        getPage(PROXY1024_PRICING_PAGES.unlimited),
        getPage(PROXY1024_PRICING_PAGES.static),
      ]);
      const items = [...parseStaticPricing(statics), ...parseUnlimitedPricing(unlimited), ...parseResidentialPricing(residential)];
      if (!items.length) throw new Proxy1024Error('transient', '1024proxy 定价页解析失败（页面结构可能已变化）');
      return items;
    },

    async createOrder(o) {
      const raw = await post(ORDER_PATHS[o.product], orderBody(o));
      const data = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const checkoutUrl = str(data.url).trim();
      // code 0 却没有结账链接：订单可能已建，按结果不明处理
      if (!/^https:\/\//i.test(checkoutUrl)) throw new Proxy1024Error('unknown', '1024proxy 下单响应缺少结账链接');
      return { checkoutUrl, orderNo: orderNoFrom(data, checkoutUrl), raw };
    },

    async payOrderWithBalance() {
      throw new Proxy1024Error('unsupported', '余额支付尚未支持：请在 1024proxy 结账页手动完成支付');
    },

    async getPurchaseRecords(q) {
      const fields: Record<string, string> = { page: String(q.page), limit: String(q.limit), start: q.start ?? '', end: q.end ?? '', order_no: q.orderNo ?? '' };
      const d = await post('/get/v1/1024/get_recharge_record', fields);
      const items = listOf(d).map(record);
      return { items, total: totalOf(d, items.length) };
    },

    async listStaticIps(q) {
      const d = await post('/get/v1/1024/static_use_list', {
        code: '', ip: '', mark: '', username: '', size: String(q.size), page: String(q.page), expired: '', order_field: '', order_type: '',
      });
      const items = listOf(d).map((r) => ({
        id: str(r.id),
        ip: str(r.ip),
        port: intOrNull(r.port) ?? 0,
        username: str(r.username),
        password: str(r.password ?? r.pass),
        country: str(r.code ?? r.country_code ?? '').slice(0, 2).toUpperCase(),
        city: str(r.city),
        region: str(r.region ?? r.country),
        expiresAt: parseVendorTime(r.expired ?? r.expire_time),
      }));
      return { items, total: totalOf(d, items.length) };
    },

    async listStaticInventory(q) {
      const d = await post('/get/v1/static/list', { code: q.code, city: q.city ?? '', ip_segment: '' });
      return listOf(d).map((r) => ({ id: str(r.id) })).filter((r) => r.id);
    },

    async allocateStaticIps(a) {
      await post('/add/v1/1024/static_use', { code: a.code, id: a.ids.join(','), day: String(a.day), num: '1', username: '', password: '', ip_segment: '' });
    },

    async listPortServers(q) {
      const d = await post('/get/v2/unlimit/portServers', { page: String(q.page), page_size: String(q.pageSize), order_type: '', order_field: '' });
      const items = listOf(d).map(toUnlimitedRow);
      return { items, total: totalOf(d, items.length) };
    },

    async listBandwidthServers(q) {
      const d = await post('/get/v3/unlimit/bandwidthServers', { page: String(q.page), page_size: String(q.pageSize) });
      const items = listOf(d).map(toUnlimitedRow);
      return { items, total: totalOf(d, items.length) };
    },

    async listSubUsers() {
      const d = await post('/get/v1/1024/subUsers', { username: '', level: '' });
      return listOf(d).map((r) => ({ username: str(r.username), title: str(r.title), trafficBytes: intOrNull(r.traffic) })).filter((u) => u.username);
    },

    async getSubUserPassword(username) {
      const d = await post('/get/v1/availableSubUsers', { show_all: '1' });
      const hit = listOf(d).find((r) => str(r.username) === username);
      if (!hit) throw new Proxy1024Error('rejected', `子账号 ${username} 不存在`);
      return str(hit.password ?? hit.pass);
    },

    async listTrafficGateways() {
      const d = await post('/get/v1/traffic/server');
      return listOf(d).map((r) => ({ hostname: str(r.hostname), title: str(r.title) })).filter((g) => g.hostname);
    },
  };
}
