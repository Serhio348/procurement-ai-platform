# Этап 20 — поиск по профилю из консоли

**Статус:** на списке закупок кнопка «Искать по профилю» запускает отбор
по ключевым словам Domain Profile. Это не чат и не поле ключевых слов.
Документы не скачиваются, модель не вызывается, оценка 0–100 не считается.

---

## 1. Цель

Специалист из консоли получает в работу процедуры, которые уже явно
совпадают с направлением. Тема поиска — данные профиля, не текст запроса.

## 2. Архитектурное решение

```text
кнопка «Искать по профилю»
  → POST /api/procurements/search { limit? }
  → SpecialistSearchHitsPort (по умолчанию fixture JSON)
  → selectRelevantSearchCards(keywords профиля, cheapClassifyHit)
  → catalog.upsertCase
  → список слева / карточка справа
```

- Тело запроса не содержит `keywords`. Лишние поля Zod отбрасывает;
  направление нельзя сменить с клиента.
- `apps/api` не импортирует MCP и `agent-runtime` (правило
  `api-does-not-import-ui-or-mcp`). Живой `goszakupki.by` остаётся за
  адаптером MCP. На этом срезе порт читает
  `tests/fixtures/procurement/normalized.json`.
- В список попадают только `cheapClassifyHit === relevant`. Ambiguous
  заголовки ждут модель (DomainSearchAgent), здесь их нет.
- Карточка поиска: `status: unknown`, цитата площадки в `statusLabel`,
  шаг «Документы ещё не брали».

```text
fixture records
  → SearchHit
  → keyword filter + cheapClassifyHit
       exclude / нет точного слова / синоним → discarded
       точное слово профиля → SpecialistProcurementCard
```

## 3. Почему именно так

**Кнопка, не строка поиска.** Иначе консоль снова станет чатом, а тема
уедет из Domain Profile в HTTP-тело.

**Классификация в domain.** Те же правила, что у DomainSearchAgent:
исключение побеждает, точное вхождение можно принять без LLM.

**Fixture-порт в API.** Иначе пришлось бы нарушить границу слоёв или
тащить Supervisor в Fastify. Смена порта на live MCP — отдельный срез,
контракт `POST /api/procurements/search` уже стабилен.

## 4. Изменения

- контракт `SpecialistSearchRequest` / `SpecialistSearchResponse`;
- `selectRelevantSearchCards` в domain;
- `POST /api/procurements/search`;
- кнопка «Искать по профилю» на списке закупок;
- блок «Что сделано» на карточке, если агент уже оставил шаг.

## 5. Новые файлы

```text
packages/domain/src/search/search-cards.ts
packages/domain/src/search/search-cards.test.ts
docs/architecture/STAGE-20.md
```

## 6. Изменяемые файлы

- `packages/contracts/src/specialist.ts`
- `packages/domain/src/index.ts`, `specialist/case.ts`
- `apps/api/src/app.ts`, `app.test.ts`, `load-fixture.ts`, `index.ts`
- `apps/web/src/api/specialist.ts`, `specialist.test.ts`
- `apps/web/src/procurements/ProcurementsApp.tsx` (+ тесты)
- `apps/web/src/SpecialistApp.tsx`, `main.tsx`, `styles.css`
- `AGENTS.md`, `README.md`, `docs/architecture/STAGE-19.md`

## 7. Изменения БД

Нет.

## 8. Контракты API / MCP / агентов

HTTP:

- `POST /api/procurements/search` — `{ limit?: 1..50 }`, по умолчанию 20.
  Ответ: `profileName`, `relevantCount`, `discardedCount`, полный каталог
  `items` после upsert.

Новых MCP tools нет. DomainSearchAgent не вызывается.

## 9. Тесты

- fixture: «Комплектная трансформаторная подстанция» → карточка;
  «Кабель силовой», «Трансформаторы силовые», «Ремонт трансформаторной
  подстанции» (нет точного «подстанция») → отброшены;
- `POST` с `keywords: ["кабель"]` всё равно не возвращает кабель;
- UI: кнопка есть, текстового поля нет, список пополняется.

## 10. Риски и ограничения

1. Живой поиск goszakupki.by из консоли ещё не подключён: нужен порт к
   Procurement MCP без импорта `mcp/` из `apps/api` (отдельный процесс
   или уже существующий MCP-клиент за границей API).
2. Синонимы и словоизменение («подстанции») без модели не принимаются.
3. Документы, коммерческие факты и score на этом шаге не считаются.
4. Каталог по-прежнему в памяти процесса API.

## 11. Критерии приёмки

- [x] поиск стартует кнопкой, не полем ввода;
- [x] ключевые слова берутся из профиля, не из тела запроса;
- [x] API не импортирует MCP;
- [x] `npm run verify` без живого LLM и без площадки.

## 12. Следующий этап

Живой `procurement.search` за тем же HTTP-контрактом реализован, см.
[`STAGE-21.md`](STAGE-21.md). Дальше — документы найденных процедур,
PostgreSQL outbox или редактор профиля.
