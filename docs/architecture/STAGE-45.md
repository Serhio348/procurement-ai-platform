# Этап 45 — кабинеты специалистов в админке

## Цель

Администратор видит чужие кабинеты: сколько профилей и закупок, список
«Мои закупки» / архив / корзина. Без права менять решения специалиста и без
входа под его сессией.

## Архитектурное решение

```
Admin → GET /api/admin/cabinets
      → listUsers + findWorkspaceId + SQL counts (RLS bypass listing)
Admin → GET /api/admin/users/:id/procurements?tab=
      → listCases(targetWorkspaceId)
      → journal: «просмотрел кабинет»
```

`workspaceId` по-прежнему не берётся с клиента. Сервер находит personal
workspace пользователя через `findWorkspaceId` и **не создаёт** кабинет на
чтении. Счётчики — один SQL `GROUP BY` по списку id (`withRlsBypass`), как
фоновый listing discovery, а не гидратация всех кейсов в память.

Список закупок — тот же `listCases`, что и консоль специалиста. Триаж и
карточка читаются из целевого workspace, не из кабинета админа (`withTriage`
админа не накладывается). Пишущих эндпоинтов нет: «Участвовать» /
«Не нужно» / очистка корзины из админки недоступны.

Просмотр конкретной карточки консоли не открывается: в списке ссылка на
площадку. `GET /api/procurements/:id` чужого UUID по-прежнему 404.

`lastActiveAt` — `max(last_seen_at)` среди **открытых** сессий. После выхода
сессия удаляется, строка показывает «Не в сети». История входов остаётся во
вкладке «Входы».

## Почему именно так

Этап 42 сознательно спрятал чужие закупки. Поддержка («у человека пусто /
зависла корзина») требует сводки, не имперсонации. Read-only listing не ломает
границу membership и не пишет от имени специалиста.

## Изменения

Новые файлы:

- `apps/web/src/admin/CabinetsPane.tsx`
- `docs/architecture/STAGE-45.md`

Изменённые: contracts `AdminCabinetSummary`; domain `countCabinetCases`;
specialist-store `summarizeCabinets`; cabinets `findWorkspaceId`;
auth `listLatestSeen`; API admin GET; вкладка «Кабинеты».

## Database changes

Нет новой миграции. Listing идёт через существующий `app.rls_bypass` для
системного обхода RLS, как `listWorkspaceIds`.

## Тесты

- domain: mine / archive / trash не смешиваются
- db: два кабинета, разные triage, раздельные счётчики
- api: специалист 403; админ видит participate другого; журнал пишет просмотр
- web: вкладка «Кабинеты», открытие списка без кнопок решения

## Риски

- Сводка не подменяет консоль специалиста: документов, фактов и входящих нет.
- `lastActiveAt` не равен «последний вход в жизни», только текущая сессия.
- Журнал пишет каждый GET списка закупок, включая смену вкладки.
- Fallback без Postgres считает из открытого кабинета в памяти.

## Обновление на сервере

Как обычно: `git pull`, `npm install`, `npm run build`,
`npm run build -w @procurement/web`, перезапуск API. Миграция не нужна.
