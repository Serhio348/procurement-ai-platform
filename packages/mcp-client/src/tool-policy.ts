import { McpToolName, type McpToolName as McpToolNameValue } from "@procurement/contracts";
import { z } from "zod";

export const ToolPolicy = z.object({
  agentAllowedTools: z.array(McpToolName),
  agentForbiddenTools: z.array(McpToolName).default([]),
  profileAllowedTools: z.array(McpToolName).optional(),
  systemForbiddenTools: z.array(McpToolName).default([]),
});
export type ToolPolicy = z.input<typeof ToolPolicy>;

export type ToolPolicyDenialReason =
  | "not_allowed_by_agent"
  | "not_allowed_by_profile"
  | "forbidden_by_agent"
  | "forbidden_by_system";

export interface ToolPolicyDecision {
  allowed: boolean;
  reason?: ToolPolicyDenialReason;
}

export class ToolPolicyDeniedError extends Error {
  readonly toolName: McpToolNameValue;
  readonly reason: ToolPolicyDenialReason;

  constructor(toolName: McpToolNameValue, reason: ToolPolicyDenialReason) {
    super(`Tool ${toolName} denied: ${reason}`);
    this.name = "ToolPolicyDeniedError";
    this.toolName = toolName;
    this.reason = reason;
  }
}

export class ToolPolicyGate {
  readonly #agentAllowed: ReadonlySet<McpToolNameValue>;
  readonly #agentForbidden: ReadonlySet<McpToolNameValue>;
  readonly #profileAllowed: ReadonlySet<McpToolNameValue> | undefined;
  readonly #systemForbidden: ReadonlySet<McpToolNameValue>;

  constructor(policy: ToolPolicy) {
    const parsed = ToolPolicy.parse(policy);
    this.#agentAllowed = new Set(parsed.agentAllowedTools);
    this.#agentForbidden = new Set(parsed.agentForbiddenTools);
    this.#profileAllowed =
      parsed.profileAllowedTools === undefined ? undefined : new Set(parsed.profileAllowedTools);
    this.#systemForbidden = new Set(parsed.systemForbiddenTools);
  }

  decide(toolName: McpToolNameValue): ToolPolicyDecision {
    if (this.#systemForbidden.has(toolName)) {
      return { allowed: false, reason: "forbidden_by_system" };
    }
    if (this.#agentForbidden.has(toolName)) {
      return { allowed: false, reason: "forbidden_by_agent" };
    }
    if (!this.#agentAllowed.has(toolName)) {
      return { allowed: false, reason: "not_allowed_by_agent" };
    }
    if (this.#profileAllowed !== undefined && !this.#profileAllowed.has(toolName)) {
      return { allowed: false, reason: "not_allowed_by_profile" };
    }
    return { allowed: true };
  }

  assertAllowed(toolName: McpToolNameValue): void {
    const decision = this.decide(toolName);
    if (!decision.allowed && decision.reason !== undefined) {
      throw new ToolPolicyDeniedError(toolName, decision.reason);
    }
  }

  /** The allowlist an agent may actually invoke, in closed-enum order. */
  allowedTools(): McpToolNameValue[] {
    return McpToolName.options.filter((toolName) => this.decide(toolName).allowed);
  }
}
