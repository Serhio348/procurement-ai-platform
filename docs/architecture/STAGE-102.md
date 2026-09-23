# STAGE-102 · «Скачать документы» во входящих — фоновый ingest вместо синхронного (R51)

## Проблема

По inbox-строке «добавлены/изменены документы» кнопка «Скачать документы»
визуально ничего не делала, консоль выглядела зависшей. Две причины:

1. **Синхронный ingest внутри HTTP-запроса.** Ветка `action === "documents"`
   в `POST /api/inbox/:id/resolve` делала `await documentIngest.ingest(card)`
   прямо в обработчике. Скачивание с площадки rate-limited (~20 запросов/мин),
   плюс распаковка архивов, OCR и чтение условий — POST висел минутами, кнопка
   крутилась, UI не отвечал.

2. **`window.open` × N после ответа.** UI открывал каждую ссылку из
   `result.documents` отдельным окном. Браузер молча блокирует пачку
   всплывающих окон — «ничего не происходит».

## Решение

**API** (`app.ts`, `/api/inbox/:id/resolve`). Ветка `documents` теперь вызывает
тот же `startParticipateIngest(card)`, что и «Участвовать»:

- dedup через `ingestJobs` (второй клик не плодит задачу);
- `ingesting: "ingest"` persist'ится **до** старта скачивания — после рестарта
  кабинет видит флаг и возобновляет job (R16/R17);
- прогресс через `ingestProgress`, сбой — в журнал (`kind: "documents"`), флаг
  снимается — как у participate-ingest;
- ответ возвращается сразу; `card` перечитывается из каталога после старта
  job и несёт `ingesting: "ingest"` — консоль показывает «скачивается» сразу.

**Семантика resolve изменилась осознанно:** строка разрешается при *принятии*
задачи, а не после успешного скачивания. Раньше сбой держал строку и отдавал
502 — но POST к этому моменту уже висел минуты. Теперь сбой виден через
`ingestProgress` (phase `failed`) и журнал — та же модель, что у «Участвовать».

**UI** (`SpecialistApp.tsx`). `window.open`-цикл удалён:

- `resolve`-обёртка при `action === "documents"` добавляет карточку в
  `ingestingIds` — общий poll прогресса отслеживает job и подтягивает
  финальную карточку при `done`;
- нотис `NoticeStack`: «Документы скачиваются — прогресс на карточке закупки»;
- `InboxRoute.onResolve` ведёт на `inboxOpenTarget(card)` и при `documents`,
  не только при `open` — отслеживаемый кейс открывается в «Моих закупках»,
  где `activeIngest` показывает фазу скачивания.

`inboxDocumentLinks` удалён из domain как мёртвый код: ответ
`SpecialistInboxResolveResponse.documents` остаётся в контракте, но теперь
всегда `[]` — ссылки на скачанные файлы живут на самой карточке.

## Регрессии

- `resolves the documents row immediately while ingest runs in the background`
  (app.test.ts): deferred-ingest — ответ 200 и строка снята **до** завершения
  promise'а ingest'а; карточка в ответе несёт `ingesting:"ingest"`; job
  вызывает реальный ingest асинхронно.
- `starts a background document download and lands on the watched case`
  (SpecialistApp.storage.test.tsx): клик → переход в «Мои закупки» +
  нотис «Документы скачиваются».
- Полный прогон: app.test.ts 85/85, web 123/123, typecheck/eslint/arch чисто.
