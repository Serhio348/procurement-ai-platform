import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromRoot = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against sources so a build is not a prerequisite for testing.
    alias: {
      "@procurement/contracts": fromRoot("./packages/contracts/src/index.ts"),
      "@procurement/domain": fromRoot("./packages/domain/src/index.ts"),
      "@procurement/observability": fromRoot("./packages/observability/src/index.ts"),
      "@procurement/mcp-client": fromRoot("./packages/mcp-client/src/index.ts"),
    },
  },
  test: {
    include: [
      "packages/**/*.test.ts",
      "apps/agent-runtime/**/*.test.ts",
      "apps/api/**/*.test.ts",
      "mcp/**/*.test.ts",
      "workers/**/*.test.ts",
    ],
    environment: "node",
    coverage: {
      reporter: ["text", "lcov"],
      include: ["packages/**/src/**", "apps/**/src/**"],
    },
  },
});
