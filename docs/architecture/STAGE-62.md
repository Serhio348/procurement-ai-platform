# Этап 62 — аудит поиска: retrieval и relevance, трассировка, объект из фразы работ

**Статус:** поиск площадки не менялся — он уже был по одной фразе на запрос.
Исправлена стадия relevance и добавлена трассировка, из-за отсутствия которой
проблему приписывали retrieval.

---

## 1. Цель

Жалоба: «поиск склеивает фразы профиля в одну строку, площадка ничего не
находит, а то, что находит, отсеивается неправильно». Требовалось разделить
retrieval и relevance, доказать, что каждая фраза профиля доходит до
goszakupki.by, и понять, где теряются подходящие закупки.

## 2. Что показал аудит

Гипотеза о склейке не подтвердилась. `GoszakupkiBySource.search` с этапа 61
делает отдельный `GET /tenders/posted?TendersSearch[text]=<фраза>` на каждую
фразу и объединяет бакеты round-robin. Дефекты были в другом:

| # | Где | Что |
|---|---|---|
| S1 | `inferSearchIntentPlan` | фраза работ «монтаж электрооборудования» целиком уходила в `desired_actions`; объекта «электрооборудование» в плане не было. «Наладка электрооборудования» и «электромонтажные работы» из-за пропуска стеммера становились *объектами*-фразами |
| V1 | следствие S1 | «Монтаж электрооборудования РП с ТП, АСКУЭ, ПНР» на реальном профиле из шести фраз — `discard 35`, «целевое оборудование не найдено» |
| V2 | `outcomeFromIntentCard` | любой `discard` по карточке → `irrelevant`, уверенность 1, вердикт запоминался на 30 дней. Модель видела только `review` (пропуск назначения) |
| V3 | `stemWord` | «сети» ≠ «сетей»: основа короче 4 букв не обрезалась |
| L1 | адаптер | `pagesPerTerm` считался от общего `limit`, а не от доли фразы |
| D1 | адаптер, API | какая фраза нашла строку — нигде не сохранялось; в адаптере не было ни одной строки лога |

Существующие тесты works-профиля использовали однословные keywords
(`["электрооборудование", "монтаж", "пусконаладка"]`) и потому проходили.

## 3. Архитектурное решение

```
STAGE A — RETRIEVAL (mcp/procurement, без решений о релевантности)
  фразы профиля (+ объекты плана, только добавляют)
  → на каждую фразу: свой запрос площадке, своя доля лимита
       rowsPerTerm = max(20, ceil(limit / фраз)), pagesPerTerm по доле
  → listingKeepsPlatformHit: только substring-шум («НКУ» в «конкурс»)
  → round-robin слияние; одна процедура = один кандидат
       SearchHit.matchedSearchTerms = все фразы, которые её нашли
  → лог: term / pages / rows / kept; terms / candidates / returned

STAGE B — RELEVANCE (domain + api)
  план: из фразы работ выделяется действие и объект
       «монтаж электросилового оборудования»
         → desired «монтаж электросилового оборудования», «монтаж»
         → object  «электросилового оборудования»
  listing: scoreSearchIntent(title)
       match | veto/чужое назначение → discard | нет объекта → review
       discard пишется в ProfileSearchSelection.discarded с причиной
  review: procurement.get → scoreSearchIntent(title + лоты + позиции)
       match → relevant
       veto или чужое назначение → irrelevant
       «объект не найден» → НЕ решение: модель (квота 50) → иначе человек
       смешанный предмет («монтаж КТП, поставка и пусконаладка») →
         excludedRole = peer → review → модели задаётся явный вопрос,
         что является основным предметом (SearchClassifierInput.mixedActions)
  лог по каждому кандидату: decision / score / matchedSearchTerms / reason
```

Модель по-прежнему не ставит число. Веса `SEARCH_INTENT_WEIGHTS`,
`MIN_MATCH_SCORE`, схема `SearchIntentPlan`, HTTP- и MCP-контракты не
менялись; `SearchHit` получил одно необязательное поле.

## 4. Почему именно так

- Split фразы работ — общее правило по корням действий (монтаж, ремонт,
  наладк, обслуживан, проектирован, строительств), не словарь отраслей.
  Работает для «электромонтажные» и «пусконаладочные» без перечисления форм.
- `discard` карточки означает «термин-матчер не увидел объект». Площадка
  вернула строку по своему индексу, которого мы не видим целиком, — это
  повод спросить модель, а не доказательство. `veto` и `mismatch` остаются
  решением кода: там найдено то, чего профиль явно не хочет.
- Лимит: контракт `limit` сохранён (ответ ≤ limit), но страницы качаются
  по доле фразы. Для трёх фраз и `limit 100` это 3 страницы на фразу вместо
  6 — быстрее при том же покрытии. Потери хвоста видны в логе
  `candidates` vs `returned`.
- Смешанные закупки. Раньше при «монтаж КТП, поставка и пусконаладка»
  решал порядок слов: исключённое действие раньше желаемого → veto. Для
  перечисления через запятую / «и» это монетка. Теперь, если оба действия
  стоят в одном предложении-перечислении, а объект найден, код выносит не
  veto, а `peer` → review, и модель получает вопрос «что основной предмет».
  Порядок «Поставка КТП, монтаж» по-прежнему match; «Монтаж КТП» без
  поставки — по-прежнему veto; работы в одном лоте и поставка в другом
  не считаются перечислением (границы по `\n . ; :`).
- Стеммер: обрезка одного падежного окончания до трёхбуквенной основы только
  для слов ≤5 букв; «шкаф», «банк» не трогаются, аббревиатуры ≤3 букв идут
  прежним exact-матчером.

## 5. Изменения

Новые:

- `docs/architecture/STAGE-62.md`

Изменённые:

- `packages/contracts/src/procurement.ts` — `SearchHit.matchedSearchTerms?`
- `mcp/procurement/src/goszakupki-by-source.ts` — доля лимита на фразу,
  бакеты с фразой, `matchedSearchTerms`, логгер
- `mcp/procurement/src/main.ts` — логгер в live-источник
- `packages/domain/src/search/intent-plan.ts` — `splitWorkPhrase`
- `packages/domain/src/search/query-terms.ts` — `SHORT_NOUN_ENDINGS`
- `packages/contracts/src/domain-search.ts` — `SearchClassifierInput.mixedActions?`
- `packages/domain/src/search/intent-score.ts` — `IntentExcludedRole.peer`,
  `enumeratesTogether`, `mixedActions` в результате
- `packages/domain/src/search/review.ts` — `outcomeFromIntentCard`,
  `scoreIntentCard`, вопрос модели в `buildSearchClassifierInput`
- `apps/api/src/search-review.ts`, `search-classifier.ts` — score в промпт,
  инструкция по `mixedActions`
- `packages/domain/src/search/search-cards.ts` — `discarded[]` с причинами,
  «Найдена по: …» в действии карточки, `matchedSearchTerms` в проверке
  substring-шума
- `packages/domain/src/specialist/workspace.ts` — `search-review-v3`
- `apps/api/src/app.ts` — слияние `matchedSearchTerms`, лог retrieval,
  `logSearchTrace` (debug) по каждому кандидату

## 6. Изменения БД

Нет. `REVIEW_ALGORITHM_VERSION` = `search-review-v3`: старые `irrelevant`
по карточке больше не блокируют повторный разбор.

## 7. Контракты

`SearchHit.matchedSearchTerms?: string[]` — additive. Остальное без
изменений.

## 8. Тесты

- T1 адаптер: `["КТПБ","КТП","сети электроснабжения"]` → три запроса с
  разными `TendersSearch[text]`, ни одного склеенного
- T2 domain: «Поставка БКТПВ-630» по «КТП» → review, не match; карточка без
  точного «КТП» → не irrelevant (открыто для модели)
- T3 адаптер: процедура, найденная двумя фразами → один hit,
  `matchedSearchTerms` = обе
- T4 api: «Пусконаладка зернового комплекса» → карточка не решает, вызов
  модели; domain: `reviewByIntentCard` → `undefined`
- T5 domain: профиль из шести реальных фраз → «Монтаж электрооборудования
  РП с ТП, АСКУЭ, ПНР» = match; зерновой комплекс ≠ match
- T6 адаптер: пять фраз, первая с десятью страницами, `limit 20` → каждая
  фраза представлена, страниц у первой ≤ 3
- T7 domain: «сети электроснабжения» ⇔ «сетей электроснабжения»
- veto и чужое назначение по карточке по-прежнему решаются без модели
- смешанный лот «монтаж КТП, поставка и пусконаладка» → `peer` / review с
  `mixedActions`; «Поставка КТП, монтаж» → match; «Монтаж КТП» → veto;
  два лота (монтаж КТП / поставка кабеля) → veto; api: модель получает
  вопрос, `needs_human` проходит специалисту
- `npm run evaluate:search`: P 100 / R 100 / F1 100, FP 0, FN 0 — как на
  этапе 51; «Шкаф автоматики» (gold uncertain) из discard в review

## 9. Диагностика

```
info  goszakupki.by search term     {term, pages, rows, kept}
info  goszakupki.by search merged   {terms, candidates, returned}
info  Specialist profile search retrieval
      {originalTerms, listingTerms, derivedTerms, firstHits, extraHits, candidates, perTerm}
debug Specialist search candidate
      {decision, sourceProcurementId, title, score, matchedSearchTerms, reason}
```

`LOG_LEVEL=debug` у `procurement-api` включает строку на каждого кандидата.

## 10. Риски

- Больше кандидатов доходит до модели: квота 50 на поиск прежняя, хвост
  уходит в `needs_human`. Это осознанно — лучше видимая очередь, чем тихий
  irrelevant.
- Объект из фразы работ добавляется к запросам площадке
  («электрооборудования» — широкий термин). Стоимость — до 3 страниц по доле
  лимита; полнота исходных фраз не страдает.
- Стеммер коротких слов может склеить пары вроде «поле/пол». Для
  многословных фраз это компенсируется порядком основ; для одиночных
  четырёхбуквенных keywords стоит следить за eval.

## 11. Критерии приёмки

- [x] каждая фраза профиля — отдельный запрос площадке, виден в логе
- [x] кандидат хранит все фразы, которые его нашли
- [x] реальный works-профиль даёт match на электромонтаж и не даёт на зерно
- [x] «нет объекта» по карточке не становится irrelevant без модели
- [x] `npm run verify`, `npm run evaluate:search` без подгонки весов
