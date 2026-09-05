# Этап 25 — PostgreSQL, MinIO и Redis для консоли

**Статус:** консоль переживает перезапуск API. Хеши документов живут в
PostgreSQL, байты — в MinIO (S3), повторный поиск по слежению — в Redis.
Без Docker остаются диск и `setInterval`. Telegram и OCR чертежей сюда
не входят.

---

## 1. Цель

Специалист не теряет профили, решения и скачанные файлы после `Ctrl+C`.
Хеш и файл не лежат в одном месте: база знает `sha256` и `storage_key`,
объектное хранилище держит байты.

---

## 2. Архитектурное решение

```text
DATABASE_URL отвечает
  → specialist_workspaces.snapshot
  → specialist_cases.card
  → procurements + procurement_documents + document_versions.hash
     storage_key = blobs/{sha256}

S3_ENDPOINT / MinIO
  → PUT/GET blobs/{sha256}
  → диск data/blobs остаётся scratch и fallback

REDIS_URL
  → BullMQ specialist-discovery (тот же процесс API, не workers/)
  → нет Redis: setInterval, как раньше

CI / нет Docker
  → data/specialist-workspace.json
  → data/blobs/{sha256}
  → in-process timer
```

- API импортирует `@procurement/db`. MCP по-прежнему не читает базу.
- Worker BullMQ крутится внутри процесса API. Пустой `workers/` не
  создаём.
- `HumanDecisionKind` не расширяем: triage специалиста остаётся в
  workspace snapshot и на карточке, не в таблице `decisions`.

---

## 3. Почему именно так

**Хеш ≠ файл.** Повторить «Участвовать» можно, сверив `document_versions.hash`.
Байты можно переложить на другой bucket, не трогая карточки.

**Redis не система записи.** Пропавший Redis не стирает кейсы. Следующий
тик discovery просто не придёт, пока Redis не вернётся; тогда сработает
интервал в процессе.

**Fallback обязателен.** `npm run verify` и тесты без Docker. Живой
контур — `npm run infra:up` и `npm run db:migrate`.

---

## 4. Изменения

- таблицы `specialist_workspaces` и `specialist_cases`;
- `createSpecialistStore`: снимок workspace, карточки, хеши в
  `document_versions`;
- `BlobStore`: MinIO + диск;
- после «Участвовать» байты копируются в объектное хранилище;
- `GET /api/documents/:hash` читает S3, затем диск;
- поиск и discovery пишут кейсы в PostgreSQL;
- discovery на Redis, иначе `setInterval`.

---

## 5. Новые файлы

```text
packages/db/drizzle/0001_specialist_console.sql
packages/db/src/specialist-store.ts
apps/api/src/persist.ts
apps/api/src/object-store.ts
apps/api/src/discovery-queue.ts
apps/api/src/discovery-transport.ts
docs/architecture/STAGE-25.md
```

---

## 6. Изменения БД

- `specialist_workspaces(id, snapshot jsonb, updated_at)`
- `specialist_cases(id, source_procurement_id, card jsonb, updated_at)`
- хеши по-прежнему в существующих `document_versions.hash` + `storage_key`

---

## 7. Критерии приёмки

- [x] без `DATABASE_URL` workspace остаётся JSON-файлом;
- [x] при доступной PostgreSQL профили и кейсы поднимаются после рестарта;
- [x] хеш пишется в `document_versions`, байты — в `blobs/{hash}`;
- [x] Redis задаёт repeatable discovery; нет Redis — интервал в процессе;
- [x] search / monitor / reject по-прежнему не качают файлы;
- [x] `npm run verify` без живой площадки и без обязательного Docker.
