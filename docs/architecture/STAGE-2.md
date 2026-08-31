# Этап 2 — Контейнерная инфраструктура и PostgreSQL

**Статус:** реализовано и проверено локально в Linux-контейнерах. Повторный
smoke-test на Ubuntu 24.04 выполняется теми же командами перед развёртыванием.

---

## 1. Цель

Поднять воспроизводимый инфраструктурный контур PostgreSQL 16, Redis и MinIO и
создать постоянную модель данных для дальнейших MCP, workers и приложений.

## 2. Архитектурное решение

- PostgreSQL — система записи для конфигурации, закупок, заданий и аудита.
- Redis с AOF — транспорт очереди, но не единственное место состояния задания.
- MinIO — S3-совместимое хранилище; bucket создаётся идемпотентно.
- Drizzle schema является типизированным описанием, SQL migration — версионируемым
  источником изменения БД.
- Контейнерные порты опубликованы только на `127.0.0.1`.
- Образы закреплены digest, чтобы одинаковая конфигурация запускалась на
  разработческой машине и Ubuntu заказчика.

## 3. Почему принято это решение

**Job recovery.** `job_runs` хранит status, checkpoint, attempt и idempotency
key. Потеря Redis не означает потерю факта о незавершённой работе.

**Append-only аудит.** PostgreSQL-триггеры запрещают UPDATE/DELETE для
`change_events` и `decisions`.

**Provenance не только в Zod.** Deferred constraint triggers не позволяют
зафиксировать `facts` без `fact_evidence` и `risks` без `risk_facts`.

**Seed не перезаписывает специалиста.** `seed_runs` фиксирует однократное
применение `electrical_equipment.v1`. Последующие старты не обновляют и не
восстанавливают профиль.

## 4. Изменения

- Compose: PostgreSQL 16, Redis 7 с AOF, MinIO и init-контейнер bucket
- workspace `@procurement/db`
- 33 таблицы, индексы, foreign keys, checks и append-only triggers
- migration runner и bootstrap runner
- repository implementations для активных профилей, idempotent procurement
  upsert, raw artifacts, change events и job runs
- root scripts `infra:*`, `db:*`
- integration tests на настоящем PostgreSQL

## 5. Новые файлы

```text
infra/docker-compose.yml
infra/README.md
packages/db/package.json
packages/db/tsconfig.json
packages/db/drizzle/0000_spooky_sauron.sql
packages/db/drizzle/meta/*
packages/db/src/client.ts
packages/db/src/schema.ts
packages/db/src/repositories.ts
packages/db/src/migrate.ts
packages/db/src/bootstrap.ts
packages/db/src/db.integration.test.ts
packages/db/src/index.ts
docs/architecture/STAGE-2.md
```

## 6. Изменяемые файлы

- `package.json`, `package-lock.json` — workspace dependencies and scripts
- `tsconfig.json` — project reference на `packages/db`
- `.env.example` — локальные PostgreSQL/Redis/MinIO параметры
- `.dependency-cruiser.cjs` — DB разрешены Node runtime и contracts, но не apps,
  workers или MCP

## 7. Database changes

Основные группы:

- configuration: companies, domain profiles, formulas, seed runs, policies,
  intents, tasks, monitoring rules
- procurement: procedures, external IDs, parties, contacts, lots, positions,
  raw artifacts, documents, versions, clarifications
- analysis: evidence, facts, risks, relevance/activity assessments, score
  snapshots
- operations: job runs, agent runs/tool calls, change events, decisions,
  notification outbox

Ключевые ограничения:

- unique `(source_id, source_record_id)`
- unique document version/hash per logical document
- unique raw artifact hash per procurement
- unique job idempotency key and notification dedupe key
- versioned scoring formula foreign keys
- append-only events/decisions
- fact/risk provenance checked at transaction commit

## 8. API / MCP / Agent contracts

HTTP API и MCP server на этом этапе не добавлены. Репозитории реализуют
инфраструктурную сторону будущих application ports. DB package не импортирует
API, queue, UI или MCP.

## 9. Tests

Проверено:

- compose syntax and service health
- Redis `appendonly=yes`
- MinIO bucket initialization
- migration на чистую отдельную БД
- повторный bootstrap
- seed profile ровно один
- пользовательское изменение seed не перезаписывается
- idempotent procurement upsert
- append-only change event
- запрет факта без evidence

Автоматический `npm test` пропускает DB integration suite без
`TEST_DATABASE_URL`; явный интеграционный прогон обязателен для этапа.

## 10. Риски

- Локальный порт 5432 может быть занят установленным PostgreSQL. Для проверки
  использован `POSTGRES_PORT=55432`; compose поддерживает override.
- Текущие credentials в `.env.example` предназначены только для loopback
  разработки. На сервере заказчика они заменяются secrets.
- Compose проверен в Linux-контейнерах Docker Desktop; перед production нужен
  повтор на Ubuntu 24.04 VirtualBox/сервере.
- Стабильный `drizzle-kit` 0.31.x тянет уязвимый устаревший esbuild loader, а
  безопасный 1.0 RC несовместим со стабильной ORM и форматом migrations.
  Генератор удалён из devDependencies после создания миграции; до безопасного
  стабильного релиза SQL changes проходят явный review.

## 11. Критерии приёмки

- [x] `docker compose config`
- [x] PostgreSQL, Redis и MinIO healthy
- [x] migration проходит на чистой БД
- [x] bootstrap повторяем и не перезаписывает профиль
- [x] DB integration tests проходят
- [x] `npm run verify`
- [x] `npm audit` — 0 vulnerabilities

## 12. Команды проверки на Ubuntu 24.04

```bash
cp .env.example .env
docker compose -f infra/docker-compose.yml up -d
docker compose -f infra/docker-compose.yml ps
npm run db:migrate
npm run db:bootstrap
docker compose -f infra/docker-compose.yml exec postgres \
  createdb -U procurement procurement_stage2_test
TEST_DATABASE_URL="postgres://procurement:procurement@127.0.0.1:5432/procurement_stage2_test" \
  npm test -- packages/db/src/db.integration.test.ts
npm run verify
```
