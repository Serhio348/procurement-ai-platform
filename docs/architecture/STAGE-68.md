# Этап 68 — сохранение профиля не падает на duplicate review verdicts

## Цель

В админке копились ошибки «Не удалось записать профиль в PostgreSQL»:
`23505 workspace_review_verdicts_uq`. UI отвечал 200 (диск сохранён), но
PostgreSQL откатывался — после перезапуска правки профиля пропадали.

## Причина

`saveWorkspace` делал `DELETE` всех вердиктов кабинета и затем `INSERT`
списка из памяти. Параллельные persist (сохранение профиля и discovery /
поиск) гонялись: оба успевали вставить одну и ту же пару
`(workspace_id, profile_id, source_procurement_id)`.

## Решение

1. `pg_advisory_xact_lock(hashtext(workspace_id))` — один writer на кабинет.
2. `INSERT … ON CONFLICT DO UPDATE` по уникальному индексу вердиктов.
3. Дедуп списка вердиктов перед записью и при загрузке в `SpecialistWorkspace`.

## Изменённые файлы

- `packages/db/src/specialist-store.ts`
- `packages/domain/src/specialist/workspace.ts`, `workspace.test.ts`
- `AGENTS.md`

## Критерии приёмки

- [x] повторное сохранение профиля с непустым `reviewedIrrelevant` не пишет
  ошибку в журнал;
- [x] дубликаты вердиктов в снимке схлопываются до одной строки;
- [x] `npm run verify`
