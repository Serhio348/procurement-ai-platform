import { SpecialistProcurementCard } from "@procurement/contracts";
import { describe, expect, it } from "vitest";
import { bidsDeadlinePassed, deadlineWithin } from "./deadline.js";

const base = {
  id: "00000000-0000-4000-8000-000000000001",
  title: "Закупка",
  status: "under_review",
  statusLabel: "рассмотрение предложений",
  url: "https://goszakupki.by/auction/view/1",
  sourceProcurementId: "auction/1",
};

describe("bidsDeadlinePassed", () => {
  it("is not fooled by a live-looking source status once the published deadline is behind", () => {
    const card = SpecialistProcurementCard.parse({
      ...base,
      watchSnapshot: {
        capturedAt: "2026-09-01T00:00:00.000Z",
        status: "under_review",
        bidsDeadline: "2026-08-08",
      },
    });
    expect(bidsDeadlinePassed(card, new Date("2026-09-11T10:00:00+03:00"))).toBe(true);
  });

  it("keeps a date-only deadline open until the end of that day in the source time zone", () => {
    const card = SpecialistProcurementCard.parse({
      ...base,
      sourceCard: {
        sourceId: "goszakupki_by",
        sourceProcurementId: "auction/1",
        url: base.url,
        title: base.title,
        fetchedAt: "2026-09-01T00:00:00.000Z",
        bidsDeadline: { precision: "date", date: "2026-09-11", timeZone: "Europe/Minsk" },
      },
    });
    // 23:30 Minsk on the deadline day: still open.
    expect(bidsDeadlinePassed(card, new Date("2026-09-11T20:30:00.000Z"))).toBe(false);
    // 00:30 Minsk the next day (21:30 UTC): gone.
    expect(bidsDeadlinePassed(card, new Date("2026-09-11T21:30:00.000Z"))).toBe(true);
  });

  it("is false without any deadline: missing data is not an expiry", () => {
    expect(bidsDeadlinePassed(SpecialistProcurementCard.parse(base), new Date())).toBe(false);
  });
});

describe("deadlineWithin", () => {
  const DAY = 86_400_000;
  const card = (deadline: string) =>
    SpecialistProcurementCard.parse({
      ...base,
      sourceCard: {
        sourceId: "goszakupki_by",
        sourceProcurementId: "auction/1",
        url: base.url,
        title: base.title,
        fetchedAt: "2026-09-18T00:00:00.000Z",
        status: "accepting_bids",
        bidsDeadline: { precision: "date_time", at: deadline },
      },
    });

  it("is true while less than the window remains and false beyond it", () => {
    const now = new Date("2026-09-18T00:00:00.000Z");
    expect(deadlineWithin(card("2026-09-19T00:00:00.000Z"), now, 36 * 60 * 60 * 1000)).toBe(true);
    expect(deadlineWithin(card("2026-09-20T00:00:00.000Z"), now, 36 * 60 * 60 * 1000)).toBe(false);
  });

  it("is false once the deadline has passed: expiry is reported by crossing, not countdown", () => {
    expect(
      deadlineWithin(card("2026-09-17T00:00:00.000Z"), new Date("2026-09-18T00:00:00.000Z"), DAY),
    ).toBe(false);
  });

  it("counts a date-only deadline by the source calendar: tomorrow counts as soon", () => {
    const dated = SpecialistProcurementCard.parse({
      ...base,
      watchSnapshot: {
        capturedAt: "2026-09-18T00:00:00.000Z",
        status: "accepting_bids",
        bidsDeadline: "2026-09-19",
      },
    });
    const now = new Date("2026-09-18T08:00:00.000Z");
    expect(deadlineWithin(dated, now, 36 * 60 * 60 * 1000)).toBe(true);
    const later = SpecialistProcurementCard.parse({
      ...base,
      watchSnapshot: {
        capturedAt: "2026-09-18T00:00:00.000Z",
        status: "accepting_bids",
        bidsDeadline: "2026-09-21",
      },
    });
    expect(deadlineWithin(later, now, 36 * 60 * 60 * 1000)).toBe(false);
  });
});
