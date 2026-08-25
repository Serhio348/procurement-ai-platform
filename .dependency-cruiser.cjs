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
      name: "no-orphans",
      severity: "warn",
      comment: "Unreachable module - probably dead code.",
      from: { orphan: true, pathNot: ["\\.d\\.ts$", "(^|/)tsconfig\\.json$"] },
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
