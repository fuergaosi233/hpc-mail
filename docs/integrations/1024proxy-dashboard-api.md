# 1024proxy customer dashboard API: reverse-engineered spec

Status: **derived from public front-end assets only**, retrieved 2026-11-25. No account was used. No login,
captcha, order, or other authenticated call was made. Every field name below comes from minified JS, so treat
response shapes as "what the SPA reads". Fields the SPA does not touch may also exist, and what the server
accepts may be looser or stricter than the SPA suggests.

Confidence legend:
- **H**: request path, request fields, and the response fields used are all visible in code.
- **M**: the request is visible, but the response shape or semantics are partly inferred.
- **L**: inferred from UI or help text. Not visible as code.

---

## 0. TL;DR for the implementer

- **There is no public ordering API.** Every call below is the private API behind the customer console. It can
  change without notice. Pin the behaviour with contract tests that run on recorded fixtures, never live.
- **API host:** `https://api.1024proxy.com`. All calls are `POST` with an
  `application/x-www-form-urlencoded` body. A few exports/downloads use `GET` with query params.
  The test host is `https://testapi.1024proxy.io` (used when the page hostname ≠ `1024proxy.com`).
- **Auth:** an opaque session token sent **as a body field `token`**, not a header. Every request also sends
  `lang` (`en`/`zh`/…) and the header `Accept-Protocol: https`. The browser keeps the same token in the cookie
  `zero_sid` (domain `.1024proxy.com`) and in `localStorage.session`.
- **Envelope:** `{ code: number, msg: string, data: any }`. `code == 0` means success. `code == 300` means the
  session is invalid or expired (the SPA logs out). Signin can also return `code == 30` (see §2).
- **Login blocker:** `POST /add/v1/signin` takes `email`, `pwd`, plus a **go-captcha slide-puzzle solution**
  (`idkey`, `x`, `y`) from `POST /get/v1/captcha/drag`. Automating it means solving a slide puzzle
  (image template matching). **Recommendation:** have the admin paste the `zero_sid` session token, set a long
  "token cache" in 1024's account settings, and keep email and password login as an optional, best-effort
  path (§2.4).
- **Purchasing has two stages, and only stage 1 is in the JS.** Each `order*` call returns `data.url`, a hosted
  checkout page that the SPA opens in a new tab. "Pay with wallet balance" (`pay_type = balance`) happens on that
  page, and **its HTML/form is not public**. That page must be captured with a real account before we can
  automate payment (§5, open issue #1).
- **Order status:** poll `POST /get/v1/1024/get_recharge_record` with `order_no`. In that list, `pay_status` is
  `1` = paid, `2` = refunded, anything else = pending (§5.6).
- **Proxy credentials (dynamic residential, rotating or sticky):**
  `host:port` comes from `/get/v1/traffic/server` (help example `us.1024proxy.io:3000`). The username is
  `{subUser}-region-{CC}[-st-{State}][-city-{City}] | [-asn-{ASN}][-sid-{8 chars}-t-{minutes}]` and the password
  is the sub-user's password (§7.1).
- **Static ISP:** you buy a per-country, per-duration **IP balance**, then **allocate** concrete IPs with
  `/add/v1/1024/static_use`. Each allocated IP has its own `ip`, `port`, `username`, and `password` (§7.2).

---

## 1. Assets analysed (evidence base)

| Asset | URL | sha256 |
|---|---|---|
| Desktop console (Vue 3 + Vite + axios + tdesign + go-captcha) | `https://dashboard.1024proxy.com/assets/index-CvNHQc98.js` + 19 lazy chunks | index `f3b8e2f0…7965` |
| — sub-user / dynamic residential page | `assets/index-CpBp0M7x.js` | `cd9468b0…d049` |
| — static ISP page | `assets/index-DyJeO_5X.js` | `7bb7732d…7460` |
| — wallet page | `assets/index-ClQFdeQa.js` | `8a1cd2d9…75b3` |
| — unlimited bandwidth page | `assets/index-CAjLRjLh.js` | `8716fe3d…4ecc` |
| — unlimited port page | `assets/index-DUYbx8qL.js` | `e83ae62a…5bdb` |
| — account / security page | `assets/index-IKa451ZA.js` | `e2af1ebe…28cb` |
| — home page | `assets/index-Dn2VBmj7.js` | `2856c0e8…adfa` |
| Mobile console (Rsbuild + Vue + vant) | `https://dash.1024proxy.com/static/js/index.6ace8754.js` + 17 async chunks | `0bd2c769…190ec` |
| Marketing site request wrapper | `https://1024proxy.com/static/js/request.js?v=1.0.15` | `9aaddb74…0489` |
| Login | `https://1024proxy.com/static/common/login/js/login.js?v=1.0.15` + inline script in `/sign-in/` | `e0b15455…6bd7` |
| Ordering (residential / IP / static / unlimited) | `/static/common/pricing/js/{residential,residential_ip,static,unlimited}.js` | see the scratch hashes |
| Ordering (premium "high-traffic") | inline `<script>` in `https://1024proxy.com/pricing/high-traffic/` | — |
| Help centre (GitBook, `.md` variants) | `https://help.1024proxy.com/llms.txt` and the linked pages | — |

The desktop and mobile consoles use the **same endpoint set**. The 122 paths in the mobile bundle are a subset
of the 127 paths in the desktop bundle. Purchase entry points are **not** in either console: both consoles send
"Buy" clicks to `https://1024proxy.com/pricing/...` (the marketing site, jQuery), which calls the `order*`
endpoints.

Desktop API module (`index-CvNHQc98.js`), verbatim:

```js
U.defaults.headers.post["Content-Type"]="application/x-www-form-urlencoded;charset=UTF-8",U.defaults.timeout=14e3,
U.interceptors.request.use((t=>(t.data||(t.data={}),t.headers["Accept-Protocol"]="https",
  t.data.lang="zh-tw"==V().languageValue?"zh":V().languageValue,t.data.token=q().session||"", ...
U.interceptors.response.use((({data:t})=>(0==t.code||t instanceof Blob||(... 300==t.code&&(... q().clear(),
  I.set("zero_sid","null",{domain:".1024proxy.com"}),location.href="http://1024proxy.com/sign-in/")),t)), ...
const X="https://api.1024proxy.com",J=(t,e)=>U.get(X+t,{params:e}),Z=(t,e,a,o)=>U({method:"post",url:X+t,data:e,headers:a,responseType:o})
```

The mobile client is explicit about the encoding (`index.6ace8754.js`):

```js
let d=i.A.create({baseURL:"https://api.1024proxy.com",timeout:14e3,headers:{"Content-Type":"application/json","Accept-Protocol":"https"}});
d.interceptors.request.use(t=>{ ... o={}; if(e&&(o.token=e),i&&(o.lang=i),"get"===t.method) return t.params={...o,...t.params},t;
  ... let l=new URLSearchParams; Object.entries({...o,...t.data}).forEach(...l.append(e,String(a))); t.data=l,
  t.headers["Content-Type"]="application/x-www-form-urlencoded" ...
```

The marketing site (`request.js`) does the same thing with jQuery:
`$.post(requestApi + u, {...d, lang: langInterface, token: localStorage.getItem("session") || Cookies.get("zero_sid")})`.

**Request signing or encryption: none.** No HMAC, timestamp, nonce, or body encryption appears on any
console or order call. The only obfuscated file is `register.encrypt.js` (jsjiami v7), which is **signup only**
and adds a `headless` bot-detection flag (`navigator.webdriver || …`). The signin page does not load it.

Other public hosts seen:
- `https://api.1024proxy.com/info` (GET, unauthenticated geo check; the site redirects Jiangsu, Shanghai, and IR
  to `/forbidden/`).
- `https://white.1024proxy.com/white/api`, `/premium/white/api`: whitelist-auth extraction (§8).
- `https://apisocks.1024proxy.com/api/getIpInfo`: key-auth extraction for the "Dynamic Residential IP (lines)"
  product (§8).
- `http://{serverDomain}:500/api`: per-server extraction for unlimited bandwidth/port (§8).
- `https://api.1024proxy.com/1024Recharge/{lang}/{token}/{amount}[/app]`: hosted wallet top-up (GET in a new
  tab).
- `https://api.1024proxy.com/get/down_invoice/{token}/{order_no}`: invoice download.

---

## 2. Authentication

### 2.1 Slide captcha (**H**)
`POST /get/v1/captcha/drag` (no fields besides `lang` and the empty `token`)
→ `data: { id, master_image, tile_image, tile_width, tile_height, initial_x, initial_y }` (base64 images for
go-captcha `Slide`). The user drags the tile; the client sends the final `{x, y}`.

Evidence (`login.js`):
```js
const res = await $POST('/get/v1/captcha/drag'); captchaId = res.data.id
capt.setData({ image: res.data.master_image, thumb: res.data.tile_image, thumbWidth: res.data.tile_width,
  thumbHeight: res.data.tile_height, thumbX: res.data.initial_x, thumbY: res.data.initial_y })
... confirm(dots, reset) { captX = dots.x; captY = dots.y; submitSignin(); }
```

### 2.2 Signin (**H** for the request, **M** for the response)
`POST /add/v1/signin` with `email`, `pwd` (8–20 chars, client-checked), `pcode` (invite code, empty),
`idkey` (= captcha `id`), `x`, `y`.
- `code 0` → `data.token` (session), `data.token_cache` (days the cookie lives; `0` = effectively never). `data`
  is also stored whole as `localStorage.user`, so it is the user object (see `/get/v1/member` fields).
- `code 30` → the page calls `check_verificat()`, which fetches an **image captcha** from `POST /ip2` →
  `data: {k, id, img}`. The input for it (`#verification`) is **hidden**, and `submitSignin` does **not** send
  it. This looks like a legacy path or a risk-control branch; the server's exact requirement is unknown (open
  issue #3).
- Other non-zero codes → `msg` is shown.

Evidence (`login.js`):
```js
const res = await $POST('/add/v1/signin', { "email": emailVal, "pwd": pwdVal, "pcode": codeVal,
  "idkey": captchaId, "x": captX, "y": captY });
if (res.code == 30) { $('#verification').val(''); check_verificat(); }
if (res.code == 0) { localStorage.setItem('session', res.data.token); ...
  const expires = res.data.token_cache === 0 ? 9999999999999 : res.data.token_cache; ...
  Cookies.set("zero_sid", res.data.token, cookieOptions);
```

**2FA / e-mail code at login:** the signin code sends **no** MFA or mail-code field. The account does have TOTP
MFA (`/get/v1/mfaApp`, `/add/v1/mfaSecret` → `{code,key,qr}`, `/update/v1/bindMFa`, `/del/v1/unbindMFa`) and a
"secure e-mail" (`/update/v1/secureMail {email, code}`). In the visible code these are used only for sensitive
account operations, such as `/update/v1/upPwd {pwd, newPwd, code}`. Whether a bound MFA adds a login step
(probably another `code` value and another page) **cannot be confirmed** without an account (open issue #2).

**Google login:** `POST /v1/gLogin {oauth_token: <Google ID token>}` → same `data.token`, plus `can_set_pwd`.
The script is commented out on `/sign-in/`, and `client_id` is `""` in `googlelogin.js`. This path is **not
usable** for automation.

### 2.3 Session validation and lifecycle (**H**)
| Purpose | Call | Notes |
|---|---|---|
| Validate token / refresh the user object | `POST /add/v1/webauto {session: <token>}` | Used by `request.js#autoLoginFn` and the console boot. `code != 0` → token dead. Returns the user (`can_set_pwd`, …). |
| User profile + balance | `POST /get/v1/member` | Fields read: `email, ip, sign_date, last_date, mfa_bind ("bind"/"unbind"), access_key, google_email, token_cache, country, secure_email, morelogin, traffic, alltraffic, invoice_title`. The wallet page reads `userInfo.balance` and `userInfo.total_balance` (USD, shown with `toFixed(2)`). |
| Token lifetime setting | `POST /update/v1/upTokenCache {cacheTime}` | Days. Use this so the pasted token lasts. |
| Multi-terminal login toggle | `POST /update/v1/moreLogin {terminal: 1|0}` | `member.morelogin`. **If this is off, our login may kick the admin's browser session, or the reverse.** |
| Logout | `POST /del/v1/signout` | Invalidates the token. Never call it from automation that uses an admin-pasted token. |
| Reset API access key | `POST /update/v1/upAccessKey` → `data.access_key` | The key is for apisocks extraction (§8). It is **not** a console API key. |
| Delete account | `POST /del/v1/cancel` | **Never call.** Listed only so the client can deny-list it. |

### 2.4 Recommended auth strategy for HPC Mail
1. Primary: the admin pastes the `zero_sid` token. Store it as an admin secret setting with `SECRET_MASK`.
   Validate it with `/add/v1/webauto` and show `member.email` and `balance` in the admin UI.
2. Optional: store email and password with `SECRET_MASK`. Use them only if we later implement a slide-puzzle
   solver. Keep it disabled by default, because it is fragile and may count as bot activity under the provider's
   terms.
3. Any `code == 300` response puts the integration into the state `needs_reauth`. Never retry in a loop.

---

## 3. Balances, traffic, and catalogue

| Purpose | Call | Fields seen | Conf |
|---|---|---|---|
| Wallet balance | `/get/v1/member` (or `/add/v1/webauto`) | `balance`, `total_balance` | H |
| Home init | `POST /get/v2/indexInit` | `data.user` | M |
| "From $x" prices per product line | `POST /get/v1/1024/indexPrice` | `data: {bandwidth, flow, ports, static}` (display strings or numbers) | M |
| Dynamic residential traffic left | `POST /get/v1/trafficInfo` | `traffic`, `alltraffic`, `spend` (the UI shows `traffic/1e3/1e3/1e3` as GB, so the unit is **bytes**) | M |
| Premium ("high quality") traffic left | `POST /get/v1/premium/trafficInfo` | same as above | M |
| Wallet top-up presets | `POST /get/v1/rechargeList` | `[{sn, money, default: "true"/"false", …}]` | H |
| Unlimited **port** packages and owned ports | `POST /get/v1/unlimit/portOrders` | `data.portList`, `data.portPackage[{sn, data:[{day, sn, …}]}]` | M |
| Unlimited **bandwidth** packages and owned servers | `POST /get/v1/unlimit/bandwidthOrders` | `data.bandwidthList`, `data.bandwidthPackage[{sn, data:[{day, sn, …}]}]` | M |
| Static ISP balance overview | `POST /get/v1/1024/static_index` | `data.balance_list[0..2]` (index 0=7 d, 1=30 d, 2=90 d; `{broadcast, native}` counts), `data.my_country_list{"7day"|"30day"|"90day": [{code, citys, …}]}` | M |
| Static ISP balance for a renewal | `POST /get/v1/1024/static_ip_balance {day, code}` / `POST /get/v2/static/info {id, day}` → `data.balance` | | M |
| Port renewal prices | `POST /get/v1/1024/portRenewalPrices {id}` → `data[]` of `{day, …}` | | M |
| Bandwidth renewal options | `POST /get/v1/unlimit/bandwidthOrder {id}` → `data[]` of `{day, sn}` | | M |
| Country / state / city / ASN lists | `/get/v3/country {cate:"traffic"}` → `[{code, States, …}]`; `/get/v2/city {country, state}`; `/get/v1/asn {country, asn, city, state}` | | H |
| Static ISP inventory to pick from | `/get/v1/static/list {code, city, ip_segment}`; `/get/v1/static/ip_segment {country, city}` | | M |

**There is no catalogue endpoint with prices for every SKU.** The authoritative SKU (`sn`) and price lists are
**server-rendered into the pricing pages** at `https://1024proxy.com/pricing/{residential,static,unlimited,socks5,high-traffic}/`
(public HTML, no login needed). A quote step can scrape them. Examples from 2026-11-25 (prices shown are
**not** a contract):

| Product | Page | SKU attrs | Example SKUs |
|---|---|---|---|
| Dynamic residential traffic (GB) | `/pricing/residential/` | `.buy-btn[data-sn][data-num]`, calculator `.calculate-content[data-min=2][data-max=100][data-price=1.20]` | `flowmax100` (num 2), `flowmax200`, `flowmax1tb` |
| Premium high-quality traffic | `/pricing/high-traffic/` | `.ht-buy-btn[data-sn][data-num][data-flag=first]` | `qualityflow2` (first-purchase only), `qualityflow10/100/500/1tb` |
| Unlimited **port** | `/pricing/unlimited/` | `li.select-item[data-day][data-sn][data-price]` | `2-15ports{3d,7d,30d}`, `16-40ports…`, `41-100ports…`, `101-999ports…` |
| Unlimited **bandwidth** | `/pricing/unlimited/?type=bandwidth` | `li[data-sn][data-day][data-hour][data-price][data-money]` | `3H100mRand`, `1D{100m,200M,300M,400M}Rand`, `7D…`, `30D…` (watch the inconsistent `m`/`M` case) |
| Dynamic residential IP (lines) | `/pricing/socks5/` | `.buy-btn[data-sn][data-type=ports|bandwidth]` | `isp20`, `isp100`, `isp500`, `isp10000`, `isp30000`, `isp80000` |
| Static ISP | `/pricing/static/` | `.country_lists[data-day=7|30|90] > .country_lists_detail[data-code][data-price][data-costprice][data-region]` | `KR`, `TH`, `MY2`, `SG2`, `BR`, `MX`, … (102 entries across the 3 durations) |

Static ISP volume discount, client-side (`static.js`): 1–10 IPs ×0.95, 11–40 ×0.90, 41–100 ×0.85, 101+ ×0.80.
**The server computes the final amount.** Use the checkout page or order record as the source of truth (open
issue #5).

---

## 4. Wallet top-up (**H**)
The SPA does **not** call an API. It opens a hosted page:
`GET https://api.1024proxy.com/1024Recharge/{lang}/{token}/{amount}` (mobile appends `/app`). Amount bounds on
mobile: 1–99999. This is a real-money payment page (Alipay, card, crypto, …). **HPC Mail must never open or
automate it.** Top-ups stay manual for the admin.

Evidence (`index-ClQFdeQa.js`):
```js
const Xa=()=>{const a="https://api.1024proxy.com/1024Recharge/"+("zh-tw"==wa.languageValue?"zh":wa.languageValue)+"/"+ga.session+"/"+Ja.value;window.open(a,"_blank")}
```

Pay-type enum used in the order and recharge lists (`index-ClQFdeQa.js`, verbatim keys):
`antom, onlypay-wechat, coin, payermax, chinagpay, payermaxLocal, paypal, payssion, airwallex, onlypay-card,
balance (= "余额支付 / wallet balance"), applepay, admin`.

---

## 5. Ordering

### 5.1 Common shape (**H** for the request, **M** for the result)
Every `order*` call returns `code 0` with **`data.url`**. The page then runs `window.open()` + `location = data.url`.
No `order_no` is read from the response in the visible code (it may exist in `data`; open issue #1).
**The order is unpaid at this point.** Payment, including the "wallet balance" option, is completed on `data.url`.

### 5.2 Dynamic residential traffic (**H**)
`POST /add/v1/1024/orderFlow {sn, num}`, for example `{sn:"flowmax100", num:2}` (num = GB multiplier inside
min/max).
```js
const data = { 'sn': _sn, 'num': e.currentTarget.dataset.num };
const res = await $POST('/add/v1/1024/orderFlow', data); ... tempwindow.location =res.data.url;
```

### 5.3 Premium dynamic residential traffic (**H**)
`POST /add/v1/premium/orderFlow {sn, cate:"premium_flow", num, source:"web"}`.
Inline comment: "num: number of packages (GB = num × package value, must be within min/max)".

### 5.4 Static ISP (**H**)
`POST /add/v2/1024/orderStatic {data: "<code>-<day>-<count>[,<code>-<day>-<count>…]", coupon_code: ""}`,
for example `data=KR-30-2,US-30-5`.
```js
// 下单参数格式：code-day-num，多个用英文逗号分隔
const submitData = selected.flatMap(dayObj => dayObj.items.map(item => `${item.code}-${dayObj.day}-${item.count}`)).join(',');
const res = await $POST("/add/v2/1024/orderStatic", { data: data, coupon_code: couponCode });
```
Paying credits a **static IP balance**. It does not deliver IPs. Allocate them afterwards (§7.2).
Renewal: if IP balance > 0, `POST /update/v1/static/moreRenewal {ids, day}` (consumes balance, no payment).
Otherwise `POST /add/v2/1024/orderStaticRenewal {ids, day}` → `data.url`. Auto-renew:
`/update/v1/1024/static/more_auto {ids, day, auto}`.

### 5.5 Unlimited port / bandwidth (**H**)
`POST /add/v1/1024/orderUnlimit {sn, cate: <"ports"|"bandwidth"> (button data-type), num: <port count>}`.
Renewals: ports `POST /add/v1/1024/renewalPorts {id, day}` → `data.url`; bandwidth
`POST /add/v1/renewalUnlimit {id, sn}` → `data.url`.
Help: "server deployment and distribution will be completed within 2 minutes" after payment.

### 5.6 Dynamic residential IP (lines) (**H**)
`POST /add/v1/1024/orderIp {sn}` (for example `isp20`).

### 5.7 Order and payment status (**M**)
| Call | Request | Response used |
|---|---|---|
| Consumption / purchase records ("expenseList" tab) | `POST /get/v1/1024/get_recharge_record {page, limit, start, end, order_no}` | `data.lists[]`: `order_no, pak_cate, name, origin_price, discount_money, true_money, pay_time, pay_status` (`1` paid, `2` refunded, else pending), `data.total` |
| Top-up records ("rechargeList" tab) | `POST /get/v1/1024/get_recharge_list {pak_cate:"recharge", page, limit, start, end, order_no}` | `data.lists[]`: `order_no, pay_type, money, pay_time, pay_status`, `data.total` |
| Paid orders (invoice page) | `POST /get/v1/orderList` | `data[]`: `order_no, name, money, create_time, pay_time` |

Evidence (`index-ClQFdeQa.js`):
```js
payStatus:q((({row:a})=>[w("div",null,[2==a.pay_status?(...e.$t("staticTitle.text2") /*退款*/ ):1==a.pay_status?(...e.$t("wallet.text21") /*已支付*/ ):(...e.$t("wallet.text22") /*待支付*/ )])]))
```

### 5.8 Implications for the HPC Mail purchase engine
- **quote:** read `balance` (member) and the SKU price (scraped pricing page, or `indexPrice`), then compute the
  expected total.
- **execute:** call `order*` and persist the returned `data.url` and any `order_no` **before** the next step.
  Then the "pay with balance" step runs on the checkout page. That mechanism is unknown, so this step **must stay
  unimplemented, or limited to manual "admin completes payment in the browser"**, until a live capture shows the
  page (open issue #1).
- **reconcile:** poll `get_recharge_record` (filter by `order_no` if we have one, else match `name`, `true_money`,
  and a time window), and watch the `member.balance` delta. A timeout, a network error after `order*`, or an
  ambiguous match means **`unknown`. Never auto-retry, because a retry creates a second order.**

---

## 6. IP whitelist (**H**)
There are **separate whitelists per product line**.

| Product | List | Add | Update remark | Delete | Replace | Check "my IP" |
|---|---|---|---|---|---|---|
| Dynamic residential traffic | `/get/v1/trafficWhiteList {username, ip}` → `data[]` (`user_ip, mark, create_time, …`) | `/add/v1/addTrafficWhite {ips, mark}` (ips comma-separated) | `/update/v1/updateTrafficWhite {ids, mark, account_id}` | `/del/v1/delTrafficWhite {ips}` | `/add/v1/replaceTrafficWhite {...}` | `/get/v1/checkTrafficWhite` → `{show, is_cn, ip}` |
| Premium traffic | `/get/v1/premium/trafficWhiteList` | `/add/v1/premium/addTrafficWhite {ips}` | `/update/v1/premium/updateTrafficWhite {ids, mark, account_id}` | `/del/v1/premium/delTrafficWhite {ips}` | `/add/v1/premium/replaceTrafficWhite` | — |
| Unlimited port / bandwidth | `/get/v1/1024/get_unlimited_white {limit, page, cate:"port"|"bandwidth"}` → `data.lists, data.total` | `/add/v1/1024/add_unlimited_white {ip, remark, cate, account_id}` | `/update/v1/1024/edit_unlimited_white {id, remark}` | `/del/v1/1024/del_unlimited_white {ids}` | — | `/get/v1/1024/check_unlimited_white {cate}` → `{show, is_cn, ip}` |

Mainland-China IPs are rejected (`apmodel.text137` = "Mainland China IPs are not supported for addition and
use").

---

## 7. Credentials: sub-accounts and proxy strings

### 7.1 Dynamic residential traffic (**H**)
- Sub-users: `/get/v1/1024/subUsers {username, level}` → `data.list[]` (`id, username, pass/password, title,
  traffic, alltraffic, cate ("limit"|"nolimit"), create_time, …`). The picker uses
  `/get/v1/availableSubUsers {show_all:"1"}` → `[{username, password}]`.
- Create: `POST /add/v1/addSubUser {username, password, traffic, title, cate:"limit"}`. `traffic` is the quota
  allocation (help: "measured in GB"). A **negative value subtracts** quota (UI "decrease": `e="2"==U.value?-num:num`).
- Update: `/update/v1/upSubUser {…same…, id}`. Delete: `/del/v1/delSubUser {username}`. CSV export:
  `/get/v1/1024/subUsersDownload`.
- The premium line mirrors these under `/…/premium/…` (`addSubUser`, `subUsers`, `upSubUser`, `delSubUser`,
  `availableSubUsers`).
- Gateway host: `/get/v1/traffic/server` (premium: `/get/v1/premium/traffic/server`) → `[{hostname, title}]`,
  where `hostname` is `host:port`. Help examples use `us.1024proxy.io:3000` and say gateways exist in the US and
  in Hong Kong.
- Username grammar, verbatim from `index-CpBp0M7x.js`:
```js
a=""==V.value?"":`-region-${V.value}`, t=…`-city-${Y.value}`, s=…`-st-${C.value}`, i=…`-asn-${Yl.value}`,
u="2"==$e.value?"":`-sid-${El(8)}-t-${Zl.value}`,   // "2" = Rotating; otherwise Sticky
o=Xl.value?i:s+t;                                     // ASN XOR state+city
ke.value=`${e}${a}${o}${u}`                           // e = sub-user username, l = its password
// El(n): n chars from "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz123456789"
```
  Final form: `{user}-region-{CC}[-st-{State}][-city-{City}]` or `{user}-region-{CC}-asn-{ASN}`, plus
  `-sid-{8}-t-{1..120}` for sticky sessions. Help example: `USERNAME-region-US-st-Louisiana-city-New Orleans`
  (city names may contain spaces), `USERNAME-region-US-asn-AS11272`, `USERNAME-region-DE-sid-ENQzeWjG-t-5`.
- Export formats (`Pl`): `1` = `host:port:user:pass`, `2` = `socks5://user:pass@host:port`,
  `3` = `user:pass@host:port`, `4` = `host:port@user:pass`. The same gateway serves HTTP(S) and SOCKS5.

**HPC Mail mapping:** one inventory row per mailbox can be **generated** (no purchase): a fixed sub-user + a
sticky `-sid-<random8>-t-<minutes>` per address. Store the sid so the binding stays reproducible. Note that a sid
pins an exit only for its `t` minutes, so this is a "same session key", not a "same IP" guarantee.

### 7.2 Static ISP (**H**)
- Accounts: `/get/v1/1024/get_static_account {username}` → `data.lists`; `/add/v1/1024/add_static_account
  {username, password}`; `/update/v1/1024/edit_static_account {username, password, remark}`;
  `/del/v1/1024/del_static_account {username}`; picker `/get/v1/1024/get_static_account_select` → `[{username,
  password}]`.
- **Allocate IPs from the balance:** `POST /add/v1/1024/static_use {code, id: "<ipId,…>", day, num:1, username,
  password, ip_segment}`. Pass empty `username`/`password` for "random credentials". The `id` values come from
  `/get/v1/static/list`.
- My IPs: `POST /get/v1/1024/static_use_list {code, ip, mark, username, size, page, expired, order_field,
  order_type}` → rows with `ip, port, username, password, code, country, city, region, days, expired, mark,
  remark, use_time, created_at`. Plus `/get/v1/1024/static_all_use_list`,
  `/get/v1/1024/static/export_csv` (GET `{token, lang}`), `/get/v1/1024/static_ip_count`.
- Bulk edit credentials and remark: `/update/v1/1024/static/batch_update {username, password, mark, ids}`.
  Release: `/del/v1/1024/static/batch_del {ids}`.
- Proxy string: `ip:port:username:password`, with the same 4 formats (`index-DyJeO_5X.js`
  `switch(Eo.value){case"2":socks5://…}`).

**HPC Mail mapping:** static ISP is the natural "one proxy per mailbox" product. Each `static_use_list` row is
one inventory item, keyed by the 1024 row id.

### 7.3 Unlimited port (**H**)
- Accounts: `/add/v1/1024/add_unlimited_account {username, password, remark, cate:"port"}`, picker
  `/get/v1/1024/get_unlimited_account_select {cate:"port"}`.
- Servers / ports: `/get/v2/unlimit/portServers {page, page_size, order_type, order_field}` → `data.list[]` of
  `{id, is_demo, ip, domain ("unlimit.1024proxy.io:NNNN"), port, username, password, mark, expired, minute,
  region, whites, format}`. Batch edit: `/update/v1/1024/unlimited_port/batch_update {ids, username, password,
  minute (3–30), format, region, mark}`. Regions: `/get/v1/unlimit/portRegion`. Export:
  `GET /get/v1/unlimit/export_port {token}`.

### 7.4 Unlimited bandwidth (**H**)
- `/get/v3/unlimit/bandwidthServers {page, page_size}` → `data.lists[]` (same row shape, `domain` like
  `bwxxx.1024proxy.io`); edit `/update/v1/unlimit/upbandwidth {ids, username, password, minute, format,
  region}`; reboot `/update/v1/unlimit/reboot {id}`; regions `/get/v1/unlimit/bandwidthRegion`; monitor
  `/get/v1/unlimit/monitor {ip, start, end}`.

---

## 8. Extraction (API-link) modes (**H** for URL shape, **M** for output)

| Mode | URL template (verbatim) | Auth |
|---|---|---|
| Dynamic residential traffic | `https://white.1024proxy.com/white/api?region={CC}&num={n}[&time={min}]&format={n|rn}&type={txt|json}` | Caller IP must be on the traffic whitelist (§6). No key in the URL. |
| Premium traffic | `https://white.1024proxy.com/premium/white/api?…same…` | Premium whitelist. |
| Unlimited bandwidth / port | `http://{server.domain}:500/api?country={CC}&username={u}&password={p}&minute={m}&format={1|…}&ips={ip,…}&num={n}` | Server account credentials in the query string (plain HTTP). |
| Dynamic residential IP (lines) | `https://apisocks.1024proxy.com/api/getIpInfo?key={access_key}&port={p}&num={n}&country={CC}&state={st}&type={t}` | `member.access_key`. |

Parameter docs from the console (EN i18n): `region` = Country (int?, required); `format` = return data separator
(`n`=`\n`, `rn`=`\r\n`, required); `time` = session duration (required for sticky, omitted for rotating; help
says 10/15 min for traffic); `num` = number of IPs (optional); `type` = `txt` | `json` (optional). Bandwidth
`ips` = "Multiple addresses separated by commas; the default is the IP address of the calling interface". The
example output is shown only as an image in the help; per the help text, the API "will return an IP and port".
The JSON shape is unknown (open issue #6).

---

## 9. Endpoints HPC Mail must never call
`/del/v1/cancel` (delete account), `/del/v1/signout` (kills the shared token), `/update/v1/upPwd`,
`/update/v1/change_email`, `/update/v1/secureMail`, `/add/v1/mfaSecret`, `/update/v1/bindMFa`,
`/del/v1/unbindMFa`, `/update/v1/upAccessKey` (rotates the key other tools use),
`/update/v1/upShareCode`, `/add/v1/getProfit` (affiliate withdrawal), `/add/v1/cdkeyMake` (spends balance on
CDKs), `/update/v1/cdkeyUse`, `/1024Recharge/...`, `/update/v1/upTokenCache` (only with explicit admin
consent). Implement the client with an **allow-list** of paths. Do not expose a generic `call(path)`.

## 10. Full path inventory (desktop console, 127 paths)
Extracted with `grep -oE '"/(get|add|del|update)/[^"]+"'` over all chunks. Additional paths from the marketing
site: `/add/v1/signin`, `/add/v2/signup`, `/v1/gLogin`, `/ip2`, `/info`, `/add/v1/kwd`, `/add/v1/1024/orderFlow`,
`/add/v1/premium/orderFlow`, `/add/v1/1024/orderIp`, `/add/v2/1024/orderStatic`, `/add/v1/1024/orderUnlimit`.
The list can be regenerated from the asset URLs in §1. Bundle file names are content-hashed, so a changed name
means the client may have changed.

---

## 11. Open issues (only a live, logged-in capture can settle these)
1. **Checkout page behind `data.url`**: what the URL looks like (host, path, `order_no`); whether "wallet
   balance" payment is one POST (endpoint, fields, response); whether it needs a captcha, MFA, or secure-email
   code; and whether `order*` responses include `order_no`. **This blocks automatic payment.**
2. Does an account with bound MFA (`mfa_bind = "bind"`) or a secure e-mail require an extra login step? If so,
   which response code and fields?
3. Is the slide captcha mandatory on every `/add/v1/signin`, or only after risk triggers? What does `code 30`
   (image captcha `/ip2` → `{k,id,img}`) expect, and under which field name?
4. Token lifetime and concurrency: the real expiry for `token_cache = 0`, and whether `morelogin = 0` makes a new
   login invalidate older tokens.
5. Server-side pricing: final amounts, discounts, coupons, and rounding for each `order*`. Is there a price
   preview endpoint? None is visible.
6. JSON response shapes of the extraction URLs (§8), and whether `white.1024proxy.com` needs the whitelist to
   include the HPC Mail egress IP (space-2 nodes in multiple regions → several egress IPs).
7. Unit of `traffic` in `/add/v1/addSubUser` (GB by help text vs. bytes in `trafficInfo`).
8. Static ISP allocation after purchase: is any IP auto-assigned, or is `static_use` always required? Can
   `static_use` fail partially for a multi-id request?
9. Error-code catalogue beyond `0`, `30`, and `300`, especially insufficient balance and rate limiting.
10. Terms-of-service position on automating the console. The ToS was not reviewed here.
