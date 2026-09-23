# STAGE-105 · Liveness vs readiness: честный /api/health (R42)

Дата: 2026-05-06. Статус: выполнено.

## Проблема

`/api/health` всегда отвечал `{ok:true, postgres:<boot-flag>}`. Состояние
PostgreSQL после старта, наличие моделей, live-режим источника и давность
последнего успешного мониторинга были видны только в startup-логах. Упавшая
после запуска БД или отключённая модель никак не доходили до UI и мониторинга.

## Решение

**API:**

- `GET /api/live` → `{ok:true}` — liveness: процесс отвечает, пока жив.
- `GET /api/health` → readiness (`SpecialistServiceHealth`): 200 при
  `ready:true`, 503 иначе. Поля: `sha` (APP_BUILD_SHA или `git rev-parse`),
  `mode`, `uptimeSec`, `components` (postgres `ok|failed|off` по живому
  `pool.query("select 1")`, source `live|fixture|off`, objectStore, models,
  mail), `degraded` — человекочитаемые имена деградировавших возможностей,
  `discovery` — health контроллера слежения включая новое `lastSuccessAt`.
- `ready` требует: postgres не failed, источник подключён в live-режиме,
  модели разбора запроса и оценки присутствуют. Почта/commercial-reader/fixture
  попадают в `degraded`, но не блокируют ready. Секретов в ответе нет —
  только булевы флаги и метки времени.
- `persist.ts`: `postgresConfigured` + `ping()` — живой ping, а не флаг
  загрузки (БД может умереть после старта).

**UI:** SpecialistApp опрашивает `/api/health` на старте и каждые 60 с;
при `ready:false` — постоянный баннер «Сервис работает не полностью: …»
со списком `degraded`. Недоступный сервер по-прежнему покрывает баннер
poll-stale — health-поллинг ошибки молча пропускает.

## Проверка

- `app.test.ts`: live при degraded; ready+sha+пустой degraded при полной
  конфигурации; 503 + `postgres:failed` при мёртвом ping.
- `SpecialistApp.poll.test.tsx`: баннер показывает имена деградации и
  снимается при `ready:true`.
