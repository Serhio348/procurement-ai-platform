# Этап 0 — Архитектурный анализ

**Цель этапа:** зафиксировать целевую архитектуру, границы ответственности, модели данных и контракты. Код прикладной платформы на этом этапе не пишется.

**Статус:** на проверке. Реализация начинается только после подтверждения.

---

## 0. Формат этапа

| Поле | Содержание |
|---|---|
| Цель | Спроектировать production-ready AI-платформу закупок без реализации |
| Архитектурное решение | Greenfield-монорепозиторий: Domain Profiles как данные, Capabilities как код, MCP как tool layer, Supervisor как координатор |
| Почему | Текущий workspace был пуст; отдельного репозитория платформы не существовало |
| Изменения | Создан репозиторий и документы этапа 0 |
| Новые файлы | `README.md`, `docs/architecture/STAGE-0.md`, `.gitignore` |
| Изменяемые файлы | нет |
| Database changes | нет (модель описана, миграции — этап 2) |
| API / MCP / Agent contracts | спецификации ниже, реализация позже |
| Tests | не пишутся на этапе 0 |
| Risks | см. раздел 16 |
| Acceptance criteria | архитектура проверена человеком; можно переходить к этапу 1 |

---

## 1. Существующий репозиторий и окружение

### 1.1 Этот проект

Репозиторий **создан с нуля**. Кода, схемы БД, агентов и MCP в нём нет.

| | |
|---|---|
| GitHub | https://github.com/Serhio348/procurement-ai-platform (private) |
| Локальный путь | `E:\Projects\procurement-ai-platform` |
| Ветка | `main` |
| Содержимое до этапа 0 | пустой git |

Текущий Cursor workspace изначально был временным каталогом без git. Переписывать было нечего.

### 1.2 Связанные системы (не этот продукт)

Их **нельзя** сливать в эту платформу. Это соседние продукты той же компании. Их можно использовать как источник паттернов и позже — как внешние интеграции.

| Проект | Путь | Что это | Вывод для платформы |
|---|---|---|---|
| `technical-library` | `E:\Projects\technical-library` | PDF/OCR/поиск нормативных документов, Telegram, DeepSeek | Отдельный продукт. Documents MCP проектируется независимо; позже возможен адаптер к библиотеке как Company Knowledge source |
| `mcp-pdf-reader` | `E:\Projects\mcp-pdf-reader` | Python MCP (Docling) для извлечения текста PDF | Паттерн MCP tool layer. Не копировать как основу: у платформы нужны версии, hash, provenance, таблицы, OCR, не только markdown |
| `osmos-modbus-service` | `E:\Projects\osmos-modbus-service` | Мониторинг установок водоподготовки, `services/ai-agent` | Предметная область компании (водоподготовка). **Не** закупки. Intent/rules engine там — про станцию, не про процедуры |

### 1.3 Существующая архитектура (факт)

Архитектуры AI Procurement Platform **нет**. Есть соседние AI-системы «чат + правила + документы» для других задач. Целевая платформа должна быть **не** чатом, а оркестрацией узких capabilities.

---

## 2. Ограничения

### 2.1 Продуктовые

1. Не один большой AI-агент.
2. Не отдельный класс агента на каждое предметное направление.
3. Специалист управляет Domain Profiles, правилами, задачами, мониторингом через UI.
4. Программист добавляет только новые **capabilities**, когда платформы недостаточно.
5. Новые задачи не удаляют старые. Конфликты не резолвятся молча.
6. LLM извлекает факты и объяснения. Итоговый score считает детерминированный код.
7. Каждый важный факт имеет provenance.
8. Web UI — основной канал. Telegram — дополнительный.
9. MVP — один вертикальный срез, не вся платформа.

### 2.2 Внешние

1. Первый источник: `goszakupki.by`. Публичного стабильного JSON API на этапе анализа **не подтверждено**.
2. Запрос к карточке `https://goszakupki.by/auction/view/3545578` на этапе анализа **таймаутнулся**. Это риск адаптера: сайт может быть медленным, недоступным из среды агента, требовать JS/cookies, либо блокировать автоматический доступ.
3. Юридические ограничения парсинга и использования данных площадки нужно проверить до production-нагрузки.
4. Документы: PDF, DOCX, XLSX, сканы. OCR обязателен для части корпуса.
5. Компания работает в домене водоподготовки — это **первый Domain Profile**, не отдельный агент.

### 2.3 Инженерные

1. TypeScript end-to-end (кроме возможных изолированных OCR/extract workers).
2. PostgreSQL — система записи.
3. Least privilege на инструменты агентов обеспечивается **кодом**, не промптом.
4. Система должна переживать недоступность площадки (circuit breaker, retry, DLQ, кэш карточек).

---

## 3. Целевая архитектура

### 3.1 Управляющий поток

```
User (Web UI / Telegram)
        ↓
Ingress (API / Bot adapter)
        ↓
Intent Compiler          — сообщение → структурированный Intent
        ↓
Conflict Resolver        — иерархия политик; иначе needs_human
        ↓
Task Planner             — создать / не трогать существующие независимые задачи
        ↓
Supervisor LLM           — координация, не спецоперации
        ↓
Context Compiler         — минимальный релевантный контекст
        ↓
Task / Intent Router     — capability + domain profile + agent
        ↓
Specialized Agent        — узкая задача, строгий schema I/O
        ↓
Tool Policy Gate         — allow/deny list в коде
        ↓
MCP Client
        ↓
MCP Server
        ↓
MCP Tool
        ↓
Adapter / External System
```

### 3.2 Слои (не смешивать)

| Слой | Ответственность | Запрещено |
|---|---|---|
| **Domain** | сущности, инварианты, scoring formulas, policy hierarchy, provenance types | HTTP, LLM, SQL, MCP |
| **Application** | use cases: создать intent, скомпилировать контекст, запустить investigation, сохранить decision | прямые вызовы площадки, промпты |
| **Infrastructure** | PostgreSQL, Redis, S3, HTTP clients, Playwright, OCR, LLM provider | бизнес-правила |
| **API** | REST/JSON, auth, DTO validation (Zod) | оркестрация агентов внутри handler |
| **Agents** | Supervisor + specialized runtimes | обход Tool Policy Gate |
| **MCP** | стандартизированные tools | знание Domain Profiles |
| **Workers** | BullMQ jobs: search, download, monitor, notify | UI-логика |
| **Scheduler** | cron/интервалы мониторинга и digest | принятие решений |

### 3.3 Runtime-компоненты

| Компонент | Процесс | Зачем отдельно |
|---|---|---|
| `apps/web` | SPA | основной UX |
| `apps/api` | HTTP API | CRUD, auth, команда «создать задачу», чтение кейсов |
| `apps/agent-runtime` | Supervisor + agents | изоляция LLM, таймауты, policy gate |
| `apps/telegram-bot` | Bot API | alerts / digest / approve |
| `mcp/*` | отдельные MCP servers | добавлять tools без переписывания Supervisor |
| `workers/*` | BullMQ processors | долгие scrape/download/OCR |
| `infra` | compose: Postgres, Redis, MinIO | локальный prod-like контур |

API **не** вызывает LLM напрямую. API ставит команду/задачу в очередь или вызывает Application service, который делегирует в agent-runtime.

### 3.4 Почему так

1. **Domain Profile = данные.** Количество направлений не ограничено кодом. UI может создавать/включать/архивировать профили.
2. **Capability = код.** Новая способность (например CostCalculation) появляется как агент и/или MCP server, затем привязывается к профилю через UI.
3. **MCP отдельно от Supervisor.** Supervisor знает имена tools и capability map, не знает HTML goszakupki.by.
4. **Adapter на источник.** `GoszakupkiByAdapter` изолирован. Следующая площадка — новый адаптер, тот же `ProcurementSourcePort`.
5. **Progressive investigation** — экономия токенов и устойчивость к мусору выдачи.
6. **Deterministic scoring** — модель не «ставит оценку», она поставляет факты.

### 3.5 Стек (предложение)

| Назначение | Выбор | Почему |
|---|---|---|
| Monorepo | pnpm workspaces + Turborepo | общие Zod-контракты, один CI |
| Frontend | React 19, TypeScript, Vite | запрошенный стек, быстрый UI |
| UI kit | собственный минимальный слой + существующие паттерны web-приложений пользователя | не тащить тяжёлый admin framework в MVP |
| API | Node.js, TypeScript, Fastify | явные плагины, Zod, низкий overhead |
| Agent runtime | отдельный Node.js сервис | таймауты, изоляция, свой concurrency limit |
| Validation | Zod | контракты API, MCP, агентов, env |
| DB | PostgreSQL 16 | запрошено |
| Migrations / SQL | Drizzle ORM | SQL-first, хорошо стыкуется с Zod, без скрытой магии |
| Queue | Redis + BullMQ | retries, backoff, DLQ, repeatable jobs |
| Object storage | S3-compatible (MinIO locally) | content-addressed blobs, без дублей |
| LLM | provider adapter (OpenAI-compatible; DeepSeek уже используется в соседних системах) | смена модели без смены агентов |
| Documents extract | отдельный worker: PDF/DOCX/XLSX + OCR | тяжёлое CPU/IO вне event loop API |
| Telegram | grammY или Telegraf | зрелый Bot API |
| Observability | structured JSON logs + request/task/agent/run ids; OpenTelemetry traces позже | сначала корреляция, потом APM |
| Tests | Vitest + Playwright | unit/integration + e2e UI |

**Альтернатива, сознательно не выбрана:** NestJS — больше магии DI, легче смешать слои. Prisma — удобнее для CRUD, хуже для явных SQL-инвариантов scoring/facts. Один процесс «API+agents+MCP» — быстрее стартовать, но ломает least privilege и независимый деплой MCP.

---

## 4. Domain Model

### 4.1 Главный агрегат: `ProcurementCase`

Единый объект жизненного цикла закупки.

```
ProcurementCase
  identity:     id, source, source_procurement_id, canonical_url, year
  procedure:    title, buyer, type, status, publish_dates, deadlines
  lots[]
  documents[]          + versions[]
  facts[]              + evidence[]
  analysis             (technical / commercial / auction)
  risks[]
  scores               (computed, versioned formula)
  changes[]
  monitoring
  decisions[]
  notifications[]
  execution_history[]
```

Инвариант: одна процедура на `(source, source_procurement_id)`. Повторный поиск не создаёт дубль — присоединяется к кейсу.

### 4.2 Domain Profile (данные)

Не класс агента. Запись в БД, редактируемая специалистом.

| Поле | Назначение |
|---|---|
| name, slug, description, purpose | идентичность |
| instructions | текст для агента после компиляции контекста |
| keywords[], semantic_concepts[] | поиск и классификация |
| positive_criteria[], negative_criteria[] | релевантность |
| constraints[] | жёсткие ограничения |
| scoring_rules | веса/пороги для ScoringEngine |
| enabled, archived, priority | управление |
| associated_capabilities[] | какие агенты можно вызывать |
| associated_mcp_tools[] | какие tools разрешены в рамках профиля (пересечение с agent allowlist) |
| monitoring_rules[] | что считать изменением |

Создание через UI: специалист пишет свободный текст → LLM предлагает структурированный профиль → **подтверждение человеком** → persist. Без confirm не сохранять.

### 4.3 Остальные доменные сущности

- **Company / User** — tenant на старте = одна компания.
- **Intent** — структурированная воля специалиста (не чат-история).
- **Task** — исполняемая единица (permanent / one-shot / monitoring / human_review).
- **Policy** — System / Company правила.
- **Fact + Evidence** — утверждение со ссылкой на документ/страницу/поле карточки.
- **Risk** — типизированный риск с severity и evidence.
- **ScoreSnapshot** — результат формулы на версии правил.
- **Decision** — human: approve / reject / investigate / monitor / ignore.
- **ChangeEvent** — diff статуса, цены, документов (hash).
- **AgentDefinition / AgentRun / ToolCall** — наблюдаемость.
- **CompanyKnowledge** — внутренние нормы, не промпт «всего сразу».

### 4.4 Граница программист / специалист

| Делает специалист (UI) | Делает программист (код) |
|---|---|
| Domain Profiles | новый Capability / Agent |
| tasks, monitoring, rules, constraints | новый MCP server / tool |
| предпочтения, exceptions, instructions | новый source adapter |
| enable/disable/archive профилей | изменение policy engine / scoring engine |
| привязка существующих capabilities к профилю | смена контрактов |

Пример: «Ищи промышленные системы дозирования» — новый Domain Profile.  
«Считай себестоимость по внутренним нормативам» — новый `CostCalculationAgent` + tool, затем профиль может на него сослаться.

---

## 5. Agent Model

### 5.1 Supervisor

Отвечает за: понимание запроса, intent, scope, нужные capabilities, выбор Domain Profiles, декомпозицию, делегирование, merge результатов, next step, эскалацию.

**Не делает:** search HTML, download files, OCR, scoring arithmetic, send Telegram, delete anything.

Выход Supervisor — план:

```
SupervisorPlan
  intents[]
  selected_domain_profile_ids[]
  steps[]: { agent, capability, input_ref, reason }
  needs_human: boolean
  human_question?: string
```

### 5.2 Specialized agents (capabilities)

Один runtime-класс на capability, не на предметную область.

`DomainSearchAgent` — **универсальный runtime**. На вход получает Domain Profile. Water Treatment / Pumps / Automation — конфигурации.

| Agent | Role | Responsibility | ALLOW tools (MVP+) | DENY (всегда) |
|---|---|---|---|---|
| DomainSearchAgent | search/classify | кандидаты, релевантность, reasons, confidence, need_deeper | procurement.search, procurement.get, procurement.get_lots | documents.*, files.delete, telegram.send |
| DocumentAgent | ingest | list/download/extract, versioning, hash | documents.*, procurement.get_documents, files.put | telegram.send, files.delete |
| CommercialTermsAgent | extract commercial | оплата, аванс, сроки, гарантия, обеспечения | documents.search, documents.get_page, memory.get | procurement.search, telegram.send |
| AuctionAnalysisAgent | auction | аукцион? шаг? снижение? правила цены | procurement.get, documents.search | telegram.send |
| RiskAnalysisAgent | risks | типы рисков + evidence + severity proposal | memory.get, documents.search | telegram.send, files.delete |
| MonitoringAgent | watch | status/price/docs hash, ChangeEvent | procurement.get_status, procurement.get_changes, procurement.get_documents | telegram.send |
| NotificationAgent | notify | доставить уже сформированное сообщение | notification.send, telegram.send | procurement.*, documents.download |
| ReportAgent | report | собрать Procurement Case → отчёт | memory.get, files.put | telegram.send, documents.delete |

**MVP subset:** DomainSearchAgent, DocumentAgent, CommercialTermsAgent, MonitoringAgent, NotificationAgent.  
AuctionAnalysisAgent в MVP — **узкий** (поля карточки + явные признаки аукциона), без глубокого legal analysis.  
RiskAnalysisAgent и полный ReportAgent — после MVP, но модель данных сразу предусматривает scores/risks/reports.

Каждый агент:

- `input_schema` / `output_schema` (Zod)
- `allowed_tools` / `forbidden_tools`
- `context_requirements` (что имеет право запросить у Context Compiler)
- `error_handling` (retryable vs terminal vs needs_human)
- `confidence` в output
- при `confidence < threshold` → `needs_human = true`

### 5.3 Agent contract (логический)

```
AgentRunInput
  run_id, task_id, request_id
  agent_id
  compiled_context          # уже минимальный
  input                     # schema-specific

AgentRunOutput
  status: success | failed | needs_human | skipped
  confidence: 0..1
  payload                   # schema-specific
  facts[]
  evidence[]
  next_recommended_step?
  error?
```

Tool Policy Gate: если tool не в allowlist или в denylist — вызов **не доходит** до MCP. Промпт вторичен.

---

## 6. MCP Model

MCP — единственный стандартизированный способ доступа агентов к внешнему миру (кроме чтения compiled context).

Supervisor **не** импортирует адаптеры площадок. Новый MCP server регистрируется в capability registry.

### 6.1 Servers

| Server | Назначение | MVP |
|---|---|---|
| Procurement MCP | поиск и карточки процедур | да |
| Documents MCP | list/download/extract/ocr/search | да |
| Files MCP | content-addressed storage | да (минимум put/get/exists) |
| Memory MCP | факты, кейс, короткая память агента | частично (через API/DB в MVP допустим внутренний порт; MCP — канон) |
| Company Knowledge MCP | внутренние нормы | нет в MVP |
| Notification MCP | email/UI inbox/telegram | да (telegram + in-app) |

### 6.2 Procurement MCP tools

- `procurement.search`
- `procurement.get`
- `procurement.get_lots`
- `procurement.get_status`
- `procurement.get_history`
- `procurement.get_documents`
- `procurement.get_changes`

Порт:

```
ProcurementSourcePort
  source_id
  search(query) → SearchHit[]
  get(id) → ProcedureCard
  getLots(id)
  getStatus(id)
  getHistory(id)
  getDocuments(id)
  getChanges(id, since)
```

`GoszakupkiByAdapter` — первая реализация. Остальные площадки — новые адаптеры, тот же port.

### 6.3 Documents MCP tools

- `documents.list`
- `documents.download`
- `documents.extract_text`
- `documents.extract_tables`
- `documents.ocr`
- `documents.search`
- `documents.get_page`

Метаданные документа: `id, name, source_url, download_date, mime_type, size, hash, status`.

Дубликаты запрещены: blob ключ = `sha256`. Новая версия, если hash изменился. Старая версия сохраняется.

### 6.4 File layout (логический)

```
/procurements/{year}/{procurement_id}/
    source/
    documents/
    extracted/
    analysis/
    reports/
```

Физически: S3 objects `blobs/{sha256}` + DB pointers. Папки — проекция для человека и отчётов, не копирование байт.

---

## 7. Context Compiler

Не передавать LLM всю историю специалиста.

Вход: current event + identity + agent role.

Выход: `MinimalAgentContext` в бюджете токенов роли.

```
MinimalAgentContext
  event                  # что случилось сейчас
  intent                 # только релевантный
  domain_profile         # только выбранный (или top-N с priority)
  constraints            # system + company + domain + task, уже merged
  procurement            # текущий кейс, если есть; не все 100 кейсов
  relevant_history       # последние N решений по ЭТОМУ кейсу / профилю
  allowed_tools          # явно
  output_contract        # schema reminder
```

Правила отбора (детерминированные, не «пусть модель сама выберет из всего»):

1. Фильтр по `task_id` / `procurement_id` / `domain_id`.
2. Policy merge по иерархии (см. конфликты).
3. History: только решения и facts с тем же scope, лимит N, свежее важнее.
4. Жёсткий token budget per agent. При превышении — drop least relevant, never silent drop of active constraints.
5. Если constraints не влезли — `needs_human`, не урезать политику.

---

## 8. Intent Model

Сообщение специалиста → структурированная сущность. Чат-история не является системой записи.

| type | Пример | Эффект |
|---|---|---|
| permanent_intent | «Всегда ищи водоподготовку» | живая задача, не истекает |
| one_time_task | «Найди закупки на этой неделе» | выполняется и закрывается |
| monitoring_request | «Следи за 3545578» | MonitoringRule + task |
| constraint | «Не интересуют бытовые системы» | constraint в scope |
| preference | «Предпочитай короткие сроки поставки» | мягкий вес в scoring |
| rule | «Аванс > 50% — высокий риск» | domain/company rule |
| exception | «Кроме процедуры X» | scoped exception |
| instruction | «В этом направлении проверяй наличие монтажа» | domain instructions |
| question | «Какие сроки по 3545578?» | one-shot Q&A по кейсу |

Независимые intents **сосуществуют**. «Ищи водоподготовку» + «дополнительно ищи насосы» = два permanent intent / два профиля, не overwrite.

---

## 9. Task Model

```
Task
  id
  type: permanent | one_time | monitoring | human_review
  status: active | paused | completed | failed | waiting_human
  scope: system | company | domain | procurement | task
  intent_id
  domain_profile_id?
  procurement_id?
  priority
  schedule?              # cron / interval
  created_by, created_at, updated_at
```

UI списки: Active, Completed, Paused, Monitoring, Human Review.

Human review options: Approve, Reject, Investigate, Monitor, Ignore. Решение immutable-append в `decisions`.

---

## 10. Conflict Model

Новое не удаляет старое автоматически.

Иерархия (верх побеждает при однозначности):

```
System Policy
  → Company Policy
    → Permanent Intent
      → Domain Rule
        → Specific Procurement Rule
          → Current Task
```

Если конфликт нерешаем однозначно:

- `needs_human = true`
- специалисту задаётся вопрос с формулировкой обоих правил и scope
- **запрещены silent overrides**

Conflict Resolver — детерминированный код. LLM может предложить формулировку вопроса, но не выбрать победителя при неоднозначности.

---

## 11. Database ER Model

PostgreSQL. Ключевые таблицы:

**Identity**

- `users`
- `companies`

**Configuration (specialist-owned)**

- `domains`
- `domain_rules`
- `domain_constraints`
- `intents`
- `tasks`
- `monitoring_rules`
- `scoring_formulas` *(версии формул)*
- `policies`

**Procurement case**

- `procurements`
- `procurement_lots`
- `procurement_documents`
- `document_versions`
- `document_chunks`
- `document_extractions`
- `procurement_changes`

**Analysis**

- `facts`
- `evidence`
- `scores`
- `risks`

**Agents / HITL / comms**

- `agent_definitions`
- `agent_runs`
- `agent_tool_calls`
- `decisions`
- `notifications`
- `company_knowledge`

Связи (логически):

```
companies 1—N users
companies 1—N domains
domains 1—N domain_rules / domain_constraints
domains M—N capabilities (via domain_capabilities)
intents N—1 users
tasks N—1 intents, N—0..1 domains, N—0..1 procurements
procurements 1—N lots, documents, facts, risks, scores, changes, decisions
procurement_documents 1—N document_versions
document_versions 1—N chunks / extractions
facts N—1 evidence (provenance)
agent_runs N—0..1 tasks / procurements
agent_runs 1—N agent_tool_calls
monitoring_rules N—0..1 procurements / domains
```

Индексы обязательны: `(source, source_procurement_id)` unique; `document_versions.hash`; `agent_runs.request_id`; `tasks(status, type)`.

---

## 12. Security Model

### 12.1 Least privilege агентов

Allow/deny lists в `agent_definitions`, enforcement в Tool Policy Gate **до** MCP.

Пример DomainSearchAgent:

- ALLOW: `procurement.search`, `procurement.get`
- DENY: `files.delete`, `documents.delete`, `telegram.send`

Пересечение: `effective_tools = agent.allow ∩ domain.associated_mcp_tools \ agent.deny \ system.deny`.

### 12.2 Прочее

- AuthN на API (session/JWT). Роли: specialist, admin, viewer.
- Telegram: whitelist chat ids, команды не расширяют tools агентов.
- Secrets только в env/secret store, не в Domain Profiles.
- MCP servers не имеют права `files.delete` в MVP вообще (кроме явного admin tool вне агентов).
- Агенты не получают сырые credentials площадок.
- Audit: каждый tool call пишется в `agent_tool_calls`.

---

## 13. Workflow

### 13.1 Progressive investigation

```
New Procurement
  → cheap classification (title/keywords/profile)
  → clearly irrelevant? YES → STOP (status: discarded, reason stored)
  → get procedure details
  → need documents? YES → download
  → extract commercial terms (payment, deadline)
  → auction fields
  → deterministic score
  → if confidence low or near-threshold → human review
  → else notify + optional monitor
```

Глубокий technical/risk analysis — не в первом MVP-прогоне каждой процедуры.

### 13.2 Пример: поиск

Пользователь: «Найди закупки по водоподготовке.»

1. Intent = `one_time_task` или активация existing `permanent_intent` (не затирая его).
2. Supervisor: intent=`procurement_search`, domain=`water_treatment`.
3. DomainSearchAgent + Water Treatment profile.
4. Hits → classify → ProcurementCase для релевантных.
5. Дальше по progressive pipeline.

### 13.3 Пример: мониторинг

«Следи за процедурой 3545578 и сообщи, если изменятся документы или условия оплаты.»

1. Intent = `monitoring_request`.
2. Если кейса нет — get карточки, создать case.
3. MonitoringRule: documents hash, payment terms facts.
4. Scheduler → MonitoringAgent.
5. ChangeEvent → NotificationAgent (Telegram urgent + UI).

### 13.4 Scoring

LLM: facts, evidence, explanations, confidence.  
Code: `technical_score`, `commercial_score`, `deadline_score`, `risk_score`, `company_match_score`, `final_score`.

Формулы версионируются в `scoring_formulas`. Пересчёт при смене формулы даёт новый snapshot, старый сохраняется.

---

## 14. MVP — вертикальный срез

Не платформа целиком. Один путь:

```
goszakupki.by
  → поиск
  → Water Treatment Domain Profile
  → релевантная закупка
  → карточка
  → скачивание документов
  → оплата + срок + аукцион
  → Procurement Case
  → score
  → отчёт
  → Telegram
  → мониторинг изменений
```

### Входит

1. Один источник: goszakupki.by adapter.
2. Один Domain Profile: водоподготовка (seed + UI create/edit/enable).
3. Capabilities: search, DomainSearchAgent, DocumentAgent, CommercialTermsAgent, MonitoringAgent, NotificationAgent.
4. Узкий auction extract (поля карточки / явные формулировки).
5. Web UI: Dashboard, Procurements, Monitoring, Tasks, Domains, Documents, Agent Activity, Notifications, Settings (минимально).
6. Telegram: alert + digest + approve.
7. PostgreSQL + Redis + MinIO.
8. Provenance на коммерческих фактах.
9. Human review при низком confidence.

### Не входит в MVP

- Другие площадки
- Много доменов как обязательная поставка (UI уже позволяет, seed один)
- CostCalculation
- Company Knowledge MCP
- Полный RiskAnalysisAgent / глубокий technical analysis
- Multi-tenant
- Публичный SaaS

### Acceptance MVP

Система умеет пункты 1–15 из исходного ТЗ (найти → релевантность → карточка → документы → case → оплата → срок → аукцион → снижение → score → сохранить → отчёт → мониторинг → изменения → уведомление).

---

## 15. Структура репозитория (предложение, этап 1)

```
procurement-ai-platform/
  apps/
    web/                    # React + Vite
    api/                    # Fastify HTTP
    agent-runtime/          # Supervisor, Context Compiler, agents
    telegram-bot/
  packages/
    domain/                 # entities, scoring, policy merge
    contracts/              # Zod schemas shared
    db/                     # Drizzle schema, migrations
    mcp-client/             # typed MCP client + policy gate types
    observability/          # logger with correlation ids
  mcp/
    procurement/            # + adapters/goszakupki-by
    documents/
    files/
    memory/
    notification/
  workers/
    search/
    ingest/
    monitor/
    notify/
  infra/
    docker-compose.yml
    otel/
  docs/
    architecture/
  tests/
    e2e/
    fixtures/goszakupki-by/
```

Этап 1 создаёт каркас и пустые контракты. Этап 2 — схема БД. Этап 3 — Procurement MCP. И далее по утверждённому плану 1–16.

---

## 16. Риски этапа 0 (явно)

| Риск | Почему важно | Митигация |
|---|---|---|
| goszakupki.by без стабильного API | адаптер может быть HTML/Playwright, хрупкий | изолировать adapter; fixtures из сохранённого HTML; circuit breaker; не блокировать UI если площадка лежит |
| Таймаут доступа к площадке из среды разработки | уже наблюдался | кэш карточек; ручной import URL; повтор с backoff |
| ToS / правовые ограничения парсинга | production-нагрузка | умеренный rate limit; ident; уточнить у заказчика |
| Смешение с osmos ai-agent / technical-library | соблазн переиспользовать чат-агента | запрет merge; только паттерны и будущие MCP adapters |
| LLM начинает «ставить score» | скрытый drift качества | ScoringEngine только в `packages/domain` |
| Раздувание контекста | 50 профилей / 100 задач | Context Compiler с жёстким бюджетом |
| MCP everywhere слишком рано | скорость MVP | канон контрактов MCP; в MVP Memory может идти в DB напрямую, но за тем же port |
| OCR качество сканов | коммерческие условия в картинках | documents.ocr + needs_human если confidence низкий |
| Silent policy override | потеря доверия специалиста | Conflict Resolver + HITL |

---

## 17. Observability (контракт с этапа 1)

Каждая важная операция несёт:

`request_id`, `task_id`, `agent_id`, `procurement_id`, `run_id`

Лог должен ответить: кто, что, когда запустил, какой агент, какой tool, какие данные, какой результат.

UI **Agent Activity** читает `agent_runs` + `agent_tool_calls`.

---

## 18. План после проверки архитектуры

0. **Этап 0** — этот документ (стоп).
1. Repository structure
2. Database / domain model
3. Procurement MCP
4. Goszakupki.by adapter
5. Supervisor
6. Context Compiler
7. DomainSearchAgent
8. Document MCP + DocumentAgent
9. CommercialTermsAgent
10. Monitoring
11. Reports
12. Web UI
13. Telegram
14. Observability
15. Security hardening
16. E2E

---

## 19. Критерии приёмки этапа 0

- [ ] Зафиксировано: greenfield, существующую платформу не переписываем
- [ ] Domain Profiles — данные; направления не кодируются классами агентов
- [ ] Supervisor не выполняет спецоперации
- [ ] MCP и source adapters изолированы
- [ ] Context Compiler обязателен
- [ ] Конфликты без silent override
- [ ] Score считает код
- [ ] Provenance обязателен для фактов
- [ ] MVP = один вертикальный срез goszakupki.by × water treatment
- [ ] Человек подтвердил архитектуру → можно Этап 1

**Остановка.** Реализация не начинается без подтверждения.
