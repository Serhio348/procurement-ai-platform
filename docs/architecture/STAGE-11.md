# Этап 11 — ReportAgent

**Статус:** узкий сборщик отчёта: уже проверенные карточка, коммерческие
условия, изменения и (если есть) score превращаются в markdown для специалиста.
Модель не пишет отчёт и не ставит оценку. Полный ReportAgent с повторным чтением
документов и Company Knowledge — после MVP.

---

## 1. Цель

Собрать читаемый срез закупки, в котором нет цифр, которых не было во входе.

## 2. Архитектурное решение

- Текст отчёта собирает `compileProcurementReport` в `packages/domain`.
  Агент не просит модель «пересказать закупку».
- Вход — `ReportInput`: `terms`, `changes`, опциональный `ScoreSnapshot`.
  Карточка берётся из скомпилированного контекста.
- Отсутствующие поля попадают в `missing` и в раздел с явной пометкой, а не
  заполняются догадкой.
- `files.put` сохраняет markdown в content-addressed blob, если tool разрешён.
  Без него отчёт всё равно возвращается в payload.
- `telegram.send` запрещён. Доставка — NotificationAgent.

```text
procurement header + ReportInput
  → compileProcurementReport
  → files.put (если в allowlist)
  → ReportOutput
```

Allowlist совпадает со STAGE-0: `memory.get`, `files.put`. `memory.get` не
вызывается: Memory MCP ещё нет.

## 3. Почему именно так

**Код, не пересказ.** Иначе в отчёте появится «аванс 50%» без факта.

**Узкий агент.** STAGE-0 относит полный ReportAgent за MVP. Этот этап закрывает
вертикальный срез «есть что показать специалисту», не открывая повторный поиск
по документам.

**Хранение опционально.** Verify не требует MinIO: in-memory `files.put` на
Documents MCP или пропуск tool.

## 4. Изменения

- контракты `ReportInput` / `ReportOutput`;
- domain-компилятор markdown;
- `ReportAgent`;
- registry: allowlist как в STAGE-0;
- seed: capability `report`.

## 5. Новые файлы

```text
packages/contracts/src/report.ts
packages/domain/src/report/compile.ts
packages/domain/src/report/compile.test.ts
apps/agent-runtime/src/agents/report/agent.ts
apps/agent-runtime/src/agents/report/agent.test.ts
docs/architecture/STAGE-11.md
```

## 6. Изменяемые файлы

- `packages/contracts/src/index.ts`, `contracts.test.ts`
- `packages/contracts/src/seed/electrical-equipment.v1.ts`
- `packages/domain/src/index.ts`
- `apps/agent-runtime/src/registry/capabilities.ts`, `capabilities.test.ts`
- `apps/agent-runtime/src/context/compiler.test.ts`
- `apps/agent-runtime/src/index.ts`, `package.json`
- `README.md`, `AGENTS.md`, `docs/architecture/STAGE-10.md`

## 7. Изменения БД

Нет. Markdown может лежать как blob `files.put`; строка отчёта в PostgreSQL не
пишется.

## 8. Контракты API / MCP / агентов

Новых MCP tools нет. HTTP API нет. Агент не вызывает `documents.search` и не
считает `computeScore`.

## 9. Тесты

- аванс 30% из terms попадает в markdown, 90% не появляется;
- без terms в тексте нет «Аванс: N»;
- оценка без `ScoreSnapshot` явно «ещё не рассчитана кодом»;
- `files.put` сохраняет blob; без tool отчёт всё равно success;
- telegram и memory.get не вызываются;
- компилятор даёт `files.put`, не telegram;
- пустые `sections` не проходят Zod.

Проверка реализации: `npm run verify` — 179 прошедших тестов без площадки
и без LLM-ключа.

## 10. Риски и ограничения

1. **Нет оркестратора.** Terms и changes должен передать вызывающий.
2. **Score только если уже посчитан.** Этот агент формулу не запускает.
3. **Нет UI.** Markdown в payload / blob, не на экране.
4. **Полный отчёт с повторным чтением документов не делается.**

## 11. Критерии приёмки

- [x] отчёт не выдумывает числа;
- [x] модель не участвует;
- [x] telegram режет код;
- [x] `npm run verify` без площадки и LLM;
- [x] отчёт этапа записан.

## 12. Следующий этап

Этап 12 — NotificationAgent: доставить уже собранный отчёт и ChangeEvent
специалисту (inbox / Telegram). Реализовано, см.
[`STAGE-12.md`](STAGE-12.md).
