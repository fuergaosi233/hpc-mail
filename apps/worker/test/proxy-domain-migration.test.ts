import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

/** 0021：六张新表在 workerd D1 与 PostgreSQL 适配层上都能建出，默认值、唯一约束与 RETURNING id 行为一致 */
describe('0021_proxy_pool_domain_purchase', () => {
  const now = Date.now();

  it('proxies：默认值、端点唯一、provider_ref 为 NULL 时互不冲突', async () => {
    const insert = (host: string, username: string, provider = 'manual', ref: string | null = null) => env.db
      .prepare('INSERT INTO proxies (host, port, username, provider, provider_ref) VALUES (?, ?, ?, ?, ?) RETURNING id')
      .bind(host, 8080, username, provider, ref).first<{ id: number }>();
    const first = await insert('mig-1.example', 'u1');
    expect(first!.id).toBeGreaterThan(0);
    await insert('mig-1.example', 'u2');
    await insert('mig-2.example', 'u1', '1024proxy', 'sid-1');
    await expect(insert('mig-1.example', 'u1')).rejects.toThrow(/UNIQUE/);
    await expect(insert('mig-3.example', 'u1', '1024proxy', 'sid-1')).rejects.toThrow(/UNIQUE/);
    const row = await env.db.prepare('SELECT * FROM proxies WHERE id = ?').bind(first!.id).first<Record<string, unknown>>();
    expect(row).toMatchObject({
      label: '', provider: 'manual', source: 'manual', protocol: 'http', password_enc: '', status: 'active', max_bindings: 1,
      health_status: 'unknown', health_error: '', created_by: 0, provider_ref: null, order_id: null, expires_at: null,
    });
    expect(Number(row!.created_at)).toBeGreaterThan(now - 60_000);
    expect(Number(row!.updated_at)).toBeGreaterThan(now - 60_000);
  });

  it('address_proxy_bindings：地址主键，ON CONFLICT 更新', async () => {
    const proxy = await env.db.prepare("INSERT INTO proxies (host, port) VALUES ('mig-bind.example', 1) RETURNING id").first<{ id: number }>();
    const bind = (proxyId: number) => env.db.prepare(`INSERT INTO address_proxy_bindings (address, proxy_id, domain, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(address) DO UPDATE SET proxy_id = excluded.proxy_id, updated_at = excluded.updated_at RETURNING address`)
      .bind('a@mig.example', proxyId, 'mig.example', now, now).first<{ address: string }>();
    expect((await bind(proxy!.id))!.address).toBe('a@mig.example');
    await bind(proxy!.id + 1000);
    const row = await env.db.prepare('SELECT proxy_id, source, bound_by FROM address_proxy_bindings WHERE address = ?').bind('a@mig.example').first();
    expect(row).toEqual({ proxy_id: proxy!.id + 1000, source: 'manual', bound_by: 0 });
  });

  it('proxy_orders：order_no 唯一但允许多个 NULL', async () => {
    const insert = (orderNo: string | null) => env.db.prepare(`INSERT INTO proxy_orders (product, quantity, estimate_cents, cap_basis_cents, quote_expires_at, created_by, order_no)
      VALUES ('residential_flow', 1, 100, 120, ?, 1, ?) RETURNING id`).bind(now + 60_000, orderNo).first<{ id: number }>();
    const a = await insert(null);
    const b = await insert(null);
    expect(b!.id).toBeGreaterThan(a!.id);
    await insert('ORD-1');
    await expect(insert('ORD-1')).rejects.toThrow(/UNIQUE/);
    const row = await env.db.prepare('SELECT status, sku, order_spec, checkout_url_enc, materialized_count, actual_cents FROM proxy_orders WHERE id = ?').bind(a!.id).first();
    expect(row).toEqual({ status: 'quoted', sku: '', order_spec: '', checkout_url_enc: '', materialized_count: 0, actual_cents: null });
  });

  it('domain_purchase_batches / items：布尔与 JSON 默认值', async () => {
    const batch = await env.db.prepare('INSERT INTO domain_purchase_batches (quote_expires_at, created_by) VALUES (?, 1) RETURNING id')
      .bind(now + 60_000).first<{ id: number }>();
    const b = await env.db.prepare('SELECT status, years, auto_renew, privacy_level, quote_total_cents FROM domain_purchase_batches WHERE id = ?').bind(batch!.id).first();
    expect(b).toEqual({ status: 'quoted', years: 1, auto_renew: 0, privacy_level: 'high', quote_total_cents: 0 });
    const item = await env.db.prepare('INSERT INTO domain_purchase_items (batch_id, domain) VALUES (?, ?) RETURNING id').bind(batch!.id, 'mig-buy.example').first<{ id: number }>();
    const i = await env.db.prepare('SELECT status, name_servers, suspensions, step_attempts, operation_id, failed_step FROM domain_purchase_items WHERE id = ?').bind(item!.id).first();
    expect(i).toEqual({ status: 'quoted', name_servers: '[]', suspensions: '[]', step_attempts: 0, operation_id: null, failed_step: '' });
    // CAS 认领形状：状态 + operation_id IS NULL
    const claimed = await env.db.prepare("UPDATE domain_purchase_items SET status = 'registering', lease_until = ? WHERE id = ? AND status = 'quoted' AND operation_id IS NULL RETURNING id")
      .bind(now + 300_000, item!.id).first<{ id: number }>();
    expect(claimed!.id).toBe(item!.id);
    const again = await env.db.prepare("UPDATE domain_purchase_items SET status = 'registering' WHERE id = ? AND status = 'quoted' RETURNING id").bind(item!.id).first();
    expect(again).toBeNull();
  });

  it('integration_status：provider 主键 upsert', async () => {
    const upsert = (state: string) => env.db.prepare(`INSERT INTO integration_status (provider, state, checked_at) VALUES ('spaceship', ?, ?)
      ON CONFLICT(provider) DO UPDATE SET state = excluded.state, checked_at = excluded.checked_at`).bind(state, now).run();
    await upsert('ok');
    await upsert('invalid');
    expect(await env.db.prepare("SELECT state, detail, balance_cents FROM integration_status WHERE provider = 'spaceship'").first())
      .toEqual({ state: 'invalid', detail: '', balance_cents: null });
  });
});
