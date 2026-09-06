# Этап 27 — разбор входящих, а не склад сообщений

**Статус:** входящие — очередь. Сообщение либо открывает карточку, либо
скачивает документы, либо обновляет карточку, либо удаляется. После
действия строка исчезает, чтобы лента не копила мусор.

---

## 1. Цель

Специалист не читает входящие как почту. Он разбирает каждое сообщение
и уходит на карточку закупки.

---

## 2. Архитектурное решение

```text
слежение нашло процедуру
  → ChangeEvent kind=procedure_found
  → GET /api/inbox  topic=new_found
  → клик / «Открыть карточку»
  → POST /api/inbox/:id/resolve { action: open }
  → /procurements/:id
  → Отслеживать / Участвовать / Отклонить
  → остальные сообщения этой закупки тоже снимаются

документ изменился → action=documents → ingest + ссылки, строка пропадает
статус / цена     → action=refresh  → поля карточки из ChangeEvent, строка пропадает
любое сообщение   → DELETE или action=dismiss
```

- Тема сообщения считает код (`inboxTopic`), не модель.
- `refresh` копирует уже найденные `previous → current` на карточку.
  Повторный запрос площадки из этого этапа не делается.
- Снятые id пишутся в `workspace.dismissedInboxIds`, чтобы fixture и
  повторный discovery не вернули ту же строку.
- Сами события по-прежнему в памяти процесса. Outbox в PostgreSQL —
  отдельный этап.

---

## 3. Почему именно так

**Очередь, не архив.** Иначе через неделю входящие будут полны старых
отмен и смен цены.

**Действие зависит от вида изменения.** Новая процедура не нуждается в
«обновить карточку»: карточка уже есть. Смена документа не лечится
переходом по ссылке — нужны файлы.

**Код применяет факт.** Модель не пересчитывает цену и не ставит оценку.

---

## 4. Изменения

- `ChangeKind.procedure_found`;
- `SpecialistInboxEntry.topic` / `topicLabel`;
- `POST /api/inbox/:id/resolve`, `DELETE /api/inbox/:id`;
- discovery пишет found-событие;
- решение по карточке снимает входящие этой закупки;
- UI: кнопки «Открыть», «Скачать документы», «Обновить карточку», «Удалить».

---

## 5. Новые файлы

```text
packages/domain/src/specialist/inbox-action.ts
packages/domain/src/specialist/inbox-action.test.ts
docs/architecture/STAGE-27.md
```

---

## 6. Изменяемые файлы

- `packages/contracts/src/procurement.ts`, `specialist.ts`
- `packages/domain/src/specialist/catalog.ts`, `workspace.ts`
- `packages/domain/src/notification/message.ts`, `report/compile.ts`, `monitoring/diff.ts`
- `apps/api/src/app.ts`, `app.test.ts`
- `apps/web/src/inbox/*`, `api/specialist.ts`, `SpecialistApp.tsx`, `main.tsx`, `styles.css`
- `AGENTS.md`

---

## 7. Изменения БД

Нет. `dismissedInboxIds` лежит в JSON-снимке workspace.

---

## 8. Контракты API

- `GET /api/inbox` — только неснятые `urgent` события, с `topic`.
- `POST /api/inbox/:id/resolve` `{ action: open | refresh | documents | dismiss }`.
- `DELETE /api/inbox/:id`.

---

## 9. Тесты

- тема: found → карточка, документ → скачать, статус → обновить;
- dismiss убирает строку и оставляет кейс;
- refresh копирует `cancelled` на карточку;
- discovery создаёт `new_found`; решение снимает его;
- UI показывает действия и не оставляет textbox.

---

## 10. Риски и ограничения

1. События входящих всё ещё не таблица. Рестарт live API очищает ленту;
   снятые id переживают рестарт через workspace.
2. «Обновить карточку» не ходит на goszakupki.by. Это применение уже
   известного diff.
3. «Скачать документы» без ingest только отдаёт уже известные ссылки.

---

## 11. Критерии приёмки

- [x] клик по новой закупке открывает карточку и снимает сообщение;
- [x] у изменения есть действие или удаление;
- [x] после разбора строка не висит;
- [x] `npm test` по затронутым пакетам без живой площадки.
