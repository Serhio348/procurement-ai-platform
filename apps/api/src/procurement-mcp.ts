import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  SdkMcpToolCaller,
  serializeMcpToolCaller,
  type McpToolCaller,
} from "@procurement/mcp-client";
import type { Logger } from "@procurement/observability";

export interface ProcurementMcpProcess {
  caller: McpToolCaller;
  close: () => Promise<void>;
}

/**
 * Spawns Procurement MCP over stdio. The API must not import mcp/ source;
 * the child process owns the goszakupki.by adapter.
 */
/**
 * The child sees only what the source adapter needs (R43): source, blob,
 * fixture and logging knobs plus OS essentials to spawn/find CA bundles.
 * API secrets (DATABASE_URL, AUTH_*, SMTP_*, model keys, INTERNAL_API_TOKEN)
 * never cross into the MCP process.
 */
const MCP_ENV_EXACT = new Set([
  "LIVE_CASE_SOURCE_ID",
  "LOG_LEVEL",
  "NODE_EXTRA_CA_CERTS",
  "SEARCH_PAGES",
  "GOSZAKUPKI_TLS_INSECURE",
  "REFRESH_LIVE_OFFICE",
  "PATH",
  "PATHEXT",
  "COMSPEC",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "LANG",
  "LC_ALL",
  "TZ",
  "SHELL",
  "TERM",
  "USER",
  "LOGNAME",
]);
const MCP_ENV_PREFIXES = ["GOSZAKUPKI_BY_", "DOCUMENT_", "PROCUREMENT_", "LC_", "XDG_"];

export function mcpChildEnv(parent: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (MCP_ENV_EXACT.has(key) || MCP_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      env[key] = value;
    }
  }
  return env;
}

export async function connectProcurementMcp(options: {
  mode: "live" | "fixture";
  logger: Logger;
  blobDirectory?: string;
  /** Distinguishes parallel children in logs (background vs interactive lane). */
  lane?: string;
}): Promise<ProcurementMcpProcess> {
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const mcpMain = fileURLToPath(
    new URL("../../../mcp/procurement/src/main.ts", import.meta.url),
  );
  const tsxCli = fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url));
  const env = mcpChildEnv(process.env);
  env["PROCUREMENT_SOURCE_MODE"] = options.mode;
  if (options.blobDirectory !== undefined) {
    env["DOCUMENT_BLOB_DIR"] = options.blobDirectory;
  }
  // Node's fetch ignores tls.setDefaultCACertificates; the child must see
  // NODE_EXTRA_CA_CERTS at process start or goszakupki.by fails TLS.
  const systemCa = "/etc/ssl/certs/ca-certificates.crt";
  if ((env["NODE_EXTRA_CA_CERTS"] ?? "").trim().length === 0 && existsSync(systemCa)) {
    env["NODE_EXTRA_CA_CERTS"] = systemCa;
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsxCli, mcpMain],
    env,
    cwd: repoRoot,
    stderr: "inherit",
  });
  const client = new Client({ name: "specialist-api", version: "0.1.0" });
  try {
    await client.connect(transport);
  } catch (error) {
    await transport.close().catch(() => undefined);
    throw error;
  }
  options.logger.info("Procurement MCP connected", {
    mode: options.mode,
    ...(options.lane === undefined ? {} : { lane: options.lane }),
  });
  return {
    caller: serializeMcpToolCaller(new SdkMcpToolCaller(client)),
    close: async () => {
      await client.close();
    },
  };
}
