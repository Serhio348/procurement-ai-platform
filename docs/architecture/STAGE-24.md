# Этап 24 — документы после «Участвовать»

**Статус:** найденная live-процедура не качает файлы на поиске. Документация
идёт только после решения «Участвовать». «Отслеживать» по-прежнему только
держит карточку в списке.

---

## 1. Цель

Специалист видит файлы и разобранный текст ТЗ у закупки, в которой решил
участвовать. Поиск по профилю остаётся дешёвым: заголовки, без альбомов.

## 2. Архитектурное решение

```text
POST /api/procurements/:id/decision { kind: participate }
  → записать triage
  → procurement.get_documents
  → procurement.download          # cookie-сессия площадки, blob по sha256
  → recognizeSpecialistDocument   # те же правила, что capture: не OCR альбомов
  → карточка.documents + /api/documents/{hash}
monitor / reject / search
  → download не вызывается
```

- API по-прежнему не импортирует `mcp/procurement`. Скачивание — tool
  адаптера, не `documents.download` (у Documents MCP нет сессии площадки).
- Байты пишутся в `DOCUMENT_BLOB_DIR` / `data/blobs`. Консоль открывает
  локальную копию, не повторный URL goszakupki.by.
- Альбомы проекта пропускаются правилами этапа 18. Оценка 0–100 не
  считается.

## 3. Почему именно так

**Не на поиске.** Иначе каждая строка тянет комплекты чертежей.

**Не на «Отслеживать».** Слежение — статус и хеши позже; полный разбор ТЗ
нужен, когда специалист идёт в процедуру.

**Сессия в адаптере.** Cookie-download живёт в goszakupki HTTP-клиенте.
Второй HTTP из API обошёл бы адаптер.

## 4. Изменения

- `procurement.download` в контрактах, MCP, typed client;
- `GoszakupkiBySource.download` через ту же сессию;
- API ingest только при `participate`;
- UI: процент индексации, «прочитано агентом», текст Word в консоли,
  колонка коммерческих условий из цитат.

## 5. Новые файлы

```text
packages/domain/src/specialist/participate.ts
apps/api/src/document-ingest.ts
mcp/documents/src/recognize-specialist-document.ts
mcp/procurement/src/store-download.ts
docs/architecture/STAGE-24.md
```

## 6. Изменения БД

Нет. Каталог карточек в памяти, байты на диске.

## 7. Критерии приёмки

- [x] search / monitor / reject не качают файлы;
- [x] participate вызывает get_documents + download;
- [x] hashed файл открывается с `/api/documents/{hash}`;
- [x] GET `/api/procurements/:id/ingest-progress` показывает процент
  индексации, пока «Участвовать» ещё идёт;
- [x] разобранный файл помечается «прочитано агентом»;
- [x] `npm run verify` без живой площадки.
