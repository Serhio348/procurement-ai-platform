# Этап 18 — какие файлы читать

**Статус:** ingest больше не гоняет OCR по альбомам стройпроекта. Скан
запускается только для документов конкурса. Движок скана — DeepSeek vision,
Tesseract остаётся запасным путём.

---

## 1. Цель

Из вложений карточки достать условия закупки (ТЗ, извещение, аукционная
документация). Чертежи и схемы специалист смотрит сам. Чтение электрических
схем — отдельная фича.

## 2. Архитектурное решение

```text
байты + имя → формат (pdf / docx / xlsx / pptx / jpeg / …)
имя файла → skip_project | contest_document | unknown
  skip_project      не читаем
  contest_document  инструмент формата:
                      pdf с текстом → pdf.js
                      pdf-скан / jpeg / png → vision (Tesseract запасной)
                      docx / xlsx / pptx → Open XML
  unknown           специалисту, без OCR проекта
карточка площадки   всегда
```

Классификатор — чистая функция в `packages/domain`. Списки признаков
(ЭКН/jekn, КЖ/kzh, «аукцион», «ТЗ») — данные, не отдельный агент отрасли.
Модель не ставит вердикт «это чертёж на 80%».

Capture сначала определяет формат по magic bytes, затем вызывает
подходящий ридер. `DocumentAgent` вызывает `documents.ocr` только при
`contest_document` и только для растровых форматов.

## 3. Почему именно так

На `auction/3629820` все три вложения — альбомы ЭКН/КЖ/ЭП. Условия оплаты
уже в HTML карточки. Tesseract по 27 листам чертежа дал кашу; DeepSeek
vision штамп читает лучше, но слать ему весь проект нельзя — это и дорого,
и «чтение схем».

Цифровой слой важнее любого скана: если в PDF есть буквы, vision не нужен.

## 4. Изменения

- `classifyAttachmentRole` в domain;
- `skipped_project` в контрактах;
- DeepSeek vision OCR + fallback на Tesseract;
- DocumentAgent и capture не OCR-ят альбомы проекта;
- консоль показывает «проект/чертёж, не распознавали».

## 5. Новые файлы

```text
packages/domain/src/documents/attachment-role.ts
mcp/documents/src/deepseek-vision-ocr.ts
mcp/documents/src/fallback-ocr.ts
mcp/documents/src/document-scan-engine.ts
docs/architecture/STAGE-18.md
```

## 6. Изменяемые файлы

- `packages/contracts/src/documents.ts`, `specialist.ts`
- `apps/agent-runtime/src/agents/document-ingest/agent.ts`
- `mcp/procurement/src/capture-specialist-case.ts`
- `apps/web/src/procurements/ProcurementsApp.tsx`
- `.env.example`, `AGENTS.md`, `README.md`

## 7. Изменения БД

Нет.

## 8. Контракты API / MCP / агентов

`ExtractionStatus` дополнен `skipped_project`.
`documents.extract_text` по-прежнему цифровой слой / fixture.
`documents.ocr` — только после отбора `contest_document`.

## 9. Тесты

- живые имена ЭКН/КЖ/ЭП → `skip_project`;
- «Техническое задание.pdf» / «Аукционная документация.pdf» → скан;
- ТЗ в имени побеждает слабое «электроснабжение»;
- DocumentAgent не вызывает `documents.ocr` для jekn;
- vision-адаптер шлёт PNG и не считает HTTP 400 текстом;
- UI не пишет «OCR», если альбом пропущен.

## 10. Риски и ограничения

1. Транскрипт vision — не текстовый слой PDF. Цитата проверяется по
   транскрипту. Цифры модель может «починить».
2. Непонятное имя файла лучше отдать человеку, чем прогнать 27 листов.
3. `deepseek-chat` картинку не видит. Нужен `LLM_VISION_MODEL`.
4. Нет ключа — Tesseract, и только на файлах конкурса.

## 11. Критерии приёмки

- [x] альбомы проекта не идут в Tesseract/vision;
- [x] карточка площадки по-прежнему источник условий;
- [x] конкурсный скан читает vision при наличии ключа;
- [x] `npm run verify` без живого API DeepSeek.

## 12. Следующий этап

Vision/OCR электрических схем — отдельная фича. Дальше по консоли: задача
поиска из UI, outbox или редактор профиля.
