# Local infrastructure

The compose file targets Docker Engine on Ubuntu 24.04 and also works with
Docker Desktop for development. A full Ubuntu VM walkthrough is in
[`docs/ops/ubuntu-server.md`](../docs/ops/ubuntu-server.md).
Public console for customers: [`docs/ops/vps-console.md`](../docs/ops/vps-console.md).

```bash
docker compose -f infra/docker-compose.yml up -d
docker compose -f infra/docker-compose.yml ps
npm run db:migrate
npm run db:bootstrap
```

PostgreSQL, Redis, and MinIO bind to loopback only. Application containers
added in later stages will use the `backend` network directly.

`PROCUREMENT_SOURCE_MODE=fixture` remains the safe default. Live search and card
reads are enabled explicitly only where `goszakupki.by` is reachable. The
adapter bootstraps the anonymous cookie session required by the public listing.
