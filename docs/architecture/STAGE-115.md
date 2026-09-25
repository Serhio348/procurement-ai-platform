# Этап 115 — Telegram-бот: уведомления и управление без домена

## Проблема

Специалисту нужны push-уведомления на телефон о новых закупках и изменениях по отслеживаемым. Web Push и PWA-установка требуют HTTPS-домен (R66): на production `http://<ip>` service worker не регистрируется, а домена пока нет.

## Решение

Telegram-бот — единственный канал push на телефон, которому не нужен публичный HTTPS-endpoint платформы: api сам ходит в Bot API (исходящее HTTPS) и опрашивает `getUpdates` long polling.

### Хранение (`packages/db`, миграция `0011_specialist_telegram`)

- `specialist_telegram` — привязка `user_id → chat_id`, `username`, `mode` (`all`|`urgent`). `chat_id` уникален: один чат — один кабинет.
- `specialist_telegram_codes` — одноразовые коды привязки, TTL 10 минут, удаляются при потреблении.
- `specialist_telegram_sent` — дедуп доставки `(workspace_id, event_key)`.

### Привязка чата

UI «Профили → Уведомления в Telegram → Подключить» → `POST /api/telegram/link` возвращает `{code, url, expiresInSec}`; deep-link `t.me/<bot>?start=<code>`. Бот на `/start <code>` вызывает `consumeLinkCode` (атомарно, истёкший/чужой код отклоняется) и пишет `upsertLink`. `/stop` или `DELETE /api/telegram` отвязывают чат.

### Уведомления

`POST /api/inbox/events` после записи события вызывает `notifier.notifyInbox(workspaceId, item)`:

- без привязки к workspace — тихий пропуск;
- `mode=urgent` — пропуск несрочных событий (кандидаты), дедлайны и watch-изменения идут;
- `markSent` до `sendMessage` — рестарт между отправкой и маркером не дублирует сообщение (at-most-once; inbox в консоли остаётся durable источником правды);
- текст через `compileTelegramText`/`compileChangeAlert` с HTML-экранированием; кнопки «Открыть в консоли» и «Разобрано» (`callback_data: d:<change.id>`).

### Команды и кнопки

`/start`, `/new` (до 5 открытых inbox-строк через `openCabinet`), `/status`, `/urgent`, `/all`, `/stop`, `/help`. Callback «Разобрано» резолвится через `linkByChat → openCabinet(userId) → catalog.dismiss(changeId)` — чужой чат не может закрыть событие другого кабинета. `answerCallbackQuery` отвечает «Событие закрыто»/«уже закрыто».

### Запуск и деградация

- Без `TELEGRAM_BOT_TOKEN`: `telegram=undefined`, `GET /api/telegram` → `{available:false}`, link → 503, API работает.
- Токен есть, но `getMe` упал на старте: запись в журнал (`Telegram-бот не ответил`), `degraded: ["Telegram"]` в `/api/health`, `components.telegram=false`.
- Polling: один цикл `pollOnce` → `setTimeout(1s)`; ошибки логируются с паузой 5с; `SIGINT/SIGTERM` очищают таймер. Long polling вместо webhook — webhook требует публичный HTTPS.
- `APP_PUBLIC_URL` (фолбэк `AUTH_PUBLIC_URL`/`BETTER_AUTH_URL`) — база кнопки «Открыть в консоли»; http по IP допустим, это просто ссылка.

### API и UI

- `GET /api/telegram`, `POST /api/telegram/link`, `POST /api/telegram/mode` (`all`|`urgent`), `DELETE /api/telegram` — все под auth, в контексте пользователя; токен бота наружу не отдаётся.
- `TelegramConnect.tsx` на странице профилей: статус, создание ссылки (открывает `t.me` в новой вкладке), переключение режима, отключение; честный блок «бот не настроен» при `available:false`.

## Регрессии

- `apps/api/src/telegram.test.ts` — привязка по коду, отклонение чужого/протухшего кода, `/stop`, `/new`, `/urgent`-фильтр, дедуп отправки, авторизация callback, экранирование.
- `apps/api/src/app.telegram.test.ts` — endpoint'ы без бота (503/`available:false`) и со стабом нотификатора, анонс inbox-события.
- `apps/web/src/profile/TelegramConnect.test.tsx` — unavailable-блок, создание ссылки, смена режима, отключение.
