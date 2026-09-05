import { z } from "zod";

/**
 * Capabilities are code, not configuration. A specialist composes domain
 * profiles out of these; adding a new one is a programming task.
 */
export const CapabilityId = z.enum([
  "domain_search",
  "document_ingest",
  "commercial_terms",
  "auction_analysis",
  "risk_analysis",
  "monitoring",
  "notification",
  "report",
]);
export type CapabilityId = z.infer<typeof CapabilityId>;

/**
 * Every tool an agent may ever reach. Kept as a closed enum so allow/deny
 * lists cannot contain typos and so permissions are checkable at build time.
 */
export const McpToolName = z.enum([
  "procurement.search",
  "procurement.get",
  "procurement.get_lots",
  "procurement.get_status",
  "procurement.get_history",
  "procurement.get_documents",
  "procurement.get_changes",
  "procurement.download",

  "documents.list",
  "documents.download",
  "documents.extract_text",
  "documents.extract_tables",
  "documents.ocr",
  "documents.search",
  "documents.get_page",
  "documents.delete",

  "files.put",
  "files.get",
  "files.exists",
  "files.delete",

  "memory.get",
  "memory.put",

  "knowledge.search",

  "notification.send",
  "telegram.send",
]);
export type McpToolName = z.infer<typeof McpToolName>;

export const McpServerName = z.enum([
  "procurement",
  "documents",
  "files",
  "memory",
  "knowledge",
  "notification",
]);
export type McpServerName = z.infer<typeof McpServerName>;

/**
 * Static definition of an agent. `allowedTools` and `forbiddenTools` are
 * enforced by the tool policy gate before a call reaches MCP; the prompt is
 * never the security boundary.
 */
export const AgentDefinition = z.object({
  capability: CapabilityId,
  role: z.string().min(1),
  responsibility: z.string().min(1),
  allowedTools: z.array(McpToolName),
  forbiddenTools: z.array(McpToolName),
  /** Context slices this agent is permitted to request from the compiler. */
  contextRequirements: z.array(
    z.enum([
      "event",
      "intent",
      "domain_profile",
      "constraints",
      "procurement",
      "documents",
      "relevant_history",
      "company_knowledge",
    ]),
  ),
  /** Runs below this confidence are escalated instead of accepted. */
  minConfidence: z.number().min(0).max(1),
  /** Hard ceiling for compiled context. Constraints are never silently dropped. */
  maxContextTokens: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
  maxRetries: z.number().int().nonnegative(),
});
export type AgentDefinition = z.infer<typeof AgentDefinition>;
