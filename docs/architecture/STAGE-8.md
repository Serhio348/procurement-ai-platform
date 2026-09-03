# Этап 8 — Document MCP и DocumentAgent

**Статус:** Documents MCP хранит файлы по `sha256`, извлекает текст и таблицы из
fixture-корпуса и сообщает о плохом OCR, не выдавая кашу за факт. Живой Docling
и скачивание файлов с `goszakupki.by` остаются следующим наращиванием.

---

## 1. Цель

После того как DomainSearchAgent отобрал процедуру, получить её вложения:
скачать, не дублировать одинаковые байты, извлечь текст и таблицы, а скан с
низкой уверенностью отдать специалисту.

## 2. Архитектурное решение

- `mcp/documents` регистрирует `documents.*` и `files.put` / `files.get` /
  `files.exists`. `files.delete` не публикуется.
- Blob ключ — `blobs/{sha256}`. Повторная загрузка тех же байт не создаёт
  второй объект.
- Извлечение за портом `DocumentExtractorPort`. CI использует
  `FixtureDocumentCatalog`: цифровой файл даёт текст и таблицу; скан сначала
  `ocr_required`, затем `ocr_low_confidence`.
- Версия документа считается в `packages/domain` (`resolveContentVersion`).
  Тот же hash — та же версия, extract повторно не гоняется.
- `ocrNeedsHuman` сравнивает уверенность OCR с порогом агента. Ниже порога —
  `needs_human`, текст не становится коммерческим фактом.
- `DocumentAgent` вызывает `procurement.get_documents`, затем documents tools
  через Tool Policy Gate. Коммерческие условия не извлекает.

```text
procurement.get_documents
  → documents.download
  → sha256 / version
  → extract_text
       ocr_required → documents.ocr
  → extract_tables
  → DocumentIngestOutput
```

## 3. Почему именно так

**Fixture в CI, Docling снаружи verify.** Python и модели OCR не должны ломать
`npm run verify` на машине без Tesseract.

**Плохой скан — вопрос человеку.** Иначе «ав нс 45» превратится в аванс.

**MCP не пишет PostgreSQL.** Кейс и `document_versions` появятся у оркестратора.
Агент возвращает ingest-отчёт; blob живёт в памяти сервера процесса.

**files.* на том же stdio, что documents.** Отдельный Files MCP-процесс на этом
этапе не окупается. Инструменты уже разделены именем.

## 4. Изменения

- контракты Files/Documents MCP и `DocumentIngestOutput`;
- domain: content version и OCR gate;
- Documents MCP + fixture catalog;
- typed `DocumentsMcpClient`;
- `DocumentAgent`.
- seed профиля: `associatedMcpTools` включает extract/OCR/`files.*`, иначе
  компилятор контекста вырежет их на пересечении с профилем.

## 5. Новые файлы

```text
packages/contracts/src/documents.ts
packages/domain/src/documents/versioning.ts
packages/domain/src/documents/ocr-gate.ts
packages/mcp-client/src/documents-client.ts
mcp/documents/**
tests/fixtures/documents/**
apps/agent-runtime/src/agents/document-ingest/**
docs/architecture/STAGE-8.md
```

## 6. Изменяемые файлы

- `packages/contracts/src/index.ts`, `contracts.test.ts`
- `packages/contracts/src/seed/electrical-equipment.v1.ts`
- `packages/domain/src/index.ts`
- `packages/mcp-client/src/index.ts`
- `apps/agent-runtime/src/index.ts`
- `apps/agent-runtime/src/registry/capabilities.ts`
- `tsconfig.json`, `package.json`, `.env.example`
- `README.md`, `AGENTS.md`, `docs/architecture/STAGE-7.md`

## 7. Изменения БД

Нет. Таблицы `procurement_documents` / `document_versions` уже есть с этапа 2
и пока не заполняются этим агентом.

## 8. Контракты API / MCP / агентов

Новые tools: `documents.list`, `download`, `extract_text`, `extract_tables`,
`ocr`, `search`, `get_page`, `files.put`, `files.get`, `files.exists`.

HTTP API нет. Live download с площадки не реализован: неизвестный URL →
`not_found`. Каталог fixture: `https://example.test/files/spec-001.pdf` и
`scan-low.tiff`.

## 9. Тесты

- одинаковые байты хранятся один раз;
- digital PDF-fixture извлекается без OCR, таблица «Аванс 30%» на месте;
- скан не считается прочитанным до OCR и уходит в `ocr_low_confidence`;
- поиск по извлечённому тексту находит «Аванс»;
- DocumentAgent не вызывает telegram и delete;
- повторный ingest того же hash пропускает extract;
- нет `procurement.get_documents` в allowlist → `permission_denied`;
- seed профиля не вырезает extract/OCR на пересечении с Tool Policy Gate.

Проверка реализации: `npm run verify` — 148 прошедших тестов без Python,
без LLM-ключа и без площадки.

## 10. Риски и ограничения

1. **Нет Docling в этом этапе.** Живые PDF/сканы площадки ещё не разбираются
   настоящей OCR-моделью. Порт `DocumentExtractorPort` для этого оставлен.
2. **Нет cookie-download с goszakupki.by.** Список файлов карточки уже есть;
   байты файла — отдельный адаптер.
3. **Память процесса.** Blob store не MinIO. Для production нужен Files backend
   на S3 из этапа 2.
4. **Агент не создаёт Fact.** «Аванс 30%» в preview — цитата извлечения, не
   коммерческий факт этапа 9.

## 11. Критерии приёмки

- [x] hash версионирует содержимое, старое не затирается;
- [x] низкий OCR → человек, не выдуманный текст;
- [x] tools режет код, не промпт;
- [x] `npm run verify` без Python и без площадки;
- [x] отчёт этапа записан.

## 12. Следующий этап

Этап 9 — CommercialTermsAgent: из уже извлечённого текста достаёт оплату,
аванс и сроки как факты со ссылкой на страницу. Реализовано, см.
[`STAGE-9.md`](STAGE-9.md).
