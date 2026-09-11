# Этап 40 — архив «Моих закупок» и один флажок одного источника

## Цель

Плитки «Мои закупки» после сжатия в этапе, предшествующем 39, стали слишком
мелкими и разновысокими. В профиле осталось два флажка про закупки из одного
источника, хотя специалисту нужен один — «не показывать» вовсе. А из списка
«Мои закупки» завершённую процедуру было некуда деть: только «отклонить», что
стирает и решение, и накопленную карточку. Этап добавляет архив и наводит порядок.

## Решение

```
Мои закупки:  Все │ Слежу │ Участвую │ Архив
                  карточка ──«В архив»──▶ workspace.archivedSourceIds
                  карточка ──«Убрать»───▶ decision "reject" (уже было)
                  архив ──«Вернуть»─────▶ triage сохраняется
```

### Архив — не вид triage, а полка рядом

`SpecialistTriageKind` остаётся тройкой (`monitor | participate | reject`).
Архив хранится отдельным множеством `archivedSourceIds` в
`SpecialistWorkspaceState`: возврат из архива не угадывает прошлое решение —
карточка снова становится «Слежу» или «Участвую» как была. Карточка получает
`archived: boolean` в `withTriage` — той же точке, где подставляется triage.

Архивные кейсы остаются в каталоге и в `listed()`, но выбывают из
`monitorDecidedCases`: читать карточку завершённой процедуры каждый проход —
лишний `procurement.get` и ложные «изменения» во входящих.

Новый endpoint `POST /api/procurements/:id/archive` с телом
`SpecialistArchiveWrite { archived: boolean }` возвращает тот же
`SpecialistProcurementListResponse`, что и `/decision`. «Убрать» — это
существующий `reject`: кейс уходит из списков и больше не предлагается поиском;
на клиенте решение подтверждается `window.confirm`.

### Один флажок вместо двух

`excludeSingleSourceAfterFailed` удалён: его сценарий («оставить закупки из
одного источника, но убрать объявленные после несостоявшейся») — частный случай
`excludeSingleSource`, который по виду процедуры отбрасывает их все без единого
чтения карточки. Вместе с флагом ушли `createFailedSingleSourceFilter` и его
стоимость — один `procurement.get` на каждую single-source-строку выдачи.

Полезное из этапа 39 остаётся: `singleSourceBasis` /
`precedingProcedureNumber` на карточке, предикат
`isSingleSourceAfterFailedProcedure` и фиолетовая пометка «после
несостоявшейся» на плитке — это показ данных, а не фильтр.

### Плитки крупнее и одной высоты

Сетка `minmax(260px → 340px)`, типографика поднята примерно на 30%: заголовок
12 → 15.5px, сумма 13.5 → 17.5px, подписи 9–11 → 11.5–15px. Плитка перестала
быть одним `<button>`: внутри — `<button>` навигации и строка действий
«В архив» / «Убрать» (в архиве — «Вернуть» / «Убрать»). `li` стал flex-ом,
карточка растягивается на высоту ряда, `min-height: 250px`; заголовок зажат в
три строки, заказчик и контакт — в две, поэтому высоты совпадают.

## Изменения

Новые файлы:

- `docs/architecture/STAGE-40.md`

Удалённые:

- `apps/api/src/single-source-filter.ts` (+ тест) — флаг убран, фильтр не нужен

Изменённые:

- `packages/contracts/src/specialist.ts` — `archived`, `archivedSourceIds`,
  `SpecialistArchiveWrite`; минус `excludeSingleSourceAfterFailed`
- `packages/domain/src/specialist/workspace.ts` — множество архива, миграция
  состояния, минус строка флага в `replaceProfile`
- `apps/api/src/app.ts` — `withTriage` ставит `archived`, мониторинг пропускает
  архивные, endpoint `/archive`, фильтр по основанию убран из обоих проходов
- `apps/web/src/api/specialist.ts` — `setProcurementArchived`
- `apps/web/src/SpecialistApp.tsx`, `main.tsx` — prop `archive`, кнопки на плитке
- `apps/web/src/procurements/MyProcurementsApp.tsx` — вкладка «Архив», действия
- `apps/web/src/profile/ProfileApp.tsx` — один флажок «из одного источника»
- `apps/web/src/styles.css` — укрупнение и выравнивание плиток

## Тесты

- domain: `archivedSourceIds` переживает snapshot round-trip и снятие флага;
- api: архив сохраняет triage, выводит кейс из мониторинга и возвращает его
  обратно (`monitoredCount` 0 → 1);
- web: архивная карточка не видна в основных вкладках и лежит в «Архиве»;
  «В архив» шлёт `onArchive(id, true)`; «Убрать» спрашивает подтверждение и без
  него не срабатывает; профиль сохраняет единственный флажок и статус `failed`.

`npm run verify` — до коммита.

## Риски

- Состояние архива живёт в workspace JSON (PostgreSQL и файл): старые записи
  без `archivedSourceIds` читаются через `.default([])` — миграция БД не нужна.
- «Убрать» необратимо в смысле поиска: отклонённый `sourceProcurementId` больше
  не вернётся в выдачу этого консольного контура. Кнопка потому и спрашивает.
- `-webkit-line-clamp` поддержан всеми целевыми браузерами; без поддержки
  заголовок просто растянет плитку — безопасная деградация.

## Обновление на сервере

Миграций БД нет:

```bash
cd /opt/procurement-ai-platform
git pull origin main
npm install
npm run build
npm run build -w @procurement/web
chmod -R o+rX apps/web/dist
sudo systemctl restart procurement-api    # имя юнита — как на VPS
```
