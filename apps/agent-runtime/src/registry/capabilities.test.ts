import { CapabilityId } from "@procurement/contracts";
import { describe, expect, it } from "vitest";
import { capabilityRegistry } from "./capabilities.js";

describe("capabilityRegistry", () => {
  it("defines every closed capability without industry-specific agents", () => {
    expect(Object.keys(capabilityRegistry).sort()).toEqual([...CapabilityId.options].sort());
    expect(capabilityRegistry.domain_search.allowedTools).toContain("procurement.search");
    expect(capabilityRegistry.domain_search.forbiddenTools).toContain("telegram.send");
    expect(capabilityRegistry.document_ingest.allowedTools).toContain("documents.extract_text");
    expect(capabilityRegistry.document_ingest.allowedTools).toContain("documents.ocr");
    expect(capabilityRegistry.document_ingest.forbiddenTools).toContain("telegram.send");
    expect(capabilityRegistry.document_ingest.forbiddenTools).toContain("files.delete");
    expect(capabilityRegistry.commercial_terms.allowedTools).toContain("documents.search");
    expect(capabilityRegistry.commercial_terms.forbiddenTools).toContain("procurement.search");
    expect(capabilityRegistry.commercial_terms.forbiddenTools).toContain("telegram.send");
  });
});
