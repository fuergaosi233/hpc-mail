# Contract requests (slices → FOUNDATION / INTEGRATOR)

Each slice appends its own section. The INTEGRATOR section at the end records what was applied.

## SLICE_DOMAIN (2026-11-25)

1. **`DOMAIN_SKIP_REASONS` is missing three values that the quote writes.** `domain_purchase_items.skip_reason`
   can also be `tldNotSupported` and `unexpectedError` (the Spaceship availability result, per DESIGN §5.5
   "`taken`/others → `skipped:<result>`"), and `no_price` (the domain is available but pricing returned an
   `errorCode`, a non-USD price, or no `register` price for the requested years). The column and the
   `DomainPurchaseItemView.skipReason` field are plain strings, so nothing breaks. Request: add the three values to
   `DOMAIN_SKIP_REASONS` so the web can label them. Workaround: the web falls back to showing the raw value.
2. **Quote/confirm rate limiting returns 429, not 503.** DESIGN §5.5 says "sleep on 429 `Retry-After` ≤ 5 s, else
   503". The only 503 code is `not_configured`, which would tell the admin the feature is misconfigured. The
   implementation throws `rate_limited` (429, "Spaceship 限流，请稍后再试") instead. Other definite vendor errors map to
   `upstream_failed` (502).
3. **`POST /api/admin/domain-purchases/quotes` answers 201** (it creates a batch, like `POST /api/hosted-domains`).
   INTEGRATOR: describe it as 201 in `api-openapi.ts`.
4. **`DomainPurchaseDeps` has two extra optional fields** (private to `domain-purchase.ts`, for tests and the cron):
   `sleep?(ms)` and `registrantContactId?`. Callers outside the slice never need them.
5. **INTEGRATOR wiring** (unchanged from DESIGN): mount `src/routes/admin/domain-purchases.ts` (default export) at
   `/api/admin/domain-purchases`, add `step(report, 'domain_purchase.advance', () => runDomainPurchaseCron(env))` to
   `scheduled.ts`, and wire `CF_API_TOKEN` / `CF_ACCOUNT_ID` / `CF_EMAIL_WORKER_NAME` in `server/main.ts`. Without
   an explicit `worker_name` or `spaceship.ingressWorkerName`, confirm returns `not_configured` (D10).

## SLICE_PROXY (2026-11-25)

Nothing below needs a change in `packages/shared` before integration; items 1–3 are requests to make implicit
values explicit.

1. **`ProxyOrderView.warnings` values in use**: `payment_manual` (awaiting_payment / unknown), `maybe_charged`
   (ordering / awaiting_payment / unknown, DESIGN §6 rule 9), `actual_exceeds_estimate`, `checkout_url_unreadable`
   (sealed URL could not be opened after a key change). Request: a shared `PROXY_ORDER_WARNINGS` constant so the web
   can label them. Workaround: the field stays `string[]`.
2. **Export content shape** (`GET /api/admin/proxies/export`, `ProxyExport.content`):
   - `scope=bindings`, text formats: one line per binding, `address<TAB>proxy-line`.
   - `scope=bindings`, `json`: `[{ address, ...ProxyCredential }]`.
   - `scope=proxies`, text formats: one proxy line per row; `json`: `[{ id, label, provider, ...ProxyCredential }]`.
   - More than `MAX_PROXY_EXPORT_ROWS` rows → 400 `validation_failed` (filter by domain/status), never a truncated file.
   INTEGRATOR: describe this in OpenAPI and the agent docs.
3. **`Proxy1024Status.configured`** means "a session token is stored". Email + password alone do not count, because
   they only enable the human captcha login.
4. **Response codes**: `POST /api/admin/proxies`, `POST /api/admin/proxy-1024/quotes` and
   `POST /api/admin/proxy-1024/generate-sticky` answer **201**. Every other route answers 200. Errors:
   `not_configured` 503 (disabled, no token, a cap of 0), `upstream_failed` 502 (definite vendor error, session
   invalid, pricing page unreadable), `conflict` 409 (echo mismatch, expired quote, price rose, balance too low, already
   confirmed), `validation_failed` 400 (cap exceeded, unknown SKU, quantity out of range).
5. **Extra exports, private to the slice** (other streams don't need them): `lookupProxyForViewer` (the `/v1` lookup
   that returns 404 for addresses the key may not see), `listMyProxies`, `PROXY_RATE_SCOPES`,
   `proxy1024Runtime` (throttle/timeout knobs for tests), `resetProxy1024CatalogueCache`, `randomSid`,
   `stickyUsername`, `parse*Pricing`, `parseVendorTime`. `ProviderProxyRow` has two optional fields (`maxBindings`,
   `label`) and `upsertProviderProxies` also returns `skipped`: rows whose `host:port:username` already belongs to
   another proxy are skipped instead of taking over a manually entered proxy.
6. **INTEGRATOR wiring**
   - `app.ts`: `api.route('/proxies', proxies)` (`src/routes/proxies.ts`), `api.route('/admin/proxies', adminProxies)`
     (`src/routes/admin/proxies.ts`), `api.route('/admin/proxy-1024', adminProxy1024)` (`src/routes/admin/proxy-1024.ts`).
   - `routes/v1/index.ts`: `app.route('/proxies', v1Proxies)` (`src/routes/v1/proxies.ts`).
   - `scheduled.ts` (5-minute): `step(report, 'proxy.expire', () => expireProxies(env))` and
     `step(report, 'proxy_1024.reconcile', () => runProxy1024Cron(env))`.
   - `scheduled.ts` (daily maintenance): `for (const scope of PROXY_RATE_SCOPES) await purgeCounters(env, scope, minuteWindow(1) - 120);`
     All admin rate limits use `bumpCounter(env, scope, String(adminId), minuteWindow(1))`.
7. **Cron cost when the feature is disabled.** `runProxy1024Cron` always runs two small local UPDATEs, in parallel,
   before reading settings: quoted → expired, and `ordering` with an expired lease → `unknown`. They are indexed and
   make no vendor call, so an order caught mid-flight still becomes visible as `unknown` after the feature is turned off.
   Vendor calls happen only when the feature is enabled, a token is stored, and `integration_status.state != 'invalid'`.
8. **Request to FOUNDATION (optional).** After `integration_status` turns `invalid`, the cron stops probing. Pasting a
   new token in settings does not reset that state: the admin has to click 刷新 (`GET /status?live=1`), log in, or
   quote. Suggestion: when `updateSettings` changes `proxy1024.sessionToken`, delete the `integration_status` row for
   `proxy1024`. That would live in `setting.ts`, which the slice must not edit.
9. **UNVERIFIED vendor behaviour (P§11), guarded in code:**
   - Whether an `order*` response carries an `order_no`. We read `data.order_no` and fall back to the checkout URL
     query. Without it, reconciliation matches on amount ± 1 cent within a time window and accepts only a unique match.
   - Paying with balance: `payOrderWithBalance` always throws `unsupported`, and the admin pays on the checkout page.
   - `static_use` allocation: `/orders/:id/allocate` may run once per order, and any later attempt is refused.
     Follow-up is "同步库存".
   - The date format and timezone of `get_recharge_record`: we send `YYYY-MM-DD` ±1 day and read timestamps without
     a zone as UTC+8.
   - List field names (`list`/`lists`/`rows`, `expired`, `password`/`pass`) are read defensively.
   - The static ISP estimate applies the site's client-side volume discount; the server's figure is authoritative.
     `capBasisCents` uses the undiscounted `max(price, costprice)`.

## INTEGRATOR (2026-11-25) — applied

- SLICE_DOMAIN 1: `DOMAIN_SKIP_REASONS` gained `tldNotSupported`, `unexpectedError`, `no_price`; the web `SKIP_REASON_LABELS` is now
  typed against it and labels `no_price`.
- SLICE_DOMAIN 2–4: accepted as implemented (429 `rate_limited`, `POST /quotes` 201, private deps fields); OpenAPI documents 201.
- SLICE_PROXY 1: shared `PROXY_ORDER_WARNINGS` / `ProxyOrderWarning`; `ProxyOrderView.warnings` is `ProxyOrderWarning[]`; the web labels
  all four and no longer repeats `payment_manual` / `maybe_charged` next to the status text that already says so.
- SLICE_PROXY 2: export content shape documented in `/api/openapi.json` (`ProxyExport.content`) and `references/administration.md`.
- SLICE_PROXY 8: `updateSettings` now sets `integration_status(proxy1024)` from `invalid` back to `unknown` (detail cleared, balance kept)
  whenever a new `proxy1024.sessionToken` is submitted (any value other than `SECRET_MASK`, including `''`). Test:
  `test/procurement-integration.test.ts`.
- Rate-limit cleanup: domain-purchase admin scopes are exported as `DOMAIN_PURCHASE_RATE_SCOPES` (+ `SPACESHIP_POLL_SCOPE`, 5-minute
  windows) and purged in daily maintenance together with `PROXY_RATE_SCOPES`.
- Wiring: routers mounted in `app.ts` / `routes/v1/index.ts`; `proxy.expire`, `proxy_1024.reconcile`, `domain_purchase.advance` in
  `scheduled.ts` (shared by the workerd `scheduled` handler and the Node 5-minute timer); `server/main.ts` maps `CF_API_TOKEN`,
  `CF_ACCOUNT_ID`, `CF_EMAIL_WORKER_NAME`, `SECRET_BOX_KEY`; `deploy/k3s.yaml` sets `CF_EMAIL_WORKER_NAME=hpc-mail-ingress-20261028`
  (inert without the CF secrets). OpenAPI fragments live in `src/routes/openapi-procurement.ts`; `/v1/status` scopes now come from
  `API_SCOPES`.
