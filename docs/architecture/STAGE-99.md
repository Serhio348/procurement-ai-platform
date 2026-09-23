# STAGE-99 · Контент-проб документов: подмена файла по тому же URL (R24)

## Проблема

Diff слежения сопоставлял документы только по `sourceUrl` и `name`.
Площадка может заменить файл под неизменной ссылкой — тогда ни одно
событие не возникало: ни добавления, ни обновления. Дополнительно
автозагрузка «Участвую» реагировала только на `document_added`, но не на
`document_updated`.

## Решение

Бюджетный контент-проб — один документ на отслеживаемый кейс за проход:

- `ListedSourceAttachment` получил `contentHash` и `checkedAt` — базовая
  линия живёт прямо в `watchSnapshot.documents`.
- `SpecialistCardWatchPort.probeDocument(url)` — скачивает файл через
  `procurement.download` и возвращает sha256 (гейт порта расширен до
  `procurement.get` + `procurement.download`). Скачанный blob попадает в
  content-addressed хранилище — последующий ingest переиспользует его.
- `nextDocumentProbeTarget` выбирает документ для пробы: сначала никогда
  не проверенные, затем самый давний `checkedAt` — честная ротация по
  списку в пределах бюджета «1 файл / кейс / проход».
- `probeWatchedDocument` в watch-проходе штампует `contentHash`+`checkedAt`
  на свежую карточку до применения; `checkedAt` ставится даже при сбое
  скачивания — битая ссылка не монополизирует бюджет.
- `mergeDocumentProbes` в `applySourceCard` переносит базовые хэши со
  старого snapshot на новый по URL — линия сравнения переживает любое
  перечитывание карточки (refresh, открытие, мониторинг), а не только
  watch-проходы.
- `diffListedDocuments`: тот же URL, имя и `contentHash` различны →
  `document_updated` с `current = "… (обновлено содержимое)"` — специалист
  видит, что изменились байты, а не название.
- `document_updated` у `participate`-кейса запускает `startParticipateIngest`
  — новая версия скачивается и индексируется; старый blob сохраняется
  (хранилище адресуется содержимым).

Ограничение: кейсы «Слежу» без скачанных документов тоже покрыты — база
создаётся самим пробом с первого прохода; различие видно со второго.

## Регрессии

- `watch.test.ts` → `document content probes (R24)`: подмена при том же
  URL/имени → `document_updated`; совпадающий hash молчит; merge несёт
  базу и отдаёт свежий штамп; ротация probe-target;
- `app.test.ts` → `detects a file replaced under the same URL via a
  budgeted content probe`: проход 1 строит базу без событий, проход 2 с
  другим hash → inbox-строка «обновлено содержимое».
