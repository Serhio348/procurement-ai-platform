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
export async function connectProcurementMcp(options: {
  mode: "live" | "fixture";
  logger: Logger;
  blobDirectory?: string;
}): Promise<ProcurementMcpProcess> {
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const mcpMain = fileURLToPath(
    new URL("../../../mcp/procurement/src/main.ts", import.meta.url),
  );
  const tsxCli = fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
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
  options.logger.info("Procurement MCP connected", { mode: options.mode });
  return {
    caller: serializeMcpToolCaller(new SdkMcpToolCaller(client)),
    close: async () => {
      await client.close();
    },
  };
}
