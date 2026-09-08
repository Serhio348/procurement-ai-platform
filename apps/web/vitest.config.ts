import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const fromWeb = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@procurement/contracts": fromWeb("../../packages/contracts/src/index.ts"),
      "@procurement/domain": fromWeb("../../packages/domain/src/index.ts"),
    },
  },
  test: {
    environment: "jsdom",
    testTimeout: 15000,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
