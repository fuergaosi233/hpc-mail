# DESIGN: proxy pool + 1024proxy purchasing + Spaceship bulk domain purchasing

Status: implementation design, 2026-11-25. Branch `feat/proxy-pool-spaceship` (base `codex/k3s-postgres`).
Inputs: `1024proxy-dashboard-api.md` (cited as **P§n**), `spaceship-api.md` (**S§n**), `code-map.md` (**C§n**), repo `CLAUDE.md`.
Paths: `W` = `apps/worker`, `S` = `packages/shared`, `Web` = `apps/web`.

This document is the contract between four parallel workstreams (FOUNDATION, SLICE_PROXY, SLICE_DOMAIN, SLICE_WEB)
and the INTEGRATOR. Anything named here (table, column, type, function, route, setting key, audit action) is
binding. If an implementer needs something extra, it must be private to their own files. Shared names are changed
only by FOUNDATION.

---

## 0. Ground rules (apply to every stream)

1. **No live vendor calls, no purchases, no deploys, no `git commit`/`push`.** All tests stub `fetch`
   (`vi.stubGlobal('fetch', …)`). The stub **must throw** for any URL it does not explicitly handle, so a
   forgotten mock fails the test instead of reaching `api.1024proxy.com` or `spaceship.dev`.
2. CLAUDE.md constraints: zod contracts live only in `S`; envelope `{data}` / `{error:{code,message},requestId}`;
   list pagination `?cursor=&limit=` → `{items,nextCursor}`; admin routes use `requireAuth, requireAdmin`;
   secret settings echo `SECRET_MASK` and submitting `SECRET_MASK` keeps the stored value; secrets never go into
   audit `target`/`detail`; no extra serial DB round trips on hot paths (`requireAuth`, `/v1` auth, inbound).
3. **SQL must work on D1/SQLite and on the PostgreSQL adapter** (`W/server/postgres.ts`, C§7):
   - no `json_extract` on the new tables (use real columns). The numeric `json_extract` allow-list at
     `postgres.ts:70` is **not** extended.
   - no `datetime()/strftime()/IFNULL/group_concat/json_object/GLOB/INSERT OR REPLACE`. Timestamps are integer
     milliseconds bound from JS (`Date.now()`), not computed in SQL.
   - booleans are bound as `1/0`; text comparisons lowercase both sides; inserts that need the id use
     `RETURNING id`; string arrays are passed as `json_each(?)` with a JSON-encoded array.
   - `INSERT … SELECT … WHERE … ON CONFLICT …` always has a `WHERE` (SQLite parsing rule, see `rate-counter.ts`).
   - never hold a transaction across an outbound HTTP call. Pattern: CAS-claim row → call out → write result.
   - SQL in this document uses `?name` markers for readability; implement with positional `?` / `?N` (both
     translated by the adapter). `<LIST>` markers mean the literal status list from the shared constant.
4. Every new worker test lives in `W/test/*.test.ts`, so it runs on workerd **and** in the Postgres suite
   (`TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55439/postgres pnpm --filter @hpc-mail/worker test:postgres`,
   container `docker run -d --rm -p 127.0.0.1:55439:5432 -e POSTGRES_PASSWORD=pw --name hpcmail-pgtest postgres:16`;
   55432 is taken on this Mac). Tests in one file share storage: use unique domains/addresses per test or reset in a
   fixture.
5. Money is always **integer US cents** (`*_cents` columns, `*Cents` fields). Vendor decimal strings are converted
   with `usdToCents` (§3.6), which rounds **up** to the next cent.
6. Every vendor feature is **off unless configured** (`enabled` flag + credentials + caps > 0). A cap of `0` means
   "purchasing forbidden", never "unlimited".

---

## 1. Decisions taken in this design (resolving the recon open issues)

| # | Question | Decision |
|---|---|---|
| D1 | Secret storage | New AES-GCM "secret box" (`W/src/lib/secret-box.ts`). Proxy passwords, 1024 session token/password and Spaceship key/secret are stored sealed (`enc:v1:<kid>:<iv>:<ct>`). Key: env `secret_box_key` (k3s `SECRET_BOX_KEY`, 32 random bytes base64) when set (`kid=k1`); otherwise HKDF-SHA256 from `jwt_secret` (`kid=j1`). Unprefixed values are treated as legacy plaintext on read. `ai_model.apiKey` is **not** migrated (out of scope). |
| D2 | Binding key | `address_proxy_bindings.address` (lowercased) is the PK: works for unclaimed addresses (C§7). One proxy per address. A proxy may serve `max_bindings` addresses (default 1). |
| D3 | Binding lifecycle | The binding belongs to the **address**, not the owner. Release, transfer, user deletion and hosted-domain teardown leave it unchanged (admin-managed inventory); no changes to `mailbox.ts`/`user.ts`/`hosted-domain.ts`. Visibility to non-admins is always computed from current ownership, so a released address's proxy stops being visible to its former owner automatically. |
| D4 | `/v1` authorisation | New scope `proxy.read` (added to `API_SCOPES`). A non-admin key sees proxies only for addresses whose `mailboxes.user_id` = key user (**shared-to-me does not grant proxy access**). An admin key sees any address. Mutations stay JWT-admin-only. |
| D5 | 1024 login | Primary: admin pastes the `zero_sid` token (masked setting). Secondary: "login with email+password" with **human-in-the-loop slide captcha** rendered in our admin UI (P§2.1–2.2): we fetch the captcha, the admin drags the tile, we call `signin`. No automated captcha solving. `code 30` (image captcha) → error "请先在 1024proxy 官网登录一次后再试". |
| D6 | 1024 payment | `order*` only creates an unpaid order and returns a checkout URL (P§5.1). Automatic "pay with balance" is **not implemented** (`payOrderWithBalance` exists in the client interface and always throws `Proxy1024Unsupported`). The order goes to `awaiting_payment`, the admin pays on the checkout page, the cron reconciles via `get_recharge_record`. When a real capture exists, only `payOrderWithBalance` + one state transition need to be added. |
| D7 | 1024 products in scope | `static_isp`, `unlimited_port`, `unlimited_bandwidth`, `residential_flow`. (`premium_flow`, `residential_ip` are out of scope; client may implement the endpoints but the contract enum excludes them.) |
| D8 | System domain cap | `domainsSettingSchema` keeps `.max(64)`; FOUNDATION exports `MAX_SYSTEM_DOMAINS = 64` and uses it in the schema. Domain purchase quote/confirm enforce `listed + in-flight + selected ≤ MAX_SYSTEM_DOMAINS`. Raising the cap is a separate decision (open issue). |
| D9 | Spaceship domains vs `hosted_domains` | Own tables; never inserted into `hosted_domains`. Cloudflare primitives from `cloudflare.ts` are called directly with a credentials object whose `workerName` is the ingress worker. |
| D10 | Ingress worker | `spaceship.ingressWorkerName` setting; if empty, `env.worker_name` **only when explicitly set** (k3s: `CF_EMAIL_WORKER_NAME=hpc-mail-ingress-20261028`). If neither is explicit, domain purchasing reports `ingressWorker: null` and confirm returns `not_configured`. The default `'hpc-cloud-mail'` fallback in `cloudflareCredentials` is never used by this feature. |
| D11 | Multi-replica safety | Every external side effect is preceded by a guarded `UPDATE … WHERE status=? … RETURNING id` (CAS). Lost-outcome rows become `unknown` and are never retried automatically. |
| D12 | Proxy health | No outbound probing from the server. Health is reported by automation/admin (`POST /api/admin/proxies/:id/health`); cron only flips `active → expired` by `expires_at`. |
| D13 | Feature settings UI | Each feature page has its own "配置" card that does `PUT /api/admin/settings` with only its key. `settings-page.tsx` is not modified. |

---

## 2. Database (FOUNDATION)

One migration: **`W/migrations/0021_proxy_pool_domain_purchase.sql`** (+ `meta/0021_snapshot.json`, `_journal.json`),
generated with `pnpm --filter @hpc-mail/worker exec drizzle-kit generate --name proxy_pool_domain_purchase` after
editing `W/src/db/schema.ts`. No hand-written DML. No partial indexes. FOUNDATION verifies it applies on both
engines (workerd test run + Postgres suite).

Drizzle definitions (append to `W/src/db/schema.ts`; column names are binding):

```ts
/** 代理库存：任意来源（手工/导入/1024）。密码用 secret box 加密（enc:v1:…），列表接口永不返回密码。 */
export const proxies = sqliteTable('proxies', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  label: text('label').notNull().default(''),
  /** 供应商名，自由文本小写（'1024proxy' 由采购同步写入；手工可填任意值，缺省 'manual'） */
  provider: text('provider').notNull().default('manual'),
  source: text('source', { enum: ['manual', 'import', 'proxy1024'] }).notNull().default('manual'),
  protocol: text('protocol', { enum: ['http', 'https', 'socks5'] }).notNull().default('http'),
  host: text('host').notNull(),
  port: integer('port').notNull(),
  username: text('username').notNull().default(''),
  /** sealed；'' 表示无密码 */
  passwordEnc: text('password_enc').notNull().default(''),
  /** static_isp | unlimited_port | unlimited_bandwidth | residential_sticky | 自由文本 */
  product: text('product').notNull().default(''),
  country: text('country').notNull().default(''),   // ISO-3166 alpha-2 upper, '' unknown
  region: text('region').notNull().default(''),
  city: text('city').notNull().default(''),
  /** 供应商侧唯一标识（1024 static_use 行 id、端口服务器 id、`sub:<user>:sid:<sid>`）；手工为 null */
  providerRef: text('provider_ref'),
  orderId: integer('order_id'),                      // proxy_orders.id, nullable
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
  status: text('status', { enum: ['active', 'disabled', 'expired'] }).notNull().default('active'),
  maxBindings: integer('max_bindings').notNull().default(1),   // 1..1000
  healthStatus: text('health_status', { enum: ['unknown', 'ok', 'fail'] }).notNull().default('unknown'),
  healthCheckedAt: integer('health_checked_at', { mode: 'timestamp_ms' }),
  healthLatencyMs: integer('health_latency_ms'),
  healthError: text('health_error').notNull().default(''),
  notes: text('notes').notNull().default(''),
  createdBy: integer('created_by').notNull().default(0),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch() * 1000)`),
  createdAt: createdAtColumn(),
}, (t) => [
  uniqueIndex('uq_proxies_endpoint').on(t.host, t.port, t.username),
  uniqueIndex('uq_proxies_provider_ref').on(t.provider, t.providerRef),   // NULLs never collide (both engines)
  index('idx_proxies_status').on(t.status, t.id),
  index('idx_proxies_order').on(t.orderId),
  index('idx_proxies_expires').on(t.expiresAt),
]);

/** 地址 ↔ 代理绑定。以地址为主键（未认领地址同样可绑），与认领/释放/过户解耦。 */
export const addressProxyBindings = sqliteTable('address_proxy_bindings', {
  address: text('address').primaryKey(),             // lowercased full address
  proxyId: integer('proxy_id').notNull(),
  domain: text('domain').notNull(),                  // part after '@', lowercased
  source: text('source', { enum: ['manual', 'auto', 'import'] }).notNull().default('manual'),
  boundBy: integer('bound_by').notNull().default(0),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch() * 1000)`),
  createdAt: createdAtColumn(),
}, (t) => [index('idx_address_proxy_bindings_proxy').on(t.proxyId), index('idx_address_proxy_bindings_domain').on(t.domain, t.address)]);

/** 1024proxy 订单：quote → confirm(下单) → awaiting_payment → paid → fulfilled；结果不明 = unknown，永不自动重试 */
export const proxyOrders = sqliteTable('proxy_orders', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  status: text('status', { enum: PROXY_ORDER_STATUSES }).notNull().default('quoted'),
  product: text('product', { enum: PROXY1024_PRODUCTS }).notNull(),
  sku: text('sku').notNull().default(''),             // 1024 sn; static_isp: ''
  quantity: integer('quantity').notNull(),            // GB / ports / IP count
  /** static_isp 的下单串 "KR-30-2,US-30-5"；其余 '' */
  orderSpec: text('order_spec').notNull().default(''),
  estimateCents: integer('estimate_cents').notNull(), // what the admin sees
  capBasisCents: integer('cap_basis_cents').notNull(),// ≥ estimate (undiscounted); caps compare this
  actualCents: integer('actual_cents'),               // true_money from records
  balanceCentsAtQuote: integer('balance_cents_at_quote'),
  quoteExpiresAt: integer('quote_expires_at', { mode: 'timestamp_ms' }).notNull(),
  orderNo: text('order_no'),
  checkoutUrlEnc: text('checkout_url_enc').notNull().default(''),  // sealed (may embed session)
  leaseUntil: integer('lease_until', { mode: 'timestamp_ms' }),
  lastError: text('last_error').notNull().default(''),
  materializedCount: integer('materialized_count').notNull().default(0),
  createdBy: integer('created_by').notNull(),
  confirmedBy: integer('confirmed_by'),
  confirmedAt: integer('confirmed_at', { mode: 'timestamp_ms' }),
  orderedAt: integer('ordered_at', { mode: 'timestamp_ms' }),
  paidAt: integer('paid_at', { mode: 'timestamp_ms' }),
  checkedAt: integer('checked_at', { mode: 'timestamp_ms' }),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch() * 1000)`),
  createdAt: createdAtColumn(),
}, (t) => [uniqueIndex('uq_proxy_orders_order_no').on(t.orderNo), index('idx_proxy_orders_status').on(t.status, t.checkedAt), index('idx_proxy_orders_confirmed').on(t.confirmedAt)]);

/** Spaceship 批量采购批次 */
export const domainPurchaseBatches = sqliteTable('domain_purchase_batches', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  status: text('status', { enum: DOMAIN_BATCH_STATUSES }).notNull().default('quoted'),
  years: integer('years').notNull().default(1),
  autoRenew: integer('auto_renew', { mode: 'boolean' }).notNull().default(false),
  privacyLevel: text('privacy_level', { enum: ['public', 'high'] }).notNull().default('high'),
  quoteTotalCents: integer('quote_total_cents').notNull().default(0),     // sum cap_basis of available items
  confirmedTotalCents: integer('confirmed_total_cents').notNull().default(0),
  quoteExpiresAt: integer('quote_expires_at', { mode: 'timestamp_ms' }).notNull(),
  leaseUntil: integer('lease_until', { mode: 'timestamp_ms' }),           // confirm-in-progress lease
  lastError: text('last_error').notNull().default(''),
  createdBy: integer('created_by').notNull(),
  confirmedBy: integer('confirmed_by'),
  confirmedAt: integer('confirmed_at', { mode: 'timestamp_ms' }),
  completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch() * 1000)`),
  createdAt: createdAtColumn(),
}, (t) => [index('idx_domain_purchase_batches_status').on(t.status, t.id)]);

/** 批次内每个域名的持久化进度（cron 可续跑） */
export const domainPurchaseItems = sqliteTable('domain_purchase_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  batchId: integer('batch_id').notNull(),
  domain: text('domain').notNull(),                       // A-label, lowercased
  status: text('status', { enum: DOMAIN_ITEM_STATUSES }).notNull().default('quoted'),
  availability: text('availability').notNull().default(''), // available|taken|invalidDomainName|tldNotSupported|unexpectedError
  skipReason: text('skip_reason').notNull().default(''),    // taken|premium|over_domain_cap|already_listed|hosted|has_history|in_flight|duplicate|not_selected|invalid
  priceClass: text('price_class').notNull().default(''),     // standard|premium
  finalCents: integer('final_cents'),
  regularCents: integer('regular_cents'),
  capBasisCents: integer('cap_basis_cents'),                 // max(final, regular) × years
  operationId: text('operation_id'),                         // spaceship-async-operationid
  opStatus: text('op_status').notNull().default(''),         // pending|success|failed
  cfZoneId: text('cf_zone_id'),
  nameServers: text('name_servers', { mode: 'json' }).notNull().$type<string[]>().default(sql`'[]'`),
  zoneStatus: text('zone_status').notNull().default(''),
  routingStatus: text('routing_status').notNull().default(''),
  lifecycleStatus: text('lifecycle_status').notNull().default(''),     // from GET /v1/domains/{d}
  verificationStatus: text('verification_status').notNull().default(''),
  suspensions: text('suspensions', { mode: 'json' }).notNull().$type<string[]>().default(sql`'[]'`),
  failedStep: text('failed_step').notNull().default(''),      // register|poll|zone|nameservers|routing|catch_all|domain_add
  lastError: text('last_error').notNull().default(''),
  errorCode: text('error_code').notNull().default(''),        // spaceship-error-code / CF code
  vendorOperationId: text('vendor_operation_id').notNull().default(''), // spaceship-operation-id header of last error
  stepAttempts: integer('step_attempts').notNull().default(0),          // attempts in current step
  leaseUntil: integer('lease_until', { mode: 'timestamp_ms' }),
  nextCheckAt: integer('next_check_at', { mode: 'timestamp_ms' }),
  zoneCreateAttemptedAt: integer('zone_create_attempted_at', { mode: 'timestamp_ms' }),
  registerAttemptedAt: integer('register_attempted_at', { mode: 'timestamp_ms' }),
  registeredAt: integer('registered_at', { mode: 'timestamp_ms' }),
  readyAt: integer('ready_at', { mode: 'timestamp_ms' }),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch() * 1000)`),
  createdAt: createdAtColumn(),
}, (t) => [index('idx_domain_purchase_items_batch').on(t.batchId, t.id), index('idx_domain_purchase_items_status').on(t.status, t.nextCheckAt), index('idx_domain_purchase_items_domain').on(t.domain)]);

/** 供应商会话/凭据健康（cron 写，避免与管理员编辑 settings 争写） */
export const integrationStatus = sqliteTable('integration_status', {
  provider: text('provider').primaryKey(),     // 'proxy1024' | 'spaceship'
  state: text('state').notNull().default('unknown'), // ok|missing|invalid|error|unknown
  detail: text('detail').notNull().default(''),       // non-secret (email, error message)
  balanceCents: integer('balance_cents'),
  checkedAt: integer('checked_at', { mode: 'timestamp_ms' }),
});
```

The status enums are imported from `@hpc-mail/shared` (§3) so DB, API and UI cannot drift
(`schema.ts` already imports shared constants elsewhere; if not, import the arrays).

### 2.1 State machines

**proxy_orders.status** (`PROXY_ORDER_STATUSES`):
`quoted → ordering → awaiting_payment → paid → fulfilled`; side exits `expired` (quote TTL passed),
`cancelled` (admin, only from `quoted`), `failed` (definite rejection of `order*`; nothing created),
`unknown` (lost outcome of `order*`), `abandoned` (admin gives up an `awaiting_payment`/`unknown` order;
no vendor call).
- `quoted → ordering` is the confirm CAS (caps checked inside the same statement, §6). There is no separate stored
  `confirmed` state for orders: confirm and execute are one admin action.
- `ordering` with an expired lease (crash) → `unknown`.
- `unknown → awaiting_payment|paid` only via reconciliation evidence (record with matching `order_no`, or a unique
  match on name + amount + time window) or admin `attach_order_no`. Never by re-calling `order*`.

**domain_purchase_batches.status** (`DOMAIN_BATCH_STATUSES`):
`quoted → confirming → processing → completed`; `confirming` with an expired lease → back to `quoted`
(confirm only does read-only vendor calls); `expired`, `cancelled` from `quoted`. `completed` when every item is in a
terminal state (`domain_added`, `failed`, `skipped`, `cancelled`); `unknown` items keep the batch `processing`.

**domain_purchase_items.status** (`DOMAIN_ITEM_STATUSES`):

```
quoted ─confirm─► confirmed ─CAS─► registering ─202+opId─► registering(op pending) ─op success─► registered
   │                               │  └─4xx(not 429)/op failed──► failed(step=register)   [no charge]
   └─► skipped / cancelled         └─5xx/timeout/no opId/lease expired──► unknown          [maybe charged]
registered ─CF createZone─► zone_created ─Spaceship PUT NS─► ns_set ─CF zone active─► zone_active
zone_active ─enable routing + catch-all→ingress worker─► routing_ready ─append settings.domains.list─► domain_added
any post-registration step: definite error → failed(step=…) [admin retry allowed]; transient → stay, retry next tick
unknown ─reconcile finds domain in account─► registered      (automatic, read-only evidence)
unknown ─admin resolve 'not_registered' (live availability = available)─► failed(step=register)
```

Registration (`confirmed → registering`) is the **only** money-moving transition; it happens at most once per item,
guarded by CAS. `failed(step=register)` is never re-registered from the same item; buying again requires a new quote
batch (which re-runs availability, price and caps).

---

## 3. Shared contracts (FOUNDATION) — `packages/shared/src`

New files, all exported from `S/src/index.ts`:

### 3.1 `S/src/money.ts`
```ts
/** "5.98" | 5.98 → 598; rounds UP to the next cent; throws on NaN/negative/non-numeric */
export function usdToCents(value: string | number): number;
/** 598 → "$5.98" */
export function formatCents(cents: number): string;
```

### 3.2 `S/src/constants.ts` (edit)
- `API_SCOPES` gains `'proxy.read'` (last element).
- `export const MAX_SYSTEM_DOMAINS = 64;` and `admin-settings.ts` uses it in `domainsSettingSchema`.

### 3.3 `S/src/envelope.ts` (edit)
Add error codes `not_configured` (503: feature disabled or credentials/caps missing) and `upstream_failed`
(502: vendor returned a definite error; message carries the vendor message, never secrets). Update `ERROR_CODES`
and `ERROR_STATUS`.

### 3.4 `S/src/schemas/proxy.ts`
```ts
export const PROXY_PROTOCOLS = ['http', 'https', 'socks5'] as const;
export const PROXY_STATUSES = ['active', 'disabled', 'expired'] as const;
export const PROXY_SOURCES = ['manual', 'import', 'proxy1024'] as const;
export const PROXY_HEALTH = ['unknown', 'ok', 'fail'] as const;
export const PROXY_BINDING_SOURCES = ['manual', 'auto', 'import'] as const;
export const PROXY_EXPORT_FORMATS = ['url', 'host_port_user_pass', 'user_pass_at_host_port', 'json'] as const;

export const proxyAddressSchema   // trim().toLowerCase(), ≤254, local@domain where domain passes domainSchema
export const proxyInputSchema = z.object({
  label: z.string().trim().max(100).default(''),
  provider: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{1,64}$/).default('manual'),
  protocol: z.enum(PROXY_PROTOCOLS).default('http'),
  host: z.string().trim().toLowerCase().min(1).max(253),       // hostname or IPv4/IPv6 literal
  port: z.number().int().min(1).max(65535),
  username: z.string().max(255).default(''),
  password: z.string().max(255).default(''),                  // SECRET_MASK on update = keep
  product: z.string().trim().max(64).default(''),
  country: z.string().trim().toUpperCase().regex(/^([A-Z]{2})?$/).default(''),
  region: z.string().trim().max(100).default(''),
  city: z.string().trim().max(100).default(''),
  expiresAt: z.iso.datetime().nullable().default(null),
  status: z.enum(['active', 'disabled']).default('active'),
  maxBindings: z.number().int().min(1).max(1000).default(1),
  notes: z.string().max(1000).default(''),
});
export const updateProxyRequestSchema = proxyInputSchema.partial().refine(nonEmpty);
export const listProxiesQuerySchema = z.object({ cursor, limit (1..200, default 50), q?, status?, provider?, country?,
  bound?: z.enum(['yes','no']).optional(), orderId?: coerce int });
export const importProxiesRequestSchema = z.object({
  text: z.string().max(500_000),                 // ≤ 2000 non-empty lines
  format: z.enum(['auto', 'url', 'host_port_user_pass', 'user_pass_at_host_port']).default('auto'),
  defaults: proxyInputSchema.pick({ provider, protocol, product, country, label, expiresAt, maxBindings }).partial().default({}),
  dryRun: z.boolean().default(false),
});
export const proxyHealthReportSchema = z.object({ ok: z.boolean(), latencyMs: z.number().int().min(0).max(600_000).optional(), error: z.string().max(500).optional() });
export const bindProxyRequestSchema = z.object({ proxyId: z.number().int().positive() });
export const listBindingsQuerySchema = z.object({ cursor, limit, domain?, q?, proxyId? });
export const lookupBindingsRequestSchema = z.object({ addresses: z.array(proxyAddressSchema).min(1).max(500) });
export const autoAssignRequestSchema = z.object({
  /** 'claimed' = mailboxes 表里尚未绑定的地址；'addresses' = 显式列表（可含未认领地址） */
  target: z.enum(['claimed', 'addresses']),
  domain: domainSchema.optional(),                       // filter for target=claimed
  addresses: z.array(proxyAddressSchema).max(500).optional(), // required for target=addresses
  limit: z.number().int().min(1).max(500).default(100),
  filter: z.object({ provider: z.string().optional(), country: z.string().optional(), product: z.string().optional() }).default({}),
  dryRun: z.boolean().default(false),
});
export const exportProxiesQuerySchema = z.object({ format: z.enum(PROXY_EXPORT_FORMATS).default('url'),
  scope: z.enum(['bindings', 'proxies']).default('bindings'), domain?: domainSchema, status?: z.enum(PROXY_STATUSES) });
export const v1ProxyLookupQuerySchema = z.object({ address: proxyAddressSchema });
export const v1ProxyListQuerySchema = z.object({ cursor, limit (1..200), all: optional flag, domain? });

export interface ProxyHealth { status: ProxyHealthStatus; checkedAt: string | null; latencyMs: number | null; error: string }
export interface ProxyView { id; label; provider; source; protocol; host; port; username; hasPassword: boolean;
  product; country; region; city; providerRef: string | null; orderId: number | null; expiresAt: string | null;
  status; maxBindings; bindingCount; health: ProxyHealth; notes; createdAt; updatedAt }      // NEVER password
export interface ProxyCredential { proxyId; protocol; host; port; username; password: string; url: string;
  country; city; product; status; expiresAt: string | null }                               // revealed form
export interface ProxyBindingView { address; domain; proxyId; source; boundBy: number; createdAt; updatedAt;
  proxy: Pick<ProxyView, 'id'|'label'|'provider'|'protocol'|'host'|'port'|'username'|'country'|'status'|'expiresAt'|'health'>;
  ownerUserId: number | null; ownerUsername: string | null }
export interface ProxyBindingLookupItem { address: string; binding: ProxyBindingView | null }
export interface ProxyImportResult { created: number; duplicates: number; invalid: { line: number; reason: string }[]; dryRun: boolean }
export interface AutoAssignResult { assigned: { address: string; proxyId: number }[]; unassigned: string[]; freeProxiesLeft: number; dryRun: boolean }
export interface ProxyExport { format: ProxyExportFormat; count: number; content: string }   // text lines or JSON string
export interface ProxyPoolStats { total; active; expired; disabled; bound; free; byProvider: Record<string, number> }
export interface V1ProxyLookup { address: string; proxy: ProxyCredential | null }
export interface MyProxyBinding { address: string; proxy: ProxyCredential }

/** Pure helpers (worker import + web display share them) */
export function buildProxyUrl(p: { protocol; host; port; username; password }): string;
//   `${protocol}://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${hostOrBracketedIPv6}:${port}`; no userinfo if both empty
export function formatProxyLine(p, format: ProxyExportFormat): string;
export function parseProxyLine(line: string, format: ImportFormat): ParsedProxyLine | { error: string };
//   url: http(s)/socks5(h)://[user[:pass]@]host:port ; host_port_user_pass: host:port[:user:pass] ; user_pass_at_host_port: user:pass@host:port ; auto tries url → user_pass_at → host_port
```

### 3.5 `S/src/schemas/proxy-1024.ts`
```ts
export const PROXY1024_PRODUCTS = ['static_isp', 'unlimited_port', 'unlimited_bandwidth', 'residential_flow'] as const;
export const PROXY_ORDER_STATUSES = ['quoted', 'ordering', 'awaiting_payment', 'paid', 'fulfilled', 'failed', 'unknown', 'expired', 'cancelled', 'abandoned'] as const;
export const PROXY_ORDER_ACTIVE_FOR_CAP = ['ordering', 'awaiting_payment', 'paid', 'fulfilled', 'unknown'] as const; // count toward daily cap

export const proxy1024SettingSchema = z.object({
  enabled: z.boolean().default(false),
  email: z.string().trim().max(254).default(''),
  password: z.string().max(256).default(''),        // SECRET
  sessionToken: z.string().max(512).default(''),    // SECRET (zero_sid)
  lang: z.enum(['en', 'zh']).default('en'),
  maxOrderCents: z.number().int().min(0).max(10_000_00).default(0),   // 0 = purchasing off
  maxDailyCents: z.number().int().min(0).max(100_000_00).default(0),  // rolling 24h
  quoteTtlMinutes: z.number().int().min(1).max(60).default(15),
});
export const proxy1024QuoteRequestSchema = z.discriminatedUnion('product', [
  z.object({ product: z.literal('static_isp'), items: z.array(z.object({ country: z.string().regex(/^[A-Z0-9]{2,4}$/), days: z.union([z.literal(7), z.literal(30), z.literal(90)]), count: z.number().int().min(1).max(500) })).min(1).max(20) }),
  z.object({ product: z.literal('unlimited_port'), sku: z.string().max(64), quantity: z.number().int().min(1).max(999) }),
  z.object({ product: z.literal('unlimited_bandwidth'), sku: z.string().max(64), quantity: z.literal(1).default(1) }),
  z.object({ product: z.literal('residential_flow'), sku: z.string().max(64), quantity: z.number().int().min(1).max(1000) }),
]);
export const proxy1024ConfirmRequestSchema = z.object({ expectedCents: z.number().int().min(1) }); // must equal order.estimateCents
export const proxy1024ResolveRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('abandon') }),
  z.object({ action: z.literal('attach_order_no'), orderNo: z.string().trim().min(1).max(64) }),
]);
export const proxy1024LoginRequestSchema = z.object({ captchaId: z.string().min(1).max(128), x: z.number().int().min(0).max(2000), y: z.number().int().min(0).max(2000) });
export const proxy1024SyncRequestSchema = z.object({ kinds: z.array(z.enum(['static_isp', 'unlimited_port', 'unlimited_bandwidth'])).min(1).default([...]), orderId: z.number().int().positive().optional() });
export const proxy1024GenerateStickyRequestSchema = z.object({
  subUser: z.string().trim().min(1).max(64),         // existing sub-user (from /sub-users)
  gateway: z.string().trim().max(253).optional(),    // host:port; default first /traffic/server entry
  country: z.string().regex(/^[A-Z]{2}$/), state: z.string().max(64).optional(), city: z.string().max(64).optional(),
  minutes: z.number().int().min(1).max(120).default(30),
  count: z.number().int().min(1).max(500),
  protocol: z.enum(['http', 'socks5']).default('http'),
  maxBindings: z.number().int().min(1).max(1000).default(1),
});
export interface Proxy1024Status { enabled: boolean; configured: boolean; session: 'ok' | 'missing' | 'invalid' | 'error' | 'unknown';
  email: string; balanceCents: number | null; checkedAt: string | null; lastError: string;
  caps: { maxOrderCents: number; maxDailyCents: number; spentLast24hCents: number }; purchasingAllowed: boolean }
export interface Proxy1024Captcha { captchaId: string; masterImage: string; tileImage: string; tileWidth: number; tileHeight: number; initialX: number; initialY: number } // data: URIs
export interface Proxy1024CatalogueItem { product: Proxy1024Product; sku: string; label: string; days: number | null;
  country: string | null; unitPriceCents: number; minQuantity: number; maxQuantity: number }
export interface Proxy1024Catalogue { items: Proxy1024CatalogueItem[]; fetchedAt: string; source: 'pricing_pages' }
export interface ProxyOrderView { id; status; product; sku; quantity; orderSpec; estimateCents; capBasisCents; actualCents: number | null;
  balanceCentsAtQuote: number | null; quoteExpiresAt; orderNo: string | null; checkoutUrl: string | null /* admin only, unsealed */;
  lastError; materializedCount; createdBy; confirmedBy: number | null; confirmedAt; orderedAt; paidAt; checkedAt; createdAt; updatedAt;
  warnings: string[] /* e.g. 'actual_exceeds_estimate', 'payment_manual' */ }
export interface Proxy1024SubUser { username: string; title: string; trafficBytes: number | null }
export interface Proxy1024SyncResult { created: number; updated: number; expired: number }
```

### 3.6 `S/src/schemas/domain-purchase.ts`
```ts
export const DOMAIN_BATCH_STATUSES = ['quoted', 'confirming', 'processing', 'completed', 'expired', 'cancelled'] as const;
export const DOMAIN_ITEM_STATUSES = ['quoted', 'skipped', 'confirmed', 'registering', 'registered', 'zone_created', 'ns_set',
  'zone_active', 'routing_ready', 'domain_added', 'failed', 'unknown', 'cancelled'] as const;
export const DOMAIN_ITEM_IN_FLIGHT = ['confirmed', 'registering', 'registered', 'zone_created', 'ns_set', 'zone_active', 'routing_ready', 'unknown'] as const;
export const DOMAIN_ITEM_CHARGED_FOR_CAP = [...DOMAIN_ITEM_IN_FLIGHT, 'domain_added'] as const;   // ledger also counts status='failed' AND failed_step NOT IN ('register','poll')
export const DOMAIN_ITEM_STEPS = ['register', 'poll', 'zone', 'nameservers', 'routing', 'catch_all', 'domain_add'] as const;

export const spaceshipSettingSchema = z.object({
  enabled: z.boolean().default(false),
  apiKey: z.string().max(256).default(''),       // SECRET
  apiSecret: z.string().max(256).default(''),    // SECRET
  registrantContactId: z.union([z.literal(''), z.string().regex(/^[A-Za-z0-9]{27,32}$/)]).default(''),
  years: z.number().int().min(1).max(10).default(1),
  autoRenew: z.boolean().default(false),
  privacyLevel: z.enum(['public', 'high']).default('high'),
  allowPremium: z.boolean().default(false),
  maxDomainCents: z.number().int().min(0).max(1_000_000).default(0),    // per domain (cap basis, all years)
  maxBatchCents: z.number().int().min(0).max(10_000_000).default(0),
  maxDailyCents: z.number().int().min(0).max(10_000_000).default(0),    // rolling 24h ledger
  maxBatchDomains: z.number().int().min(1).max(100).default(20),
  quoteTtlMinutes: z.number().int().min(1).max(60).default(15),
  /** catch-all 目标 Worker；k3s = 'hpc-mail-ingress-20261028'。空 = 用显式配置的 env.worker_name */
  ingressWorkerName: z.union([z.literal(''), z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/)]).default(''),
});
export const domainQuoteRequestSchema = z.object({
  /** 粘贴原文：按空白/逗号/分号拆分，转 A-label、小写、去重；或直接给数组 */
  domains: z.union([z.string().max(20_000), z.array(z.string().max(253)).max(100)]),
  years: z.number().int().min(1).max(10).optional(),     // default settings.spaceship.years
});
export const domainConfirmRequestSchema = z.object({
  domains: z.array(domainSchema).min(1).max(100),        // subset of the batch's available items
  expectedTotalCents: z.number().int().min(1),           // must equal Σ capBasisCents of those items
});
export const domainItemResolveRequestSchema = z.object({ action: z.enum(['mark_registered', 'mark_not_registered']) });
export const registrantContactRequestSchema = z.object({ firstName, lastName, organization?, email, address1, address2?, city,
  stateProvince?, postalCode?, country: /^[A-Z]{2}$/, phone: /^\+\d{1,3}\.\d{4,14}$/, phoneExt? });  // mirrors S§ contacts
export const listDomainBatchesQuerySchema = z.object({ cursor, limit, status?: z.enum(DOMAIN_BATCH_STATUSES) });

export interface DomainPurchaseItemView { id; batchId; domain; status; availability; skipReason; priceClass;
  finalCents: number | null; regularCents: number | null; capBasisCents: number | null;
  operationId: string | null; opStatus; nameServers: string[]; zoneStatus; routingStatus;
  lifecycleStatus; verificationStatus; suspensions: string[]; failedStep; lastError; errorCode; vendorOperationId;
  /** admin actions currently allowed */ actions: ('retry' | 'resolve' | 'refresh')[];
  /** true when money may have been spent but outcome unknown */ maybeCharged: boolean;
  registeredAt; readyAt; updatedAt }
export interface DomainPurchaseBatchView { id; status; years; autoRenew; privacyLevel; quoteTotalCents; confirmedTotalCents;
  quoteExpiresAt; lastError; createdBy; confirmedBy; confirmedAt; completedAt; createdAt;
  counts: Partial<Record<DomainItemStatus, number>>; items?: DomainPurchaseItemView[] /* only on GET /:id and quote/confirm */ }
export interface DomainPurchaseStatus { enabled; configured /* key+secret+contact */; cloudflareConfigured: boolean;
  ingressWorker: string | null; ingressWorkerSource: 'setting' | 'env' | null;
  caps: { maxDomainCents; maxBatchCents; maxDailyCents; maxBatchDomains; spentLast24hCents };
  systemDomains: { used: number; inFlight: number; max: number }; purchasingAllowed: boolean; reasons: string[] }
export interface SpaceshipCredentialTest { ok: true; domainCount: number }
```

### 3.7 `S/src/schemas/admin-settings.ts` (edit)
Add to `SETTING_SCHEMAS`, `Settings`, `DEFAULT_SETTINGS`, `updateSettingsRequestSchema` (optional):
- key **`proxy1024`** → `proxy1024SettingSchema` (imported from `proxy-1024.ts`), default all-off.
- key **`spaceship`** → `spaceshipSettingSchema`, default all-off.
- Every field has `.default()` so older stored rows parse (C§1, `mergeSettingRows`).
- `export const SECRET_SETTING_PATHS = ['ai_model.apiKey', 'proxy1024.password', 'proxy1024.sessionToken', 'spaceship.apiKey', 'spaceship.apiSecret'] as const;`
- **(FOUNDATION fix)** The four new secret fields use `secretSettingString(max)` from `S/src/secret-field.ts`
  (accepts plaintext ≤ `max`, or any `enc:v1:` value ≤ 4096). The same schema parses both the admin's request and the
  stored row, and a sealed value is longer than its plaintext cap; with a plain `.max(256)` the stored row would fail
  `safeParse` and `mergeSettingRows` would silently reset the whole key to defaults. `updateSettings` rejects
  submitted values that start with `enc:v1:` (`validation_failed`).

### 3.8 Shared tests (FOUNDATION): `S/test/proxy-contracts.test.ts`
`usdToCents` rounding; `parseProxyLine`/`formatProxyLine` round-trip incl. IPv6 + spaces in usernames
(`user-region-US-city-New Orleans`); `buildProxyUrl` encoding; quote/confirm schema edge cases; settings defaults parse `{}`.

---

## 4. Worker foundation pieces (FOUNDATION)

### 4.1 `W/src/lib/secret-box.ts`
```ts
export const SEALED_PREFIX = 'enc:v1:';
export function isSealed(value: string): boolean;
/** '' → ''; otherwise AES-256-GCM, 12-byte random IV, `enc:v1:<kid>:<iv b64url>:<ct b64url>`; kid 'k1' (env.secret_box_key) or 'j1' (HKDF(jwt_secret, info 'hpc-mail/secret-box/v1')) */
export async function sealSecret(env: Pick<Env, 'secret_box_key' | 'jwt_secret'>, plaintext: string): Promise<string>;
/** '' → ''; unprefixed → returned as-is (legacy plaintext); wrong key/tamper → throws AppError('internal', '密文无法解密…') */
export async function openSecret(env: Pick<Env, 'secret_box_key' | 'jwt_secret'>, sealed: string): Promise<string>;
```
Keys are imported once per isolate and cached by kid. Test: `W/test/secret-box.test.ts` (round trip both kids,
tamper detection, legacy passthrough).

### 4.2 `W/src/types.ts` (edit)
`Env.secret_box_key?: string` (secret; base64 of 32 bytes).

### 4.3 `W/src/services/setting.ts` (edit)
- In `updateSettings`, for keys `proxy1024` and `spaceship`: for each secret field — incoming `SECRET_MASK` → keep the
  stored (sealed) value; `''` → clear; anything else → `await sealSecret(env, value)`. `ai_model` handling unchanged.
- `maskSettings` masks the four new secret paths (`SECRET_MASK` if non-empty, else `''`).
- Export helper used by both slices:
  ```ts
  /** Reads fresh settings and returns the unsealed secret fields for one vendor key. */
  export async function readVendorSecrets(env: Env, key: 'proxy1024'): Promise<{ settings: Settings['proxy1024']; password: string; sessionToken: string }>;
  export async function readVendorSecrets(env: Env, key: 'spaceship'): Promise<{ settings: Settings['spaceship']; apiKey: string; apiSecret: string }>;
  /** Writes one secret field (sealed) without touching the others; used by 1024 login to store a fresh token. */
  export async function writeVendorSecret(env: Env, key: 'proxy1024', field: 'sessionToken', plaintext: string): Promise<void>;
  ```
- `W/src/services/audit.ts`: `SECRET_SETTING_FIELDS` = the shared `SECRET_SETTING_PATHS`.
- Test additions in `W/test/settings-secrets.test.ts`: mask echo, SECRET_MASK keep, clear, stored value is sealed,
  audit detail never contains the plaintext.

---

## 5. Services

All services take `env: Env` first; admin-facing functions take `actor: Pick<AuthUser, 'id' | 'username'>` and `ip`.
The cron actor is `{ id: 0, username: 'system' }` (define a local `SYSTEM_ACTOR` in each service; do not import the
private one from `hosted-domain.ts`). External clients are created through a factory so tests can inject fakes; tests
should still prefer stubbed `fetch` to exercise the real client.

### 5.1 `W/src/services/proxy-inventory.ts` (SLICE_PROXY)
```ts
export function toProxyView(row, bindingCount: number): ProxyView;
export async function listProxies(env, query: ListProxiesQuery): Promise<CursorPage<ProxyView>>;     // ORDER BY id DESC, cursor = last id
export async function getProxy(env, id: number): Promise<ProxyView>;                                   // 404 not_found
export async function proxyPoolStats(env): Promise<ProxyPoolStats>;
export async function createProxy(env, actor, input: ProxyInput, ip?): Promise<ProxyView>;             // 409 conflict on uq_proxies_endpoint
export async function updateProxy(env, actor, id, patch: UpdateProxyRequest, ip?): Promise<ProxyView>; // password SECRET_MASK keeps
export async function deleteProxy(env, actor, id, force: boolean, ip?): Promise<void>;                 // bound & !force → 409; force deletes bindings in same batch
export async function importProxies(env, actor, req: ImportProxiesRequest, ip?): Promise<ProxyImportResult>; // INSERT … ON CONFLICT DO NOTHING per row, batches of ≤ 50 statements
export async function revealProxy(env, actor, id, ip?): Promise<ProxyCredential>;                      // audit proxy.reveal
export async function reportProxyHealth(env, id, report: ProxyHealthReport): Promise<ProxyView>;
export async function listBindings(env, query: ListBindingsQuery): Promise<CursorPage<ProxyBindingView>>; // cursor = address (ORDER BY address)
export async function lookupBindings(env, addresses: string[]): Promise<ProxyBindingLookupItem[]>;     // single query, json_each(?)
export async function bindAddress(env, actor, address, proxyId, ip?, source?: ProxyBindingSource): Promise<ProxyBindingView>;
export async function unbindAddress(env, actor, address, ip?): Promise<void>;                          // 404 if not bound
export async function autoAssignProxies(env, actor, req: AutoAssignRequest, ip?): Promise<AutoAssignResult>;
export async function exportProxies(env, actor, query: ExportProxiesQuery, ip?): Promise<ProxyExport>; // ≤ 10 000 rows; audit proxy.export (count only)
export async function getProxyForAddress(env, viewer: { userId: number; role: Role }, address: string): Promise<ProxyCredential | null>;
export async function listViewerProxies(env, viewer: { userId: number; role: Role }, q: V1ProxyListQuery): Promise<CursorPage<MyProxyBinding>>;
export async function expireProxies(env, now = Date.now()): Promise<number>;                           // cron: active & expires_at<now → expired
/** Idempotent upsert keyed by (provider, provider_ref); used by proxy-purchase materialisation. */
export async function upsertProviderProxies(env, rows: ProviderProxyRow[], orderId: number | null): Promise<{ created: number; updated: number }>;
export interface ProviderProxyRow { provider: string; providerRef: string; protocol; host; port; username; password; product; country; region; city; expiresAt: number | null }
```
Binding SQL (one statement, atomic on both engines; `changes` → 0 means proxy full/inactive → 409):
```sql
INSERT INTO address_proxy_bindings (address, proxy_id, domain, source, bound_by, created_at, updated_at)
SELECT ?1, p.id, ?2, ?3, ?4, ?5, ?5 FROM proxies p
WHERE p.id = ?6 AND p.status = 'active' AND (p.expires_at IS NULL OR p.expires_at > ?5)
  AND (SELECT COUNT(*) FROM address_proxy_bindings b WHERE b.proxy_id = p.id AND b.address <> ?1) < p.max_bindings
ON CONFLICT(address) DO UPDATE SET proxy_id = excluded.proxy_id, source = excluded.source, bound_by = excluded.bound_by, updated_at = excluded.updated_at
RETURNING address
```
Auto-assign: read candidate addresses (`target=claimed`: `SELECT m.address FROM mailboxes m LEFT JOIN
address_proxy_bindings b ON b.address = m.address WHERE b.address IS NULL [AND m.domain = ?] ORDER BY m.id LIMIT ?`;
`target=addresses`: the given list minus already-bound), read free proxies ordered by id (filters on provider/country/
product, capacity `max_bindings - count`), pair them in JS, then run the bind statement per pair in one `db.batch`
(each guarded, `source='auto'`, `ON CONFLICT(address) DO NOTHING` instead of DO UPDATE so concurrent manual binds win).
Report pairs whose statement returned no row as `unassigned`. `dryRun` returns the pairing without writing.

Visibility for `getProxyForAddress`/`listViewerProxies`: admin → any binding; user → join
`mailboxes m ON m.address = b.address AND m.user_id = ?`. Status `disabled`/`expired` proxies are still returned
(with their `status`) so automation can tell why; callers decide.

### 5.2 `W/src/services/proxy1024-client.ts` (SLICE_PROXY)
HTTP client for the private dashboard API (P§0–§9). **Allow-listed paths only**; no generic `call(path)`.
```ts
export const PROXY1024_API = 'https://api.1024proxy.com';
export const PROXY1024_SITE = 'https://1024proxy.com';
/** Every path the client may POST. A unit test asserts none of P§9's forbidden paths is present. */
export const PROXY1024_ALLOWED_PATHS = ['/get/v1/captcha/drag', '/add/v1/signin', '/add/v1/webauto', '/get/v1/member',
  '/get/v1/1024/static_index', '/get/v1/static/list', '/add/v1/1024/static_use', '/get/v1/1024/static_use_list',
  '/get/v2/unlimit/portServers', '/get/v3/unlimit/bandwidthServers', '/get/v1/availableSubUsers', '/get/v1/1024/subUsers',
  '/get/v1/traffic/server', '/add/v2/1024/orderStatic', '/add/v1/1024/orderUnlimit', '/add/v1/1024/orderFlow',
  '/get/v1/1024/get_recharge_record'] as const;
export const PROXY1024_FORBIDDEN_PATHS = ['/del/v1/cancel', '/del/v1/signout', '/update/v1/upPwd', '/update/v1/change_email',
  '/update/v1/secureMail', '/add/v1/mfaSecret', '/update/v1/bindMFa', '/del/v1/unbindMFa', '/update/v1/upAccessKey',
  '/update/v1/upShareCode', '/add/v1/getProfit', '/add/v1/cdkeyMake', '/update/v1/cdkeyUse', '/update/v1/upTokenCache', '/1024Recharge'] as const;

export type Proxy1024ErrorKind = 'session_invalid' | 'captcha_image_required' | 'rejected' | 'rate_limited' | 'transient' | 'unknown' | 'unsupported';
export class Proxy1024Error extends Error { kind; code: number | null; vendorMessage: string }
/** For order* calls: network error, timeout (14 s), HTTP 5xx, non-JSON → kind 'unknown' (an order may exist). For reads → 'transient'. code 300 → 'session_invalid'. Other non-zero code → 'rejected'. */

export interface Proxy1024Client {
  getSlideCaptcha(): Promise<Proxy1024Captcha>;                                             // H
  signin(i: { email: string; password: string; captchaId: string; x: number; y: number }): Promise<{ token: string; tokenCacheDays: number | null }>; // H req / M resp; code 30 → captcha_image_required
  validateSession(): Promise<{ email: string }>;                                             // /add/v1/webauto {session}; H
  getMember(): Promise<{ email: string; balanceCents: number | null; totalBalanceCents: number | null; mfaBound: boolean; multiLogin: boolean | null }>; // H (balance fields M)
  fetchCatalogue(): Promise<Proxy1024CatalogueItem[]>;   // GET public pricing pages, parse data-* attrs (P§3 table); no token sent; M (HTML may change)
  createOrder(o: { product: Proxy1024Product; sku: string; quantity: number; orderSpec: string }): Promise<{ checkoutUrl: string; orderNo: string | null; raw: unknown }>; // H req / M resp — order_no presence UNVERIFIED
  /** UNVERIFIED (P§11 #1): always throws Proxy1024Error('unsupported'). */
  payOrderWithBalance(checkoutUrl: string): Promise<never>;
  getPurchaseRecords(q: { orderNo?: string; page: number; limit: number; start?: string; end?: string }): Promise<{ items: { orderNo: string; name: string; trueCents: number | null; payStatus: 'paid' | 'refunded' | 'pending'; payTime: string | null }[]; total: number }>; // M
  listStaticIps(q: { page: number; size: number }): Promise<{ items: { id: string; ip: string; port: number; username: string; password: string; country: string; city: string; region: string; expiresAt: number | null }[]; total: number }>; // H req / M fields
  listStaticInventory(q: { code: string; city?: string }): Promise<{ id: string }[]>;              // M
  /** UNVERIFIED partial-failure semantics (P§11 #8). Consumes already-paid IP balance, not money. */
  allocateStaticIps(a: { code: string; ids: string[]; day: 7 | 30 | 90 }): Promise<void>;
  listPortServers(q: { page: number; pageSize: number }): Promise<{ items: Unlimited1024Row[]; total: number }>;      // H
  listBandwidthServers(q: { page: number; pageSize: number }): Promise<{ items: Unlimited1024Row[]; total: number }>; // H
  listSubUsers(): Promise<Proxy1024SubUser[]>;                                               // H (never returns passwords to callers outside the service)
  getSubUserPassword(username: string): Promise<string>;                                     // via /get/v1/availableSubUsers; H
  listTrafficGateways(): Promise<{ hostname: string; title: string }[]>;                     // H
}
export function createProxy1024Client(opts: { token: string; lang: 'en' | 'zh'; fetch?: typeof fetch; timeoutMs?: number }): Proxy1024Client;
```
Transport: `POST` `application/x-www-form-urlencoded;charset=UTF-8`, body fields + `token` + `lang`, header
`Accept-Protocol: https`, `redirect: 'manual'` (3xx = failure, CLAUDE.md workerd note), 14 s timeout, response
`{code,msg,data}`. Never log request bodies (token/password). Client-side throttle: ≥ 300 ms between calls in one
client instance. `fetchCatalogue` is a plain GET of the pricing pages with no credentials.

### 5.3 `W/src/services/proxy-purchase.ts` (SLICE_PROXY)
```ts
export async function proxy1024Status(env, opts?: { live?: boolean }): Promise<Proxy1024Status>;   // live: getMember() and write integration_status
export async function startProxy1024Login(env, actor): Promise<Proxy1024Captcha>;                  // requires email+password configured
export async function completeProxy1024Login(env, actor, req: Proxy1024LoginRequest, ip?): Promise<Proxy1024Status>; // writeVendorSecret(sessionToken); audit proxy_1024.login
export async function getProxy1024Catalogue(env): Promise<Proxy1024Catalogue>;                    // 10-min in-memory cache per isolate
export async function quoteProxyOrder(env, actor, req: Proxy1024QuoteRequest, ip?): Promise<ProxyOrderView>;
export async function listProxyOrders(env, q: { cursor?; limit?; status? }): Promise<CursorPage<ProxyOrderView>>;
export async function getProxyOrder(env, id): Promise<ProxyOrderView>;
export async function confirmProxyOrder(env, actor, id, req: Proxy1024ConfirmRequest, ip?): Promise<ProxyOrderView>;
export async function cancelProxyOrder(env, actor, id, ip?): Promise<ProxyOrderView>;
export async function resolveProxyOrder(env, actor, id, req: Proxy1024ResolveRequest, ip?): Promise<ProxyOrderView>;
export async function refreshProxyOrder(env, actor, id): Promise<ProxyOrderView>;                  // reconcile one order now
export async function syncProxy1024Inventory(env, actor, req: Proxy1024SyncRequest, ip?): Promise<Proxy1024SyncResult>;
export async function allocateStaticForOrder(env, actor, orderId, ip?): Promise<Proxy1024SyncResult>; // UNVERIFIED path; paid static_isp only
export async function listProxy1024SubUsers(env): Promise<Proxy1024SubUser[]>;
export async function generateStickyProxies(env, actor, req: Proxy1024GenerateStickyRequest, ip?): Promise<{ created: number }>;
/** Cron: expire stale quotes; ordering with expired lease → unknown; reconcile awaiting_payment/unknown/paid (≤ 20 orders, ≤ 20 vendor calls, deadline 30 s). Skips entirely if not enabled or session != ok. */
export async function runProxy1024Cron(env, opts?: { now?: number; client?: Proxy1024Client; deadlineMs?: number }): Promise<number>;
```
Quote: validates feature enabled, session token present, caps > 0; prices from `getProxy1024Catalogue`;
`estimateCents` = server-independent estimate (static: unit × count × volume discount P§3; others unit × qty);
`capBasisCents` = undiscounted; reads `getMember()` for `balanceCentsAtQuote`; rejects with `validation_failed` if
`capBasisCents > maxOrderCents`; inserts `status='quoted'`, `quote_expires_at = now + ttl`.

Confirm (single admin action = confirm + execute):
1. Load order; must be `quoted`, unexpired, `req.expectedCents === estimateCents` else 409.
2. Re-check: re-fetch catalogue price (cache bypass) and `getMember()` balance. Price increased → update the row's
   estimate/cap basis/expiry (still `quoted`) and return 409 `conflict` "价格已变化，请重新确认". Balance known and
   `< estimateCents` → 409 "余额不足，请先在 1024proxy 手动充值".
3. CAS with caps (one statement):
   ```sql
   UPDATE proxy_orders SET status='ordering', confirmed_by=?, confirmed_at=?1, lease_until=?2, updated_at=?1
   WHERE id=? AND status='quoted' AND quote_expires_at > ?1 AND cap_basis_cents <= ?maxOrder
     AND cap_basis_cents + (SELECT COALESCE(SUM(COALESCE(actual_cents, cap_basis_cents)), 0) FROM proxy_orders
          WHERE status IN ('ordering','awaiting_payment','paid','fulfilled','unknown') AND confirmed_at >= ?dayAgo) <= ?maxDaily
   RETURNING id
   ```
   No row → re-read to report which guard failed (409 / `validation_failed`).
4. `createOrder(...)`. Success → `awaiting_payment` with sealed checkout URL + `order_no` (if present), audit
   `proxy_1024.order_created`, warning `payment_manual`. `rejected` → `failed` (definite, nothing created).
   `session_invalid` → `failed` + integration_status `invalid`. `unknown`/`transient`/any throw → **`unknown`**,
   audit `proxy_1024.order_unknown`. Never call `createOrder` again for this row.

Reconcile (cron and refresh): for `awaiting_payment`/`unknown` with `order_no` → `getPurchaseRecords({orderNo})`;
without `order_no` → records of the confirm day, match by product name + amount ± 1 cent + time window; exactly one
match → attach. `paid` → `paid` (`actual_cents`, `paid_at`; if actual > approved cap basis → warning
`actual_exceeds_estimate` + audit). `refunded` → `abandoned`. `paid` orders are materialised: `unlimited_port` /
`unlimited_bandwidth` → `syncProxy1024Inventory` for that kind tagging new rows with `order_id`; `static_isp` →
stays `paid` until admin runs allocate/sync; `residential_flow` → `fulfilled` (quota only; admin generates sticky
proxies). `fulfilled` when `materialized_count > 0` or product is `residential_flow`. `awaiting_payment` older than
7 days → stays, flagged `lastError='未支付超过 7 天'` (admin may abandon).

Sticky generation (no purchase): username `${subUser}-region-${CC}[-st-${state}][-city-${city}]-sid-${8 chars}-t-${minutes}`
(alphabet P§7.1), password from `getSubUserPassword`, host/port from gateway, `provider='1024proxy'`,
`source='proxy1024'`, `product='residential_sticky'`, `providerRef='sub:<user>:sid:<sid>'`.

Inventory sync maps: static row → `providerRef='static:<id>'`, `product='static_isp'`; port server → `'port:<id>'`;
bandwidth server → `'bw:<id>'`; host from `domain` (split `host:port`) else `ip`/`port`; rows missing from vendor
listings are **not** deleted (only `expires_at` drives `expired`).

### 5.4 `W/src/services/spaceship-client.ts` (SLICE_DOMAIN)
```ts
export const SPACESHIP_API = 'https://spaceship.dev/api';
export type SpaceshipOutcome = 'rejected' | 'rate_limited' | 'not_found' | 'transient' | 'unknown';
export class SpaceshipError extends Error { status: number; outcome: SpaceshipOutcome; code: string /* spaceship-error-code */;
  operationId: string /* spaceship-operation-id */; retryAfterSec: number | null; detail: string; fields: { field: string; details: string }[] }
export interface SsAvailability { domain: string; result: 'available' | 'taken' | 'invalidDomainName' | 'tldNotSupported' | 'unexpectedError' }
export interface SsPrice { domain: string; priceClass: 'standard' | 'premium'; finalCents: number; regularCents: number; years: number }
export interface SsAsyncOp { status: 'pending' | 'success' | 'failed'; type: string; details: unknown; createdAt: string; modifiedAt: string }
export interface SsDomainInfo { name: string; lifecycleStatus: string; verificationStatus: string | null; suspensions: string[]; nameservers: { provider: string; hosts: string[] } | null }
export interface SpaceshipClient {
  checkAvailability(domains: string[]): Promise<SsAvailability[]>;            // ≤ 20; match by name, not order (S§13)
  queryPricing(domains: string[], years: number): Promise<SsPrice[]>;         // register price for `years`
  saveContact(c: RegistrantContactRequest): Promise<{ contactId: string }>;   // PUT /v1/contacts
  registerDomain(domain: string, body: { years: number; autoRenew: boolean; privacyLevel: 'public' | 'high'; registrantContactId: string }): Promise<{ operationId: string }>;
  getAsyncOperation(id: string): Promise<SsAsyncOp>;
  getDomain(domain: string): Promise<SsDomainInfo | null>;                     // 404 → null
  listDomains(q: { take: number; skip: number; orderBy?: '-registrationDate' }): Promise<{ items: SsDomainInfo[]; total: number }>;
  setNameservers(domain: string, hosts: string[]): Promise<{ hosts: string[] }>;
}
export function createSpaceshipClient(creds: { apiKey: string; apiSecret: string }, opts?: { fetch?: typeof fetch; timeoutMs?: number }): SpaceshipClient;
```
Transport: headers `X-API-Key`, `X-API-Secret`, `Content-Type: application/json`, `redirect: 'manual'`, timeout 15 s.
Classification: 400/401/403/422 and other non-429 4xx → `rejected` (404 → `not_found`); 429 → `rate_limited`
(`Retry-After`); 5xx / network / timeout → `transient` for reads, **`unknown` for `registerDomain`**; a 202 without the
`spaceship-async-operationid` header on `registerDomain` → `unknown`. Registration body: `{ autoRenew, years,
privacyProtection: { level, userConsent: true }, contacts: { registrant, admin: registrant, tech: registrant,
billing: registrant } }` (S§ registration). No retries inside the client.

### 5.5 `W/src/services/domain-purchase.ts` (SLICE_DOMAIN)
```ts
export interface DomainPurchaseDeps { spaceship: SpaceshipClient; cf: CloudflareCredentials | null; now: () => number }
export async function domainPurchaseStatus(env): Promise<DomainPurchaseStatus>;
export async function quoteDomainPurchase(env, actor, req: DomainQuoteRequest, ip?, deps?: Partial<DomainPurchaseDeps>): Promise<DomainPurchaseBatchView>;
export async function listDomainBatches(env, q: ListDomainBatchesQuery): Promise<CursorPage<DomainPurchaseBatchView>>;
export async function getDomainBatch(env, id): Promise<DomainPurchaseBatchView>;                       // with items
export async function confirmDomainBatch(env, actor, id, req: DomainConfirmRequest, ip?, ctx?: ExecCtx | null, deps?): Promise<DomainPurchaseBatchView>;
export async function cancelDomainBatch(env, actor, id, ip?): Promise<DomainPurchaseBatchView>;
export async function retryDomainItem(env, actor, itemId, ip?): Promise<DomainPurchaseItemView>;
export async function resolveDomainItem(env, actor, itemId, req: DomainItemResolveRequest, ip?, deps?): Promise<DomainPurchaseItemView>;
export async function refreshDomainItem(env, actor, itemId, deps?): Promise<DomainPurchaseItemView>;  // one advance step now, min 60 s since last check
export async function saveRegistrantContact(env, actor, req: RegistrantContactRequest, ip?, deps?): Promise<{ contactId: string }>; // also stores settings.spaceship.registrantContactId
export async function testSpaceshipCredentials(env, actor, deps?): Promise<SpaceshipCredentialTest>;   // listDomains({take:1}) – read-only
/** The idempotent per-item step function. Advances at most ONE transition per call. */
export async function advanceDomainItem(env, itemId: number, deps: DomainPurchaseDeps, budget: DomainCronBudget): Promise<'advanced' | 'waiting' | 'skipped' | 'failed'>;
export interface DomainCronBudget { registers: number; polls: number; zoneCreates: number; deadline: number }
/** Cron entry: recover leases, expire quotes, advance due items (≤ 30 items, deadline 60 s). Returns items advanced. No-op unless enabled + configured. */
export async function runDomainPurchaseCron(env, opts?: { now?: number; deps?: Partial<DomainPurchaseDeps>; deadlineMs?: number }): Promise<number>;
/** Ingress-worker-targeted CF credentials, or null (D10). */
export function domainPurchaseCloudflare(env, settings: Settings['spaceship']): { creds: CloudflareCredentials; source: 'setting' | 'env' } | null;
```

**Quote**: parse/split, `new URL('http://' + d).hostname` → A-label, lowercase, dedupe (dupes → `skipped:duplicate`),
invalid → `skipped:invalid`, `> maxBatchDomains` → 400. Local exclusions (one query each, `json_each`):
already in `settings.domains.list` → `already_listed`; in `hosted_domains` → `hosted`; any `mailboxes`/`messages` row
for the domain → `has_history` (CLAUDE.md rule against inheriting history); non-terminal item in another batch →
`in_flight`. Remaining names: availability + pricing in chunks of 20 (rate: ≤ 25 pricing calls / 5 s, sleep on 429
`Retry-After` ≤ 5 s, else 503). `taken`/others → `skipped:<result>`; `premium` && !allowPremium → `skipped:premium`;
`capBasisCents = max(final, regular)` (both already for `years`) `> maxDomainCents` → `skipped:over_domain_cap`.
Insert the batch first (`INSERT … RETURNING id`), then all items with that id in one `db.batch` (never look the id
up with `MAX(id)`). Audit `domain_purchase.quote` (count, total).

**Confirm**:
1. Preconditions: enabled, key/secret/contact set, `domainPurchaseCloudflare` non-null, caps > 0 → else `not_configured`.
2. Claim: `UPDATE domain_purchase_batches SET status='confirming', lease_until=?now+120s WHERE id=? AND status='quoted' AND quote_expires_at > ?now RETURNING id`; no row → 409 (expired → also set `expired`).
3. Validate selection ⊆ items with `status='quoted'`; `Σ capBasisCents === expectedTotalCents` else release claim (`status='quoted'`) + 409.
4. Re-check selected names (availability + pricing). Any unavailable or `capBasis` increased → write new prices,
   availability and `skip_reason`, new `quote_expires_at`, `status='quoted'`, total recomputed → 409 `conflict`
   "报价已变化，请核对后重新确认" (the client re-fetches the batch).
5. Commit in one `db.batch` (atomic on both engines; PG runs batches under the global advisory lock):
   ```sql
   UPDATE domain_purchase_batches SET status='processing', confirmed_by=?, confirmed_at=?now, confirmed_total_cents=?total, lease_until=NULL, updated_at=?now
   WHERE id=?id AND status='confirming' AND ?total <= ?maxBatch
     AND ?total + (SELECT COALESCE(SUM(i.cap_basis_cents),0) FROM domain_purchase_items i JOIN domain_purchase_batches b ON b.id=i.batch_id
                   WHERE b.confirmed_at >= ?dayAgo AND (i.status IN (<DOMAIN_ITEM_CHARGED_FOR_CAP>) OR (i.status='failed' AND i.failed_step NOT IN ('register','poll')))) <= ?maxDaily
     AND (SELECT COUNT(*) FROM domain_purchase_items WHERE status IN (<DOMAIN_ITEM_IN_FLIGHT>)) + ?selectedCount + ?listedCount <= ?MAX_SYSTEM_DOMAINS;
   UPDATE domain_purchase_items SET status='confirmed', next_check_at=?now, updated_at=?now
   WHERE batch_id=?id AND status='quoted' AND domain IN (SELECT value FROM json_each(?selected))
     AND (SELECT status FROM domain_purchase_batches WHERE id=?id)='processing'
     AND NOT EXISTS (SELECT 1 FROM domain_purchase_items o WHERE o.domain = domain_purchase_items.domain AND o.id <> domain_purchase_items.id AND o.status IN (<DOMAIN_ITEM_IN_FLIGHT>, 'domain_added'));
   UPDATE domain_purchase_items SET status='skipped', skip_reason='not_selected', updated_at=?now
   WHERE batch_id=?id AND status='quoted' AND (SELECT status FROM domain_purchase_batches WHERE id=?id)='processing';
   ```
   First statement changed 0 rows → set batch back to `quoted` and report the failing cap (409/`validation_failed`).
   Audit `domain_purchase.confirm` (batch id, count, total). Then `ctx.waitUntil(runDomainPurchaseCron(env, …))`
   to start promptly; durability is the cron's job.

**`advanceDomainItem` (per status, one transition, row-claimed first)**. Generic claim for non-money steps:
`UPDATE domain_purchase_items SET lease_until=?now+120s WHERE id=? AND status=?expected AND COALESCE(lease_until,0) < ?now RETURNING id`.
Results are written with `WHERE id=? AND status=?expected` and clear `lease_until`. Transient errors (CF
`isTransientCloudflareError`, Spaceship `transient`/`rate_limited`) keep the status, set `next_check_at` (+5 min, or
`Retry-After`), increment `step_attempts`, store `last_error`.

| Status | Action | Next |
|---|---|---|
| `confirmed` | budget.registers > 0; batch confirmed > 24 h ago → `failed(register)` (void, not charged); purchasing disabled / caps 0 / no CF creds / no contact → wait (hold, `last_error`); premium no longer allowed or `cap_basis` > current `maxDomainCents` → `failed(register)`; confirmed > `quoteTtlMinutes` ago → re-check availability + price for this domain, unavailable or price above `cap_basis` → `failed(register)`; then **money CAS**: `UPDATE … SET status='registering', register_attempted_at=?now, lease_until=?now+300s WHERE id=? AND status='confirmed' AND operation_id IS NULL RETURNING id`; audit `domain_purchase.register` **before** the POST; `registerDomain` | 202+op → keep `registering`, store `operation_id`, `op_status='pending'`, `next_check_at=now+60s`. `rejected` → `failed(register)`. `rate_limited` → back to `confirmed` (safe: request rejected before processing). `unknown`/throw → `unknown`, audit `domain_purchase.register_unknown`. |
| `registering`, op id set | budget.polls > 0; `getAsyncOperation` | `success` → `registered` (`registered_at`); `failed` → `failed(poll)` with `details` JSON (≤ 1000 chars), treated as a definite "not registered" (`maybeCharged=false`); `pending` > 24 h → `last_error` "注册超过 24 小时未完成" (stays). |
| `registering`, no op id, lease expired | — | `unknown` (crash between CAS and response). |
| `unknown` | every 30 min: `getDomain` (≤ 1 per 5 min per domain) | 200 → `registered` (audit `domain_purchase.reconciled`). 404/other → stay. |
| `registered` | budget.zoneCreates > 0; CF `countZones` guard (>50 and pending ≥ active → wait); `findZone(name)`: exists and `created_on < zone_create_attempted_at − 60 s` → `failed(zone)` "Cloudflare 已存在该 zone，拒绝接管"; exists and newer → adopt; else set `zone_create_attempted_at` then `createZone` | `zone_created` with `cf_zone_id`, `name_servers`. |
| `zone_created` | `getDomain` must show `lifecycleStatus='registered'` (else wait); `setNameservers(domain, name_servers)` | `ns_set` (`ns_set_at=now`). 422/400 → `failed(nameservers)`. |
| `ns_set` | `getZone`; if pending and ≥ 1 h since last check → `requestActivationCheck` (ignore errors) | `active` → `zone_active`. Pending > 7 days since `ns_set_at` → `failed(nameservers)`; admin retry → `zone_created` (clears `ns_set_at`, NS set again, timer restarts). |
| `zone_active` | `getRouting` → `enableRouting` if not enabled; `getCatchAll` → `putCatchAll` (creds.workerName = ingress) unless `catchAllTargetsWorker` | both ok → `routing_ready`. CF 2009 → wait. definite → `failed(routing|catch_all)`. |
| `routing_ready` | `appendSystemDomain(env, domain)`: `getSettingsFresh`; already listed → done; hosted conflict → `failed(domain_add)`; full (`MAX_SYSTEM_DOMAINS`) → `failed(domain_add)`; `updateSettings({domains:{list:[…, {domain, public:false, perUserLimit:0}]}, expectedDomainsRevision})`, retry ≤ 3 on `conflict` | `domain_added`, `ready_at`; audit `domain_purchase.ready` (system actor). Also refresh `verificationStatus`/`suspensions` via `getDomain` (best effort). |

The rolling 24 h ledger counts an item when its batch was confirmed **or** its registration was attempted inside the
window. After confirm (all selected items may have become `skipped:in_flight`) and after any item change: if no item of the batch is non-terminal (`unknown` counts as non-terminal) → batch
`completed`, `completed_at`.

**Cron budget per tick** (5-min ticks; Spaceship limits S§3): registers ≤ 20 (≤ 30/30 s), polls ≤ 40 (60 per 300 s
account-wide; also counted in `rate_counters` scope `spaceship.poll`, window `minuteWindow(5)`, so admin
refresh + multiple pods share it), `getDomain`/`setNameservers` ≤ 1 per item per tick and `refreshDomainItem`
rejects if `updated_at > now − 60 s` (5/300 s per domain), CF zone creates ≤ 5. Due query (copy of
`syncDueHostedDomains`):
`SELECT id FROM domain_purchase_items WHERE status IN (…non-terminal…) AND COALESCE(next_check_at,0) <= ? AND COALESCE(lease_until,0) < ? ORDER BY COALESCE(next_check_at,0), id LIMIT 30`, per-row try/catch.

**Admin retry** (`retryDomainItem`): only `failed` with `failed_step` ∈ {zone, nameservers, routing, catch_all,
domain_add} → reset to the status preceding that step (`registered`, `zone_created`, `zone_active`, `zone_active`,
`routing_ready`), `step_attempts=0`, `next_check_at=now`. `failed_step` ∈ {register, poll} → 409 "需重新报价采购".
**Resolve unknown**: `mark_registered` requires `getDomain` → 200 (else 409); `mark_not_registered` requires a
live `checkAvailability` = `available` (else 409) → `failed(register)`. Both audited
(`domain_purchase.item_resolve`).

### 5.6 Reuse of `cloudflare.ts`
No edits to `cloudflare.ts`. `domainPurchaseCloudflare` = `cloudflareCredentials(env)` (token + account) with
`workerName` replaced by the ingress worker per D10. Email Sending helpers are **not** used (k3s sends via SMTP relay).

---

## 6. Money-safety rules (normative, tested)

1. Admin-only (JWT `requireAdmin`); nothing purchase-related exists on `/v1`.
2. Feature switch + credentials + caps > 0 are all required; otherwise `not_configured` (503) before any vendor call.
3. Quote expiry: `quoteTtlMinutes` (default 15). Confirm after expiry → 409, batch/order `expired`.
4. Confirm requires the client to echo the total it showed (`expectedCents` / `expectedTotalCents`).
5. Re-check at confirm (availability + price + 1024 balance). Any upward change → no purchase, re-quoted, 409.
6. Caps: per item/order, per batch, rolling-24 h ledger from our own tables (`cap_basis_cents`, or `actual_cents`
   when known), all inside the guarded SQL statement → concurrent confirms cannot both pass.
7. Single flight: every money-moving call is preceded by a CAS on the row status; at most one POST per item/order ever.
8. Lost outcome → `unknown`; **never retried automatically**; only read-only reconciliation or an explicit admin
   resolve (which itself requires live evidence) moves it.
9. UI and API always flag `maybeCharged` for `registering`/`unknown`/`awaiting_payment`.
10. 1024 wallet top-up (`/1024Recharge`) and payment are never automated (D6).
11. Tests: a `fetch` stub that throws on unhandled URLs; assertions that `registerDomain`/`createOrder` are called
    exactly once per item across: two concurrent confirms, two cron runs, a crash between CAS and response, a 5xx
    response, admin retry on a `register`-failed item.

---

## 7. Routes

All admin routers: `const app = new Hono<AppContext>(); app.use('*', requireAuth, requireAdmin);`, handlers return
`ok(c, …)`, bodies via `parseBody(c, schema)`, queries via `parseQuery`. Rate limits use `bumpCounter`
(`rate-counter.ts`) with `minuteWindow(1)` per admin id; exceeding → `rate_limited`.

### 7.1 `W/src/routes/admin/proxies.ts` → mount `/api/admin/proxies` (SLICE_PROXY)
| Method | Path | Request | Response `data` | Notes |
|---|---|---|---|---|
| GET | `/` | `listProxiesQuerySchema` | `CursorPage<ProxyView>` | |
| GET | `/stats` | — | `ProxyPoolStats` | |
| POST | `/` | `proxyInputSchema` | `ProxyView` | audit `proxy.create` |
| POST | `/import` | `importProxiesRequestSchema` | `ProxyImportResult` | audit `proxy.import` (counts) |
| GET | `/export` | `exportProxiesQuerySchema` | `ProxyExport` | 6/min; audit `proxy.export` |
| POST | `/auto-assign` | `autoAssignRequestSchema` | `AutoAssignResult` | 10/min; audit `proxy.auto_assign` (unless dryRun) |
| GET | `/bindings` | `listBindingsQuerySchema` | `CursorPage<ProxyBindingView>` | |
| POST | `/bindings/lookup` | `lookupBindingsRequestSchema` | `{ items: ProxyBindingLookupItem[] }` | batch for address lists |
| PUT | `/bindings/:address` | `bindProxyRequestSchema` | `ProxyBindingView` | `:address` URL-encoded; audit `proxy.bind` |
| DELETE | `/bindings/:address` | — | `{ ok: true }` | audit `proxy.unbind` |
| GET | `/:id` | — | `ProxyView` | |
| PUT | `/:id` | `updateProxyRequestSchema` | `ProxyView` | audit `proxy.update` (changed field names only) |
| DELETE | `/:id?force=1` | — | `{ ok: true }` | audit `proxy.delete` |
| POST | `/:id/reveal` | — | `ProxyCredential` | 30/min; audit `proxy.reveal` |
| POST | `/:id/health` | `proxyHealthReportSchema` | `ProxyView` | not audited |
Static paths (`/stats`, `/import`, `/export`, `/auto-assign`, `/bindings…`) are registered **before** `/:id`.

### 7.2 `W/src/routes/admin/proxy-1024.ts` → mount `/api/admin/proxy-1024` (SLICE_PROXY)
| Method | Path | Request | Response `data` |
|---|---|---|---|
| GET | `/status?live=1` | — | `Proxy1024Status` (live: 6/min) |
| POST | `/login/captcha` | — | `Proxy1024Captcha` (6/min) |
| POST | `/login` | `proxy1024LoginRequestSchema` | `Proxy1024Status` (6/min) |
| GET | `/catalogue` | — | `Proxy1024Catalogue` |
| GET | `/sub-users` | — | `{ items: Proxy1024SubUser[] }` |
| POST | `/quotes` | `proxy1024QuoteRequestSchema` | `ProxyOrderView` (10/min) |
| GET | `/orders` | `{cursor, limit, status?}` | `CursorPage<ProxyOrderView>` |
| GET | `/orders/:id` | — | `ProxyOrderView` |
| POST | `/orders/:id/confirm` | `proxy1024ConfirmRequestSchema` | `ProxyOrderView` (5/min) |
| POST | `/orders/:id/cancel` | — | `ProxyOrderView` |
| POST | `/orders/:id/refresh` | — | `ProxyOrderView` (10/min) |
| POST | `/orders/:id/resolve` | `proxy1024ResolveRequestSchema` | `ProxyOrderView` |
| POST | `/orders/:id/allocate` | — | `Proxy1024SyncResult` (UNVERIFIED path, 3/min) |
| POST | `/sync` | `proxy1024SyncRequestSchema` | `Proxy1024SyncResult` (3/min) |
| POST | `/generate-sticky` | `proxy1024GenerateStickyRequestSchema` | `{ created: number }` |

### 7.3 `W/src/routes/admin/domain-purchases.ts` → mount `/api/admin/domain-purchases` (SLICE_DOMAIN)
| Method | Path | Request | Response `data` |
|---|---|---|---|
| GET | `/status` | — | `DomainPurchaseStatus` |
| POST | `/test-credentials` | — | `SpaceshipCredentialTest` (6/min) |
| POST | `/contact` | `registrantContactRequestSchema` | `{ contactId: string }` (3/min) |
| POST | `/quotes` | `domainQuoteRequestSchema` | `DomainPurchaseBatchView` (with items; 10/min) |
| GET | `/` | `listDomainBatchesQuerySchema` | `CursorPage<DomainPurchaseBatchView>` (no items) |
| GET | `/:id` | — | `DomainPurchaseBatchView` (with items) |
| POST | `/:id/confirm` | `domainConfirmRequestSchema` | `DomainPurchaseBatchView` (5/min) |
| POST | `/:id/cancel` | — | `DomainPurchaseBatchView` |
| POST | `/items/:itemId/retry` | — | `DomainPurchaseItemView` |
| POST | `/items/:itemId/resolve` | `domainItemResolveRequestSchema` | `DomainPurchaseItemView` |
| POST | `/items/:itemId/refresh` | — | `DomainPurchaseItemView` (10/min) |
(`/status`, `/test-credentials`, `/contact`, `/quotes`, `/items/…` registered before `/:id`.)

### 7.4 `W/src/routes/proxies.ts` → mount `/api/proxies` (SLICE_PROXY, user JWT)
| GET | `/mine` | — | `{ items: MyProxyBinding[] }` | `requireAuth`; owned addresses only (D4); ≤ 500 rows |

### 7.5 `W/src/routes/v1/proxies.ts` → mount `/v1/proxies` (SLICE_PROXY, API key)
`app.use('*', apiKeyAuth)`; every handler `requireScope(c, 'proxy.read')`.
| GET | `/lookup?address=` | `v1ProxyLookupQuerySchema` | `V1ProxyLookup` | non-admin + not owner → 404 `not_found` (do not leak existence) |
| GET | `/?cursor&limit&all=1&domain=` | `v1ProxyListQuerySchema` | `CursorPage<MyProxyBinding>` | `all=1` admin key only (else 403) |

### 7.6 Settings
No new settings route. `GET/PUT /api/admin/settings` carry `proxy1024` and `spaceship` (masked) via FOUNDATION's
`setting.ts` changes. Credential tests are the feature routes above.

---

## 8. Scheduled hooks (INTEGRATOR, `W/src/services/scheduled.ts`)
After `hosted_domains.sync` (`scheduled.ts:166`), every 5 minutes:
```ts
await step(report, 'proxy.expire', () => expireProxies(env));
await step(report, 'proxy_1024.reconcile', () => runProxy1024Cron(env));
await step(report, 'domain_purchase.advance', () => runDomainPurchaseCron(env));
```
Each returns quickly (one settings read) when the feature is disabled/unconfigured. Maintenance (daily): nothing new
(quotes are expired by the 5-minute steps; rows are kept as the purchase ledger, not pruned).

---

## 9. Audit actions (`logAdminAction`; never secrets in target/detail)
| Action | Target | Detail |
|---|---|---|
| `proxy.create` / `proxy.update` / `proxy.delete` | `proxy:<id>` | host:port, changed field names |
| `proxy.import` | `proxies` | created/duplicates/invalid counts |
| `proxy.reveal` | `proxy:<id>` | — |
| `proxy.bind` / `proxy.unbind` | address | `proxy:<id>` |
| `proxy.auto_assign` | domain or `addresses` | assigned count |
| `proxy.export` | `proxies` | format, scope, count |
| `proxy_1024.login` | `proxy1024` | account email |
| `proxy_1024.quote` / `.order_confirm` / `.order_created` / `.order_unknown` / `.order_failed` | `proxy_order:<id>` | product, sku, qty, cents, order_no |
| `proxy_1024.order_paid` / `.order_overcharge` (system) | `proxy_order:<id>` | actual cents |
| `proxy_1024.order_resolve` / `.order_cancel` | `proxy_order:<id>` | action |
| `proxy_1024.sync` / `.allocate` / `.generate` | `proxy1024` | counts |
| `proxy_1024.session_invalid` (system, only on transition ok→invalid) | `proxy1024` | — |
| `domain_purchase.quote` / `.confirm` / `.cancel` | `domain_batch:<id>` | count, total cents |
| `domain_purchase.register` (system, **before** POST) / `.register_unknown` / `.register_failed` | domain | batch id, op id, error code |
| `domain_purchase.reconciled` / `.ready` (system) | domain | — |
| `domain_purchase.item_retry` / `.item_resolve` | domain | step / action |
| `domain_purchase.contact_save` | `spaceship` | contact id |

---

## 10. Web (SLICE_WEB)

Admin pages are lazy (`page(preloadable(() => import(...)))` in `router.tsx`, no `React.lazy`); they may import
shared runtime values. Queries poll only while something is in flight.

| Route | Nav entry (`ADMIN_NAV`, after 托管域名) | Page file |
|---|---|---|
| `/admin/proxies` | `代理池` (lucide `Waypoints`) | `Web/src/features/admin/proxies/proxies-page.tsx` |
| `/admin/proxy-1024` | `1024 购买` (`ShoppingCart`) | `Web/src/features/admin/proxy-1024/proxy-1024-page.tsx` |
| `/admin/domain-purchases` | `域名采购` (`Globe2`) | `Web/src/features/admin/domain-purchases/domain-purchases-page.tsx` |
| `/admin/domain-purchases/:id` | — | `Web/src/features/admin/domain-purchases/domain-batch-page.tsx` |

Components (all under the feature folders):
- **代理池**: `proxies-api.ts` (`adminProxyApi`), tabs 库存 / 绑定; `proxy-stats-card.tsx`, `proxy-table.tsx`
  (filters status/provider/country/bound, cursor "加载更多"), `proxy-form-dialog.tsx` (create/edit; password field
  shows `SECRET_MASK` placeholder on edit), `proxy-import-dialog.tsx` (textarea + format + defaults, dry-run preview
  then import), `proxy-reveal-button.tsx` (POST reveal, copy URL, never cached in query cache), `bind-proxy-dialog.tsx`
  (address + proxy picker from free proxies), `auto-assign-dialog.tsx` (target/domain/limit/filters, dry-run table
  then apply), `export-dialog.tsx` (format/scope → download as `.txt`/`.json` from `content`),
  `bindings-table.tsx` (unbind with confirm-dialog).
- **1024 购买**: `proxy-1024-api.ts`; `proxy-1024-settings-card.tsx` (enabled, email, password, session token, lang,
  caps in dollars → cents, TTL; PUT `/api/admin/settings` with `{ proxy1024 }`); `proxy-1024-status-card.tsx` (session
  state, email, balance, 24 h spent / cap, "刷新" = `?live=1`); `slide-captcha-dialog.tsx` (renders master + tile
  images, horizontal slider sets `x`, `y = initialY`, submits `/login`); `proxy-1024-quote-form.tsx` (product select;
  catalogue-driven SKU select; static: rows of country/days/count); `proxy-order-confirm-dialog.tsx` (shows
  estimate, cap basis, balance at quote, expiry countdown; "确认下单" sends `expectedCents`; copy says payment is
  completed manually on the 1024 checkout page); `proxy-orders-table.tsx` (status badges; `unknown`/
  `awaiting_payment` show red "可能已产生订单/待支付" with checkout link opened `rel=noreferrer`; actions refresh /
  resolve / allocate / cancel); `sticky-generate-dialog.tsx`; `sync-inventory-button.tsx`.
- **域名采购**: `domain-purchases-api.ts`; `domain-purchase-settings-card.tsx` (enabled, key, secret, contact id,
  years, autoRenew, privacy, allowPremium, caps, batch size, TTL, ingress worker name; "测试凭据" button);
  `registrant-contact-dialog.tsx`; `domain-purchase-status-card.tsx` (shows `reasons[]` when purchasing not allowed,
  CF configured, ingress worker + source, system-domain slots used/in-flight/max);
  `domain-quote-form.tsx` (textarea paste → POST quotes → navigate to batch page); `domain-batches-table.tsx`.
  Batch page: `domain-quote-table.tsx` (checkbox per available item, price class, final/regular, cap basis,
  skip reason; running total; expiry countdown; confirm-dialog repeating total and count, sends
  `expectedTotalCents`; on 409 refetch and show "报价已变化"); `domain-progress-table.tsx` (per-item step stepper
  quoted→…→domain_added, `maybeCharged` warning, lastError/errorCode/vendorOperationId, verification/suspension
  badges, actions retry/resolve/refresh); polls `GET /:id` every 10 s while batch `confirming`/`processing`.
- **Mailbox views**:
  - `Web/src/features/admin/addresses/addresses-page.tsx`: "代理" column filled by one
    `POST /api/admin/proxies/bindings/lookup` per loaded page of addresses (never per row); row action
    "绑定代理" opens `bind-proxy-dialog` (imported from proxies feature). New file
    `Web/src/features/admin/addresses/use-address-proxies.ts`.
  - `Web/src/features/mailboxes/mailboxes-page.tsx`: small "代理" badge/popover per owned address from
    `GET /api/proxies/mine` (staleTime 5 min; not in `boot-prefetch`), copy URL button. New file
    `Web/src/features/mailboxes/use-my-proxies.ts`.
- **API keys**: `create-api-key-dialog.tsx` labels `proxy.read` as "读取邮箱代理"; presets unchanged except `full`
  (already `API_SCOPES`). Update `matchScopePreset` tests if they enumerate scopes.
- Query keys (`Web/src/api/query-keys.ts`, `admin` group): `proxies(filters)`, `proxyStats`, `proxyBindings(filters)`,
  `proxyLookup(addresses)`, `proxy1024Status`, `proxy1024Catalogue`, `proxyOrders(filters)`, `proxyOrder(id)`,
  `domainPurchaseStatus`, `domainBatches(filters)`, `domainBatch(id)`; top-level `myProxies`.
- Web tests (vitest + RTL, mocked API): one `*.test.tsx` per page (render, empty states, confirm flows send the
  echoed total, 409 handling, reveal not cached, secret field shows mask), plus `slide-captcha-dialog.test.tsx`,
  `addresses-page` proxy column test (one lookup request per page), `mailboxes-page` badge test.

---

## 11. File ownership (strict; nobody edits another stream's files)

### FOUNDATION (lands first; slices start from its contracts — they can code against this document meanwhile)
- `W/src/db/schema.ts` (append tables §2)
- `W/migrations/0021_proxy_pool_domain_purchase.sql`, `W/migrations/meta/0021_snapshot.json`, `W/migrations/meta/_journal.json`
- `S/src/money.ts`, `S/src/schemas/proxy.ts`, `S/src/schemas/proxy-1024.ts`, `S/src/schemas/domain-purchase.ts`
- edits: `S/src/index.ts`, `S/src/constants.ts` (`proxy.read`, `MAX_SYSTEM_DOMAINS`), `S/src/envelope.ts`
  (`not_configured`, `upstream_failed`), `S/src/schemas/admin-settings.ts` (keys, defaults, `SECRET_SETTING_PATHS`)
- `S/test/proxy-contracts.test.ts`
- `W/src/lib/secret-box.ts`, `W/test/secret-box.test.ts`
- edits: `W/src/types.ts` (`secret_box_key`), `W/src/services/setting.ts` (seal/mask/`readVendorSecrets`/
  `writeVendorSecret`), `W/src/services/audit.ts` (`SECRET_SETTING_FIELDS`)
- `W/test/settings-secrets.test.ts`, `W/test/proxy-domain-migration.test.ts` (migration on both engines)
- `S/src/secret-field.ts`; `W/scripts/drop-legacy.sql` (the six new tables; `check-drop-legacy.mjs` runs before
  `pnpm test` and fails otherwise)
- Must leave `pnpm typecheck` + existing tests green on both engines (e.g. the OpenAPI enum of error codes/scopes
  updates automatically from shared; if `openapi-contract.test.ts` or `Web` typecheck break because of the new
  error codes/scope, FOUNDATION fixes the minimal spot).

### SLICE_PROXY
- `W/src/services/proxy-inventory.ts`, `W/src/services/proxy1024-client.ts`, `W/src/services/proxy-purchase.ts`
- `W/src/routes/admin/proxies.ts`, `W/src/routes/admin/proxy-1024.ts`, `W/src/routes/proxies.ts`, `W/src/routes/v1/proxies.ts`
- `W/test/proxy-inventory.test.ts`, `W/test/proxy-bindings.test.ts`, `W/test/proxy1024-client.test.ts`,
  `W/test/proxy-purchase.test.ts`, `W/test/proxy-v1.test.ts`, fixtures `W/test/fixtures/proxy1024/*` (hand-written
  from P§ shapes; pricing-page HTML snippets may be derived from the recon scratch `/tmp/p1024` if present)
- Route tests mount the router on a local `Hono<AppContext>` with `requestId` + `onError` (do not touch `app.ts`).

### SLICE_DOMAIN
- `W/src/services/spaceship-client.ts`, `W/src/services/domain-purchase.ts`
- `W/src/routes/admin/domain-purchases.ts`
- `W/test/spaceship-client.test.ts`, `W/test/domain-purchase.test.ts`, `W/test/domain-purchase-cron.test.ts`,
  fixtures `W/test/fixtures/spaceship/*`. CF mocked like `hosted-domains.test.ts:42-112` with
  `{ ...env, cf_api_token: 'test-token', cf_account_id, worker_name: 'hpc-mail-ingress-test' }`.

### SLICE_WEB
- Everything under `Web/src/` listed in §10, plus `Web/src/app/router.tsx`, `Web/src/app/app-shell.tsx`
  (`ADMIN_NAV`), `Web/src/api/query-keys.ts`, `Web/src/features/api-keys/create-api-key-dialog.tsx`, and their tests.
  Codes against §3 contracts and §7 routes with mocked API; no worker files.

### INTEGRATOR (after the slices)
- `W/src/app.ts`: `api.route('/proxies', proxies)`, `api.route('/admin/proxies', adminProxies)`,
  `api.route('/admin/proxy-1024', adminProxy1024)`, `api.route('/admin/domain-purchases', adminDomainPurchases)`.
- `W/src/routes/v1/index.ts`: `app.route('/proxies', v1Proxies)` (CORS unchanged).
- `W/src/services/scheduled.ts`: the three steps in §8.
- `W/src/routes/api-openapi.ts` (all `/api/admin/proxies*`, `/api/admin/proxy-1024*`, `/api/admin/domain-purchases*`,
  `/api/proxies/mine`), `W/src/routes/v1/openapi.ts` (`/v1/proxies`, `/v1/proxies/lookup`), `openapi-common.ts`
  fragments; make `openapi-contract.test.ts` pass.
- `W/server/main.ts` env literal: `cf_api_token: process.env.CF_API_TOKEN, cf_account_id: process.env.CF_ACCOUNT_ID,
  worker_name: process.env.CF_EMAIL_WORKER_NAME, secret_box_key: process.env.SECRET_BOX_KEY` (all optional).
  Document in `deploy/README.md` (no deploy, no Secret changes): `CF_EMAIL_WORKER_NAME=hpc-mail-ingress-20261028`,
  and that setting `CF_API_TOKEN` also makes user-hosted domains possible (still gated by `hosted_domains.enabled`).
- Worker mode: `secret_box_key` optional secret (document in README; CI unchanged unless the user asks).
- Agent docs: `Web/public/skill.md` capability map + `Web/public/references/mailboxes-and-domains.md` (`proxy.read`,
  `/v1/proxies/lookup`, `/v1/proxies`); README feature section.
- Full verification: `pnpm typecheck`, `pnpm --filter @hpc-mail/worker typecheck:node`, `pnpm test`, Postgres suite.

---

## 12. Test matrix (minimum)
| Area | Must cover |
|---|---|
| Foundation | migration applies on both engines; secret box; settings mask/keep/clear/seal; audit never contains secrets |
| Inventory | CRUD; endpoint uniqueness 409; import formats + dupes + invalid lines; export formats; delete bound (409 / force) |
| Bindings | bind/rebind/unbind; capacity guard (`max_bindings`), disabled/expired proxy refused; auto-assign claimed & explicit (incl. unclaimed address), dry run, concurrent manual bind wins; lookup batch |
| /v1 + /api/proxies/mine | scope `proxy.read` required; owner sees, other user 404, shared-to user 404, admin key any; `all=1` non-admin 403 |
| 1024 client | form encoding, token in body, `Accept-Protocol` header, code 300 → session_invalid, code 30 → captcha_image_required, order* 5xx/timeout → unknown; allow-list excludes all forbidden paths; catalogue HTML parsing |
| 1024 purchase | quote caps; confirm echo mismatch; price change → 409 re-quote; balance insufficient; daily cap across two orders; concurrent confirm → one `createOrder`; unknown never retried by cron; reconcile paid/refunded; materialise unlimited servers idempotently; sticky generation username grammar |
| Spaceship client | headers, ≤ 20 chunking, name matching, error classification, 202 without op header → unknown, 429 Retry-After |
| Domain purchase | quote exclusions (listed/hosted/history/in-flight/premium/over cap); confirm caps (domain/batch/daily/system-domain slots); re-check change → 409; concurrent confirm; `registerDomain` exactly once under: double cron, crash after CAS, 5xx; op success/failed/pending; unknown reconcile via getDomain; refuse pre-existing CF zone, adopt our own after timeout; NS set only after `registered`; routing + catch-all target = ingress worker name; domains list append with revision conflict retry and idempotence; retry rules; resolve rules; budget limits respected |
| Web | per §10 |

---

## 13. Out of scope (explicit)
Automated 1024 payment and captcha solving; 1024 wallet top-up; proxy health probing from the server; extraction-link
(white/apisocks/server:500) integration; 1024 `premium_flow`/`residential_ip`; renewals (domains and proxies);
Spaceship transfers/deletion; Email Sending setup for purchased domains; raising `MAX_SYSTEM_DOMAINS`; encrypting
the legacy `ai_model.apiKey`; automatic proxy assignment on mailbox claim.

---

## 14. FOUNDATION implementation notes (landed 2026-11-25)

Binding additions/corrections made while implementing FOUNDATION (slices code against these):

- **Shared extras** (all exported from `@hpc-mail/shared`):
  - `envelope.ts`: `type CursorPage<T> = Page<T>` (the routes above say `CursorPage`; it did not exist).
  - `proxy.ts`: `PROXY_IMPORT_FORMATS` / `ProxyImportFormat` (the `ImportFormat` of §3.4), `MAX_PROXY_IMPORT_LINES`
    (2000), `MAX_PROXY_LOOKUP_ADDRESSES` (500), `MAX_PROXY_EXPORT_ROWS` (10 000), `isProxyHost`, `formatProxyHost`,
    types `ParsedProxyLine` (`protocol?` only set by the url format) and `ProxyEndpointParts` (argument of
    `buildProxyUrl`/`formatProxyLine`), plus `Xxx` inferred types for every schema (`ProxyInput`, `ListProxiesQuery`,
    `ImportProxiesRequest`, `AutoAssignRequest`, `ExportProxiesQuery`, `V1ProxyListQuery`, …).
  - `updateProxyRequestSchema` is an explicit all-optional object **without defaults** (a `.partial()` of
    `proxyInputSchema` would still apply `.default()`s and overwrite unsent fields).
  - `proxyInputSchema.host` strips `[ ]` around IPv6 and validates hostname / IPv4 / IPv6.
  - `parseProxyLine`: `user_pass_at_host_port` also accepts a bare `host:port`; `auto` with an `@` falls back to
    `host:port:user:pass` when `user:pass@host:port` fails (password containing `@`). Passwords may contain `:` in the
    `host_port_user_pass` form (everything after the 3rd colon). Usernames containing `:` cannot round-trip through the
    two colon formats (use url format).
  - `proxy-1024.ts`: `listProxyOrdersQuerySchema` (`cursor`, `limit` 1..200 default 50, `status?`) for
    `GET /orders`; `PROXY1024_SYNC_KINDS`; `Proxy1024SessionState`.
  - `domain-purchase.ts`: `DOMAIN_ITEM_TERMINAL` (`domain_added|failed|skipped|cancelled`), `DOMAIN_SKIP_REASONS`,
    `SPACESHIP_AVAILABILITY_CHUNK` (20), `MAX_DOMAIN_QUOTE_NAMES` (100), `DomainItemAction`.
  - `admin-settings.ts`: `SecretSettingPath`; `DEFAULT_SETTINGS.proxy1024/spaceship` are `schema.parse({})`.
  - `secret-field.ts`: `SEALED_SECRET_PREFIX = 'enc:v1:'`, `secretSettingString(max)` (see §3.7).
- **Secret box** (`W/src/lib/secret-box.ts`): HKDF salt `'hpc-mail/secret-box'`, info `'hpc-mail/secret-box/v1'`;
  AES-GCM AAD = `enc:v1:<kid>` (swapping the kid fails authentication). Decryption picks the key by the kid in the
  ciphertext, so adding `SECRET_BOX_KEY` later keeps old `j1` values readable while new writes use `k1`; a `k1` value
  without `SECRET_BOX_KEY` throws `AppError('internal')` naming the missing key. `secret_box_key` accepts base64 or
  base64url and must decode to 32 bytes. Extra export: `currentKid(env)`.
- **Settings** (`W/src/services/setting.ts`): `SECRET_MASK` keeps the stored ciphertext byte-for-byte (no re-seal).
  `maskSettings` masks every `SECRET_SETTING_PATHS` entry (`SECRET_MASK` / `''`). `readVendorSecrets` returns
  `settings` with the secret fields **still sealed** and the plaintexts as separate fields. `writeVendorSecret` does a
  compare-and-set on the raw JSON text (`UPDATE settings SET value=? WHERE key=? AND value=?`, insert-if-absent),
  retries 5 times, then throws `conflict`; it invalidates the settings cache. Audit: `SECRET_SETTING_FIELDS` is built
  from `SECRET_SETTING_PATHS`, so the detail says only `proxy1024.password 已更新/已清除` (re-submitting the same
  plaintext re-seals and is logged as 已更新).
- **Web minimal fix** (allowed by §11): `SCOPE_LABELS['proxy.read'] = '读取邮箱代理'` in
  `create-api-key-dialog.tsx`; its test now includes `proxy.read` in the `full` preset and asserts that an old
  5-scope key reads as `custom`.
- **Migration**: generated by drizzle-kit (`drizzle-kit check` clean). The Node/k3s runtime picks it up unchanged:
  `server/build.mjs` copies `migrations/` into `server-dist/migrations` and `PostgresDatabase.migrate` applies every
  `*.sql` in order, recorded in `hpc_migrations`. Verified on workerd D1 and PostgreSQL 16 (full worker suite on both).
