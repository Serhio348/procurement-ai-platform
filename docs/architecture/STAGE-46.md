# Этап 46 — админ снимает ошибки

## Цель

Красная метка «ошибки N» в меню висела и снять её было нечем. Админ должен
уметь пометить разобранные ошибки как снятые, чтобы счётчик показывал только
то, что действительно активно.

## Архитектурное решение

```
Admin → POST /api/admin/journal/errors/ack
      → update admin_journal set acknowledged_at = now()
        where level = 'error' and acknowledged_at is null
      → journal: «… снял ошибки: N» (info)
      → { items, errorCount }
```

Счётчик считает ошибку активной, пока она внутри окна 7 дней **и** не снята:
`level = 'error' and acknowledged_at is null and at >= now() - 7d`. Тот же
счётчик отдаётся в сессии как `errorEventCount`, поэтому метка в меню гаснет
сразу после `refresh()`.

Снятие — не удаление. Запись остаётся в журнале с датой снятия, строка теряет
красную рамку и получает подпись «снято». Разбор ошибок и их история — разные
вещи, стирать историю сбоев админке нельзя.

## Почему именно так

Альтернатива — водяной знак «ошибки до момента T» одной строкой настроек.
Отклонена: по строке журнала тогда не видно, разобрана она или просто старше
знака, и любой пересчёт окна снова поднимает старые сбои. Колонка на записи
даёт ответ на каждую строку и переживает изменение окна.

`admin_journal` перестаёт быть строго append-only, но ровно в одном поле:
`acknowledged_at`. Текст, уровень и время записи по-прежнему не переписываются
и строки не удаляются.

## Изменения

Новые файлы:

- `packages/db/drizzle/0008_admin_journal_ack.sql`
- `docs/architecture/STAGE-46.md`

Изменённые:

- contracts: `AdminJournalEntry.acknowledgedAt`, `AdminJournalWrite` его не
  принимает — снятие делает только эндпоинт
- db: `admin_journal.acknowledged_at` + индекс `admin_journal_open_error_idx`
- api: `AdminJournalPort.acknowledgeErrors`, `isOpenError`, обе реализации
  порта, `POST /api/admin/journal/errors/ack`
- web: кнопка «Снять ошибки (N)» во вкладке «Ошибки», подпись «снято»,
  `acknowledgeAdminErrors`

## Database changes

Миграция `0008_admin_journal_ack`: `acknowledged_at timestamptz` (nullable) и
индекс по `(level, acknowledged_at, at)` для счётчика. Старые записи остаются
`null`, то есть активными, пока админ их не снимет.

## Контракты

`POST /api/admin/journal/errors/ack` — без тела, только роль `admin` (общий
хук на `/api/admin`). Ответ — тот же `AdminJournalListResponse`, что у GET,
поэтому клиент не делает второй запрос за списком.

## Тесты

- api: снятая ошибка остаётся в списке, счётчик 0, повторное снятие даёт 0
- api: ошибка после снятия снова считается
- api: после `ack` сессия отдаёт `errorEventCount = 0`, в журнале есть
  «снял ошибки: 1»
- web: кнопка гаснет в «Активных ошибок нет», строка помечена «снято», текст
  сбоя остался

## Риски

- Снятие массовое: точечного «снять эту ошибку» нет. Для 19 висящих записей
  это и требовалось, но при частых сбоях админ может снять ещё не разобранное.
- Снятие пишет запись в журнал, поэтому лента «Журнал» растёт от самих
  снятий.
- Без Postgres (memory journal) снятие живёт до перезапуска процесса.

## Обновление на сервере

```bash
cd /opt/procurement-ai-platform
git pull
npm install
npm run db:migrate
npm run build
npm run build -w @procurement/web
systemctl restart procurement-api
```

Миграция обязательна: без колонки `acknowledged_at` API упадёт на журнале.
