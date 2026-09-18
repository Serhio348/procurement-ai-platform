# Этап 79 — дедуп журнала решений: квадратичный рост `workspace_decisions` остановлен (R45)

## Цель

После этапов 77–78 открытие карточки всё ещё занимало 7–29 с, хотя обращений
к площадке не было. Лог `slow request` показал: тормозит сам API —
`GET /api/inbox` до 3.1 с, `POST .../resolve` до 4.9 с, при пустом журнале
MCP-вызовов и простаивающем сервере.

## Коренная причина

`writeWorkspaceState` (пакет `db`) при каждом `saveCabinet` дедуплицировал
журнал решений ключом `sourceProcurementId:kind:madeAt`, где `madeAt` из БД —
это `timestamptz` (`Date`/`"2026-09-18 11:25:41"`), а входящий — ISO-строка
(`"2026-09-18T11:25:41.807Z"`). Ключи не совпадали **никогда**: каждая запись
кабинета вставляла всю историю решений заново, по одному INSERT на строку,
внутри advisory-lock транзакции.

Рост экспоненциальный (таблица удваивалась на каждую запись): за дни
`workspace_decisions` достигла **322 073 строк при 139 уникальных решениях**;
снимок workspace на диске — **41 МБ**. Каждое действие специалиста — resolve,
decision, persist после каждой scored-карточки поиска — делало SELECT сотен
тысяч строк и до сотен тысяч INSERT'ов, а синхронная обработка результата
блокировала event loop для всех запросов.

## Решение

1. **`workspaceDecisionKey`** — ключ дедупликации нормализует обе стороны
   через `toIsoDateTime`: `Date` из БД и ISO-строка снимка дают одинаковый
   ключ.
2. **Batch-INSERT + `onConflictDoNothing`** вместо INSERT-цикла.
3. **Миграция `0010_dedupe_workspace_decisions`**: удаляет все копии кроме
   одной на `(workspace_id, source_procurement_id, kind, made_at)` и
   добавляет уникальный индекс — повторный разгон невозможен на уровне БД.
4. **`slow request` лог** (`onResponse`, >500 мс) в API — отделяет серверное
   время от сетевого при будущих жалобах на скорость.
5. **`resolve` отдаёт slim-карточку** — консоль использует только `card.id`
   для навигации; полная карточка (с `sourceCard`) больше не ездит в ответе
   resolve, страница детали забирает её через `GET /procurements/:id`.

## Изменённые файлы

- `packages/db/src/specialist-store.ts` (`workspaceDecisionKey`, batch insert)
- `packages/db/src/specialist-store.test.ts` (регрессия ключа)
- `packages/db/drizzle/0010_dedupe_workspace_decisions.sql` + `meta/_journal.json`
- `apps/api/src/app.ts` (slow-request log, slim resolve card)

## БД

Миграция `0010`: `DELETE` дублей по `ctid` + `CREATE UNIQUE INDEX
workspace_decisions_dedupe_idx`. На VPS: 322 073 → ~300 строк.

## Тесты

- `workspaceDecisionKey produces the same key for a timestamptz Date and an
  ISO string so dedup matches` — прямая регрессия на баг формата.
- Полный `verify`: 639 + 80 тестов, типы/линт/архитектура зелёные.

## Приёмка

- Любое действие не вызывает INSERT уже существующих решений; таблица растёт
  только на реально новые решения.
- `slow request` в журнале показывает серверное время каждого запроса >500 мс.

## Риски и ограничения

- Снимок workspace продолжает нести **полный** журнал решений — после чистки
  это сотни строк, но семантически хватает последнего решения на закупку
  (`latestTriage`, `rejectedSourceIds`, `lastWorkingKind`). Отдельная проработка
  в рамках R12: хранить в снимке только latest-per-source.
- Файл `data/workspaces/<id>.json` перезаписывается маленьким при первой же
  записи после миграции — ручная чистка не нужна.
- Миграция `DELETE` на ~322 тыс. строк — одноразовая, на VPS секунды.
