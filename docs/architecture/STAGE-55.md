# Этап 55 — ZIP и ссылка на хранилище документации

**Статус:** вложение `.zip` скачивается и разбирается как набор файлов.
Если на карточке вместо файлов стоит ссылка на хранилище (Яндекс.Диск,
прямая ссылка на PDF/ZIP), адаптер переходит по ней и качает содержимое.

---

## 1. Цель

ТЗ часто лежит не отдельным PDF на goszakupki.by, а внутри архива или
по ссылке «документация на диске». Без этого этапа условия оплаты из
такого комплекта в карточку не попадают.

## 2. Архитектурное решение

```
get_documents
  → a.modal-link (как раньше)
  → внешние http(s) из блока «Документы» (Яндекс.Диск, имя файла)
  → Yandex public API / HTML-индекс → список файлов

procurement.download
  → goszakupki.by: cookie-сессия
  → иначе: публичный GET (не private IP, не GIAS)
  → disk.yandex.ru: cloud-api …/download → байты

ingest
  → zip (не docx/xlsx/pptx) → central directory → члены
  → каждый член: blob + recognize (правила этапа 18)
  → сам архив остаётся в списке, kind = archive
```

Распаковка — один-два уровня, с потолком числа и размера файлов. RAR/7z
скачиваются, внутри не читаются.

## 3. Почему именно так

Знание площадки и Яндекс.Диска остаётся в адаптере. API по-прежнему
качает только через `procurement.download`. Домен решает, какой путь
внутри zip — мусор (`__MACOSX`), какой URL у члена (`#member/…`).

Повторный download всего архива с площадки не нужен: «Обновить»
перечитывает сохранённый zip и снова распаковывает членов.

## 4. Изменения

Новые:

- `packages/domain/src/documents/archive.ts`
- `packages/domain/src/documents/documentation-url.ts`
- `mcp/documents/src/unpack-archive.ts`
- `mcp/procurement/src/public-download.ts`
- `mcp/procurement/src/documentation-expand.ts`
- `docs/architecture/STAGE-55.md`

Изменённые: parser карточки, `GoszakupkiBySource.download/getDocuments`,
`document-ingest`, kind `archive` в контракте, подпись в консоли.

## 5. Изменения БД

Нет.

## 6. Риски

- Папка на Диске без public API (закрытая ссылка) не откроется.
- Google Drive с interstitial «virus scan» может отдать HTML вместо файла.
- SSRF: только http(s) и не RFC1918; DNS rebinding не закрыт.

## 7. Критерии приёмки

- [x] ZIP с Word внутри даёт отдельный разобранный документ
- [x] ссылка Яндекс.Диска в блоке «Документы» попадает в get_documents
- [x] localhost / 10.x не качаются
- [x] `npm run verify` без живой площадки
