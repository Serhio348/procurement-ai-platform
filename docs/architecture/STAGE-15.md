# Этап 15 — список закупок и карточка кейса

**Статус:** пункт «Закупки» открывает каталог процедур. Справа — карточка:
номер, статус, ссылка на площадку, последнее изменение. Профили и задачи
по-прежнему «скоро». Исходный план STAGE-0 ставил на этап 15 наблюдаемость;
карточка кейса нужнее консоли, поэтому этот номер занят списком закупок.

---

## 1. Цель

Из inbox специалист может перейти к списку всех кейсов, включая несрочные.

## 2. Архитектурное решение

- `GET /api/procurements` и `GET /api/procurements/:id`.
- Карточка собирается из того же `SpecialistCatalog`: последняя запись по
  `procurementId`.
- Маршруты `/` (inbox) и `/procurements/:id`. Это не чат.
- Текст последнего изменения снова собирает `compileChangeAlert`.

```text
GET /api/procurements
  → список слева / карточка справа
```

## 3. Почему именно так

Список закупок — следующий экран после inbox, без редактора профиля и без
полного отчёта. Один каталог для ленты и для кейсов, чтобы «бытовой щиток»
не пропал только потому, что изменение не срочное.

## 4. Изменения

- ответ `SpecialistProcurementCard`;
- маршруты Fastify для списка и карточки;
- React Router: `/procurements`;
- пункт меню «Закупки» включён.

## 5. Новые файлы

```text
apps/web/src/procurements/ProcurementsApp.tsx
apps/web/src/procurements/ProcurementsApp.test.tsx
apps/web/src/SpecialistApp.tsx
apps/web/src/shell/Shell.tsx
docs/architecture/STAGE-15.md
```

## 6. Изменяемые файлы

- `packages/contracts/src/specialist.ts`
- `packages/domain/src/specialist/catalog.ts`, `catalog.test.ts`
- `apps/api/src/app.ts`, `app.test.ts`
- `apps/web/src/main.tsx`, `src/api/specialist.ts`
- `apps/web/package.json`
- `README.md`, `AGENTS.md`

## 7. Изменения БД

Нет.

## 8. Контракты API / MCP / агентов

HTTP:

- `GET /api/procurements` — все кейсы каталога;
- `GET /api/procurements/:id` — 404, если нет.

Новых MCP tools нет.

## 9. Тесты

- в списке есть «Бытовой щиток»;
- клик открывает ссылку площадки и текст 10000 → 9000;
- inbox по-прежнему не показывает этот несрочный кейс.

## 10. Риски и ограничения

1. Нет persistence, нет отчёта markdown, нет HITL.
2. Карточка — срез последнего изменения, не полная история кейса.
3. Профили и задачи не реализованы.

## 11. Критерии приёмки

- [x] «Закупки» не disabled;
- [x] карточка без выдуманного аванса;
- [x] verify без Docker;
- [x] отчёт этапа записан.

## 12. Следующий этап

`notification_outbox` в PostgreSQL, либо входящий Telegram-бот, либо редактор
профиля.
