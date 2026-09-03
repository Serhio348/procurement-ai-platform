# Этап 6 — Context Compiler

**Статус:** компилятор собирает `MinimalAgentContext` для шага плана без вызова
модели и без обращения к площадке. Исполнение агентов остаётся следующим этапом.

---

## 1. Цель

Дать агенту только релевантный срез: выбранный профиль, уже разрешённые правила,
текущую закупку и явную allowlist инструментов. Не передавать всю историю
специалиста, все профили и все задачи.

## 2. Архитектурное решение

- Компилятор живёт в `apps/agent-runtime` рядом с Supervisor. Это детерминированный
  код, не LLM-шаг.
- Вход — `ContextCompileRequest`: событие, capability, опциональные
  `domainProfileId` / `procurementId`, intents, профили, правила, история.
- Выход — `ContextCompilation`: либо `compiled` + `MinimalAgentContext`, либо
  `needs_human` с вопросом на русском.
- Срезы берутся только из `AgentDefinition.contextRequirements`. Notification
  не получает Domain Profile, даже если профили есть во входных данных.
- `allowedTools` — пересечение allowlist агента и профиля минус denylist.
  Считает тот же `ToolPolicyGate`, который позже не пустит вызов в MCP.
- История фильтруется по текущей закупке или профилю, лимит N, свежее важнее.
- Бюджет токенов задан на роли (`maxContextTokens`). Сначала выбрасывается
  старая история, затем проза профиля. Активные constraints не урезаются:
  если не влезли — эскалация человеку.

```text
SupervisorPlan step + scoped state
  → resolveRuleSet
  → ContextCompiler
  → Zod MinimalAgentContext
  → (этап 7) агент видит только этот контекст
```

## 3. Почему именно так

**Модель не выбирает, что ей читать.** Иначе 50 профилей снова окажутся в
промпте, а запрещённый инструмент «случайно» всплывёт в тексте.

**Политика сильнее бюджета.** Урезать правило, чтобы влезли ключевые слова, —
тихий override. Лучше спросить специалиста.

**Порт инструментов не расширяется.** Компилятор только перечисляет то, что
шлюз и так разрешит. Prompt не является границей безопасности.

## 4. Изменения

- контракты `ContextCompileRequest` и `ContextCompilation`;
- `AgentDefinition.maxContextTokens`;
- `ToolPolicyGate.allowedTools()`;
- `ContextCompiler` со short-circuit конфликтов и подгонкой бюджета;
- тесты отбора, изоляции профилей, истории, бюджета и эскалации.

## 5. Новые файлы

```text
apps/agent-runtime/src/context/compiler.ts
apps/agent-runtime/src/context/compiler.test.ts
docs/architecture/STAGE-6.md
```

## 6. Изменяемые файлы

- `packages/contracts/src/agent.ts`
- `packages/contracts/src/capability.ts`
- `packages/contracts/src/contracts.test.ts`
- `packages/mcp-client/src/tool-policy.ts`
- `packages/mcp-client/src/tool-policy.test.ts`
- `apps/agent-runtime/src/registry/capabilities.ts`
- `apps/agent-runtime/src/index.ts`
- `apps/agent-runtime/package.json`
- `apps/agent-runtime/tsconfig.json`
- `eslint.config.js`
- `.dependency-cruiser.cjs`
- `README.md`
- `AGENTS.md`

## 7. Изменения БД

Нет. Компилятор не читает PostgreSQL: вызывающий код передаёт уже выбранные
строки. Репозитории истории появятся вместе с исполнением агентов.

## 8. Контракты API / MCP / агентов

HTTP API не добавлен. MCP tools не изменились. Компилятор не вызывает их.

`MinimalAgentContext.allowedTools` — напоминание модели. Реальный запрет
по-прежнему в Tool Policy Gate.

Срезы `documents` и `company_knowledge` есть в `contextRequirements`, но в
`MinimalAgentContext` для них ещё нет полей. Компилятор их не выдумывает.

## 9. Тесты

- search получает только выбранный профиль и не видит `rawMessage`;
- notification не получает Domain Profile и search-инструменты;
- история чужой закупки отбрасывается, лишние старые записи обрезаются;
- конфликт равной силы не собирает контекст;
- constraints, которые не влезают в бюджет, эскалируются, а не урезаются;
- проза профиля ужимается раньше ключевых слов;
- capability вне профиля отклоняется.

Проверка реализации: `npm run verify` — 119 прошедших тестов без LLM-ключа,
lint/typecheck/architecture без ошибок.

## 10. Риски и ограничения

1. **Оценка токенов приблизительная** (`длина JSON / 3`), без словаря DeepSeek.
   Это потолок компилятора, не биллинг.
2. **`associatedMcpTools` профиля сужает инструменты.** Если в seed не перечислен
   tool связанной capability, агент его не увидит. Это данные профиля, не баг
   компилятора.
3. **Нет загрузки из БД.** Историю и кейс должен передать оркестратор.
4. **Агенты ещё не исполняются.** Контекст пока никто не отправляет в модель
   поиска.

## 11. Критерии приёмки

- [x] агент видит один профиль, не все;
- [x] constraints не выбрасываются молча;
- [x] `allowedTools` совпадает с решением Tool Policy Gate;
- [x] вопросы человеку на русском;
- [x] компилятор не импортирует MCP servers и БД;
- [x] `npm run verify` не требует живого LLM;
- [x] отчёт этапа записан.

## 12. Следующий этап

Этап 7 — DomainSearchAgent: поиск и первичная классификация найденных закупок
по скомпилированному профилю. Там модель читает карточки, а не составляет план.
