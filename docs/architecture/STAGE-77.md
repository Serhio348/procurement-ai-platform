# Этап 77 — интерактивная линия MCP: открытие карточки не ждёт фоновую очередь (R43, часть 1)

## Цель

«Открыть карточку», «Следить», «Участвовать» занимали 15–29 с и визуально
подвешивали консоль. Две независимые причины складывались:

1. **Одна серийная MCP-очередь на всё.** `serializeMcpToolCaller` —
   единственный сток: stdio-труба одного процесса обслуживает строго один
   запрос за раз. `procurement.get` при открытии карточки вставал за
   десятками фоновых вызовов: поисковые страницы, card-level scoring
   (по одному `procurement.get` на кандидата), discovery, watch-pass,
   скачивание документов. При 20 rpm (≥3 с на HTTP-запрос) очередь фоновой
   работы — это минуты.
2. **Полный persist на каждое действие.** `resolve`/`decision`/`archive`
   писали весь набор persistable-карточек + workspace + inbox и ждали
   advisory lock, который в этот момент мог держать фоновый прогон.

Цель: интерактивная работа не зависит от фоновой нагрузки; запись —
только тронутые данные.

## Архитектурное решение

1. **Два MCP-процесса вместо одного.** `main.ts` поднимает
   `connectProcurementMcp` дважды: `lane: "background"` (searchHits,
   searchReview, documentIngest, monitorWatch) и `lane: "interactive"`
   (cardWatch: `GET /card`, `hydrateSourceCard` в decision/reindex).
   У каждого процесса — своя stdio-труба и свой серийный caller:
   инвариант «один запрос за раз» сохраняется *внутри* линии, но линии
   параллельны. Открытие карточки ждёт только свой `procurement.get`
   (~3–6 с по pacing), а не очередь фоновых вызовов.
2. **`monitorWatch`** — отдельный порт для фонового watch-pass
   (`monitorDecidedCases`). Тот же `SpecialistCardWatchPort`, по умолчанию
   `cardWatch`: тесты и fixture-режим не меняются.
3. **`persistProgress([id])` вместо `persist()`** на одиночных действиях:
   `resolve`, `decision`, `archive`, `restore`, `GET /card`, `reindex`.
   `saveCabinet` upsert-ит только тронутую карточку (он никогда не
   удаляет отсутствующие в списке — проверено по коду); workspace snapshot
   и inbox пишутся как раньше.

## Изменённые файлы

- `apps/api/src/procurement-mcp.ts` (`lane` в логах)
- `apps/api/src/main.ts` (второй процесс, monitorWatch, закрытие обоих)
- `apps/api/src/app.ts` (`monitorWatch`, persistProgress)
- `apps/api/src/app.test.ts` (регрессия маршрутизации линий)
- `TODO.md` (R43 — частично)

## БД

Миграций нет.

## Тесты

- API: `routes the watch pass to monitorWatch and interactive reads to
  cardWatch` — decision-hydrate и `GET /card` идут в interactive-стаб,
  watch-pass — в monitor-стаб.

## Приёмка

- Открытие карточки и «Следить»/«Участвовать» не ждут фоновый поиск/
  discovery/ingest — только собственное живое чтение.
- Одиночное действие не переписывает весь набор карточек в БД.

## Риски и ограничения

- **Совокупный rate-limit.** У каждого процесса свой адаптер со своим
  pacing: теоретический максимум — 2× `GOSZAKUPKI_BY_RATE_LIMIT_RPM`.
  Практически интерактивная линия почти простаивает (1 get на клик), так
  что реальная нагрузка близка к фоновой. Если площадка начнёт резать —
  первый кандидат на отдельный RPM-конфиг для линий.
- **R43 не закрыт целиком:** дочерним процессам по-прежнему копируется
  всё окружение API (секреты auth/SMTP/LLM) — нужен allowlist; нет явных
  бюджетов/дедлайнов на время ожидания в очереди линии.
- Полный disk-persist (cases.json + inbox.json целиком) остался — это
  R37; persistProgress удешевляет только сторону PostgreSQL.
