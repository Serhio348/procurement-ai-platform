/**
 * Architectural dependency rules.
 *
 * The layering from docs/architecture/STAGE-0.md is enforced here, not by
 * convention: domain stays pure, contracts stay leaf-level.
 */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "Circular imports break the layered architecture.",
      from: {},
      to: { circular: true },
    },
    {
      name: "domain-is-pure",
      severity: "error",
      comment:
        "packages/domain must not depend on infrastructure, transport, or LLM code. It may only use packages/contracts.",
      from: { path: "^packages/domain/src" },
      to: {
        pathNot: [
          "^packages/domain/src",
          "^packages/contracts",
          "^node_modules/zod",
          "^node_modules/vitest",
        ],
      },
    },
    {
      name: "contracts-are-leaf",
      severity: "error",
      comment: "packages/contracts must not depend on any other workspace package.",
      from: { path: "^packages/contracts/src" },
      to: {
        pathNot: ["^packages/contracts/src", "^node_modules/zod", "^node_modules/vitest"],
      },
    },
    {
      name: "db-stays-below-apps",
      severity: "error",
      comment: "packages/db may use contracts only. No HTTP, queue, UI, or MCP servers.",
      from: { path: "^packages/db/src" },
      to: {
        pathNot: [
          "^packages/db/src",
          "^packages/contracts",
          "(^|/)node_modules/",
          "^(node:)?(url|path|fs)$",
        ],
      },
    },
    {
      name: "mcp-does-not-know-db-or-profiles-runtime",
      severity: "error",
      comment:
        "Procurement MCP must not import the database or application layer. DomainProfile filtering happens above the adapter.",
      from: { path: "^mcp/" },
      to: { path: "(^packages/db|^packages/application|^apps/|^workers/)" },
    },
    {
      name: "mcp-client-does-not-import-implementations",
      severity: "error",
      comment: "The typed MCP client depends on contracts, not concrete servers or persistence.",
      from: { path: "^packages/mcp-client/src" },
      to: { path: "(^packages/db|^packages/application|^mcp/|^apps/|^workers/)" },
    },
    {
      name: "workers-are-not-ui",
      severity: "error",
      comment: "Workers enqueue and process jobs; they must not import web UI code.",
      from: { path: "^workers/" },
      to: { path: "^apps/" },
    },
    {
      name: "application-does-not-import-adapters",
      severity: "error",
      comment: "Application use cases talk to ports, not to a concrete MCP server tree.",
      from: { path: "^packages/application/src" },
      to: { path: "(^mcp/|^apps/)" },
    },
    {
      name: "no-orphans",
      severity: "warn",
      comment: "Unreachable module - probably dead code.",
      from: {
        orphan: true,
        pathNot: ["\\.d\\.ts$", "(^|/)tsconfig\\.json$", "(^|/)drizzle\\.config\\.ts$"],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(dist|coverage)/" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".js", ".json"],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
