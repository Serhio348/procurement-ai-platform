# Этап 43 — список кабинета из SQL

## Цель

Кабинет больше не поднимает все `workspace_procurements` в память и не отдаёт
их одним JSON. Список и карточка читаются из PostgreSQL страницами.

## Архитектурное решение

`GET /api/procurements` принимает `tab` и `limit`. Источник — SQL по
`workspace_id`, не `catalog().procurements()`.

| tab | Что возвращает |
|---|---|
| `listed` (по умолчанию) | строки консоли: совпадения поиска и решённые, без pending review |
| `all` / `monitor` / `participate` | «Мои закупки» |
| `archive` | архив |

`GET /api/procurements/:id` — одна строка. Фоновый поиск проверяет «уже есть?»
по `(workspace_id, source_procurement_id)`, слежение читает до 40 решённых
через SQL, а не весь каталог. Кэш процесса держит профили, входящие и кейсы
текущего запроса.

При открытии кабинета Postgres больше не вызывает `loadCases`.

## Почему так

После этапа 42 у пользователя свой кабинет, но API по-прежнему гидратировал
все его закупки. Рост списка снова упёрся бы в RAM и в полный ответ
`/api/procurements`. Пагинация на SQL сохраняет границу workspace и не
требует командных кабинетов.

## Изменения

Новые файлы:

- `packages/domain/src/specialist/case-list.ts`
- `docs/architecture/STAGE-43.md`

Изменённые: contracts list query/response; specialist-store list/get/by-source;
cabinets + persist; API list/get/discovery/watch/prune; web «Мои закупки» по
вкладке, карточка по id, старт без полной выгрузки.

## Database changes

Нет новой миграции. Используются индексы `workspace_id + triage + archived`
и `last_seen_at`.

## Тесты

- domain: review не в списке; вкладка `all` не тащит search hit; архив отдельно
- API: `GET ?tab=all` пуст после поиска, появляется после «Следить»; карточка по id
- web: «Мои закупки» грузит вкладку с API; деталь ждёт `GET /:id`, а не «не найдена»

## Риски

- Inbox по-прежнему гидратируется целиком (он короткий).
- Fallback без Postgres читает JSON-файлы кабинета как раньше.
- `rememberFound` смотрит сначала кэш запроса, потом SQL, чтобы повтор
  в том же проходе не плодил дубли.

## Обновление на сервере

Как обычно: `git pull`, `npm install`, `npm run build`, перезапуск API.
Миграция не нужна.
