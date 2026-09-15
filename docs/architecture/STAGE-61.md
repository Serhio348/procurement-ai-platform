# Этап 61 — «Предмет закупки» в оценке релевантности

**Статус:** listing-score по-прежнему смотрит заголовок строки. Если
площадка вернула закупку, а в названии нет объекта, карточка дочитывается
уже существующим `procurement.get`, и `scoreSearchIntent` считает
название **вместе** с `lots[].title` (колонка «Предмет закупки»).

---

## 1. Цель

goszakupki.by ищет по предмету лота. Строка «Выбор субподрядной организации
по объекту в Жлобине» приходит по запросу «АСКУЭ», хотя в заголовке слова
нет. Фильтр списка и listing-score смотрели только title — и отбрасывали
находку площадки.

Нужно учитывать предмет лота тем же универсальным планом (objects /
actions / context), без словарей под НКУ, насосы или АСКУЭ.

## 2. Архитектурное решение

```
procurement.search (как раньше, pagesPerTerm не режем)
  → listingKeepsPlatformHit
       термин в строке списка → оставить
       «НКУ» внутри «конкурс» → выкинуть
       термина в строке нет   → оставить (площадка могла сматчить лот)
  → selectRelevantSearchCards / scoreSearchIntent({ title: hit.title })
       match → сразу в выдачу, get нет
       veto / чужое назначение → discard
       нет объекта в названии → review (лимит MAX_AMBIGUOUS_PER_SEARCH = 50)
  → review: procurement.get
       scoreSearchIntent({ title: procedureIntentText(card) })
         title + lots[].title + lots[].description + positions[].title
       match / veto / discard решают без модели
```

Текст лота передаётся как `title`, не как `extraText`: mention в extra
слабее subject и не дал бы match.

Кнопка «Поиск» по-прежнему не ждёт get: сомнительные в фоне, как этап 59.
Слежение профиля — тот же reviewAmbiguous до persist.

Профили независимы: одна карточка может быть match для монтажа и discard
для поставки НКУ.

## 3. Почему именно так

Открывать карточку на каждую строку списка — это снова минуты и 20 req/min.
Get уже был на review. Меняется только вход в эту очередь: «нет объекта в
названии» больше не discard на listing.

Веса `SEARCH_INTENT_WEIGHTS` не трогали. `SearchIntentPlan` не меняли.
HTTP/MCP контракты не меняли.

## 4. Изменения

Новые:

- `docs/architecture/STAGE-61.md`

Изменённые:

- `packages/domain/src/search/query-terms.ts` — `listingKeepsPlatformHit`
- `packages/domain/src/search/intent-score.ts` — `procedureIntentText`,
  `scoreSearchIntentFromProcedure`
- `packages/domain/src/search/search-cards.ts` — нет объекта в title → review
- `packages/domain/src/search/review.ts` — `reviewByIntentCard`
- `mcp/procurement/src/goszakupki-by-source.ts` — фильтр строки списка
- `apps/api/src/search-review.ts` — intent по карточке до cheapClassify
- `apps/api/src/app.ts` — план в review job и discovery

## 5. Изменения БД

Нет.

## 6. Контракты

Нет. `SearchHit` по-прежнему без лотов. Предмет лота живёт в
`ProcedureCard.lots[].title`.

## 7. Тесты

- площадка вернула строку без ключевого слова в title — адаптер не режет
- «НКУ» в «конкурс» по-прежнему отсев
- профиль монтажа/ПНР: предмет лота с электрооборудованием → match
- тот же профиль: пусконаладка зернового комплекса → не match
- поставка НКУ на той же карточке — отдельный discard
- `npm run evaluate:search` без подгонки весов

## 8. Риски

- Review-очередь до 50 `procurement.get` на поиск: как раньше, плюс хиты
  без объекта в названии. Если кандидатов больше 50, слоты сначала
  получают строки без объекта в title (площадка могла сматчить лот),
  а не title-only «Поставка …» с оценкой ~40. Match по title по-прежнему
  без get.
- PK `workspace_procurements` больше не совпадает с UUID карточки: два
  кабинета с одной закупкой не дерутся за `workspace_procurements_pkey`.
- Fixture `/tenders/posted` не зависит от `text=`: неизвестное слово теперь
  оставляет строки, а не обнуляет выдачу. Live-площадка возвращает только
  то, что сама нашла.
- `extraText` по-прежнему слабый mention. Карточка в него не кладётся.
