# Этап 31. Компактный профиль и фильтры goszakupki.by

## Цель

Сделать редактор профиля компактным и дать специалисту те же фильтры, что
есть в расширенном поиске goszakupki.by, чтобы поиск отправлялся сразу с
уточнениями и на бокс возвращалось меньше мусора.

## Решение

### Контракт

- `SpecialistWorkingProfile` больше не хранит `instructions` — поле не
  использовалось в консоли. Оно остаётся у `DomainProfile` для агентов.
- Добавлен `SpecialistSearchFilters` (покупатель, УНП, цена, даты,
  вид/регион/статус по кодам площадки).
- `SearchQuery` расширен соответствующими полями; запрос MCP теперь их
  передаёт адаптеру.

### Адаптер goszakupki.by

`searchPath` строит URL с параметрами, полученными от площадки:

- `TendersSearch[unp]` — УНП заказчика.
- `TendersSearch[customer_text]` — заказчик/организатор.
- `TendersSearch[num]` — номер закупки.
- `TendersSearch[price_from/to]` — цена.
- `TendersSearch[created_from/to]` — дата размещения.
- `TendersSearch[request_end_from/to]` — окончание приёма.
- `TendersSearch[auction_date_from/to]` — дата торгов.
- `TendersSearch[type][]` — вид процедуры.
- `TendersSearch[status][]` — статус.
- `TendersSearch[region][]` — область.

### API

- `createProcurementSearchHits.search` теперь принимает `Omit<SearchQuery,
  "sourceId">` — меньше позиционных аргументов.
- `runManualSearch` и фоновое `runDiscovery` собирают `SearchQuery` из
  `profile.filters`, превращая `IsoDate` в `IsoDateTime`.
- `SpecialistWorkspace.#replace` сохраняет `statuses`, `excludeKeywords` и
  `filters` — раньше они терялись при сохранении профиля.

### UI

- Убраны поля «Что ищем» и «Указания»; ключевые слова вводятся и
  отображаются как чипы (Enter или кнопка «Добавить», можно несколько через
  запятую).
- Редактор разбит на секции по карточкам; фильтры размещены в двух
  колонках, что уменьшает вертикальный скролл.
- Добавлены чекбоксы видов процедур и областей с кодами, полученными с
  сайта.

## Изменённые файлы

- `packages/contracts/src/specialist.ts`
- `packages/contracts/src/procurement.ts`
- `packages/domain/src/specialist/workspace.ts`
- `apps/api/src/app.ts`
- `apps/api/src/procurement-search.ts`
- `apps/agent-runtime/src/agents/domain-search/agent.ts`
- `mcp/procurement/src/goszakupki-by-source.ts`
- `apps/web/src/profile/ProfileApp.tsx`
- `apps/web/src/styles.css`

## Тесты

`npm run verify`: 77/79 test files, 353/365 tests, 0 нарушений
зависимостей, 301 модуль / 683 зависимости.
