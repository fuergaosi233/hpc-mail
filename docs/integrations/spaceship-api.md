# Spaceship API — spec for the HPC Mail bulk domain purchase flow

Source: https://docs.spaceship.dev/ (a Redoc page). The full OpenAPI 3.0.0 document is embedded in the page as
`__redoc_state.spec.data` (`info.version` = `1.0.0`). Retrieved 2026-11-25. sha256 of the extracted JSON:
`38ac5f7445b3377b665489d052e7df0444fd09d0aa80aeba164e5a43e8ffce4e`.
To refresh it, download the page, then `JSON.parse` the object after `__redoc_state =` and read `.spec.data`.

Everything under "Verbatim" comes straight from the spec, including field names, enums, limits and descriptions.
Sections marked **Not in the REST spec** are inference or secondary sources. Treat them as unknown until we
verify them against a real account. No authenticated call was made while this was written.

---

## 0. TL;DR for the implementer

| Step | Endpoint | Scope | Rate limit (verbatim) |
|---|---|---|---|
| Availability (bulk) | `POST /v1/domains/available` | `domains:read` | 30 req / user / 30 s |
| Price (bulk) | `POST /v1/domains/pricing/query` | `domains:read` | 30 req / user / 30 s **and** 25 req / user / 5 s across all pricing ops |
| Create contact | `PUT /v1/contacts` | `contacts:write` | 300 req / user / 300 s |
| Register | `POST /v1/domains/{domain}` → **202** + `spaceship-async-operationid` | `domains:billing` | 30 req / user / 30 s |
| Poll | `GET /v1/async-operations/{operationId}` | `asyncoperations:read` | **60 req / user / 300 s** (tight) |
| Domain info | `GET /v1/domains/{domain}` | `domains:read` | **5 req / domain / 300 s** |
| Domain list (reconcile) | `GET /v1/domains?take=100&skip=N` | `domains:read` | 300 req / user / 300 s |
| Set NS | `PUT /v1/domains/{domain}/nameservers` | `domains:write` | **5 req / domain / 300 s** |

- Base URL: `https://spaceship.dev/api`. Paths start with `/v1/...`.
- Auth headers: `X-API-Key` + `X-API-Secret`. Header names are case-insensitive; the security scheme uses
  `X-API-Key`/`X-API-Secret`, and the prose uses `X-Api-Key`/`X-Api-Secret`.
- Errors use `application/problem+json` `{ "detail": string }`. A 422 adds `data: [{field, details}]`. Every error
  carries the headers `spaceship-error-code` (pattern `^(business|application|infrastructure)(\.[a-zA-Z]+)+$`) and
  `spaceship-operation-id` (16 chars `[a-z0-9]`).
- 429 adds `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and `Retry-After` (seconds).
- All prices are USD decimal **strings** (`"5.98"`). The availability endpoint's `premiumPricing` is **deprecated**,
  so use `POST /v1/domains/pricing/query` (`priceClass` = `standard` | `premium`).
- Registration body requires `autoRenew`, `years` (1–10), `privacyProtection {level: public|high, userConsent}`,
  and `contacts {registrant (required), admin, tech, billing, attributes[]}` (contact IDs, 27–32 chars).
- **The spec has no idempotency key, no account-balance endpoint, and no payment-method field on registration.**
  See §10 and §11.

---

## 1. Authentication (verbatim)

> Spaceship API uses a combination of API key and API secret for authentication.
>
> You can generate your API key and secret in [API Manager](https://www.spaceship.com/application/api-manager/).
> Use the "New API key" button to set up a new API key and follow the guide to get started.
>
> As shown in the example below, API consumers shall pass a valid API key and a corresponding API secret in the
> X-API-Secret headers. You do not need to encode the API key and the API secret.

```bash
curl -X GET '/api/resource' \
-H 'X-Api-Secret: <secret>' \
-H 'X-Api-Key: <key>'
```

`components.securitySchemes`:

```json
"apiKey":    { "type": "apiKey", "in": "header", "name": "X-API-Key",
               "description": "API key for authenticating requests, with a set of scopes (permissions) defined by the user at the time of creation." },
"apiSecret": { "type": "apiKey", "in": "header", "name": "X-API-Secret",
               "description": "API secret for authenticating requests must be set together with the API key." }
```

`servers: [{ "url": "https://spaceship.dev/api", "description": "The main server for the Spaceship External API" }]`

### Scopes (permissions), verbatim

- `domains:read`: Read domain information, check configuration, and read supported TLDs, TLD prices and domain prices
- `domains:write`: Manage domains and domain settings
- `domains:transfer`: Transfer domains in and out
- `domains:billing`: Manage domains billing operations
- `contacts:write`: Save contact details
- `contacts:read`: Read contact details
- `dnsrecords:write` / `dnsrecords:read`: Write / read DNS resource records
- `asyncoperations:read`: Read async operations details
- (sellerhub / hyperlift scopes are irrelevant here)

**Minimum key scopes for our flow:** `domains:read`, `domains:write`, `domains:billing`, `contacts:read`,
`contacts:write`, `asyncoperations:read`. A key without `domains:billing` gets 403 on registration. That is a safe
way to run read-only quoting.

---

## 2. Error format (verbatim, identical on every operation)

Every operation we use declares the status codes `400, 401, 403, 404, 422, 429, 500`. The success code is 200,
202 or 204, depending on the operation.

| Status | Description (verbatim) | Body schema |
|---|---|---|
| 400 | The request is invalid. | `ErrorDetail` |
| 401 | The user's request was not authorized properly. | `UnauthorizedError` |
| 403 | The user's request not allowed to perform this action with the current scopes. | `ForbiddenError` |
| 404 | The requested object was not found. | `ObjectNotFoundError` |
| 422 | The entity is unprocessable. | `ValidationError` |
| 429 | The response indicates that the rate limit for the API has been exceeded. It includes details about the rate limit, like the number of requests left and the time the rate limit window resets. | `RateLimitError` |
| 500 | The infrastructure encountered an error. | `UnexpectedError` |

Content type: `application/problem+json`.

```jsonc
// ErrorDetail / UnauthorizedError / ForbiddenError / ObjectNotFoundError / RateLimitError / UnexpectedError
{ "detail": "string" }               // required; "A general message about the exception"

// ValidationError (422)
{
  "detail": "string",                // required
  "data": [                          // required; "A detailed list of validation errors"
    { "field": "name",               // "The path to the field that caused the validation error"
      "details": "The domain name contains invalid characters" }  // "A specific message about what is wrong with the field"
  ]
}
```

Headers present on **every** error response (both `required: true`):

- `spaceship-error-code`: string, maxLength 255, pattern `^(business|application|infrastructure)(\.[a-zA-Z]+)+$`.
  "The dot-separated error code indicating the type of the problem occurred"
- `spaceship-operation-id`: string, pattern `^[a-z0-9]{16}$`. "16-characters unique identifier of the operation".
  Log this with every failure; support needs it.

The spec does **not** list concrete `spaceship-error-code` values. One code is reported only by a secondary source
(see §11): `infrastructure.outcomeUnknown`.

---

## 3. Rate limits (verbatim)

### 3.1 Rate limits for our endpoints

Every operation's description has a "Rate Limits" section. These are the ones relevant to us:

| Operation | Limit text (verbatim) |
|---|---|
| `POST /v1/domains/available` | The limit to check domains availability is 30 requests per user, within 30 seconds. |
| `GET /v1/domains/{domain}/available` | The limit to check domain availability is 5 requests per domain, within 300 seconds. / The limit to check domain availability is 30 requests per user, within 30 seconds. |
| `POST /v1/domains/pricing/query` | The limit to get domains prices is 30 requests per user, within 30 seconds. / The limit to get prices is 25 requests per user, within 5 seconds, across all pricing operations. |
| `GET /v1/domains/{domain}/pricing` | The limit to get domain prices is 5 requests per domain, within 300 seconds. / ...30 requests per user, within 30 seconds. / ...25 requests per user, within 5 seconds, across all pricing operations. |
| `POST /v1/tlds/pricing/query` | The limit to get prices is 25 requests per user, within 5 seconds, across all pricing operations. |
| `GET /v1/tlds/{tld}/pricing` | The limit to get TLD prices is 5 requests per TLD, within 300 seconds. (+ the 25/5 s pricing limit) |
| `GET /v1/tlds` | The limit for fetching a TLD list is 300 requests per user, within 300 seconds. |
| `POST /v1/domains/{domain}` | The limit to register domains is 30 requests per user, within 30 seconds. |
| `GET /v1/async-operations/{operationId}` | The limit for fetching async operation details is 60 requests per user, within 300 seconds. |
| `GET /v1/domains/{domain}` | The limit for obtaining info for a domain is 5 requests per domain, within 300 seconds. |
| `GET /v1/domains` | The limit for fetching a domain list is 300 requests per user, within 300 seconds. |
| `PUT /v1/domains/{domain}/nameservers` | The limit for updating nameservers for a domain is 5 requests per domain, within 300 seconds. |
| `PUT /v1/domains/{domain}/autorenew` | The limit for updating the autorenewal state for a domain is 5 requests per domain, within 300 seconds. |
| `PUT /v1/domains/{domain}/privacy/preference` | The limit for updating the privacy preference for a domain is 5 requests per domain, within 300 seconds. |
| `PUT /v1/contacts` | The limit for saving contact details is 300 requests per user, within 300 seconds. |
| `GET /v1/contacts/{contact}` | The limit for listing contact details is 5 requests per contact, within 300 seconds. |

### 3.2 429 response headers (verbatim, all `required: true`)

- `X-RateLimit-Limit` (int32 ≥ 1): "Request limit per the allotted time window"
- `X-RateLimit-Remaining` (int32 ≥ 0): "The number of requests left for the time window"
- `X-RateLimit-Reset` (int32 ≥ 1): "The UTC date/time when the current rate limit window resets". The type is an
  integer, presumably epoch seconds; this is unverified.
- `Retry-After` (int32 ≥ 1): "The number of seconds inndicating how long the client ought to wait before making a
  follow-up request"

### 3.3 Implications for the cron-driven state machine

- **Async-op polling allows 60 requests per 300 s for the whole account (one shared bucket).** A batch of 20
  pending registrations polled every 5-minute cron tick uses 20 of the 60. Do not poll in tight loops. Poll each
  pending op at most once per tick, and back off on 429 using `Retry-After`. For bulk reconciliation, prefer
  `GET /v1/domains` (300/300 s, 100 items per page).
- **Domain info and NS updates allow 5 requests per domain per 300 s.** Each cron tick should touch a domain at most
  once per endpoint.
- Treat 429 as "try later". It never means the outcome is unknown, because a 429 means the request was rejected
  before it was processed.

---

## 4. Asynchronous operations (verbatim)

> Some API operations may take an extended period to complete. For these long-running operations, the API returns
> an HTTP 202 Accepted response with a `spaceship-async-operationid` header containing a unique operation
> identifier.
>
> 1. **Initiate Operation**: When you make a request that requires asynchronous processing (e.g., domain
>    registration, transfer operations), the API immediately returns a 202 response.
> 2. **Receive Operation ID**: The response includes the `spaceship-async-operationid` header with a unique
>    identifier for tracking the operation.
> 3. **Poll for Status**: Use the operation ID to poll the `/v1/async-operations/{operationId}` endpoint to check
>    the current status of your operation.
> 4. **Operation States**: `pending` - The operation is still in progress; `success` - The operation completed
>    successfully; `failed` - The operation encountered an error and could not complete

### `GET /v1/async-operations/{operationId}`: `getAsyncOperationDetails`

> Retrieves the details of an async operation, including its status and any associated details. This operation is
> essential for tracking the progress and outcome of async operations, providing users with the necessary
> information to manage their requests effectively.

- Path `operationId`: string, maxLength 36. "Unique ID of async operation"
- Scope `asyncoperations:read`. Rate limit 60 / user / 300 s.
- 200 body:

```jsonc
{
  "status": "pending" | "failed" | "success",  // required. "The status of the async operation."
  "type": "domains_Create",                     // required, string 1..255
  "details": { },                               // optional, free-form object. "Any detail attached to the async operation resource."
  "createdAt": "2100-01-01T00:00:00.000Z",      // required, ISO-8601, maxLength 27
  "modifiedAt": "2100-01-01T00:00:00.000Z"      // optional
}
```

The spec gives no schema or example for `details`, including on failure. Store it raw (JSON) and show it to the
admin.

The 202 header on registration is `spaceship-async-operationid`, required, pattern `^[a-zA-Z0-9]+$`, maxLength 36.
This is **different** from the per-request `spaceship-operation-id` (16 chars) that comes back on errors.

---

## 5. Bulk availability: `POST /v1/domains/available` (`checkDomainsAvailability`)

Scope `domains:read`. Rate limit 30 / user / 30 s.

Request (`application/json`, required):

```jsonc
{
  "domains": ["spaceship.dev"]  // required; array minItems 1, maxItems 20
  // items: string, format "domain", minLength 4, maxLength 255.
  // "List of domain names in ASCII format (A-label) whose details are to be fetched. The domain name must be
  //  provided in a fully qualified domain format."
}
```

200 response:

```jsonc
{
  "domains": [                           // required
    {
      "domain": "spaceship.dev",         // required
      "result": "available",             // required, enum below
      "premiumPricing": [                // required, DEPRECATED
        { "operation": "register" | "transfer" | "renew" | "restore",  // required
          "price": 10.99,                // required, number format "decimal"
          "currency": "USD" }            // required, ISO 4217; "Currently only USD is supported."
      ]
    }
  ]
}
```

`result` enum (verbatim):

- `available`: The domain is available for registration.
- `taken`: Domain is already taken and available for transfer.
- `invalidDomainName`: Domain name is invalid.
- `tldNotSupported`: Specified TLD is not supported.
- `unexpectedError`: An error occurred while checking domain availability. The system was unable to determine the
  domain's status due to a technical issue.

`premiumPricing` is described as "Premium prices of the domain. **Deprecated:** Use Get single domain prices or
Query domains prices instead." Our quotes must use §6. Read `premiumPricing` only as a cross-check, if at all.

Notes:

- Send A-labels (punycode). Normalize IDNs to lowercase A-labels on our side before quoting.
- A batch of more than 20 names is a 400/422. Chunk the batch into groups of at most 20.
- The response includes one item per requested domain. The spec doesn't say whether the items come back in request
  order (the pricing query does promise request order), so match items by `domain`.
- A single-domain variant exists: `GET /v1/domains/{domain}/available`. It has the same item shape and limits of
  5 / domain / 300 s and 30 / user / 30 s.

---

## 6. Pricing

### 6.1 Domain prices: `POST /v1/domains/pricing/query` (`queryDomainsPricing`). Use this one.

Description (verbatim):

> Retrieves the prices of domain names. Prices are returned whether or not a domain is available. To check
> availability, use `POST /v1/domains/available`. A premium domain gets premium prices, and its `priceClass` is
> `premium`. Prices include the automatic promotions the account is eligible for. Promotion codes are not applied.
> Each item has either `prices` or, when the domain has no prices, `errorCode`.
>
> **Important:** Some promotions can be used only a limited number of times, in total or per account. After the
> limit is reached, the promotion does not apply, and the price can be more than `finalPrice`.
>
> **Important:** An operation, such as `transfer`, is missing from `prices` when the TLD does not support it or
> when the operation is temporarily restricted.

Scope `domains:read`. Rate limits: 30 / user / 30 s and 25 / user / 5 s across all pricing ops.

Request: `{ "domains": ["mine.com", "rare.io", "shop.example"] }`. Array of 1–20 items; each item is a string of
4–255 chars in A-label FQDN form.

200 response ("Prices per domain name, in request order."). Each item is `oneOf`:

```jsonc
// DomainPrice
{
  "domain": "mine.com",            // required
  "priceClass": "standard",        // required; "standard" | "premium" | <unknown string ≤32>
                                   // "More values can be added later. A client must accept a value it does not know."
  "prices": {                      // required; per operation, each an array (minItems 1), at most one item per period
    "register": [
      { "period": { "value": 1, "unit": "y" },   // period optional ("not set for an operation that has no period");
                                                 // unit "y" | "m" | unknown (≤16) — "A client must ignore a price whose unit it does not know."
        "priceInDefaultCurrency": {              // required; "Prices in the default currency, which is the same for all accounts. Currently it is USD."
          "finalPrice":   { "amount": "5.98",  "currency": "USD" },  // required; "Price with the promotions applied."
          "regularPrice": { "amount": "10.98", "currency": "USD" }   // required; "Price without promotions."
        } }
    ],
    "transfer": [ ... ], "renew": [ ... ]
    // additionalProperties: "Prices of another domain operation" — "A client must ignore an operation it does not know."
  }
}
// DomainPriceError
{ "domain": "shop.example", "errorCode": "tldNotSupported" }
// errorCode: "invalidDomainName" | "tldNotSupported" | "unexpectedError" | <unknown ≤64>
```

`amount` is a string, maxLength 20: "Amount as string to preserve precision". Parse it as a decimal and store integer
micro- or cents. Do not use float.

`PricePair` description (verbatim), which matters for the caps:

> A final price and a regular price in one currency. The prices are for reference only. The checkout shows the
> price that is charged.
>
> `finalPrice` includes the promotions; `regularPrice` does not. A promotion is active when `finalPrice` is lower
> than `regularPrice`. Both prices include all fees, for example the ICANN fee. An amount of zero means that the
> operation is free.

Spec example: `rare.io` → `priceClass: "premium"`, register 1y final/regular `"999.99"` USD.

**Quote rule for us:**

- Unit price = `prices.register[]` item with `period = {value: years, unit: "y"}`, using `finalPrice.amount`.
- Enforce caps against **`max(finalPrice, regularPrice)`**. The spec says limited-use promotions can lapse, in which
  case "the price can be more than `finalPrice`". It also says prices are "for reference only".
- If no `register` item matches the requested period, the domain cannot be quoted. Neither can a domain that
  returns `errorCode`.
- Policy decision: by default, reject `priceClass !== "standard"`, or require explicit opt-in. Premium domains can be
  extremely expensive.

### 6.2 Other pricing endpoints

- `POST /v1/domains/pricing`: `getDomainsPricing`. **Deprecated** ("Use Query domains prices instead"). Same body
  and limits.
- `GET /v1/domains/{domain}/pricing`: `getSingleDomainPricing`. Same item shape. Limits: 5 / domain / 300 s, plus
  30 / user / 30 s, plus 25 / user / 5 s.
- `POST /v1/tlds/pricing/query`: `queryTldsPricing`. Body `{ "tlds": ["com", "co.uk"] }` (1–25 items, no leading
  dot, A-label). Response `{ tlds: [ {tld, prices} | {tld, errorCode: "tldNotSupported"|"unexpectedError"|...} ] }`.
  "The prices of a TLD are for one non-premium domain in that TLD." Limit 25 / user / 5 s (shared pricing bucket).
- `GET /v1/tlds/{tld}/pricing`: single TLD. Limit 5 / TLD / 300 s (plus the shared bucket).
- `GET /v1/tlds/pricing?take=1..25&skip=N`: `{ items: [{tld, prices}], total }`, sorted by `tld`.
- `GET /v1/tlds?take=1..100&skip=N`: `{ items: [{name}], total }`, the list of supported TLDs. Limit 300 / user / 300 s.

Currency: all endpoints are USD. "Currently only USD is supported" (availability). "Prices in the default currency,
which is the same for all accounts. Currently it is `USD`" (pricing).

---

## 7. Contacts

The spec has **no list-contacts endpoint**. There are two ways to get contact IDs:

1. `PUT /v1/contacts` returns `contactId`, "generated, if contact was created, or existing contact's one". That
   means the call is effectively an upsert or dedupe on identical details, so it is safe to call again.
2. `GET /v1/domains/{domain}` (or `GET /v1/domains` items) → `contacts.registrant/admin/tech/billing`, which gives
   the IDs on an existing domain.

### `PUT /v1/contacts`: `saveDetails`

> Save details for the contact and return the generated contact ID.
>
> > Validation rules for some parameters (such as `stateProvince` and `postalCode`) depend on the selected country.
> > These fields may be required based on the country's validation logic

Scope `contacts:write`. Rate limit 300 / user / 300 s.

```jsonc
{
  "firstName": "John",              // required, 1..125
  "lastName": "Doe",                // required, 1..125
  "organization": "My Company",     // optional, ≤255
  "email": "admin@example.com",     // required, format email, 3..255
  "address1": "286 King St.",       // required, ≤255
  "address2": "",                   // optional, ≤255
  "city": "San Francisco",          // required, ≤255
  "country": "US",                  // required, ISO 3166-1 alpha-2
  "stateProvince": "CA",            // optional (country-dependent), ≤255
  "postalCode": "94107",            // optional (country-dependent), ≤16
  "phone": "+1.123456789",          // required, 7..17 — note the "+CC.NUMBER" format
  "phoneExt": "256",                // optional, ≤7
  "fax": "+1.123456789",            // optional, 7..17
  "faxExt": "256",                  // optional, ≤7
  "taxNumber": "123456789"          // optional, format "taxNumber", ≤255
}
```

The 200 response is `{ "contactId": "1ZdMXpapqp9sle5dl8BlppTJXAzf3" }` (27..32 chars).

### Other contact endpoints

- `GET /v1/contacts/{contact}` (`readDetails`): scope `contacts:read`, 5 / contact / 300 s. Returns the same
  object as above.
- `PUT /v1/contacts/attributes` (`saveContactAttributes`): body `{ "type": string(2..32), ... }` → `{ contactId }`.
  This is for TLD-specific extended attributes (`contacts.attributes`, at most 5). The spec models only `type`.
  Not needed for common gTLDs.
- `GET /v1/contacts/attributes/{contact}` (`readAttributeDetails`): 5 / attribute / 300 s.
- `PUT /v1/domains/{domain}/contacts` (`setDomainContacts`): changes the contacts of an existing domain. We don't
  need it.

**Recommendation for HPC Mail:** store one admin-configured default contact ID (`registrantContactId`, plus
optional admin/tech/billing) in settings. Alternatively, store the contact details and call `PUT /v1/contacts` once
to obtain the ID. Validate the ID with `GET /v1/contacts/{id}` when the admin saves the setting.

---

## 8. Domain registration: `POST /v1/domains/{domain}` (`domainCreate`)

> Register a specific domain.

Scope **`domains:billing`**. Rate limit: "The limit to register domains is 30 requests per user, within 30 seconds."

Path `domain`: string, format domain, 4..255. "The domain name for registration." (U-label or A-label accepted;
we send the A-label.)

Request body (`DomainCreateRequest`). Required fields: `autoRenew`, `years`, `privacyProtection`, `contacts`.

```jsonc
{
  "autoRenew": false,
  // boolean. "Specifies whether automatic renewal will be enabled for the domain after the registration. After
  // that, if autoRenew is set to true, the domain will be automatically renewed using the account's default
  // payment method upon each expiration"

  "years": 1,
  // int32, minimum 1, maximum 10. "Number of years to register the domain"

  "privacyProtection": {
    // "Privacy protection options. This parameter controls the visibility of your domain registrant contact
    // information in the public WHOIS database."
    "level": "high",        // required; enum "public" | "high"
    // "Indicates the level of privacy protection. Set this property to "high" to enable privacy protection and
    // hide your personal details, or to "public" to display your real contact information. When choosing the
    // "public" level, the "userConsent" property must be set to true to confirm your explicit consent for making
    // your contact information publicly available. Note: not all TLDs support "high" privacy protection level"
    "userConsent": true     // required; "Indicates whether the user consents to the Public privacy settings"
  },

  "contacts": {
    // "Domain contacts are specified using contact IDs. These contact IDs can be obtained from the "Get domain
    // info" endpoint (/domains) for an existing domain, or by creating new contacts through the "Save contact
    // details" endpoint (/contacts). ... These contacts will be associated with the domain during registration."
    "registrant": "1ZdMXpapqp9sle5dl8BlppTJXAzf5",   // REQUIRED, contact ID 27..32
    "admin":      "1ZdMXpapqp9sle5dl8BlppTJXAzf6",   // optional
    "tech":       "1ZdMXpapqp9sle5dl8BlppTJXAzf5",   // optional
    "billing":    "1ZdMXpapqp9sle5dl8BlppTJXAzf5",   // optional
    "attributes": ["1ZdMXpapqp9sle5dl8BlppTJXAzf8"]  // optional, maxItems 5 — "List of extended attribute contact point IDs"
  }
}
```

The body has **no** field for: nameservers (so set them after registration), price or max-price, currency,
payment method, promo code, or idempotency key.

Responses:

- **202**: "Async operation was created as a result of request processing." Header `spaceship-async-operationid`
  (required, `^[a-zA-Z0-9]+$`, ≤36). The spec defines no response body.
- 400 / 401 / 403 / 404 / 422 / 429 / 500 follow §2.

Poll the operation (§4). The example type is `"domains_Create"`.

---

## 9. Domain info, list, and nameservers

### `GET /v1/domains/{domain}`: `getDomainInfo`

Scope `domains:read`. Limit **5 / domain / 300 s**. A 404 means "The requested object was not found". We assume
this also covers "not in this account", but that is unverified.

```jsonc
{
  "name": "xn--spceship-9ya.com",          // required, A-label
  "unicodeName": "spaceship.com",          // required, U-label
  "isPremium": false,                      // required
  "autoRenew": false,                      // required
  "registrationDate": "2100-01-01T00:00:00.000Z",  // required
  "expirationDate":   "2100-01-01T00:00:00.000Z",  // required
  "lifecycleStatus": "registered",         // required; enum below
  "verificationStatus": "success",         // required, NULLABLE; "verification" | "success" | "failed"
                                           // "Status of the RAA verification process. null if RAA procedure is not applied for the domain."
  "eppStatuses": ["clientTransferProhibited"],  // required; items enum: clientDeleteProhibited, clientHold,
                                                // clientRenewProhibited, clientTransferProhibited, clientUpdateProhibited
  "suspensions": [ { "reasonCode": "raaVerification" } ],  // required, maxItems 2
  "privacyProtection": { "contactForm": true, "level": "high" },  // required
  "nameservers": { "provider": "basic" | "custom", "hosts": ["ns1...", "ns2..."] },  // required; hosts 2..12
  "contacts": { "registrant": "...", "admin": "...", "tech": "...", "billing": "...", "attributes": [] }  // required (registrant required)
}
```

`lifecycleStatus` (verbatim):

- `creating`: The domain is being registered. This status means that the request has not yet been processed by the
  registry.
- `registered`: The domain is registered.
- `grace1`: The domain has expired but is still fully manageable.
- `grace2`: The domain expired, parked, and its management is limited.
- `redemption`: The domain has expired and may not be recoverable. If restoration is possible, an additional fee may
  apply.

`suspensions[].reasonCode` enum: `raaVerification, abuse, promoAbuse, fraud, pendingAccountVerification,
unauthorizedAccess, tosViolation, transferDispute, restrictedSecurity, lockCourt, suspendCourt, udrpUrs,
restrictedLegal, paymentPending, unpaidService, restrictedWhois, lockedWhois, complianceCase, suspendRegistry,
fefAbuse, ddosSuspend`. The spec says: "The array may be empty, contain details about one suspension, or contain
details about two: one `raaVerification` and one of the other reason codes." `raaVerification` means "The domain
is suspended due to unverified contacts". A new registrant contact can trigger ICANN RAA email verification. Until
the contact is verified, the domain may be suspended, and mail delivery to it would break. Surface
`verificationStatus` and `suspensions` in the admin UI.

### `GET /v1/domains?take=1..100&skip=N[&orderBy=...]`: `getDomainList`

Scope `domains:read`. Limit 300 / user / 300 s. Response `{ items: DomainInfo[] (≤100), total }`. `orderBy`
takes at most 1 value from: `name, -name, unicodeName, -unicodeName, registrationDate, -registrationDate,
expirationDate, -expirationDate`. **Use this to reconcile outcome-unknown registrations.** Sort by
`-registrationDate`, page through, and match on `name`.

### `PUT /v1/domains/{domain}/nameservers`: `setDomainNameservers`

> Allows the modification of DNS settings for a specific domain by replacing its current nameservers with new ones.

Scope `domains:write`. Limit **5 / domain / 300 s**.

Request:

```jsonc
{
  "provider": "custom",                                   // required; "basic" | "custom"
  "hosts": ["anna.ns.cloudflare.com", "bob.ns.cloudflare.com"]
  // array 2..12, each format hostname 4..255, FQDN.
  // "This field must be specified only for the "custom" provider; for the "basic" provider it should be omitted."
}
```

200 response ("Nameservers updated successfully. The response confirms that the domain's DNS settings have been
modified."):

```jsonc
{ "provider": "custom", "hosts": ["anna.ns.cloudflare.com", "bob.ns.cloudflare.com"] }  // both required
```

This call is synchronous (200, not 202) and idempotent by nature, since it replaces the whole list. Retry is safe.
Our step is: Cloudflare `zones.create` → `name_servers[]` → this PUT → wait for CF zone `status: active` → Email
Routing + catch-all → ingress worker. The spec does not say whether a domain whose `lifecycleStatus` is `creating`
accepts an NS update. Attempt the update only after the async op reports `success` and/or `lifecycleStatus` is
`registered`.

### Related settings endpoints (optional)

- `PUT /v1/domains/{domain}/autorenew`: body `{ "isEnabled": boolean }` → 200 `{ "isEnabled": boolean }`.
  Limit 5 / domain / 300 s.
- `PUT /v1/domains/{domain}/privacy/preference`: body `{ "privacyLevel": "public"|"high", "userConsent": boolean }`
  → 204. "The operation will be performed ONLY if the flag is 'true'."
- `DELETE /v1/domains/{domain}`: the spec says "This API is under development and currently returns an HTTP 501
  status." and "Please note a refund will not be provided as part of this operation." **Registration cannot be
  undone via the API.**
- DNS records (`/v1/dns/records/{domain}`) are irrelevant, because DNS is hosted on Cloudflare after the NS switch.

---

## 10. Idempotency / duplicate-order behavior

**The REST spec has none.** It defines no `Idempotency-Key` header, no client reference field, and no duplicate or
conflict status. Registration and transfer declare no 409. The words "idempot" and "duplicate" never appear in the
spec. Consequences:

- A `POST /v1/domains/{domain}` whose response is lost (timeout, connection reset, 5xx after send) has an
  **unknown outcome**. The domain may have been registered and charged.
- Safety for a second POST of a domain we already own depends on Spaceship rejecting it as no longer available.
  That is very likely, but the spec does not state it, and the error code is unknown.

Required handling on our side:

1. Persist the per-domain state `registering` (with attempt timestamp) **before** sending the POST, in the same
   durable row the cron resumes from.
2. A 202 with an op ID → store the op ID → state `pending_op`.
3. A definite pre-processing rejection (400 / 401 / 403 / 404 / 422 / 429) → `register_failed` (or retry later on
   429). Retry is safe only on 429.
4. A 5xx, network error, timeout, or a 2xx without the header → **`register_unknown`**. Never auto-retry. Reconcile
   by looking for the domain in `GET /v1/domains` (or `GET /v1/domains/{domain}` → 200 + our contacts) and by
   availability (`taken`). If the domain shows up in the account, continue as `registered`. If it is still
   `available` after a reasonable delay, the admin may explicitly retry. The admin-facing UI must say the charge may
   have happened.
5. Async op `failed` → `register_failed`. Show the raw `details`. Re-registration only on explicit admin action,
   after a fresh availability and price re-check.
6. Async op `pending` beyond an SLA (for example 24 h) → flag it for the admin. Do not re-POST.

---

## 11. Account balance and payment: what pays for the registration

**Not in the REST spec.** The REST spec has no balance or funds endpoint, no payment-method endpoint, and no
`paymentMethod` field on `DomainCreateRequest`. The only payment mention for domains is the `autoRenew` text:
"...renewed using the account's default payment method upon each expiration". So:

- We **cannot read the account balance via the API**. A per-day spending cap must be enforced from our own ledger
  (sum of quoted or confirmed prices).
- The charge goes to whatever Spaceship's checkout picks for an API order. The spec does not specify this.

Secondary source (unverified for REST): the Spaceship MCP tools reference at
https://www.spaceship.com/knowledgebase/spaceship-mcp/ returned 403 to automated fetch, so this is quoted via
search-engine summaries, not read directly. It describes the **MCP** registration tool, which is a different
surface from this REST API:

- A registration is charged to a chosen payment method, the account's default saved method, or account funds.
  "Omit to accept the account's default payment method (or funds when there is no usable default)."
- When nothing can be charged: "None of the saved payment methods can be charged for this purchase and the account
  funds cannot be used. Add a payment method or add funds to the account, then try again." Nothing is charged in
  that case.
- The charge is irreversible. Registrations are non-refundable and cannot be cancelled.
- After an `infrastructure.outcomeUnknown` result, "the domain may already have been registered and charged", and it
  can take a while to appear in the domain list. Check the account before retrying.

Operational recommendation: fund the Spaceship account with **account funds only** (no saved card as default), so
that the real exposure is bounded by the pre-paid balance. That is also the only hard cap available outside our
code. Enable registration only for an API key that has `domains:billing`, and keep a separate read-only key option
for quoting.

---

## 12. Mapping to the HPC Mail flow (summary)

1. **Quote:** normalize to an A-label, lowercase, dedupe. Chunk into groups of ≤20 →
   `POST /v1/domains/available` + `POST /v1/domains/pricing/query`. Keep `available` + `priceClass` =
   `standard` (unless opted in) + the `register` price for `years`. Store the quote with an expiry, with
   `finalPrice` and `regularPrice` as integer cents.
2. **Confirm:** re-run 1 for the confirmed names. Reject if a name is no longer available, if its price exceeds
   the quoted price, or if it violates the per-domain cap, the per-batch total cap, the per-day ledger cap, or the
   quote expiry.
3. **Register:** for each name, mark it `registering` → POST → `pending_op` or `failed` or `unknown` (§10). Stay
   under 30 POSTs per 30 s.
4. **Poll:** each cron tick polls each `pending_op` at most once (60 / 300 s account-wide bucket) → `success` →
   `registered`.
5. **DNS:** CF zone create (existing `services/cloudflare.ts` / `hosted-domain.ts`) →
   `PUT /v1/domains/{d}/nameservers {provider:"custom", hosts: cf.name_servers}` → wait until the CF zone is
   active → Email Routing enable + catch-all → configured ingress worker (`hpc-mail-ingress-20261028` in k3s mode).
6. **Activate:** append the domain to `settings.domains.list` with `expectedDomainsRevision`.
7. **Visibility:** show `verificationStatus`, `suspensions`, and `lifecycleStatus` from `GET /v1/domains/{d}`
   (≤5 / 300 s per domain). Registrant RAA verification may be required.

---

## 13. Open questions (need a real account to confirm)

- Exact `spaceship-error-code` values for "not available", "insufficient funds / no payment method", "premium
  requires acknowledgement", and "TLD requires attributes".
- Whether the async op `details` on `failed` contains a machine-readable reason.
- Typical latency from `pending` to `success` for common gTLDs.
- Whether a second `POST /v1/domains/{d}` for a domain already in the account is rejected cleanly, and with which
  code.
- How the REST registration selects the payment source (funds vs. default card), and whether it can fail with 202
  followed by an async `failed` when funds are insufficient.
- Whether `X-RateLimit-Reset` is epoch seconds.
- Whether `GET /v1/domains/{domain}` returns 404 for a domain that exists but is not in this account.
- Whether a domain whose `lifecycleStatus` is `creating` accepts a nameserver update.
