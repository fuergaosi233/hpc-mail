import { describe, expect, it } from 'vitest';
import {
  hostedDnsConflictReason, hostedDnsFqdn, hostedDnsMailReason, hostedDnsRecordInputSchema, hostedDnsRelativeName, isHostedDnsName,
} from '../src/index.js';

const domain = 'example.com';
const reason = (type: string, name: string, content = '') => hostedDnsConflictReason({ type, fqdn: hostedDnsFqdn(name, domain), content }, domain);

describe('托管域名 DNS 记录名', () => {
  it('相对名称、@ 与以本域名结尾的完整域名互相转换', () => {
    expect(hostedDnsFqdn('@', domain)).toBe(domain);
    expect(hostedDnsFqdn('', domain)).toBe(domain);
    expect(hostedDnsFqdn('Example.com.', domain)).toBe(domain);
    expect(hostedDnsFqdn('www', domain)).toBe('www.example.com');
    expect(hostedDnsFqdn('www.example.com', domain)).toBe('www.example.com');
    expect(hostedDnsFqdn('*.dev', domain)).toBe('*.dev.example.com');
    expect(hostedDnsRelativeName('example.com', domain)).toBe('@');
    expect(hostedDnsRelativeName('_acme-challenge.Example.com.', domain)).toBe('_acme-challenge');
  });

  it('通配符只能在最前面，标签不能以连字符开头', () => {
    for (const ok of ['@', 'www', '*', '*.dev', '_minecraft._tcp.mc', 'a-b.c_d']) expect(isHostedDnsName(ok), ok).toBe(true);
    for (const bad of ['a.*', 'a..b', '-a', 'a-', 'a b', 'ü', `${'a'.repeat(64)}`]) expect(isHostedDnsName(bad), bad).toBe(false);
  });
});

describe('与邮箱冲突的记录', () => {
  it('根域 MX、根域 SPF、_dmarc、_domainkey、cf-bounce 由系统维护', () => {
    expect(reason('MX', '@')).toContain('MX');
    expect(reason('TXT', '@', '"v=spf1 include:_spf.mx.cloudflare.net ~all"')).toContain('SPF');
    expect(reason('TXT', '@', 'V=SPF1 -all')).toContain('SPF');
    // 多段字符串解析时直接拼接，拆开写也是 SPF
    expect(reason('TXT', '@', '"v=sp" "f1 include:other.example ~all"')).toContain('SPF');
    expect(reason('TXT', '@', ' "v=spf1" ')).toContain('SPF');
    expect(reason('TXT', '@', '"v=spf10 x"')).toBe('');
    expect(reason('TXT', '@', '"hello" "v=spf1"')).toBe('');
    expect(reason('TXT', '_dmarc', 'v=DMARC1; p=none')).toContain('DMARC');
    expect(reason('A', '_dmarc', '1.2.3.4')).toContain('DMARC');
    expect(reason('TXT', 'cf2024-1._domainkey', 'v=DKIM1')).toContain('DKIM');
    expect(reason('TXT', '*._domainkey', 'x')).toContain('DKIM');
    expect(reason('CNAME', '_domainkey', 'x.example.net')).toContain('DKIM');
    expect(reason('MX', 'cf-bounce', 'route1.mx.cloudflare.net')).toContain('cf-bounce');
    expect(reason('A', 'x.cf-bounce', '1.2.3.4')).toContain('cf-bounce');
  });

  it('根域不能设置 CNAME；常用的网站、验证与子域记录不冲突', () => {
    expect(reason('CNAME', '@', 'cname.vercel-dns.com')).toContain('CNAME');
    expect(hostedDnsMailReason({ type: 'CNAME', fqdn: domain, content: 'x.example.net' }, domain)).toBe('');
    expect(reason('A', '@', '1.2.3.4')).toBe('');
    expect(reason('AAAA', 'www', '2001:db8::1')).toBe('');
    expect(reason('CNAME', 'www', 'cname.vercel-dns.com')).toBe('');
    expect(reason('TXT', '@', 'google-site-verification=abc')).toBe('');
    expect(reason('TXT', 'mail', 'v=spf1 include:other.example ~all')).toBe('');
    expect(reason('MX', 'mail', 'mx.other.example')).toBe('');
    expect(reason('A', 'bounce', '1.2.3.4')).toBe('');
    expect(reason('A', 'my-cf-bounce', '1.2.3.4')).toBe('');
  });
});

describe('托管域名 DNS 记录请求', () => {
  it('按类型校验并归一化', () => {
    expect(hostedDnsRecordInputSchema.parse({ type: 'A', name: ' WWW. ', ttl: 1, content: '203.0.113.10' }))
      .toEqual({ type: 'A', name: 'www', ttl: 1, content: '203.0.113.10', comment: '' });
    expect(hostedDnsRecordInputSchema.parse({ type: 'CNAME', name: 'blog', ttl: 300, content: 'Target.Example.NET.' }))
      .toMatchObject({ content: 'target.example.net' });
    expect(hostedDnsRecordInputSchema.parse({ type: 'MX', name: 'mail', ttl: 1, content: 'mx.example.net', priority: 10 }))
      .toMatchObject({ priority: 10 });
    expect(hostedDnsRecordInputSchema.parse({ type: 'SRV', name: '_minecraft._tcp.mc', ttl: 1,
      srv: { priority: 0, weight: 5, port: 25565, target: 'MC.example.net.' } })).toMatchObject({ srv: { port: 25565, target: 'mc.example.net' } });
    expect(hostedDnsRecordInputSchema.parse({ type: 'CAA', name: '@', ttl: 1, caa: { flags: 0, tag: 'issue', value: 'letsencrypt.org' } }))
      .toMatchObject({ caa: { tag: 'issue' } });
  });

  it('拒绝不支持的类型、非法 TTL 与非法记录值', () => {
    const bad = [
      { type: 'NS', name: 'sub', ttl: 1, content: 'ns.example.net' },
      { type: 'A', name: 'www', ttl: 30, content: '1.2.3.4' },
      { type: 'A', name: 'www', ttl: 90000, content: '1.2.3.4' },
      { type: 'A', name: 'www', ttl: 1, content: '1.2.3' },
      { type: 'AAAA', name: 'www', ttl: 1, content: '1.2.3.4' },
      { type: 'CNAME', name: 'www', ttl: 1, content: 'localhost' },
      { type: 'MX', name: 'mail', ttl: 1, content: 'mx.example.net' },
      { type: 'TXT', name: 'a.*', ttl: 1, content: 'x' },
      { type: 'TXT', name: 'www', ttl: 1, content: 'x'.repeat(2049) },
      { type: 'CAA', name: '@', ttl: 1, caa: { flags: 1, tag: 'issue', value: 'x' } },
      { type: 'A', name: 'www', ttl: 1, content: '1.2.3.4', comment: 'x'.repeat(101) },
    ];
    for (const input of bad) expect(hostedDnsRecordInputSchema.safeParse(input).success, JSON.stringify(input)).toBe(false);
  });
});
