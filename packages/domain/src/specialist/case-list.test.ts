import { SpecialistProcurementCard } from "@procurement/contracts";
import { describe, expect, it } from "vitest";
import {
  compareSearchQueueNewestFirst,
  countCabinetCases,
  isConsoleListedCase,
  pageListedCases,
  slimListedCard,
} from "./case-list.js";

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

  it("lists a hidden case in the trash and keeps it out of my procurements", () => {
    const hidden = card({
      id: "00000000-0000-4000-8000-000000000008",
      sourceProcurementId: "auction/8",
      triage: "hide",
      live: true,
    });
    expect(pageListedCases([match, watching, hidden], { tab: "trash" }).items.map((item) => item.id)).toEqual([
      hidden.id,
    ]);
    expect(pageListedCases([match, watching, hidden], { tab: "all" }).items.map((item) => item.id)).toEqual([
      watching.id,
    ]);
    expect(countCabinetCases([match, watching, hidden])).toEqual({
      mineCount: 1,
      archiveCount: 0,
      trashCount: 1,
    });
  });

  it("orders the search queue by posting date, newest first", () => {
    const older = SpecialistProcurementCard.parse({
      ...card({
        id: "00000000-0000-4000-8000-000000000011",
        sourceProcurementId: "auction/old",
        foundAs: "match",
        live: true,
      }),
      sourceCard: {
        sourceId: "goszakupki_by",
        sourceProcurementId: "auction/old",
        url: "https://goszakupki.by/auction/old",
        title: "старая",
        fetchedAt: "2026-10-10T16:00:00.000Z",
        publishedAt: { precision: "date", date: "2026-10-01", timeZone: "Europe/Minsk" },
      },
    });
    const newer = SpecialistProcurementCard.parse({
      ...card({
        id: "00000000-0000-4000-8000-000000000012",
        sourceProcurementId: "auction/new",
        foundAs: "match",
        live: true,
      }),
      sourceCard: {
        sourceId: "goszakupki_by",
        sourceProcurementId: "auction/new",
        url: "https://goszakupki.by/auction/new",
        title: "свежая",
        fetchedAt: "2026-10-09T16:00:00.000Z",
        publishedAt: { precision: "date", date: "2026-10-10", timeZone: "Europe/Minsk" },
      },
    });
    const processedOnly = SpecialistProcurementCard.parse({
      ...card({
        id: "00000000-0000-4000-8000-000000000013",
        sourceProcurementId: "auction/processed",
        foundAs: "match",
        live: true,
      }),
      sourceCard: {
        sourceId: "goszakupki_by",
        sourceProcurementId: "auction/processed",
        url: "https://goszakupki.by/auction/processed",
        title: "без даты размещения",
        fetchedAt: "2026-10-08T16:00:00.000Z",
      },
    });
    const ordered = [older, processedOnly, newer].sort(compareSearchQueueNewestFirst);
    expect(ordered.map((item) => item.sourceProcurementId)).toEqual([
      "auction/new",
      "auction/processed",
      "auction/old",
    ]);
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
