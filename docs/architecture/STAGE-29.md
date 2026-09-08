# Этап 29 — фильтр по статусу процедуры и целые слова в поиске

## Цель

Убрать три источника шума и потерь в поиске по профилю:

1. статусы «Подписание договора», «Завершен», «Отменен» в выдаче — профиль
   должен отбирать только интересующие статусы;
2. короткие аббревиатуры (НКУ, КРУ, КТП) матчились подстрокой внутри чужих
   слов («банку», «круглосуточной»);
3. длинные фразы «Что ищем» резались на отдельные слова и теряли контекст.

## Архитектурное решение

- `SearchHit.status: ProcedureStatus?` — адаптер нормализует статус строки
  листинга через `procedureStatus()`. `sourceStatus` остаётся дословным.
- `procedureStatus()` дополнен: «подписан*» → `bidding_closed`,
  «проведение»/«аукцион» → `auction_in_progress`, «подать предложение/документы»
  → `accepting_bids`.
- `SpecialistWorkingProfile.statuses: ProcedureStatus[]` — данные профиля,
  по умолчанию `["accepting_bids"]`. Пустой массив = без фильтра по статусу.
- `hitMatchesProfileStatuses` в `selectRelevantSearchCards`: хит без
  распознанного статуса (`undefined`) не отбрасывается — отсутствие данных не
  значит «завершено». Хит с распознанным, но не выбранным статусом отбрасывается.
- `termMatches` (domain/search): целый токен, префикс токена для слов ≥4 букв
  (склонение), подстрока внутри кодового токена с цифрой/дефисом/верхним
  регистром («2БКТПБ», «БКТПБ-746»). Многословные термины — фраза с границами
  слов. Используется в `cheapClassifyHit`, `hitMatchesProfileKeywords` и
  fallback-привязке `titleMatchesKeywords`.
- `searchPhrasesFromLookingFor` больше не дробит сегменты >4 слов на отдельные
  слова — сегмент целиком становится запросом площадки.
- Адаптер `matchesSearchRow` больше не отбрасывает строки по excludeKeywords:
  сырой `includes` там выкидывал бы лишнее до домена. Решение по
  ключевым/исключениям — только в домене.

## Почему именно так

- Статус — свойство направления: профиль = данные, а не код (правило 4.5).
- Фильтр на уровне домена, а не формы площадки: имя поля `TendersSearch[…]`
  для статуса не подтверждено; локальный фильтр по `ProcedureStatus`
  source-neutral и работает для любого источника.
- «БКТПБ» внутри модели «2БКТПБ-746» — легальное совпадение, внутри «банку» —
  нет. Чистое «целое слово» ломало бы коды моделей, чистая подстрока — шумела.

## Файлы

- `packages/contracts/src/procurement.ts` — `SearchHit.status`.
- `packages/contracts/src/specialist.ts` — `SpecialistWorkingProfile.statuses`.
- `packages/domain/src/search/term-match.ts` — новый матчер.
- `packages/domain/src/search/cheap-classify.ts`,
  `packages/domain/src/search/search-cards.ts`,
  `packages/domain/src/specialist/profile-cases.ts` — переход на `termMatches`.
- `packages/domain/src/specialist/looking-for.ts` — длинные фразы целиком.
- `mcp/procurement/src/goszakupki-by-parser.ts` — `status` в хите, новые
  соответствия статусов.
- `mcp/procurement/src/goszakupki-by-source.ts` — без мягких исключений.
- `apps/api/src/app.ts` — `statuses` профиля в ручной поиск и discovery.
- `apps/web/src/profile/ProfileApp.tsx` — чекбоксы статусов.
- Тесты: `term-match.test.ts`, `search-cards.test.ts`, `looking-for.test.ts`,
  `ProfileApp.test.tsx`, `db.integration.test.ts`.

## Изменения БД

Нет. `statuses` живёт в JSONB-снапшоте `specialist_workspaces`; у старых
профилей значение заполняется дефолтом `["accepting_bids"]` при чтении.

## Контракты

- `SearchHit.status` — опциональный `ProcedureStatus`.
- `SpecialistWorkingProfile.statuses` — массив `ProcedureStatus`, дефолт
  `["accepting_bids"]`; входит в `SpecialistProfileWrite`.
- MCP-контракты без изменений.

## Тесты

- `term-match.test.ts`: «банку»/«круглосуточной» не матчат НКУ/КРУ; кодовые
  токены матчат; фраза — только с границами слов.
- `search-cards.test.ts`: статус-фильтр отбрасывает `completed` при
  `["accepting_bids"]`, хит без статуса проходит, пустой `statuses` = всё.
- `looking-for.test.ts`: длинная фраза остаётся целой.
- `ProfileApp.test.tsx`: статусы сохраняются в профиль.

## Риски

- Неузнанный статус строки (`unknown`) при дефолтном фильтре отбрасывается —
  в UI есть «Прочие».
- Фраза из 5+ слов может вернуть 0 на площадке — это честнее, чем мешок слов;
  при необходимости позже добавим n-граммы.
- Карточки в каталоге со старым статусом не перескрываются ретроспективно —
  фильтр работает на входе.

## Критерии приёмки

- Профиль по умолчанию показывает только закупки со статусом приёма.
- «НКУ» не находит «банку»; «КТПБ» находит «2БКТПБ-746».
- Длинная фраза «Что ищем» уходит на площадку целиком.
- `npm run verify` зелёный.
