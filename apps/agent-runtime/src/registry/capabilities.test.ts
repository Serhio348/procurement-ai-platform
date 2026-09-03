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
    expect(capabilityRegistry.monitoring.allowedTools).toContain("procurement.get_status");
    expect(capabilityRegistry.monitoring.forbiddenTools).toContain("telegram.send");
    expect(capabilityRegistry.report.allowedTools).toContain("files.put");
    expect(capabilityRegistry.report.forbiddenTools).toContain("telegram.send");
    expect(capabilityRegistry.notification.allowedTools).toEqual([
      "notification.send",
      "telegram.send",
    ]);
    expect(capabilityRegistry.notification.forbiddenTools).toContain("procurement.search");
    expect(capabilityRegistry.notification.forbiddenTools).toContain("documents.download");
  });
});
