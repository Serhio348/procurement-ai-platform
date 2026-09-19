# Этап 85 — профильные операции требуют `profileId` (R03)

## Проблема

Все профильные операции читали `workspace().profile()` — глобально
активный профиль кабинета, общий для всех вкладок и устройств
пользователя. Вкладка A показывала профиль «монтаж», вкладка B
активировала «поставку» — и поиск, очередь, прогресс и переключатель
слежения во вкладке A молча начинали работать с чужим профилем.

## Решение

`profileId` — обязательная часть запроса, а не неявный контекст из
разделяемого состояния. Fallback на активный профиль отсутствует: он
оставлял бы ту же ловушку для любого забывшего параметр вызова.

**Контракты** (`contracts/specialist.ts`):

- `SpecialistProfileSearchRequest` = `SpecialistSearchRequest` +
  обязательный `profileId` — тело `POST /api/procurements/search`;
- `SpecialistProcurementListQuery.profileId` — обязателен при
  `tab=search` (проверяется обработчиком → `400 missing_profile`);
- `SpecialistSearchProgressQuery` — `profileId` для
  `GET /api/procurements/search/progress`.

**API** (`app.ts`):

- `POST /api/procurements/search`: профиль резолвится по
  `findProfile(profileId)` → `404 not_found`; проверка `no_keywords` и
  весь `runManualSearch(profile, …)` идут по указанному профилю;
- `GET /api/procurements?tab=search&profileId=` — очередь профиля из
  запроса; неизвестный id → 404;
- `GET /api/procurements/search/progress?profileId=` — снапшот прогона
  указанного профиля; неизвестный id → 404;
- **удалены** `PUT /api/profile` и `POST /api/profile/watch` — те же
  неявные операции; замены давно есть: `PUT /api/profiles/:id` и
  `POST /api/profiles/:id/watch`;
- `GET /api/profile` остаётся — безобидное чтение профиля по умолчанию
  при загрузке консоли; `/api/profile/discovery` кабинетный (обходит
  все профили со слежением) и профиля не требует.

**Web**:

- `searchProcurements(profileId, offset)`, `fetchSearchProgress(profileId)`,
  `fetchProcurements({profileId})`, `setProfileWatch(id, watch)` —
  клиент всегда называет профиль;
- `ProcurementsApp.runSearch` ищет по `chosenProfileId` — профилю,
  выбранному в панели, а не глобально активному;
- polling прогресса идёт по `searchRun.profileId` — опрос следует за
  поиском, а переключение профиля в другой вкладке его не уводит;
- mount-эффект восстановления (этап 83) и `openProfileSearch` передают
  `profileId` явно;
- `ProfileApp` переключает слежение через `/api/profiles/:id/watch` —
  id редактируемого профиля;
- `activate` остаётся серверным «по умолчанию» для `GET /api/profile`
  — на смысл запросов больше не влияет.

## Регрессии

`app.test.ts`:

- активен профиль B → поиск с `profileId: A` ищет по ключам A, кладёт
  результат в очередь A, `run.profileId === A`; очередь B пуста;
  прогресс A отдаётся по `profileId=A`, у B — синтетический `done`;
- вызовы без `profileId` → 400, с неизвестным id → 404 (поиск, очередь,
  прогресс); `PUT /api/profile` и `POST /api/profile/watch` → 404.

`specialist.test.ts`: `searchProcurements` шлёт `profileId` в теле.
`ProcurementsApp.test.tsx` / `ProfileApp.test.tsx`: поиск и слежение
вызываются с id профиля.
