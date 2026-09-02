# Procurement AI Platform

Автономная AI-платформа для поиска, мониторинга, исследования и анализа конкурсных процедур и закупок.

**Статус:** Этап 3 завершён — контракты, инфраструктура, типизированный Procurement MCP и fixture-источник. Агентов и live-адаптеров площадок пока нет.

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

## Пакеты

| Пакет | Роль |
|---|---|
| `@procurement/contracts` | Zod-схемы: идентификаторы, Domain Profile, Intent, Task, Procurement Case, контракты агентов |
| `@procurement/domain` | Чистая логика: детерминированный расчёт score, разрешение конфликтов правил |
| `@procurement/observability` | Структурный лог с correlation ids |
| `@procurement/mcp-client` | Типизированные MCP-вызовы, timeout/error mapping и Tool Policy Gate |
| `@procurement/mcp-procurement` | Source-neutral Procurement MCP и fixture-режим |

## Разработка

```bash
npm install
npm run verify   # типы, линт, тесты, архитектурные зависимости
npm test
```

Требуется Node.js 22 или новее.

## Доступ к площадкам

Белорусские закупочные порталы блокируют трафик из других стран. Пока рантайм не находится в белорусской сети, работаем на сохранённых страницах:

```
PROCUREMENT_SOURCE_MODE=fixture
```

Подробности и результаты проверки — в разделе «Гео-блокировка» документа [этапа 1](docs/architecture/STAGE-1.md).

## Репозиторий

- GitHub: https://github.com/Serhio348/procurement-ai-platform
- Локально: `E:\Projects\procurement-ai-platform`

## Следующий шаг

Следующий этап — адаптер `goszakupki.by`; для него нужны сохранённые HTML-образцы
четырёх семейств страниц. На чистой Ubuntu 24.04 инфраструктуру поднимают по
[инструкции сервера](docs/ops/ubuntu-server.md).
