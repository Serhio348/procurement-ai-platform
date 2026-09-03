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

Не начато: веб-интерфейс, входящий Telegram-бот.

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
| 13 | Веб-интерфейс | да |
| 14 | Входящий Telegram | да |
| 15 | Наблюдаемость | да |
| 16 | Усиление безопасности | да |
| 17 | Сквозное тестирование | частично |

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
