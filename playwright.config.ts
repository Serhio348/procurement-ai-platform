import { defineConfig } from "@playwright/test";

const apiURL = "http://127.0.0.1:3199";
// Vite dev binds `localhost`; on Windows that may resolve to ::1 while
// 127.0.0.1 refuses — keep the check/browser URL on the same name vite prints.
const baseURL = process.env["E2E_BASE_URL"] ?? "http://localhost:5199";
const isCI = process.env["CI"] !== undefined;

/**
 * Browser e2e (R41): the suite drives the real SPA against the real API and
 * the real persistence layer — PostgreSQL when TEST_DATABASE_URL is set (CI),
 * the same fail-closed disk store locally. Dedicated ports 3199/5199 so a
 * running dev stack on 3001/5173 is never reused by mistake.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  retries: isCI ? 1 : 0,
  reporter: isCI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "npm run start -w @procurement/api",
      url: `${apiURL}/api/live`,
      reuseExistingServer: !isCI,
      timeout: 120_000,
      env: {
        API_PORT: "3199",
        // Fixture source: deterministic offline search hits, no MCP children.
        PROCUREMENT_SOURCE_MODE: "fixture",
        AUTH_BOOTSTRAP_EMAIL: "e2e-admin@test.local",
        AUTH_BOOTSTRAP_PASSWORD: "e2e-admin-password",
        AUTH_PUBLIC_URL: baseURL,
        // No background discovery in e2e: the run must be deterministic.
        SPECIALIST_DISCOVERY_INTERVAL_MS: "0",
        // CI points TEST_DATABASE_URL at the service container → the API runs
        // fail-closed on real PostgreSQL. Locally it stays empty → the same
        // durable disk store as a fresh dev checkout (an unreachable
        // DATABASE_URL from .env must not break e2e — fail-closed is for prod).
        DATABASE_URL: process.env["TEST_DATABASE_URL"] ?? "",
      },
    },
    {
      command: "npm run dev -w @procurement/web -- --port 5199 --strictPort",
      url: baseURL,
      reuseExistingServer: !isCI,
      timeout: 120_000,
      env: {
        E2E_API_URL: apiURL,
      },
    },
  ],
});
