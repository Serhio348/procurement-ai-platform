# Этап 67 — запись кабинета без deadlock и без перезаписи всего поиска

## Цель

Убрать ошибки админки «Не удалось записать профиль / Входящие / устаревшие карточки»
и ускорить сохранение при поиске. Костыли (retry, глотание ошибок) не используем.

## Решение

1. **Один писатель на кабинет**
   - `withWorkspaceWrite` = транзакция + `pg_advisory_xact_lock(hashtext(workspaceId))`
     на `saveWorkspace` / `saveCases` / `removeCases` / `saveInbox` / `saveCabinet`.
   - Очередь `enqueueWorkspaceWrite` в `persist.ts` на весь цикл записи кабинета,
     чтобы шаги не чередовались между запросами.

2. **Одна транзакция снимка** — `saveCabinet(snapshot, cards, inbox)`:
   профиль + затронутые карточки + входящие под одним замком.
   Профиль больше не делает `UPDATE` по всем строкам `workspace_inbox`
   (это и был AB-BA deadlock с `saveInbox`).

3. **Вердикты** — без `DELETE ALL`: dedupe + `ON CONFLICT DO UPDATE`, затем
   точечное удаление сирот. Дубликаты и гонка поиска с сохранением профиля
   не дают `23505`.

4. **Входящие** — FK только на существующую карточку; dismissed пишется здесь,
   а не из `saveWorkspace`. В журнал админки уходит текст Postgres, не голая фраза.

5. **Поиск** — `persistProgress(caseIds)` вместо полного `persist` после каждой
   карточки (`persistEach`). На диск/в SQL уходят снимок профиля, inbox и
   только затронутые кейсы; полный снимок — в конце задания / по явному сохранению.

## Почему так (масштаб)

Кабинеты блокируются **по `workspaceId`**, не глобально: рост числа кабинетов
не сериализует всех пользователей. Рост профилей внутри кабинета больше не
умножает стоимость «каждый hit = все карточки».

## Изменённые файлы

- `packages/db/src/workspace-scope.ts` — `withWorkspaceWrite`
- `packages/db/src/specialist-store.ts` — `saveCabinet`, write helpers, upsert вердиктов
- `apps/api/src/persist.ts` — очередь, `persistProgress`, журнал inbox с деталью
- `apps/api/src/cabinets.ts` — контракт `persistProgress`
- `apps/api/src/app.ts` — `persistEach` → `persistProgress`
- `packages/db/src/specialist-store.test.ts`
- `docs/architecture/STAGE-67.md`

## Критерии приёмки

- [x] `npm run typecheck`
- [x] unit-тесты store/persist
- [ ] на VPS после деплоя при поиске и сохранении профиля не копятся
  `40P01` / «Входящие в PostgreSQL» / `23505` по вердиктам
