# Этап 1.1 — Расширение контрактов под goszakupki.by

**Статус:** реализовано. `npm run verify` должен проходить полностью.

---

## 1. Цель

Уточнить общий словарь данных до проектирования БД: поля реальных карточек goszakupki.by, релевантность и актуальность, нейтральный source port, формат редактируемого seed-профиля. Прикладных адаптеров и миграций на этом шаге нет.

## 2. Архитектурное решение

Контракты остаются листовым пакетом и зависят только от Zod. Предметное оборудование не появляется в управляющей логике: ключевые слова живут в `electricalEquipmentSeedV1`, схема профиля универсальна.

Веса итоговой оценки больше не дублируются в `DomainProfile`. Профиль хранит `formulaId` и пороги расследования; числа считает `ScoringFormula` в `packages/domain`.

Procurement MCP описывается нейтральными Zod-конвертами `search/get/...`. Интерфейс `ProcurementSourcePort` не принимает `DomainProfile`.

## 3. Почему принято это решение

**Seed как данные.** Первый запуск должен сразу искать электрооборудование из задания, но bootstrap не должен стать скрытым `if (title.includes("КТПБ"))`. Файл seed валидируется той же схемой, что и UI-черновик.

**Date-only отдельно от date-time.** На площадке срок подачи часто указан без времени. Подставлять полночь UTC — искажение, из-за которого активная процедура может быть отсечена.

**Unknown status ≠ inactive.** Неразобранная подпись статуса эскалируется специалисту. Документы при этом не качаются, пока нет `active`.

**Provenance для HTML.** Карточка — такой же источник, как PDF. `html_snippet` хранит поле, строку и URL.

## 4. Изменения

- `excludeKeywords` в профиле, поисковом запросе и `MinimalAgentContext`
- семейства страниц, внешние идентификаторы, стороны/контакты, лоты с позициями, `RawArtifact`, разъяснения
- `PlatformInstant`, `PlatformAmount`, жизненный цикл документа `active | deleted`
- `RelevanceAssessment`, `ActivityAssessment`
- `JobRun` с `idempotencyKey` и ошибками `retryable | terminal | needs_human`
- `ProcurementSourcePort` и MCP envelopes
- seed `electrical_equipment.v1`
- `mayEnqueueDocumentJobs` в домене
- слойные правила ESLint и dependency-cruiser для будущих `db`, `application`, `mcp`, `workers`
- нейтральные идентификаторы в unit-тестах вместо водоподготовки

## 5. Новые файлы

```
packages/contracts/src/assessment.ts
packages/contracts/src/job.ts
packages/contracts/src/seed.ts
packages/contracts/src/seed/electrical-equipment.v1.ts
packages/contracts/src/source-port.ts
packages/domain/src/activity/gate.ts
packages/domain/src/activity/gate.test.ts
docs/architecture/STAGE-1.1.md
```

## 6. Изменяемые файлы

Контракты `common`, `ids`, `domain-profile`, `procurement`, `analysis`, `agent`, `task`, `intent`, `index`; тесты contracts/domain/observability; `eslint.config.js`; `.dependency-cruiser.cjs`; датированное дополнение в `STAGE-0.md`; уточнение AGENTS.md §4.5.

## 7. Database changes

Нет. Формат seed зафиксирован, применение — этап 2.

## 8. API / MCP / Agent contracts

- MCP: `ProcurementSearchRequest` не содержит профиля
- Agent: в контекст попадают `keywords` и `excludeKeywords`, не весь профиль
- Human review: `treat_as_active | skip | review_later`

## 9. Tests

Инварианты: неполная карточка; факт без evidence; удалённый документ сохраняет версию; два произвольных профиля на одной схеме; date-only без времени; пограничная релевантность = `needs_human`; закрытая процедура = `inactive`; неизвестный статус = `needs_human`; document jobs только при `active`.

## 10. Risks

| Риск | Статус |
|---|---|
| Seed воспримут как hardcode отрасли | Закрыт схемой: любой второй профиль валиден без изменения кода |
| Веса score снова окажутся на профиле | Закрыт: `DomainScoringRules` больше не содержит `weights` |
| Адаптер начнёт принимать DomainProfile | Закрыт контрактом port + будущим правилом `mcp/` ↛ `db` |

## 11. Acceptance criteria

- [x] Карточка с одним заголовком и URL проходит схему
- [x] `Fact.evidenceIds.min(1)` не ослаблен
- [x] Seed электрооборудования валидируется как `DomainProfileSeed`
- [x] `ProcurementSourcePort` не знает про профиль
- [x] Неизвестный статус не равен `active`
- [x] `npm run verify`
