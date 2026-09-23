# STAGE-103 · Архивы RAR/7z, CP1251-имена, HTML-вместо-файла, «скачать всё архивом» (R52)

## Проблема

- `.rar`/`.7z` скачивались и лежали «глухими»: формат `unknown` → экстракция
  `failed`, файлы внутри недоступны. На goszakupki.by RAR — обычный формат
  пакета документации.
- Если эндпоинт отдавал HTML-страницу (превью-заглушка, истёкшая сессия,
  антибот) под именем `.zip`, распаковка молча давала 0 членов — в карточке
  появлялся «архив без документов».
- Windows-созданные ZIP хранят имена в CP1251 без UTF-8-флага — члены
  доставались, но с битыми именами.
- Ссылка «скачать всю документацию одним архивом» в панели документов может
  быть JS-триггером (`data-url`, `onclick`) без `href` — она не собиралась.

## Решение

**Форматы** (`file-format.ts`). `DOCUMENT_FILE_FORMATS` += `rar`, `7z`;
sniffing по магии: RAR4 `Rar!\x1A\x07\x00`, RAR5 `Rar!\x1A\x07\x01\x00`,
7z `37 7A BC AF 27 1C`; fallback по имени (`.rar`, `.7z`) и MIME
(`application/vnd.rar`, `x-rar-compressed`, `x-7z-compressed`).

**Распаковка** (`unpack-archive.ts`). Единый async `unpackArchive(format,
bytes)` → `{members, error?}`:

- ZIP — прежний нативный reader (быстрый, без WASM);
- RAR/7z — 7-Zip 24.09 в WASM (`7z-wasm`, 1.6 МБ), без системных бинарей на
  VPS. Свежий модуль на каждую распаковку: stderr собирается в рамках job
  (7zz завершается кодом 0 даже на битом контейнере — ошибки только в
  stderr), а abort не отравляет следующий архив. Memfs-директория job
  чистится после прогона;
- `error` выставляется по stderr 7zz — «архив не открылся» честно
  отличается от «архив пуст»;
- бюджеты прежние (`MAX_ARCHIVE_*`), члены проходят `indexStoredFile`
  рекурсивно — вложенные ZIP внутри RAR работают до глубины 2;
- `rarEntries()` — тест-хелпер, собирающий настоящий RAR4 с
  «stored»-членами (RAR-компрессия проприетарна, создать её нельзя).

**CP1251** (`zip-entries.ts`). Флаг 0x800 → UTF-8; без него — strict UTF-8
попытка, при сбое `windows-1251`. Кириллические имена из Windows-архивов
декодируются правильно.

**HTML-гард** (`looksLikeHtmlPage` в `file-format.ts`, вызов в
`downloadOne`): `text/html` Content-Type или `<!doctype`/`<html` в начале
байтов (с пропуском UTF-8 BOM) → `download_failed` «Площадка вернула
HTML-страницу вместо файла». Перечисленный `.html`-документ не ловится —
это реальный контент, а не заглушка.

**«Скачать всё архивом»** (`goszakupki-by-parser.ts`). Скан панели
«Документы» берёт не только `a[href]`, но и `a[data-url]`, `a[data-href]`,
`a[onclick]`; `anchorTarget()` достаёт URL из data-атрибута или
`location.href='…'`/`window.open('…')`. Архив-линк становится обычным
`SourceDocument` с `?download=1` — скачивается и распаковывается общим
путём.

## Регрессии

- `unpack-archive.test.ts`: RAR4 stored (кириллица, вложенные папки),
  7z round-trip, CP1251-имя в ZIP, битый контейнер → `error`;
- `document-ingest.test.ts`: `.rar` → дочерний `.docx` читается как
  `office_text`; HTML-заглушка → `download_failed`, не «пустой архив»;
- `file-format.test.ts`: магия RAR4/RAR5/7z, имя/MIME fallback, HTML-гард;
- `goszakupki-by-parser.test.ts`: `data-url` и `onclick` архив-линки в
  панели документов попадают в список с `download=1`.

Полный прогон: 707 тестов, typecheck, eslint, depcruise — чисто.
