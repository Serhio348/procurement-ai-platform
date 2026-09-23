import { describe, expect, it } from "vitest";
import { mcpChildEnv } from "./procurement-mcp.js";

describe("mcpChildEnv (R43)", () => {
  it("keeps source/blob knobs and OS essentials but drops API secrets", () => {
    const env = mcpChildEnv({
      PATH: "/usr/bin",
      HOME: "/root",
      GOSZAKUPKI_BY_BASE_URL: "https://goszakupki.by",
      GOSZAKUPKI_BY_RATE_LIMIT_RPM: "20",
      DOCUMENT_BLOB_DIR: "/data/blobs",
      DOCUMENT_OCR_MAX_PAGES: "20",
      PROCUREMENT_SOURCE_MODE: "live",
      SEARCH_PAGES: "3",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/certs/ca-certificates.crt",
      LOG_LEVEL: "info",
      // Secrets that must never reach the child:
      DATABASE_URL: "postgres://user:secret@db/app",
      INTERNAL_API_TOKEN: "token",
      AUTH_BOOTSTRAP_PASSWORD: "password",
      SMTP_PASSWORD: "smtp-secret",
      OPENAI_API_KEY: "sk-secret",
      AUTH_PUBLIC_URL: "https://console.example",
      API_PORT: "3001",
    });

    expect(env["GOSZAKUPKI_BY_BASE_URL"]).toBe("https://goszakupki.by");
    expect(env["DOCUMENT_BLOB_DIR"]).toBe("/data/blobs");
    expect(env["PROCUREMENT_SOURCE_MODE"]).toBe("live");
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["DATABASE_URL"]).toBeUndefined();
    expect(env["INTERNAL_API_TOKEN"]).toBeUndefined();
    expect(env["AUTH_BOOTSTRAP_PASSWORD"]).toBeUndefined();
    expect(env["SMTP_PASSWORD"]).toBeUndefined();
    expect(env["OPENAI_API_KEY"]).toBeUndefined();
    expect(env["AUTH_PUBLIC_URL"]).toBeUndefined();
    expect(env["API_PORT"]).toBeUndefined();
  });
});
