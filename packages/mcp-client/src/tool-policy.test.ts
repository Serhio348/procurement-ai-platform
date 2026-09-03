import { describe, expect, it } from "vitest";
import { ToolPolicyDeniedError, ToolPolicyGate } from "./tool-policy.js";

describe("ToolPolicyGate", () => {
  it("allows only the intersection of agent and profile allowlists", () => {
    const gate = new ToolPolicyGate({
      agentAllowedTools: ["procurement.search", "procurement.get"],
      profileAllowedTools: ["procurement.search"],
    });

    expect(gate.decide("procurement.search")).toEqual({ allowed: true });
    expect(gate.decide("procurement.get")).toEqual({
      allowed: false,
      reason: "not_allowed_by_profile",
    });
  });

  it("lets explicit denylists override every allowlist", () => {
    const gate = new ToolPolicyGate({
      agentAllowedTools: ["procurement.search", "procurement.get"],
      agentForbiddenTools: ["procurement.get"],
      systemForbiddenTools: ["procurement.search"],
    });

    expect(() => gate.assertAllowed("procurement.search")).toThrow(ToolPolicyDeniedError);
    expect(gate.decide("procurement.search").reason).toBe("forbidden_by_system");
    expect(gate.decide("procurement.get").reason).toBe("forbidden_by_agent");
  });

  it("denies a tool missing from the agent allowlist", () => {
    const gate = new ToolPolicyGate({ agentAllowedTools: [] });

    expect(gate.decide("procurement.search")).toEqual({
      allowed: false,
      reason: "not_allowed_by_agent",
    });
  });

  it("lists only tools that survive agent, profile and denylist checks", () => {
    const gate = new ToolPolicyGate({
      agentAllowedTools: ["procurement.search", "procurement.get", "telegram.send"],
      agentForbiddenTools: ["telegram.send"],
      profileAllowedTools: ["procurement.search", "telegram.send"],
    });

    expect(gate.allowedTools()).toEqual(["procurement.search"]);
  });
});
