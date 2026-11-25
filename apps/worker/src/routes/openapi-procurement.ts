import {
  DOMAIN_BATCH_STATUSES, DOMAIN_ITEM_STATUSES, DOMAIN_ITEM_STEPS, DOMAIN_SKIP_REASONS, MAX_PROXY_EXPORT_ROWS, MAX_PROXY_IMPORT_LINES,
  MAX_PROXY_LOOKUP_ADDRESSES, PROXY1024_PRODUCTS, PROXY_BINDING_SOURCES, PROXY_EXPORT_FORMATS, PROXY_HEALTH, PROXY_ORDER_STATUSES,
  PROXY_ORDER_WARNINGS, PROXY_PROTOCOLS, PROXY_SOURCES, PROXY_STATUSES,
  autoAssignRequestSchema, bindProxyRequestSchema, domainConfirmRequestSchema, domainItemResolveRequestSchema, domainQuoteRequestSchema,
  importProxiesRequestSchema, lookupBindingsRequestSchema, proxy1024ConfirmRequestSchema, proxy1024GenerateStickyRequestSchema,
  proxy1024LoginRequestSchema, proxy1024QuoteRequestSchema, proxy1024ResolveRequestSchema, proxy1024SyncRequestSchema,
  proxyHealthReportSchema, proxyInputSchema, registrantContactRequestSchema, updateProxyRequestSchema,
} from '@hpc-mail/shared';
import {
  array, bool, date, domainName, fromZod, int, nullable, object, okResult, operation, page, positiveId, query, ref, schemas, str,
  type Paths, type Schema,
} from './openapi-common.js';

/**
 * OpenAPI fragments for the proxy pool, mailbox ↔ proxy bindings, 1024proxy purchasing and Spaceship domain purchasing.
 * Importing this module registers its component schemas in the shared registry used by usedSchemas(); both
 * api-openapi.ts and v1/openapi.ts import it before building their documents.
 */
const cents = (description: string): Schema => ({ ...int, description: `${description} Integer US cents.` });
const enumOf = (values: readonly string[], description?: string): Schema => ({ type: 'string', enum: [...values], ...(description ? { description } : {}) });
const flag = (description: string): Schema => ({ type: 'string', enum: ['1', 'true', '0', 'false'], description });
const limit = (max: number, dflt: number) => query('limit', { type: 'integer', minimum: 1, maximum: max, default: dflt });
const cursor = query('cursor', { type: 'string', maxLength: 320 }, 'Opaque server nextCursor. Omit on first page; null means no next page.');
const address: Schema = { type: 'string', maxLength: 254, description: 'Full lowercase mailbox address local@domain.' };

const health = object({ status: enumOf(PROXY_HEALTH), checkedAt: nullable(date), latencyMs: nullable(int), error: str });
const proxyView = object({
  id: positiveId, label: str, provider: str, source: enumOf(PROXY_SOURCES), protocol: enumOf(PROXY_PROTOCOLS), host: str,
  port: { type: 'integer', minimum: 1, maximum: 65535 }, username: str,
  hasPassword: { ...bool, description: 'The password itself is never returned by list/detail; use reveal or the address lookup.' },
  product: str, country: str, region: str, city: str, providerRef: nullable(str), orderId: nullable(positiveId), expiresAt: nullable(date),
  status: enumOf(PROXY_STATUSES, 'expired is set by the scheduler once expiresAt has passed; disabled and expired proxies are never auto-assigned.'),
  maxBindings: positiveId, bindingCount: int, health: ref('ProxyHealth'), notes: str, createdAt: date, updatedAt: date,
});
const proxyCredential = object({
  proxyId: positiveId, protocol: enumOf(PROXY_PROTOCOLS), host: str, port: { type: 'integer', minimum: 1, maximum: 65535 },
  username: str, password: { ...str, description: 'Plaintext proxy password. Treat as a secret.' },
  url: { ...str, description: 'protocol://user:pass@host:port with percent-encoded userinfo (IPv6 hosts in brackets; no userinfo when both are empty). Ready for HTTP clients.' },
  country: str, city: str, product: str, status: enumOf(PROXY_STATUSES, 'Check before use: only active proxies are expected to work.'),
  expiresAt: nullable(date),
});
const bindingProxy = object({
  id: positiveId, label: str, provider: str, protocol: enumOf(PROXY_PROTOCOLS), host: str, port: int, username: str, country: str,
  status: enumOf(PROXY_STATUSES), expiresAt: nullable(date), health: ref('ProxyHealth'),
});

const proxyOrder = object({
  id: positiveId,
  status: enumOf(PROXY_ORDER_STATUSES, 'quoted: waiting for confirmation (expires at quoteExpiresAt); ordering: order call in flight; awaiting_payment: order created, pay it on the 1024proxy checkout page; paid/fulfilled: payment detected / proxies materialised; unknown: the order call outcome was lost and the order may exist — never retried automatically, resolve it by hand; failed: rejected by the vendor (no order); expired/cancelled/abandoned: closed.'),
  product: enumOf(PROXY1024_PRODUCTS), sku: str, quantity: positiveId, orderSpec: { ...str, description: 'JSON text of the quoted order lines.' },
  estimateCents: cents('Quoted amount; confirm must echo it as expectedCents.'),
  capBasisCents: cents('Undiscounted amount checked against the per-order and rolling 24-hour caps.'),
  actualCents: nullable(int), balanceCentsAtQuote: nullable(int), quoteExpiresAt: date, orderNo: nullable(str),
  checkoutUrl: { ...nullable(str), description: 'Administrator-only 1024proxy checkout link for paying the order from the account balance.' },
  lastError: str, materializedCount: int, createdBy: positiveId, confirmedBy: nullable(positiveId), confirmedAt: nullable(date),
  orderedAt: nullable(date), paidAt: nullable(date), checkedAt: nullable(date), createdAt: date, updatedAt: date,
  warnings: { ...array(enumOf(PROXY_ORDER_WARNINGS)),
    description: 'payment_manual: pay on the checkout page; maybe_charged: an order may exist at the vendor; actual_exceeds_estimate: the paid amount exceeds the estimate; checkout_url_unreadable: the stored checkout link cannot be decrypted (key changed).' },
});

const domainItem = object({
  id: positiveId, batchId: positiveId, domain: domainName,
  status: enumOf(DOMAIN_ITEM_STATUSES, 'Progress: confirmed → registering → registered → zone_created → ns_set → zone_active → routing_ready → domain_added (receiving mail). unknown means the registration outcome was lost: it is never registered again automatically.'),
  availability: str, skipReason: { ...str, description: `Empty unless status=skipped. Values: ${DOMAIN_SKIP_REASONS.join(', ')}.` },
  priceClass: str, finalCents: nullable(int), regularCents: nullable(int),
  capBasisCents: { ...nullable(int), description: 'max(final, regular) × years in US cents; confirm echoes the sum of the selected items.' },
  operationId: nullable(str), opStatus: str, nameServers: array(str), zoneStatus: str, routingStatus: str, lifecycleStatus: str,
  verificationStatus: str, suspensions: array(str),
  failedStep: { ...str, description: `Empty or one of ${DOMAIN_ITEM_STEPS.join(', ')}.` },
  lastError: str, errorCode: str, vendorOperationId: str,
  actions: { ...array(enumOf(['retry', 'resolve', 'refresh'])), description: 'Administrator actions currently allowed for this item.' },
  maybeCharged: { ...bool, description: 'Money may have been spent but the outcome is not known yet.' },
  registeredAt: nullable(date), readyAt: nullable(date), updatedAt: date,
});
const domainBatch = object({
  id: positiveId, status: enumOf(DOMAIN_BATCH_STATUSES), years: positiveId, autoRenew: bool, privacyLevel: enumOf(['public', 'high']),
  quoteTotalCents: int, confirmedTotalCents: int, quoteExpiresAt: date, lastError: str, createdBy: positiveId,
  confirmedBy: nullable(positiveId), confirmedAt: nullable(date), completedAt: nullable(date), createdAt: date,
  counts: { type: 'object', additionalProperties: int, description: 'Item count per item status.' },
  items: { ...array(ref('DomainPurchaseItem')), description: 'Present on GET /{id}, quote and confirm responses only.' },
}, ['items']);

Object.assign(schemas, {
  ProxyHealth: health,
  Proxy: proxyView,
  ProxyCredential: proxyCredential,
  ProxyBinding: object({ address, domain: domainName, proxyId: positiveId, source: enumOf(PROXY_BINDING_SOURCES), boundBy: int,
    createdAt: date, updatedAt: date, proxy: bindingProxy,
    ownerUserId: { ...nullable(positiveId), description: 'Current claimant; null for unclaimed addresses.' }, ownerUsername: nullable(str) }),
  ProxyBindingLookup: object({ items: array(object({ address, binding: nullable(ref('ProxyBinding')) })) }),
  ProxyImportResult: object({ created: int, duplicates: int, invalid: array(object({ line: positiveId, reason: str })), dryRun: bool }),
  ProxyAutoAssignResult: object({ assigned: array(object({ address, proxyId: positiveId })), unassigned: array(address), freeProxiesLeft: int, dryRun: bool }),
  ProxyExport: object({ format: enumOf(PROXY_EXPORT_FORMATS), count: int,
    content: { ...str, description: 'scope=bindings: one line per binding, address<TAB>proxy-line (json: array of {address, ...ProxyCredential}). scope=proxies: one proxy line per row (json: array of {id, label, provider, ...ProxyCredential}). Contains plaintext passwords.' } }),
  ProxyPoolStats: object({ total: int, active: int, expired: int, disabled: int, bound: int,
    free: { ...int, description: 'Active proxies with at least one free binding slot.' }, byProvider: { type: 'object', additionalProperties: int } }),
  V1ProxyLookup: object({ address, proxy: { ...nullable(ref('ProxyCredential')), description: 'null when no proxy is bound to this address.' } }),
  MyProxyBinding: object({ address, proxy: ref('ProxyCredential') }),
  ProxyInput: fromZod(proxyInputSchema),
  UpdateProxyRequest: { ...fromZod(updateProxyRequestSchema), description: 'Partial update; unsent fields keep their value. password ****** keeps the stored password, an empty string clears it.' },
  ImportProxiesRequest: { ...fromZod(importProxiesRequestSchema), description: `One proxy per line, at most ${MAX_PROXY_IMPORT_LINES} non-empty lines. Formats: url (http|https|socks5://[user[:pass]@]host:port), host_port_user_pass (host:port[:user:pass]), user_pass_at_host_port (user:pass@host:port); auto detects per line. Duplicate host:port:username lines are counted, not imported. dryRun validates without writing.` },
  ProxyHealthReport: fromZod(proxyHealthReportSchema),
  BindProxyRequest: fromZod(bindProxyRequestSchema),
  LookupBindingsRequest: fromZod(lookupBindingsRequestSchema),
  AutoAssignRequest: { ...fromZod(autoAssignRequestSchema), description: 'target=claimed binds free proxies to claimed addresses that have no binding (optionally one domain); target=addresses binds the listed addresses (may include unclaimed ones). Existing bindings are never replaced. dryRun returns the planned pairing without writing.' },
  Proxy1024Status: object({ enabled: bool, configured: { ...bool, description: 'A session token is stored. Email and password alone do not count.' },
    session: enumOf(['ok', 'missing', 'invalid', 'error', 'unknown']), email: str, balanceCents: nullable(int), checkedAt: nullable(date), lastError: str,
    caps: object({ maxOrderCents: int, maxDailyCents: int, spentLast24hCents: int }), purchasingAllowed: bool }),
  Proxy1024Captcha: object({ captchaId: str, masterImage: { ...str, description: 'data: URI' }, tileImage: { ...str, description: 'data: URI' },
    tileWidth: int, tileHeight: int, initialX: int, initialY: int }),
  Proxy1024Catalogue: object({ items: array(object({ product: enumOf(PROXY1024_PRODUCTS), sku: str, label: str, days: nullable(int),
    country: nullable(str), unitPriceCents: int, minQuantity: int, maxQuantity: int })), fetchedAt: date, source: { type: 'string', const: 'pricing_pages' } }),
  Proxy1024SubUsers: object({ items: array(object({ username: str, title: str, trafficBytes: nullable(int) })) }),
  Proxy1024SyncResult: object({ created: int, updated: int, expired: int }),
  ProxyOrder: proxyOrder,
  Proxy1024LoginRequest: fromZod(proxy1024LoginRequestSchema),
  Proxy1024QuoteRequest: fromZod(proxy1024QuoteRequestSchema),
  Proxy1024ConfirmRequest: { ...fromZod(proxy1024ConfirmRequestSchema), description: 'expectedCents must equal the order estimateCents shown to the administrator.' },
  Proxy1024ResolveRequest: fromZod(proxy1024ResolveRequestSchema),
  Proxy1024SyncRequest: fromZod(proxy1024SyncRequestSchema),
  Proxy1024GenerateStickyRequest: fromZod(proxy1024GenerateStickyRequestSchema),
  DomainPurchaseItem: domainItem,
  DomainPurchaseBatch: domainBatch,
  DomainPurchaseStatus: object({ enabled: bool, configured: { ...bool, description: 'API key, API secret and registrant contact id are all set.' },
    cloudflareConfigured: bool, ingressWorker: { ...nullable(str), description: 'Email Worker that new catch-all rules target.' },
    ingressWorkerSource: nullable(enumOf(['setting', 'env'])),
    caps: object({ maxDomainCents: int, maxBatchCents: int, maxDailyCents: int, maxBatchDomains: int, spentLast24hCents: int }),
    systemDomains: object({ used: int, inFlight: int, max: int }), purchasingAllowed: bool,
    reasons: { ...array(str), description: 'Why purchasing is not allowed right now (administrator-facing text).' } }),
  SpaceshipCredentialTest: object({ ok: { type: 'boolean', const: true }, domainCount: int }),
  DomainQuoteRequest: { ...fromZod(domainQuoteRequestSchema), description: 'Pasted text (split on whitespace, commas and semicolons) or an array. Names are converted to lowercase A-labels and de-duplicated; listed, hosted, historical and in-flight domains are skipped before Spaceship is asked.' },
  DomainConfirmRequest: { ...fromZod(domainConfirmRequestSchema), description: 'domains is the subset of quoted items to buy; expectedTotalCents must equal the sum of their capBasisCents. Availability and price are re-checked; any change returns 409 with refreshed prices.' },
  DomainItemResolveRequest: fromZod(domainItemResolveRequestSchema),
  RegistrantContactRequest: fromZod(registrantContactRequestSchema),
} satisfies Record<string, Schema>);

const admin = { role: 'admin' as const, vendorErrors: true };

/** /api routes (JWT). Administrator routes plus the caller's own proxies. */
export function sessionProcurementPaths(): Paths {
  const proxyFilters = [cursor, limit(200, 50), query('q', { type: 'string', maxLength: 200 }, 'Substring of label, host, username, provider reference or notes.'),
    query('status', enumOf(PROXY_STATUSES)), query('provider', { type: 'string', maxLength: 64 }), query('country', { type: 'string', pattern: '^[A-Za-z]{2}$' }),
    query('bound', enumOf(['yes', 'no'])), query('orderId', positiveId)];
  return {
    '/proxies/mine': { get: operation('List proxies bound to my claimed addresses', object({ items: array(ref('MyProxyBinding')) }), {
      description: 'Addresses the caller has claimed (at most 500). Mailboxes shared with the caller do not include proxy credentials. Contains plaintext proxy passwords.' }) },
    '/admin/proxies': {
      get: operation('List proxy inventory', page(ref('Proxy')), { ...admin, parameters: proxyFilters }),
      post: operation('Add a proxy', ref('Proxy'), { ...admin, request: 'ProxyInput', status: 201,
        description: 'Any provider. The password is stored encrypted. A duplicate host:port:username returns 409.' }),
    },
    '/admin/proxies/stats': { get: operation('Proxy pool statistics', ref('ProxyPoolStats'), admin) },
    '/admin/proxies/import': { post: operation('Bulk import proxies', ref('ProxyImportResult'), { ...admin, request: 'ImportProxiesRequest' }) },
    '/admin/proxies/export': { get: operation('Export proxies or address bindings', ref('ProxyExport'), { ...admin,
      parameters: [query('format', enumOf(PROXY_EXPORT_FORMATS)), query('scope', enumOf(['bindings', 'proxies'])), query('domain', str), query('status', enumOf(PROXY_STATUSES))],
      description: `6 per minute per administrator; audited. More than ${MAX_PROXY_EXPORT_ROWS} rows returns 400 (narrow with domain/status) rather than a truncated file. Contains plaintext passwords.` }) },
    '/admin/proxies/auto-assign': { post: operation('Assign free proxies to unbound addresses', ref('ProxyAutoAssignResult'), { ...admin, request: 'AutoAssignRequest',
      description: '10 per minute per administrator. A manual binding made concurrently wins over the automatic one.' }) },
    '/admin/proxies/bindings': { get: operation('List address ↔ proxy bindings', page(ref('ProxyBinding')), { ...admin,
      parameters: [cursor, limit(200, 50), query('domain', str), query('q', { type: 'string', maxLength: 254 }, 'Address substring.'), query('proxyId', positiveId)] }) },
    '/admin/proxies/bindings/lookup': { post: operation('Look up bindings for a list of addresses', ref('ProxyBindingLookup'), { ...admin, request: 'LookupBindingsRequest',
      description: `1–${MAX_PROXY_LOOKUP_ADDRESSES} addresses; one item per requested address, binding null when unbound.` }) },
    '/admin/proxies/bindings/{address}': {
      put: operation('Bind an address to a proxy', ref('ProxyBinding'), { ...admin, request: 'BindProxyRequest',
        description: 'address is URL-encoded and may be unclaimed. Replaces an existing binding of this address. Refused (409) when the proxy is disabled/expired or already has maxBindings addresses.' }),
      delete: operation('Unbind an address', okResult, admin),
    },
    '/admin/proxies/{id}': {
      get: operation('Read a proxy', ref('Proxy'), admin),
      put: operation('Update a proxy', ref('Proxy'), { ...admin, request: 'UpdateProxyRequest' }),
      delete: operation('Delete a proxy', okResult, { ...admin, parameters: [query('force', flag('Required (1) when the proxy still has bindings; the bindings are removed with it. Without it a bound proxy returns 409.'))] }),
    },
    '/admin/proxies/{id}/reveal': { post: operation('Reveal proxy credentials', ref('ProxyCredential'), { ...admin,
      description: '30 per minute per administrator; audited without the password. Response is not cacheable.' }) },
    '/admin/proxies/{id}/health': { post: operation('Report proxy health from automation', ref('Proxy'), { ...admin, request: 'ProxyHealthReport',
      description: 'The server never probes proxies itself; automation reports results here.' }) },

    '/admin/proxy-1024/status': { get: operation('1024proxy integration status', ref('Proxy1024Status'), { ...admin,
      parameters: [query('live', flag('1 re-checks the session and balance at 1024proxy (6 per minute). Default reads the stored state.'))] }) },
    '/admin/proxy-1024/login/captcha': { post: operation('Start an email/password login (slide captcha)', ref('Proxy1024Captcha'), { ...admin,
      description: 'Uses the stored proxy1024.email and password. A human drags the tile; submit the position to /login. 6 per minute shared with /login.' }) },
    '/admin/proxy-1024/login': { post: operation('Complete the login with the captcha position', ref('Proxy1024Status'), { ...admin, request: 'Proxy1024LoginRequest',
      description: 'On success the new session token is stored encrypted. If 1024proxy demands an image captcha, log in once on the 1024proxy website first.' }) },
    '/admin/proxy-1024/catalogue': { get: operation('Read the 1024proxy product catalogue', ref('Proxy1024Catalogue'), { ...admin,
      description: 'Parsed from the public pricing pages; unit prices exclude volume discounts.' }) },
    '/admin/proxy-1024/sub-users': { get: operation('List 1024proxy sub-users', ref('Proxy1024SubUsers'), admin) },
    '/admin/proxy-1024/quotes': { post: operation('Quote a 1024proxy order', ref('ProxyOrder'), { ...admin, request: 'Proxy1024QuoteRequest', status: 201,
      description: 'Creates a quoted order (no vendor order yet). Caps of 0 mean purchasing is off (503 not_configured); amounts over the per-order cap return 400. 10 per minute.' }) },
    '/admin/proxy-1024/orders': { get: operation('List 1024proxy orders', page(ref('ProxyOrder')), { ...admin,
      parameters: [query('cursor', { type: 'string', maxLength: 64 }), limit(200, 50), query('status', enumOf(PROXY_ORDER_STATUSES))] }) },
    '/admin/proxy-1024/orders/{id}': { get: operation('Read a 1024proxy order', ref('ProxyOrder'), admin) },
    '/admin/proxy-1024/orders/{id}/confirm': { post: operation('Confirm a quote and place the order', ref('ProxyOrder'), { ...admin, request: 'Proxy1024ConfirmRequest',
      description: 'Re-reads price and balance and enforces the per-order and rolling 24-hour caps atomically. Price rise, low balance, expired quote or echo mismatch return 409 without ordering. The order call runs at most once; a lost outcome leaves status unknown and is never retried. Payment is completed by the administrator on checkoutUrl. 5 per minute.' }) },
    '/admin/proxy-1024/orders/{id}/cancel': { post: operation('Cancel a quoted order', ref('ProxyOrder'), admin) },
    '/admin/proxy-1024/orders/{id}/refresh': { post: operation('Re-check payment of an order', ref('ProxyOrder'), { ...admin, description: 'Read-only vendor checks; never places an order. 10 per minute.' }) },
    '/admin/proxy-1024/orders/{id}/resolve': { post: operation('Resolve an unknown or unpaid order by hand', ref('ProxyOrder'), { ...admin, request: 'Proxy1024ResolveRequest',
      description: 'abandon closes an unknown or awaiting_payment order; attach_order_no records (or replaces an unconfirmed) vendor order number found in the 1024proxy console so payment reconciliation can match it; mark_fulfilled closes a paid order whose proxies were checked in the inventory by hand. None of them places an order.' }) },
    '/admin/proxy-1024/orders/{id}/allocate': { post: operation('Allocate IPs for a paid static ISP order', ref('Proxy1024SyncResult'), { ...admin,
      description: 'Allowed once per order; follow up with /sync. 3 per minute.' }) },
    '/admin/proxy-1024/sync': { post: operation('Sync purchased 1024proxy proxies into the inventory', ref('Proxy1024SyncResult'), { ...admin, request: 'Proxy1024SyncRequest',
      description: 'Idempotent; never takes over a manually entered proxy with the same endpoint. 3 per minute.' }) },
    '/admin/proxy-1024/generate-sticky': { post: operation('Generate sticky residential proxies', object({ created: int }), { ...admin, request: 'Proxy1024GenerateStickyRequest', status: 201,
      description: 'Adds sticky-session proxies for an existing sub-user to the inventory; no purchase.' }) },

    '/admin/domain-purchases': { get: operation('List domain purchase batches', page(ref('DomainPurchaseBatch')), { ...admin,
      parameters: [query('cursor', { type: 'string', maxLength: 64 }), limit(200, 50), query('status', enumOf(DOMAIN_BATCH_STATUSES))],
      description: 'Batches without items.' }) },
    '/admin/domain-purchases/status': { get: operation('Domain purchasing status', ref('DomainPurchaseStatus'), admin) },
    '/admin/domain-purchases/test-credentials': { post: operation('Test the Spaceship API credentials', ref('SpaceshipCredentialTest'), { ...admin,
      description: 'Read-only call listing the account domains. 6 per minute.' }) },
    '/admin/domain-purchases/contact': { post: operation('Save the registrant contact at Spaceship', object({ contactId: str }), { ...admin, request: 'RegistrantContactRequest',
      description: 'Creates the contact and stores its id in spaceship.registrantContactId. 3 per minute.' }) },
    '/admin/domain-purchases/quotes': { post: operation('Quote a list of domains', ref('DomainPurchaseBatch'), { ...admin, request: 'DomainQuoteRequest', status: 201,
      description: 'Checks availability and price at Spaceship (20 names per request) and creates a quoted batch with items. Nothing is bought. 10 per minute.' }) },
    '/admin/domain-purchases/items/{itemId}/retry': { post: operation('Retry a failed post-registration step', ref('DomainPurchaseItem'), { ...admin,
      description: 'Only for failures after registration (zone, nameservers, routing, catch-all, domain list). Never re-registers a domain.' }) },
    '/admin/domain-purchases/items/{itemId}/resolve': { post: operation('Resolve an unknown registration', ref('DomainPurchaseItem'), { ...admin, request: 'DomainItemResolveRequest',
      description: 'Requires live proof from Spaceship that matches the chosen action.' }) },
    '/admin/domain-purchases/items/{itemId}/refresh': { post: operation('Advance one item now', ref('DomainPurchaseItem'), { ...admin,
      description: 'Runs the next safe step immediately (at most once a minute per item); never registers. 10 per minute.' }) },
    '/admin/domain-purchases/{id}': { get: operation('Read a domain purchase batch with items', ref('DomainPurchaseBatch'), admin) },
    '/admin/domain-purchases/{id}/confirm': { post: operation('Confirm and buy selected domains', ref('DomainPurchaseBatch'), { ...admin, request: 'DomainConfirmRequest',
      description: 'Re-checks availability and price, then enforces per-domain, per-batch, rolling 24-hour and system-domain-slot caps atomically. Registration, Cloudflare zone, nameservers, Email Routing catch-all to the ingress worker and adding to the system domain list then run in the scheduler. 5 per minute.' }) },
    '/admin/domain-purchases/{id}/cancel': { post: operation('Cancel a quoted batch', ref('DomainPurchaseBatch'), admin) },
  };
}

/** /v1 routes (API key, scope proxy.read). */
export function v1ProxyPaths(): Paths {
  const scope = 'proxy.read';
  return {
    '/proxies': { get: operation('List proxies bound to addresses', page(ref('MyProxyBinding')), { scope,
      parameters: [cursor, limit(200, 50), query('all', flag('Administrator keys only: 1 lists every binding on the site; ordinary keys get 403.')), query('domain', str)],
      description: 'Default lists bindings of addresses the key owner has claimed, ordered by address. Shared-with-me mailboxes are not included. Contains plaintext proxy passwords.' }) },
    '/proxies/lookup': { get: operation('Get the proxy bound to one address', ref('V1ProxyLookup'), { scope,
      parameters: [query('address', address, undefined, true)],
      description: 'Ordinary keys may look up only addresses their owner has claimed; any other address returns 404 (existence is not revealed). Administrator keys may look up any address. proxy is null when nothing is bound. Use proxy.url directly as an HTTP/SOCKS proxy URL and check proxy.status is active.' }) },
  };
}
