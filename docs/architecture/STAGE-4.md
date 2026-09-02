# Этап 4 — GoszakupkiByAdapter

**Статус:** анонимный source-native поиск и чтение публичных карточек
реализованы и проверены на реальном сайте.

---

## 1. Цель

Подключить реальный `goszakupki.by` за уже существующим
`ProcurementSourcePort`, не передавая знание HTML в MCP tools, агентов или
доменный слой.

## 2. Архитектурное решение

- `GoszakupkiBySource` реализует тот же порт, что fixture source.
- `GoszakupkiHttpClient` отвечает только за безопасное read-only HTTP-чтение.
- `parseGoszakupkiSearchPage` преобразует строки списка в `SearchHit`.
- `parseGoszakupkiCard` преобразует HTML пяти маршрутов в source-neutral
  контракты.
- HTML parser не выполняет сетевые запросы и тестируется на обезличенных
  structural fixtures.
- Source identifier содержит маршрут: `request/3632989`. Видимый номер
  `auc0003632989` сохраняется как `ExternalIdentifier(kind="auc")`.
- Короткий in-memory cache не позволяет семи MCP tools повторно скачивать одну
  карточку в рамках последовательного расследования.

## 3. Почему именно так

**Семейство является частью идентичности источника.** Один `auc...` не содержит
маршрут карточки, а `get` получает только `sourceProcurementId`. Формат
`family/numeric-id` позволяет построить URL без перебора контроллеров.

**Поиск использует анонимную сессию площадки.** Прямой запрос списка без cookie
перенаправляется на `/site/login`, но главная страница выдаёт анонимный session
cookie. HTTP-клиент воспроизводит этот публичный браузерный flow и один раз
обновляет сессию при её истечении. Учётные данные не требуются и не хранятся.

**Парсер отделён от транспорта.** Изменение TLS, rate limit или timeout не
затрагивает CSS selectors. Изменение разметки не затрагивает MCP server.

**Неизвестное не угадывается.** Sparse card остаётся валидной; неизвестный
status возвращается как `unknown`. Даты без времени сохраняются с
`precision=date` и `Europe/Minsk`.

**Сторонний агрегатор не подменяет источник.** Он использовался только вручную
для обнаружения публичных URL. Production adapter не обращается к нему.

## 4. Проверенные страницы

02.09.2026 с машины разработки в Беларуси получены HTTP 200:

- `auction/view/3545578`
- `marketing/view/3636646`
- `request/view/3632989`
- `etrade/view/3636341`
- `single-source/view/3637380`
- `tenders/posted` после bootstrap через главную страницу

Из них созданы обезличенные fixtures: реальные структура, labels и CSS classes
с заменёнными организациями, контактами и предметами закупки.

## 5. HTTP boundary

Клиент обеспечивает:

- только same-origin GET;
- timeout и ограничение размера HTML;
- configurable rate limit, по умолчанию 20 запросов в минуту;
- явное распознавание 403, 429, 5xx, login redirect и anti-bot challenge;
- bootstrap, хранение в памяти и однократное обновление анонимной cookie-сессии;
- circuit breaker после повторных транспортных ошибок;
- объединение встроенного и системного CA store Node.

Последний пункт нужен потому, что обычный Node `fetch` на текущей цепочке
сертификатов завершался `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, тогда как системный
Windows trust store проверяет цепочку. TLS-проверка не отключается.

CAPTCHA не обходится. Такие ответы становятся `source_unavailable`.

## 6. Изменения

- live mode для Procurement MCP;
- source-native поиск по `TendersSearch[text]` с пагинацией, дедупликацией и
  нейтральными include/exclude/kind/date фильтрами;
- HTML parser карточки, лотов, позиций, заказчика, дат, сумм и документов;
- source status из видимых статусов лотов;
- document metadata URL и download URL без загрузки файла;
- типизированная ошибка недоступности внешнего источника;
- optional live contract suite;
- актуализирована документация доступности площадки.

## 7. Новые файлы

```text
mcp/procurement/src/goszakupki-by-http.ts
mcp/procurement/src/goszakupki-by-parser.ts
mcp/procurement/src/goszakupki-by-source.ts
mcp/procurement/src/goszakupki-by-http.test.ts
mcp/procurement/src/goszakupki-by-parser.test.ts
mcp/procurement/src/goszakupki-by-source.test.ts
mcp/procurement/src/goszakupki-by.live.test.ts
tests/fixtures/goszakupki-by/auction.html
tests/fixtures/goszakupki-by/marketing.html
tests/fixtures/goszakupki-by/request.html
tests/fixtures/goszakupki-by/etrade.html
tests/fixtures/goszakupki-by/single-source.html
tests/fixtures/goszakupki-by/search.html
docs/architecture/STAGE-4.md
```

## 8. Изменяемые файлы

- `mcp/procurement/src/main.ts`
- `mcp/procurement/src/index.ts`
- `mcp/procurement/src/server.ts`
- `mcp/procurement/src/source-registry.ts`
- `mcp/procurement/package.json`
- `package-lock.json`
- `.env.example`
- `README.md`
- `AGENTS.md`
- `infra/README.md`
- `docs/ops/ubuntu-server.md`

## 9. Изменения БД

Нет. Adapter возвращает внешнее состояние и не импортирует `@procurement/db`.
Сохранение raw HTML и idempotent upsert остаются обязанностью application
workflow.

## 10. Контракты API / MCP / агентов

HTTP API и агенты не добавлены. Семь MCP tool names не изменились.

Live source:

- `get`, `get_status`, `get_lots`, `get_documents`, `get_history` читают
  публичную карточку;
- `get_changes` проверяет существование карточки и возвращает пустой source
  event list; snapshot diff появится в monitoring workflow;
- `search` открывает список в анонимной cookie-сессии, запрашивает каждое
  include-слово как source-native OR и применяет neutral filters.

## 11. Тесты

- пять обезличенных card fixtures и fixture списка;
- sparse card без выдуманных optional fields;
- source identity и external `auc` identity;
- суммы, date-only, lots, positions и document links;
- cache между projection methods;
- 404 → `not_found`;
- cookie bootstrap, login refresh, CAPTCHA, transport error и circuit breaker;
- rate limiting и same-origin boundary;
- live contract на search и пяти реальных маршрутах, запускаемый только явно.

Команда live-проверки в PowerShell:

```powershell
$env:RUN_GOSZAKUPKI_LIVE_TESTS="1"
npm test -- mcp/procurement/src/goszakupki-by.live.test.ts
```

Проверка реализации:

- `npm run verify` — 110 тестов, lint/typecheck/architecture без ошибок;
- live contract — search и 5 из 5 реальных маршрутов;
- `npm run build` — успешно;
- `npm audit` — 0 vulnerabilities.

## 12. Риски и ограничения

1. **Анонимная сессия нестабильна как внешний контракт.** Площадка может
   изменить bootstrap cookie или снова закрыть список; login/CAPTCHA остаются
   явными `source_unavailable`.
2. **HTML нестабилен.** Fixtures защищают известные пять маршрутов, но изменение
   labels/classes потребует parser update.
3. **Source history неполна.** Карточка содержит chronology links; полное
   содержание отдельных вопросов требует дополнительных публичных запросов.
4. **`get_changes` не вычисляет diff.** Сравнение snapshots и append-only
   ChangeEvent относятся к этапу мониторинга.
5. **Юридические и нагрузочные ограничения** до production должны быть
   подтверждены владельцем системы; текущий клиент read-only и ограничен
   20 RPM.

## 13. Критерии приёмки

- [x] реальные карточки пяти маршрутов доступны и распознаются;
- [x] HTML fixtures обезличены;
- [x] parser отделён от HTTP;
- [x] sparse fields не ломают pipeline;
- [x] 403/CAPTCHA/login не маскируются как успешный ответ;
- [x] TLS verification не отключена;
- [x] adapter не импортирует DB/application/worker;
- [x] сторонний агрегатор не является production dependency;
- [x] `npm run verify`, build и audit проходят;
- [x] source-native `procurement.search` работает без входа;
- [x] cookie-сессия обновляется без учётных данных;
- [x] сторонний агрегатор не используется.
