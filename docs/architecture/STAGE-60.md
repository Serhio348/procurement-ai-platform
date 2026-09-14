# Этап 60 — слежение за списком документов на взятой закупке

**Статус:** «Слежу» и «Участвовать» видят, что на карточке появился или
пропал файл. Байты качаются только у «Участвовать» и только новые URL.

---

## 1. Цель

Смена ТЗ для уже взятой процедуры важнее перерисовки цены. Этап 37 обещал
сравнивать список вложений с той же страницы, что `procurement.get`, и не
качать, пока список не сдвинулся. В снимок попали статус, сумма и срок;
документы остались в тексте.

## 2. Архитектурное решение

```
procurement.get (как раньше)
  → ProcedureCard.listedDocuments { name, sourceUrl }
     те же ссылки, что блок «Документы», без Yandex/ZIP expand

watchSnapshot.documents
  → diff по sourceUrl
       новый URL    → document_added  (входящие, тема «Документы»)
       URL исчез    → document_removed
       то же URL, другое имя → document_updated
       перестановка блока → не изменение

«Слежу»: только входящие, download нет
«Участвовать» + document_added → startParticipateIngest
  ingest пропускает уже hashed sourceUrl, качает остальные
```

Старый снимок без поля `documents` на первом проходе после выката список
записывает и не орёт «добавлены все файлы».

Модель по-прежнему не сравнивает файлы. Hash той же ссылки (файл подменили)
этот этап не ловит.

## 3. Почему именно так

Страница карточки уже читается на каждом проходе. Второй `get_documents` с
expand Яндекса на 40 карточек упрётся в 20 req/min. Список имён и URL
достаточен, чтобы специалист увидел «появилось Изменения.pdf».

Качать всё заново у «Участвовать», потому что добавился один PDF, нельзя:
лимит площадки и сессия. Уже hashed URL пропускаем.

## 4. Изменения

Новые:

- `docs/architecture/STAGE-60.md`

Изменённые:

- contracts: `ListedSourceAttachment`, `ProcedureCard.listedDocuments`,
  `SpecialistCardSnapshot.documents`
- domain: `listedAttachmentsForSnapshot`, diff add/remove/rename
- parser goszakupki.by и fixture `get`
- `document-ingest`: не качать hashed URL
- `monitorDecidedCases`: ingest при `document_added` на participate

## 5. Изменения БД

Нет. Снимок по-прежнему JSON карточки.

## 6. Тесты

- список в `listedDocuments` с карточки goszakupki.by
- reshuffle не событие; новый/пропавший URL — событие
- снимок без `documents` не считается пустым списком
- ingest не зовёт download для уже hashed
- monitor: входящие, ingest нет
- participate: второй ingest после нового файла

## 7. Риски

- Файл по той же ссылке подменили — молчим, пока не появится отдельный hash-проход
  или «Обновить» с повторным download.
- Папка на Диске одним URL: состав внутри не виден, пока не сменится ссылка.
- Удалённый с площадки файл из кабинета не выкидываем: provenance.

## 8. Критерии приёмки

- [x] «Слежу»: новый файл во входящих, без download
- [x] «Участвовать»: новый файл качается, старый hashed не качается
- [x] `npm run verify` без живой площадки
