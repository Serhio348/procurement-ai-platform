# STAGE-96 · Полая проекция не затирает сохранённый кейс (R49)

## Проблема

`POST /api/inbox/:id/resolve` возвращал `slimListedCard(card)` — проекцию для
плиток списка: `documents: []`, `actions: []`, `sourceCard` с пустыми
`lots`/`parties`/`rawFields`/`externalIds`. Консоль писала её в общий
`procurements` через `rememberCard` **поверх** полной кабинетной карточки.
Детальная страница берёт `stored = fromList ?? fetched` и не догружает
карточку, уже лежащую в state → «Документы (0)», «Лоты (0)» у кейса со
скачанными файлами.

## Решение

1. **API**: resolve возвращает полную карточку — консоль открывает её как
   есть, повторный запрос не нужен (старый комментарий о «detail refetches
   itself» был неверен: догрузка идёт только при отсутствии карточки в state).
2. **Web**: `rememberCard` делегирует `mergeProcurementCards` — один путь
   слияния вместо особого «replace».
3. **Merge**: `sourceCard` выбирается по глубине
   (`lots`+`parties`+`externalIds`+`rawFields`), а не по `??` — полая
   проекция не побеждает сохранённую карточку. Поля-опционалы уже имели ту же
   защиту; `documents`/`actions` — правило «непустое побеждает».

## Регрессии

- `SpecialistApp.merge.test.ts`: slim-ответ поверх богатого кейса сохраняет
  `documents`, `lots`, `rawFields`.
