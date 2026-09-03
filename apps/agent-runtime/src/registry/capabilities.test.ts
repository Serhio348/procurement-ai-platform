import { CapabilityId } from "@procurement/contracts";
import { describe, expect, it } from "vitest";
import { capabilityRegistry } from "./capabilities.js";

describe("capabilityRegistry", () => {
  it("defines every closed capability without industry-specific agents", () => {
    expect(Object.keys(capabilityRegistry).sort()).toEqual([...CapabilityId.options].sort());
    expect(capabilityRegistry.domain_search.allowedTools).toContain("procurement.search");
    expect(capabilityRegistry.domain_search.forbiddenTools).toContain("telegram.send");
  });
});
