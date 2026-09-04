# Этап 17 — распознавание live-PDF

**Статус:** у сканов и чертежей с goszakupki.by нет текстового слоя. Capture
берёт цифровые буквы, если они есть; иначе декодирует изображение страницы
(CCITT) и гоняет OCR. Низкая уверенность показывается специалисту и не
становится коммерческим фактом.

---

## 1. Цель

Прочитать живые PDF кейса: не только hash, а текст по страницам. Чертёж не
выдавать за договор. «Аванс 30%» из каши OCR не попадает в `CommercialTerms`.

## 2. Архитектурное решение

- Цифровой слой: pdf.js `getTextContent` + сборка строк по координатам
  (штамп чертежа иначе читается справа налево).
- Нет букв: операторы `paintImageXObject`, распаковка 1-bit CCITT, PNG,
  Tesseract `rus+eng`. Canvas pdf.js на Node не рисует эти битмапы — не
  используем `page.render`.
- Оценка качества — `packages/domain` (`assessDocumentPages`, порог 0.6).
  MCP не ставит факты.
- `npm run capture:live-case` пишет страницы в `live-run.json`. Verify и API
  не вызывают Tesseract.
- Tesseract и `@napi-rs/canvas` — Apache/MIT. AGPL MuPDF не берём.

```text
PDF bytes
  → text layer? reconstruct rows
       достаточно букв → digital_text
  → иначе image XObject → unpack → OCR
       confidence ≥ 0.6 → extracted / cheap extract
       ниже → ocr_low_confidence, превью в карточке
```

## 3. Почему именно так

Живые файлы 2БКТПБ — строительные чертежи, 42 CCITT-картинки, 0 букв в слое.
Простой `getTextContent` честно пустой. OCR штампа даёт «БЕЛГИПРОАГРОПИЩЕПРОМ»
при ~47% — это сигнал специалисту, не факт оплаты.

«Предоплата до 99,5%» на площадке — потолок, не точка. Дешёвый разбор не
превращает «до N%» в `advancePercent`.

## 4. Изменения

- pdf.js extractor, распаковка 1bpp, Tesseract OCR;
- quality gate в domain;
- capture пишет `extraction` на документ;
- консоль: статус OCR и превью.

## 5. Новые файлы

```text
packages/domain/src/documents/text-quality.ts
mcp/documents/src/pdfjs-extractor.ts
mcp/documents/src/pdf-layout.ts
mcp/documents/src/pdf-image.ts
mcp/documents/src/tesseract-ocr.ts
docs/architecture/STAGE-17.md
```

## 6. Изменяемые файлы

- `packages/contracts/src/specialist.ts`
- `packages/domain/src/commercial/cheap-extract.ts`, `specialist/case.ts`
- `mcp/documents/src/server.ts`, `fixture-catalog.ts`, `extractor-port.ts`
- `mcp/procurement/src/capture-specialist-case.ts`
- `apps/web/src/procurements/ProcurementsApp.tsx`

## 7. Изменения БД

Нет.

## 8. Контракты API / MCP / агентов

`SpecialistCaseDocument.extraction`: status, kind, pages, notes.
Карточка: `extractNotes`, `extractPreview`.
MCP `documents.extract_text` остаётся; порт extractor стал async. По умолчанию
сервер по-прежнему fixture.

## 9. Тесты

- штамп: строки по Y, не по порядку items;
- 1-bit unpack;
- digital PDF без OCR;
- «предоплата 40%» да, «до 99,5%» нет;
- OCR 47% с «Аванс 30%» не даёт `termsDetail`.

## 10. Риски и ограничения

1. OCR чертежей шумный. Порог 0.6 обязателен.
2. Первый capture качает `rus`/`eng` tessdata (кэш `data/tessdata`).
3. 45 страниц OCR — минуты, не секунды. `DOCUMENT_OCR_MAX_PAGES`.
4. Таблицы из скана не собираются.
5. Docling/внешний OCR-сервис не подключён.

## 11. Критерии приёмки

- [x] пустой текстовый слой не маскируется;
- [x] OCR штампа виден в консоли;
- [x] низкая уверенность ≠ факт аванса;
- [x] `npm run verify` без Tesseract и без Python.

## 12. Следующий этап

Дальше: этап 18 отбирает файлы до OCR и читает конкурсные сканы vision-моделью.
OCR / vision электрических схем остаётся отдельной фичей.
