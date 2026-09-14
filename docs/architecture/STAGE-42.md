# Этап 42 — личные кабинеты и изоляция данных

## Цель

Несколько пользователей больше не делят один кабинет `console`. У каждого —
свои профили, решения, входящие и «Мои закупки». Одна и та же процедура
площадки может быть у многих; действия одного не меняют другого.

## Архитектурное решение

Граница владения — `workspace`, не россыпь `user_id` по всем таблицам.
При регистрации создаётся personal workspace и membership `owner`. Позже
та же схема позволит командный кабинет.

Данные разделены:

- **Общие публичные:** `procurements`, документы, `document_versions`, MinIO
  `blobs/{sha256}`. Одна закупка и один файл не копируются.
- **Приватные:** `workspace_profiles`, `workspace_procurements`,
  `workspace_inbox`, `workspace_decisions`, `workspace_review_verdicts`,
  настройки. RLS: `SET LOCAL app.workspace_id`, политика без `BYPASSRLS`
  у роли API (`FORCE ROW LEVEL SECURITY`). Обход только через
  `app.rls_bypass=on` для миграции и системного listing.

Администратор видит пользователей и журнал, не содержимое чужих кабинетов.

`SpecialistProcurementCard.id` — кейс кабинета; `canonicalProcurementId` —
общая строка `procurements`.

## Почему так

Текущий store писал всех в `specialist_workspaces.id='console'` и уникалил
кейсы глобально по `source_procurement_id`. Второй пользователь затирал
первого. Workspace как агрегат сохраняет путь к team-кабинету без новой
нормализации всей БД.

## Изменения

Новые файлы:

- `packages/db/drizzle/0007_personal_workspaces.sql`
- `packages/db/src/workspace-scope.ts`
- `packages/db/src/workspace-backfill.ts`
- `apps/api/src/cabinets.ts`
- `apps/api/src/cabinet-isolation.test.ts`
- `docs/architecture/STAGE-42.md`

Изменённые:

- `packages/contracts` — `WorkspaceId`, `canonicalProcurementId`, `RequestPrincipal`
- `packages/db/src/schema.ts`, `specialist-store.ts`, `migrate.ts`
- `apps/api` — persist, auth principal, per-request cabinet, discovery по всем кабинетам
- `apps/web` — localStorage last-search ids по `userId`

## Database changes

Миграция `0007` создаёт workspace-таблицы и RLS. `npm run db:migrate`
затем идемпотентно клонирует snapshot `console` каждому **active**
пользователю (новые UUID профилей и кейсов, те же document hashes).
Pending получают пустой кабинет при signup/активации. Blob в MinIO не
копируется. Маркер: `workspace_backfill_runs.id = personal_workspaces.v1`.

Legacy `specialist_workspaces` / `specialist_cases` / `specialist_inbox`
остаются для аудита, новые записи туда не пишутся.

Перед продом: `pg_dump` и проверка чисел профилей/кейсов/inbox после
клона.

## Тесты

- db integration: два кабинета, одна canonical procurement, разный triage;
  хеш чужого файла не виден;
- api: два cookie-сессии, чужой UUID даёт 404, профили и inbox не пересекаются;
- web: last-search ids в namespace пользователя.

## Риски

- ALS/enterWith привязывает кабинет к запросу; фоновый discovery обходит
  все workspace id явно.
- RLS на `workspace_members` разрешает строку по `app.user_id`, чтобы
  найти кабинет до того, как известен `workspace_id`.
- Клон исторического общего кабинета всем active может быть избыточен для
  пользователя, который почти не работал — это сознательный выбор этапа.
- Таблицы фактов/задач/job_runs получили nullable `workspace_id` заранее;
  консоль их ещё не заполняет.

## Обновление на сервере

Сделайте дамп, затем как обычно `git pull`, `npm install`, `npm run db:migrate`,
перезапуск API. После миграции каждый активный пользователь увидит копию
прежнего общего кабинета; новые регистрации стартуют с пустого.
