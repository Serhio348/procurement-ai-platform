import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SearchQuery, SourceProcurementId } from "@procurement/contracts";
import { ButbSource } from "./butb-source.js";
import type { ButbPage, ButbPageClient } from "./butb-http.js";
import { parseButbRegistryRows } from "./butb-parser.js";

const registryHtml = readFileSync(
  fileURLToPath(new URL("../test/fixtures/butb/registry.html", import.meta.url)),
  "utf8",
);
const cardHtml = readFileSync(
  fileURLToPath(new URL("../test/fixtures/butb/card.html", import.meta.url)),
  "utf8",
);

function page(body: string, url = "https://zakupki.butb.by/auctions/reestrauctions.html"): ButbPage {
  return { status: 200, url, body };
}

function fakeClient(pages: Map<number, string>, card = cardHtml): ButbPageClient & {
  calls: { pages: number[]; links: string[] };
} {
  const calls = { pages: [] as number[], links: [] as string[] };
  return {
    calls,
    async registryPage(p) {
      calls.pages.push(p);
      const body = pages.get(p);
      return body === undefined
        ? page("<table></table>")
        : page(body);
    },
    async openCard(linkId) {
      calls.links.push(linkId);
      return { status: 200, url: "https://zakupki.butb.by/auctions/viewinvitation.html", body: card };
    },
    async download() {
      return { status: 200, url: "", bytes: new Uint8Array([1, 2, 3]) };
    },
    withSession: (fn) => fn(),
  };
}

function query(partial: Partial<SearchQuery>): SearchQuery {
  return SearchQuery.parse({ sourceId: "butb", ...partial });
}

const firstRow = parseButbRegistryRows(registryHtml)[0]!;

describe("ButbSource.search", () => {
  it("returns rows matching a keyword with matchedSearchTerms", async () => {
    const client = fakeClient(new Map([[1, registryHtml], [2, "<table></table>"]]));
    const source = new ButbSource({ client });
    const answer = await source.search(
      query({ keywords: [firstRow.title.split(" ")[0]!], publishedFrom: "1900-01-01T00:00:00Z", limit: 10 }),
    );
    expect(answer.hits.length).toBeGreaterThan(0);
    const hit = answer.hits[0]!;
    expect(hit.sourceId).toBe("butb");
    expect(hit.sourceProcurementId).toBe(`butb/${firstRow.registryNumber}`);
    expect(hit.matchedSearchTerms).toEqual([firstRow.title.split(" ")[0]!]);
  });

  it("stops scanning when a page falls behind the publishedFrom watermark", async () => {
    // Watermark after every fixture row → the first page already answers.
    const client = fakeClient(new Map([[1, registryHtml]]));
    const source = new ButbSource({ client });
    const answer = await source.search(
      query({ keywords: ["инструментарий"], publishedFrom: "2026-10-16T00:00:00Z", limit: 10 }),
    );
    expect(answer.hits).toEqual([]);
    expect(answer.hasMore).toBe(false);
    expect(client.calls.pages).toEqual([1]);
  });

  it("excludes rows whose title contains an excluded term", async () => {
    const client = fakeClient(new Map([[1, registryHtml], [2, "<table></table>"]]));
    const source = new ButbSource({ client });
    const answer = await source.search(
      query({
        keywords: [],
        excludeKeywords: ["инструментарий", "ворот"],
        publishedFrom: "1900-01-01T00:00:00Z",
        limit: 50,
      }),
    );
    for (const hit of answer.hits) {
      expect(hit.title).not.toMatch(/инструментарий|ворот/i);
    }
  });

  it("honours the local status filter", async () => {
    const client = fakeClient(new Map([[1, registryHtml], [2, "<table></table>"]]));
    const source = new ButbSource({ client });
    const answer = await source.search(
      query({ keywords: [], statuses: ["accepting_bids"], publishedFrom: "1900-01-01T00:00:00Z", limit: 50 }),
    );
    for (const hit of answer.hits) {
      expect(hit.status).toBe("accepting_bids");
    }
  });

  it("caps page reads", async () => {
    const pages = new Map<number, string>();
    for (let p = 1; p <= 40; p += 1) pages.set(p, registryHtml);
    const client = fakeClient(pages);
    const source = new ButbSource({ client, maxSearchPages: 5 });
    const answer = await source.search(
      query({ keywords: ["неттакогослова"], publishedFrom: "1900-01-01T00:00:00Z", limit: 500 }),
    );
    expect(client.calls.pages.length).toBe(5);
    expect(answer.hasMore).toBe(true);
  });

  it("stops at the wall-clock budget instead of outliving the tool timeout", async () => {
    // Pages exist forever; each read costs 30 s of clock — the 60 s budget
    // must cut the scan after two pages and honestly report hasMore.
    let tick = new Date("2026-10-16T00:00:00Z").getTime();
    const client = fakeClient(
      new Map(Array.from({ length: 40 }, (_, i) => [i + 1, registryHtml])),
    );
    const timed: ButbPageClient & { calls: typeof client.calls } = {
      calls: client.calls,
      registryPage: async (p) => {
        tick += 30_000;
        return client.registryPage(p);
      },
      openCard: client.openCard,
      download: client.download,
      withSession: client.withSession,
    };
    const source = new ButbSource({
      client: timed,
      maxSearchPages: 40,
      maxSearchMs: 60_000,
      now: () => new Date(tick),
    });
    const answer = await source.search(
      query({ keywords: ["неттакогослова"], publishedFrom: "1900-01-01T00:00:00Z", limit: 500 }),
    );
    expect(client.calls.pages.length).toBe(2);
    expect(answer.hasMore).toBe(true);
  });
});

describe("ButbSource.get", () => {
  it("finds the row on page 1 and opens the card via its link id", async () => {
    const client = fakeClient(new Map([[1, registryHtml]]));
    const source = new ButbSource({ client });
    const card = await source.get(
      SourceProcurementId.parse(`butb/${firstRow.registryNumber}`),
    );
    expect(card.sourceProcurementId).toBe(`butb/${firstRow.registryNumber}`);
    expect(client.calls.links).toEqual([firstRow.cardLinkId]);
    expect(card.lots.length).toBe(6);
  });

  it("probes deeper pages exponentially for an older card", async () => {
    const pages = new Map<number, string>([
      [1, registryHtml],
      [2, syntheticPage(20, "10.10.2026")],
      [4, syntheticPage(60, "01.10.2026", "AU20261001999001")],
    ]);
    const client = fakeClient(pages);
    const source = new ButbSource({ client });
    const card = await source.get(SourceProcurementId.parse("butb/AU20261001999001"));
    expect(client.calls.pages).toEqual([1, 2, 4]);
    expect(client.calls.links).toEqual(["fra:reestrAu:60:_t344"]);
    expect(card.sourceProcurementId).toBe("butb/AU20261001999001");
  });

  it("starts the second lookup next to the remembered row position", async () => {
    const pages = new Map<number, string>([
      [1, registryHtml],
      [3, syntheticPage(42, "01.10.2026", "AU20261001999001")],
    ]);
    const client = fakeClient(pages);
    let now = Date.parse("2026-10-20T00:00:00Z");
    const source = new ButbSource({ client, cardCacheTtlMs: 1_000, now: () => new Date(now) });
    const id = SourceProcurementId.parse("butb/AU20261001999001");

    await source.get(id);
    expect(client.calls.pages).toContain(3);
    client.calls.pages = [];
    client.calls.links = [];

    now += 60_000; // past the card cache — the card is re-read, but…
    await source.get(id);
    // …the row position is remembered: page 3 answered directly, no page 1.
    expect(client.calls.pages).toEqual([3]);
    expect(client.calls.links).toEqual(["fra:reestrAu:42:_t344"]);
  });

  it("seeds the row position from a search scan", async () => {
    const pages = new Map<number, string>([
      [1, registryHtml],
      [2, syntheticPage(20, "10.10.2026")],
    ]);
    const client = fakeClient(pages);
    const source = new ButbSource({ client });

    await source.search(
      query({ keywords: [], publishedFrom: "1900-01-01T00:00:00Z", limit: 50 }),
    );
    client.calls.pages = [];

    const card = await source.get(
      SourceProcurementId.parse(`butb/${firstRow.registryNumber}`),
    );
    expect(card.sourceProcurementId).toBe(`butb/${firstRow.registryNumber}`);
    // Hint from the scan pointed at page 1 — no probing needed.
    expect(client.calls.pages).toEqual([1]);
  });

  it("answers not-found for an id the registry no longer lists", async () => {
    const client = fakeClient(new Map([[1, registryHtml]]));
    const source = new ButbSource({ client });
    await expect(
      source.get(SourceProcurementId.parse("butb/AU20200101000000")),
    ).rejects.toMatchObject({ name: "SourceRecordNotFoundError" });
  });

  it("rejects ids outside the butb namespace", async () => {
    const client = fakeClient(new Map([[1, registryHtml]]));
    const source = new ButbSource({ client });
    await expect(
      source.get(SourceProcurementId.parse("auction/123")),
    ).rejects.toMatchObject({ name: "SourceRecordNotFoundError" });
  });
});

/** A synthetic registry page: one row with the given date/reg number. */
function syntheticPage(rowIndex: number, date: string, regNo = "AU20261010396700"): string {
  return `<table><tbody><tr id="fra:reestrAu_row_${rowIndex}"><td><span>${regNo}</span></td>` +
    `<td><a href="#" id="fra:reestrAu:${rowIndex}:_t344" onclick="mojarra.jsfcljs()">Инструментарий</a></td>` +
    `<td>аукцион</td><td>${date}</td><td>1 710 704,01 BYN</td><td>Заказчик</td>` +
    `<td>Госзакупка</td><td>30.10.2026</td><td></td><td>Подача предложений / документов</td><td></td></tr></tbody></table>`;
}
