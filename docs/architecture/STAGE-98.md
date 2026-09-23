# STAGE-98 · Review-кандидат не тревога и объясняет себя (R34)

## Проблема

Плашка «Тревога» показывалась при любом непустом inbox — включая очередь,
где лежат только `urgent:false` кандидаты на проверку. Специалист видел
тревожный сигнал там, где требуется спокойное решение, а сама строка
кандидата не объясняла, почему закупка попала на проверку: ни профиля,
чей поиск её нашёл, ни причины сомнения scorer'а.

## Решение

- `InboxPage`: «Тревога» взводится только по записям с `urgent:true`.
  Если срочных нет, но записи есть — показывается спокойная плашка
  «На проверку: система не уверена в релевантности кандидатов — решение
  за вами» (amber, как чип review-топика, без красного).
- Контракт `SpecialistInboxEntry` получил два поля:
  - `profileNames` — имена направлений, чей поиск привёл кейс;
  - `reviewReason` — кодовое объяснение оценки (`card.relevanceReason`),
    что именно нужно проверить глазами.
- `presentInbox()` в `app.ts` обогащает записи из `urgentInbox()`:
  `profileIds` карточки → имена профилей через `workspace().findProfile`
  + `profileDisplayName`, `reviewReason` из карточки. Применяется на всех
  четырёх местах отдачи inbox (`GET /api/inbox`, `POST /api/inbox/events`,
  `DELETE /api/inbox/:id`, `POST /api/inbox/:id/resolve`).
- Деталь review-строки: мета-поле «Профиль» (у любой записи с именами) и
  блок «Почему на проверку» с `reviewReason` или честным fallback
  «Система не смогла уверенно определить релевантность — проверьте
  карточку вручную».

Действия не менялись: «Открыть карточку» ведёт кандидата на разбор
(маршрутизация R48 сохранена), «Удалить» убирает из очереди.

## Регрессии

- `InboxApp.test.tsx`: `marks review candidates as needs-attention
  without raising the alarm` — только review → нет «Тревоги», есть
  спокойная плашка, «Почему на проверку», reason и имя профиля;
- `InboxApp.test.tsx`: `keeps the alarm when urgent changes sit next to
  review candidates` — срочное событие рядом с кандидатом → «Тревога»;
- `app.test.ts`: `explains a review candidate with its profile name and
  relevance reason` — API отдаёт `profileNames`/`reviewReason` кандидата.
