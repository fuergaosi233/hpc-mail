# HPC Mail on K3s and PostgreSQL

This fork can run the existing application on Node.js with PostgreSQL, PostgreSQL-backed KV and a local persistent object volume. Cloudflare D1, KV and R2 are not needed for this runtime. The original Workers runtime and tests remain available.

The PostgreSQL adapter preserves the application's prepared-statement and transactional batch interfaces. It binds parameters, serializes application write batches with a database advisory lock, translates the SQL constructs used by the application, and installs equivalent native PostgreSQL protections for the last administrator and invitation consumption. New SQL constructs must be covered by the PostgreSQL suite before deployment.

## Current deployment

- Web: `https://anytoken.email` (the previous `mail.multi-agent.wiki` ingress is retained).
- Namespace: `hpc-mail`
- Application and object volume: `pve-bigbox-ubuntu-3`
- PostgreSQL: existing `postgres.open-lark.svc.cluster.local` service, dedicated `hpc_mail` database and non-superuser role, application pool maximum 4 connections, role connection limit 8.
- Administrator: `holegots`. Registration requires an invitation. Only `anytoken.email` is public, with 10 addresses per ordinary user on that domain (50 globally); the friend account has an unlimited private policy for `freetrips.net` and `anytoken.email`. Credentials remain in Kubernetes Secrets and private deployment files.
- Initial mailboxes: `holegots@multi-agent.wiki`, `holegots@0xolivia.xyz`, `holegots@astergate.cc`, `holegots@seed-diffusion.com`.
- HTTPS: namespace-scoped DNS-01 issuer `hpc-mail-dns01`, using the `hpc-mail-cloudflare-dns` Secret. Renewal is automatic. SMTP reloads renewed certificates from the Secret volume automatically.
- CoreDNS has a domain-only `anytoken-mail.server` custom entry resolving `anytoken.email` through Cloudflare DNS over TLS, avoiding the upstream negative responses observed during registration. Merge `coredns-anytoken.patch.json` into the existing shared ConfigMap; preserve all other entries.

Creating a mailbox in the application does not activate public mail delivery. DNS and an incoming transport must be verified separately.

## Cloudflare Tunnel front door

The public `anytoken.email` entry uses the existing healthy `gamesgadget-mail-k8s` tunnel (`400e2dd2-cd0b-41c6-b0e1-51308b0fb681`) rather than the direct Tencent HTTPS ingress. On 2026-10-28 the direct origin returned TLS handshake failures (525) to Workers despite a healthy application and valid certificate. The new routes are appended; the tunnel's existing `mail.gamesgadget.com` and `inbox.s6o.org` routes remain unchanged.

- `anytoken.email` (all paths) → `http://hpc-mail.hpc-mail.svc.cluster.local.:8080`
- `ingress.anytoken.email`, path `^/(internal/email|healthz)$` → the same service
- Both hostnames are proxied CNAMEs to `400e2dd2-cd0b-41c6-b0e1-51308b0fb681.cfargotunnel.com`.

The shared tunnel has two running connectors on Aliyun and the 5090 node. Its token is unchanged. The existing direct ingress and its DNS-01 certificate remain as an alternate origin, but the public site and signed mail relay use the tunnel. Ingestion still requires the existing HMAC signature, digest and timestamp. Configuration is managed in the account's Tunnel dashboard; the current Wrangler OAuth grant cannot administer Tunnel configuration via API.

## Incoming transports

The standalone SMTP server accepts configured recipient domains only and never acts as an unauthenticated external relay. The Tencent edge forwards TCP/25 to the application over the cluster network. Internal SMTP has been verified; public receipt uses Cloudflare Email Routing and the signed HTTPS transport below.

`apps/worker/ingress` is a small alternative Cloudflare Email Worker. It forwards incoming raw messages to `/internal/email` over HTTPS. Both sides use a separate `INBOUND_RELAY_SECRET` / `RELAY_SECRET`: HMAC authenticates the timestamp, envelope and content digest before the body is read. The backend enforces a five-minute window and 32 MiB limit, verifies the actual digest, rejects unknown domains and acknowledges only after the original ingestion pipeline stores the message. Storage errors cause SMTP retry, and the existing ingestion key deduplicates retries.

The Worker `hpc-mail-ingress-20261028` is published with `BACKEND_URL=https://ingress.anytoken.email` and a separately installed `RELAY_SECRET`. Catch-all rules for only `anytoken.email`, `freetrips.net` and `gamesgadget.com` point to it. Cloudflare manages their MX/SPF/DKIM records. Existing named rules and website records are preserved. Other candidate domains are configured privately in the app but have not been activated for public mail delivery. Workers requires `redirect: 'manual'`; redirect responses are rejected rather than forwarding signed email elsewhere.

The ordinary account `friend01` owns `astor.wu@freetrips.net` and `friend@anytoken.email`. The former `friend@freetrips.net` was released at the owner's request. Its credentials remain in private deployment files. Real Cloudflare MX delivery to `astor.wu@freetrips.net`, `holegots@gamesgadget.com` and `friend@anytoken.email` has been confirmed in the intended users' inboxes.

External sending and forwarding from the Node runtime require `SMTP_RELAY_URL`. Site-internal delivery works without an external relay. No paid plan has been enabled.

## Validation and operation

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @hpc-mail/worker typecheck:node
TEST_DATABASE_URL=postgres://user:password@localhost:5432/test_database pnpm --filter @hpc-mail/worker test:postgres
pnpm --filter @hpc-mail/worker build:node
docker buildx build --platform linux/amd64 --load -f Dockerfile.k3s -t hpc-mail:release .
```

Use a disposable PostgreSQL database for tests: each test file creates and removes its own schema. The PostgreSQL suite explicitly skips SQLite planner/read-counter assertions and instead checks PostgreSQL index eligibility, concurrent atomic batches, audit-failure rollback and authenticated ingestion. These skips are not claims that SQLite plans were validated on PostgreSQL.

The image is imported to the application node's K3s containerd cache before applying `k3s.yaml`, which deliberately uses `imagePullPolicy: Never`. Update the release tag for each image. Use `scripts/smoke.sh` with credentials supplied through a protected environment. The optional `CURL_CONNECT_TO` pins the verified public origin when the local DNS/proxy still caches an earlier Cloudflare edge address.

The object volume is persistent but local to one node; this is a single-instance deployment, not high availability or an independently verified backup. No backup policy for other applications has been changed.
