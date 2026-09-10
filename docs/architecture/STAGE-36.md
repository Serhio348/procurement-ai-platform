# Этап 36. Укрепление фонового поиска: замок, темп, пробойник

## Цель

Перед тем как добавлять слежку за ценами и документами по уже решённым
карточкам, нужно устранить риски, которые сделают само слежение опасным:

1. **Перекрывающиеся проходы.** Если предыдущий фоновый обход затянулся, а
   таймер уже выстрелил, два прохода могут бежать одновременно, гнаться за одними
   и теми же водяными знаками и нагружать площадку вдвое.
2. **Давка на источник.** Каждый профиль — это `procurement.search`. При 10
   профилях в час уходит до 10 запросов подряд; без паузы площадка легко нас
   заблокирует.
3. **Повторные попытки на мёртвый источник.** Если goszakupki.by лежит или
   таймаутит, система продолжает долбить каждые N минут.
4. **Нет админской видимости.** Не видно, запущен ли сейчас обход, когда он
   завершился, сколько профилей следит и открыт ли пробойник.

Этот этап закрывает эти четыре пробела. Мониторинг карточек пойдёт поверх этой
подготовки.

## Решения

### 1. `DiscoveryController` — замок + пробойник

Новый `apps/api/src/discovery-control.ts`. Его ответственность:

- `tryStart(now)` — отказывает, если проход уже идёт (`busy`) или пробойник
  открыт (`cooldown`).
- `finish(result, now)` — снимает замок, фиксирует результат, сбрасывает счётчик
  ошибок после успешного прохода.
- `recordFailure(error, now)` — считает только **сетевые сбои**: `source_unavailable`
  и `timeout` из `McpToolCallError`. Прочие ошибки не открывают пробойник.
- `beforeRequest(now)` — ждёт `SPECIALIST_DISCOVERY_REQUEST_INTERVAL_MS` между
  запросами к площадке.
- `health(watchingCount)` — снимок состояния для админки.

Счётчик и замок — в памяти процесса. Это осознанный компромисс: при рестарте
счётчики обнуляются, но и зависший замок не блокирует систему навечно.

Пороги настраиваются через `.env`:

- `SPECIALIST_DISCOVERY_FAILURE_THRESHOLD` — сколько подряд сбоев площадки
  открывают пробойник (по умолчанию 3);
- `SPECIALIST_DISCOVERY_COOLDOWN_MS` — как долго пробойник остаётся открытым
  (по умолчанию 5 минут);
- `SPECIALIST_DISCOVERY_REQUEST_INTERVAL_MS` — минимальный зазор между
  `procurement.search` внутри одного прохода (по умолчанию 0).

### 2. `runDiscovery` согласуется с контроллером

`apps/api/src/app.ts`:

- в начале `runDiscovery` — `tryStart`;
- перед `searchHits.search` — `beforeRequest`;
- при досрочных выходах (`watch_off`, `no_keywords`) — `finish`;
- в случае исключения — `recordFailure`;
- при успехе — `finish`.

Ответ `SpecialistDiscoveryResponse` расширен двумя новыми `reason`:
`already_running` и `cooldown`.

### 3. Админский эндпоинт `GET /api/admin/discovery`

`apps/api/src/app.ts` публикует состояние контроллера в формате
`SpecialistDiscoveryHealthResponse`. Требует ту же админскую роль, что и
`/api/admin/journal`.

## Изменения

| Файл | Что |
|---|---|
| `packages/contracts/src/specialist.ts` | `SpecialistDiscoveryResponse.reason` — `already_running`, `cooldown`; новые `SpecialistDiscoveryHealth`, `SpecialistDiscoveryHealthResponse` |
| `apps/api/src/discovery-control.ts` | `DiscoveryController`, `createDiscoveryController` — замок, пауза, пробойник, health |
| `apps/api/src/discovery-control.test.ts` | тесты замка, пробойника, сброса, cooldown |
| `apps/api/src/app.ts` | `runDiscovery` через контроллер, `GET /api/admin/discovery` |
| `apps/api/src/main.ts` | создание `discoveryController` из `process.env`, передача в API |
| `.env.example` | `SPECIALIST_DISCOVERY_REQUEST_INTERVAL_MS`, `SPECIALIST_DISCOVERY_FAILURE_THRESHOLD`, `SPECIALIST_DISCOVERY_COOLDOWN_MS` |

## БД

Новых таблиц нет. Контроллер хранит состояние в памяти процесса.

## API

- `POST /api/profile/discovery` — может вернуть `reason: "already_running"` или
  `"cooldown"`, по-прежнему `200`.
- `GET /api/admin/discovery` — админ; возвращает `health`.

## Тесты

`apps/api/src/discovery-control.test.ts`:

- свежий контроллер допускает старт;
- второй `tryStart` возвращает `busy`;
- подряд `source_unavailable` / `timeout` открывают пробойник;
- не-сетевые ошибки не открывают пробойник;
- cooldown истекающего позволяет один пробный старт;
- успешный `finish` сбрасывает счётчик ошибок.

`npm run verify` — зелёный.

## Риски

- **Замок в памяти процесса.** При нескольких репликах API это не защитит от
  параллельных проходов на разных инстансах. Для нескольких реплик понадобится
  Redis-замок или `pg_advisory_lock`.
- **Пробойник не лечит причину.** Он только даёт площадке передышку; админ
  должен видеть в журнале, что пошло не так.
- **Rate limit — между профилями, не внутри площадки.** `procurement.search`
  сама по себе может делать несколько HTTP-вызовов; `requestIntervalMs`
  регулирует интервал между вызовами инструмента, а не между его внутренними
  запросами.
- **Ручной `POST /api/profile/discovery` тоже подчиняется пробойнику.** Это
  верно: если площадка лежит, форсировать бессмысленно; админ видит причину.

## Критерии приёмки

- Два одновременных вызова `runDiscovery` не бегут рядом: второй возвращает
  `already_running`.
- `source_unavailable` / `timeout` три раза подряд открывают пробойник на
  5 минут по умолчанию.
- Админ видит состояние обхода в `GET /api/admin/discovery`.
- `npm run verify` проходит.
