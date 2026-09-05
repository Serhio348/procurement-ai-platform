# Этап 22 — профиль, решение специалиста и слежение за новыми закупками

**Статус:** специалист заполняет профиль, сам запускает поиск, выбирает
отслеживать / участвовать / не нужно. Постоянный поиск новых процедур
идёт только после отдельной кнопки слежения. Отвергнутые id не
предлагаются снова.

---

## 1. Цель

Консоль перестаёт быть «списком из воздуха». Появляется рабочий цикл:

1. заполнить профиль;
2. нажать «Искать по профилю»;
3. по каждой найденной закупке выбрать действие;
4. по желанию включить слежение за *новыми* закупками.

Без кнопки слежения cron ничего не ищет.

---

## 2. Архитектурное решение

```text
Профиль (keywords, exclude)
  → PUT /api/profile                 # не включает watch
Слежение
  → POST /api/profile/watch          # явный флаг
Разовый поиск
  → POST /api/procurements/search    # keywords из профиля, не из HTTP-тела
Решение
  → POST /api/procurements/:id/decision  { kind: monitor|participate|reject }
  → append-only SpecialistTriageDecision
Discovery (интервал API)
  → если watch=false → no-op
  → иначе search, выкинуть уже решённые sourceProcurementId
```

- Тема поиска — данные профиля. HTTP-тело по-прежнему без `keywords`.
- `reject` скрывает карточку из списка и больше не возвращается ни разовым
  поиском, ни discovery.
- `monitor` / `participate` остаются в работе и тоже не предлагаются как
  «новые».
- Решения append-only: более позднее перекрывает вид списка, история не
  стирается.
- Состояние профиля и решений — `data/specialist-workspace.json`, не
  PostgreSQL. Таблицы `domain_profiles` / `decisions` этапа 2 остаются
  целевым хранилищем; этот срез не требует Docker.
- Интервал discovery — `SPECIALIST_DISCOVERY_INTERVAL_MS` (по умолчанию
  10 минут). Watch выключен: таймер может тикать, `runDiscovery` сразу
  возвращает `watch_off`.

Два мониторинга не смешиваются:

| Кнопка | Что делает |
|---|---|
| Следить за новыми закупками | discovery по профилю |
| Отслеживать на карточке | решение `monitor` по уже найденной процедуре |

```text
SpecialistWorkspace (profile + decisions)
  → selectRelevantSearchCards
  → partitionHitsByDecision(decidedSourceIds)
```

---

## 3. Почему именно так

**Явный watch.** Сохранение профиля — данные. Иначе «заполнил поля» тихо
запускает площадку.

**Решение человека, не score.** Модель по-прежнему не оценивает закупку
0–100. Три кнопки — `HumanDecisionKind` в терминах консоли:
отслеживать / участвовать / не нужно.

**Не предлагать отвергнутое.** Инвариант в `packages/domain`, не в
промпте. Cron не имеет права «забыть» reject после рестарта процесса:
решения пишутся на диск.

**Файл, не Postgres.** Консоль `npm run web` уже живёт без БД. Подключать
`companies` / `users` / FK `decisions.procurement_id` на этом этапе
сломало бы verify без Docker.

---

## 4. Изменения

- рабочий профиль и triage-решения в contracts;
- `SpecialistWorkspace` и `partitionHitsByDecision` в domain;
- API: GET/PUT профиль, POST watch, POST decision, POST discovery;
- live MCP search берёт keywords из текущего профиля;
- UI: раздел «Профили», кнопки решения на карточке.

## 5. Новые файлы

```text
packages/domain/src/specialist/workspace.ts
packages/domain/src/specialist/triage.ts
packages/domain/src/specialist/triage.test.ts
apps/api/src/workspace-file.ts
apps/web/src/profile/ProfileApp.tsx
apps/web/src/profile/ProfileApp.test.tsx
docs/architecture/STAGE-22.md
```

## 6. Изменяемые файлы

- `packages/contracts/src/specialist.ts`, `contracts.test.ts`
- `packages/domain/src/index.ts`
- `apps/api/src/app.ts`, `app.test.ts`, `main.ts`, `procurement-search.ts`
- `apps/web/src/SpecialistApp.tsx`, `main.tsx`, `shell/Shell.tsx`
- `apps/web/src/procurements/ProcurementsApp.tsx`
- `apps/web/src/api/specialist.ts`
- `apps/web/src/inbox/InboxApp.test.tsx`
- `.env.example`, `AGENTS.md`, `README.md`, `docs/architecture/STAGE-21.md`

## 7. Изменения БД

Нет. Workspace JSON в `data/` (gitignored).

## 8. Контракты API / MCP / агентов

- `GET /api/profile`
- `PUT /api/profile` `{ name, keywords, excludeKeywords }` — не трогает watch
- `POST /api/profile/watch` `{ watchNewProcurements }`
- `POST /api/profile/discovery` `{ limit? }`
- `POST /api/procurements/:id/decision` `{ kind: monitor|participate|reject }`

Discovery:

- `ran: false, reason: watch_off | no_keywords`
- `ran: true, reason: ok`

Новых MCP tools нет.

## 9. Тесты

- сохранение профиля не включает watch;
- reject не возвращается следующим поиском;
- discovery при выключенном watch не добавляет карточки;
- включённый watch пропускает уже решённые source id;
- UI: отдельная кнопка слежения; «Не нужно» убирает строку.

## 10. Риски и ограничения

1. Каталог карточек по-прежнему в памяти: после рестарта API список пуст,
   пока не нажмут поиск. Решения на диске, поэтому отвергнутые не всплывут.
2. Таймер в процессе API — не BullMQ. Один процесс консоли.
3. PostgreSQL `decisions` ещё не используется.
4. Документы найденных live-процедур по-прежнему не качаются.

## 11. Критерии приёмки

- [x] пустой список до поиска — норма;
- [x] профиль не запускает поиск сам;
- [x] watch off → discovery no-op;
- [x] reject не предлагается снова;
- [x] `npm run verify` без живого LLM и без площадки.

## 12. Следующий этап

Документы найденных live-процедур, PostgreSQL outbox / decisions, либо
входящий Telegram-бот.
