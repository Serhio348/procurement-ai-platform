# Этап 78 — карточка, прочитанная при проверке, открывается без повторного живого чтения

## Цель

После этапа 77 открытие карточки всё ещё стоило живой `procurement.get`:
страница детали делала `GET /api/procurements/:id/card`, и API шёл на
площадку за страницей закупки. При этом та же самая страница **уже была
скачана** в ходе проверки кандидата — `scorePendingHits` звал `fetchCard`,
прогонял карточку через scorer и выбрасывал её, сохраняя только статус.
Открытие платило за второй идентичный запрос (~3–6 с на свободной линии,
дольше в очереди).

Цель: сохранять прочитанную при проверке `ProcedureCard` на кейс и отдавать
её при открытии; живое чтение остаётся только там, где свежесть — смысл
действия (явное «Обновить», watch-проход, reindex).

## Архитектурное решение

1. **`ReviewOutcome.card?: ProcedureCard`.** Исход проверки несёт не только
   вердикт/оценку/статус, но и саму скачанную карточку. `attachCardStatus`
   в `search-review.ts` прикрепляет её к исходу — числовая оценка по-прежнему
   принадлежит коду, модель карточку не трогает.
2. **`scorePendingHits` сохраняет карточку.** При наличии `outcome.card`
   кейс собирается через `applySourceCard(builtCard, outcome.card, now)` —
   тот же код, что hydrate/watch: `sourceCard`, `watchSnapshot`, живой
   заголовок, заказчик, сумма, `live: true`. Заголовок листинга заменяется
   реальным заголовком площадки.
3. **Открытие отдаёт сохранённое.** `GET /card` при наличии `sourceCard`
   возвращает его без обращения к `cardWatch`; `hydrateSourceCard` (decision
   «Следить»/«Участвовать») с параметром `force` пропускает живое чтение,
   когда карточка уже есть. Переход карточки между вкладками после решения
   стал мгновенным.
4. **Явная свежесть.** `GET /card?fresh=1` (кнопка «Обновить» на странице
   детали) и `hydrateSourceCard(next, true)` (reindex при «Участвовать»)
   всегда читают площадку. Watch-проход (`monitorWatch`) живёт на фоновой
   линии и обновляет `sourceCard`/`watchSnapshot` у отслеживаемых карточек
   как раньше.

## Изменённые файлы

- `packages/domain/src/search/review.ts` (`ReviewOutcome.card`)
- `apps/api/src/search-review.ts` (`attachCardStatus` → `card`)
- `apps/api/src/app.ts` (`scorePendingHits` → `applySourceCard`;
  `hydrateSourceCard(force)`; `GET /card` + `?fresh=1`)
- `apps/web/src/api/specialist.ts` (`fetchProcurementCard(id, fetcher, fresh)`)
- `apps/web/src/procurements/ProcurementDetailApp.tsx` (`loadPlatformCard`
  с `fresh`; «Обновить» → `?fresh=1`)
- `apps/api/src/app.test.ts` (две регрессии), `TODO.md` (R43 — этапы 77–78)

## БД

Миграций нет: `sourceCard` и `watchSnapshot` — существующие поля
`SpecialistProcurementCard`, раньше их заполняли только hydrate/watch.

## Тесты

- `serves the platform card fetched during review on open and refetches
  only on fresh`: проверка вернула `outcome.card` → `GET /card` отдаёт её
  без единого `read`; `?fresh=1` → живое чтение.
- `routes the watch pass to monitorWatch and interactive reads to
  cardWatch` (расширен): после decision-hydrate открытие не трогает
  интерактивную линию, `?fresh=1` идёт в неё, watch-pass — в monitor-линию.

## Приёмка

- Открытие карточки из очереди/входящих не вызывает `procurement.get`,
  если проверка уже сохранила страницу — мгновенно.
- «Следить»/«Участвовать» по проверенной карточке не делают повторный
  живой запрос.
- «Обновить» и watch-проход по-прежнему читают площадку.

## Риски и ограничения

- **Свежесть «заморожена» на момент проверки** для неотслеживаемых
  карточек: пока специалист не нажмёт «Обновить» или не возьмёт карточку
  в «Следить», страница показывает снимок на момент score. Это осознанный
  компромисс скорость↔свежесть; снимок маркирован `fetchedAt`.
- Отслеживаемые карточки свежести не теряют — watch-pass перезаписывает
  `sourceCard` каждый проход.
- Карточки, сохранённые до этого этапа (без `sourceCard`), открываются
  по-прежнему живым чтением — деградации нет.
