# Этап 49 — evaluation harness для старого и нового поиска

## Цель

Получить измеримый baseline: на размеченном наборе закупок сравнить старый
отбор (одно точное слово = match) и новый (`SearchIntentPlan` + score 0–100).
Алгоритм поиска не меняется.

## Архитектурное решение

```
размеченные карточки (gold: relevant | irrelevant | uncertain)
  → SearchHit (доп. текст — в buyerName, это поле уже читает cheapClassify)
  → selectRelevantSearchCards без intent     = old
  → inferSearchIntentPlan + selectRelevantSearchCards с intent = new
  → Precision / Recall / F1 / FP / FN считает код, не модель
```

Бизнес-логика не копируется. Неуверенные эталоны в метрики не входят.

## Запуск

```bash
npm run evaluate:search
```

Набор: `packages/domain/src/search/evaluate-nku-pumps.ts`. Новые живые
карточки добавляются туда же с ручной меткой. LLM для метрик не вызывается.

## Изменения

- `packages/domain/src/search/evaluate.ts` + тест
- `packages/domain/src/search/evaluate-nku-pumps.ts`
- `packages/domain/src/search/evaluate-cli.ts`
- скрипт `evaluate:search`
- этот файл
