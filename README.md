# Procurement AI Platform

Автономная AI-платформа для поиска, мониторинга, исследования и анализа конкурсных процедур и закупок.

**Статус:** этап 42 — у каждого пользователя свой кабинет. Профили,
решения и закупки изолированы; карточка площадки и файлы общие по хешу.
Документы по-прежнему только после «Участвовать». Это не чат.

## Принцип

Это не «чат с AI». Это платформа с ограниченной ответственностью каждого слоя:

```
User → Intent → Context → Supervisor → Domain / Capability
     → Specialized Agent → MCP → Tool → External System
```

- **Domain Profiles** — данные, не код.
- **Capabilities / системные агенты** — код.
- **MCP** — стандартизированный слой инструментов.
- **Supervisor** — координатор, не исполнитель спецопераций.
- **Context Compiler** — защита модели от перегрузки контекста.
- **Web UI** — основной интерфейс.
- **Telegram** — дополнительный канал.
- **Human** — финальная инстанция при неопределённости.

## Документы

- [**Инструкция по разработке**](AGENTS.md) — начните отсюда, если продолжаете работу над проектом
- [Новый Ubuntu-сервер (VirtualBox / заказчик)](docs/ops/ubuntu-server.md)
- [Живая консоль на VPS (клиенты, пароль, goszakupki.by)](docs/ops/vps-console.md)
- [Этап 0 — архитектура](docs/architecture/STAGE-0.md)
- [Этап 1 — структура репозитория и базовые пакеты](docs/architecture/STAGE-1.md)
- [Этап 2 — инфраструктура и PostgreSQL](docs/architecture/STAGE-2.md)
- [Этап 3 — Procurement MCP](docs/architecture/STAGE-3.md)
- [Этап 4 — адаптер goszakupki.by](docs/architecture/STAGE-4.md)
- [Этап 5 — Supervisor](docs/architecture/STAGE-5.md)
- [Этап 6 — Context Compiler](docs/architecture/STAGE-6.md)
- [Этап 7 — DomainSearchAgent](docs/architecture/STAGE-7.md)
- [Этап 8 — Document MCP и DocumentAgent](docs/architecture/STAGE-8.md)
- [Этап 9 — CommercialTermsAgent](docs/architecture/STAGE-9.md)
- [Этап 10 — MonitoringAgent](docs/architecture/STAGE-10.md)
- [Этап 11 — ReportAgent](docs/architecture/STAGE-11.md)
- [Этап 12 — NotificationAgent](docs/architecture/STAGE-12.md)
- [Этап 13 — веб-интерфейс](docs/architecture/STAGE-13.md)
- [Этап 14 — живой inbox через HTTP API](docs/architecture/STAGE-14.md)
- [Этап 15 — список закупок и карточка кейса](docs/architecture/STAGE-15.md)
- [Этап 16 — живой прогон одной закупки](docs/architecture/STAGE-16.md)
- [Этап 17 — распознавание live-PDF](docs/architecture/STAGE-17.md)
- [Этап 18 — отбор файлов и vision сканов конкурса](docs/architecture/STAGE-18.md)
- [Этап 19 — факты поставки и гарантии из Word-ТЗ](docs/architecture/STAGE-19.md)
- [Этап 20 — поиск по профилю из консоли](docs/architecture/STAGE-20.md)
- [Этап 21 — живой поиск goszakupki.by из консоли](docs/architecture/STAGE-21.md)
- [Этап 22 — профиль, решение и слежение](docs/architecture/STAGE-22.md)
- [Этап 23 — несколько профилей](docs/architecture/STAGE-23.md)
- [Этап 24 — документы после «Участвовать»](docs/architecture/STAGE-24.md)
- [Этап 25 — PostgreSQL, MinIO и Redis для консоли](docs/architecture/STAGE-25.md)
- [Этап 42 — личные кабинеты и изоляция данных](docs/architecture/STAGE-42.md)

## Пакеты

| Пакет | Роль |
|---|---|
| `@procurement/contracts` | Zod-схемы: идентификаторы, Domain Profile, Intent, Task, Procurement Case, контракты агентов |
| `@procurement/domain` | Чистая логика: детерминированный расчёт score, разрешение конфликтов правил |
| `@procurement/observability` | Структурный лог с correlation ids |
| `@procurement/mcp-client` | Типизированные MCP-вызовы, timeout/error mapping и Tool Policy Gate |
| `@procurement/mcp-procurement` | Source-neutral Procurement MCP, fixture и live-карточки goszakupki.by |
| `@procurement/mcp-documents` | Documents MCP: blob по sha256, fixture extract/OCR |
| `@procurement/mcp-notifications` | Notifications MCP: inbox и telegram.send |
| `@procurement/agent-runtime` | Supervisor, Context Compiler, DomainSearchAgent, DocumentAgent, CommercialTermsAgent, MonitoringAgent, ReportAgent, NotificationAgent |
| `@procurement/api` | Fastify: inbox, карточки, профиль, поиск; PostgreSQL / MinIO / Redis |
| `@procurement/web` | Консоль специалиста: inbox, закупки, профиль |

## Разработка

```bash
npm install
npm run verify   # типы, линт, тесты, архитектурные зависимости
npm run web      # API (3001) + консоль специалиста (Vite 5173)
npm run capture:live-case  # живой кейс + PDF в data/blobs (нужна сеть РБ)
```

Требуется Node.js 22 или новее.

## Доступ к площадкам

Текущая машина разработки находится в Беларуси, и публичные карточки
`goszakupki.by` доступны. Детерминированная разработка и CI по умолчанию
работают на сохранённых страницах:

```
PROCUREMENT_SOURCE_MODE=fixture
```

Live-режим выполняет source-native поиск и читает публичные карточки:

```
PROCUREMENT_SOURCE_MODE=live
```

Клиент сначала открывает главную страницу, получает анонимную cookie-сессию и
затем читает `/tenders/posted`. Учётная запись и сторонний сервис не нужны.

## Репозиторий

- GitHub: https://github.com/Serhio348/procurement-ai-platform
- Локально: `E:\Projects\procurement-ai-platform`

## Следующий шаг

Чтобы консоль писала в PostgreSQL / MinIO / Redis: `npm run infra:up`, затем
`npm run db:migrate`. Без Docker остаются JSON-файл и `data/blobs`.
Telegram-бот и OCR чертежей — отдельные работы. На чистой Ubuntu 24.04
инфраструктуру поднимают по [инструкции сервера](docs/ops/ubuntu-server.md).
