# Инструкция по разработке

Файл читается человеком и любым AI-инструментом (Cursor, Codex, Claude Code, Cline, Copilot и др.).
Прочитайте его целиком перед первым изменением кода.

---

## 1. Что это за проект

Автономная AI-платформа для поиска, мониторинга и анализа закупок.

Ключевая идея: **это не чат с моделью**. Модель понимает запрос и координирует работу, но саму работу выполняют узкие исполнители со строгими контрактами и ограниченным набором инструментов.

```
Пользователь → Intent → Контекст → Supervisor → Domain / Capability
             → Специализированный агент → MCP → Инструмент → Внешняя система
```

Обязательное чтение перед работой:

- [`docs/architecture/STAGE-0.md`](docs/architecture/STAGE-0.md) — архитектура, доменная модель, план этапов
- [`docs/architecture/STAGE-1.md`](docs/architecture/STAGE-1.md) — что уже реализовано и почему именно так
- [`docs/architecture/STAGE-2.md`](docs/architecture/STAGE-2.md) — PostgreSQL, Redis и MinIO
- [`docs/architecture/STAGE-3.md`](docs/architecture/STAGE-3.md) — Procurement MCP и fixture boundary
- [`docs/architecture/STAGE-4.md`](docs/architecture/STAGE-4.md) — адаптер goszakupki.by
- [`docs/architecture/STAGE-5.md`](docs/architecture/STAGE-5.md) — Supervisor
- [`docs/architecture/STAGE-6.md`](docs/architecture/STAGE-6.md) — Context Compiler
- [`docs/architecture/STAGE-7.md`](docs/architecture/STAGE-7.md) — DomainSearchAgent
- [`docs/architecture/STAGE-8.md`](docs/architecture/STAGE-8.md) — Document MCP и DocumentAgent
- [`docs/architecture/STAGE-9.md`](docs/architecture/STAGE-9.md) — CommercialTermsAgent
- [`docs/architecture/STAGE-10.md`](docs/architecture/STAGE-10.md) — MonitoringAgent
- [`docs/architecture/STAGE-11.md`](docs/architecture/STAGE-11.md) — ReportAgent
- [`docs/architecture/STAGE-12.md`](docs/architecture/STAGE-12.md) — NotificationAgent
- [`docs/architecture/STAGE-13.md`](docs/architecture/STAGE-13.md) — веб-интерфейс (inbox)
- [`docs/architecture/STAGE-14.md`](docs/architecture/STAGE-14.md) — живой inbox через HTTP API
- [`docs/architecture/STAGE-15.md`](docs/architecture/STAGE-15.md) — список закупок и карточка кейса
- [`docs/architecture/STAGE-16.md`](docs/architecture/STAGE-16.md) — живой прогон одной закупки
- [`docs/architecture/STAGE-17.md`](docs/architecture/STAGE-17.md) — распознавание live-PDF
- [`docs/architecture/STAGE-18.md`](docs/architecture/STAGE-18.md) — отбор файлов и vision сканов конкурса
- [`docs/architecture/STAGE-19.md`](docs/architecture/STAGE-19.md) — факты поставки и гарантии из Word-ТЗ
- [`docs/architecture/STAGE-20.md`](docs/architecture/STAGE-20.md) — поиск по профилю из консоли
- [`docs/architecture/STAGE-21.md`](docs/architecture/STAGE-21.md) — живой поиск goszakupki.by из консоли
- [`docs/architecture/STAGE-22.md`](docs/architecture/STAGE-22.md) — профиль, решение и слежение
- [`docs/architecture/STAGE-23.md`](docs/architecture/STAGE-23.md) — несколько профилей
- [`docs/architecture/STAGE-24.md`](docs/architecture/STAGE-24.md) — документы после «Участвовать»
- [`docs/architecture/STAGE-25.md`](docs/architecture/STAGE-25.md) — PostgreSQL, MinIO и Redis для консоли
- [`docs/architecture/STAGE-26.md`](docs/architecture/STAGE-26.md) — вход, регистрация и одобрение доступа
- [`docs/architecture/STAGE-27.md`](docs/architecture/STAGE-27.md) — разбор входящих, а не склад сообщений
- [`docs/architecture/STAGE-28.md`](docs/architecture/STAGE-28.md) — журнал: доступ, вход/выход, ошибки
- [`docs/architecture/STAGE-38.md`](docs/architecture/STAGE-38.md) — карточка площадки при «Участвовать»
- [`docs/architecture/STAGE-39.md`](docs/architecture/STAGE-39.md) — несостоявшиеся процедуры и закупки из одного источника
- [`docs/architecture/STAGE-40.md`](docs/architecture/STAGE-40.md) — архив «Моих закупок» и один флажок одного источника
- [`docs/architecture/STAGE-41.md`](docs/architecture/STAGE-41.md) — скачивание больших ТЗ, подписи сроков и стабильные сессии
- [`docs/architecture/STAGE-42.md`](docs/architecture/STAGE-42.md) — личные кабинеты и изоляция данных
- [`docs/architecture/STAGE-43.md`](docs/architecture/STAGE-43.md) — список кабинета из SQL, без полной гидратации
- [`docs/architecture/STAGE-44.md`](docs/architecture/STAGE-44.md) — корзина после «Не нужно» / «Убрать»
- [`docs/architecture/STAGE-45.md`](docs/architecture/STAGE-45.md) — кабинеты специалистов в админке
- [`docs/architecture/STAGE-46.md`](docs/architecture/STAGE-46.md) — админ снимает ошибки в журнале
- [`docs/architecture/STAGE-47.md`](docs/architecture/STAGE-47.md) — модель дочитывает условия, код проверяет цитату
- [`docs/architecture/STAGE-48.md`](docs/architecture/STAGE-48.md) — план поиска из фразы, оценку 0–100 считает код
- [`docs/architecture/STAGE-49.md`](docs/architecture/STAGE-49.md) — evaluation harness: Precision/Recall старого и нового поиска
- [`docs/architecture/STAGE-50.md`](docs/architecture/STAGE-50.md) — живой dump goszakupki.by, baseline «НКУ для управления насосами»
- [`docs/architecture/STAGE-51.md`](docs/architecture/STAGE-51.md) — фильтр выдачи, discard vs review, required_context
- [`docs/architecture/STAGE-52.md`](docs/architecture/STAGE-52.md) — «Участвовать» качает файлы после смены вкладки
- [`docs/architecture/STAGE-53.md`](docs/architecture/STAGE-53.md) — срок оплаты с «после чего» из документа
- [`docs/architecture/STAGE-54.md`](docs/architecture/STAGE-54.md) — «Обновить» перечитывает скачанные файлы
- [`docs/architecture/STAGE-55.md`](docs/architecture/STAGE-55.md) — ZIP и ссылка на хранилище документации
- [`docs/architecture/STAGE-59.md`](docs/architecture/STAGE-59.md) — поиск: план параллельно, разбор карточек в фоне
- [`docs/architecture/STAGE-60.md`](docs/architecture/STAGE-60.md) — слежение: список документов на взятой закупке
- [`docs/architecture/STAGE-61.md`](docs/architecture/STAGE-61.md) — предмет лота в оценке поиска
- [`docs/architecture/STAGE-62.md`](docs/architecture/STAGE-62.md) — поиск по каждому терму, честный merge и provenance
- [`docs/architecture/STAGE-63.md`](docs/architecture/STAGE-63.md) — план не сужается моделью, услуги ≠ поставка, кандидат ≠ новая закупка
- [`docs/architecture/STAGE-64.md`](docs/architecture/STAGE-64.md) — listing = retrieval, оценка после карточки, список растёт по мере score; завершённые без решения не хранятся
- [`docs/architecture/STAGE-65.md`](docs/architecture/STAGE-65.md) — профиль поставки: работы в голове заголовка не становятся найденными
- [`docs/architecture/STAGE-66.md`](docs/architecture/STAGE-66.md) — очередь поиска хранится по профилю, пока её не разберут
- [`docs/architecture/STAGE-67.md`](docs/architecture/STAGE-67.md) — решение по лотам не зависит от их порядка (R07)
- [`docs/architecture/STAGE-68.md`](docs/architecture/STAGE-68.md) — «включая» помечает второстепенную клаузу, а не отменяет veto (R08)
- [`docs/architecture/STAGE-69.md`](docs/architecture/STAGE-69.md) — merge плана: ограничения профиля сильнее предположений модели (R09)
- [`docs/architecture/STAGE-70.md`](docs/architecture/STAGE-70.md) — объект извлекается из фразы поставки и коротких обозначений (R10)
- [`docs/architecture/STAGE-71.md`](docs/architecture/STAGE-71.md) — дедупликация не прячет непрочитанные страницы площадки (R11)
- [`docs/architecture/STAGE-72.md`](docs/architecture/STAGE-72.md) — лимит обращений к модели соблюдается на прогон, а не на карточку (R13)
- [`docs/architecture/STAGE-73.md`](docs/architecture/STAGE-73.md) — review-кандидат перепроверяется, а не воскрешается как есть (R05)
- [`docs/architecture/STAGE-74.md`](docs/architecture/STAGE-74.md) — оценка card-level проверки доходит до карточки UI (R06)
- [`docs/architecture/STAGE-75.md`](docs/architecture/STAGE-75.md) — запись кабинета: один writer, upsert вердиктов, точечный persist поиска
- [`docs/architecture/STAGE-76.md`](docs/architecture/STAGE-76.md) — удаление профиля: крестик и быстрый persist
- [`docs/architecture/STAGE-77.md`](docs/architecture/STAGE-77.md) — интерактивная линия MCP: открытие карточки не ждёт фоновую очередь (R43, часть 1)
- [`docs/architecture/STAGE-78.md`](docs/architecture/STAGE-78.md) — карточка, прочитанная при проверке, открывается без повторного живого чтения
- [`docs/architecture/STAGE-79.md`](docs/architecture/STAGE-79.md) — дедуп журнала решений: квадратичный рост `workspace_decisions` остановлен (R45)
- [`docs/architecture/STAGE-80.md`](docs/architecture/STAGE-80.md) — «Открыть карточку» из inbox всегда открывает нужную закупку (R46)
- [`docs/architecture/STAGE-81.md`](docs/architecture/STAGE-81.md) — порт дизайна «Мои закупки» и видов процедур из ветки Cursor
- [`docs/architecture/STAGE-82.md`](docs/architecture/STAGE-82.md) — слежение за сроком подачи: «истекает завтра» и «истёк» во входящих и тостах (R47)
- [`docs/architecture/STAGE-83.md`](docs/architecture/STAGE-83.md) — очередь поиска и живой прогресс восстанавливаются после reload (R01)
- [`docs/architecture/STAGE-84.md`](docs/architecture/STAGE-84.md) — «Открыть карточку» из inbox: просмотр отделён от решения, профиль происхождения сохраняется (R02)
- [`docs/architecture/STAGE-85.md`](docs/architecture/STAGE-85.md) — профильные операции требуют `profileId`, активный профиль не подменяет субъект запроса (R03)
- [`docs/architecture/STAGE-86.md`](docs/architecture/STAGE-86.md) — целостность записи кабинета: fail-closed БД, честные ошибки persist, single-flight, tmp+rename, durable inbox (R18–R21, R26)
- [`docs/architecture/STAGE-87.md`](docs/architecture/STAGE-87.md) — события мониторинга: единый diff при любом чтении живой карточки, identity перехода через `dedupeKey`, inbox-строка закрывается только после успешного действия (R22, R23, R25)
- [`docs/architecture/STAGE-88.md`](docs/architecture/STAGE-88.md) — профильная модель состояния: оценки по паре «карточка–профиль», `runId` владеет прогрессом, fingerprint профиля, durable прогон и ingest, scope по кабинету (R04, R12, R15–R17)
- [`docs/architecture/STAGE-89.md`](docs/architecture/STAGE-89.md) — полнота списков и доверие: серверная пагинация до UI, rate-limit на auth, атомарный «последний админ», evaluation гоняет реальный pipeline (R27, R38–R40)
- [`docs/architecture/STAGE-90.md`](docs/architecture/STAGE-90.md) — модель видит то же, что scorer: релевантные цитаты лотов с lotCount вместо первых N названий (R14)
- [`docs/architecture/STAGE-91.md`](docs/architecture/STAGE-91.md) — честные состояния списков: `ApiError`, автомат loading/error/ready/stale по вкладке, generation-защита от гонок, индикатор связи после трёх сбоев polling, точечная блокировка действий (R28)
- [`docs/architecture/STAGE-92.md`](docs/architecture/STAGE-92.md) — pending-фраза «Добавить слово» входит в сохранение и `dirty`, локальный ввод синхронизируется с ответом сервера (R29)
- [`docs/architecture/STAGE-93.md`](docs/architecture/STAGE-93.md) — guard несохранённых правок на навигацию по меню, форма профиля переинициализируется по `key={id}` (R30)
- [`docs/architecture/STAGE-94.md`](docs/architecture/STAGE-94.md) — «Назначение» редактируется, `description` сохраняется — редактор больше не затирает поля review-контекста (R31)
- [`docs/architecture/STAGE-95.md`](docs/architecture/STAGE-95.md) — «Открыть карточку» из inbox ведёт в раздел по состоянию кейса: «Мои закупки»/«Корзина»/«Закупки» (R48)
- [`docs/architecture/STAGE-96.md`](docs/architecture/STAGE-96.md) — resolve возвращает полную карточку, merge выбирает `sourceCard` по глубине — полая проекция не затирает кейс (R49)
- [`docs/architecture/STAGE-97.md`](docs/architecture/STAGE-97.md) — «Вернуть» из корзины снимает отказ, а не создаёт «Слежу»; возврат в «Участвую» возобновляет ingest (R36)
- [`docs/architecture/STAGE-98.md`](docs/architecture/STAGE-98.md) — «Тревога» только на срочные записи; review-кандидат показывает профиль и `reviewReason` (R34)
- [`docs/architecture/STAGE-99.md`](docs/architecture/STAGE-99.md) — контент-проб документов: sha256-проб одного файла на кейс за проход, diff по `contentHash`, `document_updated` запускает ingest у «Участвую» (R24)
- [`docs/architecture/STAGE-100.md`](docs/architecture/STAGE-100.md) — отмена поиска: статус `cancelled`, `POST /api/procurements/search/cancel`, маркер для listing-in-flight; select профиля не блокируется, честный прогресс (R35)
- [`docs/architecture/STAGE-101.md`](docs/architecture/STAGE-101.md) — деталь догружает полную карточку поверх slim-плитки («Документы (0)» исправлено); тосты «куда ушла карточка» на все перемещения (R50)
- [`docs/architecture/STAGE-102.md`](docs/architecture/STAGE-102.md) — «Скачать документы» во входящих: фоновый ingest вместо синхронного в POST, переход на карточку вместо `window.open`-пачки (R51)
- [`docs/architecture/STAGE-103.md`](docs/architecture/STAGE-103.md) — архивы RAR/7z через 7z-wasm, CP1251-имена в ZIP, HTML-вместо-файла → `download_failed`, «скачать всё архивом» по data-url/onclick (R52)
- [`docs/architecture/STAGE-104.md`](docs/architecture/STAGE-104.md) — модальное подтверждение: focus trap на Tab/Shift+Tab, возврат фокуса открывшей кнопке (R33)
- [`docs/architecture/STAGE-105.md`](docs/architecture/STAGE-105.md) — liveness `/api/live` vs readiness `/api/health`: живой ping PostgreSQL, sha деплоя, `degraded`-список, баннер в UI (R42)
- [`docs/architecture/STAGE-106.md`](docs/architecture/STAGE-106.md) — env-allowlist для дочернего MCP и очередь с дедлайном на ожидание + приоритетом (R43)
- [`docs/architecture/STAGE-107.md`](docs/architecture/STAGE-107.md) — единая актуальная спецификация очередей поиска и совместимости контрактов; STAGE-63/64/66 помечены историческими (R44)
- [`docs/architecture/STAGE-108.md`](docs/architecture/STAGE-108.md) — инкрементальный persist: skip неизменённых карточек/профилей/verdicts/inbox по canonicalJson-сравнению, `loadCasesByIds` вместо N+1 в tab=search, ограниченный кэш источника (R37)

---

## 2. Запуск

Нужен **Node.js 22+**. Пакетный менеджер — **npm** (не pnpm, не yarn).

```bash
git clone https://github.com/Serhio348/procurement-ai-platform.git
cd procurement-ai-platform
npm install
npm run verify
```

| Команда | Что делает |
|---|---|
| `npm run verify` | Полная проверка: типы → линт → тесты → архитектурные зависимости |
| `npm run typecheck` | Сборка типов по всем пакетам |
| `npm run lint` | ESLint |
| `npm test` | Vitest один прогон |
| `npm run test:watch` | Vitest в режиме наблюдения |
| `npm run arch` | dependency-cruiser: проверка слоёв |
| `npm run build` | Сборка пакетов в `dist/` |
| `npm run web` | API + Vite: консоль специалиста |

`npm run verify` должен проходить **до** коммита. Если он падает — работа не закончена.

---

## 3. Структура

```
packages/
  contracts/       Zod-схемы. Общий словарь данных. Зависит только от zod
  domain/          Чистая логика: расчёт score, разрешение конфликтов. Зависит только от contracts
  observability/   Структурный лог с correlation ids. Без зависимостей
  db/              PostgreSQL schema, migrations и repositories
  mcp-client/      Typed MCP client и Tool Policy Gate
apps/
  agent-runtime/   Supervisor, Context Compiler, DomainSearchAgent, DocumentAgent, CommercialTermsAgent, MonitoringAgent, ReportAgent, NotificationAgent
  api/             Fastify: inbox и карточки закупок для консоли
  web/             Консоль специалиста: inbox и список закупок
mcp/procurement/   Source-neutral Procurement MCP, fixture и live goszakupki.by
mcp/documents/     Documents MCP: hash, extract, OCR-сигнал
mcp/notifications/ Notifications MCP: inbox и telegram.send
workers/           (пусто) фоновые задачи
docs/architecture/ Документы этапов
```

Пустые каталоги появятся на соответствующих этапах. Не создавайте их «про запас».

---

## 4. Архитектурные правила, которые нельзя нарушать

Это не пожелания. Часть из них проверяется автоматически и уронит сборку.

**4.1. Доменный слой чист.** `packages/domain` не имеет права импортировать базу, HTTP, файловую систему, браузер, LLM и даже логгер. Только `contracts`. Проверяется ESLint и dependency-cruiser.

**4.2. Итоговую оценку считает код, а не модель.** Модель поставляет факты, цитаты, объяснения и уверенность. Числа и вердикт — только `packages/domain/src/scoring`. Никогда не просите модель «оценить закупку от 0 до 100».

**4.3. Факт без источника не существует.** У `Fact.evidenceIds` и `Risk.factIds` стоит `.min(1)`. Не ослабляйте это. Ответ «оплата 30%» без ссылки на документ и страницу — дефект.

**4.4. Никаких тихих подмен правил.** Более сильная область побеждает, но перекрытые правила возвращаются в `overridden` и остаются видимыми. Равные по силе противоречия эскалируются человеку, даже если одно правило свежее. Не добавляйте разрешение «по дате».

**4.5. Направления поиска — данные, а не код.** Любая тема (включая стартовый профиль электрооборудования) — запись `DomainProfile`. Никогда не создавайте агента под отрасль. Один универсальный `DomainSearchAgent` работает с любым профилем.

**4.6. Права на инструменты проверяет код.** У агента есть `allowedTools` и `forbiddenTools`. Запрет обеспечивается шлюзом перед вызовом MCP, а не текстом промпта. Промпт — не граница безопасности.

**4.7. Supervisor не выполняет работу.** Он планирует и делегирует. Он не парсит HTML, не качает файлы, не считает арифметику, не шлёт сообщения.

**4.8. Контекст компилируется, а не вываливается целиком.** Агенту передаётся `MinimalAgentContext` — только релевантный срез. Не передавайте всю историю пользователя, все профили и все задачи.

**4.9. Источники изолированы адаптерами.** Знание про конкретную площадку живёт в одном адаптере за общим интерфейсом. Добавление второй площадки не должно затрагивать агентов.

**4.10. Соседние проекты не сливаем.** `technical-library`, `mcp-pdf-reader`, `osmos-modbus-service` — отдельные продукты. Можно заимствовать подходы, нельзя тащить их код внутрь.

---

## 5. Соглашения кода

- **TypeScript строгий**, ESM. В относительных импортах указывайте расширение `.js`:
  `import { Fact } from "./common.js";`
- **Типы импортируйте через `import type`** — включён `verbatimModuleSyntax`.
- **Валидация — Zod.** Всё, что приходит извне (HTTP, MCP, LLM, страница площадки), проходит через схему.
- **`console.*` запрещён**, кроме `packages/observability`. Используйте логгер.
- **Комментарии в коде — на английском**, и только про то, чего код не может сказать сам: ограничение, компромисс, неочевидная причина. Не описывайте комментарием то, что и так видно.
- **Строки для специалиста — на русском** (вопросы при конфликтах, объяснения оценки).
- **Идентификаторы брендированные.** `ProcurementId` нельзя передать туда, где ждут `DocumentId`, хотя оба строки.
- **Внешние данные необязательны.** У карточки площадки обязательны только заголовок и ссылка. Всё остальное может отсутствовать — конвейер обязан это пережить, а не упасть.

### Тесты

Проверяйте инварианты, а не тавтологии. Хороший тест: «свежее правило не побеждает автоматически». Плохой: «функция возвращает то, что в неё положили».

Обязательно покрывайте: маршрутизацию, сборку контекста, конфликты правил, права на инструменты, извлечение из документов, дубликаты процедур, изменения документов, мониторинг, восстановление после сбоя.

Тесты лежат рядом с кодом: `*.test.ts`. Запускаются по исходникам, сборка не требуется.

---

## 6. Как вести этап

Работайте **по одному этапу**. Не пытайтесь реализовать платформу целиком.

Для каждого этапа выдавайте: цель, архитектурное решение, почему именно оно, изменения, новые файлы, изменяемые файлы, изменения БД, контракты API/MCP/агентов, тесты, риски, критерии приёмки.

После реализации обязательно: `npm run verify`, затем отчёт в `docs/architecture/STAGE-N.md`.

**Ошибки не скрывайте.** Если решение несёт архитектурный риск — сообщите о нём до реализации, а не после.

Коммиты: одно осмысленное изменение на коммит, сообщение на английском, объясняет **почему**, а не перечисляет файлы.

---

## 7. Текущее состояние

Готово:

- Этап 0 — архитектура
- Этап 1 — каркас монорепозитория, `contracts`, `domain`, `observability`, 38 тестов
- Этап 2 — PostgreSQL, Redis, MinIO, миграции и repositories
- Этап 3 — typed MCP client, Tool Policy Gate, Procurement MCP и fixture source
- Этап 4 — анонимный source-native поиск, live-карточки `goszakupki.by` и пять
  HTML-маршрутов
- Этап 5 — Supervisor: план из структурированных intents через DeepSeek API
- Этап 6 — Context Compiler: `MinimalAgentContext` для шага плана
- Этап 7 — DomainSearchAgent: поиск и классификация по Domain Profile
- Этап 8 — Document MCP и DocumentAgent: hash, extract, эскалация плохого OCR
- Этап 9 — CommercialTermsAgent: факты оплаты и аванса только с цитатой со страницы
- Этап 10 — MonitoringAgent: diff статуса, сроков и документов по правилам профиля
- Этап 11 — ReportAgent: markdown-отчёт из проверенных фактов, без выдуманной оценки
- Этап 12 — NotificationAgent: inbox и telegram.send уже сформированного текста
- Этап 13 — веб-интерфейс: inbox срочных ChangeEvent, без чата
- Этап 14 — живой inbox через Fastify API
- Этап 15 — список закупок и карточка кейса
- Этап 16 — живой прогон одной закупки с goszakupki.by
- Этап 17 — распознавание live-PDF (слой + OCR скана)
- Этап 18 — не сканировать альбомы проекта; конкурсные сканы — DeepSeek vision
- Этап 19 — поставка и гарантия из Word-ТЗ дешёвым разбором с цитатой
- Этап 20 — поиск по профилю из консоли (fixture, без чата)
- Этап 21 — живой поиск goszakupki.by из консоли через Procurement MCP
- Этап 22 — редактор профиля, решения по карточке и слежение за новыми закупками
- Этап 23 — несколько профилей, пустые поля, слежение на каждом
- Этап 24 — документы найденной процедуры после «Участвовать»
- Этап 25 — консоль: хеши в PostgreSQL, файлы в MinIO, discovery в Redis
- Этап 26 — вход, открытая регистрация, admin выдаёт роль
- Этап 27 — входящие разбираются действием и исчезают
- Этап 28 — журнал админа: доступ, вход/выход, счётчик ошибок
- Этапы 29–37 — фильтр поиска, разбор сомнительных, discovery, слежение за решёнными
- Этап 38 — карточка площадки сохраняется при «Участвовать»/«Следить»
- Этап 39 — статус «Не состоялась», истёкший срок, закупки из одного источника
- Этап 40 — вкладка «Архив» в «Мои закупки», кнопки «В архив»/«Убрать», один флажок одного источника
- Этап 41 — лимит скачивания файлов отдельно от страниц, подписанные сроки, сессии без взаимных выбросов
- Этап 42 — личный workspace у каждого пользователя; закупки и профили не общие
- Этап 43 — список и карточка из SQL, кабинет не поднимает все закупки в память
- Этап 44 — корзина: «Не нужно» / «Убрать» можно вернуть или удалить окончательно
- Этап 45 — админ видит сводку и список закупок чужого кабинета, только чтение
- Этап 46 — админ снимает разобранные ошибки, метка «ошибки N» гаснет
- Этап 47 — модель дочитывает пропущенные условия из документов; цитата, файл и
  страница видны специалисту, число без цитаты в карточку не попадает
- Этап 48 — поиск: модель разбирает фразу на объект и тип закупки, код считает
  оценку 0–100; одно слово больше не делает закупку подходящей
- Этап 49 — измеримый baseline поиска: `npm run evaluate:search`, метки
  relevant / irrelevant / uncertain, Precision / Recall / F1 без LLM
- Этап 50 — живой dump goszakupki.by по профилю «НКУ для управления насосами»:
  44 карточки площадки + 7 seed, Old vs New без подгонки весов
- Этап 51 — поиск: term-match по выдаче площадки, score 0 без объекта не
  review, поставщик ≠ поставка, `required_context` считает код
- Этап 52 — «Участвовать»: ingest в фоне, смена вкладки не отменяет скачивание
- Этап 53 — срок оплаты: период и событие из цитаты («после подписания акта»)
- Этап 54 — «Обновить» в «Моих закупках»: карточка площадки + переиндексация blobs
- Этап 55 — ZIP распаковывается; ссылка на Яндекс.Диск / файл вместо вложения качается
- Этап 59 — «Поиск» и слежение профиля: план модели параллельно со списком;
  карточки сомнительных у кнопки дочитывает фон; входящие сразу, без урезания
  фраз и страниц
- Этап 60 — «Слежу»/«Участвовать»: смена списка файлов на карточке во входящих;
  новые файлы качаются только у «Участвовать»
- Этап 61 — поиск: предмет лота (`lots[].title`) в `scoreSearchIntent`;
  каждая фраза профиля остаётся отдельным запросом площадке, результаты
  объединяются без голодания поздних фраз; listing не режет совпадение
  только в лоте или внутри кода; `procurement.get` только у review, лимит 50
- Этап 62 — аудит поиска: `SearchHit.matchedSearchTerms`, доля лимита на
  каждую фразу, лог по каждому запросу площадке и по каждому кандидату;
  объект из фразы работ («монтаж электрооборудования» → объект
  «электрооборудования»); короткие существительные в падежах (сети/сетей);
  «объект не найден» по карточке — не irrelevant, а модель / человек
- Этап 63 — план модели не сужает детерминированный; услуга в голове
  заголовка ≠ поставка; кандидат во входящих без «срочно»
- Этап 64 — listing не вердикт: score после `procurement.get` (title +
  лот); match пишется в SQL сразу; «Закупки» из кабинета, без wipe;
  завершённые без «Участвовать»/«Отслеживать» из кабинета уходят
- Этап 65 — профиль поставки: реконструкция / строительство / подряд в
  голове заголовка — вето, не найденная закупка; лот «Поставка …» может
  оставить совпадение
- Этап 66 — поиск по профилю не затирает чужую очередь; карточки живут,
  пока специалист не разберёт их
- Этап 67 — запись кабинета под замком: без deadlock профиля/входящих,
  upsert вердиктов, persist поиска по затронутым карточкам
- Этап 68 — крестик удаления профиля: `saveWorkspaceMeta` / optimistic UI;
  без переписи вердиктов, решений и inbox; строка исчезает сразу

Не начато: hash той же ссылки на «Отслеживать», PostgreSQL outbox для inbox,
входящий Telegram-бот.
OCR / vision электрических схем и чертежей — отдельная фича (не этапы 17–21).

### План этапов

| № | Этап | Можно ли делать без доступа к площадке |
|---|---|---|
| 2 | База данных и миграции | да |
| 3 | Procurement MCP | да |
| 4 | Адаптер goszakupki.by | да: карточки и анонимный search |
| 5 | Supervisor | да |
| 6 | Context Compiler | да |
| 7 | DomainSearchAgent | да |
| 8 | Document MCP + DocumentAgent | да |
| 9 | CommercialTermsAgent | да |
| 10 | Мониторинг | да |
| 11 | Отчёты | да |
| 12 | NotificationAgent | да |
| 13 | Веб-интерфейс (inbox) | да |
| 14 | Живой inbox через HTTP API | да |
| 15 | Список закупок и карточка кейса | да |
| 16 | Входящий Telegram | да |
| 17 | Наблюдаемость | да |
| 18 | Усиление безопасности | да |
| 19 | Сквозное тестирование | частично |

Нумерация файлов `STAGE-N.md` после этапа 14 сдвинута под консоль:
15 — список закупок, 16 — живой прогон и локальные PDF, 17 — распознавание
PDF, 18 — отбор вложений и vision сканов конкурса, 19 — факты из Word-ТЗ,
20 — поиск по профилю из UI, 21 — живой поиск goszakupki.by из консоли,
22 — профиль, triage и watch, 23 — несколько профилей,
24 — документы после «Участвовать», 25 — PostgreSQL / MinIO / Redis.
Строки «входящий Telegram / наблюдаемость / безопасность / e2e» в таблице —
очередь работ, не следующие свободные номера документов.

---

## 8. Доступ к площадке

Текущая машина разработки находится в Беларуси. Проверено 02.09.2026:

- `goszakupki.by`, список процедур и публичные карточки `auction`, `marketing`,
  `request`, `etrade`, `single-source` доступны;
- для `/tenders/posted` нужна анонимная cookie-сессия: сначала открывается
  главная страница, затем список; учётная запись не требуется;
- `icetrade.by` отвечает `403`, но не входит в этап 4.

Следствия:

1. `PROCUREMENT_SOURCE_MODE=fixture` остаётся безопасным режимом по умолчанию.
2. `PROCUREMENT_SOURCE_MODE=live` разрешён для source-native поиска и чтения
   известных карточек.
3. Не подменяйте `goszakupki.by` сторонним агрегатором внутри этого адаптера.
   Адаптер использует только публичный источник и анонимную сессию.
4. Production-воркер доступа к площадке должен исполняться с белорусского
   адреса.

Языковые модели (DeepSeek, OpenAI-совместимые) доступны из любой страны — здесь ограничений нет.

---

## 9. Целевой стек

Утверждён на этапе 0, менять только с обоснованием.

| Назначение | Выбор |
|---|---|
| Монорепозиторий | npm workspaces |
| Frontend | React + TypeScript + Vite |
| API | Node.js + Fastify |
| База | PostgreSQL 16 |
| Миграции | Drizzle ORM |
| Очередь | Redis + BullMQ |
| Хранилище файлов | S3-совместимое, локально MinIO |
| Валидация | Zod |
| Тесты | Vitest, Playwright для e2e |
| LLM | Адаптер провайдера, OpenAI-совместимый API |
| Telegram | Bot API |

---

## 10. Настройка окружения

```bash
cp .env.example .env
```

Заполните `DATABASE_URL`, `REDIS_URL`, `LLM_API_KEY`, `TELEGRAM_BOT_TOKEN` по мере надобности этапов.

`.env` **никогда не коммитится**. Секреты не попадают в Domain Profiles и не пишутся в логи — логгер вырезает поля вроде `token`, `api_key`, `authorization` автоматически.

Для локальной инфраструктуры (PostgreSQL, Redis, MinIO) понадобится Docker. На этапе 2 появится `infra/docker-compose.yml`.
