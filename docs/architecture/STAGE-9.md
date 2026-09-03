# Этап 9 — CommercialTermsAgent

**Статус:** агент читает уже извлечённый текст, превращает цитаты со страницы
в факты и собирает `CommercialTerms` кодом. Оценку 0–100 не ставит. Memory MCP
и запись фактов в PostgreSQL остаются следующим наращиванием.

---

## 1. Цель

После ingest документов ответить, какие условия оплаты, аванса, сроков и
гарантии в них написаны, так чтобы каждое число можно было открыть на странице
оригинала.

## 2. Архитектурное решение

- Вход — `CompiledDocumentRef[]` из контекста или payload. Сканы
  `ocr_low_confidence` / `ocr_required` не читаются.
- Поиск только `documents.search` и `documents.get_page`. `procurement.search`
  и `telegram.send` запрещены в registry и не вызываются из кода.
- Явные числа («Аванс 30 процентов») читает `cheapExtractCommercialClaims` в
  `packages/domain`. Модель вызывается, только если дешёвый разбор ничего не
  нашёл, а страницы с коммерческой лексикой уже есть.
- `quoteIsOnPage` — граница provenance: цитата модели, которой нет на странице,
  отбрасывается, а не становится фактом.
- `assembleCommercialTerms` мапит факты на `CommercialTerms`. Разные значения
  одного ключа не разрешаются «по дате» — уходят специалисту.
- Score не считается. `commercialScore` этот агент не импортирует.

```text
CompiledDocumentRef (status=extracted)
  → documents.search (аванс, оплата, …)
  → documents.get_page
  → cheapExtractCommercialClaims
       пусто → DeepSeek JSON claims
  → keepQuotedClaims
  → Fact + Evidence
  → assembleCommercialTerms
```

## 3. Почему именно так

**Цитата проверяется кодом.** Иначе модель спокойно напишет «аванс 90%» со
ссылкой на страницу, где этого нет.

**Дешёвый разбор до модели.** Fixture и типичные формулировки не должны
жечь токены. Неоднозначный «порядок расчётов» остаётся модели.

**Сборка условий — не оценка.** `CommercialTerms.advancePercent` — sourced
поле с `factIds`. Формула 0–100 живёт в `packages/domain/src/scoring` и
вызывается позже.

## 4. Изменения

- контракты `CommercialClaim` / `CommercialExtractionInput` / `Output`;
- `CompiledDocumentRef` в контексте компилятора;
- domain: provenance, cheap extract, assemble;
- `CommercialTermsAgent`, порт модели, DeepSeek-адаптер;
- seed: `memory.get`, чтобы компилятор не вырезал tool будущему Memory MCP.

## 5. Новые файлы

```text
packages/contracts/src/commercial-terms.ts
packages/domain/src/commercial/**
apps/agent-runtime/src/agents/commercial-terms/**
apps/agent-runtime/src/llm/openai-compatible-commercial-extractor.ts
apps/agent-runtime/src/testing/fake-commercial-extractor.ts
docs/architecture/STAGE-9.md
```

## 6. Изменяемые файлы

- `packages/contracts/src/agent.ts`, `index.ts`, `contracts.test.ts`
- `packages/contracts/src/documents.ts`
- `packages/contracts/src/seed/electrical-equipment.v1.ts`
- `packages/domain/src/index.ts`
- `apps/agent-runtime/src/context/compiler.ts`, `compiler.test.ts`
- `apps/agent-runtime/src/registry/capabilities.ts`, `capabilities.test.ts`
- `apps/agent-runtime/src/index.ts`, `package.json`
- `README.md`, `AGENTS.md`, `docs/architecture/STAGE-8.md`

## 7. Изменения БД

Нет. `facts` / `evidence` агент возвращает в `AgentRunOutput` и не пишет в
repositories.

## 8. Контракты API / MCP / агентов

Новых MCP tools нет. Агент использует уже существующие `documents.search` и
`documents.get_page`. `memory.get` в allowlist, но не вызывается: Memory MCP
ещё не реализован.

HTTP API нет. Модель обязана вернуть `{ claims: CommercialClaim[] }`. Поле
score в схеме нет.

`AgentRunOutput.facts[].evidenceIds` по-прежнему `.min(1)`.

## 9. Тесты

- цитата с другим пробелом принимается, выдуманная — нет;
- «Аванс 30 процентов» → факт без модели;
- «ав нс 45» не становится авансом;
- конфликт 30% и 50% не выбирается молча;
- модель с цитатой не со страницы → `needs_human`, фактов нет;
- скан `ocr_low_confidence` не идёт в search;
- нет `documents.search` в allowlist → `permission_denied`;
- компилятор отдаёт hash документов и не даёт `procurement.search`;
- API key не попадает в prompt.

Проверка реализации: `npm run verify` — 162 прошедших теста без живого LLM
и без площадки.

## 10. Риски и ограничения

1. **Нет Memory MCP.** Предыдущие факты закупки агент не читает.
2. **Нет записи в БД.** Повторный прогон снова ходит в documents MCP.
3. **Дешёвые regex узкие.** Свободные формулировки идут в модель; качество
   зависит от цитаты, которую потом проверяет код.
4. **Evidence.location.documentId** пока эфемерный UUID прогона: таблицы
   `procurement_documents` этот агент не заполняет.
5. **Score не вызывается.** Это следующий продуктовый шаг после фактов, не
   часть агента.

## 11. Критерии приёмки

- [x] факт без цитаты на странице не проходит;
- [x] модель не ставит score;
- [x] конфликт равных значений эскалируется;
- [x] tools режет код, не промпт;
- [x] вопросы на русском;
- [x] `npm run verify` без живого LLM и без площадки;
- [x] отчёт этапа записан.

## 12. Следующий этап

Этап 10 — мониторинг: изменения статуса, сроков и hash документов по уже
отобранной закупке. Параллельно можно подключить Memory MCP, чтобы факты
этого этапа переживали перезапуск процесса.
