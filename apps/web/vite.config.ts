import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const fromWeb = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@procurement/contracts": fromWeb("../../packages/contracts/src/index.ts"),
      "@procurement/domain": fromWeb("../../packages/domain/src/index.ts"),
    },
  },
  build: {
    target: "es2022",
  },
  server: {
    port: 5173,
    strictPort: true,
    allowedHosts: [".trycloudflare.com", ".ngrok-free.app", ".ngrok.io"],
    proxy: {
      "/api": {
        // E2E_API_URL lets playwright run the stack on dedicated ports so a
        // dev server already on 3001/5173 is never reused by mistake (R41).
        target: process.env["E2E_API_URL"] ?? "http://127.0.0.1:3001",
        timeout: 180_000,
        proxyTimeout: 180_000,
      },
    },
  },
});
