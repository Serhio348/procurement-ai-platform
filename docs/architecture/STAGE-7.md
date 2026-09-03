# Этап 7 — DomainSearchAgent

**Статус:** универсальный поисковый агент ищет закупки по Domain Profile,
отсекает явный мусор кодом и отдаёт неоднозначные заголовки модели. Карточки
не сохраняются в БД, документы не скачиваются, итоговый score не считается.

---

## 1. Цель

Найти кандидатов по профилю направления и ответить на вопрос специалиста
«этот конкурс наш?», не превращая DomainSearchAgent в отраслевой класс и не
отдавая модели право ставить оценку 0–100.

## 2. Архитектурное решение

- Один runtime `DomainSearchAgent` для любого профиля. Тема поиска — данные
  профиля (ключевые слова, исключения, критерии), не `if (title.includes("КТПБ"))`
  в коде агента.
- Поиск идёт через `ProcurementMcpClient` и Tool Policy Gate. Агент вызывает
  только tools из скомпилированного `allowedTools`.
- `excludeKeywords` **не** передаются в `procurement.search`. Площадка ищет по
  ключевым словам; исключения применяются после ответа, в
  `cheapClassifyHit`.
- Дешёвая классификация живёт в `packages/domain`: exclude побеждает keyword;
  точное вхождение ключевого слова можно принять без LLM; остальное — ambiguous.
- DeepSeek классифицирует только ambiguous-заголовки. Для них агент может
  взять карточку через `procurement.get`, если инструмент разрешён.
- Выход — `DomainSearchCandidate[]` с `verdict`, `confidence`, `reason` на
  русском и `needDeeper`. Нет поля score.

```text
MinimalAgentContext.domainProfile
  → SearchQuery(keywords, excludeKeywords=[])
  → procurement.search
  → cheapClassifyHit
       exclude → irrelevant
       keyword → relevant, needDeeper
       ambiguous → DeepSeek JSON (optional get)
  → DomainSearchOutput
```

## 3. Почему именно так

**Код отсекает очевидное, модель читает неоднозначное.** Иначе либо все
карточки идут в LLM, либо синонимы вроде «распределительное устройство»
теряются.

**Исключения не отправляются на площадку.** Это правило профиля: минус-слова
фильтруют выдачу у нас, а не становятся поисковым запросом goszakupki.by.

**Score считает другой слой.** Классификатор говорит relevant/irrelevant/
needs_human. Формула 0–100 остаётся в `packages/domain/src/scoring`.

## 4. Изменения

- контракты `DomainSearchInput` / `DomainSearchCandidate` / `DomainSearchOutput`;
- `cheapClassifyHit` в домене;
- `DomainSearchAgent` с MCP-клиентом и портом классификатора;
- OpenAI-совместимый адаптер DeepSeek и fake для тестов;
- factory из env + уже существующего MCP caller.

## 5. Новые файлы

```text
packages/contracts/src/domain-search.ts
packages/domain/src/search/cheap-classify.ts
packages/domain/src/search/cheap-classify.test.ts
apps/agent-runtime/src/agents/domain-search/agent.ts
apps/agent-runtime/src/agents/domain-search/agent.test.ts
apps/agent-runtime/src/agents/domain-search/factory.ts
apps/agent-runtime/src/agents/domain-search/model-port.ts
apps/agent-runtime/src/llm/openai-compatible-search-classifier.ts
apps/agent-runtime/src/llm/openai-compatible-search-classifier.test.ts
apps/agent-runtime/src/testing/fake-search-classifier.ts
docs/architecture/STAGE-7.md
```

## 6. Изменяемые файлы

- `packages/contracts/src/index.ts`
- `packages/contracts/src/contracts.test.ts`
- `packages/domain/src/index.ts`
- `apps/agent-runtime/src/index.ts`
- `apps/agent-runtime/package.json`
- `README.md`
- `AGENTS.md`
- `docs/architecture/STAGE-6.md`

## 7. Изменения БД

Нет. Агент не создаёт `ProcurementCase` и не пишет `relevance_assessments`.
Это появится вместе с оркестратором исполнения плана.

## 8. Контракты API / MCP / агентов

HTTP API не добавлен. Набор MCP tools не изменился. Агент использует
`procurement.search` и при необходимости `procurement.get`. `telegram.send` и
документы не вызываются, даже если ошибочно попали в allowlist — их нет в
коде агента.

`AgentRunOutput.nextRecommendedCapability` может предложить `document_ingest`.
Supervisor по-прежнему решает, запускать ли его.

## 9. Тесты

- keyword-hit не вызывает модель и не шлёт exclude на площадку;
- exclude побеждает keyword в заголовке;
- ambiguous-заголовок идёт в модель, telegram не вызывается;
- нет `procurement.search` в allowlist → `permission_denied` без MCP;
- исчерпан лимит классификации → `needs_human`, модель не вызывается;
- candidate не принимает числовой score вместо verdict;
- API key не попадает в prompt классификатора.

Проверка реализации: `npm run verify` — 130 прошедших тестов без LLM-ключа
и без площадки.

## 10. Риски и ограничения

1. **Нет сохранения кейсов.** Повторный поиск снова сходит на площадку.
2. **Оценка токенов/карточки урезана.** В модель уходят заголовок, лоты и
   ограниченный `rawFields`, не HTML страницы.
3. **Лимит классификаций** (20 на прогон) защищает живой источник. Лишние
   ambiguous уходят специалисту.
4. **`associatedMcpTools` профиля по-прежнему сужает get.** Если tool не в
   профиле, классификатор работает только по строке списка.

## 11. Критерии приёмки

- [x] один агент на все профили, не агент «электрооборудование»;
- [x] exclude не уходит в search query;
- [x] модель не ставит score;
- [x] права на tools проверяет код;
- [x] вопросы и причины на русском;
- [x] `npm run verify` без живого LLM и без площадки;
- [x] отчёт этапа записан.

## 12. Следующий этап

Этап 8 — Document MCP + DocumentAgent: скачивание и извлечение текста по
уже отобранным релевантным процедурам. Реализовано, см. [`STAGE-8.md`](STAGE-8.md).
