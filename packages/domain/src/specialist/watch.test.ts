import { describe, expect, it } from "vitest";
import { ProcedureCard, SpecialistProcurementCard } from "@procurement/contracts";
import {
  cardSnapshot,
  diffCardSnapshots,
  inboxItemFromWatchChange,
  isWatchedTriage,
  mergeDocumentProbes,
  nextDocumentProbeTarget,
  normalizePriceKey,
  withWatchSnapshot,
} from "./watch.js";

function sourceCard(input: {
  status?: "accepting_bids" | "completed" | "cancelled";
  raw?: string;
  amount?: number;
  bidsDeadline?: unknown;
  listedDocuments?: Array<{
    name: string;
    sourceUrl: string;
    contentHash?: string;
    checkedAt?: string;
  }>;
}) {
  return ProcedureCard.parse({
    sourceId: "goszakupki_by",
    sourceProcurementId: "auction/100",
    url: "https://goszakupki.by/auction/view/auction-100",
    title: "Поставка НКУ-0,4",
    fetchedAt: "2026-09-10T00:00:00.000Z",
    status: input.status ?? "accepting_bids",
    ...(input.raw !== undefined
      ? { amount: { kind: "limit", amount: null, raw: input.raw } }
      : input.amount !== undefined
        ? { amount: { kind: "limit", amount: input.amount, raw: `${String(input.amount)} BYN` } }
        : {}),
    ...(input.bidsDeadline === undefined ? {} : { bidsDeadline: input.bidsDeadline }),
    ...(input.listedDocuments === undefined ? {} : { listedDocuments: input.listedDocuments }),
  });
}

function consoleCard(triage?: "monitor" | "participate" | "reject") {
  return SpecialistProcurementCard.parse({
    id: "0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f",
    title: "Поставка НКУ-0,4",
    status: "accepting_bids",
    statusLabel: "приём предложений",
    url: "https://goszakupki.by/auction/view/auction-100",
    sourceProcurementId: "auction/100",
    live: true,
    ...(triage === undefined ? {} : { triage }),
  });
}

describe("normalizePriceKey", () => {
  it("reads the same sum through different printings", () => {
    expect(normalizePriceKey("1 234,56 руб.")).toBe("1234.56");
    expect(normalizePriceKey("1 234.56 BYN")).toBe("1234.56");
    expect(normalizePriceKey("1 234,00")).toBe("1234");
    expect(normalizePriceKey("1.234.567,89")).toBe("1234567.89");
    expect(normalizePriceKey("  12 345  ")).toBe("12345");
  });

  it("stays silent when there is no figure at all", () => {
    expect(normalizePriceKey(undefined)).toBeUndefined();
    expect(normalizePriceKey("")).toBeUndefined();
    expect(normalizePriceKey("цена по запросу")).toBeUndefined();
  });
});

describe("cardSnapshot", () => {
  it("keeps the printed label next to the normalized key", () => {
    const snapshot = cardSnapshot(
      sourceCard({ status: "accepting_bids", raw: "1 000,50 BYN", bidsDeadline: { precision: "date", date: "2026-09-20", timeZone: "Europe/Minsk" } }),
      "2026-09-10T00:00:00.000Z",
    );
    expect(snapshot.status).toBe("accepting_bids");
    expect(snapshot.priceLabel).toBe("1 000,50 BYN");
    expect(snapshot.priceKey).toBe("1000.5");
    expect(snapshot.bidsDeadline).toBe("2026-09-20");
  });
});

describe("diffCardSnapshots", () => {
  it("does not fire when only the price formatting moved", () => {
    const previous = cardSnapshot(sourceCard({ raw: "1 000,00 BYN" }), "2026-09-10T00:00:00.000Z");
    const current = cardSnapshot(sourceCard({ raw: "1 000.00 BYN" }), "2026-09-11T00:00:00.000Z");
    expect(diffCardSnapshots(previous, current)).toEqual([]);
  });

  it("fires on a real price change and keeps both wordings", () => {
    const previous = cardSnapshot(sourceCard({ raw: "1 000,00 BYN" }), "2026-09-10T00:00:00.000Z");
    const current = cardSnapshot(sourceCard({ raw: "1 050,00 BYN" }), "2026-09-11T00:00:00.000Z");
    const changes = diffCardSnapshots(previous, current);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({
      kind: "price_changed",
      field: "price",
      previous: "1 000,00 BYN",
      current: "1 050,00 BYN",
      dedupeKey: "2026-09-11T00:00:00.000Z",
    });
  });

  it("fires on status and deadline changes", () => {
    const previous = cardSnapshot(
      sourceCard({
        status: "accepting_bids",
        bidsDeadline: { precision: "date", date: "2026-09-20", timeZone: "Europe/Minsk" },
      }),
      "2026-09-10T00:00:00.000Z",
    );
    const current = cardSnapshot(
      sourceCard({
        status: "cancelled",
        bidsDeadline: { precision: "date", date: "2026-09-25", timeZone: "Europe/Minsk" },
      }),
      "2026-09-11T00:00:00.000Z",
    );
    const kinds = diffCardSnapshots(previous, current).map((item) => item.kind);
    expect(kinds).toContain("status_changed");
    expect(kinds).toContain("deadline_changed");
  });

  it("fires when a file appears or vanishes and ignores a reshuffle", () => {
    const tz = (files: Array<{ name: string; sourceUrl: string }>) =>
      cardSnapshot(
        sourceCard({
          listedDocuments: files,
        }),
        "2026-09-10T00:00:00.000Z",
      );
    const one = tz([{ name: "ТЗ.pdf", sourceUrl: "https://goszakupki.by/files/1" }]);
    const two = tz([
      { name: "Изменения.pdf", sourceUrl: "https://goszakupki.by/files/2" },
      { name: "ТЗ.pdf", sourceUrl: "https://goszakupki.by/files/1" },
    ]);
    const reshuffled = tz([
      { name: "Изменения.pdf", sourceUrl: "https://goszakupki.by/files/2" },
      { name: "ТЗ.pdf", sourceUrl: "https://goszakupki.by/files/1" },
    ]);
    const added = diffCardSnapshots(one, two);
    expect(added.map((item) => item.kind)).toEqual(["document_added"]);
    expect(added[0]?.current).toBe("Изменения.pdf");
    expect(diffCardSnapshots(two, reshuffled)).toEqual([]);
    expect(diffCardSnapshots(two, one).map((item) => item.kind)).toEqual(["document_removed"]);
  });

  it("does not treat a snapshot taken before document watch as an empty list", () => {
    const previous = cardSnapshot(sourceCard({}), "2026-09-10T00:00:00.000Z");
    const withoutDocs = { ...previous };
    delete withoutDocs.documents;
    const current = cardSnapshot(
      sourceCard({
        listedDocuments: [{ name: "ТЗ.pdf", sourceUrl: "https://goszakupki.by/files/1" }],
      }),
      "2026-09-11T00:00:00.000Z",
    );
    expect(diffCardSnapshots(withoutDocs, current)).toEqual([]);
  });

  it("ignores a field that simply disappeared from the page", () => {
    const previous = cardSnapshot(sourceCard({ raw: "1 000,00 BYN" }), "2026-09-10T00:00:00.000Z");
    const current = cardSnapshot(sourceCard({}), "2026-09-11T00:00:00.000Z");
    expect(diffCardSnapshots(previous, current)).toEqual([]);
  });
});

describe("watch inbox item and card snapshot", () => {
  it("reports a change once and stores the fresh snapshot on the case", () => {
    const card = withWatchSnapshot(
      consoleCard("monitor"),
      cardSnapshot(sourceCard({ raw: "1 000,00 BYN" }), "2026-09-10T00:00:00.000Z"),
    );
    expect(card.watchSnapshot?.priceKey).toBe("1000");

    const item = inboxItemFromWatchChange(
      card,
      { kind: "status_changed", field: "status", previous: "приём предложений", current: "отменена" },
      "2026-09-11T00:00:00.000Z",
    );
    expect(item.change.kind).toBe("status_changed");
    expect(item.change.urgent).toBe(true);
    expect(item.procurement.sourceProcurementId).toBe("auction/100");
  });

  it("gives a repeated change to an earlier value a new event id", () => {
    const card = consoleCard("monitor");
    const at = (iso: string, raw: string) =>
      cardSnapshot(sourceCard({ raw }), iso);
    // 100 → 90 → 100 → 90: each occurrence is a different apply, so each is
    // its own event; replaying one apply stays a duplicate (R23).
    const first = inboxItemFromWatchChange(
      card,
      diffCardSnapshots(at("2026-09-10T00:00:00.000Z", "1 000,00 BYN"), at("2026-09-11T00:00:00.000Z", "900,00 BYN"))[0]!,
      "2026-09-11T00:00:00.000Z",
    );
    const back = inboxItemFromWatchChange(
      card,
      diffCardSnapshots(at("2026-09-11T00:00:00.000Z", "900,00 BYN"), at("2026-09-12T00:00:00.000Z", "1 000,00 BYN"))[0]!,
      "2026-09-12T00:00:00.000Z",
    );
    const repeated = inboxItemFromWatchChange(
      card,
      diffCardSnapshots(at("2026-09-12T00:00:00.000Z", "1 000,00 BYN"), at("2026-09-13T00:00:00.000Z", "900,00 BYN"))[0]!,
      "2026-09-13T00:00:00.000Z",
    );
    expect(first.change.id).not.toBe(repeated.change.id);
    expect(back.change.id).not.toBe(first.change.id);
    const replay = inboxItemFromWatchChange(
      card,
      diffCardSnapshots(at("2026-09-10T00:00:00.000Z", "1 000,00 BYN"), at("2026-09-11T00:00:00.000Z", "900,00 BYN"))[0]!,
      "2026-09-11T00:00:00.000Z",
    );
    expect(replay.change.id).toBe(first.change.id);
  });

  it("does not merge two added files that only share a name", () => {
    const card = consoleCard("monitor");
    const previous = cardSnapshot(sourceCard({}), "2026-09-10T00:00:00.000Z");
    const current = cardSnapshot(
      sourceCard({
        listedDocuments: [
          { name: "ТЗ.pdf", sourceUrl: "https://goszakupki.by/files/1" },
          { name: "ТЗ.pdf", sourceUrl: "https://goszakupki.by/files/2" },
        ],
      }),
      "2026-09-11T00:00:00.000Z",
    );
    const ids = diffCardSnapshots(previous, current).map(
      (change) => inboxItemFromWatchChange(card, change, "2026-09-11T00:00:00.000Z").change.id,
    );
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("only monitor and participate keep being read", () => {
    expect(isWatchedTriage(consoleCard("monitor"))).toBe(true);
    expect(isWatchedTriage(consoleCard("participate"))).toBe(true);
    expect(isWatchedTriage(consoleCard("reject"))).toBe(false);
    expect(isWatchedTriage(consoleCard())).toBe(false);
  });
});

describe("document content probes (R24)", () => {
  const HASH_A = "a".repeat(64);
  const HASH_B = "b".repeat(64);
  const URL_TZ = "https://goszakupki.by/files/tz";

  it("reports a file replaced under an unchanged name and URL", () => {
    const previous = cardSnapshot(
      sourceCard({
        listedDocuments: [
          { name: "ТЗ.pdf", sourceUrl: URL_TZ, contentHash: HASH_A },
        ],
      }),
      "2026-09-10T00:00:00.000Z",
    );
    const current = cardSnapshot(
      sourceCard({
        listedDocuments: [
          { name: "ТЗ.pdf", sourceUrl: URL_TZ, contentHash: HASH_B },
        ],
      }),
      "2026-09-11T00:00:00.000Z",
    );

    const changes = diffCardSnapshots(previous, current);

    expect(changes).toEqual([
      {
        kind: "document_updated",
        field: "documents",
        previous: "ТЗ.pdf",
        current: "ТЗ.pdf (обновлено содержимое)",
        dedupeKey: `2026-09-11T00:00:00.000Z:${URL_TZ}`,
      },
    ]);
  });

  it("stays silent while the probed hash matches the baseline", () => {
    const snap = (at: string) =>
      cardSnapshot(
        sourceCard({
          listedDocuments: [
            { name: "ТЗ.pdf", sourceUrl: URL_TZ, contentHash: HASH_A },
          ],
        }),
        at,
      );
    expect(
      diffCardSnapshots(
        snap("2026-09-10T00:00:00.000Z"),
        snap("2026-09-11T00:00:00.000Z"),
      ),
    ).toEqual([]);
  });

  it("carries probe baselines across re-listings and lets fresh stamps win", () => {
    const previous = [
      { name: "ТЗ.pdf", sourceUrl: URL_TZ, contentHash: HASH_A, checkedAt: "2026-09-10T00:00:00.000Z" },
    ];
    const carried = mergeDocumentProbes(previous, [
      { name: "ТЗ.pdf", sourceUrl: URL_TZ },
      { name: "Смета.pdf", sourceUrl: "https://goszakupki.by/files/sm" },
    ]);
    expect(carried[0]?.contentHash).toBe(HASH_A);
    expect(carried[0]?.checkedAt).toBe("2026-09-10T00:00:00.000Z");
    expect(carried[1]?.contentHash).toBeUndefined();

    const stamped = mergeDocumentProbes(previous, [
      {
        name: "ТЗ.pdf",
        sourceUrl: URL_TZ,
        contentHash: HASH_B,
        checkedAt: "2026-09-11T00:00:00.000Z",
      },
    ]);
    expect(stamped[0]?.contentHash).toBe(HASH_B);
    expect(stamped[0]?.checkedAt).toBe("2026-09-11T00:00:00.000Z");
  });

  it("probes the never-checked document first, then the stalest", () => {
    const urlB = "https://goszakupki.by/files/b";
    const current = [
      { name: "А.pdf", sourceUrl: URL_TZ },
      { name: "Б.pdf", sourceUrl: urlB },
    ];
    expect(nextDocumentProbeTarget(undefined, current)?.sourceUrl).toBe(urlB);

    const previous = [
      { name: "А.pdf", sourceUrl: URL_TZ, checkedAt: "2026-09-10T00:00:00.000Z" },
    ];
    expect(nextDocumentProbeTarget(previous, current)?.sourceUrl).toBe(urlB);

    const bothChecked = [
      { name: "А.pdf", sourceUrl: URL_TZ, checkedAt: "2026-09-12T00:00:00.000Z" },
      { name: "Б.pdf", sourceUrl: urlB, checkedAt: "2026-09-10T00:00:00.000Z" },
    ];
    expect(nextDocumentProbeTarget(bothChecked, current)?.sourceUrl).toBe(urlB);
  });
});
