# Этап 3 — Procurement MCP

**Статус:** реализовано. Source-neutral MCP и fixture-режим готовы; live
`goszakupki.by` намеренно не реализован без проверенных HTML-образцов.

---

## 1. Цель

Дать агентам и будущим application use cases единый типизированный интерфейс
поиска и чтения закупок, не связывая их с конкретной площадкой, базой данных
или бизнес-профилем.

## 2. Архитектурное решение

- `mcp/procurement` — MCP stdio server с семью read-only tools.
- `ProcurementSourcePort` — единственная граница между tools и источником.
- `FixtureProcurementSource` читает нормализованный JSON и не использует сеть.
- `packages/mcp-client` валидирует вход/выход, ограничивает timeout, переносит
  correlation ID и проверяет права до вызова MCP.
- Tool Policy Gate вычисляет пересечение agent/profile allowlists, затем
  применяет agent/system denylists.
- MCP и source adapter не импортируют DB, application, workers или
  `DomainProfile`.

## 3. Почему именно так

**MCP не является хранилищем.** Он возвращает состояние внешнего источника.
Идемпотентный upsert в PostgreSQL выполняется будущим application workflow выше
MCP.

**Source DTO отделены от persistence DTO.** Площадка не знает внутренние UUID
`ProcurementId`, `LotId`, `DocumentId`. Поэтому `SourceLot`,
`SourceDocument`, `SourceClarification` и `SourceChange` не требуют внутренних
идентификаторов. Они назначаются только при сохранении.

**Профиль не пересекает source boundary.** MCP получает только нейтральный
`SearchQuery`. Передача `domainProfile` отклоняется strict Zod schema.

**Неизвестное не угадывается.** Sparse card допустима, status может остаться
`unknown`, date-only сохраняется календарной датой с timezone.

**Fixture не выдаётся за goszakupki parser.** Синтетический corpus проверяет
wire protocol и четыре семейства страниц, но не CSS/HTML площадки. Реальный
адаптер остаётся этапом 4.

## 4. Реализованные tools

- `procurement.search`
- `procurement.get`
- `procurement.get_status`
- `procurement.get_lots`
- `procurement.get_documents`
- `procurement.get_history`
- `procurement.get_changes`

Все tools помечены MCP annotations как read-only, idempotent и open-world.
Успешный ответ содержит текстовый JSON и `structuredContent`.

## 5. Изменения контрактов

- добавлен `ProcurementGetStatusResponse`
- добавлен `ProcurementSourcePort.getStatus`
- request envelopes сделаны strict
- добавлены именованные aliases запросов для status/lots/documents/history
- source-native DTO отделены от сохранённых сущностей
- `ProcedureCard.lots` теперь содержит `SourceLot[]`

## 6. Новые файлы

```text
packages/mcp-client/package.json
packages/mcp-client/tsconfig.json
packages/mcp-client/src/call-tool.ts
packages/mcp-client/src/procurement-client.ts
packages/mcp-client/src/tool-policy.ts
packages/mcp-client/src/*.test.ts
packages/mcp-client/src/index.ts

mcp/procurement/package.json
mcp/procurement/tsconfig.json
mcp/procurement/README.md
mcp/procurement/src/main.ts
mcp/procurement/src/server.ts
mcp/procurement/src/source-registry.ts
mcp/procurement/src/fixture-source.ts
mcp/procurement/src/*.test.ts
mcp/procurement/src/index.ts

tests/fixtures/procurement/normalized.json
docs/architecture/STAGE-3.md
```

## 7. Изменяемые файлы

- `packages/contracts/src/procurement.ts`
- `packages/contracts/src/source-port.ts`
- `packages/contracts/src/contracts.test.ts`
- `package.json`, `package-lock.json`
- `tsconfig.json`
- `eslint.config.js`
- `.dependency-cruiser.cjs`
- `README.md`
- `AGENTS.md`

## 8. Изменения БД

Нет. Procurement MCP не читает и не изменяет PostgreSQL.

## 9. Контракты API / MCP / агентов

HTTP API и агенты не добавлены. Typed client предоставляет методы для всех
семи Procurement tools. Перед транспортом он:

1. проверяет tool policy;
2. валидирует request;
3. передаёт correlation ID через MCP metadata;
4. применяет timeout;
5. маппит source/timeout errors;
6. валидирует `structuredContent`.

## 10. Ошибки

MCP error metadata различает:

- `not_found`
- `source_unavailable`
- `invalid_request`
- `internal`

Typed client дополнительно различает `timeout`, `invalid_output` и общий
`remote_error`.

## 11. Тесты

- wire integration через официальный MCP `InMemoryTransport`
- регистрация всех семи tools
- search include/exclude и Unicode normalization
- card/status/lots/documents/history/changes
- sparse external card
- strict rejection `domainProfile`
- unknown source record
- correlation ID в structured log
- agent/profile/system tool policy
- запрет transport call при denied tool
- malformed output и typed source error mapping
- source-native DTO без внутренних UUID
- date-only без выдуманного времени
- duplicate fixture record rejection

Fixture tests не обращаются в сеть.

## 12. Риски и ограничения

- Синтетические normalised fixtures не подтверждают разметку реального
  `goszakupki.by`.
- Live mode завершается явной ошибкой до появления проверенного адаптера.
- `get_changes` fixture возвращает заранее подготовленные source changes;
  вычисление diff и append-only сохранение появятся в monitoring workflow.
- Fixture search имитирует широкий source search. Финальные relevance и
  activity decisions выполняются выше MCP детерминированным кодом.

## 13. Критерии приёмки

- [x] семь tools доступны через MCP
- [x] request/response проходят Zod
- [x] профиль не пересекает MCP boundary
- [x] denied tool не достигает транспорта
- [x] fixture mode не использует сеть
- [x] MCP не импортирует DB/application
- [x] `npm run verify`
- [x] `npm audit` — 0 vulnerabilities

## 14. Запуск

```bash
PROCUREMENT_SOURCE_MODE=fixture npm run mcp:procurement
```

Это stdio server: терминал будет ждать MCP-клиента. Для автоматической проверки
используется `npm test`.

## 15. Следующий этап

Этап 4 — `GoszakupkiByAdapter`; фактическое решение описано в
[`STAGE-4.md`](STAGE-4.md).
