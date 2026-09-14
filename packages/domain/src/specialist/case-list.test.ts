import { SpecialistProcurementCard } from "@procurement/contracts";
import { describe, expect, it } from "vitest";
import { countCabinetCases, isConsoleListedCase, pageListedCases, slimListedCard } from "./case-list.js";

function card(input: {
  id: string;
  sourceProcurementId: string;
  title?: string;
  foundAs?: SpecialistProcurementCard["foundAs"];
  triage?: SpecialistProcurementCard["triage"];
  archived?: boolean;
  live?: boolean;
}): SpecialistProcurementCard {
  return SpecialistProcurementCard.parse({
    title: input.title ?? input.sourceProcurementId,
    status: "unknown",
    statusLabel: "неизвестен",
    url: `https://goszakupki.by/${input.sourceProcurementId}`,
    ...input,
  });
}

describe("pageListedCases", () => {
  const match = card({
    id: "00000000-0000-4000-8000-000000000001",
    sourceProcurementId: "auction/1",
    foundAs: "match",
    live: true,
  });
  const watching = card({
    id: "00000000-0000-4000-8000-000000000002",
    sourceProcurementId: "auction/2",
    foundAs: "match",
    triage: "monitor",
    live: true,
  });
  const archived = card({
    id: "00000000-0000-4000-8000-000000000003",
    sourceProcurementId: "auction/3",
    foundAs: "match",
    triage: "participate",
    archived: true,
    live: true,
  });
  const review = card({
    id: "00000000-0000-4000-8000-000000000004",
    sourceProcurementId: "auction/4",
    foundAs: "review",
    live: true,
  });

  it("keeps review cases out of the console list until a specialist takes them", () => {
    expect(isConsoleListedCase(review)).toBe(false);
    expect(pageListedCases([match, review]).items.map((item) => item.id)).toEqual([match.id]);
  });

  it("pages My procurements without returning the whole catalog", () => {
    const page = pageListedCases([match, watching, archived], { tab: "all", limit: 10 });
    expect(page.total).toBe(1);
    expect(page.items.map((item) => item.id)).toEqual([watching.id]);
  });

  it("keeps rejected cases out of the archive tab", () => {
    const trashed = card({
      id: "00000000-0000-4000-8000-000000000006",
      sourceProcurementId: "auction/6",
      foundAs: "match",
      triage: "reject",
      archived: true,
      live: true,
    });
    expect(pageListedCases([archived, trashed], { tab: "archive" }).items.map((item) => item.id)).toEqual([
      archived.id,
    ]);
  });

  it("lists rejected cases only on the trash tab, even when search would skip them", () => {
    const trashed = card({
      id: "00000000-0000-4000-8000-000000000005",
      sourceProcurementId: "auction/5",
      foundAs: "match",
      triage: "reject",
      live: true,
    });
    const skipped = new Set(["auction/5"]);
    expect(
      pageListedCases([watching, trashed], { tab: "all", rejectedSourceIds: skipped }).items.map(
        (item) => item.id,
      ),
    ).toEqual([watching.id]);
    expect(
      pageListedCases([watching, trashed], { tab: "trash", rejectedSourceIds: skipped }).items.map(
        (item) => item.id,
      ),
    ).toEqual([trashed.id]);
  });

  it("strips extracts and files from a list row so trash cannot pull the whole case", () => {
    const fat = SpecialistProcurementCard.parse({
      ...watching,
      extractPreview: "полный текст ТЗ ".repeat(80),
      reportMarkdown: "# отчёт",
      documents: [
        {
          name: "ТЗ.pdf",
          sourceUrl: "https://goszakupki.by/files/tz.pdf",
          status: "hashed",
        },
      ],
    });
    const slim = slimListedCard(fat);
    expect(slim.documents).toEqual([]);
    expect(slim.extractPreview).toBeUndefined();
    expect(slim.reportMarkdown).toBeUndefined();
    expect(slim.title).toBe(watching.title);
  });

  it("counts mine, archive and trash without mixing tabs", () => {
    const trashed = card({
      id: "00000000-0000-4000-8000-000000000007",
      sourceProcurementId: "auction/7",
      triage: "reject",
      archived: true,
    });
    expect(countCabinetCases([match, watching, archived, trashed])).toEqual({
      mineCount: 1,
      archiveCount: 1,
      trashCount: 1,
    });
  });
});
