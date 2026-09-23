# STAGE-97 · «Вернуть» из корзины не создаёт слежение без выбора (R36)

## Проблема

`lastWorkingKind` возвращал `"monitor"` как fallback: кейс, отклонённый прямо
из поиска без единого рабочего решения, после «Вернуть» становился
«Слежу» — мониторинг начинал перечитывать закупку, которую специалист
никогда не просил следить. А возврат в `participate` не запускал пропущенный
ingest документов — файлы оставались нескачанными.

## Решение

- `SpecialistWorkspace.clearRejections(sourceProcurementId)` — удаляет только
  решения `reject` из журнала. Раньше работавший кейс всплывает со своим
  `monitor`/`participate`; без него `latestKind` пуст — кейс неразобран.
- `POST /api/procurements/:id/restore`:
  - после снятия отказа `withTriage` показывает прежний этап; если его нет —
    `triage` стрипается из карточки и кейс возвращается в очередь поиска
    профилей (`appendSearchId`), кандидатом;
  - возврат в `monitor`/`participate` делает `hydrateSourceCard` + `live`
    (как decide);
  - возврат в `participate` вызывает `startParticipateIngest` — пропущенное
    скачивание документов возобновляется.
- `lastWorkingKind` удалён — fallback «иначе monitor» был самим багом.

## Регрессии

- `app.test.ts`: `restores a never-watched reject as an undecided candidate,
  not as monitor` — triage пуст, кейс снова в `tab=search` очереди профиля,
  в `tab=monitor` его нет;
- `workspace.test.ts`: `clearRejections` всплывает participate/monitor после
  снятия reject, чистый журнал → undecided;
- существующий сценарий participate → reject → restore → participate
  сохранён.
