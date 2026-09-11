# Этап 39 — несостоявшиеся процедуры и закупки из одного источника

## Цель

Специалист видел карточку со статусом «рассмотрение предложений» и сроком подачи
8 августа — в сентябре. На площадке это была закупка из одного источника с
основанием «7. Признание процедуры государственной закупки несостоявшейся». Наш
словарь статусов не знал слова «несостоявшаяся», основание с карточки не
читалось, а профиль не умел отсеивать такие закупки. Этап закрывает три дыры.

## Решение

```
listing row ──kind──▶ SearchHit.kind ──▶ profile.excludeSingleSource   (без запросов)
card page  ──basis─▶ ProcedureCard.singleSourceBasis
                     ProcedureCard.precedingProcedureNumber
                       └─▶ isSingleSourceAfterFailedProcedure()          (domain)
                             └─▶ FailedSingleSourceFilter (api)          (1 card read / hit, кэш)
lot badge  «несостоя…» ─▶ ProcedureStatus.failed ─▶ фильтр «Статусы закупок»
card dates ──▶ bidsDeadlinePassed() ─▶ пометка «срок подачи истёк» в UI
```

### Новый статус `failed`

`ProcedureStatus` получил значение `failed` («не состоялась»). Парсер goszakupki
проверяет подстроку «несостоя» **до** «рассмотр»: бейдж лота вида
«Рассмотрение … Процедура признана несостоявшейся» иначе становился
`under_review`. Подписи добавлены в `statusLabel` (domain и report), чекбокс — в
профиль. В PostgreSQL enum `procedure_status` расширен миграцией
`0006_procedure_status_failed.sql`; консольные карточки лежат в jsonb, для них
миграция не нужна.

### Вид процедуры на строке списка

`SearchHit.kind` — вид уже виден в колонке списка, парсер отдавал его только
внутри адаптера. Теперь он идёт в домен, и `selectRelevantSearchCards`
отбрасывает `single_source`, если у профиля `excludeSingleSource`. Строка без
вида не отбрасывается: отсутствие данных — не основание.

### Основание закупки из одного источника

Карточка отдаёт `singleSourceBasis` и `precedingProcedureNumber` (поля
«Основание выбора процедуры…» и «Номер процедуры…, признанной несостоявшейся»).
Предикат `isSingleSourceAfterFailedProcedure(card)` — чистый, в `domain`: только
`single_source` и только при наличии номера или слова «несостоя» в основании.

Основание есть только на карточке, поэтому флаг профиля
`excludeSingleSourceAfterFailed` стоит один `procurement.get` на каждую
single-source-строку. `createFailedSingleSourceFilter` (`apps/api`) читает
карточку через уже существующий `SpecialistCardWatchPort`, кэширует вердикт на
время процесса (основание не меняется), а нечитаемую карточку **оставляет** в
выдаче и пробует снова в следующий раз. В фоновом обходе чтения идут через
`discoveryController.beforeRequest`, как и остальные запросы к площадке.

Отсев учитывается в `discardedCount` ответа поиска, чтобы специалист видел, что
что-то было убрано, а не «поиск ничего не нашёл».

### «Срок подачи истёк»

`bidsDeadlinePassed(card, now)` в `domain` решает по датам, а не по статусу
площадки: `sourceCard.bidsDeadline` (instant или дата до конца дня в часовом
поясе источника), иначе строка из `watchSnapshot`. Плитка «Мои закупки» и
карточка показывают красную пометку независимо от того, что пишет площадка;
рядом — фиолетовая «после несостоявшейся», если карточка это подтверждает.

## Изменения

Новые файлы:

- `packages/domain/src/specialist/deadline.ts` (+ тест)
- `apps/api/src/single-source-filter.ts` (+ тест)
- `apps/web/src/procurements/MyProcurementsApp.test.tsx`
- `packages/db/drizzle/0006_procedure_status_failed.sql`
- `docs/architecture/STAGE-39.md`

Изменённые:

- `packages/contracts/src/procurement.ts` — `failed`, `SearchHit.kind`,
  `ProcedureCard.singleSourceBasis` / `precedingProcedureNumber`
- `packages/contracts/src/specialist.ts` — два флага профиля
- `mcp/procurement/src/goszakupki-by-parser.ts` — статус, kind, поля основания
- `packages/domain/src/search/search-cards.ts` — фильтр по kind, предикат
- `packages/domain/src/specialist/{case,source-card,workspace}.ts`,
  `report/compile.ts`
- `apps/api/src/app.ts` — фильтр в ручном поиске и обходе
- `apps/web/src/profile/ProfileApp.tsx` — секция «Закупки из одного источника»,
  статус «Не состоялась»
- `apps/web/src/procurements/{MyProcurementsApp,ProcurementDetailApp}.tsx`,
  `styles.css`

## Тесты

- парсер: основание, номер несостоявшейся, `failed` из бейджа лота, kind на строке;
- domain: `excludeSingleSource` отбрасывает только при флаге и только с kind;
  предикат — по основанию/номеру, не по виду; `bidsDeadlinePassed` — конец дня
  в часовом поясе, «рассмотрение» не мешает, без даты — false;
- api: фильтр читает только single-source, кэширует, не трогает нечитаемые,
  ходит через rate-limiter;
- web: профиль сохраняет флаги и статус `failed`; плитка показывает обе пометки.

`npm run verify`: 428 + 47 тестов, dependency-cruiser чист.

## Риски

- Тексты полей «Основание…» и «Номер процедуры…» взяты со скриншота реальной
  карточки; вторая форма подписи добавлена на всякий случай. Если площадка
  переименует поле, предикат вернёт `false` и закупка останется в выдаче —
  безопасная сторона.
- `excludeSingleSourceAfterFailed` замедляет поиск пропорционально числу
  single-source-строк на странице; в UI об этом сказано прямо.
- `ALTER TYPE … ADD VALUE` на PostgreSQL 16 работает внутри транзакции
  drizzle-миграции; на PostgreSQL < 12 потребовалось бы вынести из транзакции.

## Обновление на сервере

```bash
cd /opt/procurement-ai-platform
git pull origin main
npm install
npm run build
npm run db:migrate -w @procurement/db     # DATABASE_URL из .env
npm run build -w @procurement/web
chmod -R o+rX apps/web/dist
sudo systemctl restart procurement-api    # имя юнита — как на VPS
```
