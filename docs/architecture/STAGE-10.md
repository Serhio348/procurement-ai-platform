# Этап 10 — MonitoringAgent

**Статус:** агент сверяет текущий статус, срок подачи и список документов с
прошлым снимком. Что считать изменением, задаёт `monitoringRules` профиля.
Telegram не отправляется: это следующий NotificationAgent.

---

## 1. Цель

По уже выбранной закупке ответить, изменились ли статус, дедлайн или состав
документов, и вернуть append-only `ChangeEvent[]` без молчаливой подмены
старого hash.

## 2. Архитектурное решение

- Diff считает `packages/domain` (`diffMonitoringSnapshots`). Модель не
  участвует: изменение — факт сравнения, не мнение.
- Темы наблюдения — данные профиля (`status`, `deadlines`, `documents`, …).
  Смена статуса при правиле «только documents» не становится событием.
- Текущий снимок: `procurement.get_status` + `get_documents`. Источниковые
  `get_changes` дополняют diff, если tool разрешён; live goszakupki.by по-
  прежнему отдаёт пустой список (этап 4).
- Первый прогон без `previous` только фиксирует baseline: изменений нет.
- Hash документа накладывается из `documentHashes` прошлого ingest. Сам
  мониторинг файлы не качает.
- `telegram.send` в denylist. При `notifyOnChange` агент лишь рекомендует
  capability `notification`.

```text
previous MonitoringSnapshot
  + get_status / get_documents / get_changes
  → current snapshot
  → diffMonitoringSnapshots(profile.monitoringRules)
  → ChangeEvent[]
```

## 3. Почему именно так

**Правила профиля, не if по отрасли.** «Следить за документами» — запись
`DomainMonitoringRule`, тот же агент для любого направления.

**Сравнение кодом.** Иначе модель может «не заметить» отмену или выдумать
изменение цены, которой get_status не отдаёт.

**Не слать Telegram из мониторинга.** STAGE-0: NotificationAgent доставляет
уже сформированное сообщение. Иначе срочность и канал размазываются по двум
агентам.

## 4. Изменения

- контракты `MonitoringSnapshot` / `MonitoringInput` / `MonitoringOutput`;
- domain-diff по правилам профиля;
- `MonitoringAgent`;
- компилятор отдаёт `monitoringRules`;
- seed: `procurement.get_status` и `get_changes`.

## 5. Новые файлы

```text
packages/contracts/src/monitoring.ts
packages/domain/src/monitoring/diff.ts
packages/domain/src/monitoring/diff.test.ts
apps/agent-runtime/src/agents/monitoring/agent.ts
apps/agent-runtime/src/agents/monitoring/agent.test.ts
docs/architecture/STAGE-10.md
```

## 6. Изменяемые файлы

- `packages/contracts/src/agent.ts`, `index.ts`, `contracts.test.ts`
- `packages/contracts/src/seed/electrical-equipment.v1.ts`
- `packages/domain/src/index.ts`
- `apps/agent-runtime/src/context/compiler.ts`, `compiler.test.ts`
- `apps/agent-runtime/src/registry/capabilities.test.ts`
- `apps/agent-runtime/src/index.ts`, `package.json`
- `README.md`, `AGENTS.md`, `docs/architecture/STAGE-9.md`

## 7. Изменения БД

Нет. Снимок и `ChangeEvent` возвращаются в `AgentRunOutput`. Таблица
`change_events` этапа 2 этим агентом не заполняется.

## 8. Контракты API / MCP / агентов

Новых MCP tools нет. Агент вызывает `get_status`, `get_documents`,
`get_changes`. `memory.get` / `memory.put` в allowlist, но не вызываются.

HTTP API нет. Scheduler/BullMQ не добавлялся: прогон по-прежнему внешний.

## 9. Тесты

- первый прогон без previous не изобретает события;
- смена статуса видна только если профиль смотрит `status`;
- новый hash документа не затирает старый, а даёт `document_updated`;
- telegram не вызывается даже при urgent-изменении;
- нет `procurement.get_status` → `permission_denied`;
- компилятор кладёт `monitoringRules` и не даёт telegram.

Проверка реализации: `npm run verify` — 172 прошедших теста без площадки
и без LLM-ключа.

## 10. Риски и ограничения

1. **Нет планировщика.** Интервал `intervalMinutes` пока данные профиля, не
   cron.
2. **Нет Persistence.** Следующий прогон должен получить `previous` снаружи.
3. **Цена с карточки не читается.** `procurement.get` не в allowlist STAGE-0;
   `price` сработает, только если source `get_changes` его пришлёт.
4. **Live get_changes пустой.** Diff строится по снимкам статуса и списка
   файлов, не по журналу площадки.
5. **NotificationAgent ещё нет.** Рекомендация `notification` никуда не
   доставляется.

## 11. Критерии приёмки

- [x] темы мониторинга — данные профиля;
- [x] diff считает код, не модель;
- [x] старый hash документа не затирается;
- [x] telegram режет код;
- [x] `npm run verify` без площадки и без LLM;
- [x] отчёт этапа записан.

## 12. Следующий этап

Этап 11 — отчёты: собрать уже проверенные факты и изменения в читаемый
срез для специалиста. Либо NotificationAgent, если важнее доставка
ChangeEvent в UI/Telegram.
