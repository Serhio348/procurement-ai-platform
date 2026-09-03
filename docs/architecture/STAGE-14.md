# Этап 14 — живой inbox через HTTP API

**Статус:** консоль больше не читает JSON из бандла. Fastify отдаёт срочные
ChangeEvent из каталога в памяти. NotificationAgent может проецировать событие
в API после MCP-доставки. PostgreSQL `notification_outbox` ещё не подключён.

Исходный план STAGE-0 ставил на этап 14 входящий Telegram. Живая лента inbox
нужнее консоли, поэтому этот номер занят API. Telegram-бот сдвинут.

---

## 1. Цель

Новое срочное изменение появляется в inbox без пересборки фронтенда.

## 2. Архитектурное решение

- `apps/api` — Fastify: `GET /api/inbox`, `POST /api/inbox/events`,
  `GET /api/health`.
- Каталог — `SpecialistCatalog` в `packages/domain`. Старт наполняется
  `tests/fixtures/specialist/inbox.json`.
- POST с тем же `change.id` идемпотентен: повтор даёт 200, новая запись — 201.
- Web ходит в `/api/*` через Vite proxy на порт 3001.
- `npm run web` поднимает API и Vite вместе (`concurrently`).
- NotificationAgent принимает опциональный порт `SpecialistInboxEvents`.
  После успешного MCP `notification.send` проецирует `{ procurement, change }`.
  Сбой проекции не отменяет уже доставленное уведомление.
- Verify не требует Docker: тесты используют `app.inject` и in-memory catalog.

```text
NotificationAgent → MCP notification.send
                 → SpecialistInboxEvents.record
                      POST /api/inbox/events
Web GET /api/inbox
```

## 3. Почему именно так

**API, не JSON в React.** Иначе «живой» inbox — это правка репозитория.

**Память, не outbox.** Таблица есть с этапа 2; MCP и агент не пишут PostgreSQL.
Проекция в API — мост до оркестратора.

**Код по-прежнему рисует diff** через `compileChangeAlert`.

**Проекция не ломает доставку.** Inbox MCP остаётся источником уведомления;
HTTP-каталог — отдельный экран.

## 4. Изменения

- контракты fixture/inbox и ответа `GET /api/inbox`;
- `SpecialistCatalog` в domain;
- пакет `@procurement/api`;
- web читает `/api/inbox` вместо локального JSON;
- NotificationAgent: опциональный `inboxEvents`;
- `npm run web` стартует API и Vite.

## 5. Новые файлы

```text
packages/contracts/src/specialist.ts
packages/domain/src/specialist/catalog.ts
packages/domain/src/specialist/catalog.test.ts
tests/fixtures/specialist/inbox.json
apps/api/**
apps/agent-runtime/src/agents/notification/inbox-events.ts
apps/agent-runtime/src/agents/notification/inbox-events.test.ts
docs/architecture/STAGE-14.md
```

## 6. Изменяемые файлы

- `packages/contracts/src/index.ts`
- `packages/domain/src/index.ts`
- `apps/agent-runtime/src/agents/notification/agent.ts`, `agent.test.ts`
- `apps/agent-runtime/src/index.ts`
- `apps/web/src/main.tsx`, `apps/web/src/api/specialist.ts`
- `apps/web/vite.config.ts`
- `package.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.js`,
  `.dependency-cruiser.cjs`, `.env.example`
- `README.md`, `AGENTS.md`, `docs/architecture/STAGE-13.md`

## 7. Изменения БД

Нет. `notification_outbox` не читается и не пишется.

## 8. Контракты API / MCP / агентов

HTTP:

- `GET /api/inbox` — только `change.urgent === true`;
- `POST /api/inbox/events` — тело `InboxFixtureItem`;
- `GET /api/health`.

Новых MCP tools нет. UI по-прежнему не вызывает MCP.

## 9. Тесты

- GET inbox из fixture без «бытового щитка»;
- POST urgent → GET видит запись, повтор — duplicate;
- агент после MCP вызывает projection;
- сбой projection не меняет status MCP-доставки на failed.

## 10. Риски и ограничения

1. **Память процесса.** Рестарт API возвращает seed из fixture.
2. **Нет polling.** Новое событие видно после следующего `GET` / перезагрузки
   страницы.
3. **Нет outbox.** Оркестратор ещё не связывает MCP и API сам.

## 11. Критерии приёмки

- [x] UI читает inbox с API;
- [x] новое событие видно без правки фронта;
- [x] verify без Docker;
- [x] отчёт этапа записан.

## 12. Следующий этап

Этап 15 — список закупок и карточка кейса. Реализовано, см.
[`STAGE-15.md`](STAGE-15.md).
