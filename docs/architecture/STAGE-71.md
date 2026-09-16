# Этап 71 — deadlock записи профиля и входящих

## Цель

В админке снова появилось две активные ошибки:

1. `Не удалось записать профиль в PostgreSQL … 40P01 deadlock detected`
   (обновление `workspace_inbox` внутри `saveWorkspace`);
2. `Не удалось записать Входящие в PostgreSQL.`
   (insert/upsert в `workspace_inbox` из `saveInbox`).

Оба в одном прогоне поиска ~12:25–12:26 UTC.

## Почему

Этап 68 повесил `pg_advisory_xact_lock` только на `saveWorkspace`. Параллельный
`saveInbox` / `saveCases` шёл без замка и брал row-lock на тех же строках
входящих — классический deadlock. Поиск с `persistEach` и фоновый discovery
часто пишут кабинет одновременно.

## Решение

1. `withWorkspaceWrite` — advisory lock на все писатели кабинета:
   `saveWorkspace`, `saveInbox`, `saveCases`, `removeCases`.
2. Очередь в `persist.ts` на кабинет: полный `persist` (профиль → карточки →
   входящие), `persistWorkspaceOnly` и `removeCases` не чередуются.

Диск по-прежнему пишется до PostgreSQL; при сбое Postgres ошибка в журнал,
копия на диске остаётся.

## Изменённые файлы

- `packages/db/src/workspace-scope.ts`
- `packages/db/src/specialist-store.ts`
- `apps/api/src/persist.ts`, `persist.test.ts`
- `docs/architecture/STAGE-71.md`
- `AGENTS.md`

## Критерии приёмки

- [x] параллельный persist кабинета не теряет последнюю запись на диске
- [x] `npm run verify`
- [ ] на VPS после деплоя новые `40P01` / «Входящие в PostgreSQL» не копятся
  при поиске
