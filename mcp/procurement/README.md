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

The fixture transport is deterministic and performs no network calls. It is not
a parser for `goszakupki.by`; real page parsing remains blocked until verified
HTML samples are available for Stage 4.

The process uses MCP stdio. Standard output is reserved for protocol frames;
structured logs go to standard error.
