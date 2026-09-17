# Этап 73 — вид процедуры: поле площадки, не «иная»

## Цель

В консоли у многих закупок вид процедуры показывался как «иная», хотя на
карточке goszakupki.by явно написано «Конкурс с ограниченным участием»,
«Открытый конкурс», «Заявка о ценах…». Особенно на «Слежу»: после гидратации
карточки текст поля не попадал в `kindLabel`, а плитки списка ещё и
обнуляют `rawFields`.

## Решение

1. Listing: колонка «Вид процедуры» пишется в `SearchHit.kindLabel` дословно.
2. Карточка площадки: `rawFields["Вид процедуры закупки"]` уже парсится;
   при `applySourceCard` / live-run это значение копируется в
   `SpecialistProcurementCard.kindLabel`.
3. Отображение (`cardProcedureKindLabel`): сначала поле площадки, затем
   сохранённый `kindLabel` (кроме грубого «иная»), затем подпись по URL
   (`limited` → конкурс с ограниченным участием, `marketing` → заявка о
   ценах, `etrade` → открытый конкурс).
4. Парсер enum: если подпись на странице не распознана, берётся семейство
   из пути (`/limited/`, `/etrade/`, …), а не сразу `other`.

## Изменённые файлы

- `packages/contracts/src/procurement.ts` — `SearchHit.kindLabel`
- `mcp/procurement/src/goszakupki-by-parser.ts`, `goszakupki-by-parser.test.ts`
- `packages/domain/src/specialist/case.ts`, `case.test.ts`, `source-card.ts`,
  `source-card.test.ts`
- `packages/domain/src/search/search-cards.ts`
- `apps/web/src/procurements/ProcurementsApp.tsx`, `MyProcurementsApp.test.tsx`
- `docs/architecture/STAGE-73.md`
- `AGENTS.md`

## Критерии приёмки

- [x] listing сохраняет дословный вид процедуры
- [x] hydrate/`applySourceCard` пишет `kindLabel` из «Вид процедуры закупки»
- [x] «иная» не перекрывает limited / marketing / etrade по URL
- [x] `npm run verify`
