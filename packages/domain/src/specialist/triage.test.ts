import { SearchHit } from "@procurement/contracts";
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
  it("does not start discovery until the specialist turns watch on", () => {
    const workspace = new SpecialistWorkspace();
    expect(workspace.profile().watchNewProcurements).toBe(false);
    expect(shouldRunDiscovery(workspace.profile().watchNewProcurements)).toBe(false);
    workspace.setWatch(true);
    expect(shouldRunDiscovery(workspace.profile().watchNewProcurements)).toBe(true);
  });

  it("saving keywords does not silently enable watch", () => {
    const workspace = new SpecialistWorkspace();
    workspace.replaceProfile({
      name: "Щиты",
      keywords: ["НКУ"],
      excludeKeywords: [],
    });
    expect(workspace.profile().watchNewProcurements).toBe(false);
    expect(workspace.profile().keywords).toEqual(["НКУ"]);
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
