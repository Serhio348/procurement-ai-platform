# STAGE-109 · CI: реальный PostgreSQL в verify + браузерный e2e (R41)

Дата: 2026-05-06. Статус: выполнено.

## Проблема

Обязательной проверки не было: PostgreSQL-интеграционные тесты пропускались
без `TEST_DATABASE_URL` — «зелёный» прогон мог скрывать сломанный write-path
в БД (в т.ч. регрессии R37/R39). Браузерных end-to-end тестов не было
вообще: связку SPA → API → SQL не проверял никто.

## Решение

**`.github/workflows/ci.yml`** — на каждый push в main и каждый PR:

- **job `verify`**: сервисы postgres:16-alpine и redis:7-alpine с health-
  checks → `npm run db:migrate` → `npm run verify` с `TEST_DATABASE_URL` —
  все `describe.skipIf(TEST_DATABASE_URL)`-тесты выполняются на настоящей
  мигрированной БД. Затем полная сборка.
- **job `e2e`**: postgres:16 → миграции → `playwright install chromium` →
  `npm run build` → `npx playwright test`; при падении — артефакты
  `playwright-report`/`test-results` на 7 дней.

**`playwright.config.ts`**: `webServer` поднимает стек сам — API на 3199
(fixture-режим: `loadFixtureSearchHits` + cheap scorer, без MCP-детей и без
внешних вызовов; `AUTH_BOOTSTRAP_*` создаёт одобренного админа; discovery
выключен) и vite dev на 5199. Порты выделенные: dev-сервер на 3001/5173
никогда не «переиспользуется» по ошибке — при первом прогоне playwright
молча подключился к чужому экрану.

- `DATABASE_URL: $TEST_DATABASE_URL` — в CI API идёт fail-closed на
  PostgreSQL; локально пустое значение = тот же durable disk store, а
  недоступный `DATABASE_URL` из `.env` не мешает.
- vite-прокси читает `E2E_API_URL` (`vite.config.ts`) — SPA ходит на 3199.

**`e2e/specialist.spec.ts`** — полный круг специалиста в настоящем браузере:
вход → переименование профиля + ключевое слово «КТП» → «Искать по профилю»
→ review-кандидат появляется во «Входящих» → «Открыть карточку» →
«Отслеживать» → «Мои закупки» → `page.reload()` — решение переживает
перезагрузку страницы, потому что живёт в серверном хранилище (R01/R03/R27).

## Что где покрыто

- **Restart-сервера** (очередь/прогресс/ingest после рестарта процесса) —
  vitest-уровень: durable-run restore (R16) и R01; e2e покрывает
  browser-reload, что тоже требует серверной персистентности.
- **Два пользователя / изоляция кабинетов** — `cabinet-isolation.test.ts`
  на уровне API; e2e-расширение при необходимости.
- Локальный запуск: `npm run test:e2e` (chromium ставится
  `npx playwright install chromium`).

## Проверка

- `npx playwright test` локально: зелёный за ~15с (disk store).
- `npm run verify`: 718 + 126 тестов, typecheck, eslint, depcruise — чисто.
