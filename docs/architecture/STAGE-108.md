# STAGE-108 · Инкрементальный persist: цена действия равна изменению, а не кабинету (R37)

Дата: 2026-05-06. Статус: выполнено.

## Проблема

Стоимость каждого действия росла линейно от накопленного кабинета:

- `saveCabinet` после решения по **одной** карточке прогонял
  `saveWorkspaceCase` по всем сохраняемым карточкам (canonical upsert +
  update + delete/reinsert связей на каждую), переписывал все профили и
  verdicts и upsert'ил каждую строку inbox, включая dismissed;
- `tab=search` разрешал каждый id очереди отдельным `getCase` (N+1) до
  slice страницы;
- кэш карточек `goszakupki-by-source` проверял TTL при чтении, но протухшие
  ключи не удалял — память росла до рестарта.

## Решение

**Принцип:** один `SELECT` по workspace решает, *какие* строки изменились;
пишутся только они. Чтения остаются O(кабинет) по индексу, записи — O(изменение).

**Карточки.** `saveWorkspaceCase` сначала читает существующую строку (включая
`card` jsonb) и при равенстве по `comparableCardJson` — канонический jsonb без
`canonicalProcurementId`, который хранится в строке, но может отсутствовать у
вызывающего — выходит сразу: canonical upsert, update строки и
delete/reinsert `workspace_procurement_profiles` не выполняются.
`saveCabinet` дополнительно делает bulk-select `source→card` и не вызывает
`saveWorkspaceCase` для неизменённых карточек вовсе. Это покрывает все пути
(`persist`, `persistProgress`, `saveCases`) без правки call-site'ов.

**Workspace.** Профили: upsert только при отличающемся поле —
`profileRowMatches` сравнивает через `canonicalJson` (jsonb переупорядочивает
ключи) и `toIsoDateTime` (timestamptz wire-format). Verdicts: один select
`profileId+source+decidedAt+version` — insert/upsert только свежих; тот же
select гонит orphan-свип (удаляются только строки, отсутствующие в snapshot).
Decisions/inbox-чтения без изменений — SELECT по workspace-индексу.

**Inbox.** Один select `eventKey,state,workspaceProcurementId,item` —
upsert только новых и изменившихся (состояние, привязка к кейсу или сам
payload события). Dismissals применяются только к строкам `state='open'` и
только к тем, чьи change-id реально помечены — скан всей истории и массовый
UPDATE сняты.

**Чтение очереди поиска.** `CabinetRegistry.loadCasesByIds(workspaceId, ids)`
— один `IN`-запрос. `tab=search` собирает id, отсутствующие в гидрированном
каталоге, и делает один bulk-fetch вместо `getCase` на каждый id.

**Кэш источника.** `GoszakupkiBySourceOptions.cacheMaxEntries` (512):
после вставки сначала выметаются протухшие записи, затем — при превышении —
старейшие (Map итерирует в порядке вставки).

## Проверка

- `specialist-store.test.ts`: `canonicalJson` (порядок ключей),
  `comparableCardJson` (stored `canonicalProcurementId` — не изменение),
  `profileRowMatches` (round-trip row ↔ profile, любое поле — изменение).
- `app.test.ts` «one bulk fetch»: очередь из 5 id, 3 только в сторе —
  ответ 200 с 5 карточками, `getCase` не вызван ни разу,
  `loadCasesByIds` вызван ровно один раз с недостающими id.
- `db.integration.test.ts` (под `TEST_DATABASE_URL`): повторный `saveCabinet`
  с теми же данными + одна новая inbox-строка + одна изменённая карточка —
  `updated_at` неизменённых строк inbox/profiles/cases/canonical идентичен
  первому сохранению, изменённая карточка реально записана.

## Что сознательно не сделано

- Disk-mirror (`mirrorToDisk`) по-прежнему пишет полные файлы — локальная
  запись дешёвая и нужна для durability/бэкапов.
- SELECT'ы по workspace остаются O(кабинет) — индексные чтения, не записи;
  полноценная SQL-пагинация очереди поиска (LIMIT/OFFSET вместо фильтрации
  в памяти) — отдельный шаг, если профилирование покажет необходимость.
