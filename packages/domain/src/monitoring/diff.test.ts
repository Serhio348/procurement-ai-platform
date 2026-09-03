import { DomainMonitoringRule, MonitoringSnapshot } from "@procurement/contracts";
import { describe, expect, it } from "vitest";
import { diffMonitoringSnapshots } from "./diff.js";

const now = "2026-09-03T09:00:00.000Z";
const later = "2026-09-03T10:00:00.000Z";
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);

describe("diffMonitoringSnapshots", () => {
  it("emits nothing on the first check because there is no previous snapshot", () => {
    expect(
      diffMonitoringSnapshots(undefined, snapshot(), [
        DomainMonitoringRule.parse({ watch: "status", intervalMinutes: 60 }),
      ]),
    ).toEqual([]);
  });

  it("detects a status change only when the profile watches status", () => {
    const previous = snapshot({ status: "accepting_bids" });
    const current = snapshot({ status: "cancelled", fetchedAt: later });
    expect(
      diffMonitoringSnapshots(previous, current, [
        DomainMonitoringRule.parse({ watch: "documents", intervalMinutes: 60 }),
      ]),
    ).toEqual([]);
    expect(
      diffMonitoringSnapshots(previous, current, [
        DomainMonitoringRule.parse({
          watch: "status",
          intervalMinutes: 60,
          urgent: true,
          notifyOnChange: true,
        }),
      ]),
    ).toEqual([
      expect.objectContaining({
        kind: "status_changed",
        previous: "accepting_bids",
        current: "cancelled",
        urgent: true,
      }),
    ]);
  });

  it("treats a new document hash as an update and does not drop the old hash", () => {
    const url = "https://example.test/files/spec-001.pdf";
    const previous = snapshot({
      documents: [{ name: "ТЗ.pdf", sourceUrl: url, hash: hashA }],
    });
    const current = snapshot({
      fetchedAt: later,
      documents: [{ name: "ТЗ.pdf", sourceUrl: url, hash: hashB }],
    });
    const changes = diffMonitoringSnapshots(previous, current, [
      DomainMonitoringRule.parse({ watch: "documents", intervalMinutes: 60, notifyOnChange: true }),
    ]);
    expect(changes).toEqual([
      expect.objectContaining({
        kind: "document_updated",
        previous: hashA,
        current: hashB,
      }),
    ]);
  });
});

function snapshot(
  overrides: Partial<Parameters<typeof MonitoringSnapshot.parse>[0]> = {},
) {
  return MonitoringSnapshot.parse({
    status: "accepting_bids",
    documents: [],
    fetchedAt: now,
    ...overrides,
  });
}
