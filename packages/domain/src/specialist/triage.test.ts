import { SearchHit, electricalEquipmentSeedV1 } from "@procurement/contracts";
import { describe, expect, it } from "vitest";
import {
  isRejectedTriage,
  partitionHitsByDecision,
  shouldRunDiscovery,
} from "./triage.js";
import { SpecialistWorkspace } from "./workspace.js";

function hit(sourceProcurementId: string, title: string): SearchHit {
  return SearchHit.parse({
    sourceId: "goszakupki_by",
    sourceProcurementId,
    url: `https://goszakupki.by/auction/view/${sourceProcurementId}`,
    title,
  });
}

describe("specialist triage", () => {
  it("starts with an empty working profile and can keep a second direction", () => {
    const workspace = new SpecialistWorkspace();
    expect(workspace.profile().name).toBe("");
    expect(workspace.profile().description).toBe("");
    expect(workspace.profile().keywords).toEqual([]);
    expect(workspace.profile().instructions).toBe("");
    const second = workspace.addProfile();
    expect(workspace.profiles()).toHaveLength(2);
    expect(workspace.profile().id).toBe(second.id);
    expect(second.keywords).toEqual([]);
    const remaining = workspace.removeProfile(second.id);
    expect(workspace.profiles()).toHaveLength(1);
    expect(remaining.id).toBe(workspace.profiles()[0]?.id);
    expect(() => workspace.removeProfile(remaining.id)).toThrow("last_profile");
  });

  it("clears the stock electrical seed so the form starts empty", () => {
    const workspace = SpecialistWorkspace.parse({
      profile: {
        name: electricalEquipmentSeedV1.name,
        description: electricalEquipmentSeedV1.description,
        keywords: electricalEquipmentSeedV1.keywords,
      },
    });
    expect(workspace.profile().name).toBe("");
    expect(workspace.profile().description).toBe("");
    expect(workspace.profile().keywords).toEqual([]);
    expect(workspace.profile().instructions).toBe("");
  });

  it("does not start discovery until the specialist turns watch on", () => {
    const workspace = new SpecialistWorkspace();
    expect(workspace.profile().watchNewProcurements).toBe(false);
    expect(shouldRunDiscovery(workspace.profile().watchNewProcurements)).toBe(false);
    workspace.setWatch(true);
    expect(shouldRunDiscovery(workspace.profile().watchNewProcurements)).toBe(true);
  });

  it("saving looking-for text does not silently enable watch", () => {
    const workspace = new SpecialistWorkspace();
    workspace.replaceProfile({
      name: "Щиты",
      purpose: "ignored purpose",
      description: "НКУ, щиты",
      instructions: "Бытовые щитки не брать.",
      keywords: ["НКУ", "щиты", "ВРУ"],
    });
    expect(workspace.profile().watchNewProcurements).toBe(false);
    expect(workspace.profile().excludeKeywords).toEqual([]);
    expect(workspace.profile().keywords).toEqual(["НКУ", "щиты", "ВРУ"]);
    expect(workspace.profile().purpose).toBe("ignored purpose");
  });

  it("does not re-offer a rejected or already judged source id on the next discovery", () => {
    const workspace = new SpecialistWorkspace();
    workspace.recordDecision("auction/001", "reject", "2026-09-04T12:00:00.000Z");
    workspace.recordDecision("auction/002", "monitor", "2026-09-04T12:01:00.000Z");
    workspace.recordDecision("auction/003", "participate", "2026-09-04T12:02:00.000Z");

    const partitioned = partitionHitsByDecision(
      [
        hit("auction/001", "КТПБ отвергнутая"),
        hit("auction/002", "КТПБ на мониторинге"),
        hit("auction/003", "КТПБ в работе"),
        hit("auction/004", "Новая КТПБ"),
      ],
      workspace.decidedSourceIds(),
    );

    expect(partitioned.undecided.map((item) => item.sourceProcurementId)).toEqual(["auction/004"]);
    expect(partitioned.skippedDecidedCount).toBe(3);
    expect(isRejectedTriage(workspace.latestKind("auction/001"))).toBe(true);
    expect(workspace.rejectedSourceIds().has("auction/001")).toBe(true);
    expect(workspace.rejectedSourceIds().has("auction/004")).toBe(false);
  });

  it("lets a later decision replace an earlier one without deleting history", () => {
    const workspace = new SpecialistWorkspace();
    workspace.recordDecision("auction/001", "monitor", "2026-09-04T12:00:00.000Z");
    workspace.recordDecision("auction/001", "reject", "2026-09-04T13:00:00.000Z");

    expect(workspace.latestKind("auction/001")).toBe("reject");
    expect(workspace.snapshot().decisions).toHaveLength(2);
    expect(workspace.rejectedSourceIds().has("auction/001")).toBe(true);
  });
});
