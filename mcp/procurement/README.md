# Procurement MCP

Source-neutral MCP server for procurement discovery and card inspection.

## Tools

- `procurement.search`
- `procurement.get`
- `procurement.get_status`
- `procurement.get_lots`
- `procurement.get_documents`
- `procurement.get_history`
- `procurement.get_changes`

Every request and response crosses a Zod boundary. The server never imports the
database, application workflows, or a `DomainProfile`.

## Fixture mode

```bash
PROCUREMENT_SOURCE_MODE=fixture npm run mcp:procurement
```

The default normalized fixture is
`tests/fixtures/procurement/normalized.json`. Override it with
`PROCUREMENT_FIXTURE_PATH`.

The fixture transport is deterministic and performs no network calls.

## Live goszakupki.by mode

```bash
PROCUREMENT_SOURCE_MODE=live npm run mcp:procurement
```

The live adapter searches the public tender list and parses `auction`,
`marketing`, `request`, `etrade`, and `single-source` cards. Its source-native
identifier includes the route family, for example `request/3632989`; the
visible `auc...` value is returned as an external identifier.

The HTTP client enforces a request rate, timeout, response-size limit,
same-origin URLs, anti-bot detection, and a small circuit breaker. Before
opening `/tenders/posted`, it obtains an anonymous session cookie from the home
page and refreshes that session once after a login redirect. No account or
third-party aggregator is used. The client also combines Node and
operating-system CA stores because the site does not currently send a complete
certificate chain. TLS verification stays enabled.

Optional live contract check:

```powershell
$env:RUN_GOSZAKUPKI_LIVE_TESTS="1"
npm test -- mcp/procurement/src/goszakupki-by.live.test.ts
```

The process uses MCP stdio. Standard output is reserved for protocol frames;
structured logs go to standard error.
