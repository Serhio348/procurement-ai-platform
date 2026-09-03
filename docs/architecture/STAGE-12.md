# Этап 12 — NotificationAgent

**Статус:** узкий доставщик уже сформированного текста. ReportAgent и
MonitoringAgent по-прежнему не пишут в Telegram. Inbox в памяти процесса,
`telegram.send` в CI не ходит в Bot API.

---

## 1. Цель

Доставить специалисту готовый отчёт или ChangeEvent: inbox всегда, Telegram
только для срочного, если есть разрешённый chat id.

## 2. Архитектурное решение

- `mcp/notifications` публикует `notification.send` и `telegram.send`.
  `procurement.*` и `documents.download` на этом сервере нет.
- Inbox — `MemoryInboxStore` с дедупликацией по `dedupeKey`. Повтор не
  переписывает тело.
- Telegram за портом `TelegramSenderPort`. Fixture/`RecordingTelegramSender`
  только записывает вызов. Live — Bot API `sendMessage`, только с токеном и
  непустым `TELEGRAM_ALLOWED_CHAT_IDS`.
- Маршрут считает `routeNotification` в `packages/domain`: несрочное не
  открывает Telegram. Текст ChangeEvent собирает `compileChangeAlert` из
  уже известных `previous`/`current`. Лимит 4096 символов режет код, не модель.
- `NotificationAgent` не вызывает поиск, не качает документы, не просит LLM
  «пересказать» отчёт.

```text
уже сформированный title/body
  или ChangeEvent[] → compileChangeAlert
  → routeNotification
  → notification.send
  → telegram.send (только urgent + chat)
```

Allowlist совпадает со STAGE-0: `notification.send`, `telegram.send`.
Deny: `procurement.*`, `documents.download`.

## 3. Почему именно так

**Доставка отдельно от содержания.** Иначе MonitoringAgent начнёт слать
сырой diff в чат, а ReportAgent — markdown в обход inbox.

**Код решает канал.** Модель не выбирает «срочность» и не подставляет chat id.

**CI без Telegram.** `NOTIFICATION_TELEGRAM_MODE=fixture` по умолчанию.
Verify не требует бота и не ходит в сеть.

**MCP не пишет PostgreSQL.** Таблица `notification_outbox` с этапа 2 пока не
заполняется. Дедуп живёт в памяти сервера процесса.

## 4. Изменения

- контракты inbox/telegram MCP и `NotificationInput` / `NotificationOutput`;
- domain: маршрут и текст ChangeEvent;
- Notifications MCP + typed client;
- `NotificationAgent`;
- registry: deny `procurement.*` и `documents.download`.

## 5. Новые файлы

```text
packages/contracts/src/notification.ts
packages/domain/src/notification/route.ts
packages/domain/src/notification/message.ts
packages/mcp-client/src/notifications-client.ts
mcp/notifications/**
apps/agent-runtime/src/agents/notification/agent.ts
apps/agent-runtime/src/agents/notification/agent.test.ts
docs/architecture/STAGE-12.md
```

## 6. Изменяемые файлы

- `packages/contracts/src/index.ts`, `contracts.test.ts`
- `packages/domain/src/index.ts`
- `packages/mcp-client/src/index.ts`
- `apps/agent-runtime/src/index.ts`, `package.json`
- `apps/agent-runtime/src/registry/capabilities.ts`, `capabilities.test.ts`
- `tsconfig.json`, `package.json`, `.env.example`
- `README.md`, `AGENTS.md`, `docs/architecture/STAGE-11.md`

## 7. Изменения БД

Нет. `notification_outbox` уже есть с этапа 2 и этим агентом не пишется.

## 8. Контракты API / MCP / агентов

Новые tools: `notification.send`, `telegram.send`.

HTTP API нет. Входящий Telegram (webhook, команды бота) не делается.

Live: `NOTIFICATION_TELEGRAM_MODE=live`, `TELEGRAM_BOT_TOKEN`,
непустой `TELEGRAM_ALLOWED_CHAT_IDS`. Пустой allowlist в live — ошибка
старта и `invalid_request` на `telegram.send`.

## 9. Тесты

- несрочный отчёт → только inbox, telegram не вызывается;
- срочный ChangeEvent → inbox + telegram, `procurement.search` не вызывается
  даже если ошибочно попал в allowlist;
- пустые body и changes → `needs_human`;
- повторный `dedupeKey` не переписывает тело;
- chat вне allowlist → `invalid_request`, HTTP нет;
- live без allowlist не шлёт;
- текст длиннее 4096 обрезается кодом;
- в тексте изменения нет выдуманного «аванс N%».

Проверка реализации: `npm run verify` — 200 прошедших тестов без площадки,
без LLM-ключа и без Telegram-токена.

## 10. Риски и ограничения

1. **Нет оркестратора.** Chat id и `dedupeKey` должен передать вызывающий.
2. **Inbox в памяти.** Рестарт процесса теряет ленту. Outbox в PostgreSQL —
   позже.
3. **Нет email.** STAGE-0 допускал email; MVP — inbox + telegram.
4. **Нет входящего бота.** Только `sendMessage`. Подписка, /start, диалог —
   не этот этап.
5. **UI inbox ещё нет.** Запись есть в MCP; экрана специалиста нет.

## 11. Критерии приёмки

- [x] агент не ищет закупки и не качает документы;
- [x] несрочное не уходит в Telegram;
- [x] текст не выдумывает числа;
- [x] CI не требует Telegram-токен;
- [x] `npm run verify` без площадки и LLM;
- [x] отчёт этапа записан.

## 12. Следующий этап

Этап 13 — веб-интерфейс: специалист видит inbox, отчёт и ChangeEvent.
Входящий Telegram-бот остаётся отдельным наращиванием.
