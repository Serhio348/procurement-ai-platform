# STAGE-106 · MCP: env-allowlist и очередь с дедлайном (R43, часть 2)

Дата: 2026-05-06. Статус: выполнено.

## Проблема

Дочернему процессу Procurement MCP копировалось **всё** окружение API —
DATABASE_URL, AUTH_*, SMTP_*, ключи моделей, INTERNAL_API_TOKEN уходили в
процесс, которому они не нужны. А в `serializeMcpToolCaller` `timeoutMs`
покрывал только выполнение tool call: вызов мог неопределённо ждать в очереди
за чужими длинными операциями, и приоритетов в очереди не было.

## Решение

**Env-allowlist** (`mcpChildEnv` в `procurement-mcp.ts`): ребёнок получает
только `GOSZAKUPKI_BY_*`, `DOCUMENT_*`, `PROCUREMENT_*`, `NODE_EXTRA_CA_CERTS`,
`LOG_LEVEL`, `SEARCH_PAGES`, `GOSZAKUPKI_TLS_INSECURE`, `LIVE_CASE_SOURCE_ID`,
`REFRESH_LIVE_OFFICE`, `LC_*`, `XDG_*` и OS-необходимые переменные
(PATH/HOME/SYSTEMROOT/TEMP/…). Секреты API не пересекают границу процесса.

**Очередь с дедлайном и приоритетом** (`serializeMcpToolCaller`): вместо
tail-цепочки — явная очередь. `timeoutMs` теперь общий бюджет «ожидание +
выполнение»: вызов, чей дедлайн истёк в очереди, падает с
`McpToolCallError("timeout")` и никогда не занимает pipe. Опция
`priority: "high"` вставляет вызов перед уже стоящими «normal» (FIFO внутри
уровня) — короткое чтение карточки при слежении (`card-watch`, `priority:
"high"`) не ждёт пачку ingest-скачиваний другого кабинета на общем
background-линии. Интерактивная линия — отдельный процесс (STAGE-77).

## Проверка

- `call-tool.test.ts`: дедлайн в очереди → timeout до старта pipe;
  high-приоритет обходит поставленный раньше normal; сериализация сохранена.
- `procurement-mcp.test.ts`: allowlist сохраняет source/blob knobs и
  отсекает DATABASE_URL/AUTH/SMTP/ключи моделей.
