import { describe, expect, it } from 'vitest';
import {
  API_SCOPES,
  DEFAULT_SETTINGS,
  DOMAIN_ITEM_CHARGED_FOR_CAP,
  ERROR_CODES,
  ERROR_STATUS,
  MAX_SYSTEM_DOMAINS,
  SECRET_SETTING_PATHS,
  SETTING_SCHEMAS,
  autoAssignRequestSchema,
  buildProxyUrl,
  domainConfirmRequestSchema,
  domainsSettingSchema,
  formatCents,
  formatProxyLine,
  listProxiesQuerySchema,
  parseProxyLine,
  proxy1024ConfirmRequestSchema,
  proxy1024QuoteRequestSchema,
  proxy1024SettingSchema,
  proxyAddressSchema,
  proxyInputSchema,
  registrantContactRequestSchema,
  spaceshipSettingSchema,
  updateProxyRequestSchema,
  updateSettingsRequestSchema,
  usdToCents,
  v1ProxyListQuerySchema,
  type ParsedProxyLine,
  type ProxyEndpointParts,
} from '../src/index.js';

describe('usdToCents / formatCents', () => {
  it('字符串与数字换算为美分，不足一分向上取整', () => {
    expect(usdToCents('5.98')).toBe(598);
    expect(usdToCents(5.98)).toBe(598);
    expect(usdToCents('0')).toBe(0);
    expect(usdToCents('12')).toBe(1200);
    expect(usdToCents('0.5')).toBe(50);
    expect(usdToCents('.5')).toBe(50);
    expect(usdToCents('1.001')).toBe(101);
    expect(usdToCents('1.0000001')).toBe(101);
    expect(usdToCents('1.00000')).toBe(100);
    expect(usdToCents(' 3.10 ')).toBe(310);
    // 浮点误差不应被向上取整成多一分
    expect(usdToCents(0.1 + 0.2)).toBe(30);
    expect(usdToCents(19.99)).toBe(1999);
  });

  it('非法值抛错', () => {
    for (const bad of ['', 'abc', '-1', '1e3', '1,000.00', '$5', '5.5.5']) expect(() => usdToCents(bad)).toThrow();
    for (const bad of [Number.NaN, -0.01, Number.POSITIVE_INFINITY]) expect(() => usdToCents(bad)).toThrow();
  });

  it('formatCents', () => {
    expect(formatCents(598)).toBe('$5.98');
    expect(formatCents(5)).toBe('$0.05');
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(123456789)).toBe('$1,234,567.89');
    expect(formatCents(-598)).toBe('-$5.98');
  });
});

describe('代理行解析与格式化', () => {
  const base: ProxyEndpointParts = { protocol: 'http', host: '1.2.3.4', port: 8080, username: 'user', password: 'p@ss:w0rd' };

  it('buildProxyUrl 编码用户名密码，IPv6 加方括号，无凭据时不带 userinfo', () => {
    expect(buildProxyUrl(base)).toBe('http://user:p%40ss%3Aw0rd@1.2.3.4:8080');
    expect(buildProxyUrl({ ...base, username: 'user-region-US-city-New Orleans', password: 'x' }))
      .toBe('http://user-region-US-city-New%20Orleans:x@1.2.3.4:8080');
    expect(buildProxyUrl({ ...base, protocol: 'socks5', host: '2001:db8::1' })).toBe('socks5://user:p%40ss%3Aw0rd@[2001:db8::1]:8080');
    expect(buildProxyUrl({ ...base, username: '', password: '' })).toBe('http://1.2.3.4:8080');
  });

  it('各格式往返一致（含 IPv6 与带空格的用户名）', () => {
    const samples: ProxyEndpointParts[] = [
      base,
      { protocol: 'socks5', host: '2001:db8::1', port: 1080, username: 'user-region-US-city-New Orleans', password: 'secret' },
      { protocol: 'https', host: 'gw.example.com', port: 443, username: '', password: '' },
      { protocol: 'http', host: 'gw.example.com', port: 7777, username: 'a', password: 'b@c' },
    ];
    for (const sample of samples) {
      const fromUrl = parseProxyLine(formatProxyLine(sample, 'url'), 'url') as ParsedProxyLine;
      expect(fromUrl).toEqual(sample);
      const auto = parseProxyLine(formatProxyLine(sample, 'url'), 'auto') as ParsedProxyLine;
      expect(auto).toEqual(sample);
      for (const format of ['host_port_user_pass', 'user_pass_at_host_port'] as const) {
        const line = formatProxyLine(sample, format);
        const { protocol: _protocol, ...rest } = sample;
        expect(parseProxyLine(line, format), `${format}: ${line}`).toEqual(rest);
        expect(parseProxyLine(line, 'auto'), `auto: ${line}`).toEqual(rest);
      }
      const json = JSON.parse(formatProxyLine(sample, 'json')) as Record<string, unknown>;
      expect(json).toMatchObject({ ...sample, url: buildProxyUrl(sample) });
    }
  });

  it('常见供应商格式', () => {
    expect(parseProxyLine('socks5h://u:p@Proxy.Example.com:1080/', 'auto')).toEqual({ protocol: 'socks5', host: 'proxy.example.com', port: 1080, username: 'u', password: 'p' });
    expect(parseProxyLine('  5.6.7.8:3128  ', 'auto')).toEqual({ host: '5.6.7.8', port: 3128, username: '', password: '' });
    expect(parseProxyLine('5.6.7.8:3128:user-region-US-city-New Orleans:pw:with:colons', 'host_port_user_pass'))
      .toEqual({ host: '5.6.7.8', port: 3128, username: 'user-region-US-city-New Orleans', password: 'pw:with:colons' });
    expect(parseProxyLine('u:p@[2001:db8::2]:9000', 'auto')).toEqual({ host: '2001:db8::2', port: 9000, username: 'u', password: 'p' });
  });

  it('非法行返回原因而不是抛错', () => {
    for (const [line, format] of [
      ['', 'auto'],
      ['ftp://h:1', 'url'],
      ['http://h', 'url'],
      ['http://h:99999', 'url'],
      ['http://h:80/path', 'url'],
      ['host-only', 'auto'],
      ['1.2.3.4:abc', 'auto'],
      ['1.2.3.4:80:useronly', 'host_port_user_pass'],
      ['nouserpass@1.2.3.4:80', 'user_pass_at_host_port'],
      ['bad host:80', 'auto'],
      ['[2001:db8::1:80', 'auto'],
    ] as const) {
      const parsed = parseProxyLine(line, format);
      expect('error' in parsed, `${format}: ${line}`).toBe(true);
    }
  });
});

describe('代理请求 schema', () => {
  it('proxyInputSchema 规范化并填默认值', () => {
    const parsed = proxyInputSchema.parse({ host: ' GW.Example.COM ', port: 8000, country: 'us' });
    expect(parsed).toMatchObject({ host: 'gw.example.com', port: 8000, country: 'US', provider: 'manual', protocol: 'http', maxBindings: 1, status: 'active', expiresAt: null });
    expect(proxyInputSchema.parse({ host: '[2001:db8::1]', port: 1 }).host).toBe('2001:db8::1');
    expect(proxyInputSchema.safeParse({ host: 'bad host', port: 80 }).success).toBe(false);
    expect(proxyInputSchema.safeParse({ host: 'h.example', port: 0 }).success).toBe(false);
    expect(proxyInputSchema.safeParse({ host: 'h.example', port: 80, country: 'USA' }).success).toBe(false);
    expect(proxyInputSchema.safeParse({ host: 'h.example', port: 80, provider: 'Bad Name' }).success).toBe(false);
  });

  it('updateProxyRequestSchema 不套默认值且不能为空', () => {
    expect(updateProxyRequestSchema.safeParse({}).success).toBe(false);
    expect(updateProxyRequestSchema.parse({ notes: 'x' })).toEqual({ notes: 'x' });
  });

  it('地址小写且需带合法域名', () => {
    expect(proxyAddressSchema.parse(' Foo@Example.COM ')).toBe('foo@example.com');
    for (const bad of ['foo', '@example.com', 'foo@bar', 'a@b@example.com', 'a b@example.com']) {
      expect(proxyAddressSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('查询参数空串视为未传', () => {
    expect(listProxiesQuerySchema.parse({ cursor: '', limit: '', status: '' })).toEqual({ limit: 50 });
    expect(listProxiesQuerySchema.safeParse({ limit: '201' }).success).toBe(false);
    expect(v1ProxyListQuerySchema.parse({ all: '1' }).all).toBe(true);
    expect(v1ProxyListQuerySchema.parse({}).all).toBe(false);
  });

  it('auto-assign 显式地址模式必须给地址', () => {
    expect(autoAssignRequestSchema.safeParse({ target: 'addresses' }).success).toBe(false);
    expect(autoAssignRequestSchema.parse({ target: 'claimed' })).toMatchObject({ limit: 100, dryRun: false, filter: {} });
    expect(autoAssignRequestSchema.parse({ target: 'addresses', addresses: ['A@x.example'] }).addresses).toEqual(['a@x.example']);
  });
});

describe('采购请求 schema', () => {
  it('1024 报价按产品区分', () => {
    expect(proxy1024QuoteRequestSchema.safeParse({ product: 'static_isp', items: [{ country: 'us', days: 30, count: 2 }] }).success).toBe(true);
    expect(proxy1024QuoteRequestSchema.safeParse({ product: 'static_isp', items: [{ country: 'US', days: 31, count: 2 }] }).success).toBe(false);
    expect(proxy1024QuoteRequestSchema.safeParse({ product: 'static_isp', items: [] }).success).toBe(false);
    expect(proxy1024QuoteRequestSchema.parse({ product: 'unlimited_bandwidth', sku: 'x' })).toMatchObject({ quantity: 1 });
    expect(proxy1024QuoteRequestSchema.safeParse({ product: 'unlimited_bandwidth', sku: 'x', quantity: 2 }).success).toBe(false);
    expect(proxy1024QuoteRequestSchema.safeParse({ product: 'premium_flow', sku: 'x', quantity: 1 }).success).toBe(false);
    expect(proxy1024ConfirmRequestSchema.safeParse({ expectedCents: 0 }).success).toBe(false);
  });

  it('域名确认要求回传总价', () => {
    expect(domainConfirmRequestSchema.safeParse({ domains: ['a.example'], expectedTotalCents: 1099 }).success).toBe(true);
    expect(domainConfirmRequestSchema.safeParse({ domains: [], expectedTotalCents: 1 }).success).toBe(false);
    expect(domainConfirmRequestSchema.safeParse({ domains: ['a.example'] }).success).toBe(false);
  });

  it('注册人联系人电话格式', () => {
    const contact = { firstName: 'A', lastName: 'B', email: 'a@b.example', address1: '1 St', city: 'X', country: 'us', phone: '+1.4155550100' };
    expect(registrantContactRequestSchema.parse(contact).country).toBe('US');
    expect(registrantContactRequestSchema.safeParse({ ...contact, phone: '4155550100' }).success).toBe(false);
  });

  it('台账状态包含 domain_added', () => {
    expect(DOMAIN_ITEM_CHARGED_FOR_CAP).toContain('domain_added');
    expect(DOMAIN_ITEM_CHARGED_FOR_CAP).toContain('unknown');
  });
});

describe('设置与常量', () => {
  it('新设置键默认全关，空对象可解析（旧存储行兼容）', () => {
    expect(proxy1024SettingSchema.parse({})).toEqual(DEFAULT_SETTINGS.proxy1024);
    expect(spaceshipSettingSchema.parse({})).toEqual(DEFAULT_SETTINGS.spaceship);
    expect(DEFAULT_SETTINGS.proxy1024).toMatchObject({ enabled: false, maxOrderCents: 0, maxDailyCents: 0, password: '', sessionToken: '' });
    expect(DEFAULT_SETTINGS.spaceship).toMatchObject({ enabled: false, maxDomainCents: 0, maxBatchCents: 0, maxDailyCents: 0, ingressWorkerName: '' });
    expect(SETTING_SCHEMAS.proxy1024).toBe(proxy1024SettingSchema);
    expect(SETTING_SCHEMAS.spaceship).toBe(spaceshipSettingSchema);
    expect(updateSettingsRequestSchema.safeParse({ spaceship: {} }).success).toBe(true);
  });

  it('密文字段：明文受长度限制，库里的长密文仍可解析', () => {
    const sealed = 'enc:v1:k1:' + 'a'.repeat(16) + ':' + 'b'.repeat(900);
    expect(spaceshipSettingSchema.safeParse({ apiKey: sealed }).success).toBe(true);
    expect(spaceshipSettingSchema.safeParse({ apiKey: 'x'.repeat(257) }).success).toBe(false);
    expect(proxy1024SettingSchema.safeParse({ sessionToken: sealed }).success).toBe(true);
    expect(proxy1024SettingSchema.safeParse({ sessionToken: 'x'.repeat(513) }).success).toBe(false);
  });

  it('上限、ingress worker 与联系人 ID 校验', () => {
    expect(spaceshipSettingSchema.safeParse({ ingressWorkerName: 'hpc-mail-ingress-20261028' }).success).toBe(true);
    expect(spaceshipSettingSchema.safeParse({ ingressWorkerName: 'Bad_Name' }).success).toBe(false);
    expect(spaceshipSettingSchema.safeParse({ registrantContactId: 'short' }).success).toBe(false);
    expect(spaceshipSettingSchema.safeParse({ registrantContactId: '1ZdMXpapqp9sle5dl8BlppTJXAzf3' }).success).toBe(true);
    expect(proxy1024SettingSchema.safeParse({ maxOrderCents: -1 }).success).toBe(false);
  });

  it('密文路径、scope、错误码与系统域名上限', () => {
    expect(SECRET_SETTING_PATHS).toEqual(['ai_model.apiKey', 'proxy1024.password', 'proxy1024.sessionToken', 'spaceship.apiKey', 'spaceship.apiSecret']);
    expect(API_SCOPES.at(-1)).toBe('proxy.read');
    expect(ERROR_CODES).toContain('not_configured');
    expect(ERROR_STATUS.not_configured).toBe(503);
    expect(ERROR_STATUS.upstream_failed).toBe(502);
    expect(MAX_SYSTEM_DOMAINS).toBe(64);
    const list = Array.from({ length: MAX_SYSTEM_DOMAINS + 1 }, (_, i) => ({ domain: `d${i}.example` }));
    expect(domainsSettingSchema.safeParse({ list: list.slice(0, MAX_SYSTEM_DOMAINS) }).success).toBe(true);
    expect(domainsSettingSchema.safeParse({ list }).success).toBe(false);
  });
});
