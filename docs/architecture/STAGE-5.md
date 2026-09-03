# Этап 5 — Supervisor

**Статус:** планировщик реализован и проверяется без живого LLM. Он принимает
уже структурированные intents и правила, вызывает OpenAI-совместимую модель
через порт и возвращает проверенный `SupervisorPlan`. Исполнение агентов,
MCP-вызовы и Context Compiler остаются следующими этапами.

---

## 1. Цель

Получить координатора, который решает *что делать дальше*, но сам не выполняет
работу: не ищет закупки, не читает HTML, не считает score и не шлёт сообщения.

## 2. Архитектурное решение

- Runtime живёт в `apps/agent-runtime`, а не в API и не в `packages/domain`.
- Вход — `SupervisorRequest`: `requestId`, intents, активные профили,
  `ScopedRule[]`, optional закупка.
- Выход — существующий `SupervisorPlan`. При `needsHuman=true` обязателен
  `humanQuestion` на русском.
- Равносильные конфликты правил разрешает код (`resolveRuleSet`) *до* вызова
  модели. Свежее правило не побеждает автоматически.
- Модель видит компактную проекцию: statement, тип intent, профили и
  capabilities. `rawMessage` и полная история не передаются.
- После ответа модели детерминированный guard проверяет Zod, существование
  профилей, разрешение capability профилем и принадлежность procurement IDs.
- LLM подключается через `SupervisorModelPort`. Реальный адаптер говорит с
  DeepSeek как с OpenAI-совместимым `/chat/completions` и `response_format=json_object`.
  Тесты используют `FakeSupervisorModel`.

```text
Intents + Profiles + Rules
  → resolveRuleSet
  → SupervisorPlanner
  → DeepSeek JSON plan
  → Zod + permission guard
  → SupervisorPlan
```

## 3. Почему именно так

**Модель планирует, код разрешает.** Иначе Supervisor сможет выбрать чужой
профиль, запрещённую capability или проигнорировать конфликт правил.

**Порт, а не SDK в домене.** `packages/domain` остаётся чистым. Смена
DeepSeek на другого OpenAI-совместимого провайдера — смена `LLM_BASE_URL`.

**Нет MCP на этом этапе.** Пока нет Context Compiler и DomainSearchAgent,
вызов площадки из Supervisor нарушил бы правило «координатор не исполняет».

## 4. Изменения

- контракт `SupervisorRequest` и уточнение `SupervisorPlan`;
- статический registry всех `CapabilityId`;
- `SupervisorPlanner` с policy short-circuit и plan guard;
- OpenAI-совместимый HTTP adapter и factory из env;
- fake-модель для детерминированных тестов;
- ESLint и dependency-cruiser для `apps/agent-runtime`.

## 5. Новые файлы

```text
apps/agent-runtime/package.json
apps/agent-runtime/tsconfig.json
apps/agent-runtime/src/index.ts
apps/agent-runtime/src/registry/capabilities.ts
apps/agent-runtime/src/registry/capabilities.test.ts
apps/agent-runtime/src/supervisor/model-port.ts
apps/agent-runtime/src/supervisor/supervisor.ts
apps/agent-runtime/src/supervisor/supervisor.test.ts
apps/agent-runtime/src/supervisor/factory.ts
apps/agent-runtime/src/llm/openai-compatible-supervisor-model.ts
apps/agent-runtime/src/llm/openai-compatible-supervisor-model.test.ts
apps/agent-runtime/src/testing/fake-supervisor-model.ts
docs/architecture/STAGE-5.md
```

## 6. Изменяемые файлы

- `packages/contracts/src/agent.ts`
- `packages/contracts/src/contracts.test.ts`
- `tsconfig.json`
- `package.json`
- `.dependency-cruiser.cjs`
- `eslint.config.js`
- `vitest.config.ts`
- `.env.example`
- `README.md`
- `AGENTS.md`

## 7. Изменения БД

Нет. План пока in-memory. `agent_runs` и task repositories появятся вместе с
оркестрацией исполнения.

## 8. Контракты API / MCP / агентов

HTTP API не добавлен. Семь MCP tools не изменились. Supervisor не вызывает их.

Модель обязана вернуть JSON формы `SupervisorPlan`. Невалидный JSON, пустой
исполняемый план, низкая уверенность и ошибка HTTP становятся эскалацией
человеку, а не частичным запуском агентов.

## 9. Тесты

- search intent → `domain_search` выбранного профиля;
- независимые search и monitoring не теряются;
- конфликт равной силы не вызывает модель;
- capability вне `associatedCapabilities` отклоняется;
- invalid JSON / пустой план / низкая уверенность / 503 → `needsHuman`;
- API key не попадает в prompt;
- `needsHuman` без вопроса не проходит Zod.

Проверка реализации:

- `npm run verify` — 110 прошедших тестов без LLM-ключа, lint/typecheck/architecture без ошибок;
- `npm run build` и `npm audit` — после закрытия этапа.

## 10. Риски и ограничения

1. **Качество плана зависит от модели.** Guard отсекает запрещённое, но не
   заменяет хороший prompt на следующих этапах.
2. **Intent Compiler ещё не реализован.** Supervisor получает уже собранные
   intents, не сырой чат.
3. **Нет цикла исполнения.** `SupervisorPlan.steps` пока никто не запускает.
4. **Секрет LLM только в env.** Логгер уже вырезает `api_key` и `authorization`.

## 11. Критерии приёмки

- [x] `SupervisorPlan` всегда проходит Zod;
- [x] Supervisor не импортирует MCP servers и БД;
- [x] conflict resolver short-circuit до LLM;
- [x] профиль и capability проверяются кодом;
- [x] вопросы человеку на русском;
- [x] DeepSeek подключается как OpenAI-совместимый API;
- [x] `npm run verify` не требует живого ключа;
- [x] отчёт этапа записан.

## 12. Следующий этап

Этап 6 — Context Compiler: сборка `MinimalAgentContext` для шага плана.
Реализовано, см. [`STAGE-6.md`](STAGE-6.md).
