# Этап 88 — профильная модель состояния: оценки по паре, владение прогоном, durable-задания (R04, R12, R15–R17)

Пять пунктов ревью про один дефект модели: у карточки, прогона поиска
и document job не было собственного субъекта. Вердикт жил «на карточке»
вообще, прогресс — «на профиле» вообще, ingest-дедуп — «на id карточки»
вообще. Этап вводит владельцев: оценка принадлежит паре
«карточка–профиль», прогон — своему `runId`, задание — кабинету.

## R04 — assessments[profileId], верхний уровень — производная

У `SpecialistCard` появилось `assessments: Record<profileId,
{verdict, score, reason, evaluatedAt}>`. `rememberFound` пишет оценку в
слот профиля, который выполнил поиск, а верхнеуровневые
`foundAs / relevanceScore / relevanceReason` становятся производной
(`deriveAssessmentView`): любой `match` любого профиля делает
карточку match, иначе берётся свежайшая оценка.

Профильные выдачи (`GET tab=search`, очередь поиска, inbox-проекция)
показывают специалисту оценку именно его профиля через
`projectCardForProfile` — карточка, которую A принял, а B отложил на
проверку, в ленте A выглядит match, в ленте B — review.

Legacy-карточки без `assessments` не ломаются: при первом касании
верхнеуровневый вердикт атрибутируется связанным профилям
(`withCardAssessment`). Повторная оценка тем же профилем перезаписывает
только его слот — чужой `match` больше не исчезает.

## R15 — runId владеет прогрессом

Ручной поиск получает `runId` (uuid). Семантика конкуренции: **новый
прогон вытесняет старый** — повторное «Искать» по тому же профилю не
блокируется 409, а заменяет текущий прогон. Все мутации прогресса
(`begin/scored/skip/finish`) несут `runId` и проверяются через
`isCurrent`: устаревший воркер молча прекращает писать, его записи
отбрасываются. `runId === undefined` не владеет слотом — discovery не
может воскресить завершённый ручной прогон.

`runId` проброшен через `scorePendingHits` и `startListingReviewJob`;
`clear(profileId)` при удалении профиля снимает его прогон. Web опрашивает
`/api/procurements/search/progress` по profileId прогона, а не по
активному профилю вкладки.

## R12 — fingerprint поиско-значимых полей

`replaceProfile` сравнивает все поля, влияющие на retrieval и
relevance: name, purpose, description, keywords, excludeKeywords,
statuses, excludeSingleSource, filters. Любое расхождение сбрасывает
`lastDiscoveryAt` и кэш `rememberIrrelevant`-отказов — старые решения
не блокируют закупки, подходящие новой редакции. Идентичное сохранение
watermark не трогает; ручные решения кабинета (inbox, кейсы) не
инвалидируются.

## R16 — durable прогон и durable ingest

Поиск: прогресс зеркалируется в `workspace.searchRuns` (в PG — в
settings JSONB через `workspaceSettingsPayload`, в файловом режиме — в
снапшоте). `restoreDurableWork` при открытии кабинета восстанавливает
незавершённый прогон в progress-хаб вместе с `runId` — после рестарта
API или перезагрузки страницы UI продолжает видеть живой статус, а не
«ничего не происходит».

Документы: до старта фонового ingest кейсу ставится durable-флаг
`ingesting`. При открытии кабинета `listIngestingCases` находит
незавершённые загрузки и перезапускает их в `cabinetAls` владеющего
кабинета (фон обёрнут в catch — ошибка восстановления журналируется, а
не падает unhandled). Успех upsert'ит карточку и персистится; провал
журналируется, строка остаётся для повтора (см. R25). Терминальный
статус `interrupted` дошёл до UI как завершённый, а не «вечный
спиннер».

## R17 — scope ingest по кабинету

`card.id` детерминирован (`uuidFromHex(sourceId:sourceProcurementId)`) —
одинаков во всех кабинетах. Поэтому `ingestJobs` теперь ключируется
`{workspaceId, cardId}`, а `IngestProgressHub` разделён на сырой хаб и
scoped-фасад `bindIngestScope(workspaceId)`: `begin/listed/file/done/
fail/snapshot` работают внутри кабинета. `document-ingest` (ingest и
reindex) принимает scoped-интерфейс; endpoint прогресса и inline-ingest
в inbox resolve тоже scoped. Два специалиста могут нажать «Участвовать»
на одной процедуре — оба получают свои файлы и свой прогресс.

## Ограничения

- Вытеснение прогона (R15) не отменяет уже выполненные сетевые запросы
  старого воркера — их результаты пишутся в кейсы, но прогресс не
  портят. Отмена in-flight HTTP — не входит в этап (R35).
- Восстановление ingest повторяет только загрузку: уже скачанные файлы
  dedup'ятся по blob-cache, двойной работы нет.
- `searchRuns` хранит текущий слот на профиль; истории прогонов нет.

## Регрессии

- `workspace.test.ts`: инвалидация watermark по name/statuses/filters/
  single-source, roundtrip `searchRuns`, снятие run с удалённым
  профилем.
- `search-progress.test.ts`: вытеснение по `runId`, stale-записи
  отбрасываются.
- `app.test.ts`: оценка B не переписывает match A; второй прогон
  вытесняет первый; прогон восстанавливается после reopen кабинета.
- `ingest-progress.test.ts`: scoped-снапшоты изолированы.
- `cabinet-isolation.test.ts`: одинаковый `card.id` в двух кабинетах —
  два независимых document job.
</content>
