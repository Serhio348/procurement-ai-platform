# Local infrastructure

The compose file targets Docker Engine on Ubuntu 24.04 and also works with
Docker Desktop for development. A full Ubuntu VM walkthrough is in
[`docs/ops/ubuntu-server.md`](../docs/ops/ubuntu-server.md).

```bash
docker compose -f infra/docker-compose.yml up -d
docker compose -f infra/docker-compose.yml ps
npm run db:migrate
npm run db:bootstrap
```

PostgreSQL, Redis, and MinIO bind to loopback only. Application containers
added in later stages will use the `backend` network directly.

`PROCUREMENT_SOURCE_MODE=fixture` remains the safe default. Anonymous live
search is enabled explicitly only where `goszakupki.by` is reachable.
