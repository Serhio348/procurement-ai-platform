import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SearchQuery, SourceProcurementId } from "@procurement/contracts";
import { ButbSource } from "./butb-source.js";
import {
  ButbViewExpiredError,
  type ButbPage,
  type ButbPageClient,
  type ButbSearchCriteria,
} from "./butb-http.js";
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

  it("refuses a page the paginator says has records but parses to no rows", async () => {
    // Degraded table markup must surface as a source failure — a silent
    // empty page would tell the caller the registry tail was read.
    const degraded =
      `<div><script>var w = {"paginator":new YAHOO.widget.Paginator({"rowsPerPage":20,"totalRecords":500})};</script></div>`;
    const client = fakeClient(new Map([[1, degraded]]));
    const source = new ButbSource({ client });
    await expect(
      source.search(
        query({ keywords: [], publishedFrom: "1900-01-01T00:00:00Z", limit: 50 }),
      ),
    ).rejects.toMatchObject({ name: "SourceAccessError" });
  });

  it("refuses a non-final page that parses fewer rows than a page holds", async () => {
    const partial =
      syntheticPage(0, "15.10.2026") +
      `<script>var w = {"paginator":new YAHOO.widget.Paginator({"rowsPerPage":20,"totalRecords":500})};</script>`;
    const client = fakeClient(new Map([[1, partial]]));
    const source = new ButbSource({ client });
    await expect(
      source.search(
        query({ keywords: [], publishedFrom: "1900-01-01T00:00:00Z", limit: 50 }),
      ),
    ).rejects.toMatchObject({ name: "SourceAccessError" });
  });

  it("treats a genuinely empty page past the advertised end as the tail", async () => {
    const client = fakeClient(
      new Map([[1, registryHtml], [2, "<table></table>"]]),
    );
    const source = new ButbSource({ client });
    const answer = await source.search(
      query({ keywords: [], publishedFrom: "1900-01-01T00:00:00Z", limit: 50 }),
    );
    expect(answer.hasMore).toBe(false);
  });

  it("hands back a resume cursor on truncation and a fresh instance reaches the tail", async () => {
    // The regression this guards: a scan bounded to two pages used to emit
    // no position at all — the next pass re-read the same head forever and
    // the rows below the budget were never seen. The cursor must survive in
    // the token alone: the resuming call runs on a NEW source instance.
    const pages = new Map<number, string>([
      [1, syntheticPage(0, "20.10.2026", "AU20261020000001")],
      [2, syntheticPage(20, "18.10.2026", "AU20261018000002")],
      [3, syntheticPage(40, "17.10.2026", "AU20261017000003")],
      [4, syntheticPage(60, "15.10.2026", "AU20261015000005")],
    ]);
    const client = fakeClient(pages);
    const shallow = new ButbSource({ client, maxSearchPages: 2 });
    const first = await shallow.search(
      query({ keywords: ["инструментарий"], publishedFrom: "1900-01-01T00:00:00Z", limit: 500 }),
    );
    expect(first.hasMore).toBe(true);
    expect(first.scanCursor).toBeDefined();
    expect(first.hits.map((hit) => hit.sourceProcurementId)).not.toContain(
      "butb/AU20261015000005",
    );

    const resumed = new ButbSource({ client });
    const second = await resumed.search(
      query({
        keywords: ["инструментарий"],
        publishedFrom: "1900-01-01T00:00:00Z",
        limit: 500,
        scanCursor: first.scanCursor,
      }),
    );
    const ids = second.hits.map((hit) => hit.sourceProcurementId);
    expect(ids).toContain("butb/AU20261015000005");
    expect(second.hasMore).toBe(false);
    expect(second.scanCursor).toBeUndefined();
  });

  it("picks up posts newer than the cursor before continuing the tail", async () => {
    const pages = new Map<number, string>([
      [1, syntheticPage(0, "20.10.2026", "AU20261020000001")],
      [2, syntheticPage(20, "18.10.2026", "AU20261018000002")],
      [3, syntheticPage(40, "17.10.2026", "AU20261017000003")],
    ]);
    const client = fakeClient(pages);
    const shallow = new ButbSource({ client, maxSearchPages: 2 });
    const first = await shallow.search(
      query({ keywords: ["инструментарий"], publishedFrom: "1900-01-01T00:00:00Z", limit: 500 }),
    );
    expect(first.scanCursor).toBeDefined();

    // Between passes a new procedure was posted at the head — the cursor
    // row shifted a page deeper. Resuming straight at the tail would miss
    // the new post; the head phase must collect it first.
    pages.set(1, syntheticPage(0, "22.10.2026", "AU20261022000009"));
    pages.set(2, syntheticPage(20, "20.10.2026", "AU20261020000001"));
    pages.set(3, syntheticPage(40, "18.10.2026", "AU20261018000002"));
    pages.set(4, syntheticPage(60, "17.10.2026", "AU20261017000003"));
    const resumed = new ButbSource({ client });
    const second = await resumed.search(
      query({
        keywords: ["инструментарий"],
        publishedFrom: "1900-01-01T00:00:00Z",
        limit: 500,
        scanCursor: first.scanCursor,
      }),
    );
    const ids = second.hits.map((hit) => hit.sourceProcurementId);
    expect(ids).toContain("butb/AU20261022000009");
    expect(ids).toContain("butb/AU20261017000003");
    expect(second.hasMore).toBe(false);
  });

  it("falls back to the cursor date band when the cursor row left the registry", async () => {
    const pages = new Map<number, string>([
      [1, syntheticPage(0, "20.10.2026", "AU20261020000001")],
      [2, syntheticPage(20, "18.10.2026", "AU20261018000002")],
      [3, syntheticPage(40, "15.10.2026", "AU20261015000005")],
    ]);
    const client = fakeClient(pages);
    const shallow = new ButbSource({ client, maxSearchPages: 2 });
    const first = await shallow.search(
      query({ keywords: ["инструментарий"], publishedFrom: "1900-01-01T00:00:00Z", limit: 500 }),
    );
    expect(first.scanCursor).toBeDefined();

    // The cursor row was withdrawn — no page carries its registry number.
    // The first row older than its date band still marks the tail.
    pages.delete(2);
    const shifted = new Map<number, string>([
      [1, pages.get(1)!],
      [2, syntheticPage(20, "17.10.2026", "AU20261017000003")],
      [3, pages.get(3)!],
    ]);
    const resumed = new ButbSource({ client: fakeClient(shifted) });
    const second = await resumed.search(
      query({
        keywords: ["инструментарий"],
        publishedFrom: "1900-01-01T00:00:00Z",
        limit: 500,
        scanCursor: first.scanCursor,
      }),
    );
    const ids = second.hits.map((hit) => hit.sourceProcurementId);
    expect(ids).toContain("butb/AU20261017000003");
    expect(ids).toContain("butb/AU20261015000005");
    expect(second.hasMore).toBe(false);
  });

  it("returns the tail window when the request still carries the old offset", async () => {
    // «Загрузить ещё» sends offset=400 for page two — but a resumed scan's
    // candidates only cover the unread tail. Slicing them by that offset
    // would return an empty page and mark the window read: the cursor is
    // the position, the offset must rebase to the resumed window.
    const pages = new Map<number, string>([
      [1, syntheticPage(0, "20.10.2026", "AU20261020000001")],
      [2, syntheticPage(20, "18.10.2026", "AU20261018000002")],
      [3, syntheticPage(40, "17.10.2026", "AU20261017000003")],
    ]);
    const client = fakeClient(pages);
    const shallow = new ButbSource({ client, maxSearchPages: 1 });
    const first = await shallow.search(
      query({ keywords: ["инструментарий"], publishedFrom: "1900-01-01T00:00:00Z", limit: 400 }),
    );
    expect(first.scanCursor).toBeDefined();

    const resumed = new ButbSource({ client });
    const second = await resumed.search(
      query({
        keywords: ["инструментарий"],
        publishedFrom: "1900-01-01T00:00:00Z",
        limit: 400,
        offset: 400,
        scanCursor: first.scanCursor,
      }),
    );
    const ids = second.hits.map((hit) => hit.sourceProcurementId);
    expect(ids).toContain("butb/AU20261018000002");
    expect(ids).toContain("butb/AU20261017000003");
    expect(second.hasMore).toBe(false);
  });

  it("re-reads the stop page when its candidates overflowed the slice", async () => {
    // Two matching rows on the stop page but only one fits the window: the
    // second was read yet never returned. Anchoring the cursor at the page
    // itself — not past it — makes the resume re-read exactly that page.
    const pages = new Map<number, string>([
      [
        1,
        syntheticMultiPage([
          { rowIndex: 0, date: "20.10.2026", regNo: "AU20261020000001" },
          { rowIndex: 1, date: "20.10.2026", regNo: "AU20261020000002" },
        ]),
      ],
      [2, syntheticPage(20, "18.10.2026", "AU20261018000003")],
    ]);
    const client = fakeClient(pages);
    const source = new ButbSource({ client });
    const first = await source.search(
      query({ keywords: ["инструментарий"], publishedFrom: "1900-01-01T00:00:00Z", limit: 1 }),
    );
    expect(first.hits).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    expect(first.scanCursor).toBeDefined();

    const resumed = new ButbSource({ client });
    const second = await resumed.search(
      query({
        keywords: ["инструментарий"],
        publishedFrom: "1900-01-01T00:00:00Z",
        limit: 400,
        offset: 400,
        scanCursor: first.scanCursor,
      }),
    );
    const ids = second.hits.map((hit) => hit.sourceProcurementId);
    // The overflow row from the truncated page is not lost — and the
    // already-returned row re-reads once, deduped by the caller.
    expect(ids).toContain("butb/AU20261020000002");
    expect(ids).toContain("butb/AU20261018000003");
    expect(second.hasMore).toBe(false);
  });

  it("refuses a cursor written for different search terms", async () => {
    // The profile was edited between «Загрузить ещё» clicks — the saved
    // position marks a window these terms never scanned, so the lane must
    // rescan the head instead of skipping it.
    const pages = new Map<number, string>([
      [1, syntheticPage(0, "20.10.2026", "AU20261020000001")],
      [2, syntheticPage(20, "18.10.2026", "AU20261018000002")],
    ]);
    const client = fakeClient(pages);
    const shallow = new ButbSource({ client, maxSearchPages: 1 });
    const first = await shallow.search(
      query({ keywords: ["инструментарий"], publishedFrom: "1900-01-01T00:00:00Z", limit: 400 }),
    );
    expect(first.scanCursor).toBeDefined();

    const resumed = new ButbSource({ client });
    const second = await resumed.search(
      query({
        keywords: ["электродвигатель"],
        publishedFrom: "1900-01-01T00:00:00Z",
        limit: 400,
        offset: 400,
        scanCursor: first.scanCursor,
      }),
    );
    // Fresh scan under the new terms — page 1 was read again (twice in
    // total across both calls) and its row evaluated against the new
    // keyword (it does not match → no hits).
    expect(client.calls.pages.filter((p) => p === 1)).toHaveLength(2);
    expect(second.hits).toEqual([]);
  });

  it("ignores an unparseable cursor instead of trusting it", async () => {
    const client = fakeClient(new Map([[1, registryHtml], [2, "<table></table>"]]));
    const source = new ButbSource({ client });
    const answer = await source.search(
      query({
        keywords: ["инструментарий"],
        publishedFrom: "1900-01-01T00:00:00Z",
        limit: 10,
        scanCursor: "%%%not-a-cursor%%%",
      }),
    );
    expect(answer.hits.length).toBeGreaterThan(0);
    expect(answer.hasMore).toBe(false);
    expect(answer.scanCursor).toBeUndefined();
  });
});

describe("ButbSource native subject search", () => {
  /** Fake client that answers the site's own filtered model per term. */
  function nativeClient(
    filtered: Map<string, Map<number, string>>,
    plain?: Map<number, string>,
  ) {
    const calls = {
      filtered: [] as { subject: string; page: number; criteria: ButbSearchCriteria }[],
      pages: [] as number[],
      cleared: 0,
      links: [] as string[],
    };
    const client: ButbPageClient & { calls: typeof calls } = {
      calls,
      async registryPage(p) {
        calls.pages.push(p);
        return page(plain?.get(p) ?? "<table></table>");
      },
      async filteredPage(criteria, p) {
        calls.filtered.push({ subject: criteria.subject, page: p, criteria });
        const body = filtered.get(criteria.subject)?.get(p);
        return page(body ?? "<table></table>");
      },
      clearSearch() {
        calls.cleared += 1;
      },
      async openCard(linkId) {
        calls.links.push(linkId);
        return { status: 200, url: "https://zakupki.butb.by/auctions/viewinvitation.html", body: cardHtml };
      },
      async download() {
        return { status: 200, url: "", bytes: new Uint8Array([1]) };
      },
      withSession: (fn) => fn(),
    };
    return client;
  }

  /** A filtered page that reports its own filtered total to the paginator. */
  function filteredBody(rows: string, totalRecords: number): string {
    return (
      `<table><tbody>${rows}</tbody></table>` +
      `<script>var w = {"paginator":new YAHOO.widget.Paginator(` +
      `{"rowsPerPage":20,"totalRecords":${totalRecords}})};</script>`
    );
  }

  /**
   * A full non-final filtered page — the parser refuses partial reads, so
   * every page before the last must carry the full 20 rows, each with its
   * own registry number (candidates dedupe on it).
   */
  function fullRows(base: number, firstRegNo: string, date = "20.10.2026"): string {
    return Array.from({ length: 20 }, (_v, i) =>
      syntheticRow(
        base + i,
        date,
        i === 0 ? firstRegNo : `AU20261010${String(39000 + base + i)}`,
      ),
    ).join("");
  }

  it("searches each term natively and merges the candidate sets", async () => {
    const filtered = new Map<string, Map<number, string>>([
      [
        "подстанция",
        new Map([[1, filteredBody(
          syntheticRow(0, "20.10.2026", "AU20261020000001") +
            syntheticRow(1, "20.10.2026", "AU20261020000002"),
          2,
        )]]),
      ],
      [
        "нку",
        new Map([[1, filteredBody(
          syntheticRow(0, "20.10.2026", "AU20261020000002") +
            syntheticRow(1, "19.10.2026", "AU20261019000003"),
          2,
        )]]),
      ],
    ]);
    const client = nativeClient(filtered);
    const source = new ButbSource({ client });
    const answer = await source.search(
      query({
        keywords: ["подстанция", "нку"],
        publishedFrom: "1900-01-01T00:00:00Z",
        limit: 50,
      }),
    );

    // One filtered read per term — the advertised total closes each model.
    expect(client.calls.filtered.map((call) => [call.subject, call.page])).toEqual([
      ["подстанция", 1],
      ["нку", 1],
    ]);
    // The plain registry is never scanned on the native path.
    expect(client.calls.pages).toEqual([]);
    const ids = answer.hits.map((hit) => hit.sourceProcurementId);
    expect(ids).toHaveLength(3);
    const dup = answer.hits.find((hit) => hit.sourceProcurementId === "butb/AU20261020000002")!;
    expect(dup.matchedSearchTerms).toEqual(["подстанция", "нку"]);
    expect(answer.hasMore).toBe(false);
    // The session's search state is released after every native pass.
    expect(client.calls.cleared).toBe(1);
  });

  it("finds rows whose title never mentions the term — the subject is the point", async () => {
    // AU…001's title is generic («Инструментарий»): a title scan can never
    // see it, yet the site's subject search returns it for «подстанция».
    // This is the user's AU20261007394983 case end-to-end.
    const filtered = new Map<string, Map<number, string>>([
      ["подстанция", new Map([[1, filteredBody(syntheticRow(0, "20.10.2026", "AU20261020000001"), 1)]])],
    ]);
    const client = nativeClient(filtered);
    const source = new ButbSource({ client });
    const answer = await source.search(
      query({ keywords: ["подстанция"], publishedFrom: "1900-01-01T00:00:00Z", limit: 50 }),
    );
    expect(answer.hits.map((hit) => hit.sourceProcurementId)).toEqual([
      "butb/AU20261020000001",
    ]);
    expect(answer.hits[0]!.matchedSearchTerms).toEqual(["подстанция"]);
  });

  it("passes statuses, buyer and registry number to the native form", async () => {
    const seen: ButbSearchCriteria[] = [];
    const filtered = new Map<string, Map<number, string>>([
      ["инструментарий", new Map([[1, filteredBody(syntheticRow(0, "20.10.2026"), 1)]])],
    ]);
    const client = nativeClient(filtered);
    const source = new ButbSource({ client });
    await source.search(
      query({
        keywords: ["инструментарий"],
        statuses: ["accepting_bids"],
        buyerText: "заказ",
        buyerUnp: "123456789",
        procurementNumber: "AU2026",
        publishedFrom: "1900-01-01T00:00:00Z",
        limit: 50,
      }),
    );
    for (const call of client.calls.filtered) seen.push(call.criteria);
    expect(seen).toEqual([
      {
        subject: "инструментарий",
        statuses: ["accepting_bids"],
        registryNumber: "AU2026",
        buyerName: "заказ",
        buyerUnp: "123456789",
      },
    ]);
  });

  it("hands back a cursor on truncation and a fresh instance reaches the tail", async () => {
    const filtered = new Map<string, Map<number, string>>([
      [
        "инструментарий",
        new Map([
          [1, filteredBody(fullRows(0, "AU20261020000001"), 21)],
          [2, filteredBody(syntheticRow(20, "19.10.2026", "AU20261019000002"), 21)],
        ]),
      ],
    ]);
    const shallow = new ButbSource({ client: nativeClient(filtered), maxSearchPages: 1 });
    const first = await shallow.search(
      query({ keywords: ["инструментарий"], publishedFrom: "1900-01-01T00:00:00Z", limit: 50 }),
    );
    expect(first.hits).toHaveLength(20);
    expect(first.hits.map((hit) => hit.sourceProcurementId)).toContain(
      "butb/AU20261020000001",
    );
    expect(first.hasMore).toBe(true);
    expect(first.scanCursor).toBeDefined();

    // Resume on a NEW source: the window is re-read and the already-served
    // candidates are skipped by the cursor's returned-count.
    const resumed = new ButbSource({ client: nativeClient(filtered) });
    const second = await resumed.search(
      query({
        keywords: ["инструментарий"],
        publishedFrom: "1900-01-01T00:00:00Z",
        limit: 50,
        scanCursor: first.scanCursor,
      }),
    );
    expect(second.hits.map((hit) => hit.sourceProcurementId)).toEqual([
      "butb/AU20261019000002",
    ]);
    expect(second.hasMore).toBe(false);
    expect(second.scanCursor).toBeUndefined();
  });

  it("paginates the filtered model until the advertised total is read", async () => {
    const filtered = new Map<string, Map<number, string>>([
      [
        "инструментарий",
        new Map([
          [1, filteredBody(fullRows(0, "AU20261020000001"), 21)],
          [2, filteredBody(syntheticRow(20, "19.10.2026", "AU20261019000002"), 21)],
        ]),
      ],
    ]);
    const client = nativeClient(filtered);
    const source = new ButbSource({ client });
    const answer = await source.search(
      query({ keywords: ["инструментарий"], publishedFrom: "1900-01-01T00:00:00Z", limit: 50 }),
    );
    expect(client.calls.filtered.map((call) => call.page)).toEqual([1, 2]);
    expect(answer.hasMore).toBe(false);
    expect(answer.hits).toHaveLength(21);
  });

  it("falls back to the registry scan when the search form broke", async () => {
    const plain = new Map<number, string>([
      [1, registryHtml],
      [2, "<table></table>"],
    ]);
    const calls = { cleared: 0 };
    const client: ButbPageClient & { calls: typeof calls; pages: number[] } = {
      calls,
      pages: [] as number[],
      async registryPage(p) {
        (this as { pages: number[] }).pages.push(p);
        return page(plain.get(p) ?? "<table></table>");
      },
      async filteredPage() {
        throw new Error("search panel markup not recognized");
      },
      clearSearch() {
        calls.cleared += 1;
      },
      async openCard() {
        return { status: 200, url: "", body: cardHtml };
      },
      async download() {
        return { status: 200, url: "", bytes: new Uint8Array([1]) };
      },
      withSession: (fn) => fn(),
    };
    const source = new ButbSource({ client });
    const answer = await source.search(
      query({
        keywords: [firstRow.title.split(" ")[0]!],
        publishedFrom: "1900-01-01T00:00:00Z",
        limit: 10,
      }),
    );
    // The form threw — the title scan still answered honestly.
    expect(client.pages.length).toBeGreaterThan(0);
    expect(answer.hits.length).toBeGreaterThan(0);
    expect(calls.cleared).toBe(1);
  });

  it("treats a scan-path cursor as unusable for a native window", async () => {
    // Get a real scan cursor by truncating the title scan.
    const plain = new Map<number, string>([
      [1, syntheticPage(0, "20.10.2026", "AU20261020000001")],
      [2, syntheticPage(20, "18.10.2026", "AU20261018000002")],
    ]);
    const scanOnly = fakeClient(plain);
    const truncated = new ButbSource({ client: scanOnly, maxSearchPages: 1 });
    const first = await truncated.search(
      query({ keywords: ["инструментарий"], publishedFrom: "1900-01-01T00:00:00Z", limit: 400 }),
    );
    expect(first.scanCursor).toBeDefined();

    // Feed it to a native search: no returned-count in it, so the whole
    // filtered window is re-read — resuming by it would lose candidates.
    const filtered = new Map<string, Map<number, string>>([
      ["инструментарий", new Map([[1, filteredBody(syntheticRow(0, "20.10.2026", "AU20261020000009"), 1)]])],
    ]);
    const native = new ButbSource({ client: nativeClient(filtered) });
    const second = await native.search(
      query({
        keywords: ["инструментарий"],
        publishedFrom: "1900-01-01T00:00:00Z",
        limit: 400,
        scanCursor: first.scanCursor,
      }),
    );
    expect(second.hits.map((hit) => hit.sourceProcurementId)).toEqual([
      "butb/AU20261020000009",
    ]);
    expect(second.hasMore).toBe(false);
  });

  it("treats a native cursor as unusable for a registry scan", async () => {
    // The form worked yesterday and died today: the window's cursor must
    // not anchor the fallback scan — it has no row position to anchor on.
    const filtered = new Map<string, Map<number, string>>([
      [
        "инструментарий",
        new Map([
          [1, filteredBody(fullRows(0, "AU20261020000001"), 21)],
        ]),
      ],
    ]);
    const shallow = new ButbSource({ client: nativeClient(filtered), maxSearchPages: 1 });
    const first = await shallow.search(
      query({ keywords: ["инструментарий"], publishedFrom: "1900-01-01T00:00:00Z", limit: 50 }),
    );
    expect(first.scanCursor).toBeDefined();

    // Now the client lost its form — the same cursor must not freeze the
    // scan in its head phase: a fresh scan reads the head instead.
    const plain = new Map<number, string>([
      [1, syntheticPage(0, "20.10.2026", "AU20261020000001")],
      [2, "<table></table>"],
    ]);
    const scanOnly = fakeClient(plain);
    const resumed = new ButbSource({ client: scanOnly });
    const second = await resumed.search(
      query({
        keywords: ["инструментарий"],
        publishedFrom: "1900-01-01T00:00:00Z",
        limit: 50,
        scanCursor: first.scanCursor,
      }),
    );
    expect(scanOnly.calls.pages).toEqual([1, 2]);
    expect(second.hits.map((hit) => hit.sourceProcurementId)).toEqual([
      "butb/AU20261020000001",
    ]);
    expect(second.hasMore).toBe(false);
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
    const client = fakeClient(pages, cardHtml.replace("AU20261015396707", "AU20261001999001"));
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
    const client = fakeClient(pages, cardHtml.replace("AU20261015396707", "AU20261001999001"));
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

  it("re-probes above the hint when removals pushed the row up", async () => {
    const pages = new Map<number, string>([
      [1, registryHtml],
      [2, syntheticPage(20, "10.10.2026")],
      [3, syntheticPage(42, "01.10.2026", "AU20261001999001")],
    ]);
    const client = fakeClient(pages, cardHtml.replace("AU20261015396707", "AU20261001999001"));
    let now = Date.parse("2026-10-20T00:00:00Z");
    const source = new ButbSource({ client, cardCacheTtlMs: 1_000, now: () => new Date(now) });
    const id = SourceProcurementId.parse("butb/AU20261001999001");
    await source.get(id); // seeds the remembered position at row 42 → page 3

    // Rows above were removed: the card now sits on page 2 and the hinted
    // page only carries older rows — probing deeper would never find it.
    pages.set(2, syntheticPage(30, "01.10.2026", "AU20261001999001"));
    pages.set(3, syntheticPage(45, "25.09.2026"));
    now += 60_000;
    client.calls.pages = [];
    client.calls.links = [];

    const card = await source.get(id);
    expect(card.sourceProcurementId).toBe("butb/AU20261001999001");
    expect(client.calls.pages).toEqual([3, 1, 2]);
    expect(client.calls.links).toEqual(["fra:reestrAu:30:_t344"]);
  });

  it("re-runs locate+open after a dead session instead of reposting the stale link id", async () => {
    const client = fakeClient(new Map([[1, registryHtml]]));
    let openAttempts = 0;
    const flaky: ButbPageClient & { calls: typeof client.calls } = {
      calls: client.calls,
      registryPage: client.registryPage,
      openCard: async (linkId) => {
        openAttempts += 1;
        if (openAttempts === 1) throw new ButbViewExpiredError();
        return client.openCard(linkId);
      },
      download: client.download,
      withSession: client.withSession,
    };
    const source = new ButbSource({ client: flaky });
    const card = await source.get(
      SourceProcurementId.parse(`butb/${firstRow.registryNumber}`),
    );
    expect(card.sourceProcurementId).toBe(`butb/${firstRow.registryNumber}`);
    // The whole sequence re-ran: locate happened twice, the stale link id
    // from the dead session was not reposted as-is.
    expect(client.calls.pages).toEqual([1, 1]);
    expect(openAttempts).toBe(2);
  });

  it("rejects a card whose registry number differs from the requested id", async () => {
    // The postback opened the wrong row — the card's own field names a
    // different procedure. Relabelling it would monitor a stranger's case.
    const wrongCard = cardHtml.replace("AU20261015396707", "AU20261015396708");
    const client = fakeClient(new Map([[1, registryHtml]]), wrongCard);
    const source = new ButbSource({ client });
    await expect(
      source.get(SourceProcurementId.parse(`butb/${firstRow.registryNumber}`)),
    ).rejects.toMatchObject({ name: "SourceAccessError" });
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

describe("ButbSource documents", () => {
  const cardId = () => SourceProcurementId.parse(`butb/${firstRow.registryNumber}`);

  it("lists the card's download links as absolute urls", async () => {
    const client = fakeClient(new Map([[1, registryHtml]]));
    const source = new ButbSource({ client });

    const answer = await source.getDocuments(cardId());

    expect(answer.documents.length).toBeGreaterThan(0);
    for (const document of answer.documents) {
      expect(document.downloadUrl ?? document.sourceUrl).toMatch(
        /^https:\/\/zakupki\.butb\.by\/auctions\/download\?/,
      );
    }
    // The listing rode the same locate+open session sequence as a card read.
    expect(client.calls.pages).toEqual([1]);
    expect(client.calls.links).toHaveLength(1);
  });

  it("downloads a butb-hosted file through the session client with path and query", async () => {
    const client = fakeClient(new Map());
    const paths: string[] = [];
    const source = new ButbSource({
      client: {
        ...client,
        download: async (path) => {
          paths.push(path);
          return {
            status: 200,
            url: "https://zakupki.butb.by/auctions/download",
            bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
            contentType: "application/pdf",
          };
        },
      },
    });

    const file = await source.download(
      "https://zakupki.butb.by/auctions/download?id=6116020&name=tz.pdf",
    );

    expect(paths).toEqual(["/auctions/download?id=6116020&name=tz.pdf"]);
    expect(file.contentType).toBe("application/pdf");
    expect(file.bytes.byteLength).toBe(4);
    // A download is a plain session GET — the card must not be re-opened.
    expect(client.calls.pages).toEqual([]);
    expect(client.calls.links).toEqual([]);
  });

  it("sends a document hosted outside butb to the public downloader", async () => {
    const client = fakeClient(new Map());
    const fetched: string[] = [];
    const source = new ButbSource({
      client,
      publicFetch: async (url) => {
        fetched.push(String(url));
        return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        });
      },
    });

    const file = await source.download("https://files.example.by/docs/tz.pdf");

    expect(file.bytes.byteLength).toBe(4);
    expect(fetched).toEqual(["https://files.example.by/docs/tz.pdf"]);
    // The session lane was not touched for a foreign host.
    expect(client.calls.pages).toEqual([]);
    expect(client.calls.links).toEqual([]);
  });
});

describe("ButbSource cancellation", () => {
  it("an already-aborted call never reaches the registry", async () => {
    const client = fakeClient(new Map([[1, registryHtml]]));
    const source = new ButbSource({ client });
    const controller = new AbortController();
    controller.abort();

    await expect(
      source.search(
        query({ keywords: ["инструментарий"], publishedFrom: "1900-01-01T00:00:00Z" }),
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "SourceAbortedError" });
    expect(client.calls.pages).toEqual([]);
  });

  it("stops a running scan at the next page boundary instead of scanning on", async () => {
    const controller = new AbortController();
    const pages: number[] = [];
    const client: ButbPageClient = {
      async registryPage(p) {
        pages.push(p);
        if (pages.length === 1) controller.abort();
        return page(registryHtml);
      },
      async openCard() {
        throw new Error("unreachable");
      },
      async download() {
        throw new Error("unreachable");
      },
      withSession: (fn) => fn(),
    };
    const source = new ButbSource({ client });

    // No early watermark — without cancellation this would page until the
    // scan bound; the abort must stop it after the first page.
    await expect(
      source.search(
        query({ keywords: ["инструментарий"], publishedFrom: "1900-01-01T00:00:00Z" }),
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "SourceAbortedError" });
    expect(pages).toEqual([1]);
  });

  it("a cancelled card lookup releases the session for the next operation", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = fakeClient(new Map([[1, registryHtml]]));
    const source = new ButbSource({ client });

    await expect(
      source.get(SourceProcurementId.parse(`butb/${firstRow.registryNumber}`), {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "SourceAbortedError" });

    // The lock was released: an uncancelled read proceeds normally.
    const live = await source.get(
      SourceProcurementId.parse(`butb/${firstRow.registryNumber}`),
    );
    expect(live.sourceProcurementId).toBe(`butb/${firstRow.registryNumber}`);
  });
});

/** A synthetic registry row with the given date/reg number. */
function syntheticRow(rowIndex: number, date: string, regNo = "AU20261010396700"): string {
  return `<tr id="fra:reestrAu_row_${rowIndex}"><td><span>${regNo}</span></td>` +
    `<td><a href="#" id="fra:reestrAu:${rowIndex}:_t344" onclick="mojarra.jsfcljs()">Инструментарий</a></td>` +
    `<td>аукцион</td><td>${date}</td><td>1 710 704,01 BYN</td><td>Заказчик</td>` +
    `<td>Госзакупка</td><td>30.10.2026</td><td></td><td>Подача предложений / документов</td><td></td></tr>`;
}

/** A synthetic registry page: one row with the given date/reg number. */
function syntheticPage(rowIndex: number, date: string, regNo = "AU20261010396700"): string {
  return `<table><tbody>${syntheticRow(rowIndex, date, regNo)}</tbody></table>`;
}

/** A synthetic registry page holding several rows — for overflow regressions. */
function syntheticMultiPage(
  rows: ReadonlyArray<{ rowIndex: number; date: string; regNo?: string }>,
): string {
  return `<table><tbody>${rows
    .map((row) => syntheticRow(row.rowIndex, row.date, row.regNo ?? "AU20261010396700"))
    .join("")}</tbody></table>`;
}
