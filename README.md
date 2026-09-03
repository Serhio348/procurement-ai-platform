# Procurement AI Platform

Автономная AI-платформа для поиска, мониторинга, исследования и анализа конкурсных процедур и закупок.

**Статус:** этап 6 завершён — Context Compiler собирает минимальный контекст
агента без вызова модели. Агентов-исполнителей и веб-интерфейса пока нет.

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
- [Этап 0 — архитектура](docs/architecture/STAGE-0.md)
- [Этап 1 — структура репозитория и базовые пакеты](docs/architecture/STAGE-1.md)
- [Этап 2 — инфраструктура и PostgreSQL](docs/architecture/STAGE-2.md)
- [Этап 3 — Procurement MCP](docs/architecture/STAGE-3.md)
- [Этап 4 — адаптер goszakupki.by](docs/architecture/STAGE-4.md)
- [Этап 5 — Supervisor](docs/architecture/STAGE-5.md)
- [Этап 6 — Context Compiler](docs/architecture/STAGE-6.md)

## Пакеты

| Пакет | Роль |
|---|---|
| `@procurement/contracts` | Zod-схемы: идентификаторы, Domain Profile, Intent, Task, Procurement Case, контракты агентов |
| `@procurement/domain` | Чистая логика: детерминированный расчёт score, разрешение конфликтов правил |
| `@procurement/observability` | Структурный лог с correlation ids |
| `@procurement/mcp-client` | Типизированные MCP-вызовы, timeout/error mapping и Tool Policy Gate |
| `@procurement/mcp-procurement` | Source-neutral Procurement MCP, fixture и live-карточки goszakupki.by |
| `@procurement/agent-runtime` | Supervisor и Context Compiler: план и `MinimalAgentContext` без вызова MCP |

## Разработка

```bash
npm install
npm run verify   # типы, линт, тесты, архитектурные зависимости
npm test
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

Следующий плановый этап — DomainSearchAgent. На чистой Ubuntu 24.04 инфраструктуру поднимают по
[инструкции сервера](docs/ops/ubuntu-server.md).
