# Этап 21 — живой поиск goszakupki.by из консоли

**Статус:** кнопка «Искать по профилю» вызывает `procurement.search` через
MCP-клиент. Адаптер площадки остаётся в MCP. API его исходники не импортирует.
Документы не скачиваются, модель не вызывается, оценка 0–100 не считается.

---

## 1. Цель

Специалист из консоли видит актуальные процедуры goszakupki.by по Domain
Profile, а не только fixture JSON.

## 2. Архитектурное решение

```text
кнопка «Искать по профилю»
  → POST /api/procurements/search { limit? }
  → PROCUREMENT_SOURCE_MODE=live
       → stdio Procurement MCP (goszakupki_by)
       → procurement.search(keywords профиля)
  → selectRelevantSearchCards
  → catalog.upsertCase
```

- `apps/api` импортирует `@procurement/mcp-client`, не `mcp/procurement`.
- Дочерний процесс MCP владеет HTML и cookie-сессией.
- Тело HTTP по-прежнему без `keywords`. Тема — данные профиля.
- Tool Policy Gate разрешает только `procurement.search`. `get` / documents
  с консоли недоступны.
- `PROCUREMENT_SOURCE_MODE=fixture` (CI и тесты) читает JSON, как на этапе 20.
- Карточки с `sourceId=goszakupki_by` помечаются `live`.
- Live-консоль не сеет `inbox.json` и `live-run.json`: список пуст, пока
  специалист не нажмёт «Искать по профилю».

```text
Specialist API  --stdio-->  Procurement MCP  -->  goszakupki.by
                         (не import mcp/)
```

## 3. Почему именно так

**Граница слоёв.** Живой HTML нельзя тащить в Fastify. Иначе вторая площадка
полезет в API. MCP-клиент — уже существующий порт.

**Stdio, не in-process server.** `createProcurementMcpServer` живёт в `mcp/`.
Импорт уронил бы `api-does-not-import-ui-or-mcp`.

**Один tool.** Консольный поиск не должен скачивать карточки и файлы.

## 4. Изменения

- порт `createProcurementSearchHits` над `ProcurementMcpClient`;
- stdio-подключение MCP при `PROCUREMENT_SOURCE_MODE=live`;
- 503/504, если площадка недоступна или поиск превысил timeout;
- адаптер перестаёт ходить за следующим ключевым словом, когда `limit` набран;
- Vite proxy timeout 180 с.

## 5. Новые файлы

```text
apps/api/src/procurement-search.ts
apps/api/src/procurement-search.test.ts
apps/api/src/procurement-mcp.ts
apps/api/src/load-env.ts
docs/architecture/STAGE-21.md
```

## 6. Изменяемые файлы

- `apps/api/src/app.ts`, `app.test.ts`, `main.ts`, `package.json`, `tsconfig.json`
- `mcp/procurement/src/goszakupki-by-source.ts` (+ тест)
- `packages/domain/src/search/search-cards.ts` (+ тест)
- `apps/web/src/api/specialist.ts` (+ тест)
- `apps/web/src/procurements/ProcurementsApp.tsx`
- `apps/web/vite.config.ts`
- `AGENTS.md`, `README.md`, `docs/architecture/STAGE-20.md`

## 7. Изменения БД

Нет.

## 8. Контракты API / MCP / агентов

HTTP тот же: `POST /api/procurements/search`.

Ошибки:

- `503 { error: "source_unavailable" }`
- `504 { error: "search_timeout" }`
- `502 { error: "search_failed" }`

Новых MCP tools нет. DomainSearchAgent не вызывается.

## 9. Тесты

- MCP-порт вызывает `procurement.search` с `goszakupki_by` и keywords профиля,
  не вызывает `procurement.get`;
- заблокированный источник → 503 и пустой каталог;
- адаптер не запрашивает второе слово, если `limit` уже набран;
- UI: нет текстового поля, живая карточка, русская ошибка площадки;
- fixture-поиск этапа 20 без сети по-прежнему зелёный.

## 10. Риски и ограничения

1. Каждое ключевое слово профиля — отдельный запрос к `/tenders/posted`, пока
   не наберётся `limit`. При 20 RPM поиск может занять десятки секунд.
2. Синонимы и словоизменение без модели не принимаются.
3. Нужна белорусская сеть и анонимная cookie-сессия. CI остаётся на fixture.
4. Каталог по-прежнему в памяти процесса API.
5. Stdio MCP стартует вместе с API в live-режиме; без него кнопка снова
   читает fixture JSON.

## 11. Критерии приёмки

- [x] API не импортирует `mcp/`;
- [x] live-поиск идёт в `procurement.search` с keywords профиля;
- [x] `npm run verify` без живого LLM и без площадки;
- [x] при `PROCUREMENT_SOURCE_MODE=live` консоль ходит на goszakupki.by.

## 12. Следующий этап

Редактор профиля, решения специалиста и постоянное слежение — см. STAGE-22.
