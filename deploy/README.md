# HPC Mail on K3s and PostgreSQL

This fork can run the existing application on Node.js with PostgreSQL, PostgreSQL-backed KV and a local persistent object volume. Cloudflare D1, KV and R2 are not needed for this runtime. The original Workers runtime and tests remain available.

The PostgreSQL adapter preserves the application's prepared-statement and transactional batch interfaces. It binds parameters, serializes application write batches with a database advisory lock, translates the SQL constructs used by the application, and installs equivalent native PostgreSQL protections for the last administrator and invitation consumption. New SQL constructs must be covered by the PostgreSQL suite before deployment.

## Current deployment

- Web: `https://mail.multi-agent.wiki`
- Namespace: `hpc-mail`
- Application and object volume: `pve-bigbox-ubuntu-3`
- PostgreSQL: existing `postgres.open-lark.svc.cluster.local` service, dedicated `hpc_mail` database and non-superuser role, application pool maximum 4 connections, role connection limit 8.
- Initial administrator: `holegots`; registration is closed. Passwords and connection credentials are Kubernetes Secrets and private local deployment files, never source files.
- Initial mailboxes: `holegots@multi-agent.wiki`, `holegots@0xolivia.xyz`, `holegots@astergate.cc`, `holegots@seed-diffusion.com`.
- HTTPS: namespace-scoped HTTP-01 issuer `hpc-mail-http01`. SMTP reloads renewed certificates from the Secret volume automatically.

Creating a mailbox in the application does not activate public mail delivery. DNS and an incoming transport must be verified separately.

## Incoming transports

The standalone SMTP server accepts configured recipient domains only and never acts as an unauthenticated external relay. The Tencent edge forwards TCP/25 to the application over the cluster network. Internal SMTP has been verified; public delivery remains unverified in the current deployment.

`apps/worker/ingress` is a small alternative Cloudflare Email Worker. It forwards incoming raw messages to `/internal/email` over HTTPS. Both sides use a separate `INBOUND_RELAY_SECRET` / `RELAY_SECRET`: HMAC authenticates the timestamp, envelope and content digest before the body is read. The backend enforces a five-minute window and 32 MiB limit, verifies the actual digest, rejects unknown domains and acknowledges only after the original ingestion pipeline stores the message. Storage errors cause SMTP retry, and the existing ingestion key deduplicates retries.

Publishing this Worker and enabling Email Routing require Cloudflare Workers and Email Routing write access. The available DNS token cannot publish it. Its source and dry-run are ready; it is not currently deployed. After deployment, configure `RELAY_SECRET`, enable Email Routing only for the four unused mail domains above and point their catch-all rules to `hpc-mail-ingress-20261028`. Existing mail routes on the other six zones must remain untouched. Remove the deployment-created pilot MX before enabling Cloudflare's managed MX records.

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
