# Code map: where 1024proxy, the proxy inventory and Spaceship plug in

Branch `feat/proxy-pool-spaceship` (based on `codex/k3s-postgres`, HEAD `22a2786`). All paths are repo-relative; `W` = `apps/worker`, `S` = `packages/shared`, `Web` = `apps/web`. Line numbers were taken at the HEAD above.

---

## 0. Baseline status (2026-11-25, before any change)

| Check | Command (cwd `apps/worker` unless noted) | Result |
|---|---|---|
| Worker typecheck | `pnpm typecheck` (`tsc -p tsconfig.json`) | pass |
| Node runtime typecheck | `pnpm typecheck:node` (`tsc -p tsconfig.server.json`) | pass |
| workerd subset | `npx vitest run test/hosted-domains.test.ts test/lib.test.ts test/db.test.ts` | 3 files, 104 tests pass |
| Postgres suite (full) | `TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55439/postgres pnpm test:postgres` | 36 files, 508 pass / 18 skipped (the SQLite-planner-only names) |
| Web typecheck | `pnpm --filter @hpc-mail/web typecheck` | pass |
| Web subset | `npx vitest run src/features/admin/domains src/features/admin/hosted-domains` (cwd `apps/web`) | 2 files, 11 pass |
| Shared tests | `pnpm --filter @hpc-mail/shared test` | 3 files, 40 pass |

Notes from the run:
- Port 55432 is already used on this Mac by another container, so the Postgres test container ran on `127.0.0.1:55439`: `docker run -d --rm -p 127.0.0.1:55439:5432 -e POSTGRES_PASSWORD=pw --name hpcmail-pgtest-map postgres:16`. The default URL in `W/server/test-env.ts:7` (`127.0.0.1:15432/hpc_test`) is not running locally, so always set `TEST_DATABASE_URL`.
- `W/.dev.vars` does not exist in this worktree (good: CLAUDE.md warns that a real `cf_api_token` there breaks the "no credentials" tests).

---

## 1. Settings service (admin settings, secret masking, revisions)

**Contract (shared)** – `S/src/schemas/admin-settings.ts`
- `SECRET_MASK = '******'` :7. Settings echo this value in place of a secret; a PUT that submits it keeps the stored value.
- `SETTING_SCHEMAS` :187-201 is the registry of setting keys. Each key is one row in the `settings` table (`key` text PK, `value` JSON text; `W/src/db/schema.ts:327-330`).
- `DEFAULT_SETTINGS` :208-227 and `updateSettingsRequestSchema` :229-248 (every key optional, plus `expectedDomainsRevision` :236; the refine at :246 requires at least one key).
- `aiModelSettingSchema` :132-137 is the only existing secret-bearing setting. Use it as the template for a `proxy_1024` / `spaceship` setting that holds credentials.
- `hostedDomainsSettingSchema` :171-183 is the template for a feature setting with an `enabled` flag and caps.

**Service** – `W/src/services/setting.ts`
- `mergeSettingRows` :20-34 calls `safeParse` on each key. An invalid stored value silently falls back to the default, so new schemas need `.default()` on fields that may be added later.
- `getSettingsFresh` :37-40 reads straight from D1/PG. Use it for anything that must be strongly consistent (caps, domain revision).
- `settingsQuery` :56-67 and `getSettings` :73-81 use a 15 s per-isolate memory cache. On Node there is one process, so the cache is process-wide. If reading fails, `getSettings` returns `DEFAULT_SETTINGS`, which means **every feature is disabled when settings are unavailable**. That is safe for opt-in features.
- `updateSettings` :111-167:
  - SECRET_MASK keep-old logic for `ai_model.apiKey` is at :124-128. **Each new secret field needs its own branch here.** No generic mechanism exists.
  - The domains branch :132-143 refuses domains present in `hosted_domains` (`json_each` query :137-141) and computes `revision: expected + 1`.
  - Cross-key validation runs before any write :145-153.
  - The domains CAS write is :154-161: `INSERT … SELECT … WHERE ? = COALESCE(json_extract(value,'$.revision'),0) ON CONFLICT DO UPDATE … WHERE … RETURNING key`. A missing row means 409 `conflict`.
  - Other keys are upserted one by one :162-165 (not atomic with the domains CAS), and `invalidateSettingsCache` runs at :166.
- `maskSettings` :170-173 masks the admin echo. **Extend it for every new secret.**

**Route** – `W/src/routes/admin/settings.ts`
- `app.use('*', requireAuth, requireAdmin)` :22.
- GET `/api/admin/settings` → `maskSettings(getSettingsFresh)` :25-28.
- PUT :30-41 requires `expectedDomainsRevision` when `domains` is present (:33). It reads `before`, writes, then logs an audit entry with `describeSettingsChange`.
- The pattern for testing a credential (`POST /ai-model-test`) is at :59-78: unsubmitted fields and SECRET_MASK fall back to the saved value. Reuse it for "test 1024proxy login" and "test Spaceship key".

**Audit of secrets** – `W/src/services/audit.ts:66` `SECRET_SETTING_FIELDS = new Set(['ai_model.apiKey'])`. **New secret paths must be added here**; otherwise `describeValue` (:68-80) writes the old and new secret values into `admin_audit_logs.detail`.

**Web echo** – `Web/src/features/admin/settings/settings-page.tsx:63-64` keeps a local `SECRET_MASK` copy, which a test checks against shared. Input handling is at :126 and :165-166.

---

## 2. Domain list update path (`settings.domains.list`, `expectedDomainsRevision`)

- Schema: `domainEntrySchema` `S/src/schemas/admin-settings.ts:71-79` (`domain`, `public` default false, `perUserLimit` default 0, `random?`). `domainsSettingSchema` :83-86 has **`.max(64)` entries and must be unique.** This hard cap matters for bulk purchases. The cap needs a decision, see the open issues.
- Readers: `W/src/services/domain.ts`: `getDomains` :16, `getPublicDomains` :28, `getVisibleDomains` :37, `getRoutableDomains` :92-123 (settings list ∪ claimed mailbox domains ± hosted status).
- **Inbound gate on k3s:** `W/server/inbound-relay.ts:33` returns 422 unless the recipient domain is in `getRoutableDomains(env)`. The SMTP path `W/server/main.ts:103-106` has the same gate. A purchased domain therefore receives nothing until it is added to `settings.domains.list`. Adding it is the last "ready" step.
- Correct programmatic append (server side, no HTTP):
  1. `const s = await getSettingsFresh(env)`
  2. `await updateSettings(env, { domains: { list: [...s.domains.list, { domain, public: false, perUserLimit: 0 }] }, expectedDomainsRevision: s.domains.revision ?? 0 })`
  3. On `AppError('conflict')`, re-read and retry a bounded number of times. Treat "already present" as success, which makes the step idempotent.
  4. Then `logAdminAction(..., 'settings.update', 'domains', describeSettingsChange(...))`, or a dedicated `spaceship.domain_ready` action.
- Mutual exclusion: `updateSettings` rejects a domain that is in `hosted_domains` (`setting.ts:136-141`). `createHostedDomain` rejects a domain already in the system list (`hosted-domain.ts:251-253`). A Spaceship-bought domain must therefore **not** be inserted into `hosted_domains`. Track its zone in a new table (section 3).
- The first-boot seed on Node writes the list from `MAIL_DOMAINS` (`W/server/main.ts:62`). This runs only when no admin exists, so it never overwrites the list later.
- Web: `Web/src/features/admin/domains/domains-page.tsx:253-256` (`persist` mutation sends `expectedDomainsRevision: settings.domains.revision ?? 0`).

---

## 3. Hosted-domain + Cloudflare services

### `W/src/services/cloudflare.ts` (stateless Cloudflare API helpers; reuse directly)
- `CloudflareCredentials { token, accountId, workerName }` :7-12. `cloudflareCredentials(env)` :14-19 returns null unless both `env.cf_api_token` and `env.cf_account_id` are set. `workerName = env.worker_name?.trim() || 'hpc-cloud-mail'` :18.
- `cfFetch` :40-66: 10 s timeout, `redirect: 'manual'`, throws `CloudflareApiError(status, codes)` :22-31. `isTransientCloudflareError` :112-114 (status 0 / 429 / 5xx means the outcome is unknown, so keep state and retry).
- Zones:
  - `findZone(creds, name)` :122-126 (account-scoped, includes pending)
  - `createZone` :128-130 (`type: 'full'`); `result.name_servers` holds the **CF-assigned NS** to send to Spaceship
  - `getZone` :133-140 (null only after confirming by name, see `confirmMissing` :116-119; 403/9109 is ambiguous)
  - `deleteZone` :143-149, `requestActivationCheck` :152-158 (Free plan allows one call per hour), `countZones` :231-238 (used for the ">50 zones and pending > active" guard)
- Email Routing:
  - `getRouting` :160-162, `enableRouting` :168-170 (POST `/email/routing/dns` with `{}` for the apex; fails with 2009 while the zone is pending)
  - `getCatchAll` :172-174, `putCatchAll` :176-183 (rule `actions: [{type:'worker', value:[creds.workerName]}]`)
  - `catchAllTargetsWorker(rule, workerName)` :185-188
- Email Sending (`listSendingSubdomains` / `createSendingSubdomain` / ... :190-210) is used by hosted domains. It is **not needed on k3s**, where outbound mail goes through `SMTP_RELAY_URL`, so the Spaceship flow should skip it.
- `verifyToken` :218-228 is used for the health/"test credentials" pattern.

### Catch-all target worker on k3s: required change
- Worker mode: `W/wrangler.toml:34` `worker_name = "hpc-cloud-mail"` (a var), typed at `W/src/types.ts:20-21`.
- **Node/k3s mode does not wire any of the CF variables today.** The `env` object at `W/server/main.ts:31-52` sets only `db, kv, r2, jwt_secret, site_origin, build_sha, email, assets`. As a result `cloudflareCredentials(env)` is always null on k3s, hosted domains are effectively off there, and `syncDueHostedDomains` returns 0 immediately (`hosted-domain.ts:526`).
- To make zone creation work on k3s, add to that `env` literal: `cf_api_token: process.env.CF_API_TOKEN, cf_account_id: process.env.CF_ACCOUNT_ID, worker_name: process.env.CF_EMAIL_WORKER_NAME` (or similarly named variables). Set `CF_EMAIL_WORKER_NAME=hpc-mail-ingress-20261028`, the ingress worker name from `W/ingress/wrangler.toml:1`. All of these come from the `hpc-mail` Secret via `envFrom` (`deploy/k3s.yaml:59-60`). Because `putCatchAll`/`catchAllTargetsWorker` already use `creds.workerName`, this single mapping points every catch-all at the ingress worker. No other code changes are needed. Note `deploy/README.md:36`: the ingress worker is `hpc-mail-ingress-20261028`, `BACKEND_URL=https://ingress.anytoken.email`.
- Turning on `cf_api_token` on k3s also enables **user-hosted domains** (`hostedDomainsAvailable` `hosted-domain.ts:38-40`). The first-boot seed disabled `hosted_domains.enabled` (`main.ts:62`), so it stays off unless an admin enables it. If the Spaceship feature needs separate credentials or a separate switch, give it its own credential accessor rather than reusing `cloudflareCredentials`.

### `W/src/services/hosted-domain.ts` (stateful flow to copy, not call)
- `createHostedDomain` :248-305: reserve the row first with a guarded `INSERT … WHERE NOT EXISTS … RETURNING id` :255-266, then `findZone`, which **refuses to take over an existing zone** :271-273, then `createZone` :275. On a transient error the reservation is kept for the cron to recover :277-279. Otherwise the reservation is deleted :280. Finally the zone id and NS are back-filled with a guarded UPDATE :285-299 and the audit entry is written :300.
- `ensureMailConfig` :324-381 (private) is a read-then-write, idempotent sequence: Routing (only when the zone is active) :336-346 → catch-all :348-356 → sending :358-379. Transient errors keep the previous state (`settled` :334).
- `saveChecked` :384-387, `preconfigure` :389-396, `recoverReservation` :409-424 (finds the zone by name with `created_on >= reservation - 1 min`), `teardown` :426-463, `dropPending` :399-407.
- `syncHostedDomain` :465-523 is the state machine (pending/initializing → wait plus optional activation check; moved; active → ensureMailConfig → active/provisioning/error with a 30 min grace).
- `syncDueHostedDomains` :525-543: `SELECT id … WHERE status IN(...) OR (status='pending' AND COALESCE(checked_at,0) < ?) … ORDER BY COALESCE(checked_at,0) LIMIT ?`, processing 10 per cron with per-row try/catch. **Copy this "due query plus per-row try/catch" shape for Spaceship domain progress.**
- The Spaceship flow should call the `cloudflare.ts` primitives itself, with its own table (e.g. `spaceship_domain_orders` and `cf_zone_id`/`name_servers`/`step`/`last_error`/`checked_at` columns). `ensureMailConfig` is not exported, and it also does Email Sending and writes `hosted_domains`. Exporting a reduced "routing + catch-all" helper from `hosted-domain.ts` is the other option.
- The constant `SYSTEM_ACTOR = { id: 0, username: 'system' }` :36 is the actor for cron-side audit entries.
- Tests mock Cloudflare with `vi.stubGlobal('fetch', fetchMock)` and an in-memory zone map (`W/test/hosted-domains.test.ts:42-112`). Credentials are injected per test with `const runtime: Env = { ...env, cf_api_token: 'test-token', cf_account_id: ACCOUNT, worker_name: WORKER }` :115. Use the same approach for Spaceship and 1024proxy mocks; no live calls.

---

## 4. Scheduled jobs and the Node cron trigger

- `W/src/services/scheduled.ts`:
  - `step(report, name, task)` :139-148 isolates failures per step and logs `{step, ms, count|failed}`.
  - `runScheduled(env, maintenance)` :151-169: notification repair/process, purge recover, claude facts, storage leases/links/cleanup, `hosted_domains.sync` :166, then maintenance (daily) :171-230.
  - Add new steps (e.g. `spaceship.progress`, `proxy_1024.reconcile`) next to :166. Each should be bounded (LIMIT and deadline) and must return quickly when the feature is not configured.
- Worker trigger: `W/src/index.ts:124-126` (`scheduled` → `runScheduled(env, cron === '0 16 * * *')`); crons are configured at `W/wrangler.toml:26-27` (`*/5 * * * *`, `0 16 * * *`).
- **Node trigger:** `W/server/main.ts:142-147` runs `setInterval` every 5 min. The `scheduled` flag prevents overlap inside the process. Maintenance runs when the UTC hour is 16 and the minute is < 5. The interval is cleared on SIGTERM :149-153, with a 25 s hard exit.
  - The interval guard is per process. With more than one replica, ticks overlap across pods. Every cron-side mutation must therefore be guarded at row level (CAS on `status`/`lease_until`), the same way `hosted_domains` uses guarded UPDATEs. This matters most for "register domain" and "pay order", which must never run twice. Use a lease row or claim with `UPDATE … SET status='registering', lease=? WHERE id=? AND status='queued' RETURNING id` **before** the external call, and if the result is unknown, set `status='unknown'` and never retry automatically.
  - The first tick fires 5 min after boot, and no tick fires on startup.
- `waitUntil` on Node (`main.ts:67-69`) is fire-and-forget with logging only. It has no durability, so long multi-step work belongs in the cron, driven from DB state.

---

## 5. Admin route layout and `requireAdmin`

- Mounting: `W/src/app.ts:32-64`. The `/api` sub-app registers the `admin/*` routers at :51-58; `/v1` is mounted at :61. New routers would go at, for example, `api.route('/admin/proxies', …)`, `api.route('/admin/proxy-1024', …)` and `api.route('/admin/spaceship', …)`.
- Router file pattern (`W/src/routes/admin/hosted-domains.ts`): `const app = new Hono<AppContext>(); app.use('*', requireAuth, requireAdmin);` :11-12, handlers `ok(c, await service(c.env, c.get('user')!, …, clientIp(c)))`.
- Middleware: `requireAuth` `W/src/middleware/auth.ts:54` (JWT + D1 session batch), `requireAdmin` :218-221 (`user.role !== 'admin'` → 403 `forbidden`).
- Helpers: `W/src/lib/http.ts` `ok` :16, `execCtx` :21, `clientIp` :30, `parseId` :36, `parseBooleanFlag` :43, `parseBody(c, zodSchema)` :50, `parseQuery` :65. Errors: `AppError(code, message)` `W/src/lib/errors.ts:4-16` with codes and statuses from `S/src/envelope.ts:19-56`. There is no 202 code or "unknown" code; return a domain-specific status inside `{data}`.
- Envelope: success `{data}` and failure `{error:{code,message},requestId}` (`W/src/middleware/error.ts:20`).
- **OpenAPI is enforced:** `W/test/openapi-contract.test.ts` "describes every mounted endpoint and does not invent unimplemented endpoints" (:73-77) compares `app.routes` with the operations in both specs. **Every new `/api/admin/*` route must be added to `W/src/routes/api-openapi.ts`** (paths object at :11, admin examples :177-196) **and every new `/v1/*` route to `W/src/routes/v1/openapi.ts`.** Shared schema fragments and `fromZod` live in `W/src/routes/openapi-common.ts` (helpers :15-37, `schemas` :103, `query` :258).

---

## 6. `/v1` API-key auth and scope model (what addresses a key can reach)

- `apiKeyAuth` `W/src/middleware/api-key-auth.ts:61-165` performs one batched read (settings plus key by sha256, :46-58). It then checks status, user status, expiry and IP allowlist (:92-97). It sets `c.set('apiKey', {id, userId, role, scopes})` (:100-105), runs a single write batch for the rate limits (:118-131), and writes the `api_request_logs` audit entry in `finally` (:150-164).
- `requireScope(c, scope)` :168-173. Scopes: `S/src/constants.ts:10-17` → `mail.read | mail.write | mail.send | mailbox.read | mailbox.write`. Keys carry the **owner's role** (`ApiKeyContext` `W/src/types.ts:36-41`). There are no per-key address restrictions.
- Address visibility (to mirror in the proxy lookup):
  - Non-admin key: the user's own `mailboxes` rows (`listMailboxes(env, {userId})`, `W/src/routes/v1/mailboxes.ts:19-26`) plus mailboxes shared with the user (`/v1/mailboxes/shared` :13-17; `sharedAddressQuery` `W/src/services/message.ts:168-175`, inbound-only).
  - Admin key: may pass `?all=1` (:22-24), `scope=unclaimed|user` (`W/src/lib/message-viewer.ts:9-27`, non-admins are limited to `mine`).
  - Ownership helpers: `userOwnsAddress` `W/src/services/mailbox.ts:773`, `getMailboxOwner` :709, `userAddresses` :698.
- Suggested rule for `GET /v1/mailboxes/proxy?address=` (or `/v1/proxies/...`): require `mailbox.read`, plus either the address belongs to the key user or the key role is admin. Whether shared-to-me grants proxy access is an open decision: shares cover only reading mail, not other credentials. Bulk export and auto-assign belong in admin JWT routes. A new scope, e.g. `proxy.read`, can be added to `API_SCOPES`, which also needs the api-key UI (`Web/src/features/api-keys/create-api-key-dialog.tsx`) and the OpenAPI updated. CLAUDE.md also says "账户设置及管理员功能只使用 JWT，不扩张邮箱 Key 的权限", so keep admin-only actions off `/v1`.
- `/v1` routes are listed in `W/src/routes/v1/index.ts:25-44`. Update `Web/public/skill.md` and `Web/public/references/mailboxes-and-domains.md` (agent docs) when `/v1` changes, as CLAUDE.md requires.

---

## 7. Mailboxes table, schema.ts and migrations

- `mailboxes` `W/src/db/schema.ts:48-59`: `id` (autoincrement), `address` unique, `domain`, `user_id`, `display_name`, `created_at` (ms). Indexes `idx_mailboxes_user`, `idx_mailboxes_domain`.
- **Unclaimed addresses have no mailbox row.** Catch-all mail can arrive for any address, and `messages.address` is the visibility key (CLAUDE.md). A per-address proxy binding that must also work for unclaimed or not-yet-claimed addresses should therefore key on `address` (text, unique), not on `mailbox_id`.
- Mailbox deletion and ownership-change paths a binding must react to (or deliberately ignore):
  - `releaseMailbox` `W/src/services/mailbox.ts:645-675` (DELETE at :666)
  - `transferMailbox` :583 (owner changes, row kept)
  - `deleteUser` `W/src/services/user.ts:196-221` (DELETE mailboxes by user :221)
  - hosted `teardown` `W/src/services/hosted-domain.ts:437`
- Column conventions: `createdAtColumn()` :6-9 (`integer timestamp_ms default (unixepoch()*1000)`), JSON as `text({mode:'json'}).$type<…>()`, booleans as `integer({mode:'boolean'})`, enums as `text({enum:[…]})`. Template table: `hostedDomains` :281-312.
- Migrations: `W/drizzle.config.ts` (sqlite dialect, out `./migrations`).
  - Generate with `pnpm --filter @hpc-mail/worker db:generate` after editing schema.ts. This produces `migrations/00NN_<name>.sql` plus `meta/00NN_snapshot.json` and a `_journal.json` entry. The latest is `0020_hosted_domains`, so the next is `0021_…`.
  - Statements are separated by `--> statement-breakpoint`.
  - Hand-edited or custom SQL exists (`0010`, `0013`, `0019` contain DML). Keep the drizzle snapshot consistent so that later `db:generate` runs do not re-emit the changes.
- **D1 apply:** wrangler `d1 migrations apply` (scripts in `W/package.json`). CI checks that the number of `migrations/*.sql` files equals `d1_migrations` rows (`.github/workflows/deploy.yml:208-211`).
- **workerd tests:** `W/vitest.config.ts` reads `readD1Migrations('migrations')`; `W/test/apply-migrations.ts` applies them per test file.
- **Postgres apply:** `PostgresDatabase.migrate(dir)` `W/server/postgres.ts:156-177`:
  - Takes a tx plus advisory lock 15400602 and installs the helper functions (:103-115).
  - Tracks applied files in `hpc_migrations(name)`. It applies `*.sql` files **sorted by filename** (not by journal), splitting each on `--> statement-breakpoint` and running `translateSql` on every statement.
  - Then installs the `hpc_assign_id` trigger on every identity `id` table and creates `hpc_kv`.
  - It is called at boot: `W/server/main.ts:21` (`MIGRATIONS_DIR`).
- **server-dist:** `W/server/build.mjs` (`pnpm --filter @hpc-mail/worker build:node`) bundles `server/main.ts` into `server-dist/server.mjs` and copies `dist` (web build) into `server-dist/assets` and `migrations` into `server-dist/migrations`. `Dockerfile.k3s` sets `MIGRATIONS_DIR=/app/migrations`. The release steps are in `deploy/README.md:46-50`: `pnpm build`, then `build:node`, then `docker buildx … -f Dockerfile.k3s`.

### SQL the Postgres adapter translates (`translateSql` `W/server/postgres.ts:37-101`)
Supported or translated:
- Placeholders: `?` / `?N` become `$N` with casts from the JS value type (integer → `::bigint`, float → `::double precision`, string → `::text`, null/boolean → no cast). Placeholders inside quoted strings are left untouched (:57-64). Backtick identifiers become double quotes.
- Functions:
  - `changes()` is replaced by the previous statement's change count within a batch (:65)
  - `unixepoch()` → `floor(extract(epoch from statement_timestamp()))::bigint` (:66)
  - `instr` → `strpos` (:67), `substr` gets integer casts (:68)
  - `json_extract(v, '$.path')` → `hpc_json_text`, or `hpc_json_number` **only for the whitelisted paths `revision|autoClaimLimit|perUserLimit|perDomainLimit|ownedDomain|wasTaken|hosted`** (:69-72). **A new numeric JSON path compared with a number must be added to that regex.**
  - `json_each(?)` → `hpc_json_each`, or `hpc_json_numbers` when the bound JSON is all numbers or the SQL compares `id`/`user_id`/`mailbox_id IN (SELECT value FROM json_each(…))` (:73-80)
- `SUM(<boolean expr>)` → `SUM((expr)::integer)`; multi-argument `MAX`/`MIN` → `GREATEST`/`LEAST` (:86-87).
- `WHERE 1` → `WHERE TRUE`; `INDEXED BY …` is stripped; table-qualified `ON CONFLICT(...)` columns are unqualified (:88-90).
- `IS ?` / `IS NOT ?` → `IS [NOT] DISTINCT FROM` (:93).
- `INSERT OR IGNORE` → `… ON CONFLICT DO NOTHING` (:95-97).
- DDL: `integer PRIMARY KEY AUTOINCREMENT` → `bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY`; `integer` → `bigint`; `DEFAULT false/true` → `0/1` (:98-99).
- A few hard-coded rewrites exist for specific existing queries (:82-84, :91-92, :94) and the two trigger DDLs (:38-53).

Results:
- Postgres booleans come back as `0/1`. CamelCase aliases are recovered only for `AS camelName` (:190-195). `last_row_id` is `rows[0].id`, so it is set only when the statement uses `RETURNING id` (:198).
- `UNIQUE`/`NOT NULL` violations are rewritten to SQLite-style messages (`sqliteError` :117-125).

Not translated, so avoid or add a translation plus a test in `W/server/postgres.test.ts`:
- `datetime()`/`strftime()`/`date()`
- `IFNULL` (use `COALESCE`)
- `group_concat`, `json_group_array`/`json_object`
- `GLOB`, `REPLACE INTO`/`INSERT OR REPLACE`
- implicit text↔int comparisons
- `LIKE`: case-insensitive in SQLite, case-sensitive in PG, so lowercase on both sides
- `json_extract` numeric paths not in the whitelist
- booleans bound as JS `true/false` in raw SQL (bind `1/0`)

Concurrency: **every** `batch()` (and every single-statement `.all/.run/.first`, which go through `batch`) runs in a transaction holding **global advisory lock 15400601** (:134-150), mirroring D1's serialised writes. Statement timeout is 15 s and the pool max is 4 (:131). Never hold a transaction open across an external HTTP call (D1 cannot do that anyway). Write "intent/claimed" state first, call out, then write the result.

D1 bound-parameter limit: 100 (`W/src/lib/d1.ts:7`). `chunk()` :16 uses 90 per batch. Pass address lists as JSON plus `json_each(?)`.

---

## 8. Audit log service

- `logAdminAction(env, actor{id,username}, action, target='', detail='', ip='')` `W/src/services/audit.ts:9-24` is best-effort and never throws. Table `admin_audit_logs` is at `W/src/db/schema.ts:425-441`. Entries older than 90 days are pruned in maintenance (`scheduled.ts:178-190`).
- Action naming is `area.verb` (`hosted_domain.create`, `settings.update`, `mailbox.transfer`). Suggested: `proxy.create|update|delete|bind|unbind|auto_assign|export`, `proxy_1024.quote|order.execute|order.unknown`, `spaceship.quote|order.confirm|domain.register|domain.ready|domain.retry`. The cron actor is `{id:0, username:'system'}` (`hosted-domain.ts:36`).
- Never put secrets (proxy password, 1024 password, Spaceship key) into `target` or `detail`. `detail` is truncated to 1000 characters by `describeSettingsChange` only, while `logAdminAction` stores whatever it receives.
- When an audit record must be atomic with the change, inline the INSERT into the same `db.batch` (transfer does this; see `CLAUDE.md` "所有权、旧共享撤销、管理审计同一 D1 事务").
- List endpoint: `W/src/routes/admin/audit.ts` (GET `/api/admin/audit-logs`, cursor paging) → `listAdminAuditLogs` `audit.ts:109-137`.

---

## 9. `W/src/lib/crypto.ts`: no symmetric encryption

- Available: `sha256Hex` :16, `hmacSha256Hex` :25, `hmacSha256Base64` :38, `timingSafeEqualStr` :52, `signAttachment`/`verifyAttachmentSig` :59-78 (HMAC with `jwt_secret`).
- **There is no AES or other encryption anywhere** (`grep -rn "AES|encrypt|decrypt" src server` returns nothing). Existing secrets are stored in plaintext in the DB and protected only by masking: `ai_model.apiKey` in the `settings` row, `users.totp_secret`, notify-prefs webhook secrets.
- Options for 1024 and Spaceship credentials and for stored proxy passwords:
  1. Follow the existing convention: plaintext in the DB, SECRET_MASK on echo, never audited.
  2. Add an AES-GCM helper with WebCrypto (`crypto.subtle` works in both workerd and Node 22). The key would come from a new env secret (e.g. `SETTINGS_ENC_KEY`), wired in `W/src/types.ts` and `W/server/main.ts` `env`, and in CI secrets for Worker mode.
  3. Keep the vendor credentials out of the DB entirely as env secrets, like `cf_api_token`.

  This needs a decision (see the open issues). Proxy passwords must be returned in clear to authorised consumers (`/v1` lookup), so option 2 means decrypting on read.

---

## 10. Shared package (zod contracts) and OpenAPI

- `S/package.json`: source-only, `exports: { ".": "./src/index.ts" }`, dependency zod 4.
- Barrel: `S/src/index.ts:1-13` re-exports `constants`, `envelope` and `schemas/*`. **New files (e.g. `schemas/proxy.ts`, `schemas/spaceship.ts`, `schemas/proxy-1024.ts`) must be added here.**
- Template: `S/src/schemas/hosted-domain.ts` (131 lines: request schemas, view interfaces, admin query schema) and `S/src/schemas/api-key.ts`.
- Tests: `S/test/*.test.ts` (`schemas.test.ts`, `hosted-dns.test.ts`, `mailbox-policy.test.ts`).
- Worker validates with `parseBody(c, schema)` / `parseQuery`. Web imports types and uses schemas for form pre-validation. Per CLAUDE.md, the login and entry chunk must not import shared runtime values, so admin pages that do so are fine because they are lazy chunks.
- OpenAPI: session spec `W/src/routes/api-openapi.ts` (`buildSessionOpenApiSpec` :9), API-key spec `W/src/routes/v1/openapi.ts` (`buildOpenApiSpec` :7), common fragments and `fromZod` in `W/src/routes/openapi-common.ts:34`. Both are served raw (no `{data}`) at `/api/openapi.json` and `/v1/openapi.json` (`app.ts:39`, `v1/index.ts:37`). The contract test is in section 5.

---

## 11. Web admin structure

- Router: `Web/src/app/router.tsx`.
  - `page(load, pick)` :32-33 wraps `lazyWithReload` (not `React.lazy`).
  - Admin pages are registered with inline `preloadable(() => import(...))` :46-66.
  - Admin children under `path: 'admin'` with `<AdminGuard/>` are at :93-110 (e.g. `{ path: 'hosted-domains', element: <AdminHostedDomainsPage/>, handle: title('托管域名') }` :103).
- Preload registry: `Web/src/app/route-modules.ts`, `preloadable` :7-19. Hot user routes are in `ROUTE_LOADERS` :37-49. Admin routes intentionally are not (comment :54), so new admin pages need only a `router.tsx` entry.
- Admin nav: `ADMIN_NAV` in `Web/src/app/app-shell.tsx:76-85` (`{ to, label, icon }`, lucide icons).
- API client: `Web/src/api/client.ts` `apiRequest` :76-125 unwraps `{data}`, adds the Bearer token and clears the token on 401. The `api.get/post/put/delete` helpers are at :127-136.
  - Resource objects: `Web/src/api/resources.ts` (`adminApi` :240-268).
  - Feature-local API modules are an alternative, e.g. `Web/src/features/hosted-domains/hosted-domains-api.ts` (`adminHostedDomainApi` :50-56).
  - Query keys: `Web/src/api/query-keys.ts` (`admin` group :53-64).
- Templates:
  - `Web/src/features/admin/domains/domains-page.tsx` (496 lines): settings-driven list with a revision CAS (`persist` :253-256) and per-domain DNS status queries.
  - `Web/src/features/admin/hosted-domains/admin-hosted-domains-page.tsx` (296 lines): health card `useQuery(queryKeys.admin.hostedDomainsHealth)` :55, filtered list :154-155, action mutation with invalidate :162-168.
  - The addresses page `Web/src/features/admin/addresses/addresses-page.tsx`, a virtualised list of all addresses, is the natural place for a per-address "proxy" column or bind action.
  - Settings page secret field: `Web/src/features/admin/settings/settings-page.tsx:126,165-166`.
- UI kit: `Web/src/components/ui/*` (table, dialog, confirm-dialog, badge, switch, textarea, toast, ...), plus `Web/src/components/page-header.tsx` and `query-error-state.tsx`.
- Web tests sit next to the code (`*.test.tsx`, 72 files). Admin pages each have one (e.g. `admin-hosted-domains-page.test.tsx`, `domains-page.test.tsx`). Run them with `pnpm --filter @hpc-mail/web exec vitest run <path>`.

---

## 12. Test layout and how to run

- **workerd (D1/SQLite):** `W/vitest.config.ts` uses `cloudflareTest` with `wrangler.test.toml`, binds `jwt_secret` and `TEST_MIGRATIONS`, and excludes `server/**`.
  - Setup is `W/test/apply-migrations.ts`. Tests import `{ env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'` and call `createApp().request(...)` or the services directly.
  - **Storage is shared between tests in the same file.** Use unique prefixes or reset in a fixture (see `fixture()` `W/test/hosted-domains.test.ts:118-135`).
  - Run with `pnpm --filter @hpc-mail/worker test` (also runs the `check-drop-legacy` and `check-inject-asset-routes` scripts) or `npx vitest run test/<file>` in `apps/worker`.
- **Postgres:** `W/vitest.postgres.config.ts` aliases `cloudflare:test` to `W/server/test-env.ts` (a fresh `test_<uuid>` schema per run with `PostgresDatabase`, `FileBucket` and `PostgresKV`) and `cloudflare:email`.
  - Setup is `W/server/test-setup.ts` (migrate, test trigger fn, drop schema afterwards). There is no file parallelism, and timeouts are 30 s.
  - It runs **the same `test/*.test.ts` files plus `server/*.test.ts`**, so a new test under `W/test/` automatically covers both engines. SQLite-planner-only test names are skipped by `testNamePattern` (:5-17).
  - Adapter unit tests: `W/server/postgres.test.ts`.
  - Run: `docker run -d --rm -p 127.0.0.1:55439:5432 -e POSTGRES_PASSWORD=pw --name hpcmail-pgtest postgres:16`, then `TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55439/postgres pnpm --filter @hpc-mail/worker test:postgres`.
- **Mocking outbound HTTP:** `vi.stubGlobal('fetch', vi.fn(...))` and assert the origin (see `hosted-domains.test.ts:46-112`). For Spaceship, mock `https://spaceship.dev/api/v1/...`, including 202 with the `spaceship-async-operationid` header and the async-operation polling. For 1024proxy, mock `api.1024proxy.com`. **No live calls.**
- Typecheck: `pnpm --filter @hpc-mail/worker typecheck` and `typecheck:node` (the server tsconfig also covers `server/main.ts` env wiring). `pnpm typecheck` at the root covers all packages.

---

## 13. Placement summary for the new feature

| Concern | Put it in |
|---|---|
| zod contracts | `S/src/schemas/proxy.ts`, `spaceship.ts`, `proxy-1024.ts` and export them from `S/src/index.ts` |
| Settings (enabled, caps, credentials) | new keys in `SETTING_SCHEMAS`/`DEFAULT_SETTINGS`/`updateSettingsRequestSchema`; SECRET_MASK branches in `updateSettings` and `maskSettings`; `SECRET_SETTING_FIELDS` in audit; optionally `/test` endpoints modelled on `/ai-model-test` |
| Tables | `W/src/db/schema.ts` and `db:generate` (`0021_*`): `proxies`, `address_proxy_bindings` (address-keyed), `proxy_1024_orders` (quote/confirmed/paying/paid/unknown/failed), `spaceship_orders` and `spaceship_order_domains` (per-domain step machine: quoted → registering → registered/unknown → zone_created → ns_set → zone_active → routing_ready → listed) |
| External clients | `W/src/services/spaceship.ts`, `W/src/services/proxy-1024.ts`, modelled on `cloudflare.ts` (timeout, `redirect:'manual'`, typed error with transient classification) |
| CF steps | reuse `cloudflare.ts` primitives; **wire `cf_api_token`/`cf_account_id`/`worker_name` into `W/server/main.ts` env** with `worker_name` = ingress worker |
| Domain-list append | `updateSettings` with `expectedDomainsRevision`, retried on 409; idempotent if the domain is already present |
| Cron | new `step(...)` entries in `runScheduled` next to `hosted_domains.sync` (`scheduled.ts:166`); row-level CAS leases because there may be more than one replica |
| Admin API | `W/src/routes/admin/proxies.ts`, `admin/proxy-1024.ts`, `admin/spaceship.ts`, mounted in `app.ts` and described in `api-openapi.ts` |
| /v1 | `W/src/routes/v1/proxies.ts` (or under mailboxes), described in `v1/openapi.ts`, plus `skill.md`/references |
| Web | `Web/src/features/admin/proxies/*`, `.../spaceship/*` pages; `router.tsx` admin children; `ADMIN_NAV`; query keys; per-address proxy column on addresses page |
| Tests | `W/test/proxies.test.ts`, `spaceship.test.ts`, `proxy-1024.test.ts` (run on both engines); `S/test/*`; web page tests |
